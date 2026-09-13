/**
 * A thin supervisor around one `core watch` child.
 *
 * Core owns polling, reconnect, dedupe, persistence, redelivery and acking, and
 * refuses a second live watcher for the same config. This file owns only what a
 * harness adapter must: start one child, read its JSONL stdout, classify its
 * exit, restart it a bounded number of times when it dies unexpectedly, and
 * never signal a process it did not spawn.
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
	type ConfigChoice,
	type CoreCommand,
	type Env,
	inactiveReason,
	resolveCoreCommand,
	resolveSessionConfig,
} from "./locate.ts";

/** One `type:"message"` line from core's stdout. */
export interface MattermostEvent {
	type: "message";
	connection: string;
	event_id: string;
	post_id: string;
	channel_id: string;
	root_id: string | null;
	sender_id: string;
	/** The sender's username as core resolved it; "" when the directory lookup failed. */
	sender_username: string;
	/**
	 * What core's operator config says this sender is. Set where the event is
	 * built, so this adapter renders a role it was told rather than one it
	 * guessed, and a message body can never influence it.
	 */
	sender_role: "operator" | "automation" | "unknown";
	text: string;
	created_at: number;
	updated_at: number;
	replayed: boolean;
}

/**
 * Exit codes fixed by the core owner: 0 clean, 2 config error, 3 another live
 * watcher holds the lock, 4 auth failure, 1 unexpected. 2/3/4 are terminal —
 * restarting would only race the other consumer or repeat the same failure.
 */
const TERMINAL_EXITS: Record<number, string> = {
	2: "config error",
	3: "another watcher already holds this config's lock",
	4: "authentication failed",
};

const RESTART_BASE_MS = 1_000;
const RESTART_CAP_MS = 30_000;
const MAX_RESTARTS = 6;
/** A child that survives this long is healthy; the restart budget resets. */
const HEALTHY_UPTIME_MS = 60_000;
/** Guard against one unterminated line wedging the parser. */
const MAX_LINE_BYTES = 1 << 20;
const DIAGNOSTIC_HISTORY = 20;

export type WatcherStatus =
	| { kind: "inactive"; detail: string }
	| { kind: "starting" }
	| { kind: "ready"; pid: number; connections: number }
	| { kind: "restarting"; attempt: number; delayMs: number }
	| { kind: "failed"; detail: string }
	| { kind: "stopped" };

export interface WatcherOptions {
	env: Env;
	/**
	 * The session's live working directory, whose `.omp/mcp.json` may pin the
	 * identity. Omitted when the host has no project directory: then only the
	 * environment can name one.
	 */
	cwd?: string;
	onEvent(event: MattermostEvent): void;
	onStatus(status: WatcherStatus): void;
	/** Core stderr, spawn failures, restart notes. */
	onDiagnostic(line: string): void;
	/** Test seam. */
	restartBaseMs?: number;
}

function parseEvent(line: string): MattermostEvent | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	if (!("type" in parsed) || parsed.type !== "message") return null;
	if (!("event_id" in parsed) || typeof parsed.event_id !== "string") return null;
	if (!("connection" in parsed) || typeof parsed.connection !== "string") return null;
	// Core is the sole writer of this stream and its shape is pinned by the
	// shared contract; the identity fields an adapter acts on are checked above.
	const event = parsed as unknown as MattermostEvent;
	return event;
}

/** Feed chunks in, get whole lines out. Oversized lines are dropped, not buffered. */
function lineReader(onLine: (line: string) => void, onOverflow: (bytes: number) => void) {
	let buffer = "";
	return (chunk: string) => {
		buffer += chunk;
		for (;;) {
			const index = buffer.indexOf("\n");
			if (index === -1) break;
			const line = buffer.slice(0, index).replace(/\r$/, "");
			buffer = buffer.slice(index + 1);
			if (line.length > 0) onLine(line);
		}
		if (buffer.length > MAX_LINE_BYTES) {
			onOverflow(buffer.length);
			buffer = "";
		}
	};
}

export class CoreWatcher {
	#options: WatcherOptions;
	#child: ChildProcess | null = null;
	#status: WatcherStatus = { kind: "stopped" };
	#restarts = 0;
	#startedAt = 0;
	#stopping = false;
	#restartTimer: NodeJS.Timeout | undefined;
	#killTimer: NodeJS.Timeout | undefined;
	#diagnostics: string[] = [];
	#command: CoreCommand | null = null;
	#config: ConfigChoice | null = null;

	constructor(options: WatcherOptions) {
		this.#options = options;
	}

	get status(): WatcherStatus {
		return this.#status;
	}

	get pid(): number | null {
		return this.#child?.pid ?? null;
	}

	get command(): CoreCommand | null {
		return this.#command;
	}

	/** Absolute config path of the identity being watched. */
	get config(): string | null {
		return this.#config?.path ?? null;
	}

	/** Where that identity came from — the environment and optional project contract. */
	get configSource(): string | null {
		return this.#config?.detail ?? null;
	}

	/** Most recent diagnostics, oldest first. */
	get diagnostics(): readonly string[] {
		return this.#diagnostics;
	}

	/**
	 * Resolve identity and CLI, then start one child. `inactive` means this
	 * session has no identity, including a shared project launched without its
	 * required environment selection. `failed` means a configured contract is
	 * broken or conflicting.
	 */
	start(): WatcherStatus {
		if (this.#child || this.#restartTimer) return this.#status;
		this.#stopping = false;
		this.#restarts = 0;

		const config = resolveSessionConfig(this.#options.env, this.#options.cwd);
		if (config === null) {
			return this.#setStatus({ kind: "inactive", detail: inactiveReason(this.#options.cwd) });
		}
		if (!config.ok) {
			return this.#setStatus(
				"inactive" in config && config.inactive
					? { kind: "inactive", detail: config.reason }
					: { kind: "failed", detail: config.reason },
			);
		}

		const command = resolveCoreCommand(this.#options.env);
		if (!command.ok) return this.#setStatus({ kind: "failed", detail: command.reason });

		this.#config = config.value;
		this.#command = command.value;
		return this.#spawnChild();
	}

	/**
	 * Terminate the child this watcher spawned, and only that one: SIGTERM, then
	 * SIGKILL if it outlives the grace period. Resolves once it is gone.
	 */
	async stop(graceMs = 5_000): Promise<void> {
		this.#stopping = true;
		clearTimeout(this.#restartTimer);
		this.#restartTimer = undefined;
		const child = this.#child;
		if (!child || child.exitCode !== null || child.signalCode !== null) {
			this.#child = null;
			this.#setStatus({ kind: "stopped" });
			return;
		}
		const exited = Promise.withResolvers<void>();
		child.once("exit", () => exited.resolve());
		child.kill("SIGTERM");
		this.#killTimer = setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}, graceMs);
		this.#killTimer.unref?.();
		await exited.promise;
		clearTimeout(this.#killTimer);
		this.#killTimer = undefined;
		this.#setStatus({ kind: "stopped" });
	}

	#spawnChild(): WatcherStatus {
		const command = this.#command;
		const config = this.#config?.path;
		if (!command || !config) return this.#status;

		let child: ChildProcess;
		try {
			child = spawn(command.command, [...command.prefix, "--config", config, "watch"], {
				stdio: ["ignore", "pipe", "pipe"],
				// The child's environment, not this process's: the resolved identity
				// is passed down without ever mutating `process.env`, so a second
				// session in the same process cannot inherit it.
				env: { ...this.#options.env, MATTERMOST_AGENT_CONFIG: config },
			});
		} catch (error) {
			return this.#setStatus({ kind: "failed", detail: `spawn failed: ${String(error)}` });
		}

		this.#child = child;
		this.#startedAt = Date.now();

		child.stdout?.setEncoding("utf8");
		child.stdout?.on(
			"data",
			lineReader(
				(line) => {
					const event = parseEvent(line);
					if (!event) {
						this.#note(`ignored unparseable stdout line (${line.length} chars)`);
						return;
					}
					this.#options.onEvent(event);
				},
				(bytes) => this.#note(`dropped ${bytes} bytes of unterminated stdout`),
			),
		);

		child.stderr?.setEncoding("utf8");
		child.stderr?.on(
			"data",
			lineReader(
				(line) => this.#onStderr(line),
				(bytes) => this.#note(`dropped ${bytes} bytes of unterminated stderr`),
			),
		);

		child.on("error", (error) => this.#note(`child error: ${String(error)}`));
		child.on("exit", (code, signal) => this.#onExit(code, signal));

		// Safety net for a host that tears down without firing session_shutdown:
		// an 'exit' listener still runs synchronously, and kill(2) is a syscall.
		const killOnParentExit = () => {
			try {
				child.kill("SIGTERM");
			} catch {
				// already gone
			}
		};
		process.once("exit", killOnParentExit);
		child.once("exit", () => process.removeListener("exit", killOnParentExit));

		return this.#setStatus({ kind: "starting" });
	}

	#onStderr(line: string): void {
		this.#note(line);
		const ready = /^mattermost-agent: ready connections=(\d+)/.exec(line);
		if (ready && this.#child?.pid) {
			this.#setStatus({ kind: "ready", pid: this.#child.pid, connections: Number(ready[1]) });
		}
	}

	#onExit(code: number | null, signal: NodeJS.Signals | null): void {
		this.#child = null;
		clearTimeout(this.#killTimer);
		this.#killTimer = undefined;
		if (this.#stopping) {
			this.#setStatus({ kind: "stopped" });
			return;
		}

		const uptime = Date.now() - this.#startedAt;
		const how = code === null ? `signal ${signal}` : `exit ${code}`;
		const terminal = code === null ? undefined : TERMINAL_EXITS[code];
		if (terminal) {
			this.#note(`core stopped: ${terminal} (${how})`);
			this.#setStatus({ kind: "failed", detail: terminal });
			return;
		}

		if (uptime >= HEALTHY_UPTIME_MS) this.#restarts = 0;
		this.#restarts += 1;
		if (this.#restarts > MAX_RESTARTS) {
			const detail = `core exited ${MAX_RESTARTS + 1} times (last: ${how}); giving up`;
			this.#note(detail);
			this.#setStatus({ kind: "failed", detail });
			return;
		}

		const base = this.#options.restartBaseMs ?? RESTART_BASE_MS;
		const delayMs = Math.min(base * 2 ** (this.#restarts - 1), RESTART_CAP_MS);
		this.#note(`core ${how}; restarting in ${delayMs}ms (attempt ${this.#restarts})`);
		this.#setStatus({ kind: "restarting", attempt: this.#restarts, delayMs });
		this.#restartTimer = setTimeout(() => {
			this.#restartTimer = undefined;
			if (this.#stopping) return;
			this.#spawnChild();
		}, delayMs);
		this.#restartTimer.unref?.();
	}

	#note(line: string): void {
		this.#diagnostics.push(line);
		if (this.#diagnostics.length > DIAGNOSTIC_HISTORY) this.#diagnostics.shift();
		this.#options.onDiagnostic(line);
	}

	#setStatus(status: WatcherStatus): WatcherStatus {
		this.#status = status;
		this.#options.onStatus(status);
		return status;
	}
}

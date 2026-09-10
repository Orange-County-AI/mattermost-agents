/**
 * What to spawn: the core CLI, the bun that runs it, and the config file.
 *
 * Identity is never guessed. It comes from exactly two explicit places:
 * `MATTERMOST_AGENT_CONFIG` in the session environment, and the project MCP
 * file OMP already reads for this working directory, `<cwd>/.omp/mcp.json`,
 * where a server entry pins that same variable in its own `env`. That file is
 * the one place a project declares which Mattermost account its tools act as,
 * so a listener reading it stays the same account as the tools — and an
 * operator gets a working listener from an ordinary `omp` launch, with no
 * shell exports and no extra flags.
 *
 * Nothing else is searched: no ancestor directory, no `$HOME`, no default
 * profile. An adapter that guessed a config out of the filesystem would start
 * consuming somebody else's inbox on any machine that happened to have a file
 * there. Both unset means inactive, which is not an error; two sources that
 * disagree is an error, and so is one that cannot be read literally.
 *
 * The wrappers in `adapters/bin/` deliberately implement only the environment
 * half of this: they are plain `sh` and run under harnesses with no project
 * directory of their own.
 */

import { readFileSync, statSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CONFIG_ENV = "MATTERMOST_AGENT_CONFIG";
export const CLI_ENV = "MATTERMOST_AGENT_CLI";
export const BUN_ENV = "MATTERMOST_AGENT_BUN";

/** `adapters/omp-extension/locate.ts` → `<repo>/src/agent/cli.ts`. */
const DEFAULT_CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/agent/cli.ts");

export type Env = Record<string, string | undefined>;

export type Resolution<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface CoreCommand {
	/** Executable to spawn. */
	command: string;
	/** Leading arguments — the CLI entry, when it runs through bun. */
	prefix: string[];
	/** Resolved CLI entry, for diagnostics. */
	cli: string;
}

function fileMode(path: string): number | null {
	try {
		const stat = statSync(path);
		return stat.isFile() ? stat.mode : null;
	} catch {
		return null;
	}
}

/**
 * `MATTERMOST_AGENT_BUN`, else this runtime when it is already bun (the normal
 * case inside OMP), else `bun` on PATH. No guessed install locations.
 */
export function findBun(env: Env): string | null {
	const override = env[BUN_ENV];
	if (override) return fileMode(override) === null ? null : override;
	// Only when this runtime really is a bun binary: a host that bundles its own
	// entry can leave execPath pointing at a script, which cannot run the CLI.
	if (process.versions.bun && basename(process.execPath) === "bun") return process.execPath;
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, "bun");
		const mode = fileMode(candidate);
		if (mode !== null && (mode & 0o111) !== 0) return candidate;
	}
	return null;
}

/**
 * How to invoke the core CLI: `MATTERMOST_AGENT_CLI` when set (a `.ts`/`.js`
 * entry runs through bun, anything else runs directly), otherwise the fixed
 * path inside this checkout, so the whole repo stays relocatable.
 */
export function resolveCoreCommand(env: Env): Resolution<CoreCommand> {
	const override = env[CLI_ENV];
	const cli = override ? resolve(override) : DEFAULT_CLI;
	if (fileMode(cli) === null) {
		return {
			ok: false,
			reason: override
				? `${CLI_ENV}=${override} does not name a file`
				: `core CLI missing at ${cli}`,
		};
	}

	if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(cli)) {
		const mode = fileMode(cli);
		if (mode === null || (mode & 0o111) === 0) return { ok: false, reason: `${cli} is not executable` };
		return { ok: true, value: { command: cli, prefix: [], cli } };
	}

	const bun = findBun(env);
	if (!bun) return { ok: false, reason: `bun not found on PATH; set ${BUN_ENV}` };
	return { ok: true, value: { command: bun, prefix: [cli], cli } };
}

/**
 * `null` when `MATTERMOST_AGENT_CONFIG` is unset — this session is not a
 * Mattermost consumer, which is not an error. A path that does not exist is an
 * error: somebody meant to connect and the setup is wrong.
 */
export function resolveConfigPath(env: Env): Resolution<string> | null {
	const configured = env[CONFIG_ENV];
	if (!configured) return null;
	const path = resolve(configured);
	if (fileMode(path) === null) return { ok: false, reason: `${CONFIG_ENV}=${path} does not exist` };
	return { ok: true, value: path };
}

/** The project MCP file OMP itself reads for a working directory. */
const PROJECT_MCP = [".omp", "mcp.json"];

/** Where a resolved identity came from, for diagnostics and for the operator. */
export type ConfigOrigin = "env" | "project";

export interface ConfigChoice {
	/** Absolute path of the core agent config. */
	path: string;
	origin: ConfigOrigin;
	/** Human-readable source, shown by `/mattermost status`. */
	detail: string;
}

export function projectMcpPath(cwd: string): string {
	return join(cwd, ...PROJECT_MCP);
}

/**
 * The slice of OMP's project MCP file this adapter reads. Every field stays
 * `unknown` until it is checked: the file is hand-edited config, and OMP has
 * its own schema for the rest of it.
 */
interface ProjectMcpFile {
	mcpServers?: Record<string, { enabled?: unknown; env?: Record<string, unknown> } | undefined>;
	disabledServers?: unknown;
	enabledServers?: unknown;
}

/**
 * Before launching a stdio server OMP may resolve an `env` value through a
 * leading `!` shell command, a `${VAR}` placeholder, or a bare
 * environment-variable name, and only falls back to the literal string. Only
 * the literal case names a config this adapter can verify and hand to core, so
 * the others are reported as unsupported instead of guessed at: resolving them
 * differently from OMP is how a listener ends up on a different account than
 * the tools.
 */
function literalPath(value: string): Resolution<string> {
	if (value.startsWith("!")) {
		return { ok: false, reason: "which OMP runs as a shell command; this adapter needs a literal path" };
	}
	if (value.includes("${")) {
		return { ok: false, reason: "which OMP expands as a placeholder; this adapter needs a literal path" };
	}
	if (!value.includes("/")) {
		return {
			ok: false,
			reason: "which names an environment variable, not a path; this adapter needs a literal path",
		};
	}
	return { ok: true, value };
}

/**
 * The identity `<cwd>/.omp/mcp.json` pins, if any: the one config path that
 * enabled server entries agree on.
 *
 * `null` when the file is absent, has no server map, or no server pins
 * `MATTERMOST_AGENT_CONFIG` — none of which is an error. Two servers pinning
 * different configs is: that project declares two identities and there is no
 * defensible way to pick one, so nothing starts.
 */
export function resolveProjectConfig(cwd: string): Resolution<ConfigChoice> | null {
	const file = projectMcpPath(cwd);
	if (fileMode(file) === null) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		return { ok: false, reason: `${file} is not readable JSON: ${String(error)}` };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, reason: `${file} does not contain a JSON object` };
	}

	const servers = (parsed as ProjectMcpFile).mcpServers;
	if (!servers || typeof servers !== "object" || Array.isArray(servers)) return null;
	const { disabledServers, enabledServers } = parsed as ProjectMcpFile;
	const disabled: readonly unknown[] = Array.isArray(disabledServers) ? disabledServers : [];
	const forceEnabled: readonly unknown[] = Array.isArray(enabledServers) ? enabledServers : [];

	/** Resolved config path → the server names that pin it. */
	const pinned = new Map<string, string[]>();
	for (const [name, entry] of Object.entries(servers)) {
		if (!entry || typeof entry !== "object") continue;
		const { env } = entry;
		if (!env || typeof env !== "object") continue;
		const raw = env[CONFIG_ENV];
		if (typeof raw !== "string") continue;
		const value = raw.trim();
		if (value.length === 0) continue;
		// A server OMP will not launch cannot be this session's identity.
		if (disabled.includes(name)) continue;
		if (entry.enabled === false && !forceEnabled.includes(name)) continue;

		const literal = literalPath(value);
		if (!literal.ok) {
			return { ok: false, reason: `${file}: server "${name}" sets ${CONFIG_ENV}=${value}, ${literal.reason}` };
		}
		const path = resolve(cwd, literal.value);
		const owners = pinned.get(path);
		if (owners) owners.push(name);
		else pinned.set(path, [name]);
	}

	if (pinned.size === 0) return null;
	if (pinned.size > 1) {
		const listed = [...pinned]
			.map(([path, names]) => `${names.join(", ")} → ${path}`)
			.join("; ");
		return {
			ok: false,
			reason: `${file} pins ${pinned.size} different ${CONFIG_ENV} values (${listed}); one project, one identity`,
		};
	}

	const [path, names] = [...pinned][0];
	const detail = `${file} server ${names.map((name) => `"${name}"`).join(", ")}`;
	if (fileMode(path) === null) return { ok: false, reason: `${detail} points ${CONFIG_ENV} at ${path}, which does not exist` };
	return { ok: true, value: { path, origin: "project", detail } };
}

/**
 * The identity this session listens as: the environment, the project MCP file,
 * or neither. Disagreement is fatal rather than resolved by precedence —
 * listening as one account while the MCP tools reply as another is worse than
 * not listening at all.
 */
export function resolveSessionConfig(env: Env, cwd?: string): Resolution<ConfigChoice> | null {
	const explicit = resolveConfigPath(env);
	if (explicit && !explicit.ok) return explicit;

	const project = cwd ? resolveProjectConfig(cwd) : null;
	if (project && !project.ok) return project;

	if (explicit?.ok && project?.ok) {
		if (explicit.value !== project.value.path) {
			return {
				ok: false,
				reason:
					`${CONFIG_ENV}=${explicit.value} but ${project.value.detail} pins ${project.value.path}; ` +
					"refusing to listen as one account while the MCP tools act as another",
			};
		}
		return {
			ok: true,
			value: { path: explicit.value, origin: "env", detail: `${CONFIG_ENV}, matching ${project.value.detail}` },
		};
	}
	if (explicit?.ok) return { ok: true, value: { path: explicit.value, origin: "env", detail: CONFIG_ENV } };
	return project;
}

/** Why a session with no identity is not watching — never phrased as a fault. */
export function inactiveReason(cwd?: string): string {
	if (!cwd) return `${CONFIG_ENV} is not set and this session has no project directory`;
	return `${CONFIG_ENV} is not set and no server in ${projectMcpPath(cwd)} pins it`;
}

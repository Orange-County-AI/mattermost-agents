/**
 * This integration's segment of the footer line, and what an operator may
 * change about it.
 *
 * The line is shared with every other channel integration in the process (see
 * `channel-status.ts`), so a segment stays short: which identities this
 * session listens as and — always, whatever the operator configured — one
 * word when one of them is not listening.
 *
 * Identity comes from the profile. Liveness does NOT come from this process's
 * opinion of its child: it comes from the rows the listener itself writes,
 * `watcher_health` and unacked `events`, exactly what `status` reads. That is
 * the whole point. A credential that authenticates proves nothing about
 * whether anything is listening, and a child process that exists proves only
 * that — a wedged child stops heartbeating, and a stopped heartbeat is what
 * shows up here as `stale`. Four agents once went deaf while every credential
 * still worked; this line exists so that is visible without asking.
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
// The staleness rule and the liveness test, imported rather than restated, so
// the footer can never disagree with `status` about what "listening" means.
import { LOCK_STALE_MS, processAlive } from "../../src/agent/state.ts";

/** How this integration is named in the shared registry, and its place in the line. */
export const STATUS_OWNER = "mattermost";

/** Short for a narrow footer, spelled out when the operator asks for verbose. */
const LABEL = { compact: "mm", verbose: "mattermost" } as const;

/**
 * The words `status` reports for a listener, plus `starting` for the moment a
 * child is up but a connection has not opened yet, and `auth`/`config` for the
 * two reasons a retry will never succeed on its own.
 */
export type ListenerMarker = "starting" | "retrying" | "auth" | "config" | "stale" | "stopped" | "absent";

/** What this session's child is doing, as the supervisor sees it. */
export type ChildState = "starting" | "running" | "failed";

export const STATUS_FIELDS = ["label", "identity", "count"] as const;
export type StatusField = (typeof STATUS_FIELDS)[number];
export type StatusStyle = "compact" | "verbose";

export interface StatusConfig {
	readonly fields: readonly StatusField[];
	readonly style: StatusStyle;
}

/**
 * Identity, and nothing else. Next to named connections a pending count says
 * little, so it is opt-in; the not-listening marker is not a field at all,
 * because it is the one thing this line exists to make visible and an
 * operator trimming the line must not be able to hide it.
 */
export const DEFAULT_STATUS: StatusConfig = { fields: ["label", "identity"], style: "compact" };

/** A `status` block that says something this build does not understand. */
export class StatusConfigError extends Error {}

/**
 * Read the operator's `status` block, or refuse it. Refusing beats guessing:
 * a mistyped field name that silently rendered the default would be a setting
 * the operator believes is in force and never is.
 */
export function parseStatusConfig(raw: unknown): StatusConfig {
	if (raw === undefined || raw === null) return DEFAULT_STATUS;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new StatusConfigError('"status" must be an object with optional "fields" and "style"');
	}
	// Named, and read only key by key below: this is hand-written config, so
	// every key it carries is checked before anything is believed.
	const block = raw as Record<string, unknown>;
	const strange = Object.keys(block).filter((key) => key !== "fields" && key !== "style");
	if (strange.length > 0) {
		throw new StatusConfigError(
			`"status" has unknown key(s) ${strange.join(", ")}; it takes only "fields" and "style"`,
		);
	}

	let fields = DEFAULT_STATUS.fields;
	if (block.fields !== undefined) {
		if (!Array.isArray(block.fields)) {
			throw new StatusConfigError(`"status.fields" must be an array of ${STATUS_FIELDS.join(", ")}`);
		}
		const chosen: StatusField[] = [];
		for (const entry of block.fields) {
			const known = STATUS_FIELDS.find((field) => field === entry);
			if (known === undefined) {
				throw new StatusConfigError(
					`"status.fields" has unknown field ${JSON.stringify(entry)}; the fields are ${STATUS_FIELDS.join(", ")}`,
				);
			}
			if (chosen.includes(known)) throw new StatusConfigError(`"status.fields" lists "${known}" twice`);
			chosen.push(known);
		}
		fields = chosen;
	}

	let style = DEFAULT_STATUS.style;
	if (block.style !== undefined) {
		if (block.style !== "compact" && block.style !== "verbose") {
			throw new StatusConfigError('"status.style" must be "compact" or "verbose"');
		}
		style = block.style;
	}

	return { fields, style };
}

export interface ProfileConnection {
	/** The connection id: what `watcher_health` and `events` are keyed by. */
	readonly id: string;
	/** What the footer shows for it. */
	readonly identity: string;
}

export interface ProfileFacts {
	/** In the order the operator wrote them; that order is theirs, not ours to sort. */
	readonly connections: readonly ProfileConnection[];
	readonly stateDir: string;
	readonly status: StatusConfig;
	/** Set when a `status` block was present and refused; the default is in force instead. */
	readonly statusRefused: string | null;
}

/**
 * The slice of the profile the footer needs. Core validates the whole file
 * with its own schema — the child fails loudly on a broken profile — so this
 * checks only what it reads, and only to the depth it reads it.
 */
export function readProfileFacts(path: string): ProfileFacts {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${path} is not a JSON object`);
	}
	// Named, with every field below checked before use.
	const profile = parsed as Record<string, unknown>;
	if (typeof profile.stateDir !== "string" || profile.stateDir.length === 0) {
		throw new Error(`${path} has no "stateDir"`);
	}
	if (!Array.isArray(profile.connections) || profile.connections.length === 0) {
		throw new Error(`${path} has no "connections"`);
	}
	const connections: ProfileConnection[] = [];
	for (const entry of profile.connections) {
		if (!entry || typeof entry !== "object") throw new Error(`${path} has a connection that is not an object`);
		const connection = entry as Record<string, unknown>;
		if (typeof connection.id !== "string" || connection.id.length === 0) {
			throw new Error(`${path} has a connection without an "id"`);
		}
		connections.push({ id: connection.id, identity: connection.id });
	}

	let status = DEFAULT_STATUS;
	let statusRefused: string | null = null;
	try {
		status = parseStatusConfig(profile.status);
	} catch (error) {
		// Refused, never half-applied. The caller says so out loud — a
		// notification and `/mattermost status` — and the line falls back to
		// the default, because rendering nothing would hide the listener too.
		statusRefused = error instanceof StatusConfigError ? error.message : String(error);
	}
	return { connections, stateDir: profile.stateDir, status, statusRefused };
}

/** One `watcher_health` row: what the listener last claimed, and when. */
export interface ListenerRow {
	readonly reported: string;
	readonly pid: number;
	readonly host: string;
	readonly heartbeatAt: number;
	readonly errorKind: string | null;
}

export interface ListenerFacts {
	readonly rows: Map<string, ListenerRow>;
	readonly pending: Map<string, number>;
}

const NOTHING_KNOWN: ListenerFacts = { rows: new Map(), pending: new Map() };

const HEALTH_SQL =
	"SELECT connection_id, reported, pid, host, heartbeat_at, last_error_kind FROM watcher_health";
const PENDING_SQL = "SELECT connection, COUNT(*) AS pending FROM events WHERE acked_at IS NULL GROUP BY connection";

interface HealthQueryRow {
	connection_id: string;
	reported: string;
	pid: number;
	host: string;
	heartbeat_at: number;
	last_error_kind: string | null;
}

interface PendingQueryRow {
	connection: string;
	pending: number;
}

/**
 * Reads the listener's own state file, read-only and in process: two indexed
 * queries against the same SQLite the listener writes. No `status` subprocess
 * and no network — the footer must cost nothing, and the questions it asks
 * ("is anything listening", "how much is unanswered") are answered locally.
 */
export class ListenerStateReader {
	readonly #path: string;
	readonly #note: (line: string) => void;
	#db: Database | null = null;
	#complained = false;

	constructor(stateDir: string, note: (line: string) => void) {
		this.#path = join(stateDir, "agent.sqlite");
		this.#note = note;
	}

	/**
	 * Never throws. A state file that does not exist yet means nothing has run
	 * yet, and a read that loses a race with the writer means try again in ten
	 * seconds; neither is worth an exception in a UI callback.
	 */
	read(withPending: boolean): ListenerFacts {
		const db = this.#open();
		if (!db) return NOTHING_KNOWN;
		try {
			const rows = new Map<string, ListenerRow>();
			for (const row of db.query<HealthQueryRow, []>(HEALTH_SQL).all()) {
				rows.set(row.connection_id, {
					reported: row.reported,
					pid: row.pid,
					host: row.host,
					heartbeatAt: row.heartbeat_at,
					errorKind: row.last_error_kind,
				});
			}
			const pending = new Map<string, number>();
			// Only when the operator asked for a count: an unread query nobody
			// renders is pure cost.
			if (withPending) {
				for (const row of db.query<PendingQueryRow, []>(PENDING_SQL).all()) {
					pending.set(row.connection, row.pending);
				}
			}
			return { rows, pending };
		} catch (error) {
			this.#note(`state read failed: ${String(error)}`);
			this.close();
			return NOTHING_KNOWN;
		}
	}

	close(): void {
		this.#db?.close(false);
		this.#db = null;
	}

	#open(): Database | null {
		if (this.#db) return this.#db;
		try {
			this.#db = new Database(this.#path, { readonly: true });
			this.#complained = false;
			return this.#db;
		} catch (error) {
			// Once per outage, not once per refresh: the usual cause is a
			// listener that has not created the file yet.
			if (!this.#complained) {
				this.#complained = true;
				this.#note(`state not readable at ${this.#path}: ${String(error)}`);
			}
			return null;
		}
	}
}

/**
 * What to say about one connection, from the child's state and the listener's
 * own last word. `null` means listening — the healthy case says nothing,
 * because a footer that talks when everything works teaches an operator to
 * stop reading it.
 */
export function markerFor(child: ChildState, row: ListenerRow | undefined, now: number): ListenerMarker | null {
	// The child gave up. Whatever the last heartbeat claimed, nothing is
	// listening for this session now.
	if (child === "failed") return "stale";
	if (!row) return child === "starting" ? "starting" : "absent";
	// Same test `status` applies: a heartbeat this old, or a local pid that is
	// gone, means the process that wrote the row is not there any more.
	const gone =
		row.reported !== "stopped" &&
		(now - row.heartbeatAt > LOCK_STALE_MS || (row.host === hostname() && !processAlive(row.pid)));
	if (gone) return child === "starting" ? "starting" : "stale";
	if (row.reported === "stopped") return "stopped";
	if (row.reported === "retrying") {
		// A refused credential and a broken profile need a human's hands on
		// them; a server that is merely down needs patience. Three words,
		// three remedies.
		if (row.errorKind === "identity") return "auth";
		if (row.errorKind === "config") return "config";
		return "retrying";
	}
	return row.reported === "listening" ? null : "stale";
}

export interface SegmentEntry {
	/** Empty when there is no identity to name — a failure before the profile was read. */
	readonly identity: string;
	readonly marker: ListenerMarker | null;
	readonly pending: number;
}

/**
 * The segment text, or `undefined` for no segment at all. An unhealthy
 * connection is named whatever the field list says: the operator may shorten
 * this line, never blind it.
 */
export function renderSegment(entries: readonly SegmentEntry[], config: StatusConfig): string | undefined {
	const compact = config.style === "compact";
	const parts: string[] = [];
	if (config.fields.includes("label")) parts.push(compact ? LABEL.compact : LABEL.verbose);

	const withIdentity = config.fields.includes("identity");
	const named = entries
		.filter((entry) => (withIdentity && entry.identity.length > 0) || entry.marker !== null)
		.map((entry) =>
			entry.marker === null
				? entry.identity
				: compact
					? `${entry.identity}!${entry.marker}`
					: `${entry.identity} (${entry.marker})`.trim(),
		);
	if (named.length > 0) parts.push(named.join(compact ? "·" : ", "));

	if (config.fields.includes("count")) {
		const pending = entries.reduce((total, entry) => total + entry.pending, 0);
		if (pending > 0) parts.push(compact ? `↓${pending}` : `${pending} pending`);
	}

	return parts.length > 0 ? parts.join(" ") : undefined;
}

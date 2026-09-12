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
// The label convention is shared with every other channel integration in the
// process; only the names below are this repository's.
import {
	type ChannelLabel,
	DEFAULT_LABEL_STYLE,
	LABEL_STYLES,
	type LabelChoice,
	type LabelStyle,
	MAX_LABEL_COLUMNS,
} from "./channel-status.ts";

/** How this integration is named in the shared registry, and its place in the line. */
export const STATUS_OWNER = "mattermost";

/**
 * What this integration is called in the footer. The default is the brand
 * glyph: `dev-mattermost`, U+E927, from the Nerd Fonts symbol set — a logo is
 * read faster than two letters, and two letters are what a font without it
 * falls back to. A build older than the one that added U+E927 draws tofu
 * there, which `status.label` and `status.glyph` exist to fix without a
 * release.
 */
export const CHANNEL_LABEL: ChannelLabel = { glyph: "\ue927", text: "mm", verbose: "mattermost" };

/**
 * The words `status` reports for a listener, plus `starting` for the moment a
 * child is up but a connection has not opened yet, and `auth`/`config` for the
 * two reasons a retry will never succeed on its own.
 */
export type ListenerMarker = "starting" | "retrying" | "auth" | "config" | "stale" | "stopped" | "absent";

/** What this session's child is doing, as the supervisor sees it. */
export type ChildState = "starting" | "running" | "failed";

/**
 * The two halves of an identity are separate fields, because they answer
 * different questions: `connection` says which server-and-profile entry this
 * is, `user` says which account the credential authenticated as. A footer
 * that showed only the first named two agents sharing one account
 * identically.
 */
export const STATUS_FIELDS = ["label", "connection", "user", "count"] as const;
export type StatusField = (typeof STATUS_FIELDS)[number];
export type StatusStyle = "compact" | "verbose";

/** Everything a `status` block may say; anything else is refused by name. */
const STATUS_KEYS = ["fields", "style", "label", "glyph"] as const;

export interface StatusConfig {
	readonly fields: readonly StatusField[];
	readonly style: StatusStyle;
	/** Which form the `label` field takes, when the field is listed at all. */
	readonly label: LabelStyle;
	/** The operator's own glyph for this machine's font, or `null` for this build's. */
	readonly glyph: string | null;
}

/**
 * Who this session acts as, and nothing else: the connection and the account
 * on it. Next to a named identity a pending count says little, so it is
 * opt-in; neither the not-listening marker nor the lock-held-elsewhere marker
 * is a field at all, because those are the things this line exists to make
 * visible and an operator trimming the line must not be able to hide them.
 * The label is the brand glyph, because a footer is scanned rather than read.
 */
export const DEFAULT_STATUS: StatusConfig = {
	fields: ["label", "connection", "user"],
	style: "compact",
	label: DEFAULT_LABEL_STYLE,
	glyph: null,
};

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
		throw new StatusConfigError(`"status" must be an object with optional ${STATUS_KEYS.join(", ")}`);
	}
	// Named, and read only key by key below: this is hand-written config, so
	// every key it carries is checked before anything is believed.
	const block = raw as Record<string, unknown>;
	const strange = Object.keys(block).filter((key) => !STATUS_KEYS.some((known) => known === key));
	if (strange.length > 0) {
		throw new StatusConfigError(
			`"status" has unknown key(s) ${strange.join(", ")}; it takes only ${STATUS_KEYS.join(", ")}`,
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

	let label = DEFAULT_STATUS.label;
	if (block.label !== undefined) {
		const known = LABEL_STYLES.find((candidate) => candidate === block.label);
		if (known === undefined) {
			throw new StatusConfigError(
				`"status.label" must be one of ${LABEL_STYLES.join(", ")}, not ${JSON.stringify(block.label)}`,
			);
		}
		label = known;
	}

	let glyph = DEFAULT_STATUS.glyph;
	if (block.glyph !== undefined && block.glyph !== null) {
		if (typeof block.glyph !== "string") {
			throw new StatusConfigError(`"status.glyph" must be a string, not ${JSON.stringify(block.glyph)}`);
		}
		// Measured in terminal columns, not characters: this is a label on a
		// line two integrations share, and a glyph that renders as nothing
		// (empty, a control character) is the failure this check exists for.
		const columns = Bun.stringWidth(block.glyph);
		if (columns < 1 || columns > MAX_LABEL_COLUMNS) {
			throw new StatusConfigError(
				`"status.glyph" is ${columns} column(s) wide; it must be 1 to ${MAX_LABEL_COLUMNS}`,
			);
		}
		glyph = block.glyph;
	}

	return { fields, style, label, glyph };
}

/**
 * What the shared line should call this integration, given the operator's
 * block. A label the field list leaves out is no label at all, whatever style
 * is configured: `fields` says whether, `label` says how.
 */
export function labelChoice(config: StatusConfig): LabelChoice {
	return {
		style: config.fields.includes("label") ? config.label : "none",
		verbose: config.style === "verbose",
		...(config.glyph === null ? {} : { glyph: config.glyph }),
	};
}

export interface ProfileConnection {
	/** The connection id: what `watcher_health` and `events` are keyed by. */
	readonly id: string;
	/**
	 * The account this connection acts as, as far as the PROFILE can say —
	 * empty here, and deliberately so. A Mattermost profile pins
	 * `expectedUserId`, twenty-six opaque characters that name nobody; the
	 * readable name exists only after a credential authenticates, and the
	 * listener records it in `watcher_identity` for this line to read.
	 */
	readonly account: string;
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
		connections.push({ id: connection.id, account: "" });
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

/** One `watcher_identity` row: who a credential turned out to be, and when. */
export interface IdentityRow {
	/** The readable account name — a Mattermost username. */
	readonly account: string;
	readonly userId: string;
	/** The AgentState scope this identity owns; the exact key of its lock row. */
	readonly scope: string;
	readonly resolvedAt: number;
}

/** One `watcher_lock` row: which process currently has the right to listen. */
export interface LockRow {
	readonly scope: string;
	readonly pid: number;
	readonly host: string;
	readonly heartbeatAt: number;
}

export interface ListenerFacts {
	readonly rows: Map<string, ListenerRow>;
	readonly pending: Map<string, number>;
	/** By connection id. Absent until a credential has authenticated at least once. */
	readonly identities: Map<string, IdentityRow>;
	/** Every lock row in the file, in the order SQLite returned them. */
	readonly locks: readonly LockRow[];
}

const NOTHING_KNOWN: ListenerFacts = { rows: new Map(), pending: new Map(), identities: new Map(), locks: [] };

const HEALTH_SQL =
	"SELECT connection_id, reported, pid, host, heartbeat_at, last_error_kind FROM watcher_health";
const PENDING_SQL = "SELECT connection, COUNT(*) AS pending FROM events WHERE acked_at IS NULL GROUP BY connection";
const IDENTITY_SQL = "SELECT connection_id, scope, user_id, username, resolved_at FROM watcher_identity";
const LOCK_SQL = "SELECT scope, pid, host, heartbeat_at FROM watcher_lock";

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

interface IdentityQueryRow {
	connection_id: string;
	scope: string;
	user_id: string;
	username: string;
	resolved_at: number;
}

interface LockQueryRow {
	scope: string;
	pid: number;
	host: string;
	heartbeat_at: number;
}

/**
 * Reads the listener's own state file, read-only and in process: a handful of
 * small queries against the same SQLite the listener writes. No `status`
 * subprocess and no network — the footer must cost nothing, and every question
 * it asks ("is anything listening", "as whom", "does this session hold the
 * right to listen at all", "how much is unanswered") is answered locally.
 */
export class ListenerStateReader {
	readonly #path: string;
	readonly #note: (line: string) => void;
	#db: Database | null = null;
	#complained = false;
	/** Which tables this file actually has, read once per open. */
	#tables: Record<string, true> = {};

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
			const identities = new Map<string, IdentityRow>();
			// A state file written by a build older than `watcher_identity` has
			// no such table, and this reader opens read-only so it cannot create
			// one. Skipping the query costs the names and nothing else — the
			// health rows and the lock still render.
			if (this.#tables.watcher_identity) {
				for (const row of db.query<IdentityQueryRow, []>(IDENTITY_SQL).all()) {
					identities.set(row.connection_id, {
						account: row.username,
						userId: row.user_id,
						scope: row.scope,
						resolvedAt: row.resolved_at,
					});
				}
			}
			const locks = db.query<LockQueryRow, []>(LOCK_SQL).all().map((row) => ({
				scope: row.scope,
				pid: row.pid,
				host: row.host,
				heartbeatAt: row.heartbeat_at,
			}));
			return { rows, pending, identities, locks };
		} catch (error) {
			this.#note(`state read failed: ${String(error)}`);
			this.close();
			return NOTHING_KNOWN;
		}
	}

	close(): void {
		this.#db?.close(false);
		this.#db = null;
		this.#tables = {};
	}

	#open(): Database | null {
		if (this.#db) return this.#db;
		try {
			const db = new Database(this.#path, { readonly: true });
			// One catalogue read per open, so a table this build queries and an
			// older writer never created is a missing fact rather than a thrown
			// read that would blank the whole segment.
			for (const row of db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
				this.#tables[row.name] = true;
			}
			this.#db = db;
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

/**
 * How far up a process tree this will look for one of our own pids. The child
 * this session spawned normally IS the lock holder; the walk exists for the
 * one configuration where it is not — `MATTERMOST_AGENT_CLI` naming a wrapper
 * script, which puts the real watcher a generation or two down.
 */
const MAX_ANCESTRY = 8;

/**
 * `/proc/<pid>/stat`'s parent, or `null` at the top of the walk. The command
 * name field is parenthesised and may itself contain spaces and parentheses,
 * so the fields are counted from the LAST `)`: state, then ppid.
 *
 * Linux only, by construction. Everywhere else the walk stops immediately and
 * ownership falls back to pid equality, which is the normal case anyway.
 */
function parentPid(pid: number): number | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const parent = Number(fields[1]);
		// 1 is init: an orphan, which is no longer anybody's descendant.
		return Number.isInteger(parent) && parent > 1 ? parent : null;
	} catch {
		return null;
	}
}

function inTree(pid: number, roots: readonly number[]): boolean {
	let current: number | null = pid;
	for (let step = 0; current !== null && step <= MAX_ANCESTRY; step += 1) {
		if (roots.includes(current)) return true;
		current = parentPid(current);
	}
	return false;
}

/**
 * The lock row for one connection. The recorded identity carries the exact
 * scope its listener locks under, so that is the join. Without one — an old
 * state file, or a credential that has never authenticated here — the
 * connection id is the first field of every scope, and a single match is
 * unambiguous; two identities sharing one stateDir under one connection id are
 * not, so nothing is claimed rather than the wrong one.
 */
export function lockFor(
	locks: readonly LockRow[],
	connectionId: string,
	scope: string | null,
): LockRow | undefined {
	if (scope !== null) return locks.find((lock) => lock.scope === scope);
	const candidates = locks.filter((lock) => lock.scope.startsWith(`${connectionId}|`));
	return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Where this connection's watcher lock lives when it does NOT belong to this
 * session, as a locator to print; `null` when the lock is ours, dead, or
 * absent.
 *
 * This is the failure `watcher_health` cannot show. That table is keyed by
 * connection and origin only, so a listener held by ANOTHER session writes
 * healthy rows into the same file: the segment reads `listening`, every
 * credential works, and this session still receives nothing, because only the
 * lock holder does. Two agents shared one account that way for a whole evening
 * and the wrong one settled a human's approval.
 *
 * Liveness is the lock's own rule, imported rather than restated. Ownership is
 * this session's spawned child and its descendants — a lock on another host
 * can never be ours, because our child runs here.
 */
export function elsewhereLocator(lock: LockRow | undefined, ours: readonly number[], now: number): string | null {
	if (!lock) return null;
	const here = lock.host === hostname();
	const live = lock.heartbeatAt > now - LOCK_STALE_MS && !(here && !processAlive(lock.pid));
	if (!live) return null;
	if (here && inTree(lock.pid, ours)) return null;
	// A pid, because a pane cannot be attributed from local state: nothing in
	// this file records which terminal a listener was started from, and asking
	// the multiplexer would be the network call this line refuses to make.
	return here ? `#${lock.pid}` : `#${lock.host}:${lock.pid}`;
}

export interface SegmentEntry {
	/** The connection id, empty only when there was no profile to read one from. */
	readonly connection: string;
	/** The account it acts as; empty when local state cannot name one yet. */
	readonly account: string;
	readonly marker: ListenerMarker | null;
	/** The lock holder's locator when it is not this session's; never config-gated. */
	readonly elsewhere: string | null;
	readonly pending: number;
}

/**
 * Binds an account to its connection. `·` already separates one connection
 * from the next, and `/` binds tighter than `·` to the eye, so
 * `ocai/stub·ticket500/stub` groups correctly without spending a space on it.
 * It is also the conventional namespace separator (host/user, org/repo), and
 * it collides with nothing either half may contain: Mattermost usernames are
 * lowercase letters, digits and `. - _`, and a mail address has no slash.
 */
const ACCOUNT_SEPARATOR = "/";

/**
 * What to call one connection, given the field list. Two ways for that list to
 * leave nothing to say: it names neither half, or the only half it names is a
 * `user` local state cannot name yet. Either way a name still reaches this
 * line, because the only reason it does is that something is wrong with this
 * connection — and then it is the FULL name, connection and account both. Half
 * a name is what let two sessions on one account look identical.
 */
function nameFor(entry: SegmentEntry, config: StatusConfig): string {
	const parts: string[] = [];
	if (config.fields.includes("connection")) parts.push(entry.connection);
	if (config.fields.includes("user") && entry.account.length > 0) parts.push(entry.account);
	if (parts.length > 0) return parts.join(ACCOUNT_SEPARATOR);
	return entry.account.length > 0 ? `${entry.connection}${ACCOUNT_SEPARATOR}${entry.account}` : entry.connection;
}

/**
 * Everything the segment says after its label — the label itself belongs to
 * the shared line, which spaces it. Empty when the operator asked for none of
 * it; a label alone is still a segment. A connection carrying a marker is
 * named whatever the field list says: the operator may shorten this line,
 * never blind it.
 */
export function renderSegmentBody(entries: readonly SegmentEntry[], config: StatusConfig): string {
	const compact = config.style === "compact";
	const parts: string[] = [];

	const named = config.fields.includes("connection") || config.fields.includes("user");
	const shown = entries
		.filter(
			(entry) =>
				(named && entry.connection.length > 0) || entry.marker !== null || entry.elsewhere !== null,
		)
		.map((entry) => {
			const markers: string[] = [];
			if (entry.marker !== null) markers.push(entry.marker);
			if (entry.elsewhere !== null) markers.push(`elsewhere${entry.elsewhere}`);
			const name = nameFor(entry, config);
			if (markers.length === 0) return name;
			return compact
				? `${name}${markers.map((marker) => `!${marker}`).join("")}`
				: `${name} (${markers.join(", ")})`.trim();
		});
	if (shown.length > 0) parts.push(shown.join(compact ? "·" : ", "));

	if (config.fields.includes("count")) {
		const pending = entries.reduce((total, entry) => total + entry.pending, 0);
		if (pending > 0) parts.push(compact ? `↓${pending}` : `${pending} pending`);
	}

	return parts.join(" ");
}

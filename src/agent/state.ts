/**
 * Durable agent state: one SQLite file under the config's stateDir, shared by
 * the watcher, the CLI and the MCP tools.
 *
 * Everything is keyed by a scope = connection id + server origin + authenticated
 * user id. Two agents pointed at different servers, or the same server as
 * different bots, never see each other's events even if they share a stateDir.
 *
 * Ordering rules that matter:
 *   - an event row is committed BEFORE the watcher prints it,
 *   - a channel checkpoint only moves inside the same transaction that stored
 *     every event of that sweep, so a failed sweep can never skip a post,
 *   - acks are explicit; reading or printing an event never settles it.
 */
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

export interface StoredEvent {
  event_id: string
  connection: string
  post_id: string
  channel_id: string
  root_id: string
  sender_id: string
  text: string
  created_at: number
  updated_at: number
  first_seen_at: number
  attempts: number
  next_attempt_at: number
  acked_at: number | null
}

export interface EventInput {
  event_id: string
  connection: string
  post_id: string
  channel_id: string
  root_id: string
  sender_id: string
  text: string
  created_at: number
  updated_at: number
}

export interface OutboundRecord {
  event_id: string
  message_hash: string
  /** The exact stored payload: a reply's text, or a send's channel+root+text. Compared verbatim for idempotency. */
  message: string
  /** sent = the server acknowledged the post; failed = the server rejected it; unknown = the call was ambiguous. */
  status: 'sent' | 'failed' | 'unknown'
  post_id: string | null
  error: string | null
  created_at: number
  updated_at: number
}

export interface Gap {
  channel_id: string
  from_ms: number
  to_ms: number
  observed: number
  noticed_at: number
}

export interface LockHolder {
  pid: number
  host: string
  started_at: number
  heartbeat_at: number
}

/**
 * What the supervisor last recorded about one connection's listener. Keyed by
 * connection id + server origin ONLY — deliberately not by the authenticated
 * user, because the question "is my listener alive?" has to be answerable
 * exactly when the identity call is the thing that is failing.
 */
export interface WatcherHealthRow {
  connection_id: string
  origin: string
  pid: number
  host: string
  /** What the supervisor was doing: listening, retrying a failed open, or shut down cleanly. */
  reported: 'listening' | 'retrying' | 'stopped'
  /** How many times the current open has been attempted; 0 once it is listening. */
  attempts: number
  last_error: string | null
  last_error_kind: string | null
  last_error_at: number | null
  started_at: number
  heartbeat_at: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  scope TEXT NOT NULL,
  event_id TEXT NOT NULL,
  connection TEXT NOT NULL,
  post_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  acked_at INTEGER,
  PRIMARY KEY (scope, event_id)
);
CREATE INDEX IF NOT EXISTS events_pending ON events (scope, acked_at, next_attempt_at);
CREATE TABLE IF NOT EXISTS checkpoints (
  scope TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  since_ms INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, channel_id)
);
CREATE TABLE IF NOT EXISTS gaps (
  scope TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  from_ms INTEGER NOT NULL,
  to_ms INTEGER NOT NULL,
  observed INTEGER NOT NULL,
  noticed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS outbound (
  scope TEXT NOT NULL,
  event_id TEXT NOT NULL,
  message_hash TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL,
  post_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, event_id)
);
CREATE TABLE IF NOT EXISTS watcher_lock (
  scope TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  host TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS watcher_health (
  key TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  pid INTEGER NOT NULL,
  host TEXT NOT NULL,
  reported TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_error_kind TEXT,
  last_error_at INTEGER,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);
`

/** A dead holder is one whose heartbeat stopped; on this host we also check the pid. */
export const LOCK_STALE_MS = 30_000

export class AgentState {
  readonly scope: string
  private readonly db: Database

  private constructor(db: Database, scope: string) {
    this.db = db
    this.scope = scope
  }

  /** scope = connection id + origin + authenticated user, so state never crosses identities. */
  static open(args: { stateDir: string; connectionId: string; origin: string; userId: string }): AgentState {
    mkdirSync(args.stateDir, { recursive: true })
    const db = new Database(join(args.stateDir, 'agent.sqlite'), { create: true })
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(SCHEMA)
    return new AgentState(db, `${args.connectionId}|${args.origin}|${args.userId}`)
  }

  close(): void {
    this.db.close(false)
  }

  checkpoint(channelId: string): number | undefined {
    const row = this.db
      .query<{ since_ms: number }, [string, string]>('SELECT since_ms FROM checkpoints WHERE scope = ? AND channel_id = ?')
      .get(this.scope, channelId)
    return row?.since_ms
  }

  /**
   * Store one channel sweep. Events and the new checkpoint commit together: if
   * this throws, the checkpoint stays where it was and the next sweep re-reads
   * the same window (event ids make that idempotent).
   */
  commitSweep(args: { channelId: string; events: EventInput[]; checkpoint: number; gap?: Omit<Gap, 'noticed_at'> }): number {
    const now = Date.now()
    const insertEvent = this.db.query(
      `INSERT INTO events (scope, event_id, connection, post_id, channel_id, root_id, sender_id, text,
                           created_at, updated_at, first_seen_at, attempts, next_attempt_at, acked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL)
       ON CONFLICT (scope, event_id) DO NOTHING`,
    )
    const setCheckpoint = this.db.query(
      `INSERT INTO checkpoints (scope, channel_id, since_ms, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (scope, channel_id) DO UPDATE SET since_ms = excluded.since_ms, updated_at = excluded.updated_at`,
    )
    const insertGap = this.db.query(
      'INSERT INTO gaps (scope, channel_id, from_ms, to_ms, observed, noticed_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    let stored = 0
    this.db.transaction(() => {
      for (const e of args.events) {
        const res = insertEvent.run(
          this.scope,
          e.event_id,
          e.connection,
          e.post_id,
          e.channel_id,
          e.root_id,
          e.sender_id,
          e.text,
          e.created_at,
          e.updated_at,
          now,
        )
        stored += res.changes
      }
      if (args.gap) {
        insertGap.run(this.scope, args.gap.channel_id, args.gap.from_ms, args.gap.to_ms, args.gap.observed, now)
      }
      setCheckpoint.run(this.scope, args.channelId, args.checkpoint, now)
    })()
    return stored
  }

  /** Unacked events whose backoff has elapsed, oldest post first. */
  duePending(now: number, limit = 50): StoredEvent[] {
    return this.db
      .query<StoredEvent, [string, number, number]>(
        `SELECT * FROM events WHERE scope = ? AND acked_at IS NULL AND next_attempt_at <= ?
         ORDER BY created_at ASC, updated_at ASC LIMIT ?`,
      )
      .all(this.scope, now, limit)
  }

  pending(limit = 50): StoredEvent[] {
    return this.db
      .query<StoredEvent, [string, number]>(
        'SELECT * FROM events WHERE scope = ? AND acked_at IS NULL ORDER BY created_at ASC, updated_at ASC LIMIT ?',
      )
      .all(this.scope, limit)
  }

  /** Called BEFORE printing: the attempt is durable even if the process dies mid-write. */
  markAttempt(eventId: string, nextAttemptAt: number): number {
    this.db
      .query('UPDATE events SET attempts = attempts + 1, next_attempt_at = ? WHERE scope = ? AND event_id = ?')
      .run(nextAttemptAt, this.scope, eventId)
    return this.event(eventId)?.attempts ?? 0
  }

  /** Make every pending event due now — used once at startup to replay the backlog. */
  rearmPending(): void {
    this.db.query('UPDATE events SET next_attempt_at = 0 WHERE scope = ? AND acked_at IS NULL').run(this.scope)
  }

  event(eventId: string): StoredEvent | undefined {
    return (
      this.db
        .query<StoredEvent, [string, string]>('SELECT * FROM events WHERE scope = ? AND event_id = ?')
        .get(this.scope, eventId) ?? undefined
    )
  }

  /** Settle exactly one event. Returns false if it is unknown to this scope. */
  ack(eventId: string, now = Date.now()): boolean {
    const res = this.db
      .query('UPDATE events SET acked_at = ? WHERE scope = ? AND event_id = ? AND acked_at IS NULL')
      .run(now, this.scope, eventId)
    return res.changes > 0 || this.event(eventId) !== undefined
  }

  outbound(eventId: string): OutboundRecord | undefined {
    return (
      this.db
        .query<OutboundRecord, [string, string]>(
          'SELECT event_id, message_hash, message, status, post_id, error, created_at, updated_at FROM outbound WHERE scope = ? AND event_id = ?',
        )
        .get(this.scope, eventId) ?? undefined
    )
  }

  /**
   * Atomically reserve the right to perform one outbound operation. The key is
   * an event id for a reply, or `send:<request_id>` for an agent-initiated
   * post — one namespace, two kinds of key, so both share this machinery
   * without inventing fake inbox events.
   *
   * `payload` is the full identity of the operation (a reply's exact text; a
   * send's channel + root + text). Only the caller that inserts the row may
   * post; everyone else gets the existing record back, so two MCP or CLI
   * processes racing produce one post, not two — a read-then-write check would
   * not. A previous attempt the server definitively REJECTED (4xx) is
   * retakeable: nothing was published, so a retry is safe.
   */
  claimOutbound(key: string, payload: string): { claimed: boolean; existing?: OutboundRecord } {
    const eventId = key
    const message = payload
    const now = Date.now()
    const hash = Bun.hash(message).toString(16)
    const inserted = this.db
      .query(
        `INSERT INTO outbound (scope, event_id, message_hash, message, status, post_id, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'unknown', NULL, NULL, ?, ?)
         ON CONFLICT (scope, event_id) DO NOTHING`,
      )
      .run(this.scope, eventId, hash, message, now, now)
    if (inserted.changes > 0) return { claimed: true }

    const retaken = this.db
      .query(
        `UPDATE outbound SET message = ?, message_hash = ?, status = 'unknown', error = NULL, updated_at = ?
         WHERE scope = ? AND event_id = ? AND status = 'failed'`,
      )
      .run(message, hash, now, this.scope, eventId)
    if (retaken.changes > 0) return { claimed: true }
    return { claimed: false, existing: this.outbound(eventId) }
  }

  /** A reply landed: record it and settle the event it answered, in one transaction. */
  markOutboundSent(eventId: string, postId: string, now = Date.now()): void {
    this.db.transaction(() => {
      this.db
        .query("UPDATE outbound SET status = 'sent', post_id = ?, error = NULL, updated_at = ? WHERE scope = ? AND event_id = ?")
        .run(postId, now, this.scope, eventId)
      this.db
        .query('UPDATE events SET acked_at = ? WHERE scope = ? AND event_id = ? AND acked_at IS NULL')
        .run(now, this.scope, eventId)
    })()
  }

  /** An agent-initiated post landed. It answers no inbound event, so nothing is settled. */
  markSendSent(key: string, postId: string, now = Date.now()): void {
    this.db
      .query("UPDATE outbound SET status = 'sent', post_id = ?, error = NULL, updated_at = ? WHERE scope = ? AND event_id = ?")
      .run(postId, now, this.scope, key)
  }

  markOutboundOutcome(eventId: string, status: 'failed' | 'unknown', error: string): void {
    this.db
      .query('UPDATE outbound SET status = ?, error = ?, updated_at = ? WHERE scope = ? AND event_id = ?')
      .run(status, error, Date.now(), this.scope, eventId)
  }

  gaps(limit = 20): Gap[] {
    return this.db
      .query<Gap, [string, number]>(
        'SELECT channel_id, from_ms, to_ms, observed, noticed_at FROM gaps WHERE scope = ? ORDER BY noticed_at DESC LIMIT ?',
      )
      .all(this.scope, limit)
  }

  lockHolder(): LockHolder | undefined {
    return (
      this.db
        .query<LockHolder, [string]>('SELECT pid, host, started_at, heartbeat_at FROM watcher_lock WHERE scope = ?')
        .get(this.scope) ?? undefined
    )
  }

  /**
   * Take the single-watcher lock, or report who holds it. A holder whose
   * heartbeat is older than LOCK_STALE_MS is dead; a same-host holder whose pid
   * is gone is dead immediately, so a crashed watcher does not block a restart.
   */
  acquireLock(now = Date.now()): { ok: true } | { ok: false; holder: LockHolder } {
    const host = hostname()
    const holder = this.lockHolder()
    if (holder && holder.heartbeat_at > now - LOCK_STALE_MS && !(holder.host === host && !processAlive(holder.pid))) {
      return { ok: false, holder }
    }
    this.db
      .query(
        `INSERT INTO watcher_lock (scope, pid, host, started_at, heartbeat_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (scope) DO UPDATE SET pid = excluded.pid, host = excluded.host,
           started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at`,
      )
      .run(this.scope, process.pid, host, now, now)
    return { ok: true }
  }

  heartbeat(now = Date.now()): void {
    this.db.query('UPDATE watcher_lock SET heartbeat_at = ? WHERE scope = ? AND pid = ?').run(now, this.scope, process.pid)
  }

  releaseLock(): void {
    this.db.query('DELETE FROM watcher_lock WHERE scope = ? AND pid = ?').run(this.scope, process.pid)
  }
}

/**
 * The listener's own liveness, recorded WITHOUT an authenticated identity.
 *
 * `AgentState` is scoped by the user the credential turned out to be, so none
 * of it can be written — or read — while the identity call is failing. That is
 * precisely the window an operator needs an answer in: after a host reboot,
 * four agents answered `health: live` from a fresh identity call while their
 * watchers had been dead for hours. This table is the honest signal: a
 * heartbeat written every few seconds by the supervisor that is actually
 * resident, plus what it is doing and the last error it saw.
 *
 * It lives in the same SQLite file, keyed by connection id + origin, so
 * `status` can read it before it knows who the credential is.
 */
export class WatcherHealth {
  private readonly db: Database

  private constructor(db: Database) {
    this.db = db
  }

  static open(stateDir: string): WatcherHealth {
    mkdirSync(stateDir, { recursive: true })
    const db = new Database(join(stateDir, 'agent.sqlite'), { create: true })
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(SCHEMA)
    return new WatcherHealth(db)
  }

  close(): void {
    this.db.close(false)
  }

  /**
   * Record where one connection stands. `error` is remembered across beats: a
   * listener that recovered still shows what it was last stopped by, which is
   * what makes a flapping server visible at all.
   *
   * A row belongs to the process that is actually listening. A second `watch`
   * — which will lose the lock a moment later — must not stamp its own pid
   * over a live watcher's, or `status` would report a working listener as
   * dead. Ownership is released exactly as the lock's is: a stopped holder, a
   * heartbeat past LOCK_STALE_MS, or a same-host pid that is gone.
   */
  report(args: {
    connectionId: string
    origin: string
    reported: WatcherHealthRow['reported']
    attempts?: number
    error?: { text: string; kind: string } | null
    now?: number
  }): void {
    const now = args.now ?? Date.now()
    const key = `${args.connectionId}|${args.origin}`
    const error = args.error
    const held = this.read(args.connectionId, args.origin)
    if (held && (held.pid !== process.pid || held.host !== hostname()) && liveHolder(held, now)) return
    this.db
      .query(
        `INSERT INTO watcher_health (key, connection_id, origin, pid, host, reported, attempts,
                                     last_error, last_error_kind, last_error_at, started_at, heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET pid = excluded.pid, host = excluded.host,
           reported = excluded.reported, attempts = excluded.attempts,
           last_error = COALESCE(excluded.last_error, watcher_health.last_error),
           last_error_kind = COALESCE(excluded.last_error_kind, watcher_health.last_error_kind),
           last_error_at = COALESCE(excluded.last_error_at, watcher_health.last_error_at),
           started_at = CASE WHEN watcher_health.pid = excluded.pid AND watcher_health.host = excluded.host
                             THEN watcher_health.started_at ELSE excluded.started_at END,
           heartbeat_at = excluded.heartbeat_at`,
      )
      .run(
        key,
        args.connectionId,
        args.origin,
        process.pid,
        hostname(),
        args.reported,
        args.attempts ?? 0,
        error ? error.text.slice(0, 500) : null,
        error ? error.kind : null,
        error ? now : null,
        now,
        now,
      )
  }

  read(connectionId: string, origin: string): WatcherHealthRow | undefined {
    return (
      this.db
        .query<WatcherHealthRow, [string]>(
          `SELECT connection_id, origin, pid, host, reported, attempts, last_error, last_error_kind,
                  last_error_at, started_at, heartbeat_at FROM watcher_health WHERE key = ?`,
        )
        .get(`${connectionId}|${origin}`) ?? undefined
    )
  }
}

/**
 * Is the process that wrote this row still the listener? Same test the lock
 * uses: a stopped holder is not, a heartbeat past LOCK_STALE_MS is not, and on
 * this host a pid that is gone is not — immediately, so a crash never leaves a
 * phantom listener behind.
 */
function liveHolder(row: WatcherHealthRow, now: number): boolean {
  if (row.reported === 'stopped') return false
  if (row.heartbeat_at <= now - LOCK_STALE_MS) return false
  return !(row.host === hostname() && !processAlive(row.pid))
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

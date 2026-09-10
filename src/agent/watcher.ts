/**
 * The persistent watcher: one long-lived process, one connection per configured
 * server, message events on stdout as JSONL.
 *
 * Transport choice (measured on OCAI, Team Edition 11.9.0): the Agents plugin's
 * external MCP server is not routable on this build, so this is plain REST +
 * WebSocket. The WebSocket is only a WAKE-UP: every event the agent emits comes
 * from a REST `since` sweep, which is the one path that is replayable after a
 * disconnect, sees edits, and cannot deliver a post the checkpoint has already
 * passed. A dropped socket therefore costs latency, never messages — the poll
 * timer alone is a correct (slower) watcher.
 */
import type { MattermostClient, MMUser } from '../mattermost'
import { senderRole, type ConnectionConfig, type SenderRole } from './config'
import { planSweep, type IngestPolicy } from './ingest'
import { channelScope, type ChannelScope } from './scope'
import type { AgentState, StoredEvent } from './state'

/**
 * WebSocket events that can change what this account is a member of. They are
 * a latency optimisation only: every tick re-reads memberships anyway, so a
 * missed frame delays a new channel by one poll interval instead of losing it.
 */
const MEMBERSHIP_EVENTS: Record<string, true> = {
  user_added: true,
  user_removed: true,
  channel_created: true,
  channel_deleted: true,
  channel_converted: true,
  direct_added: true,
  group_added: true,
  added_to_team: true,
  leave_team: true,
}

const POST_EVENTS: Record<string, true> = { posted: true, post_edited: true, post_deleted: true }

/** How far back a brand-new checkpoint looks. Bounded so a first run cannot replay a year. */
export const INITIAL_LOOKBACK_MS = 60 * 60 * 1000

export const REDELIVERY_BASE_MS = 30_000
export const REDELIVERY_MAX_MS = 15 * 60 * 1000

export interface WatcherIo {
  /** Message events. stdout, one JSON object per line, nothing else. */
  emit(line: string): void
  /** Diagnostics. stderr, never a turn. */
  log(line: string): void
  /**
   * A server-side failure this watcher rode out, or `null` once a whole tick
   * came back clean. Optional because it is diagnostics only: the watcher
   * never stops for one of these, it just lets `status` say so out loud.
   */
  transient?(error: string | null): void
}

export interface MessageLine {
  type: 'message'
  connection: string
  event_id: string
  post_id: string
  channel_id: string
  root_id: string
  sender_id: string
  /** The sender's username. '' when the directory lookup failed — never a guess. */
  sender_username: string
  /**
   * What the operator's config says this sender is. Resolved here, and from the
   * same function the MCP tools use, so one event never reports two roles.
   */
  sender_role: SenderRole
  text: string
  created_at: number
  updated_at: number
  replayed: boolean
}

export function messageLine(event: StoredEvent, attempts: number, role: SenderRole): MessageLine {
  return {
    type: 'message',
    connection: event.connection,
    event_id: event.event_id,
    post_id: event.post_id,
    channel_id: event.channel_id,
    root_id: event.root_id,
    sender_id: event.sender_id,
    sender_username: event.sender_username,
    sender_role: role,
    text: event.text,
    created_at: event.created_at,
    updated_at: event.updated_at,
    replayed: attempts > 1,
  }
}

export function redeliveryDelay(attempts: number): number {
  return Math.min(REDELIVERY_BASE_MS * 2 ** Math.max(0, attempts - 1), REDELIVERY_MAX_MS)
}

/** One connection's watch loop. Independent of every other connection's failures. */
export class ConnectionWatcher {
  private readonly policy: IngestPolicy
  private readonly scope: ChannelScope
  private socket: WebSocket | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private wakeTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectDelay = 1000
  private sweeping = false
  private stopped = false
  /** The last server-side failure inside the current tick; diagnostics only. */
  private lastFailure: string | undefined
  /**
   * user id → username, for this process. The directory is asked once per
   * sender and the answer travels with the event, so a redelivery years later
   * still names who wrote it. A rename therefore shows the old name until the
   * watcher restarts — a cosmetic staleness, and never an authority one:
   * `senderRole` reads the immutable id, not this.
   */
  private readonly usernames: Record<string, string> = {}

  constructor(
    private readonly conn: ConnectionConfig,
    private readonly client: MattermostClient,
    private readonly state: AgentState,
    private readonly token: string,
    selfUserId: string,
    private readonly io: WatcherIo,
  ) {
    this.policy = { connection: conn.id, selfUserId, allowedBotIds: conn.allowedBotIds, usernames: this.usernames }
    this.scope = channelScope(conn, client, selfUserId)
  }

  /** Catch up, replay the unacked backlog, then stay resident. */
  async start(): Promise<void> {
    this.state.rearmPending()
    // Membership mode has nothing to sweep until the memberships are known, so
    // a failure here is fatal to THIS connection's startup — the supervisor
    // retries it — rather than a silent watch of zero channels.
    if (this.scope.mode === 'membership') await this.scope.refresh()
    await this.sweepAll()
    this.drain()
    this.openSocket()
    this.pollTimer = setInterval(() => void this.tick(), this.conn.pollIntervalMs)
    this.io.log(
      `connection-ready connection=${this.conn.id} scope=${this.scope.mode} channels=${this.scope.channels().length}`,
    )
  }

  stop(): void {
    this.stopped = true
    clearInterval(this.pollTimer)
    clearTimeout(this.wakeTimer)
    clearTimeout(this.reconnectTimer)
    this.socket?.close()
    this.socket = undefined
  }

  private async tick(): Promise<void> {
    this.lastFailure = undefined
    await this.refreshScope()
    const swept = await this.sweepAll()
    this.drain()
    // Diagnostics only, and only when a sweep actually ran: an operator
    // reading `status` should see a listener that is alive but getting 502s,
    // rather than having to guess it from stderr.
    if (swept) this.io.transient?.(this.lastFailure ?? null)
  }

  /**
   * Re-read the account's memberships (a no-op in static mode). A channel
   * joined, created or left while this process runs therefore starts or stops
   * being swept within one tick — no restart, no config edit. A failed refresh
   * keeps the previous set: losing the server for a moment must not silently
   * stop watching everything.
   */
  private async refreshScope(): Promise<void> {
    if (this.scope.mode !== 'membership' || this.stopped) return
    const before = this.scope.channels().length
    try {
      await this.scope.refresh()
    } catch (err) {
      this.lastFailure = errorText(err)
      this.io.log(`warn connection=${this.conn.id} membership refresh failed: ${errorText(err)}`)
      return
    }
    const after = this.scope.channels().length
    if (after !== before) {
      this.io.log(`membership connection=${this.conn.id} channels=${after} (was ${before})`)
    }
  }

  /**
   * Sequential, one channel at a time: a failure stops at that channel's
   * checkpoint. Answers whether it ran at all — a tick that collided with an
   * in-flight sweep has verified nothing and must not report a clean pass.
   */
  private async sweepAll(): Promise<boolean> {
    if (this.sweeping || this.stopped) return false
    this.sweeping = true
    try {
      for (const channelId of this.scope.channels()) {
        try {
          await this.sweepChannel(channelId)
        } catch (err) {
          this.lastFailure = errorText(err)
          this.io.log(`warn connection=${this.conn.id} channel=${channelId} sweep failed: ${errorText(err)}`)
        }
      }
    } finally {
      this.sweeping = false
    }
    return true
  }

  private async sweepChannel(channelId: string): Promise<void> {
    const stored = this.state.checkpoint(channelId)
    // First run only looks back INITIAL_LOOKBACK_MS. That is a bounded start,
    // not a promise about history: anything older is simply not this agent's
    // backlog. Afterwards the window overlaps the checkpoint by 1ms, because
    // `since` is exclusive on update_at and a post written in the checkpoint's
    // millisecond would otherwise never be returned. Event ids absorb the overlap.
    const priorCheckpoint = stored ?? Date.now() - INITIAL_LOOKBACK_MS
    const since = stored === undefined ? priorCheckpoint : Math.max(0, stored - 1)
    const list = await this.client.getChannelPostsSince(channelId, since)
    // Before the events are built, so the name is stored with them and every
    // later redelivery names the sender without another directory call.
    await this.learnUsernames(list.order.map((id) => list.posts[id]?.user_id))
    const plan = planSweep(list, since, this.policy, priorCheckpoint)
    if (plan.observed === 0) return
    if (plan.overflow) {
      this.io.log(
        `warn connection=${this.conn.id} channel=${channelId} catch-up DEGRADED: the since-window hit the server cap ` +
          `(${plan.overflow.observed} posts). Posts updated between ${plan.overflow.from_ms} and ${plan.overflow.to_ms} were never ` +
          `returned; the checkpoint stays at ${priorCheckpoint} and the gap is recorded. Messages in that range are NOT delivered ` +
          'until an operator replays that range from channel history.',
      )
    }
    const newEvents = this.state.commitSweep({
      channelId,
      events: plan.events,
      checkpoint: plan.checkpoint,
      gap: plan.overflow ? { channel_id: channelId, ...plan.overflow } : undefined,
    })
    if (newEvents > 0) {
      this.io.log(`sweep connection=${this.conn.id} channel=${channelId} new=${newEvents} checkpoint=${plan.checkpoint}`)
    }
  }

  /**
   * Fill the username cache for ids it does not have yet. A failure here is
   * NOT a sweep failure: an unnamed sender is still delivered, still carries
   * its user id, and still resolves to a role — losing a display name must
   * never cost a message.
   */
  private async learnUsernames(ids: (string | undefined)[]): Promise<void> {
    const wanted = [
      ...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0 && !(id in this.usernames))),
    ]
    if (wanted.length === 0) return
    // Mattermost caps /users/ids at 100 per call.
    for (let at = 0; at < wanted.length; at += 100) {
      const batch = wanted.slice(at, at + 100)
      let users: MMUser[]
      try {
        users = await this.client.usersByIds(batch)
      } catch (err) {
        this.io.log(`warn connection=${this.conn.id} username lookup failed for ${batch.length} sender(s): ${errorText(err)}`)
        return
      }
      for (const user of users) this.usernames[user.id] = user.username
    }
  }

  /** Print every due event. State is committed first, so a crash re-delivers instead of losing. */
  private drain(): void {
    const now = Date.now()
    for (const event of this.state.duePending(now)) {
      const attempts = this.state.markAttempt(event.event_id, now + redeliveryDelay(event.attempts + 1))
      this.io.emit(JSON.stringify(messageLine(event, attempts, senderRole(this.conn, event.sender_id))))
    }
  }

  private openSocket(): void {
    if (this.stopped) return
    const socket = new WebSocket(this.client.websocketUrl())
    this.socket = socket
    socket.onopen = () => socket.send(JSON.stringify({ seq: 1, action: 'authentication_challenge', data: { token: this.token } }))
    socket.onmessage = (raw) => this.onFrame(String(raw.data))
    socket.onerror = () => this.io.log(`warn connection=${this.conn.id} websocket error`)
    socket.onclose = () => {
      if (this.stopped || this.socket !== socket) return
      this.io.log(`warn connection=${this.conn.id} websocket closed; polling continues, reconnect in ${this.reconnectDelay}ms`)
      this.reconnectTimer = setTimeout(() => this.openSocket(), this.reconnectDelay)
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000)
    }
  }

  private onFrame(data: string): void {
    let frame: { event?: string; broadcast?: { channel_id?: string } }
    try {
      frame = JSON.parse(data) as { event?: string; broadcast?: { channel_id?: string } }
    } catch {
      return
    }
    if (frame.event === 'hello') {
      this.reconnectDelay = 1000
      this.io.log(`websocket connected connection=${this.conn.id}`)
      return
    }
    const event = frame.event ?? ''
    if (POST_EVENTS[event]) {
      const channelId = frame.broadcast?.channel_id
      // Static mode: a post outside the allowlist is not ours, whoever posted
      // it. Membership mode: a channel we do not know yet may be one we were
      // just added to, so wake and let the tick's refresh decide.
      if (channelId && this.scope.mode === 'static' && !this.scope.knows(channelId)) return
      this.wake()
      return
    }
    if (MEMBERSHIP_EVENTS[event] && this.scope.mode === 'membership') this.wake()
  }

  /**
   * Coalesce socket frames into one tick. Waking the sweep instead of
   * ingesting the frame keeps ONE code path owning the checkpoint, so a socket
   * event can never jump ahead of a failed fetch.
   */
  private wake(): void {
    if (this.wakeTimer) return
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined
      void this.tick()
    }, 150)
  }
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

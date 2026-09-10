/**
 * The operations the CLI and the MCP tools share. No daemon, no HTTP gateway:
 * both entry points open the same SQLite state and the same REST client.
 *
 * Ownership is enforced here, once, through the connection's ChannelScope: a
 * channel outside the configured allowlist (static mode) or outside this
 * account's real memberships (membership mode) is refused, whoever asks.
 */
import { MattermostClient, httpStatus, type MMListPost } from '../mattermost'
import { connectionById, resolveToken, type AgentConfig, type ConnectionConfig } from './config'
import { channelScope, type ChannelScope } from './scope'
import { AgentState, type StoredEvent } from './state'

export class BackendError extends Error {}

/** The credential does not belong to the identity the config pins it to. */
export class IdentityError extends Error {}

/**
 * Why a connection failed to open, and therefore whether stopping is ever the
 * right answer.
 *
 * `identity` is a DEFINITE refusal of the credential: the server judged it and
 * said no (401, 403), or it authenticated as somebody the profile is not
 * pinned to. A human has to fix that, so the listener may stop.
 *
 * `transient` is everything else — 5xx, 408, 429, a connection reset, a DNS or
 * TLS failure, a timeout, a proxy's HTML error page. The credential was never
 * judged, so the only correct response is to back off and keep trying: a
 * server that is rebooting must not turn into an hours-long silence. This is
 * the exact misclassification that made watchers exit 4 on a boot-time 502.
 */
export type OpenFailureKind = 'identity' | 'transient'

export function openFailureKind(err: unknown): OpenFailureKind {
  if (err instanceof IdentityError) return 'identity'
  const status = httpStatus(err)
  return status === 401 || status === 403 ? 'identity' : 'transient'
}

export interface Session {
  conn: ConnectionConfig
  client: MattermostClient
  state: AgentState
  token: string
  selfUserId: string
  selfUsername: string
  scope: ChannelScope
}

/** Resolve the token, verify the identity, and open that identity's state. */
export async function openSession(config: AgentConfig, connectionId: string): Promise<Session> {
  const conn = connectionById(config, connectionId)
  const token = await resolveToken(conn)
  const client = new MattermostClient(conn.url, token)
  const me = await client.me()
  // A pinned connection stops here if the credential moved to another account:
  // acting as, or reading the mail of, an unintended identity is worse than
  // not starting. The check is on the immutable user id, not the username.
  if (conn.expectedUserId && me.id !== conn.expectedUserId) {
    throw new IdentityError(
      `connection ${conn.id}: the credential authenticates as ${me.username} (${me.id}), ` +
        `but this connection is pinned to user id ${conn.expectedUserId}. Refusing to act as the wrong identity.`,
    )
  }
  const state = AgentState.open({
    stateDir: config.stateDir,
    connectionId: conn.id,
    origin: new URL(conn.url).origin,
    userId: me.id,
  })
  const scope = channelScope(conn, client, me.id)
  // Membership mode needs the set before anything can be listed; static mode's
  // refresh is a no-op, so this costs one request only where it buys something.
  await scope.refresh()
  return { conn, client, state, token, selfUserId: me.id, selfUsername: me.username, scope }
}

export async function openSessions(config: AgentConfig, connectionId?: string): Promise<Session[]> {
  const ids = connectionId ? [connectionId] : config.connections.map((c) => c.id)
  const sessions: Session[] = []
  for (const id of ids) sessions.push(await openSession(config, id))
  return sessions
}

export function closeSessions(sessions: Session[]): void {
  for (const session of sessions) session.state.close()
}

export interface PendingEvent {
  connection: string
  event_id: string
  post_id: string
  channel_id: string
  root_id: string
  sender_id: string
  text: string
  created_at: number
  updated_at: number
  attempts: number
  replied: boolean
}

/**
 * Unhandled events, scoped. A stored event whose channel has left this
 * connection's scope — the allowlist was narrowed, the account left the
 * channel — is not listed: an agent must not be pointed at mail it may no
 * longer read or answer. In membership mode this filters on the last
 * membership refresh; the reply path re-checks with the server.
 */
export function listPending(sessions: Session[], limit = 50): PendingEvent[] {
  const out: PendingEvent[] = []
  for (const session of sessions) {
    for (const event of session.state.pending(limit)) {
      if (!session.scope.knows(event.channel_id)) continue
      out.push({
        connection: session.conn.id,
        event_id: event.event_id,
        post_id: event.post_id,
        channel_id: event.channel_id,
        root_id: event.root_id,
        sender_id: event.sender_id,
        text: event.text,
        created_at: event.created_at,
        updated_at: event.updated_at,
        attempts: event.attempts,
        replied: session.state.outbound(event.event_id)?.status === 'sent',
      })
    }
  }
  return out.sort((a, b) => a.created_at - b.created_at).slice(0, limit)
}

/**
 * The one authorisation gate. Static mode answers from the allowlist;
 * membership mode asks the server about this channel, so a join or a leave
 * applies to the very next operation.
 */
export async function requireChannel(session: Session, channelId: string): Promise<void> {
  const decision = await session.scope.check(channelId)
  if (!decision.allowed) throw new BackendError(decision.reason ?? `channel ${channelId} is out of scope`)
}

function requireEvent(session: Session, eventId: string): StoredEvent {
  const event = session.state.event(eventId)
  if (!event) throw new BackendError(`unknown event ${eventId} on connection ${session.conn.id}`)
  return event
}

export interface ReadPostResult {
  post: MMListPost
  /** The whole thread, oldest first, so a reply can be written with context. */
  thread: MMListPost[]
}

export async function readPost(session: Session, postId: string): Promise<ReadPostResult> {
  const post = await session.client.getPost(postId)
  await requireChannel(session, String(post.channel_id))
  const list = await session.client.getThread(post.root_id || post.id)
  const thread = list.order
    .map((id) => list.posts[id])
    .filter((p): p is MMListPost => Boolean(p))
    .sort((a, b) => a.create_at - b.create_at)
  return { post, thread }
}

export async function readChannel(session: Session, channelId: string, limit = 30): Promise<MMListPost[]> {
  await requireChannel(session, channelId)
  const list = await session.client.getChannelPosts(channelId, Math.min(Math.max(limit, 1), 200))
  return list.order
    .map((id) => list.posts[id])
    .filter((p): p is MMListPost => Boolean(p))
    .sort((a, b) => a.create_at - b.create_at)
}

export interface CreatePostArgs {
  channel_id: string
  message: string
  root_id?: string
  /** Caller-chosen idempotency key. The same key + same destination + same text never posts twice. */
  request_id: string
}

export interface CreatePostResult {
  status: 'sent' | 'unknown'
  duplicate: boolean
  post_id: string | null
  channel_id: string
  root_id: string
  request_id: string
  note?: string
}

/**
 * Start a conversation: post into a configured channel without any inbound
 * event. It settles nothing — an agent-initiated post is not an answer, and
 * inventing a fake inbox event to carry it would corrupt the pending set.
 *
 * Idempotency uses the same atomic reservation as `reply`, keyed
 * `send:<request_id>` and identified by destination + text, so a retry after an
 * ambiguous failure cannot silently double-post into a shared channel.
 */
export async function createPost(session: Session, args: CreatePostArgs): Promise<CreatePostResult> {
  if (args.message.trim().length === 0) throw new BackendError('message is empty')
  if (args.request_id.trim().length === 0) throw new BackendError('request_id is required')
  await requireChannel(session, args.channel_id)

  let rootId = args.root_id ?? ''
  if (rootId) {
    const root = await session.client.getPost(rootId)
    if (String(root.channel_id) !== args.channel_id) {
      throw new BackendError(`root post ${rootId} is in channel ${String(root.channel_id)}, not ${args.channel_id}`)
    }
    // Mattermost threads are one level deep: replying to a reply roots at its root.
    rootId = root.root_id || root.id
  }

  const key = `send:${args.request_id}`
  const target = { channel_id: args.channel_id, root_id: rootId, request_id: args.request_id }
  // Identity is destination + text: reusing a request_id for anything else is a conflict, not a resend.
  const payload = JSON.stringify({ channel_id: args.channel_id, root_id: rootId, message: args.message })
  const claim = session.state.claimOutbound(key, payload)
  if (!claim.claimed) {
    const previous = claim.existing
    if (!previous) throw new BackendError(`request ${args.request_id} state is unreadable; retry`)
    if (previous.message !== payload) {
      throw new BackendError(
        `request_id ${args.request_id} was already used for a different destination or text; use a new request_id`,
      )
    }
    if (previous.status === 'sent') {
      return { ...target, status: 'sent', duplicate: true, post_id: previous.post_id, note: 'already posted; nothing was sent' }
    }
    return {
      ...target,
      status: 'unknown',
      duplicate: true,
      post_id: null,
      note: `a previous attempt with this request_id ended ambiguously (${previous.error ?? 'no detail'}); read the channel before retrying`,
    }
  }

  try {
    const post = await session.client.createPost({ channel_id: args.channel_id, message: args.message, root_id: rootId || undefined })
    session.state.markSendSent(key, post.id)
    return { ...target, status: 'sent', duplicate: false, post_id: post.id }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    if (definitelyRejected(detail)) {
      session.state.markOutboundOutcome(key, 'failed', detail.slice(0, 500))
      throw new BackendError(`Mattermost rejected the post: ${detail}`)
    }
    session.state.markOutboundOutcome(key, 'unknown', detail.slice(0, 500))
    return {
      ...target,
      status: 'unknown',
      duplicate: false,
      post_id: null,
      note: `the post may or may not have landed (${detail}); retry with the SAME request_id to avoid a duplicate`,
    }
  }
}

export interface ReplyResult {
  status: 'sent' | 'unknown'
  /** True when this call did nothing because the identical reply is already recorded. */
  duplicate: boolean
  post_id: string | null
  channel_id: string
  root_id: string
  event_id: string
  note?: string
}

/**
 * Reply in the thread of one stored event, then settle that event and nothing
 * else. Idempotent per (event, exact message text): the same text returns the
 * recorded result, different text for an answered event is a conflict rather
 * than a second post.
 *
 * The claim is taken atomically before the HTTP call, so two processes racing
 * on one event post once. Only a definitive 4xx rejection is retryable — a 5xx
 * or a network error may have created the post, so it stays `unknown` and is
 * surfaced instead of silently retried. Mattermost has no idempotency key; a
 * blind repost is how an agent double-answers.
 */
export async function reply(session: Session, eventId: string, message: string): Promise<ReplyResult> {
  if (message.trim().length === 0) throw new BackendError('reply message is empty')
  const event = requireEvent(session, eventId)
  await requireChannel(session, event.channel_id)
  const rootId = event.root_id || event.post_id
  const target = { channel_id: event.channel_id, root_id: rootId, event_id: eventId }

  const claim = session.state.claimOutbound(eventId, message)
  if (!claim.claimed) {
    const previous = claim.existing
    if (!previous) throw new BackendError(`event ${eventId} reply state is unreadable; retry`)
    if (previous.message !== message) {
      throw new BackendError(
        `event ${eventId} already has a ${previous.status} reply with different text; refusing to post a second answer`,
      )
    }
    if (previous.status === 'sent') {
      // Re-settle: a crash between the post and the ack must not leave the event pending forever.
      session.state.ack(eventId)
      return { ...target, status: 'sent', duplicate: true, post_id: previous.post_id, note: 'identical reply already delivered; nothing was posted' }
    }
    return {
      ...target,
      status: 'unknown',
      duplicate: true,
      post_id: null,
      note: `a previous attempt at this exact reply ended ambiguously (${previous.error ?? 'no detail'}); read the channel and decide before retrying`,
    }
  }

  try {
    const post = await session.client.createPost({ channel_id: event.channel_id, message, root_id: rootId })
    session.state.markOutboundSent(eventId, post.id)
    return { ...target, status: 'sent', duplicate: false, post_id: post.id }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    if (definitelyRejected(detail)) {
      session.state.markOutboundOutcome(eventId, 'failed', detail.slice(0, 500))
      throw new BackendError(`Mattermost rejected the reply: ${detail}`)
    }
    session.state.markOutboundOutcome(eventId, 'unknown', detail.slice(0, 500))
    return {
      ...target,
      status: 'unknown',
      duplicate: false,
      post_id: null,
      note: `the post may or may not have landed (${detail}); the event stays pending — read the channel before retrying`,
    }
  }
}

/**
 * True only when the server answered with a status that means "nothing was
 * created": a 4xx other than 408 (timeout) and 429 (throttled), both of which
 * can accompany a request the server did process. 5xx and transport errors are
 * ambiguous by construction — a gateway can time out after the post landed.
 */
export function definitelyRejected(detail: string): boolean {
  const match = /HTTP (\d{3})/.exec(detail)
  if (!match) return false
  const status = Number(match[1])
  return status >= 400 && status < 500 && status !== 408 && status !== 429
}

export function markHandled(session: Session, eventId: string): { event_id: string; already_handled: boolean } {
  const event = requireEvent(session, eventId)
  const already = event.acked_at !== null
  session.state.ack(eventId)
  return { event_id: eventId, already_handled: already }
}

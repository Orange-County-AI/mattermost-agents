/**
 * Turning Mattermost posts into agent events.
 *
 * Everything here is measured against the live OCAI server (Team Edition
 * 11.9.0), not assumed:
 *   - `GET /channels/{id}/posts?since=` filters on update_at, ignores
 *     `page`/`per_page`, and answers in ONE response. There is no cursor, so a
 *     window larger than the server cap loses the OLDEST posts of the window —
 *     hence the overflow check below rather than a paging loop.
 *   - a deleted post comes back in that scan as a tombstone (delete_at > 0,
 *     message emptied); GET /posts/{id} answers 404 for it.
 *   - EDITING a post also creates a tombstone holding the previous revision,
 *     distinguished only by original_id pointing at the live post.
 *   - agent posts carry props.from_bot === "true", so "drop all bot posts"
 *     would drop every peer agent. Only self is always dropped; other bots are
 *     dropped unless explicitly allowlisted.
 */
import type { MMListPost, MMPostList } from '../mattermost'
import type { EventInput } from './state'

/** Mattermost caps a `since` scan; past this we cannot prove we saw the whole window. */
export const SINCE_RESULT_LIMIT = 1000

/** Event text is bounded so one wall-of-text post cannot flood a turn. read_post has the full body. */
export const MAX_EVENT_TEXT = 4000

export interface IngestPolicy {
  connection: string
  selfUserId: string
  allowedBotIds: string[]
  /**
   * Mattermost user id → username, filled by the watcher before it plans a
   * sweep. A post carries only the opaque id, and an id alone tells a model
   * nothing about who is talking; the name travels with the event so a replay
   * never has to ask the directory again. Missing means the lookup failed —
   * honest emptiness, never a guess.
   */
  usernames?: Record<string, string>
}

export type SkipReason = 'self' | 'bot-not-allowlisted' | 'system' | 'tombstone' | 'edit-revision' | 'empty'

export function classify(post: MMListPost, policy: IngestPolicy): SkipReason | 'deliver' {
  const deleteAt = numberField(post, 'delete_at')
  if (deleteAt > 0) return stringField(post, 'original_id') === '' ? 'tombstone' : 'edit-revision'
  if (post.user_id === policy.selfUserId) return 'self'
  const type = stringField(post, 'type')
  if (type.startsWith('system_')) return 'system'
  if (isFromBot(post) && !policy.allowedBotIds.includes(post.user_id)) return 'bot-not-allowlisted'
  if (post.message.trim().length === 0) return 'empty'
  return 'deliver'
}

export function isFromBot(post: MMListPost): boolean {
  const props = post.props
  if (!props || typeof props !== 'object' || !('from_bot' in props)) return false
  const flag = props.from_bot
  return flag === 'true' || flag === true
}

/**
 * Event identity is post id + CONTENT revision — edit_at when the post has been
 * edited, else create_at. Deliberately not update_at: Mattermost bumps
 * update_at for bookkeeping (a reply threading under the post, a reaction),
 * and keying on it makes an agent's own answer re-deliver the message it just
 * answered. update_at still drives the catch-up checkpoint, where "anything
 * touched since" is exactly what we want.
 */
export function eventId(connection: string, post: MMListPost): string {
  return `${connection}:${post.id}:${numberField(post, 'edit_at') || post.create_at}`
}

export function toEvent(post: MMListPost, policy: IngestPolicy): EventInput {
  const text = post.message.length > MAX_EVENT_TEXT ? `${post.message.slice(0, MAX_EVENT_TEXT)}\n[truncated]` : post.message
  return {
    event_id: eventId(policy.connection, post),
    connection: policy.connection,
    post_id: post.id,
    channel_id: stringField(post, 'channel_id'),
    root_id: post.root_id,
    sender_id: post.user_id,
    sender_username: policy.usernames?.[post.user_id] ?? '',
    text,
    created_at: post.create_at,
    updated_at: numberField(post, 'update_at') || post.create_at,
  }
}

export interface SweepPlan {
  events: EventInput[]
  /** Where the checkpoint should stand after this sweep commits. Never moves backwards. */
  checkpoint: number
  observed: number
  /**
   * Set when the server cap hid part of the window. `since` has no cursor, so
   * the capped response keeps the NEWEST posts and silently drops the oldest of
   * the window: the only honest response is to keep the checkpoint, record the
   * gap and say catch-up is degraded.
   */
  overflow?: { from_ms: number; to_ms: number; observed: number }
}

/**
 * Plan one channel sweep. `priorCheckpoint` keeps the result monotone even
 * though callers deliberately re-request a small overlap (`since` is exclusive
 * on update_at, so a post written in the same millisecond as the checkpoint
 * would otherwise never be seen).
 */
export function planSweep(list: MMPostList, since: number, policy: IngestPolicy, priorCheckpoint = since): SweepPlan {
  const posts = list.order.map((id) => list.posts[id]).filter((p): p is MMListPost => Boolean(p))
  posts.sort((a, b) => (numberField(a, 'update_at') || a.create_at) - (numberField(b, 'update_at') || b.create_at))

  const events: EventInput[] = []
  let checkpoint = priorCheckpoint
  let oldest = Number.POSITIVE_INFINITY
  for (const post of posts) {
    const updatedAt = numberField(post, 'update_at') || post.create_at
    checkpoint = Math.max(checkpoint, updatedAt)
    oldest = Math.min(oldest, updatedAt)
    if (classify(post, policy) === 'deliver') events.push(toEvent(post, policy))
  }

  if (posts.length >= SINCE_RESULT_LIMIT) {
    // Keep the checkpoint: everything between `since` and the oldest row we got
    // was never returned, and advancing would abandon it.
    return { events, checkpoint: priorCheckpoint, observed: posts.length, overflow: { from_ms: since, to_ms: oldest, observed: posts.length } }
  }
  return { events, checkpoint, observed: posts.length }
}

function numberField(post: MMListPost, key: string): number {
  const value = post[key]
  return typeof value === 'number' ? value : 0
}

function stringField(post: MMListPost, key: string): string {
  const value = post[key]
  return typeof value === 'string' ? value : ''
}

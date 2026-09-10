import { describe, expect, test } from 'bun:test'
import type { MMListPost, MMPostList } from '../mattermost'
import { classify, eventId, planSweep, SINCE_RESULT_LIMIT, toEvent, type IngestPolicy } from './ingest'

const SELF = 'self-bot-id'
const PEER_BOT = 'peer-bot-id'
const HUMAN = 'human-id'

const policy: IngestPolicy = { connection: 'ocai', selfUserId: SELF, allowedBotIds: [PEER_BOT] }

function post(overrides: Partial<MMListPost> & { id: string; user_id: string }): MMListPost {
  return {
    channel_id: 'chan',
    message: 'hello',
    root_id: '',
    create_at: 1000,
    update_at: 1000,
    edit_at: 0,
    delete_at: 0,
    original_id: '',
    type: '',
    props: {},
    ...overrides,
  }
}

function list(posts: MMListPost[]): MMPostList {
  return { order: posts.map((p) => p.id), posts: Object.fromEntries(posts.map((p) => [p.id, p])) }
}

describe('classify', () => {
  test('delivers a human post and a peer bot post, drops self and unlisted bots', () => {
    expect(classify(post({ id: 'a', user_id: HUMAN }), policy)).toBe('deliver')
    expect(classify(post({ id: 'b', user_id: PEER_BOT, props: { from_bot: 'true' } }), policy)).toBe('deliver')
    expect(classify(post({ id: 'c', user_id: SELF, props: { from_bot: 'true' } }), policy)).toBe('self')
    expect(classify(post({ id: 'd', user_id: 'other-bot', props: { from_bot: 'true' } }), policy)).toBe('bot-not-allowlisted')
  })

  test('a peer that is not flagged as a bot is delivered without allowlisting', () => {
    expect(classify(post({ id: 'e', user_id: 'canary-peer' }), policy)).toBe('deliver')
  })

  test('separates a real deletion from the tombstone Mattermost writes for an edit', () => {
    expect(classify(post({ id: 'f', user_id: HUMAN, delete_at: 2000 }), policy)).toBe('tombstone')
    expect(classify(post({ id: 'g', user_id: HUMAN, delete_at: 2000, original_id: 'f' }), policy)).toBe('edit-revision')
  })

  test('drops join/leave system posts', () => {
    expect(classify(post({ id: 'h', user_id: HUMAN, type: 'system_join_channel' }), policy)).toBe('system')
  })
})

describe('planSweep', () => {
  test('bookkeeping bumps keep the same event id; a genuine edit gets a new one', () => {
    const original = post({ id: 'p1', user_id: HUMAN, create_at: 1000, update_at: 1000 })
    // A reply threading under p1, or a reaction, bumps update_at with edit_at 0.
    const bumped = post({ id: 'p1', user_id: HUMAN, create_at: 1000, update_at: 4000, edit_at: 0 })
    const edited = post({ id: 'p1', user_id: HUMAN, create_at: 1000, update_at: 5000, edit_at: 4999, message: 'fixed' })

    expect(eventId('ocai', bumped)).toBe(eventId('ocai', original))
    expect(eventId('ocai', edited)).not.toBe(eventId('ocai', original))
    expect(toEvent(edited, policy).post_id).toBe('p1')
  })

  test('checkpoint tracks the newest update_at across the whole window, not the newest delivered post', () => {
    const plan = planSweep(
      list([
        post({ id: 'p1', user_id: HUMAN, update_at: 1500 }),
        post({ id: 'p2', user_id: SELF, update_at: 9000 }),
        post({ id: 'p3', user_id: HUMAN, update_at: 3000 }),
      ]),
      1000,
      policy,
    )
    expect(plan.events.map((e) => e.post_id)).toEqual(['p1', 'p3'])
    expect(plan.checkpoint).toBe(9000)
    expect(plan.overflow).toBeUndefined()
  })

  test('the checkpoint never moves backwards when the window overlaps the previous one', () => {
    const plan = planSweep(list([post({ id: 'p1', user_id: HUMAN, update_at: 2000 })]), 2999, policy, 3000)
    expect(plan.checkpoint).toBe(3000)
  })

  test('a capped window keeps the checkpoint and reports a gap instead of abandoning unseen posts', () => {
    const posts = Array.from({ length: SINCE_RESULT_LIMIT }, (_, i) =>
      post({ id: `p${i}`, user_id: HUMAN, create_at: 5000 + i, update_at: 5000 + i }),
    )
    const plan = planSweep(list(posts), 1000, policy, 1000)
    expect(plan.overflow).toEqual({ from_ms: 1000, to_ms: 5000, observed: SINCE_RESULT_LIMIT })
    expect(plan.checkpoint).toBe(1000)
    expect(plan.events).toHaveLength(SINCE_RESULT_LIMIT)
  })

  test('bounds event text so one huge post cannot flood a turn', () => {
    const event = toEvent(post({ id: 'big', user_id: HUMAN, message: 'x'.repeat(9000) }), policy)
    expect(event.text.length).toBeLessThan(9000)
    expect(event.text.endsWith('[truncated]')).toBe(true)
  })
})

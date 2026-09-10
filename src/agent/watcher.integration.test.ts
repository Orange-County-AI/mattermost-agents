/**
 * End-to-end coverage against a fake Mattermost, exercising the behaviours the
 * live canary proved once: successive messages on one resident process, catch-up
 * across a restart, no re-delivery of settled events, and a failed fetch that
 * refuses to move the checkpoint.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MattermostClient, type MMListPost } from '../mattermost'
import { createPost, openSession, readChannel, reply, BackendError, type Session } from './backend'
import type { AgentConfig, ConnectionConfig } from './config'
import { AgentState } from './state'
import { ConnectionWatcher } from './watcher'

const SELF = 'bot-1'
const PEER = 'peer-1'
const CHANNEL = 'chan-1'

interface FakeServer {
  url: string
  port: number
  post(args: { user_id?: string; message: string; root_id?: string; id?: string }): MMListPost
  edit(id: string, message: string): void
  bump(id: string): number
  posts: MMListPost[]
  failSinceWith: number | null
  failPostWith: number | null
  stop(): void
}

function startFakeMattermost(): FakeServer {
  const posts: MMListPost[] = []
  // Anchored to now: the watcher's first sweep only reaches back INITIAL_LOOKBACK_MS.
  let clock = Date.now() - 60_000
  let counter = 0
  const state = { failSinceWith: null as number | null, failPostWith: null as number | null }

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === '/api/v4/websocket') {
        if (srv.upgrade(req)) return undefined
        return new Response('expected websocket', { status: 400 })
      }
      if (url.pathname === '/api/v4/users/me') return Response.json({ id: SELF, username: 'clem' })

      const channelPosts = /^\/api\/v4\/channels\/([^/]+)\/posts$/.exec(url.pathname)
      if (channelPosts) {
        const since = url.searchParams.get('since')
        if (since !== null && state.failSinceWith) return new Response('boom', { status: state.failSinceWith })
        const selected = since === null ? posts : posts.filter((p) => Number(p.update_at) > Number(since))
        return Response.json({
          order: [...selected].reverse().map((p) => p.id),
          posts: Object.fromEntries(selected.map((p) => [p.id, p])),
        })
      }
      if (url.pathname === '/api/v4/posts' && req.method === 'POST') {
        if (state.failPostWith) return new Response('nope', { status: state.failPostWith })
        return req.json().then((body) => {
          const parsed = body as { channel_id: string; message: string; root_id?: string }
          return Response.json(create({ user_id: SELF, message: parsed.message, root_id: parsed.root_id }))
        })
      }
      const single = /^\/api\/v4\/posts\/([^/]+)$/.exec(url.pathname)
      if (single) {
        const found = posts.find((p) => p.id === single[1])
        return found ? Response.json(found) : new Response('not found', { status: 404 })
      }
      const thread = /^\/api\/v4\/posts\/([^/]+)\/thread$/.exec(url.pathname)
      if (thread) {
        const root = thread[1]
        const selected = posts.filter((p) => p.id === root || p.root_id === root)
        return Response.json({
          order: selected.map((p) => p.id),
          posts: Object.fromEntries(selected.map((p) => [p.id, p])),
        })
      }
      return new Response('unhandled', { status: 404 })
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ event: 'hello', data: { connection_id: 'fake' }, seq: 0 }))
      },
      message() {},
    },
  })

  function create(args: { user_id?: string; message: string; root_id?: string; id?: string }): MMListPost {
    clock += 1000
    counter += 1
    const post: MMListPost = {
      id: args.id ?? `post-${counter}`,
      channel_id: CHANNEL,
      user_id: args.user_id ?? PEER,
      message: args.message,
      root_id: args.root_id ?? '',
      create_at: clock,
      update_at: clock,
      edit_at: 0,
      delete_at: 0,
      original_id: '',
      type: '',
      props: {},
    }
    posts.push(post)
    return post
  }

  const port = server.port
  if (port === undefined) throw new Error('fake Mattermost did not bind a port')

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    posts,
    post: create,
    edit(id, message) {
      const found = posts.find((p) => p.id === id)
      if (!found) throw new Error(`no post ${id}`)
      clock += 1000
      found.message = message
      found.update_at = clock
      found.edit_at = clock
    },
    /** Bookkeeping touch: update_at moves, content and edit_at do not (a threaded reply, a reaction). */
    bump(id: string): number {
      const found = posts.find((p) => p.id === id)
      if (!found) throw new Error(`no post ${id}`)
      clock += 1000
      found.update_at = clock
      return clock
    },
    get failSinceWith() {
      return state.failSinceWith
    },
    set failSinceWith(value: number | null) {
      state.failSinceWith = value
    },
    get failPostWith() {
      return state.failPostWith
    },
    set failPostWith(value: number | null) {
      state.failPostWith = value
    },
    stop: () => server.stop(true),
  }
}

let fake: FakeServer
let stateDir: string
let conn: ConnectionConfig

beforeEach(() => {
  fake = startFakeMattermost()
  stateDir = mkdtempSync(join(tmpdir(), 'agent-watch-'))
  conn = {
    id: 'test',
    url: fake.url,
    tokenEnv: 'FAKE_TOKEN',
    channelIds: [CHANNEL],
    watchMemberships: false,
    allowedBotIds: [],
    pollIntervalMs: 1000,
  }
})

afterEach(() => fake.stop())

function openWatcher(lines: string[], logs: string[]): { watcher: ConnectionWatcher; state: AgentState } {
  const state = AgentState.open({ stateDir, connectionId: conn.id, origin: fake.url, userId: SELF })
  const watcher = new ConnectionWatcher(conn, new MattermostClient(fake.url, 'token'), state, 'token', SELF, {
    emit: (line) => lines.push(line),
    log: (line) => logs.push(line),
  })
  return { watcher, state }
}

interface EmittedMessage {
  event_id: string
  post_id: string
  text: string
  replayed: boolean
  root_id: string
  sender_id: string
}

const parsed = (lines: string[]): EmittedMessage[] => lines.map((line) => JSON.parse(line) as EmittedMessage)

// These tests drive a real HTTP/WebSocket server and the watcher's own poll
// timer, so time is genuinely real here; every wait is on an observable
// condition (a printed line, a moved checkpoint), never on a guessed duration.
async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(50)
  }
  throw new Error('timed out waiting for condition')
}

describe('watcher', () => {
  test('one resident process emits successive messages and never repeats one', async () => {
    const lines: string[] = []
    const logs: string[] = []
    const { watcher, state } = openWatcher(lines, logs)
    fake.post({ message: 'first' })
    await watcher.start()
    await waitFor(() => lines.length === 1)

    fake.post({ message: 'second' })
    await waitFor(() => lines.length === 2)
    watcher.stop()

    expect(parsed(lines).map((m) => m.text)).toEqual(['first', 'second'])
    expect(parsed(lines).every((m) => !m.replayed)).toBe(true)
    expect(state.pending()).toHaveLength(2)
    state.close()
  })

  test('a post that lands while the watcher is down is delivered on restart, settled ones are not', async () => {
    const firstRun: string[] = []
    const logs: string[] = []
    const first = openWatcher(firstRun, logs)
    fake.post({ message: 'before restart' })
    await first.watcher.start()
    await waitFor(() => firstRun.length === 1)
    const delivered = parsed(firstRun)[0] as EmittedMessage
    first.state.ack(delivered.event_id)
    first.watcher.stop()
    first.state.close()

    fake.post({ message: 'while offline' })

    const secondRun: string[] = []
    const second = openWatcher(secondRun, logs)
    await second.watcher.start()
    await waitFor(() => secondRun.length === 1)
    second.watcher.stop()

    expect(parsed(secondRun).map((m) => m.text)).toEqual(['while offline'])
    second.state.close()
  })

  test('an unsettled event is replayed after a restart, flagged as a replay', async () => {
    const firstRun: string[] = []
    const logs: string[] = []
    const first = openWatcher(firstRun, logs)
    fake.post({ message: 'unhandled' })
    await first.watcher.start()
    await waitFor(() => firstRun.length === 1)
    first.watcher.stop()
    first.state.close()

    const secondRun: string[] = []
    const second = openWatcher(secondRun, logs)
    await second.watcher.start()
    await waitFor(() => secondRun.length === 1)
    second.watcher.stop()

    const replayed = parsed(secondRun)[0] as EmittedMessage
    expect(replayed.text).toBe('unhandled')
    expect(replayed.replayed).toBe(true)
    expect(replayed.event_id).toBe((parsed(firstRun)[0] as EmittedMessage).event_id)
    second.state.close()
  })

  test('a failing fetch leaves the checkpoint alone, and the message arrives once the server recovers', async () => {
    const lines: string[] = []
    const logs: string[] = []
    const { watcher, state } = openWatcher(lines, logs)
    fake.post({ message: 'first' })
    await watcher.start()
    await waitFor(() => lines.length === 1)
    const checkpoint = state.checkpoint(CHANNEL)

    fake.failSinceWith = 500
    fake.post({ message: 'during outage' })
    await waitFor(() => logs.some((l) => l.includes('sweep failed')))
    expect(state.checkpoint(CHANNEL)).toBe(checkpoint as number)
    expect(lines).toHaveLength(1)

    fake.failSinceWith = null
    await waitFor(() => lines.length === 2)
    watcher.stop()
    expect(parsed(lines)[1]?.text).toBe('during outage')
    state.close()
  })

  test('an edit is a new event; a reply threading under a post is not', async () => {
    const lines: string[] = []
    const logs: string[] = []
    const { watcher, state } = openWatcher(lines, logs)
    const original = fake.post({ message: 'original' })
    await watcher.start()
    await waitFor(() => lines.length === 1)

    // Mattermost bumps the root post's update_at when a reply threads under it.
    // Wait for the sweep that OBSERVED the bump (the checkpoint moves), then
    // assert nothing was emitted for it.
    const bumped = fake.bump(original.id)
    await waitFor(() => state.checkpoint(CHANNEL) === bumped)
    expect(lines).toHaveLength(1)

    fake.edit(original.id, 'original, corrected')
    await waitFor(() => lines.length === 2)
    watcher.stop()

    const messages = parsed(lines)
    expect(messages[1]?.text).toBe('original, corrected')
    expect(messages[1]?.post_id).toBe(original.id)
    expect(messages[1]?.event_id).not.toBe(messages[0]?.event_id)
    state.close()
  })
})

describe('reply', () => {
  const config = (): AgentConfig => ({ version: 1, stateDir, connections: [conn] })

  async function seed(): Promise<{ session: Session; eventId: string }> {
    process.env.FAKE_TOKEN = 'token'
    const lines: string[] = []
    const logs: string[] = []
    const { watcher, state } = openWatcher(lines, logs)
    fake.post({ message: 'question' })
    await watcher.start()
    await waitFor(() => lines.length === 1)
    watcher.stop()
    state.close()
    const session = await openSession(config(), conn.id)
    const [pending] = session.state.pending()
    if (!pending) throw new Error('no pending event')
    return { session, eventId: pending.event_id }
  }

  test('replies in the triggering thread and settles only that event', async () => {
    const { session, eventId } = await seed()
    fake.post({ message: 'unrelated second question' })
    const before = session.state.pending().length

    const stored = session.state.event(eventId)
    if (!stored) throw new Error('the event vanished from state')
    const result = await reply(session, eventId, 'answer')
    expect(result.status).toBe('sent')
    expect(result.root_id).toBe(stored.post_id)
    expect(fake.posts.at(-1)?.root_id).toBe(result.root_id)
    expect(session.state.pending().some((e) => e.event_id === eventId)).toBe(false)
    expect(session.state.pending()).toHaveLength(before - 1)
    session.state.close()
  })

  test('the identical reply is a no-op and re-settles the event; different text is refused', async () => {
    const { session, eventId } = await seed()
    const first = await reply(session, eventId, 'answer')
    const postCount = fake.posts.length

    const again = await reply(session, eventId, 'answer')
    expect(again).toMatchObject({ status: 'sent', duplicate: true, post_id: first.post_id })
    expect(fake.posts).toHaveLength(postCount)

    await expect(reply(session, eventId, 'a different answer')).rejects.toThrow(BackendError)
    expect(fake.posts).toHaveLength(postCount)
    session.state.close()
  })

  test('a 5xx leaves the outcome unknown and the event pending; a 4xx is a definite rejection', async () => {
    const { session, eventId } = await seed()
    fake.failPostWith = 503
    const ambiguous = await reply(session, eventId, 'answer')
    expect(ambiguous.status).toBe('unknown')
    expect(session.state.pending().some((e) => e.event_id === eventId)).toBe(true)
    // The ambiguous attempt is not retaken automatically — an agent must look first.
    expect(await reply(session, eventId, 'answer')).toMatchObject({ status: 'unknown', duplicate: true })

    const other = fake.post({ message: 'second question' })
    const lines: string[] = []
    const logs: string[] = []
    const { watcher, state } = openWatcher(lines, logs)
    await watcher.start()
    await waitFor(() => lines.some((l) => l.includes(other.id)))
    watcher.stop()
    state.close()

    const secondEvent = session.state.pending().find((e) => e.post_id === other.id)
    fake.failPostWith = 403
    await expect(reply(session, secondEvent?.event_id as string, 'answer')).rejects.toThrow(BackendError)
    fake.failPostWith = null
    const retried = await reply(session, secondEvent?.event_id as string, 'answer')
    expect(retried.status).toBe('sent')
    session.state.close()
  })

  test('a channel outside the connection allowlist is refused', async () => {
    const { session } = await seed()
    await expect(readChannel(session, 'someone-elses-channel')).rejects.toThrow(BackendError)
    session.state.close()
  })
})

describe('createPost', () => {
  async function session(): Promise<Session> {
    process.env.FAKE_TOKEN = 'token'
    return openSession({ version: 1, stateDir, connections: [conn] }, conn.id)
  }

  test('posts into an allowlisted channel, settles nothing, and is idempotent per request_id', async () => {
    const open = await session()
    const first = await createPost(open, { channel_id: CHANNEL, message: 'kicking off', request_id: 'req-1' })
    expect(first).toMatchObject({ status: 'sent', duplicate: false })
    expect(open.state.pending()).toHaveLength(0)

    const again = await createPost(open, { channel_id: CHANNEL, message: 'kicking off', request_id: 'req-1' })
    expect(again).toMatchObject({ status: 'sent', duplicate: true, post_id: first.post_id })
    expect(fake.posts.filter((p) => p.message === 'kicking off')).toHaveLength(1)

    await expect(createPost(open, { channel_id: CHANNEL, message: 'something else', request_id: 'req-1' })).rejects.toThrow(
      BackendError,
    )
    open.state.close()
  })

  test('refuses a channel outside the allowlist and a root post from another channel', async () => {
    const open = await session()
    await expect(createPost(open, { channel_id: 'other-chan', message: 'hi', request_id: 'req-2' })).rejects.toThrow(BackendError)

    const foreign = fake.post({ message: 'elsewhere' })
    const post = fake.posts.find((p) => p.id === foreign.id) as MMListPost
    post.channel_id = 'other-chan'
    await expect(
      createPost(open, { channel_id: CHANNEL, message: 'hi', root_id: foreign.id, request_id: 'req-3' }),
    ).rejects.toThrow(BackendError)
    open.state.close()
  })
})

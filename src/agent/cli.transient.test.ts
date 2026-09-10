/**
 * Where the line between "the credential was refused" and "the server has not
 * answered yet" is drawn, observed the way an adapter observes it: by running
 * the real CLI as a child process and watching whether it is still there.
 *
 * This is a regression suite for a measured outage. After a host reboot the
 * Mattermost server behind Cloudflare answered 502 for a while; the watcher
 * classified that as an authentication failure, exited 4 — which a harness
 * treats as "a human must fix the credential, do not restart" — and several
 * agents stayed deaf for hours with perfectly good tokens.
 *
 * The claims are observable ones: the process is alive or it is not, mail
 * arrives or it does not, the exit code is 4 or it never comes.
 *
 * Real time is unavoidable here (a child process, sockets, retry backoff);
 * every wait is on observed output, never on a guessed duration.
 */
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Subprocess } from 'bun'
import type { MMListPost } from '../mattermost'

const SELF = 'bot-1'
const PEER = 'peer-1'
const CHANNEL = 'chan-1'
const CLI = join(import.meta.dir, 'cli.ts')

/** What the fake answers with right now. `null` = behave like a working server. */
type Failure = { status: number; body: string } | null

interface Fixture {
  url: string
  /** Make every request fail with this status, or set null to recover. */
  fail(failure: Failure): void
  /** How many times the identity call was attempted — one per open attempt. */
  identityCalls(): number
  post(message: string): MMListPost
  stop(): void
}

function serveMattermost(): Fixture {
  const posts: MMListPost[] = []
  const state = { failure: null as Failure, identityCalls: 0 }
  let clock = Date.now() - 30_000
  let counter = 0
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === '/api/v4/websocket') return srv.upgrade(req) ? undefined : new Response('no', { status: 400 })
      if (url.pathname === '/api/v4/users/me') state.identityCalls += 1
      // A rebooting server behind a proxy fails everything, and the proxy's
      // body is HTML, not JSON — exactly what the classifier must not mistake
      // for a judgement about the token.
      if (state.failure) {
        return new Response(state.failure.body, {
          status: state.failure.status,
          headers: { 'content-type': 'text/html' },
        })
      }
      if (url.pathname === '/api/v4/users/me') return Response.json({ id: SELF, username: 'clem' })
      if (/^\/api\/v4\/channels\/[^/]+\/posts$/.test(url.pathname)) {
        const since = Number(url.searchParams.get('since') ?? 0)
        const selected = posts.filter((p) => Number(p.update_at) > since)
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
  return {
    url: `http://127.0.0.1:${server.port}`,
    fail: (failure) => {
      state.failure = failure
    },
    identityCalls: () => state.identityCalls,
    stop: () => server.stop(true),
    post(message) {
      clock += 1000
      counter += 1
      const post: MMListPost = {
        id: `${CHANNEL}-${counter}`,
        channel_id: CHANNEL,
        user_id: PEER,
        message,
        root_id: '',
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
    },
  }
}

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

interface Sink {
  out: string[]
  err: string[]
}

interface Run {
  proc: Subprocess<'ignore', 'pipe', 'pipe'>
  sink: Sink
}

function run(args: string[]): Run {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    env: { ...process.env, FAKE_TOKEN: 'token' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  cleanup.push(() => proc.kill())
  const sink: Sink = { out: [], err: [] }
  const pump = async (stream: ReadableStream<Uint8Array>, into: string[]): Promise<void> => {
    const decoder = new TextDecoder()
    let buffered = ''
    for await (const chunk of stream) {
      buffered += decoder.decode(chunk)
      const parts = buffered.split('\n')
      buffered = parts.pop() ?? ''
      into.push(...parts)
    }
  }
  void pump(proc.stdout, sink.out)
  void pump(proc.stderr, sink.err)
  return { proc, sink }
}

async function until(check: () => boolean, sink: Sink, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(50)
  }
  throw new Error(`timed out.\nstdout:\n${sink.out.join('\n')}\nstderr:\n${sink.err.join('\n')}`)
}

async function writeConfig(fixture: Fixture, overrides: Record<string, unknown> = {}): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-transient-'))
  const path = join(dir, 'config.json')
  await Bun.write(
    path,
    JSON.stringify({
      version: 1,
      stateDir: dir,
      connections: [
        {
          id: 'ocai',
          url: fixture.url,
          tokenEnv: 'FAKE_TOKEN',
          channelIds: [CHANNEL],
          pollIntervalMs: 1000,
          ...overrides,
        },
      ],
    }),
  )
  return path
}

interface StatusRow {
  connection: string
  health: string
  error?: string
  watcher: { state: string; heartbeat_age_ms?: number; last_error?: string; last_error_kind?: string }
}

async function readStatus(config: string): Promise<StatusRow[]> {
  const { proc, sink } = run(['--config', config, 'status'])
  await proc.exited
  return JSON.parse(sink.out.join('\n')) as StatusRow[]
}

const PROXY_PAGE = '<html><head><title>502 Bad Gateway</title></head><body>error code: 502</body></html>'

test('a 502 on the identity call never ends the watcher, and delivery resumes when the server comes back', async () => {
  const fake = serveMattermost()
  cleanup.push(() => fake.stop())
  fake.fail({ status: 502, body: PROXY_PAGE })
  const config = await writeConfig(fake)

  const { proc, sink } = run(['--config', config, 'watch'])
  await until(() => sink.err.some((l) => l.includes('transient-error') && l.includes('DEGRADED')), sink)

  // Still resident, and it says so instead of pretending to be ready.
  await until(() => sink.err.some((l) => l.includes('nothing is listening yet')), sink)
  expect(proc.exitCode).toBeNull()
  expect(sink.err.some((l) => l.includes('auth-error'))).toBe(false)
  expect(sink.err.some((l) => l.includes('shutting down'))).toBe(false)
  expect(sink.out.join('')).toBe('')

  // An operator asking now is told the truth twice over: the server cannot be
  // reached, and a listener IS alive and retrying.
  const degraded = await readStatus(config)
  expect(degraded[0]?.health).toBe('unreachable')
  expect(degraded[0]?.watcher.state).toBe('retrying')
  expect(degraded[0]?.watcher.last_error_kind).toBe('transient')
  expect(degraded[0]?.watcher.last_error).toContain('502')

  // The server comes back. No restart: the supervisor's retry picks it up.
  fake.fail(null)
  fake.post('sent while the server was rebooting')
  await until(() => sink.out.some((l) => l.includes('sent while the server was rebooting')), sink, 90_000)
  expect(proc.exitCode).toBeNull()

  const recovered = await readStatus(config)
  expect(recovered[0]?.health).toBe('live')
  expect(recovered[0]?.watcher.state).toBe('listening')
  proc.kill()
}, 150_000)

test('a killed listener reads dead in status, even though the credential still works', async () => {
  const fake = serveMattermost()
  cleanup.push(() => fake.stop())
  const config = await writeConfig(fake)

  const { proc, sink } = run(['--config', config, 'watch'])
  await until(() => sink.err.some((l) => l.startsWith('mattermost-agent: ready')), sink)
  const listening = await readStatus(config)
  expect(listening[0]?.watcher.state).toBe('listening')

  // The exact shape of the outage this fix is about: the process is gone while
  // the token is perfectly good, so a live identity call says `live` and only
  // the watcher's own heartbeat can say the agent is deaf.
  proc.kill('SIGKILL')
  await proc.exited
  const dead = await readStatus(config)
  expect(dead[0]?.health).toBe('live')
  expect(dead[0]?.watcher.state).toBe('stale')
}, 90_000)

test('a 401 on the identity call is a refusal: exit 4, named as an auth error', async () => {
  const fake = serveMattermost()
  cleanup.push(() => fake.stop())
  fake.fail({ status: 401, body: '{"id":"api.context.session_expired.app_error"}' })
  const config = await writeConfig(fake)

  const { proc, sink } = run(['--config', config, 'watch'])
  expect(await proc.exited).toBe(4)
  expect(sink.err.some((l) => l.includes('auth-error'))).toBe(true)
  expect(sink.err.some((l) => l.includes('transient-error'))).toBe(false)
  expect(sink.out.join('')).toBe('')
}, 60_000)

test('a 403 on the identity call is a refusal too: exit 4', async () => {
  const fake = serveMattermost()
  cleanup.push(() => fake.stop())
  fake.fail({ status: 403, body: '{"id":"api.context.permissions.app_error"}' })
  const config = await writeConfig(fake)

  const { proc } = run(['--config', config, 'watch'])
  expect(await proc.exited).toBe(4)
}, 60_000)

test('a credential that authenticates as somebody else is exit 4, named as an identity error', async () => {
  const fake = serveMattermost()
  cleanup.push(() => fake.stop())
  const config = await writeConfig(fake, { expectedUserId: 'somebody-else' })

  const { proc, sink } = run(['--config', config, 'watch'])
  expect(await proc.exited).toBe(4)
  expect(sink.err.some((l) => l.includes('identity-error'))).toBe(true)
  expect(sink.out.join('')).toBe('')
}, 60_000)

test('repeated 5xx backs off instead of spinning, and keeps retrying without a cap', async () => {
  const fake = serveMattermost()
  cleanup.push(() => fake.stop())
  fake.fail({ status: 503, body: 'service unavailable' })
  const config = await writeConfig(fake)

  // Real time, deliberately: the pacing under test is a child process's own
  // retry backoff, which no in-process clock can advance. The assertion is on
  // the observed pacing, not on a guessed duration.
  const startedAt = Date.now()
  const { proc, sink } = run(['--config', config, 'watch'])
  await until(() => sink.err.some((l) => l.includes('attempt 4')), sink, 60_000)
  const elapsed = Date.now() - startedAt

  // 1s doubling means the fourth attempt cannot happen before 1+2+4 seconds.
  // A spinning supervisor would have got there in milliseconds, and would have
  // made far more than one identity call per attempt.
  expect(elapsed).toBeGreaterThan(6_500)
  expect(fake.identityCalls()).toBeLessThanOrEqual(5)
  expect(proc.exitCode).toBeNull()
  expect(sink.err.some((l) => l.includes('shutting down'))).toBe(false)
  proc.kill()
}, 90_000)

test('a 429 is transient: the listener rides out the throttle and delivers afterwards', async () => {
  const fake = serveMattermost()
  cleanup.push(() => fake.stop())
  fake.fail({ status: 429, body: 'slow down' })
  const config = await writeConfig(fake)

  const { proc, sink } = run(['--config', config, 'watch'])
  await until(() => sink.err.some((l) => l.includes('transient-error') && l.includes('429')), sink)
  expect(proc.exitCode).toBeNull()

  fake.fail(null)
  fake.post('sent after the throttle lifted')
  await until(() => sink.out.some((l) => l.includes('sent after the throttle lifted')), sink, 90_000)
  proc.kill()
}, 150_000)

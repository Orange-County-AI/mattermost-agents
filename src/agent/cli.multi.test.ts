/**
 * Multi-instance behaviour, observed the way an adapter observes it: by running
 * the real CLI as a child process and reading its stdout/stderr.
 *
 * The claim under test is not "state scopes differ" — it is that a configured
 * server which is DOWN cannot stop a healthy server's mail, and that the dead
 * one rejoins without restarting the watcher.
 *
 * Real time is unavoidable here (a child process, sockets, the watcher's poll
 * timer); every wait is on observed output, never on a guessed duration.
 */
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Subprocess } from 'bun'
import type { MMListPost } from '../mattermost'

const SELF = 'bot-1'
const PEER = 'peer-1'
const LIVE_CHANNEL = 'chan-live'
const DEAD_CHANNEL = 'chan-dead'
const CLI = join(import.meta.dir, 'cli.ts')

interface Fixture {
  server: ReturnType<typeof Bun.serve>
  post(message: string, channelId?: string): MMListPost
}

function serveMattermost(port: number, channelId: string): Fixture {
  const posts: MMListPost[] = []
  let clock = Date.now() - 30_000
  let counter = 0
  const server = Bun.serve({
    port,
    fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === '/api/v4/websocket') return srv.upgrade(req) ? undefined : new Response('no', { status: 400 })
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
    server,
    post(message, channel = channelId) {
      clock += 1000
      counter += 1
      const post: MMListPost = {
        id: `${channel}-${counter}`,
        channel_id: channel,
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

/** Bind briefly to learn a port nothing is listening on, so the "dead" origin is genuinely refused. */
function reservePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = probe.port
  probe.stop(true)
  if (port === undefined) throw new Error('could not reserve a port')
  return port
}

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

async function readUntil(
  proc: Subprocess<'ignore', 'pipe', 'pipe'>,
  sink: { out: string[]; err: string[] },
  check: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(100)
  }
  throw new Error(`timed out.\nstdout:\n${sink.out.join('\n')}\nstderr:\n${sink.err.join('\n')}`)
}

test('a dead connection degrades on its own; the live one keeps delivering and the dead one recovers in place', async () => {
  const livePort = reservePort()
  const deadPort = reservePort()
  const live = serveMattermost(livePort, LIVE_CHANNEL)
  cleanup.push(() => live.server.stop(true))

  const stateDir = mkdtempSync(join(tmpdir(), 'agent-multi-'))
  const configPath = join(stateDir, 'config.json')
  await Bun.write(
    configPath,
    JSON.stringify({
      version: 1,
      stateDir,
      connections: [
        { id: 'live', url: `http://127.0.0.1:${livePort}`, tokenEnv: 'FAKE_TOKEN', channelIds: [LIVE_CHANNEL], pollIntervalMs: 1000 },
        { id: 'dead', url: `http://127.0.0.1:${deadPort}`, tokenEnv: 'FAKE_TOKEN', channelIds: [DEAD_CHANNEL], pollIntervalMs: 1000 },
      ],
    }),
  )

  live.post('first while the other server is down')

  const proc = Bun.spawn(['bun', CLI, '--config', configPath, 'watch'], {
    env: { ...process.env, FAKE_TOKEN: 'token' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  cleanup.push(() => proc.kill())
  const sink = { out: [] as string[], err: [] as string[] }
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

  // The healthy connection is ready and delivering while the other is refused.
  await readUntil(proc, sink, () => sink.out.some((l) => l.includes('first while the other server is down')))
  expect(sink.err.some((l) => l.includes('connection=dead') && l.includes('DEGRADED'))).toBe(true)
  expect(sink.err.some((l) => l.startsWith('mattermost-agent: ready connections=1'))).toBe(true)

  // A second message on the live connection still arrives with the other down.
  live.post('second while the other server is down')
  await readUntil(proc, sink, () => sink.out.some((l) => l.includes('second while the other server is down')))

  // The dead origin comes up. No restart: the supervisor's retry picks it up.
  const revived = serveMattermost(deadPort, DEAD_CHANNEL)
  cleanup.push(() => revived.server.stop(true))
  revived.post('from the recovered server', DEAD_CHANNEL)
  await readUntil(proc, sink, () => sink.out.some((l) => l.includes('from the recovered server')), 30_000)

  const connections = sink.out.map((l) => (JSON.parse(l) as { connection: string }).connection)
  expect(new Set(connections)).toEqual(new Set(['live', 'dead']))
  proc.kill()
}, 60_000)

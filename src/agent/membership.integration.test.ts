/**
 * Membership mode against a running watcher: the claim is that a channel this
 * account is added to (or removed from) while the process is resident changes
 * what it watches, with no restart and no config edit — and that a static
 * connection does NOT behave that way, however many channels somebody invites
 * it to.
 *
 * Real HTTP, a real WebSocket and the watcher's own poll timer; every wait is
 * on an observed line or an observed scope, never on a guessed duration.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MattermostClient } from '../mattermost'
import type { ConnectionConfig } from './config'
import { AgentState } from './state'
import { startFakeMattermost, type FakeMattermost } from './testing/fake-mattermost'
import { ConnectionWatcher } from './watcher'

const TEAM = 'team-agents'
const SELF = 'user-a'
const TOKEN = 'token-fleet-security'

let fake: FakeMattermost
let stateDir: string
const running: { stop(): void }[] = []
const closing: AgentState[] = []

beforeEach(() => {
  fake = startFakeMattermost()
  stateDir = mkdtempSync(join(tmpdir(), 'agent-membership-'))
  fake.addUser({ id: SELF, username: 'fleet-security' })
  fake.addUser({ id: 'user-b', username: 'incus-migration' })
  fake.addTeam({ id: TEAM, name: 'agents', type: 'I' })
  fake.addTeamMember(TEAM, SELF)
  fake.addTeamMember(TEAM, 'user-b')
  fake.addChannel({ id: 'chan-town', team_id: TEAM, name: 'town-square', type: 'O' })
  fake.addChannelMember('chan-town', SELF)
  fake.addChannelMember('chan-town', 'user-b')
})

afterEach(() => {
  for (const watcher of running.splice(0)) watcher.stop()
  for (const state of closing.splice(0)) state.close()
  fake.stop()
})

function watcherFor(
  conn: Partial<ConnectionConfig>,
  lines: string[],
  logs: string[],
): { watcher: ConnectionWatcher; state: AgentState } {
  const connection: ConnectionConfig = {
    id: 'mm',
    url: fake.url,
    tokenEnv: 'FAKE_TOKEN_A',
    channelIds: [],
    watchMemberships: true,
    allowedBotIds: [],
    operatorUserIds: [],
    automationUserIds: [],
    pollIntervalMs: 1000,
    ...conn,
  }
  const state = AgentState.open({ stateDir, connectionId: connection.id, origin: fake.url, userId: SELF, username: 'fleet-security' })
  closing.push(state)
  const watcher = new ConnectionWatcher(connection, new MattermostClient(fake.url, TOKEN), state, TOKEN, SELF, {
    emit: (line) => lines.push(line),
    log: (line) => logs.push(line),
  })
  running.push(watcher)
  return { watcher, state }
}

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(50)
  }
  throw new Error('timed out waiting for condition')
}

/** The watcher's own JSONL: one message per line. */
function texts(lines: string[]): string[] {
  return lines.map((line) => {
    const parsed: unknown = JSON.parse(line)
    if (parsed && typeof parsed === 'object' && 'text' in parsed && typeof parsed.text === 'string') return parsed.text
    throw new Error(`emitted line has no text: ${line}`)
  })
}

test('a channel joined while the watcher runs is delivered without a restart, and leaving stops it', async () => {
  const lines: string[] = []
  const logs: string[] = []
  const { watcher } = watcherFor({}, lines, logs)
  fake.post({ channel_id: 'chan-town', user_id: 'user-b', message: 'in the channel we started with' })
  await watcher.start()
  await waitFor(() => lines.length === 1)
  expect(logs.some((line) => line.includes('scope=membership'))).toBe(true)

  // Somebody creates a channel and adds this account — the exact thing an
  // allowlist cannot express and a restart should not be needed for.
  fake.addChannel({ id: 'chan-new', team_id: TEAM, name: 'agent-ops', type: 'P' })
  fake.addChannelMember('chan-new', 'user-b')
  fake.addChannelMember('chan-new', SELF)
  fake.post({ channel_id: 'chan-new', user_id: 'user-b', message: 'from the channel we just joined' })

  await waitFor(() => lines.length === 2)
  expect(texts(lines)).toEqual(['in the channel we started with', 'from the channel we just joined'])

  // Removed again: the next post there is not this agent's mail any more.
  fake.removeChannelMember('chan-new', SELF)
  await waitFor(() => logs.some((line) => line.includes('membership connection=mm channels=1')))
  fake.post({ channel_id: 'chan-new', user_id: 'user-b', message: 'after we left' })
  fake.post({ channel_id: 'chan-town', user_id: 'user-b', message: 'still in this one' })

  await waitFor(() => lines.length === 3)
  expect(texts(lines)).not.toContain('after we left')
  expect(texts(lines).at(-1)).toBe('still in this one')
}, 30_000)

test('a static connection keeps its allowlist even after this account is added to another channel', async () => {
  const lines: string[] = []
  const logs: string[] = []
  const { watcher } = watcherFor({ watchMemberships: false, channelIds: ['chan-town'] }, lines, logs)
  await watcher.start()
  expect(logs.some((line) => line.includes('scope=static'))).toBe(true)

  fake.addChannel({ id: 'chan-new', team_id: TEAM, name: 'agent-ops', type: 'O' })
  fake.addChannelMember('chan-new', SELF)
  fake.addChannelMember('chan-new', 'user-b')
  fake.post({ channel_id: 'chan-new', user_id: 'user-b', message: 'not this agent business' })
  fake.post({ channel_id: 'chan-town', user_id: 'user-b', message: 'allowlisted' })

  // The proof is the traffic, not a sleep: wait until the allowlisted channel
  // has been swept twice with both posts already on the server, then assert
  // the other channel was never even asked about.
  await waitFor(() => fake.requests.filter((entry) => entry === 'GET /channels/chan-town/posts').length >= 2)
  expect(fake.requests.filter((entry) => entry.includes('chan-new'))).toEqual([])
  expect(texts(lines)).toEqual(['allowlisted'])
}, 30_000)

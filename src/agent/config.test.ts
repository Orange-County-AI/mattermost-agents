/**
 * The profile contract: what a config MUST say before this process is allowed
 * to listen as somebody.
 */
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigError, loadConfig, senderRole, soleConnectionId, type ConnectionConfig } from './config'

const dirs: string[] = []

afterEach(() => dirs.splice(0))

async function writeConfig(connection: Record<string, unknown>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-config-'))
  dirs.push(dir)
  const path = join(dir, 'config.json')
  await Bun.write(
    path,
    JSON.stringify({
      version: 1,
      stateDir: dir,
      connections: [{ id: 'ocai', url: 'https://example.invalid', tokenEnv: 'TOKEN', ...connection }],
    }),
  )
  return path
}

test('an empty channel list is refused in static mode and allowed in membership mode', async () => {
  const staticPath = await writeConfig({ channelIds: [] })
  await expect(loadConfig(staticPath)).rejects.toThrow(ConfigError)

  const membershipPath = await writeConfig({ channelIds: [], watchMemberships: true })
  const loaded = await loadConfig(membershipPath)
  const [conn] = loaded.config.connections
  expect(conn).toMatchObject({ watchMemberships: true, channelIds: [] })
})

test('static scope is the default, and expectedUserId is carried through as given', async () => {
  // Mattermost-shaped (26 lowercase alphanumerics) but synthetic: the pin is
  // about carrying an opaque id through untouched, not about any real account.
  const pinned = 'aaaaaaaaaaaaaaaaaaaaaaaaaa'
  const path = await writeConfig({ channelIds: ['chan-1'], expectedUserId: pinned })
  const { config } = await loadConfig(path)
  const [conn] = config.connections
  expect(conn?.watchMemberships).toBe(false)
  expect(conn?.expectedUserId).toBe(pinned)
  expect(soleConnectionId(config)).toBe('ocai')
})

test('a second connection makes an unnamed one ambiguous rather than guessed', async () => {
  const path = await writeConfig({ channelIds: ['chan-1'] })
  const { config } = await loadConfig(path)
  const [first] = config.connections
  if (!first) throw new Error('no connection')
  const two = { ...config, connections: [first, { ...first, id: 'other' }] }
  expect(() => soleConnectionId(two)).toThrow(ConfigError)
  expect(soleConnectionId(two, 'other')).toBe('other')
})

test('a sender is whatever the operator lists them as, and unlisted means unknown', async () => {
  const owner = 'a375eksumifijx66784pbyws9w'
  const robot = 'mns4as5d8iba7bqkasq95aogqw'
  const path = await writeConfig({
    channelIds: ['chan-1'],
    operatorUserIds: [owner],
    automationUserIds: [robot],
  })
  const { config } = await loadConfig(path)
  const [conn] = config.connections
  if (!conn) throw new Error('no connection')
  expect(senderRole(conn, owner)).toBe('operator')
  expect(senderRole(conn, robot)).toBe('automation')
  expect(senderRole(conn, 'zzz5eksumifijx66784pbyws9w')).toBe('unknown')
})

test('the principals default to nobody, so an unconfigured connection trusts no sender', async () => {
  const path = await writeConfig({ channelIds: ['chan-1'] })
  const { config } = await loadConfig(path)
  const [conn] = config.connections
  if (!conn) throw new Error('no connection')
  expect(conn.operatorUserIds).toEqual([])
  expect(conn.automationUserIds).toEqual([])
  expect(senderRole(conn, 'a375eksumifijx66784pbyws9w')).toBe('unknown')
})

test('a principals list that cannot mean one thing is refused, not resolved by precedence', async () => {
  const owner = 'a375eksumifijx66784pbyws9w'

  // Both roles at once: the config does not say which, so neither is assumed.
  const ambiguous = await writeConfig({
    channelIds: ['chan-1'],
    operatorUserIds: [owner],
    automationUserIds: [owner],
  })
  await expect(loadConfig(ambiguous)).rejects.toThrow(/both operatorUserIds and automationUserIds/)

  const duplicated = await writeConfig({ channelIds: ['chan-1'], operatorUserIds: [owner, owner] })
  await expect(loadConfig(duplicated)).rejects.toThrow(/twice in operatorUserIds/)

  const blank = await writeConfig({ channelIds: ['chan-1'], automationUserIds: [''] })
  await expect(loadConfig(blank)).rejects.toThrow(ConfigError)

  const notAList = await writeConfig({ channelIds: ['chan-1'], operatorUserIds: owner })
  await expect(loadConfig(notAList)).rejects.toThrow(ConfigError)

  // An agent listed as its own operator would be claiming authority it does
  // not have; its own posts are never delivered anyway.
  const itself = await writeConfig({
    channelIds: ['chan-1'],
    expectedUserId: owner,
    operatorUserIds: [owner],
  })
  await expect(loadConfig(itself)).rejects.toThrow(/its own account/)
})

test('roles are per connection, because the same human is a different id on each server', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-config-'))
  dirs.push(dir)
  const path = join(dir, 'config.json')
  const base = { url: 'https://example.invalid', tokenEnv: 'TOKEN', channelIds: ['chan-1'] }
  await Bun.write(
    path,
    JSON.stringify({
      version: 1,
      stateDir: dir,
      connections: [
        { ...base, id: 'ocai', operatorUserIds: ['a375eksumifijx66784pbyws9w'] },
        { ...base, id: 'ticket500', operatorUserIds: ['au6gdc4fnpntugpfmwui6s1qcw'] },
      ],
    }),
  )
  const { config } = await loadConfig(path)
  const [ocai, ticket500] = config.connections as [ConnectionConfig, ConnectionConfig]
  expect(senderRole(ocai, 'a375eksumifijx66784pbyws9w')).toBe('operator')
  expect(senderRole(ticket500, 'a375eksumifijx66784pbyws9w')).toBe('unknown')
  expect(senderRole(ticket500, 'au6gdc4fnpntugpfmwui6s1qcw')).toBe('operator')
})

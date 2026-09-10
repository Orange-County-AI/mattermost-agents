/**
 * The profile contract: what a config MUST say before this process is allowed
 * to listen as somebody.
 */
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigError, loadConfig, soleConnectionId } from './config'

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

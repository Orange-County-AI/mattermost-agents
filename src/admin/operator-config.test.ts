/**
 * Operator config validation.
 *
 * This file is what points an account-creating tool at a live installation,
 * so a wrong or sloppy value here is the expensive kind of mistake: the
 * refusals below are the contract. All ids are synthetic.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOperatorConfig, OperatorConfigError, parseOperatorConfig } from './operator-config'

const workdir = await mkdtemp(join(tmpdir(), 'mm-agents-config-'))
afterAll(() => rm(workdir, { recursive: true, force: true }))

const valid = {
  version: 1,
  url: 'https://mattermost.example.com',
  tokenSecret: 'MATTERMOST_ADMIN_TOKEN',
  teamId: 'tttttttttttttttttttttttttt',
  observerUserIds: ['oooooooooooooooooooooooooo'],
}

async function writeConfig(body: unknown, mode = 0o600): Promise<string> {
  const path = join(workdir, `operator-${Math.random().toString(36).slice(2)}.json`)
  await writeFile(path, typeof body === 'string' ? body : JSON.stringify(body), { mode })
  await chmod(path, mode)
  return path
}

describe('parseOperatorConfig', () => {
  test('accepts a complete config and trims the url', () => {
    const config = parseOperatorConfig({ ...valid, url: 'https://mattermost.example.com/' }, 'test')
    expect(config.url).toBe('https://mattermost.example.com')
    expect(config.tokenSecret).toBe('MATTERMOST_ADMIN_TOKEN')
    expect(config.observerUserIds).toEqual(['oooooooooooooooooooooooooo'])
  })

  test('a token VALUE where a secret NAME belongs is refused', () => {
    expect(() => parseOperatorConfig({ ...valid, tokenSecret: 'aaaaaaaaaaaaaaaaaaaaaaaaaa' }, 'test')).toThrow(/secret NAME/)
  })

  test('a missing or non-http url is refused', () => {
    expect(() => parseOperatorConfig({ ...valid, url: undefined }, 'test')).toThrow(/url/)
    expect(() => parseOperatorConfig({ ...valid, url: 'mattermost.example.com' }, 'test')).toThrow(/url/)
  })

  test('team and observers are optional but must be well formed when present', () => {
    expect(parseOperatorConfig({ version: 1, url: valid.url, tokenSecret: valid.tokenSecret }, 'test').teamId).toBeUndefined()
    expect(() => parseOperatorConfig({ ...valid, observerUserIds: 'not-an-array' }, 'test')).toThrow(/observerUserIds/)
  })
})

describe('loadOperatorConfig', () => {
  test('a missing file is an operator error naming the path, never a default', async () => {
    const path = join(workdir, 'does-not-exist.json')
    await expect(loadOperatorConfig(path)).rejects.toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })

  test('a world-readable config is refused', async () => {
    const path = await writeConfig(valid, 0o644)
    await expect(loadOperatorConfig(path)).rejects.toThrow(/chmod 600/)
  })

  test('invalid JSON is reported as such', async () => {
    const path = await writeConfig('{not json', 0o600)
    await expect(loadOperatorConfig(path)).rejects.toThrow(/invalid JSON/)
  })

  test('a 0600 config loads', async () => {
    const config = await loadOperatorConfig(await writeConfig(valid))
    expect(config.teamId).toBe('tttttttttttttttttttttttttt')
  })

  test('OperatorConfigError is what callers can catch', async () => {
    const error = await loadOperatorConfig(join(workdir, 'nope.json')).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OperatorConfigError)
  })
})

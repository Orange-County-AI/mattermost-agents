/**
 * Store reads against a FAKE `secret` binary.
 *
 * The bug these exist for: mapping every nonzero exit to "absent" turns an
 * outage into a licence to mint or overwrite a credential. Absence must be
 * established positively, and a cache-served value must never pass as proof
 * of what the store holds.
 *
 * Each case writes a tiny shell stand-in and points SECRET_BIN at it, so
 * nothing here touches 1Password, the broker, or any real secret.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSecretFromStore } from './secrets'

const workdir = await mkdtemp(join(tmpdir(), 'mm-agents-secrets-'))
afterAll(() => rm(workdir, { recursive: true, force: true }))

/** Install a fake `secret` and make it the one the module calls. */
async function fakeSecret(script: string): Promise<void> {
  const path = join(workdir, `secret-${Math.random().toString(36).slice(2)}`)
  await writeFile(path, `#!/bin/sh\n${script}\n`, { mode: 0o700 })
  await chmod(path, 0o700)
  process.env.SECRET_BIN = path
}

const NAME = 'MATTERMOST_AGENT_TEST_TOKEN'

describe('readSecretFromStore', () => {
  test('a value the store serves is present', async () => {
    await fakeSecret(`[ "$1" = "${NAME}" ] && echo "value-from-store" && exit 0; exit 1`)
    const read = await readSecretFromStore(NAME)
    expect(read.status).toBe('present')
    expect(read.status === 'present' && read.value).toBe('value-from-store')
  })

  test('missing: the read fails AND an authoritative list excludes the name', async () => {
    await fakeSecret(`case "$1" in list) echo OTHER_NAME; exit 0;; *) echo "not found" >&2; exit 1;; esac`)
    expect((await readSecretFromStore(NAME)).status).toBe('absent')
  })

  test('unavailable: the read fails and the list cannot answer either', async () => {
    await fakeSecret(`echo "1Password unreachable" >&2; exit 1`)
    const read = await readSecretFromStore(NAME)
    expect(read.status).toBe('unknown')
    expect(read.status === 'unknown' && read.reason).toContain('absence is NOT established')
  })

  test('unavailable: the name IS listed but the read failed — never absence', async () => {
    await fakeSecret(`case "$1" in list) echo ${NAME}; exit 0;; *) echo "broker HTTP 503" >&2; exit 1;; esac`)
    const read = await readSecretFromStore(NAME)
    expect(read.status).toBe('unknown')
    expect(read.status === 'unknown' && read.reason).toContain('503')
  })

  test('a cache-served value is stale, not proof of the store', async () => {
    await fakeSecret(`echo "cached-value"; echo "secret: served ${NAME} from the local cache (1Password unreachable)" >&2; exit 0`)
    const read = await readSecretFromStore(NAME)
    expect(read.status).toBe('stale')
  })

  test('diagnostics carry no credential-shaped text', async () => {
    await fakeSecret(`echo "leaked aaaaaaaaaaaaaaaaaaaaaaaaaa oops" >&2; exit 1`)
    const read = await readSecretFromStore(NAME)
    expect(read.status).toBe('unknown')
    expect(read.status === 'unknown' && read.reason).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaaaa')
  })

  test('the environment cannot answer for the store', async () => {
    // A name exported in this process must not be mistaken for a stored one.
    process.env[NAME] = 'value-from-environment'
    await fakeSecret(`case "$1" in list) exit 0;; *) exit 1;; esac`)
    expect((await readSecretFromStore(NAME)).status).toBe('absent')
    delete process.env[NAME]
  })
})

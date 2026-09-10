/**
 * Adoption, end to end, through the real operator CLI.
 *
 * The fleet this tool is being pointed at already has accounts it did not
 * create, so the interesting behaviour is not "can it provision" — it is what
 * happens at the boundary between "the username is taken" and "that account
 * IS this agent". Only an operator can assert the second one, so the assertion
 * has a flag, `--adopt <user-id>`, and everything that could make it false is
 * checked before anything is bound.
 *
 * Everything here runs against the fake Mattermost and a fake `secret` binary
 * inside a temp directory: no live server, no real store, and — deliberately —
 * no contact with ~/.config/mattermost-agents, because a real operator may be
 * provisioning the real fleet at the same time.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFakeMattermost, type FakeMattermost, type FakeUser } from '../agent/testing/fake-mattermost'
import { assertCredentialFree, type ProvisioningRecord } from './record'

const repoRoot = new URL('../..', import.meta.url).pathname

let workdir: string
let configDir: string
let storeDir: string
let secretBin: string
let operatorConfig: string
let server: FakeMattermost
/** The account nobody here created: the whole point of the feature. */
let preExisting: FakeUser
/** A pre-existing BOT that already administers the server. */
let privilegedBot: FakeUser

const OPERATOR_SECRET = 'MATTERMOST_TEST_OPERATOR_TOKEN'
const AGENT_SECRET = 'MATTERMOST_TEST_AGENT_CLEM_TOKEN'
const PRIVILEGED_SECRET = 'MATTERMOST_TEST_AGENT_ADMINBOT_TOKEN'
const TEAM_ID = 'team-fixture'

interface Run {
  code: number
  stdout: string
  stderr: string
}

async function cli(...args: string[]): Promise<Run> {
  const proc = Bun.spawn(['bun', 'src/admin/cli.ts', ...args], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      MATTERMOST_AGENTS_CONFIG_DIR: configDir,
      MATTERMOST_AGENTS_OPERATOR_CONFIG: operatorConfig,
      SECRET_BIN: secretBin,
      // The operator credential resolves from the environment; the AGENT
      // secret must come from the fake store, which is what is under test.
      [OPERATOR_SECRET]: 'token-agent-operator',
    },
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

const recordFile = (name: string): string => join(configDir, 'provisioning', `${name}.json`)

async function readRecordFile(name: string): Promise<ProvisioningRecord | null> {
  try {
    return JSON.parse(await readFile(recordFile(name), 'utf8')) as ProvisioningRecord
  } catch {
    return null
  }
}

/** What the fake store holds, by name. */
async function storedNames(): Promise<string[]> {
  return (await readdir(storeDir)).sort()
}

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'mm-agents-adopt-'))
  configDir = join(workdir, 'config')
  storeDir = join(workdir, 'store')
  await mkdir(configDir, { recursive: true, mode: 0o700 })
  await mkdir(storeDir, { recursive: true, mode: 0o700 })

  secretBin = join(workdir, 'secret')
  await writeFile(
    secretBin,
    [
      '#!/bin/sh',
      `STORE="${storeDir}"`,
      'case "$1" in',
      '  list) ls -1 "$STORE" 2>/dev/null; exit 0 ;;',
      '  set) shift; cat > "$STORE/$1"; exit 0 ;;',
      '  get) shift ;;',
      'esac',
      'if [ -f "$STORE/$1" ]; then cat "$STORE/$1"; exit 0; fi',
      'echo "secret: $1 not found" >&2',
      'exit 1',
    ].join('\n'),
    { mode: 0o700 },
  )
  await chmod(secretBin, 0o700)

  server = startFakeMattermost()
  server.addUser({ id: 'user-operator', username: 'agent-operator', roles: 'system_user system_admin' })
  // Provisioned by a human, long before this tool existed.
  preExisting = server.addUser({ id: 'user-clem-existing', username: 'clem', email: 'clem@people.invalid' })
  // The other real shape: a BOT that already administers the installation
  // and cannot be demoted by a migration.
  privilegedBot = server.addUser({
    id: 'user-admin-bot',
    username: 'adminbot',
    is_bot: true,
    roles: 'system_user system_admin',
    email: 'adminbot@people.invalid',
  })
  server.addTeam({ id: TEAM_ID, name: 'agents', type: 'O' })
  // The operator may add members and may mint tokens for bot accounts.
  server.botTokenMinters.add('user-operator')
  server.addTeamMember(TEAM_ID, 'user-operator')
  server.teamInviters.add('user-operator')

  operatorConfig = join(configDir, 'operator.json')
  await writeFile(
    operatorConfig,
    JSON.stringify({ version: 1, url: server.url, tokenSecret: OPERATOR_SECRET, teamId: TEAM_ID }),
    { mode: 0o600 },
  )
  await chmod(operatorConfig, 0o600)
})

afterAll(async () => {
  server.stop()
  await rm(workdir, { recursive: true, force: true })
})

const clemFlags = [
  '--username',
  'clem',
  '--email',
  'clem-agent@agents.invalid',
  '--label',
  'Clem (AI agent)',
  '--secret',
  AGENT_SECRET,
  '--connection-id',
  'fixture',
]

const botFlags = [
  '--username',
  'adminbot',
  '--email',
  'adminbot-agent@agents.invalid',
  '--label',
  'Admin Bot (AI agent)',
  '--secret',
  PRIVILEGED_SECRET,
  '--connection-id',
  'fixture',
]

describe('provision --adopt', () => {
  test('without --adopt, a pre-existing account is refused and the id is handed back', async () => {
    const run = await cli('provision', 'clem', ...clemFlags)
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('refusing to adopt an unrelated account')
    expect(run.stderr).toContain(`--adopt ${preExisting.id}`)
    // A refusal costs nothing: no record, no credential, no membership.
    expect(await readRecordFile('clem')).toBeNull()
    expect(await storedNames()).toEqual([])
    expect(server.accessTokens).toHaveLength(0)
  })

  test('an id whose username is not this agent\u2019s is refused and writes nothing', async () => {
    const run = await cli('provision', 'clem', ...clemFlags, '--adopt', 'user-operator')
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('@agent-operator')
    expect(await readRecordFile('clem')).toBeNull()
    expect(await storedNames()).toEqual([])
    expect(server.accessTokens).toHaveLength(0)
  })

  test('--adopt binds the named account and records it as adopted', async () => {
    const before = server.users.length
    const run = await cli('provision', 'clem', ...clemFlags, '--adopt', preExisting.id)
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('adopted pre-existing account clem')

    // Nothing was created: adoption is a binding, not a provisioning.
    expect(server.users).toHaveLength(before)

    const record = await readRecordFile('clem')
    expect(record?.adopted).toBe(true)
    expect(record?.userId).toBe(preExisting.id)
    expect(record?.username).toBe('clem')
    expect(record?.steps.secretWritten).toBe(true)
    expect(record?.steps.profileWritten).toBe(true)

    // The account's own email is untouched by adoption.
    expect(server.users.find((u) => u.id === preExisting.id)?.email).toBe('clem@people.invalid')

    // The normal downstream steps still ran: token minted into the named
    // secret, team joined, profile bound to the id.
    expect(await storedNames()).toEqual([AGENT_SECRET])
    expect(server.accessTokens).toHaveLength(1)
    expect(server.accessTokens[0]?.user_id).toBe(preExisting.id)
    expect(await readFile(join(storeDir, AGENT_SECRET), 'utf8')).toBe(String(server.accessTokens[0]?.token))
    const profile = JSON.parse(await readFile(join(configDir, 'profiles', 'clem.json'), 'utf8')) as {
      connections: { id: string; expectedUserId: string; tokenSecret: string }[]
    }
    expect(profile.connections[0]?.expectedUserId).toBe(preExisting.id)
    expect(profile.connections[0]?.tokenSecret).toBe(AGENT_SECRET)
  })

  test('the adopted record is credential-free', async () => {
    const record = await readRecordFile('clem')
    expect(record).not.toBeNull()
    expect(() => assertCredentialFree(record as ProvisioningRecord)).not.toThrow()
    const raw = await readFile(recordFile('clem'), 'utf8')
    expect(raw).not.toContain(String(server.accessTokens[0]?.token))
  })

  test('adopting an id that already belongs to another record is refused', async () => {
    // Same username, a different local name: the only way to reach the
    // "already somebody's identity" guard rather than the username check.
    const run = await cli(
      'provision',
      'clem-copy',
      ...clemFlags,
      '--connection-id',
      'fixture',
      '--adopt',
      preExisting.id,
    )
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('already the provisioning record of "clem"')
    expect(await readRecordFile('clem-copy')).toBeNull()
    expect(server.accessTokens).toHaveLength(1)
  })

  test('a later run needs no flags at all and mints nothing new', async () => {
    const run = await cli('provision', 'clem')
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('reused existing account clem')
    expect(run.stdout).toContain('reused stored token')
    expect(server.accessTokens).toHaveLength(1)
    const record = await readRecordFile('clem')
    // Adoption is remembered: the record, not the flag, is the authority now.
    expect(record?.adopted).toBe(true)
    expect(record?.userId).toBe(preExisting.id)
    expect(record?.incomplete).toBeUndefined()
  })

  test('verify accepts the adopted identity as this tool\u2019s own', async () => {
    const run = await cli('verify', 'clem')
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('clem: OK')
  })

  test('--dry-run reports the adoption and changes nothing', async () => {
    const before = await readFile(recordFile('clem'), 'utf8')
    const run = await cli('provision', 'clem', '--adopt', preExisting.id, '--dry-run')
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('would adopt account clem')
    expect(server.accessTokens).toHaveLength(1)
    expect(await readFile(recordFile('clem'), 'utf8')).toBe(before)
  })

  test('--adopt without an id refuses instead of provisioning past it', async () => {
    const run = await cli('provision', 'ghost', ...clemFlags, '--adopt')
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('--adopt needs the user id')
  })
})

/**
 * Some fleets have an agent that IS the administrator — a bot with
 * `system_admin` that already runs the installation. Demoting it to migrate
 * it would break the thing being migrated, so the refusal gets an explicit
 * escape hatch instead of an exception buried in the code.
 */
describe('provision --adopt --allow-privileged', () => {
  test('a system_admin account is still refused without the flag', async () => {
    const run = await cli('provision', 'adminbot', ...botFlags, '--adopt', privilegedBot.id)
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('account holds system_admin')
    expect(run.stderr).toContain('--allow-privileged')
    expect(await readRecordFile('adminbot')).toBeNull()
    expect(await storedNames()).not.toContain(PRIVILEGED_SECRET)
  })

  test('the flag on its own, with no --adopt, is refused', async () => {
    const run = await cli('provision', 'adminbot', ...botFlags, '--allow-privileged')
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('refusing --allow-privileged on its own')
    expect(await readRecordFile('adminbot')).toBeNull()
  })

  test('with the flag the admin bot is adopted, roles untouched, consent recorded', async () => {
    const rolesBefore = privilegedBot.roles
    const run = await cli('provision', 'adminbot', ...botFlags, '--adopt', privilegedBot.id, '--allow-privileged')
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('PRIVILEGED IDENTITY')
    expect(run.stdout).toContain('keeps roles "system_user system_admin"')
    expect(run.stdout).toContain('left roles untouched on privileged account')

    // The one thing that must not happen to a live administrator: a role edit.
    expect(server.users.find((u) => u.id === privilegedBot.id)?.roles).toBe(rolesBefore)
    expect(server.requests.filter((r) => r === `PUT /users/${privilegedBot.id}/roles`)).toEqual([])

    const record = await readRecordFile('adminbot')
    expect(record?.adopted).toBe(true)
    expect(record?.allowPrivileged).toBe(true)
    expect(record?.adoptedRoles).toBe('system_user system_admin')
    expect(record?.accountType).toBe('bot')
    expect(record?.steps.secretWritten).toBe(true)

    // A bot identity still gets a real, working credential of its own.
    const minted = server.accessTokens.filter((t) => t.user_id === privilegedBot.id)
    expect(minted).toHaveLength(1)
    expect(await readFile(join(storeDir, PRIVILEGED_SECRET), 'utf8')).toBe(String(minted[0]?.token))
  })

  test('a flagless re-run keeps working from the record', async () => {
    const run = await cli('provision', 'adminbot')
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('PRIVILEGED IDENTITY')
    expect(run.stdout).toContain('reused stored token')
    const record = await readRecordFile('adminbot')
    expect(record?.allowPrivileged).toBe(true)
    expect(record?.adoptedRoles).toBe('system_user system_admin')
    expect(record?.incomplete).toBeUndefined()
    expect(server.accessTokens.filter((t) => t.user_id === privilegedBot.id)).toHaveLength(1)
    expect(server.users.find((u) => u.id === privilegedBot.id)?.roles).toBe('system_user system_admin')
  })

  test('verify reports the privilege instead of failing the identity', async () => {
    const run = await cli('verify', 'adminbot')
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('adminbot: OK')
    expect(run.stdout).toContain('PRIVILEGED: account holds system_admin')
  })

  test('list marks the record privileged with the accepted roles', async () => {
    const run = await cli('list')
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('adminbot: adminbot (user-admin-bot) type=bot adopted PRIVILEGED roles="system_user system_admin"')
  })

  test('a bot whose token cannot be minted fails loudly and stores nothing', async () => {
    const stubborn = server.addUser({
      id: 'user-other-bot',
      username: 'otherbot',
      is_bot: true,
      roles: 'system_user system_admin',
    })
    // This installation will not let the operator mint for bots.
    server.botTokenMinters.delete('user-operator')
    try {
      const run = await cli(
        'provision',
        'otherbot',
        '--username',
        'otherbot',
        '--email',
        'otherbot-agent@agents.invalid',
        '--label',
        'Other Bot (AI agent)',
        '--secret',
        'MATTERMOST_TEST_AGENT_OTHERBOT_TOKEN',
        '--connection-id',
        'fixture',
        '--adopt',
        stubborn.id,
        '--allow-privileged',
      )
      expect(run.code).toBe(2)
      expect(run.stderr).toContain('cannot mint an access token for otherbot')
      expect(run.stderr).toContain('BOT account')
      expect(run.stderr).toContain('Roles were left untouched by design')
      // Loud, and empty-handed: no credential, and the record says why.
      expect(await storedNames()).not.toContain('MATTERMOST_TEST_AGENT_OTHERBOT_TOKEN')
      expect(server.accessTokens.filter((t) => t.user_id === stubborn.id)).toEqual([])
      expect((await readRecordFile('otherbot'))?.incomplete).toContain('token mint failed')
    } finally {
      server.botTokenMinters.add('user-operator')
    }
  })
})

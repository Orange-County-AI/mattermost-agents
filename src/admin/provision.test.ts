/**
 * The refusal paths are the point of this module: provisioning that adopts a
 * stranger's account, or overwrites a credential it cannot identify, is worse
 * than provisioning that fails. Those decisions are pure, so they are tested
 * here without a server.
 */
import { describe, expect, test } from 'bun:test'
import { assertNoTokenValues, buildProfile, planProfileWrite, type AgentProfile, type ProfileConnection } from './profile'
import { decideAccountAction, decideSecretAction, defineAgent } from './provision'
import { assertCredentialFree, type ProvisioningRecord } from './record'

const record = (over: Partial<ProvisioningRecord> = {}): ProvisioningRecord => ({
  version: 1,
  name: 'fleet-security',
  serverUrl: 'https://mattermost.example',
  connectionId: 'ocai',
  userId: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
  username: 'fleet-security',
  email: 'fleet-security@agents.example',
  displayLabel: 'Fleet Security (AI agent)',
  accountType: 'user',
  roles: 'system_user',
  teamId: 'tttttttttttttttttttttttttt',
  teamName: 'agents',
  secretName: 'MATTERMOST_AGENT_FLEET_SECURITY_TOKEN',
  tokenId: null,
  tokenDigest: null,
  profilePath: '/tmp/fleet-security.json',
  provisionedBy: { userId: 'oooooooooooooooooooooooooo', username: 'clem' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  steps: {
    accountCreated: true,
    teamJoined: true,
    tokenRoleGranted: true,
    tokenIssued: true,
    secretWritten: true,
    profileWritten: true,
  },
  ...over,
})

describe('decideAccountAction', () => {
  test('never adopts an existing account nobody provisioned', () => {
    const decision = decideAccountAction({
      existing: { id: 'zzzzzzzzzzzzzzzzzzzzzzzzzz', username: 'fleet-security' },
      record: null,
      allowRecreate: false,
    })
    expect(decision.action).toBe('refuse')
    expect(decision.reason).toContain('no provisioning record')
  })

  test('refuses when the username now points at a different user id', () => {
    const decision = decideAccountAction({
      existing: { id: 'zzzzzzzzzzzzzzzzzzzzzzzzzz', username: 'fleet-security' },
      record: record(),
      allowRecreate: false,
    })
    expect(decision.action).toBe('refuse')
  })

  test('reuses the account the record owns', () => {
    const decision = decideAccountAction({
      existing: { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', username: 'fleet-security' },
      record: record(),
      allowRecreate: false,
    })
    expect(decision.action).toBe('reuse')
  })

  test('a vanished account needs an explicit --recreate', () => {
    expect(decideAccountAction({ existing: null, record: record(), allowRecreate: false }).action).toBe('refuse')
    expect(decideAccountAction({ existing: null, record: record(), allowRecreate: true }).action).toBe('create')
  })

  test('creates when nothing exists', () => {
    expect(decideAccountAction({ existing: null, record: null, allowRecreate: false }).action).toBe('create')
  })
})

describe('decideSecretAction', () => {
  const expectedUserId = 'aaaaaaaaaaaaaaaaaaaaaaaaaa'

  test('mints only when the store positively has nothing', () => {
    expect(decideSecretAction({ storeStatus: 'absent', storedIdentity: null, expectedUserId, rotate: false }).action).toBe('mint')
  })

  test('an unreadable store mints nothing and overwrites nothing', () => {
    const decision = decideSecretAction({
      storeStatus: 'unknown',
      storedIdentity: null,
      expectedUserId,
      rotate: false,
      reason: 'broker returned 503',
    })
    expect(decision.action).toBe('refuse')
    expect(decision.reason).toContain('503')
  })

  test('--rotate does not override an unreadable store', () => {
    expect(decideSecretAction({ storeStatus: 'unknown', storedIdentity: null, expectedUserId, rotate: true }).action).toBe('refuse')
  })

  test('a cached value is not proof of the store, so it decides nothing', () => {
    expect(decideSecretAction({ storeStatus: 'stale', storedIdentity: expectedUserId, expectedUserId, rotate: false }).action).toBe('refuse')
  })

  test('reuses a stored token that already is this identity', () => {
    expect(decideSecretAction({ storeStatus: 'present', storedIdentity: expectedUserId, expectedUserId, rotate: false }).action).toBe('reuse')
  })

  test("refuses to overwrite another identity's credential", () => {
    const decision = decideSecretAction({
      storeStatus: 'present',
      storedIdentity: 'bbbbbbbbbbbbbbbbbbbbbbbbbb',
      expectedUserId,
      rotate: false,
    })
    expect(decision.action).toBe('refuse')
  })

  test('an unidentifiable stored token is refused, not clobbered', () => {
    expect(decideSecretAction({ storeStatus: 'present', storedIdentity: null, expectedUserId, rotate: false }).action).toBe('refuse')
  })

  test('--rotate is the deliberate override for a token that IS there', () => {
    expect(decideSecretAction({ storeStatus: 'present', storedIdentity: null, expectedUserId, rotate: true }).action).toBe('mint')
  })
})

describe('profile', () => {
  test('membership mode: no channel allowlist, identity pinned, token by name', () => {
    const profile = buildProfile({
      name: 'fleet-security',
      connectionId: 'ocai',
      url: 'https://mattermost.example',
      secretName: 'MATTERMOST_AGENT_FLEET_SECURITY_TOKEN',
      expectedUserId: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
    })
    const conn = profile.connections[0]!
    expect(conn.watchMemberships).toBe(true)
    expect(conn.channelIds).toEqual([])
    expect(conn.expectedUserId).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(conn.tokenEnv).toBe('MATTERMOST_AGENT_FLEET_SECURITY_TOKEN')
    expect(conn.tokenSecret).toBe('MATTERMOST_AGENT_FLEET_SECURITY_TOKEN')
  })

  test('a token value in place of a secret name is rejected', () => {
    const profile = buildProfile({
      name: 'x',
      connectionId: 'ocai',
      url: 'https://mattermost.example',
      secretName: 'MATTERMOST_AGENT_X_TOKEN',
      expectedUserId: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
    })
    profile.connections[0]!.tokenEnv = 'aaaaaaaaaaaaaaaaaaaaaaaaaa'
    expect(() => assertNoTokenValues(profile)).toThrow(/token value/)
  })
})

describe('record', () => {
  test('identifiers and digests are fine', () => {
    expect(() => assertCredentialFree(record({ tokenId: 'test-token-id', tokenDigest: 'sha256:000000000000' }))).not.toThrow()
  })

  test('a field that could hold a credential stops the write', () => {
    const bad = { ...record(), accessToken: 'aaaaaaaaaaaaaaaaaaaaaaaaaa' } as unknown as ProvisioningRecord
    expect(() => assertCredentialFree(bad)).toThrow(/credential/)
  })
})

describe('defineAgent', () => {
  const complete = {
    name: 'release-warden',
    username: 'release-warden',
    email: 'release-warden@agents.example.com',
    displayLabel: 'Release Warden (AI agent)',
    secretName: 'MATTERMOST_AGENT_RELEASE_WARDEN_TOKEN',
    connectionId: 'example',
  }

  test('registers any identity from supplied values', () => {
    const def = defineAgent(complete)
    expect(def.username).toBe('release-warden')
    expect(def.connectionId).toBe('example')
    expect(def.position).toContain('automated account')
  })

  test('nothing is guessed: a bare name is refused', () => {
    expect(() => defineAgent({ name: 'release-warden' })).toThrow(/connection id/)
  })

  test('a missing email is refused', () => {
    expect(() => defineAgent({ ...complete, email: undefined })).toThrow(/email/)
  })

  test('a token value pasted where a secret NAME belongs is refused', () => {
    expect(() => defineAgent({ ...complete, secretName: 'aaaaaaaaaaaaaaaaaaaaaaaaaa' })).toThrow(/secret NAME/)
  })

  test('an unusable Mattermost username is refused before the server sees it', () => {
    expect(() => defineAgent({ ...complete, username: 'No Spaces Allowed' })).toThrow(/username/)
  })
})

describe('planProfileWrite', () => {
  const intended: ProfileConnection = {
    id: 'ocai',
    url: 'https://mattermost.example',
    tokenEnv: 'MATTERMOST_AGENT_FLEET_SECURITY_TOKEN',
    tokenSecret: 'MATTERMOST_AGENT_FLEET_SECURITY_TOKEN',
    expectedUserId: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
    channelIds: [],
    watchMemberships: true,
    allowedBotIds: [],
    pollIntervalMs: 5000,
  }
  /** What an operator's profile looks like after they extend it by hand. */
  const extended = (over: Partial<ProfileConnection> = {}): AgentProfile => ({
    version: 1,
    stateDir: '/srv/agents/fleet-security',
    connections: [
      {
        id: 'second-instance',
        url: 'https://mattermost.other.example',
        tokenEnv: 'MATTERMOST_OTHER_TOKEN',
        tokenSecret: 'MATTERMOST_OTHER_TOKEN',
        expectedUserId: 'cccccccccccccccccccccccccc',
        channelIds: ['dddddddddddddddddddddddddd'],
        watchMemberships: false,
        allowedBotIds: [],
        pollIntervalMs: 5000,
      },
      { ...intended, channelIds: ['eeeeeeeeeeeeeeeeeeeeeeeeee'], watchMemberships: false, pollIntervalMs: 30_000, ...over },
    ],
  })

  test('a matching binding is kept, whatever else the operator added', () => {
    // Second instance, strict channel scope, custom stateDir and poll interval
    // all differ from what provisioning would generate — and none of them is
    // a reason to rewrite the file.
    expect(planProfileWrite(extended(), intended).action).toBe('keep')
  })

  test('connection order does not decide anything', () => {
    const reordered = extended()
    reordered.connections.reverse()
    expect(planProfileWrite(reordered, intended).action).toBe('keep')
  })

  test('a different identity on the same connection id is refused', () => {
    const plan = planProfileWrite(extended({ expectedUserId: 'bbbbbbbbbbbbbbbbbbbbbbbbbb' }), intended)
    expect(plan.action).toBe('refuse')
    expect(plan.reason).toContain('expectedUserId')
  })

  test('a different secret reference on the same connection id is refused', () => {
    expect(planProfileWrite(extended({ tokenSecret: 'MATTERMOST_SOMEONE_ELSE_TOKEN' }), intended).action).toBe('refuse')
  })

  test('an existing profile without the intended connection is refused, never clobbered', () => {
    const other: AgentProfile = { version: 1, stateDir: '/srv/x', connections: [extended().connections[0]!] }
    const plan = planProfileWrite(other, intended)
    expect(plan.action).toBe('refuse')
    expect(plan.reason).toContain('--replace-profile')
  })

  test('no profile means create, and --replace-profile is the explicit override', () => {
    expect(planProfileWrite(null, intended).action).toBe('create')
    expect(planProfileWrite(extended({ expectedUserId: 'bbbbbbbbbbbbbbbbbbbbbbbbbb' }), intended, { replace: true }).action).toBe('replace')
  })
})

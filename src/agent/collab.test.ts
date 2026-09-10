/**
 * The collaboration surface, against a fake Mattermost that enforces real
 * memberships and real refusals. Two identities share one server, which is the
 * only way to test that a DM has two sides and that scope is per credential.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackendError, IdentityError, createPost, openSession, readChannel, type Session } from './backend'
import {
  addChannelMember,
  createChannel,
  createTeam,
  dm,
  joinChannel,
  joinTeam,
  listChannels,
  listTeams,
  searchUsers,
  whoami,
} from './collab'
import type { AgentConfig } from './config'
import { startFakeMattermost, type FakeMattermost } from './testing/fake-mattermost'

const TEAM = 'team-agents'
const OPEN_TEAM = 'team-open'

let fake: FakeMattermost
let stateDir: string
const opened: Session[] = []

beforeEach(() => {
  fake = startFakeMattermost()
  stateDir = mkdtempSync(join(tmpdir(), 'agent-collab-'))
  fake.addUser({ id: 'user-a', username: 'fleet-security' })
  fake.addUser({ id: 'user-b', username: 'incus-migration' })
  fake.addUser({ id: 'user-h', username: 'stephan' })
  fake.addTeam({ id: TEAM, name: 'agents', type: 'I' })
  fake.addTeam({ id: OPEN_TEAM, name: 'open-house', type: 'O' })
  for (const user of ['user-a', 'user-b', 'user-h']) fake.addTeamMember(TEAM, user)
  fake.addChannel({ id: 'chan-town', team_id: TEAM, name: 'town-square', type: 'O' })
  for (const user of ['user-a', 'user-b', 'user-h']) fake.addChannelMember('chan-town', user)
  process.env.FAKE_TOKEN_A = 'token-fleet-security'
  process.env.FAKE_TOKEN_B = 'token-incus-migration'
})

afterEach(() => {
  for (const session of opened.splice(0)) session.state.close()
  fake.stop()
})

interface OpenArgs {
  user: 'a' | 'b'
  watchMemberships?: boolean
  channelIds?: string[]
  expectedUserId?: string
}

function configFor(args: OpenArgs): AgentConfig {
  return {
    version: 1,
    stateDir,
    connections: [
      {
        id: `mm-${args.user}`,
        url: fake.url,
        tokenEnv: args.user === 'a' ? 'FAKE_TOKEN_A' : 'FAKE_TOKEN_B',
        channelIds: args.channelIds ?? [],
        watchMemberships: args.watchMemberships ?? true,
        allowedBotIds: [],
        pollIntervalMs: 1000,
        ...(args.expectedUserId ? { expectedUserId: args.expectedUserId } : {}),
      },
    ],
  }
}

async function session(args: OpenArgs): Promise<Session> {
  const config = configFor(args)
  const first = config.connections[0]
  if (!first) throw new Error('no connection')
  const open = await openSession(config, first.id)
  opened.push(open)
  return open
}

describe('identity', () => {
  test('a credential that authenticates as another user is refused, and the pinned one is accepted', async () => {
    await expect(session({ user: 'a', expectedUserId: 'user-b' })).rejects.toThrow(IdentityError)

    const pinned = await session({ user: 'a', expectedUserId: 'user-a' })
    expect(pinned.selfUserId).toBe('user-a')
    const identity = await whoami(pinned)
    expect(identity.user).toMatchObject({ id: 'user-a', username: 'fleet-security', is_bot: false })
    expect(identity.identity_pinned).toBe(true)
    expect(identity.scope.mode).toBe('membership')
    expect(identity.memberships.map((channel) => channel.id)).toContain('chan-town')
    expect(identity.teams.map((team) => team.id)).toEqual([TEAM])
  })
})

describe('static scope', () => {
  test('a channel this account is a member of is still refused unless the config lists it', async () => {
    fake.addChannel({ id: 'chan-side', team_id: TEAM, name: 'side-quest', type: 'O' })
    fake.addChannelMember('chan-side', 'user-a')
    const open = await session({ user: 'a', watchMemberships: false, channelIds: ['chan-town'] })

    // Membership is not the question in static mode: the allowlist is.
    await expect(readChannel(open, 'chan-side')).rejects.toThrow(BackendError)
    await expect(
      createPost(open, { channel_id: 'chan-side', message: 'hello', request_id: 'req-side' }),
    ).rejects.toThrow(BackendError)
    expect(open.scope.channels()).toEqual(['chan-town'])
    expect(fake.posts).toHaveLength(0)
  })

  test('every directory, resource and DM operation is refused, and the server is never asked', async () => {
    const open = await session({ user: 'a', watchMemberships: false, channelIds: ['chan-town'] })
    const before = fake.requests.length

    for (const attempt of [
      () => searchUsers(open, { term: 'incus' }),
      () => listTeams(open),
      () => listChannels(open, { team_id: TEAM }),
      () => createTeam(open, { name: 'agent-lab', display_name: 'Agent Lab' }),
      () => joinTeam(open, { team_id: TEAM }),
      () => createChannel(open, { team_id: TEAM, name: 'agent-ops', display_name: 'Agent Ops' }),
      () => joinChannel(open, { channel_id: 'chan-town' }),
      () => addChannelMember(open, { channel_id: 'chan-town', user_id: 'user-b' }),
      () => dm(open, { username: 'incus-migration', message: 'hi', request_id: 'static-1' }),
    ]) {
      await expect(attempt()).rejects.toThrow(BackendError)
    }

    // Refused before any request: no enumeration, no create, no post, nothing
    // for the broad underlying credential to do.
    expect(fake.requests.length).toBe(before)
    expect(fake.createdCount()).toBe(0)
    expect(fake.posts).toHaveLength(0)
    expect(fake.channels.map((channel) => channel.name)).toEqual(['town-square'])
  })

  test('whoami still answers, with in-scope metadata only', async () => {
    fake.addChannel({ id: 'chan-side', team_id: TEAM, name: 'side-quest', type: 'O' })
    fake.addChannelMember('chan-side', 'user-a')
    const open = await session({ user: 'a', watchMemberships: false, channelIds: ['chan-town'] })

    const identity = await whoami(open)
    expect(identity.user).toMatchObject({ id: 'user-a', username: 'fleet-security' })
    expect(identity.scope).toEqual({ mode: 'static', watching: ['chan-town'] })
    expect(identity.teams).toEqual([])
    expect(identity.memberships.map((channel) => channel.id)).toEqual(['chan-town'])
    expect(identity.note).toMatch(/static allowlist mode/)
    // The account IS in chan-side; whoami does not say so, because this
    // connection is not scoped to it.
    expect(fake.requests.some((entry) => entry.includes('/users/me/channels'))).toBe(false)
  })
})

describe('membership scope', () => {
  test('a channel this account left is refused on the next operation, without reopening the session', async () => {
    const open = await session({ user: 'a' })
    fake.post({ channel_id: 'chan-town', user_id: 'user-h', message: 'morning' })
    expect(await readChannel(open, 'chan-town')).toHaveLength(1)

    fake.removeChannelMember('chan-town', 'user-a')
    await expect(readChannel(open, 'chan-town')).rejects.toThrow(BackendError)
  })
})

describe('teams', () => {
  test('joining an open team works; an invite-only one is refused and changes no membership', async () => {
    const open = await session({ user: 'a' })
    await expect(joinTeam(open, { team_name: 'open-house' })).resolves.toMatchObject({
      status: 'joined',
      team_id: OPEN_TEAM,
      user_id: 'user-a',
    })

    fake.addTeam({ id: 'team-locked', name: 'locked', type: 'I' })
    await expect(joinTeam(open, { team_id: 'team-locked' })).rejects.toThrow(BackendError)

    const after = await listTeams(open)
    expect(after.teams.map((team) => team.id).sort()).toEqual([OPEN_TEAM, TEAM].sort())
  })

  test('creating a team twice reports the existing one instead of creating a second', async () => {
    const open = await session({ user: 'a' })
    const first = await createTeam(open, { name: 'agent-lab', display_name: 'Agent Lab' })
    expect(first).toMatchObject({ status: 'created', member: true })
    expect(first.team?.invite_only).toBe(true)
    const createdOnce = fake.createdCount()

    const again = await createTeam(open, { name: 'agent-lab', display_name: 'Agent Lab' })
    expect(again).toMatchObject({ status: 'exists', member: true })
    expect(again.team?.id).toBe(first.team?.id)
    expect(fake.createdCount()).toBe(createdOnce)
  })
})

describe('channels', () => {
  test('a channel is created public inside the team by default, and repeating the call does not create a second', async () => {
    const open = await session({ user: 'a' })
    const created = await createChannel(open, { team_id: TEAM, name: 'agent-ops', display_name: 'Agent Ops' })
    expect(created.status).toBe('created')
    expect(created.channel?.type).toBe('O')
    expect(created.members).toEqual(['user-a'])
    const channelId = created.channel?.id
    if (!channelId) throw new Error('create reported no channel')
    const createdOnce = fake.createdCount()

    const again = await createChannel(open, { team_id: TEAM, name: 'agent-ops', display_name: 'Agent Ops' })
    expect(again).toMatchObject({ status: 'exists' })
    expect(again.channel?.id).toBe(channelId)
    expect(fake.createdCount()).toBe(createdOnce)

    const listed = await listChannels(open, { team_id: TEAM })
    expect(listed.joined.map((channel) => channel.id)).toContain(channelId)
    expect(listed.joinable.map((channel) => channel.id)).not.toContain(channelId)
  })

  test('a channel found after an ambiguous create is reported as recovered, not as ours', async () => {
    const open = await session({ user: 'a' })
    fake.failCreateWith = 502
    const ambiguous = await createChannel(open, { team_id: TEAM, name: 'agent-ops', display_name: 'Agent Ops' })
    fake.failCreateWith = null

    // The name resolves now, but nothing here can tell our write from a
    // concurrent creator's, so the status says recovered rather than created.
    expect(ambiguous.status).toBe('recovered')
    expect(ambiguous.channel?.name).toBe('agent-ops')
    expect(ambiguous.channel?.team_id).toBe(TEAM)
    expect(fake.createdCount()).toBe(1)
    expect(fake.channels.filter((channel) => channel.name === 'agent-ops')).toHaveLength(1)
  })

  test('a denied name lookup stops the create instead of POSTing to find out', async () => {
    fake.addChannel({ id: 'chan-secret', team_id: TEAM, name: 'secret', type: 'P' })
    fake.addChannelMember('chan-secret', 'user-h')
    const open = await session({ user: 'a' })
    const before = fake.requests.length

    await expect(createChannel(open, { team_id: TEAM, name: 'secret', display_name: 'Secret' })).rejects.toThrow(
      BackendError,
    )

    expect(fake.createdCount()).toBe(0)
    expect(fake.requests.slice(before).some((entry) => entry === 'POST /channels')).toBe(false)
    expect(fake.channels.filter((channel) => channel.name === 'secret')).toHaveLength(1)
  })

  test('an existing resource whose privacy differs from the request is refused, not handed back', async () => {
    const open = await session({ user: 'a' })
    await createChannel(open, { team_id: TEAM, name: 'agent-ops', display_name: 'Agent Ops' })
    const createdOnce = fake.createdCount()

    const asPrivate = createChannel(open, {
      team_id: TEAM,
      name: 'agent-ops',
      display_name: 'Agent Ops',
      private: true,
    })
    await expect(asPrivate).rejects.toThrow(BackendError)
    // Same rule for a team: `agents` exists and is invite only.
    await expect(createTeam(open, { name: 'agents', display_name: 'Agents', public: true })).rejects.toThrow(
      BackendError,
    )

    // Nothing created, and the existing channel is untouched — still public.
    expect(fake.createdCount()).toBe(createdOnce)
    expect(fake.channels.filter((channel) => channel.name === 'agent-ops').map((channel) => channel.type)).toEqual(['O'])
  })

  test('a private channel cannot be self-joined, by id or by name', async () => {
    fake.addChannel({ id: 'chan-secret', team_id: TEAM, name: 'secret', type: 'P' })
    fake.addChannelMember('chan-secret', 'user-h')
    const open = await session({ user: 'a' })

    await expect(joinChannel(open, { team_id: TEAM, channel_name: 'secret' })).rejects.toThrow(BackendError)
    await expect(joinChannel(open, { channel_id: 'chan-secret' })).rejects.toThrow(BackendError)
    expect(fake.membersOf('chan-secret')).toEqual(['user-h'])
  })

  test('a member can add a peer into a private channel, and a repeat call is reported as already a member', async () => {
    const open = await session({ user: 'a' })
    const created = await createChannel(open, {
      team_id: TEAM,
      name: 'agent-private',
      display_name: 'Agent Private',
      private: true,
    })
    const channelId = created.channel?.id
    if (!channelId) throw new Error('create reported no channel')
    expect(created.channel?.type).toBe('P')

    const added = await addChannelMember(open, { channel_id: channelId, username: 'incus-migration' })
    expect(added).toMatchObject({ status: 'added', user_id: 'user-b' })
    expect(added.members.sort()).toEqual(['user-a', 'user-b'])

    const twice = await addChannelMember(open, { channel_id: channelId, user_id: 'user-b' })
    expect(twice.status).toBe('already_member')

    // The peer can now see it for itself — the invite is real, not local state.
    const peer = await session({ user: 'b' })
    expect((await whoami(peer)).memberships.map((channel) => channel.id)).toContain(channelId)
  })
})

describe('dm', () => {
  test('a DM has both identities on one native channel, and each side can answer on it', async () => {
    const a = await session({ user: 'a' })
    const sent = await dm(a, { username: 'incus-migration', message: 'got a VM question', request_id: 'dm-1' })
    expect(sent.post.status).toBe('sent')
    expect(sent.target).toMatchObject({ id: 'user-b', username: 'incus-migration' })
    expect(sent.members.sort()).toEqual(['user-a', 'user-b'])

    const b = await session({ user: 'b' })
    const seen = await readChannel(b, sent.channel_id)
    expect(seen.map((post) => post.message)).toEqual(['got a VM question'])
    expect(seen[0]?.user_id).toBe('user-a')

    const back = await dm(b, { user_id: 'user-a', message: 'ask away', request_id: 'dm-2' })
    expect(back.channel_id).toBe(sent.channel_id)
    expect((await readChannel(a, sent.channel_id)).map((post) => post.user_id)).toEqual(['user-a', 'user-b'])
  })

  test('sending settles nothing: unanswered inbound mail is still pending afterwards', async () => {
    const a = await session({ user: 'a' })
    const inbound = fake.post({ channel_id: 'chan-town', user_id: 'user-h', message: 'when you get a moment' })
    a.state.commitSweep({
      channelId: 'chan-town',
      checkpoint: inbound.create_at,
      events: [
        {
          event_id: `mm-a:${inbound.id}:${inbound.create_at}`,
          connection: 'mm-a',
          post_id: inbound.id,
          channel_id: 'chan-town',
          root_id: '',
          sender_id: 'user-h',
          text: inbound.message,
          created_at: inbound.create_at,
          updated_at: inbound.create_at,
        },
      ],
    })
    expect(a.state.pending()).toHaveLength(1)

    await dm(a, { username: 'incus-migration', message: 'unrelated', request_id: 'dm-5' })
    await createPost(a, { channel_id: 'chan-town', message: 'thinking out loud', request_id: 'dm-6' })

    const [still] = a.state.pending()
    expect(still?.post_id).toBe(inbound.id)
    expect(still?.acked_at).toBeNull()
  })

  test('the same request_id does not send a second copy, and a different text under it is refused', async () => {
    const a = await session({ user: 'a' })
    const first = await dm(a, { username: 'incus-migration', message: 'ping', request_id: 'dm-3' })
    const again = await dm(a, { username: 'incus-migration', message: 'ping', request_id: 'dm-3' })

    expect(again.post).toMatchObject({ status: 'sent', duplicate: true, post_id: first.post.post_id })
    expect(fake.posts.filter((post) => post.message === 'ping')).toHaveLength(1)

    await expect(dm(a, { username: 'incus-migration', message: 'different', request_id: 'dm-3' })).rejects.toThrow(
      BackendError,
    )
    expect(fake.posts).toHaveLength(1)
  })

  test('an unknown username is a resolution error, never a fuzzy match', async () => {
    const a = await session({ user: 'a' })
    await expect(dm(a, { username: 'incus', message: 'hi', request_id: 'dm-4' })).rejects.toThrow(BackendError)
    // The fragment DOES match by search, which is exactly why sending must not use search.
    expect((await searchUsers(a, { term: 'incus' })).map((user) => user.username)).toEqual(['incus-migration'])
    expect(fake.posts).toHaveLength(0)
  })
})

/**
 * Finding peers and building a place to talk: identity, users, teams, channels,
 * DMs. The CLI and the MCP tools share every function here, so both paths get
 * the same permission handling and the same idempotency.
 *
 * Three rules hold throughout:
 *
 *   1. WHO WE ARE COMES FROM THE CREDENTIAL. No function takes a user id to act
 *      *as*. `joinTeam` / `joinChannel` act as self; `addTeamMember` /
 *      `addChannelMember` add somebody else and succeed only if the server's
 *      role permissions allow it.
 *   2. A REFUSAL IS A RESULT, NOT A FAILURE TO PAPER OVER. A 403 is reported
 *      with what the server actually permits — never retried, never reported as
 *      success. Mattermost has no self-join for a private channel, and an
 *      invite-only team needs somebody with add_user_to_team; both are said out
 *      loud instead of being simulated.
 *   3. A CREATE IS LOOKED UP, NOT REPEATED. Every create resolves the name
 *      first, and after an ambiguous failure resolves it again. `unknown` means
 *      "go look", never "try again": a blind retry is how a shared team ends up
 *      with two channels of the same purpose.
 */
import { httpStatus, type MMChannel, type MMTeam, type MMUser } from '../mattermost'
import { BackendError, createPost, definitelyRejected, type CreatePostResult, type Session } from './backend'
import type { ScopeMode } from './scope'

/**
 * What an operation did.
 *   created   — this call's POST is the one the server acknowledged.
 *   exists    — it was already there before we tried; nothing was created.
 *   recovered — our create failed ambiguously and a resource of that name is
 *               there now. It may be ours, or a concurrent creator's; the two
 *               are indistinguishable from here, so this is never reported as
 *               `created`.
 *   unknown   — ambiguous, and nothing of that name is resolvable. Go look.
 */
export type WriteStatus = 'created' | 'exists' | 'recovered' | 'unknown'

/**
 * Directory, resource-management and DM operations are membership-mode only.
 *
 * A static profile is a CEILING, not a hint. Its credential is usually far
 * broader than its `channelIds` — the Clem canary's token can read the whole
 * server — and the whole point of the allowlist is that the connection cannot
 * act outside it. Enumerating users, listing unrelated channels, creating
 * teams or opening a DM would all step over that line, so they are refused
 * before any request is made rather than filtered afterwards.
 */
function requireMembershipMode(session: Session, what: string): void {
  if (session.scope.mode === 'membership') return
  throw new BackendError(
    `${what} is not available on connection ${session.conn.id}: it runs in static allowlist mode ` +
      `(watchMemberships is off), where this connection may only read and post in its ` +
      `${session.conn.channelIds.length} configured channel(s). This is a deliberate ceiling on a profile whose ` +
      'credential may be much broader. Use a connection with watchMemberships: true for directory, team, channel ' +
      'and DM operations.',
  )
}

export interface WhoamiResult {
  connection: string
  url: string
  user: { id: string; username: string; is_bot: boolean; roles: string }
  /** True when the config pins this connection to this user id (it matched, or we would not be here). */
  identity_pinned: boolean
  scope: { mode: ScopeMode; watching: string[] }
  /** Membership mode only. A static connection reports no team it is not scoped to. */
  teams: { id: string; name: string; display_name: string; type: string }[]
  /**
   * Membership mode: every channel and DM this account is in. Static mode: only
   * the allowlisted channels, resolved where the server permits it.
   */
  memberships: { id: string; type: string; name: string; display_name: string; team_id: string }[]
  note?: string
}

/**
 * The one identity question a static connection may still ask — but it answers
 * with in-scope metadata only: no team list, no enumeration of channels the
 * allowlist does not name.
 */
export async function whoami(session: Session): Promise<WhoamiResult> {
  const me = await session.client.me()
  const identity = {
    connection: session.conn.id,
    url: session.conn.url,
    user: {
      id: me.id,
      username: me.username,
      is_bot: me.is_bot === true,
      roles: typeof me.roles === 'string' ? me.roles : '',
    },
    identity_pinned: Boolean(session.conn.expectedUserId),
    scope: { mode: session.scope.mode, watching: session.scope.channels() },
  }

  if (session.scope.mode !== 'membership') {
    const scoped: WhoamiResult['memberships'] = []
    for (const channelId of session.scope.channels()) {
      const channel = await describeIfVisible(session, channelId)
      if (channel) scoped.push(channel)
    }
    return {
      ...identity,
      teams: [],
      memberships: scoped,
      note:
        'static allowlist mode: only the configured channels are reported. Teams, other channels and other users ' +
        'are outside this connection\'s scope even where the credential could see them.',
    }
  }

  const [teams, channels] = await Promise.all([session.client.getMyTeams(), session.client.getAllMyChannels()])
  return {
    ...identity,
    teams: teams.map((team) => ({
      id: team.id,
      name: team.name ?? '',
      display_name: team.display_name ?? '',
      type: team.type ?? '',
    })),
    memberships: channels
      .filter((channel) => (channel.delete_at ?? 0) === 0)
      .map((channel) => ({
        id: channel.id,
        type: channel.type,
        name: channel.name ?? '',
        display_name: channel.display_name ?? '',
        team_id: channel.team_id ?? '',
      })),
  }
}

/** One allowlisted channel as far as the server will describe it; refusals are simply not reported. */
async function describeIfVisible(
  session: Session,
  channelId: string,
): Promise<WhoamiResult['memberships'][number] | undefined> {
  try {
    const channel = await session.client.getChannel(channelId)
    return {
      id: channel.id,
      type: channel.type,
      name: channel.name ?? '',
      display_name: channel.display_name ?? '',
      team_id: channel.team_id ?? '',
    }
  } catch (err) {
    const status = httpStatus(err)
    if (status === 403 || status === 404) return undefined
    throw err
  }
}

export interface FoundUser {
  id: string
  username: string
  is_bot: boolean
  nickname: string
}

export async function searchUsers(session: Session, args: { term: string; limit?: number }): Promise<FoundUser[]> {
  requireMembershipMode(session, 'searching the user directory')
  const term = args.term.trim()
  if (term.length === 0) throw new BackendError('term is required')
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100)
  const found = await session.client.searchUsers({ term, limit })
  return found.slice(0, limit).map(describeUser)
}

export interface TeamRow {
  id: string
  name: string
  display_name: string
  type: string
  /** "I" is invite only, "O" is open — the difference decides whether join_team can work. */
  invite_only: boolean
}

export async function listTeams(session: Session): Promise<{ teams: TeamRow[] }> {
  requireMembershipMode(session, 'listing teams')
  const teams = await session.client.getMyTeams()
  return { teams: teams.map(describeTeam) }
}

export interface CreateTeamResult {
  status: WriteStatus
  team: TeamRow | null
  /** True when this account is a member of the team the result names. */
  member: boolean
  note?: string
}

/**
 * Create a team, private by default. The name is resolved FIRST, and that
 * lookup's outcome is respected in full. A denied lookup is not an absence and
 * not an existence either — it is simply unknown, and creating into an unknown
 * is how duplicates and surprises happen, so it stops. Reusing an existing team
 * is refused when its privacy does not match what was asked for.
 */
export async function createTeam(
  session: Session,
  args: { name: string; display_name: string; public?: boolean },
): Promise<CreateTeamResult> {
  requireMembershipMode(session, 'creating a team')
  const name = requireSlug(args.name, 'name')
  const display = args.display_name.trim()
  if (display.length === 0) throw new BackendError('display_name is required')
  const wanted = args.public ? 'O' : 'I'

  const before = await findTeam(session, name)
  if (before.refused) {
    throw new BackendError(
      `refusing to create team ${name}: the name lookup was denied (HTTP ${before.refused}), so whether a team of ` +
        'this name exists cannot be established from this account. No creation was attempted. Ask somebody who can ' +
        'see the team list, or choose a name this account can resolve.',
    )
  }
  if (before.team) {
    requireSameKind({ what: `team ${name}`, wanted, actual: before.team.type ?? '', privateCode: 'I' })
    return {
      status: 'exists',
      team: describeTeam(before.team),
      member: await isTeamMember(session, before.team.id),
      note: 'a team with this name already exists; nothing was created',
    }
  }

  try {
    const created = await session.client.createTeam({ name, display_name: display, type: wanted })
    return { status: 'created', team: describeTeam(created), member: true }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    if (definitelyRejected(detail)) throw new BackendError(`Mattermost refused to create team ${name}: ${detail}`)
    // Ambiguous: the create may have landed. Look the name up rather than retry
    // — but finding one does NOT prove it is ours, so say so.
    const after = await findTeam(session, name)
    if (after.team) {
      requireSameKind({ what: `team ${name}`, wanted, actual: after.team.type ?? '', privateCode: 'I', ambiguous: true })
      return {
        status: 'recovered',
        team: describeTeam(after.team),
        member: await isTeamMember(session, after.team.id),
        note:
          `the create call failed ambiguously (${detail}) and a team with this name is there now. It may be from ` +
          'that attempt or from another creator — check its members and creator before treating it as ours. Nothing ' +
          'further was created.',
      }
    }
    return {
      status: 'unknown',
      team: null,
      member: false,
      note:
        `the create call failed ambiguously (${detail}) and team ${name} is not resolvable ` +
        (after.refused ? `(the lookup was denied with HTTP ${after.refused}, so existence is undetermined) ` : '') +
        '— check the server before creating it again',
    }
  }
}

export interface MembershipResult {
  status: 'joined' | 'already_member' | 'added'
  team_id?: string
  channel_id?: string
  user_id: string
  /** Membership roles the server recorded, e.g. "channel_user channel_admin". */
  roles?: string
  note?: string
}

/**
 * Join a team as self. Mattermost's native join IS "add me to the team", which
 * an OPEN team allows and an invite-only team refuses unless this account has
 * add_user_to_team there. The refusal is reported with the remedy, never
 * simulated.
 */
export async function joinTeam(session: Session, args: { team_id?: string; team_name?: string }): Promise<MembershipResult> {
  requireMembershipMode(session, 'joining a team')
  const team = await resolveTeam(session, args)
  if (await isTeamMember(session, team.id)) {
    return { status: 'already_member', team_id: team.id, user_id: session.selfUserId }
  }
  try {
    const member = await session.client.addTeamMember(team.id, session.selfUserId)
    return { status: 'joined', team_id: team.id, user_id: session.selfUserId, roles: member.roles }
  } catch (err) {
    throw permissionError(err, {
      what: `join team ${team.name ?? team.id}`,
      remedy:
        (team.type === 'I' ? 'this team is invite only (type I). ' : '') +
        'Mattermost has no other native self-join: an account that holds add_user_to_team on this team (a team admin, ' +
        'or a system admin) must add this account, or the team must be switched to open invites.',
    })
  }
}

/** Add somebody else to a team. Succeeds exactly when this account's role allows it. */
export async function addTeamMember(
  session: Session,
  args: { team_id?: string; team_name?: string; user_id?: string; username?: string },
): Promise<MembershipResult> {
  requireMembershipMode(session, 'adding a team member')
  const team = await resolveTeam(session, args)
  const user = await resolveUser(session, args)
  if (user.id === session.selfUserId) return joinTeam(session, { team_id: team.id })
  try {
    const member = await session.client.addTeamMember(team.id, user.id)
    return { status: 'added', team_id: team.id, user_id: user.id, roles: member.roles }
  } catch (err) {
    throw permissionError(err, {
      what: `add ${user.username} to team ${team.name ?? team.id}`,
      remedy: 'adding another user to a team needs add_user_to_team on that team; this account does not have it.',
    })
  }
}

export interface ChannelRow {
  id: string
  name: string
  display_name: string
  /** "O" public, "P" private, "D" direct, "G" group direct. */
  type: string
  team_id: string
}

export interface ListChannelsResult {
  team_id: string
  joined: ChannelRow[]
  /** Public channels of this team this account is NOT in yet. Empty when joined_only. */
  joinable: ChannelRow[]
}

/**
 * What this account can see in one team: the channels it is in, plus the public
 * ones it could join. Private channels it is not in are invisible by design and
 * are not guessed at.
 */
export async function listChannels(
  session: Session,
  args: { team_id: string; joined_only?: boolean },
): Promise<ListChannelsResult> {
  requireMembershipMode(session, 'listing channels')
  if (args.team_id.trim().length === 0) throw new BackendError('team_id is required')
  const mine = await session.client.getMyTeamChannels(args.team_id)
  const joined = mine.filter((channel) => (channel.delete_at ?? 0) === 0).map(describeChannel)
  if (args.joined_only) return { team_id: args.team_id, joined, joinable: [] }

  const joinedIds = new Set(joined.map((channel) => channel.id))
  const publicChannels = await session.client.getPublicTeamChannels(args.team_id)
  return {
    team_id: args.team_id,
    joined,
    joinable: publicChannels
      .filter((channel) => (channel.delete_at ?? 0) === 0 && !joinedIds.has(channel.id))
      .map(describeChannel),
  }
}

export interface CreateChannelResult {
  status: WriteStatus
  channel: ChannelRow | null
  /** Actual member ids the server reports for the resulting channel. */
  members: string[]
  note?: string
}

/**
 * Create a channel inside a team. PUBLIC by default, which inside a private
 * team is what makes a channel visible to the humans on that team; pass
 * `private` for an invite-only one.
 *
 * Same two rules as createTeam. A denied name lookup stops the operation:
 * a 403 says only that this account may not ask, so existence is undetermined,
 * and POSTing to find out could either fail on uniqueness or be read as
 * success. And a channel found after an ambiguous failure is reported as
 * `recovered`, never `created`: we cannot tell our own write from a
 * concurrent creator's.
 */
export async function createChannel(
  session: Session,
  args: { team_id: string; name: string; display_name: string; private?: boolean; purpose?: string },
): Promise<CreateChannelResult> {
  requireMembershipMode(session, 'creating a channel')
  if (args.team_id.trim().length === 0) throw new BackendError('team_id is required')
  const name = requireSlug(args.name, 'name')
  const display = args.display_name.trim()
  if (display.length === 0) throw new BackendError('display_name is required')
  const wanted = args.private ? 'P' : 'O'

  const before = await findChannel(session, args.team_id, name)
  if (before.refused) {
    throw new BackendError(
      `refusing to create channel ${name} in team ${args.team_id}: the name lookup was denied ` +
        `(HTTP ${before.refused}), so whether a channel of this name exists cannot be established from this ` +
        'account. No creation was attempted. Ask a member of that team, or choose a name this account can resolve.',
    )
  }
  if (before.channel) {
    requireSameKind({ what: `channel ${name}`, wanted, actual: before.channel.type, privateCode: 'P' })
    return {
      status: 'exists',
      channel: describeChannel(before.channel),
      members: await memberIds(session, before.channel.id),
      note: 'a channel with this name already exists in this team; nothing was created',
    }
  }

  try {
    const created = await session.client.createChannel({
      team_id: args.team_id,
      name,
      display_name: display,
      type: wanted,
      purpose: args.purpose,
    })
    return { status: 'created', channel: describeChannel(created), members: await memberIds(session, created.id) }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    if (definitelyRejected(detail)) throw new BackendError(`Mattermost refused to create channel ${name}: ${detail}`)
    const after = await findChannel(session, args.team_id, name)
    if (after.channel) {
      requireSameKind({ what: `channel ${name}`, wanted, actual: after.channel.type, privateCode: 'P', ambiguous: true })
      return {
        status: 'recovered',
        channel: describeChannel(after.channel),
        members: await memberIds(session, after.channel.id),
        note:
          `the create call failed ambiguously (${detail}) and a channel with this name is there now. It may be from ` +
          'that attempt or from another creator — check its members before treating it as ours. Nothing further was ' +
          'created.',
      }
    }
    return {
      status: 'unknown',
      channel: null,
      members: [],
      note:
        `the create call failed ambiguously (${detail}) and channel ${name} is not resolvable in team ${args.team_id} ` +
        (after.refused ? `(the lookup was denied with HTTP ${after.refused}, so existence is undetermined) ` : '') +
        '— look before creating it again',
    }
  }
}

/**
 * Join a channel as self. Public channels allow it; a private one does not —
 * Mattermost has no self-join for type P, so that is refused with the remedy
 * (a current member adds this account) instead of a pretend success.
 */
export async function joinChannel(
  session: Session,
  args: { channel_id?: string; team_id?: string; channel_name?: string },
): Promise<MembershipResult & { members: string[] }> {
  requireMembershipMode(session, 'joining a channel')
  const channel = await resolveChannel(session, args)
  const existing = await membership(session, channel.id, session.selfUserId)
  if (existing) {
    return {
      status: 'already_member',
      channel_id: channel.id,
      user_id: session.selfUserId,
      roles: existing.roles,
      members: await memberIds(session, channel.id),
    }
  }
  try {
    const member = await session.client.addChannelMember(channel.id, session.selfUserId)
    return {
      status: 'joined',
      channel_id: channel.id,
      user_id: session.selfUserId,
      roles: member.roles,
      members: await memberIds(session, channel.id),
    }
  } catch (err) {
    throw permissionError(err, {
      what: `join channel ${channel.name ?? channel.id}`,
      remedy:
        channel.type === 'P'
          ? 'this channel is private: Mattermost has no self-join for a private channel. A current member with ' +
            'manage_private_channel_members must add this account (add_channel_member).'
          : 'joining a public channel needs join_public_channels on its team, and team membership; this account is ' +
            'missing one of them.',
    })
  }
}

/** Invite somebody else into a channel this account is in. */
export async function addChannelMember(
  session: Session,
  args: { channel_id: string; user_id?: string; username?: string },
): Promise<MembershipResult & { members: string[] }> {
  requireMembershipMode(session, 'adding a channel member')
  if (args.channel_id.trim().length === 0) throw new BackendError('channel_id is required')
  const user = await resolveUser(session, args)
  const existing = await membership(session, args.channel_id, user.id)
  if (existing) {
    return {
      status: 'already_member',
      channel_id: args.channel_id,
      user_id: user.id,
      roles: existing.roles,
      members: await memberIds(session, args.channel_id),
    }
  }
  try {
    const member = await session.client.addChannelMember(args.channel_id, user.id)
    return {
      status: 'added',
      channel_id: args.channel_id,
      user_id: user.id,
      roles: member.roles,
      members: await memberIds(session, args.channel_id),
    }
  } catch (err) {
    throw permissionError(err, {
      what: `add ${user.username} to channel ${args.channel_id}`,
      remedy:
        'this needs manage_private_channel_members (private) or manage_public_channel_members (public) on that ' +
        'channel, and the target must already be a member of the team.',
    })
  }
}

export interface DmResult {
  target: FoundUser
  channel_id: string
  /** Both sides of the direct channel, from the server. */
  members: string[]
  post: CreatePostResult
}

/**
 * DM one user. The direct channel is created natively between this account and
 * the target (Mattermost returns the same channel for the same pair, so this is
 * idempotent), and the message goes through the ordinary send path: same
 * `request_id` idempotency, same ambiguous-outcome reporting, nothing settled.
 *
 * Membership mode only. A static profile's reach is its channel list; opening
 * a brand-new direct channel would step straight outside it.
 */
export async function dm(
  session: Session,
  args: { user_id?: string; username?: string; message: string; request_id: string },
): Promise<DmResult> {
  requireMembershipMode(session, 'sending a direct message')
  if (args.message.trim().length === 0) throw new BackendError('message is empty')
  if (args.request_id.trim().length === 0) throw new BackendError('request_id is required')
  const target = await resolveUser(session, args)
  if (target.id === session.selfUserId) {
    throw new BackendError('refusing to DM this connection\'s own identity; name the peer you mean')
  }
  const channel = await session.client.createDirectChannel(session.selfUserId, target.id)
  const post = await createPost(session, {
    channel_id: channel.id,
    message: args.message,
    request_id: args.request_id,
  })
  return {
    target: describeUser(target),
    channel_id: channel.id,
    members: await memberIds(session, channel.id),
    post,
  }
}

function describeUser(user: MMUser): FoundUser {
  return {
    id: user.id,
    username: user.username,
    is_bot: user.is_bot === true,
    nickname: typeof user.nickname === 'string' ? user.nickname : '',
  }
}

/**
 * Refuse to hand back an existing resource whose privacy is not the privacy
 * that was asked for. Getting a PUBLIC channel back from a request for a
 * private one is the dangerous direction — an agent would post into it
 * believing it was closed — so a mismatch is an error either way, never a
 * silently different result.
 */
function requireSameKind(args: {
  what: string
  wanted: string
  actual: string
  privateCode: string
  ambiguous?: boolean
}): void {
  if (args.wanted === args.actual) return
  const describe = (code: string): string => (code === args.privateCode ? 'private' : 'public')
  throw new BackendError(
    `refusing to reuse ${args.what}: you asked for a ${describe(args.wanted)} one and the existing ${args.what} is ` +
      `${describe(args.actual)} (type "${args.actual}")` +
      (args.ambiguous
        ? '. It appeared after an ambiguous create, so it is probably somebody else\'s, and it is certainly not what ' +
          'was asked for'
        : '') +
      '. Nothing was created or changed — pick another name, or ask for the privacy it actually has.',
  )
}

function describeTeam(team: MMTeam): TeamRow {
  return {
    id: team.id,
    name: team.name ?? '',
    display_name: team.display_name ?? '',
    type: team.type ?? '',
    invite_only: team.type === 'I',
  }
}

function describeChannel(channel: MMChannel): ChannelRow {
  return {
    id: channel.id,
    name: channel.name ?? '',
    display_name: channel.display_name ?? '',
    type: channel.type,
    team_id: channel.team_id ?? '',
  }
}

/** Mattermost slugs are lowercase, dashed, and rejected server-side otherwise. */
function requireSlug(value: string, field: string): string {
  const slug = value.trim()
  if (!/^[a-z0-9]([a-z0-9-_]*[a-z0-9])?$/.test(slug)) {
    throw new BackendError(
      `${field} must be a Mattermost slug: lowercase letters, digits, dash or underscore, starting and ending alphanumeric (got "${value}")`,
    )
  }
  return slug
}

/**
 * A name lookup with three outcomes, not two: found, absent (404), or DENIED
 * (403 — this account may not ask, so nothing at all is known about the name).
 * Collapsing the third into absence is exactly how a duplicate create happens,
 * and collapsing it into existence would be a claim the server never made.
 */
async function findTeam(session: Session, name: string): Promise<{ team?: MMTeam; refused?: number }> {
  try {
    return { team: await session.client.getTeamByName(name) }
  } catch (err) {
    const status = httpStatus(err)
    if (status === 404) return {}
    if (status === 403) return { refused: 403 }
    throw err
  }
}

async function findChannel(session: Session, teamId: string, name: string): Promise<{ channel?: MMChannel; refused?: number }> {
  try {
    return { channel: await session.client.getChannelByName(teamId, name) }
  } catch (err) {
    const status = httpStatus(err)
    if (status === 404) return {}
    if (status === 403) return { refused: 403 }
    throw err
  }
}

async function isTeamMember(session: Session, teamId: string): Promise<boolean> {
  const teams = await session.client.getMyTeams()
  return teams.some((team) => team.id === teamId)
}

async function membership(session: Session, channelId: string, userId: string): Promise<{ roles: string } | undefined> {
  try {
    const member = await session.client.getChannelMember(channelId, userId)
    return { roles: member.roles }
  } catch (err) {
    const status = httpStatus(err)
    if (status === 403 || status === 404) return undefined
    throw err
  }
}

/**
 * The channel's real member ids, or an empty list when the server will not say.
 * Reporting who is actually in a channel is the point of the collaboration
 * tools; failing the whole operation because the follow-up read was refused is
 * not.
 */
async function memberIds(session: Session, channelId: string): Promise<string[]> {
  try {
    const members = await session.client.getChannelMembers(channelId)
    return members.map((member) => member.user_id)
  } catch {
    return []
  }
}

/**
 * A denied lookup (403) is how Mattermost answers for a team this account may
 * not see — which includes, but is not limited to, an invite-only team it is
 * not in. So the message says what the server said (the lookup was denied) plus
 * what would let this account in if the team does exist, and claims nothing
 * about existence either way.
 */
const TEAM_INVITE_REMEDY =
  'if it exists it is not joinable from here: Mattermost has no self-join for an invite-only team, so an account ' +
  'holding add_user_to_team on it (a team admin, or a system admin) must add this account.'

async function resolveTeam(session: Session, args: { team_id?: string; team_name?: string }): Promise<MMTeam> {
  if (args.team_id) {
    try {
      return await session.client.getTeam(args.team_id)
    } catch (err) {
      if (httpStatus(err) === 403) {
        throw new BackendError(
          `the lookup for team ${args.team_id} was denied (HTTP 403), so this account cannot confirm it exists; ` +
            TEAM_INVITE_REMEDY,
        )
      }
      throw new BackendError(`cannot resolve team ${args.team_id}: ${errorDetail(err)}`)
    }
  }
  if (args.team_name) {
    const found = await findTeam(session, args.team_name)
    if (found.team) return found.team
    throw new BackendError(
      found.refused
        ? `the lookup for team ${args.team_name} was denied (HTTP 403), so this account cannot confirm it exists; ` +
          TEAM_INVITE_REMEDY
        : `no team named ${args.team_name} is visible to this account`,
    )
  }
  throw new BackendError('name the team: team_id or team_name')
}

async function resolveChannel(
  session: Session,
  args: { channel_id?: string; team_id?: string; channel_name?: string },
): Promise<MMChannel> {
  if (args.channel_id) {
    try {
      return await session.client.getChannel(args.channel_id)
    } catch (err) {
      throw new BackendError(`cannot resolve channel ${args.channel_id}: ${errorDetail(err)}`)
    }
  }
  if (args.team_id && args.channel_name) {
    const found = await findChannel(session, args.team_id, args.channel_name)
    if (found.channel) return found.channel
    throw new BackendError(
      found.refused
        ? `the lookup for channel ${args.channel_name} in team ${args.team_id} was denied (HTTP 403), so this ` +
          'account cannot confirm it exists; if it does, it is private and a member must add this account'
        : `no channel named ${args.channel_name} in team ${args.team_id} is visible to this account`,
    )
  }
  throw new BackendError('name the channel: channel_id, or team_id plus channel_name')
}

/** Exact resolution only: a DM or an invite must never land on a fuzzy search hit. */
async function resolveUser(session: Session, args: { user_id?: string; username?: string }): Promise<MMUser> {
  if (args.user_id) {
    try {
      return await session.client.getUser(args.user_id)
    } catch (err) {
      throw new BackendError(`cannot resolve user ${args.user_id}: ${errorDetail(err)}`)
    }
  }
  if (args.username) {
    const username = args.username.replace(/^@/, '')
    try {
      return await session.client.getUserByUsername(username)
    } catch (err) {
      throw new BackendError(
        `cannot resolve username ${username}: ${errorDetail(err)}. Use search_users to find the exact username first.`,
      )
    }
  }
  throw new BackendError('name the user: user_id or username')
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Turn a server refusal into a result the agent can act on. A 403 keeps the
 * server's own words plus what would actually be needed; anything else is
 * passed through unchanged, because inventing an explanation for a 5xx would be
 * worse than reporting it.
 */
function permissionError(err: unknown, args: { what: string; remedy: string }): BackendError {
  const detail = errorDetail(err)
  if (httpStatus(err) === 403) {
    return new BackendError(`Mattermost refused to ${args.what} (HTTP 403). ${args.remedy} Server said: ${detail}`)
  }
  return new BackendError(`could not ${args.what}: ${detail}`)
}

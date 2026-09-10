/**
 * A fake Mattermost with the parts the collaboration path depends on: several
 * identities behind different tokens, teams with types, channels with types,
 * real per-user memberships, native direct channels, and the permission
 * refusals the real server actually gives.
 *
 * It is deliberately strict about the refusals, because that is what the tests
 * are for:
 *   - reading or sweeping a channel you are not in answers 403,
 *   - self-joining a PRIVATE channel answers 403 (Mattermost has no such join),
 *   - joining an invite-only team answers 403 unless the caller was granted the
 *     right to add members,
 *   - a private channel is invisible by name to a non-member (403), which is
 *     not the same as absent (404).
 *
 * Real HTTP and a real WebSocket, so watchers and the CLI can run against it
 * unchanged.
 */
import type { MMListPost } from '../../mattermost'

export interface FakeUser {
  id: string
  username: string
  is_bot: boolean
  token: string
}

export interface FakeTeam {
  id: string
  name: string
  display_name: string
  /** "I" invite only, "O" open. */
  type: string
}

export interface FakeChannel {
  id: string
  team_id: string
  name: string
  display_name: string
  /** "O" public, "P" private, "D" direct. */
  type: string
  delete_at: number
}

export interface FakeMattermost {
  url: string
  stop(): void
  users: FakeUser[]
  teams: FakeTeam[]
  channels: FakeChannel[]
  posts: MMListPost[]
  /** Fixture setup. */
  addUser(args: { id: string; username: string; is_bot?: boolean }): FakeUser
  addTeam(args: { id: string; name: string; display_name?: string; type?: string }): FakeTeam
  addChannel(args: { id: string; team_id: string; name: string; display_name?: string; type?: string }): FakeChannel
  addTeamMember(teamId: string, userId: string): void
  addChannelMember(channelId: string, userId: string): void
  removeChannelMember(channelId: string, userId: string): void
  membersOf(channelId: string): string[]
  post(args: { channel_id: string; user_id: string; message: string; root_id?: string }): MMListPost
  /** Users allowed to add somebody to a team (models add_user_to_team). */
  teamInviters: Set<string>
  /** Next POST /posts fails with this status, then the field is left alone. */
  failPostWith: number | null
  /** Next channel/team create fails with this status. */
  failCreateWith: number | null
  /** How many creates the server actually performed, ambiguous failures included. */
  createdCount(): number
  /**
   * Every request the server answered, as "METHOD /path". Lets a test prove a
   * channel was never even asked about, instead of sleeping and hoping.
   */
  requests: string[]
}

export function startFakeMattermost(): FakeMattermost {
  const users: FakeUser[] = []
  const teams: FakeTeam[] = []
  const channels: FakeChannel[] = []
  const posts: MMListPost[] = []
  const teamMembers = new Set<string>()
  const channelMembers = new Set<string>()
  const teamInviters = new Set<string>()
  const requests: string[] = []
  const state = { failPostWith: null as number | null, failCreateWith: null as number | null, creates: 0 }
  let clock = Date.now() - 60_000
  let counter = 0

  const key = (a: string, b: string): string => `${a}|${b}`
  const forbidden = (why: string): Response => new Response(JSON.stringify({ message: why }), { status: 403 })
  const missing = (why: string): Response => new Response(JSON.stringify({ message: why }), { status: 404 })

  const caller = (req: Request): FakeUser | undefined => {
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '')
    return users.find((user) => user.token === token)
  }

  const create = (args: { channel_id: string; user_id: string; message: string; root_id?: string }): MMListPost => {
    clock += 1000
    counter += 1
    const post: MMListPost = {
      id: `post-${counter}`,
      channel_id: args.channel_id,
      user_id: args.user_id,
      message: args.message,
      root_id: args.root_id ?? '',
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
  }

  const server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      const path = url.pathname.replace(/^\/api\/v4/, '')
      requests.push(`${req.method} ${path}`)

      if (path === '/websocket') {
        if (srv.upgrade(req)) return undefined
        return new Response('expected websocket', { status: 400 })
      }

      const me = caller(req)
      if (!me) return new Response(JSON.stringify({ message: 'invalid token' }), { status: 401 })

      if (path === '/users/me') return Response.json(publicUser(me))

      if (path === '/users/search' && req.method === 'POST') {
        const body = (await req.json()) as { term?: string }
        const term = (body.term ?? '').toLowerCase()
        return Response.json(users.filter((user) => user.username.toLowerCase().includes(term)).map(publicUser))
      }

      const byUsername = /^\/users\/username\/(.+)$/.exec(path)
      if (byUsername) {
        const found = users.find((user) => user.username === byUsername[1])
        return found ? Response.json(publicUser(found)) : missing('user not found')
      }

      if (path === '/users/me/teams') {
        return Response.json(teams.filter((team) => teamMembers.has(key(team.id, me.id))))
      }

      const userById = /^\/users\/([^/]+)$/.exec(path)
      if (userById && req.method === 'GET') {
        const found = users.find((user) => user.id === userById[1])
        return found ? Response.json(publicUser(found)) : missing('user not found')
      }

      const teamByName = /^\/teams\/name\/(.+)$/.exec(path)
      if (teamByName) {
        const found = teams.find((team) => team.name === teamByName[1])
        if (!found) return missing('team not found')
        if (found.type === 'I' && !teamMembers.has(key(found.id, me.id))) return forbidden('team is invite only')
        return Response.json(found)
      }

      if (path === '/teams' && req.method === 'POST') {
        if (state.failCreateWith) {
          // Ambiguous by construction: the server DID create it, then failed to say so.
          const body = (await req.json()) as { name: string; display_name: string; type: string }
          state.creates += 1
          const team: FakeTeam = { id: `team-${teams.length + 1}`, ...body }
          teams.push(team)
          teamMembers.add(key(team.id, me.id))
          return new Response('gateway', { status: state.failCreateWith })
        }
        const body = (await req.json()) as { name: string; display_name: string; type: string }
        if (teams.some((team) => team.name === body.name)) {
          return new Response(JSON.stringify({ message: 'a team with that name already exists' }), { status: 400 })
        }
        state.creates += 1
        const team: FakeTeam = { id: `team-${teams.length + 1}`, ...body }
        teams.push(team)
        teamMembers.add(key(team.id, me.id))
        return Response.json(team, { status: 201 })
      }

      const teamMemberAdd = /^\/teams\/([^/]+)\/members$/.exec(path)
      if (teamMemberAdd && req.method === 'POST') {
        const team = teams.find((t) => t.id === teamMemberAdd[1])
        if (!team) return missing('team not found')
        const body = (await req.json()) as { user_id: string }
        const self = body.user_id === me.id
        const allowed = team.type === 'O' ? self || teamInviters.has(me.id) : teamInviters.has(me.id)
        if (!allowed) {
          return forbidden(self ? 'you do not have permission to join this team' : 'permission to add members denied')
        }
        teamMembers.add(key(team.id, body.user_id))
        return Response.json({ team_id: team.id, user_id: body.user_id, roles: 'team_user' }, { status: 201 })
      }

      const teamById = /^\/teams\/([^/]+)$/.exec(path)
      if (teamById) {
        const found = teams.find((team) => team.id === teamById[1])
        if (!found) return missing('team not found')
        if (found.type === 'I' && !teamMembers.has(key(found.id, me.id))) return forbidden('team is invite only')
        return Response.json(found)
      }

      if (path === '/users/me/channels') {
        return Response.json(channels.filter((channel) => channelMembers.has(key(channel.id, me.id))))
      }

      const myTeamChannels = /^\/users\/me\/teams\/([^/]+)\/channels$/.exec(path)
      if (myTeamChannels) {
        return Response.json(
          channels.filter(
            (channel) => channel.team_id === myTeamChannels[1] && channelMembers.has(key(channel.id, me.id)),
          ),
        )
      }

      const teamChannelByName = /^\/teams\/([^/]+)\/channels\/name\/(.+)$/.exec(path)
      if (teamChannelByName) {
        const found = channels.find(
          (channel) => channel.team_id === teamChannelByName[1] && channel.name === teamChannelByName[2],
        )
        if (!found) return missing('channel not found')
        // A private channel is invisible to a non-member: 403, not 404.
        if (found.type === 'P' && !channelMembers.has(key(found.id, me.id))) return forbidden('channel is private')
        return Response.json(found)
      }

      const publicTeamChannels = /^\/teams\/([^/]+)\/channels$/.exec(path)
      if (publicTeamChannels && req.method === 'GET') {
        return Response.json(channels.filter((channel) => channel.team_id === publicTeamChannels[1] && channel.type === 'O'))
      }

      if (path === '/channels' && req.method === 'POST') {
        const body = (await req.json()) as { team_id: string; name: string; display_name: string; type: string }
        if (state.failCreateWith) {
          state.creates += 1
          const channel: FakeChannel = { id: `chan-${channels.length + 1}`, delete_at: 0, ...body }
          channels.push(channel)
          channelMembers.add(key(channel.id, me.id))
          return new Response('gateway', { status: state.failCreateWith })
        }
        if (channels.some((channel) => channel.team_id === body.team_id && channel.name === body.name)) {
          return new Response(JSON.stringify({ message: 'a channel with that name already exists' }), { status: 400 })
        }
        if (!teamMembers.has(key(body.team_id, me.id))) return forbidden('not a member of that team')
        state.creates += 1
        const channel: FakeChannel = { id: `chan-${channels.length + 1}`, delete_at: 0, ...body }
        channels.push(channel)
        channelMembers.add(key(channel.id, me.id))
        return Response.json(channel, { status: 201 })
      }

      if (path === '/channels/direct' && req.method === 'POST') {
        const pair = (await req.json()) as string[]
        const [a, b] = pair
        if (!a || !b) return new Response('bad pair', { status: 400 })
        const name = [a, b].sort().join('__')
        const existing = channels.find((channel) => channel.type === 'D' && channel.name === name)
        const channel = existing ?? {
          id: `dm-${channels.length + 1}`,
          team_id: '',
          name,
          display_name: '',
          type: 'D',
          delete_at: 0,
        }
        if (!existing) channels.push(channel)
        channelMembers.add(key(channel.id, a))
        channelMembers.add(key(channel.id, b))
        return Response.json(channel, { status: existing ? 200 : 201 })
      }

      const channelMemberOne = /^\/channels\/([^/]+)\/members\/([^/]+)$/.exec(path)
      if (channelMemberOne) {
        const [, channelId, rawUserId] = channelMemberOne
        const userId = rawUserId === 'me' ? me.id : String(rawUserId)
        if (!channels.some((channel) => channel.id === channelId)) return missing('channel not found')
        if (!channelMembers.has(key(String(channelId), me.id)) && userId !== me.id) {
          return forbidden('you are not in that channel')
        }
        if (!channelMembers.has(key(String(channelId), userId))) return missing('membership not found')
        return Response.json({ channel_id: channelId, user_id: userId, roles: 'channel_user' })
      }

      const channelMemberList = /^\/channels\/([^/]+)\/members$/.exec(path)
      if (channelMemberList && req.method === 'GET') {
        const channelId = String(channelMemberList[1])
        if (!channelMembers.has(key(channelId, me.id))) return forbidden('you are not in that channel')
        return Response.json(
          users
            .filter((user) => channelMembers.has(key(channelId, user.id)))
            .map((user) => ({ channel_id: channelId, user_id: user.id, roles: 'channel_user' })),
        )
      }

      if (channelMemberList && req.method === 'POST') {
        const channelId = String(channelMemberList[1])
        const channel = channels.find((c) => c.id === channelId)
        if (!channel) return missing('channel not found')
        const body = (await req.json()) as { user_id: string }
        const self = body.user_id === me.id
        if (self && channel.type === 'P' && !channelMembers.has(key(channelId, me.id))) {
          return forbidden('private channels cannot be joined without an invitation')
        }
        if (self && channel.type === 'O' && !teamMembers.has(key(channel.team_id, me.id))) {
          return forbidden('not a member of that team')
        }
        if (!self && !channelMembers.has(key(channelId, me.id))) {
          return forbidden('you must be in the channel to add somebody to it')
        }
        channelMembers.add(key(channelId, body.user_id))
        return Response.json({ channel_id: channelId, user_id: body.user_id, roles: 'channel_user' }, { status: 201 })
      }

      const channelPosts = /^\/channels\/([^/]+)\/posts$/.exec(path)
      if (channelPosts) {
        const channelId = String(channelPosts[1])
        if (!channelMembers.has(key(channelId, me.id))) return forbidden('you are not in that channel')
        const since = url.searchParams.get('since')
        const selected = posts.filter(
          (post) => post.channel_id === channelId && (since === null || Number(post.update_at) > Number(since)),
        )
        return Response.json({
          order: [...selected].reverse().map((post) => post.id),
          posts: Object.fromEntries(selected.map((post) => [post.id, post])),
        })
      }

      const channelById = /^\/channels\/([^/]+)$/.exec(path)
      if (channelById) {
        const found = channels.find((channel) => channel.id === channelById[1])
        if (!found) return missing('channel not found')
        if (found.type !== 'O' && !channelMembers.has(key(found.id, me.id))) return forbidden('channel is not visible')
        return Response.json(found)
      }

      if (path === '/posts' && req.method === 'POST') {
        const body = (await req.json()) as { channel_id: string; message: string; root_id?: string }
        if (state.failPostWith) return new Response('nope', { status: state.failPostWith })
        if (!channelMembers.has(key(body.channel_id, me.id))) return forbidden('you are not in that channel')
        return Response.json(create({ channel_id: body.channel_id, user_id: me.id, message: body.message, root_id: body.root_id }))
      }

      const threadOf = /^\/posts\/([^/]+)\/thread$/.exec(path)
      if (threadOf) {
        const root = String(threadOf[1])
        const selected = posts.filter((post) => post.id === root || post.root_id === root)
        return Response.json({
          order: selected.map((post) => post.id),
          posts: Object.fromEntries(selected.map((post) => [post.id, post])),
        })
      }

      const postById = /^\/posts\/([^/]+)$/.exec(path)
      if (postById) {
        const found = posts.find((post) => post.id === postById[1])
        return found ? Response.json(found) : missing('post not found')
      }

      return new Response(`unhandled ${req.method} ${path}`, { status: 404 })
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ event: 'hello', data: { connection_id: 'fake' }, seq: 0 }))
      },
      message() {},
    },
  })

  const port = server.port
  if (port === undefined) throw new Error('fake Mattermost did not bind a port')

  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => server.stop(true),
    users,
    teams,
    channels,
    posts,
    teamInviters,
    requests,
    addUser(args) {
      const user: FakeUser = {
        id: args.id,
        username: args.username,
        is_bot: args.is_bot ?? false,
        token: `token-${args.username}`,
      }
      users.push(user)
      return user
    },
    addTeam(args) {
      const team: FakeTeam = {
        id: args.id,
        name: args.name,
        display_name: args.display_name ?? args.name,
        type: args.type ?? 'I',
      }
      teams.push(team)
      return team
    },
    addChannel(args) {
      const channel: FakeChannel = {
        id: args.id,
        team_id: args.team_id,
        name: args.name,
        display_name: args.display_name ?? args.name,
        type: args.type ?? 'O',
        delete_at: 0,
      }
      channels.push(channel)
      return channel
    },
    addTeamMember: (teamId, userId) => void teamMembers.add(key(teamId, userId)),
    addChannelMember: (channelId, userId) => void channelMembers.add(key(channelId, userId)),
    removeChannelMember: (channelId, userId) => void channelMembers.delete(key(channelId, userId)),
    membersOf: (channelId) => users.filter((user) => channelMembers.has(key(channelId, user.id))).map((user) => user.id),
    post: create,
    get failPostWith() {
      return state.failPostWith
    },
    set failPostWith(value: number | null) {
      state.failPostWith = value
    },
    get failCreateWith() {
      return state.failCreateWith
    },
    set failCreateWith(value: number | null) {
      state.failCreateWith = value
    },
    createdCount: () => state.creates,
  }
}

function publicUser(user: FakeUser): Record<string, unknown> {
  return { id: user.id, username: user.username, is_bot: user.is_bot, roles: 'system_user', nickname: '' }
}

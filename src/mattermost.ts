/**
 * Minimal Mattermost REST client. The bridge is the ONLY holder of the bot
 * token, so all authed HTTP to Mattermost goes through here:
 *   - me()         : verify the token at startup (GET /api/v4/users/me)
 *   - createPost() : send a (threaded) reply (POST /api/v4/posts)
 *
 * The WebSocket URL is derived from the same base so ingestion and posting
 * always target one server.
 */
export interface MMUser {
  id: string
  username: string
  [k: string]: unknown
}

export interface MMCreatedPost {
  id: string
  channel_id: string
  root_id: string
  message: string
  create_at: number
  [k: string]: unknown
}

/** A post as returned inside a post list (channel history / thread). */
export interface MMListPost {
  id: string
  create_at: number
  user_id: string
  message: string
  root_id: string
  [k: string]: unknown
}

/** Mattermost "post list" envelope: `order` is newest-first ids into `posts`. */
export interface MMPostList {
  order: string[]
  posts: Record<string, MMListPost>
}

/** A team. `type` is "I" (invite only) or "O" (open). */
export interface MMTeam {
  id: string
  name?: string
  display_name?: string
  type?: string
  [k: string]: unknown
}

/** A channel. type: "D" (dm) | "G" (group dm) | "O" (public) | "P" (private). */
export interface MMChannel {
  id: string
  type: string
  name?: string
  display_name?: string
  team_id?: string
  delete_at?: number
  [k: string]: unknown
}

/** One user's membership of one channel; `roles` carries channel_admin when set. */
export interface MMChannelMember {
  channel_id: string
  user_id: string
  roles: string
  [k: string]: unknown
}

/** One user's membership of one team. */
export interface MMTeamMember {
  team_id: string
  user_id: string
  roles: string
  [k: string]: unknown
}

/** Metadata for an uploaded file (GET /files/{id}/info). */
export interface MMFileInfo {
  id: string
  name: string
  extension: string
  mime_type: string
  size: number
  width?: number
  height?: number
  [k: string]: unknown
}

/** Every request carries a deadline: an unresponsive server must not hang a sweep or a startup forever. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

export class MattermostClient {
  readonly baseUrl: string
  private readonly token: string
  private readonly timeoutMs: number

  constructor(baseUrl: string, token: string, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.token = token
    this.timeoutMs = timeoutMs
  }

  /** ws(s):// URL for the Mattermost WebSocket API, derived from the base URL. */
  websocketUrl(): string {
    return this.baseUrl.replace(/^http/, 'ws') + '/api/v4/websocket'
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api/v4${path}`, {
      ...init,
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`MM ${init?.method ?? 'GET'} ${path}: HTTP ${res.status} ${body.slice(0, 300)}`)
    }
    return (await res.json()) as T
  }

  me(): Promise<MMUser> {
    return this.api<MMUser>('/users/me')
  }

  /**
   * Post a message. Always pass root_id (= post.root_id || post.id) so replies
   * land in the originating thread.
   */
  createPost(args: { channel_id: string; message: string; root_id?: string }): Promise<MMCreatedPost> {
    const body: Record<string, unknown> = { channel_id: args.channel_id, message: args.message }
    if (args.root_id) body.root_id = args.root_id
    return this.api<MMCreatedPost>('/posts', { method: 'POST', body: JSON.stringify(body) })
  }

  /** Recent posts in a channel (newest-first in `order`). Requires bot membership. */
  getChannelPosts(channelId: string, perPage = 30): Promise<MMPostList> {
    return this.api<MMPostList>(`/channels/${channelId}/posts?per_page=${perPage}`)
  }

  /** One post by id. Deleted posts answer 404 — the tombstone only shows up in `since` scans. */
  getPost(postId: string): Promise<MMListPost> {
    return this.api<MMListPost>(`/posts/${postId}`)
  }

  /** All posts in a thread (pass any post id in the thread, e.g. the root). */
  getThread(postId: string): Promise<MMPostList> {
    return this.api<MMPostList>(`/posts/${postId}/thread`)
  }

  /**
   * Posts in a channel modified after `sinceMs` (Unix ms). Used by the
   * reconnect catch-up scan. Note Mattermost filters `since` on update_at, so
   * edits of older posts come back too — callers filter by create_at.
   */
  getChannelPostsSince(channelId: string, sinceMs: number): Promise<MMPostList> {
    return this.api<MMPostList>(`/channels/${channelId}/posts?since=${sinceMs}`)
  }

  /** Teams the bot belongs to. */
  getMyTeams(): Promise<MMTeam[]> {
    return this.api<MMTeam[]>('/users/me/teams')
  }

  /** Channels (incl. DMs/GMs) the bot is a member of, scoped to one team. */
  getMyTeamChannels(teamId: string): Promise<MMChannel[]> {
    return this.api<MMChannel[]>(`/users/me/teams/${teamId}/channels`)
  }

  /** ALL channels the bot is a member of, across teams (Mattermost >= 6.1). */
  getAllMyChannels(): Promise<MMChannel[]> {
    return this.api<MMChannel[]>('/users/me/channels')
  }

  /**
   * One channel by id. `post_edited` / `post_deleted` events carry no
   * channel_type (unlike `posted`), so the edit path resolves it here.
   */
  getChannel(channelId: string): Promise<MMChannel> {
    return this.api<MMChannel>(`/channels/${channelId}`)
  }

  /**
   * One user's channel membership. 403/404 is the honest answer for "not a
   * member" (Mattermost answers 403 when the caller may not even look), so
   * callers that want a boolean use `channelMembership` below.
   */
  getChannelMember(channelId: string, userId: string): Promise<MMChannelMember> {
    return this.api<MMChannelMember>(`/channels/${channelId}/members/${userId}`)
  }

  /** Everyone in a channel (membership rows, not users). */
  getChannelMembers(channelId: string, perPage = 100): Promise<MMChannelMember[]> {
    return this.api<MMChannelMember[]>(`/channels/${channelId}/members?per_page=${perPage}`)
  }

  /** Users matching a term. Non-admin accounts see what their teams let them see. */
  searchUsers(args: { term: string; team_id?: string; limit?: number }): Promise<MMUser[]> {
    const body: Record<string, unknown> = { term: args.term, allow_inactive: false }
    if (args.team_id) body.team_id = args.team_id
    if (args.limit) body.limit = args.limit
    return this.api<MMUser[]>('/users/search', { method: 'POST', body: JSON.stringify(body) })
  }

  getUserByUsername(username: string): Promise<MMUser> {
    return this.api<MMUser>(`/users/username/${username}`)
  }

  getUser(userId: string): Promise<MMUser> {
    return this.api<MMUser>(`/users/${userId}`)
  }

  /** One team by its URL slug. 404 when it does not exist OR is invisible to this account. */
  getTeamByName(name: string): Promise<MMTeam> {
    return this.api<MMTeam>(`/teams/name/${name}`)
  }

  getTeam(teamId: string): Promise<MMTeam> {
    return this.api<MMTeam>(`/teams/${teamId}`)
  }

  /** type "I" = invite only (the default here), "O" = open. */
  createTeam(args: { name: string; display_name: string; type: 'I' | 'O' }): Promise<MMTeam> {
    return this.api<MMTeam>('/teams', { method: 'POST', body: JSON.stringify(args) })
  }

  /**
   * Add a user to a team. Mattermost's native join for an OPEN team is the
   * same call with your own id; an invite-only team refuses it unless the
   * caller has add_user_to_team on that team.
   */
  addTeamMember(teamId: string, userId: string): Promise<MMTeamMember> {
    return this.api<MMTeamMember>(`/teams/${teamId}/members`, {
      method: 'POST',
      body: JSON.stringify({ team_id: teamId, user_id: userId }),
    })
  }

  /** Public channels of a team — the joinable set, membership not required. */
  getPublicTeamChannels(teamId: string, perPage = 200): Promise<MMChannel[]> {
    return this.api<MMChannel[]>(`/teams/${teamId}/channels?per_page=${perPage}`)
  }

  /** One channel by team + slug. 404 when absent, 403 when private and not ours. */
  getChannelByName(teamId: string, channelName: string): Promise<MMChannel> {
    return this.api<MMChannel>(`/teams/${teamId}/channels/name/${channelName}`)
  }

  /** type "O" = public inside the team, "P" = private. */
  createChannel(args: {
    team_id: string
    name: string
    display_name: string
    type: 'O' | 'P'
    purpose?: string
  }): Promise<MMChannel> {
    return this.api<MMChannel>('/channels', { method: 'POST', body: JSON.stringify(args) })
  }

  /** Join (userId = self) or invite (userId = somebody else) — one native call. */
  addChannelMember(channelId: string, userId: string): Promise<MMChannelMember> {
    return this.api<MMChannelMember>(`/channels/${channelId}/members`, {
      method: 'POST',
      body: JSON.stringify({ user_id: userId }),
    })
  }

  /**
   * The direct channel between two users. Native and idempotent: the same pair
   * always answers with the same channel, created on first call.
   */
  createDirectChannel(userIdA: string, userIdB: string): Promise<MMChannel> {
    return this.api<MMChannel>('/channels/direct', { method: 'POST', body: JSON.stringify([userIdA, userIdB]) })
  }

  /** Batch-resolve user_id -> user (for turning post authors into @usernames). */
  usersByIds(ids: string[]): Promise<MMUser[]> {
    return this.api<MMUser[]>('/users/ids', { method: 'POST', body: JSON.stringify(ids) })
  }

  /** Metadata for an uploaded file (name, extension, mime_type, size, …). */
  getFileInfo(fileId: string): Promise<MMFileInfo> {
    return this.api<MMFileInfo>(`/files/${fileId}/info`)
  }

  /** Raw bytes of an uploaded file. */
  async getFileBytes(fileId: string): Promise<ArrayBuffer> {
    const res = await fetch(`${this.baseUrl}/api/v4/files/${fileId}`, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { Authorization: `Bearer ${this.token}` },
    })
    if (!res.ok) {
      throw new Error(`MM GET /files/${fileId}: HTTP ${res.status}`)
    }
    return res.arrayBuffer()
  }
}

/**
 * The HTTP status inside an error thrown by this client, when it carries one.
 * Every failed call formats `… HTTP <status> <body>`, so callers can tell a
 * refusal (403) from an absence (404) from an ambiguous 5xx without parsing
 * message text themselves.
 */
export function httpStatus(err: unknown): number | undefined {
  const match = /HTTP (\d{3})/.exec(err instanceof Error ? err.message : String(err))
  return match ? Number(match[1]) : undefined
}

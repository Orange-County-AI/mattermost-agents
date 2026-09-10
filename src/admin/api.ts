/**
 * Operator-only Mattermost REST client.
 *
 * This is deliberately NOT the agent client in ../mattermost.ts and it is never
 * reachable from the MCP surface: the endpoints here (create user, grant role,
 * mint access token, add team member) are administrative and belong to a
 * human-run process, not to a model-driven one.
 *
 * Two rules the shape of this file exists to enforce:
 *   - a token is passed to the constructor and never leaves the object: it is
 *     not logged, not put in a URL, and not included in any thrown message;
 *   - probes need status codes, not exceptions, so `raw()` reports the HTTP
 *     status and `call()` is the throwing convenience on top of it.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

export interface MMUser {
  id: string
  username: string
  email?: string
  nickname?: string
  first_name?: string
  last_name?: string
  position?: string
  roles: string
  is_bot?: boolean
  delete_at?: number
  auth_service?: string
  [k: string]: unknown
}

export interface MMTeam {
  id: string
  name: string
  display_name: string
  type: string
  [k: string]: unknown
}

export interface MMTeamMember {
  team_id: string
  user_id: string
  roles: string
  [k: string]: unknown
}

export interface MMChannel {
  id: string
  team_id: string
  name: string
  display_name: string
  type: string
  [k: string]: unknown
}

export interface MMUserAccessToken {
  /** Token id — an identifier, safe to record; `token` is the credential. */
  id: string
  user_id: string
  description: string
  is_active?: boolean
  /** Only present on creation. */
  token?: string
}

export interface ApiResult<T> {
  ok: boolean
  status: number
  data: T | null
  /** Truncated response body, for diagnostics on failure. */
  body: string
}

export class ApiError extends Error {
  readonly status: number
  readonly method: string
  readonly path: string
  constructor(method: string, path: string, status: number, body: string) {
    super(`MM ${method} ${path}: HTTP ${status} ${body.slice(0, 300)}`)
    this.name = 'ApiError'
    this.status = status
    this.method = method
    this.path = path
  }
}

export class OperatorClient {
  readonly baseUrl: string
  private readonly token: string
  private readonly timeoutMs: number

  constructor(baseUrl: string, token: string, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.token = token
    this.timeoutMs = timeoutMs
  }

  /** Status-reporting request. Never throws on a 4xx/5xx — probes need the code. */
  async raw<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    const res = await fetch(`${this.baseUrl}/api/v4${path}`, {
      method,
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text().catch(() => '')
    let data: T | null = null
    if (res.ok && text) {
      try {
        data = JSON.parse(text) as T
      } catch {
        data = null
      }
    }
    return { ok: res.ok, status: res.status, data, body: text.slice(0, 500) }
  }

  /** Throwing request for the paths where a failure is a hard stop. */
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.raw<T>(method, path, body)
    if (!r.ok) throw new ApiError(method, path, r.status, r.body)
    return r.data as T
  }

  me(): Promise<MMUser> {
    return this.call<MMUser>('GET', '/users/me')
  }

  /** Identity of whoever holds `token`, as a probe (401 is an answer, not a crash). */
  whoami(): Promise<ApiResult<MMUser>> {
    return this.raw<MMUser>('GET', '/users/me')
  }

  /** 404 => the username is free. */
  userByUsername(username: string): Promise<ApiResult<MMUser>> {
    return this.raw<MMUser>('GET', `/users/username/${encodeURIComponent(username)}`)
  }

  /** Admin-only lookup; used to prove an email is not already someone else's. */
  userByEmail(email: string): Promise<ApiResult<MMUser>> {
    return this.raw<MMUser>('GET', `/users/email/${encodeURIComponent(email)}`)
  }

  userById(userId: string): Promise<ApiResult<MMUser>> {
    return this.raw<MMUser>('GET', `/users/${userId}`)
  }

  /**
   * Native account creation. An admin token creates an ordinary account
   * (`system_user`); there is no role field here on purpose — roles are never
   * set at creation time by this tool.
   */
  createUser(args: {
    username: string
    email: string
    password: string
    nickname?: string
    first_name?: string
    position?: string
  }): Promise<ApiResult<MMUser>> {
    return this.raw<MMUser>('POST', '/users', args)
  }

  patchUser(userId: string, patch: Record<string, unknown>): Promise<ApiResult<MMUser>> {
    return this.raw<MMUser>('PUT', `/users/${userId}/patch`, patch)
  }

  /**
   * Role assignment. Callers must pass the complete role string; the only
   * grant this tool ever makes is `system_user system_user_access_token`,
   * which is what personal access tokens require. Never `system_admin`.
   */
  setUserRoles(userId: string, roles: string): Promise<ApiResult<unknown>> {
    return this.raw<unknown>('PUT', `/users/${userId}/roles`, { roles })
  }

  getTeam(teamId: string): Promise<ApiResult<MMTeam>> {
    return this.raw<MMTeam>('GET', `/teams/${teamId}`)
  }

  getTeamMember(teamId: string, userId: string): Promise<ApiResult<MMTeamMember>> {
    return this.raw<MMTeamMember>('GET', `/teams/${teamId}/members/${userId}`)
  }

  addTeamMember(teamId: string, userId: string): Promise<ApiResult<MMTeamMember>> {
    return this.raw<MMTeamMember>('POST', `/teams/${teamId}/members`, { team_id: teamId, user_id: userId })
  }

  getMyTeams(): Promise<ApiResult<MMTeam[]>> {
    return this.raw<MMTeam[]>('GET', '/users/me/teams')
  }

  getUserTeams(userId: string): Promise<ApiResult<MMTeam[]>> {
    return this.raw<MMTeam[]>('GET', `/users/${userId}/teams`)
  }

  getMyChannels(): Promise<ApiResult<MMChannel[]>> {
    return this.raw<MMChannel[]>('GET', '/users/me/channels')
  }

  createUserAccessToken(userId: string, description: string): Promise<ApiResult<MMUserAccessToken>> {
    return this.raw<MMUserAccessToken>('POST', `/users/${userId}/tokens`, { description })
  }

  listUserAccessTokens(userId: string): Promise<ApiResult<MMUserAccessToken[]>> {
    return this.raw<MMUserAccessToken[]>('GET', `/users/${userId}/tokens?per_page=200`)
  }

  revokeUserAccessToken(tokenId: string): Promise<ApiResult<unknown>> {
    return this.raw<unknown>('POST', '/users/tokens/revoke', { token_id: tokenId })
  }

  /**
   * Full server config — admin only. Only the settings provisioning actually
   * depends on are typed; the payload has hundreds of fields and pretending
   * to model them all would be worse than naming the four that matter.
   */
  serverConfig(): Promise<ApiResult<MMServerConfig>> {
    return this.raw<MMServerConfig>('GET', '/config')
  }
}

/** The slice of the server config that decides whether provisioning can work. */
export interface MMServerConfig {
  ServiceSettings?: { EnableUserAccessTokens?: boolean; EnableBotAccountCreation?: boolean }
  TeamSettings?: { EnableOpenServer?: boolean; EnableUserCreation?: boolean; RestrictCreationToDomains?: string }
  EmailSettings?: { RequireEmailVerification?: boolean; EnableSignUpWithEmail?: boolean }
  GitLabSettings?: { Enable?: boolean }
}

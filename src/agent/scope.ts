/**
 * What one connection is allowed to see, and how that answer stays true while
 * the process runs.
 *
 * Two modes, deliberately not unified:
 *
 *   static     — the configured `channelIds`, full stop. Joining a channel does
 *                NOT widen it. This is what an allowlisted profile (the Clem
 *                canary) relies on: reach is a config decision, not something
 *                anybody with an invite can grant.
 *
 *   membership — the account's ACTUAL memberships, joined channels and DMs,
 *                re-read from the server. Opt-in per connection, for a
 *                dedicated service account whose whole purpose is to be
 *                invited places. A join or a leave takes effect without
 *                restarting anything.
 *
 * `knows()` answers from the last refresh and is for listings. `check()` is the
 * authorisation path and, in membership mode, asks the server about THIS
 * channel: a leave applies immediately, and a channel we were added to a
 * second ago is not refused for being unseen. A 5xx is not an answer — it
 * propagates, because "we could not tell" must never read as "allowed" or as
 * "not a member".
 */
import { httpStatus, type MattermostClient } from '../mattermost'
import type { ConnectionConfig } from './config'

export type ScopeMode = 'static' | 'membership'

/** allowed=false carries the operator-facing reason; a transport failure throws instead. */
export interface ScopeDecision {
  allowed: boolean
  reason?: string
}

export interface ChannelScope {
  readonly mode: ScopeMode
  /** Channels in scope as of the last refresh. The watcher sweeps exactly these. */
  channels(): string[]
  /** Cheap, cached membership answer for filtering lists. */
  knows(channelId: string): boolean
  /** Authoritative per-operation decision. */
  check(channelId: string): Promise<ScopeDecision>
  /** Re-read scope from the server. A no-op in static mode. */
  refresh(): Promise<void>
}

export class StaticScope implements ChannelScope {
  readonly mode = 'static'

  constructor(private readonly conn: ConnectionConfig) {}

  channels(): string[] {
    return [...this.conn.channelIds]
  }

  knows(channelId: string): boolean {
    return this.conn.channelIds.includes(channelId)
  }

  async check(channelId: string): Promise<ScopeDecision> {
    if (this.knows(channelId)) return { allowed: true }
    return {
      allowed: false,
      reason:
        `channel ${channelId} is not in connection ${this.conn.id}'s channelIds allowlist ` +
        '(watchMemberships is off for this connection, so being a member of it grants nothing)',
    }
  }

  async refresh(): Promise<void> {}
}

export class MembershipScope implements ChannelScope {
  readonly mode = 'membership'
  private known = new Set<string>()
  private refreshedAt = 0

  constructor(
    private readonly client: MattermostClient,
    private readonly connectionId: string,
    private readonly selfUserId: string,
  ) {}

  channels(): string[] {
    return [...this.known]
  }

  knows(channelId: string): boolean {
    return this.known.has(channelId)
  }

  /** When the membership set was last successfully re-read (0 = never). */
  lastRefreshAt(): number {
    return this.refreshedAt
  }

  async check(channelId: string): Promise<ScopeDecision> {
    try {
      await this.client.getChannelMember(channelId, this.selfUserId)
      this.known.add(channelId)
      return { allowed: true }
    } catch (err) {
      const status = httpStatus(err)
      // 403: the server will not even discuss this channel with us. 404: no
      // such membership (or no such channel). Both mean "not ours".
      if (status === 403 || status === 404) {
        this.known.delete(channelId)
        return {
          allowed: false,
          reason:
            `connection ${this.connectionId} is not a member of channel ${channelId} ` +
            `(server answered HTTP ${status}); join it, or have somebody add this account, first`,
        }
      }
      throw err
    }
  }

  /**
   * One call for every channel and DM this account belongs to, across teams.
   * Deleted (archived) channels drop out, so an archived channel stops being
   * swept without anyone editing a config.
   */
  async refresh(): Promise<void> {
    const channels = await this.client.getAllMyChannels()
    const next = new Set<string>()
    for (const channel of channels) {
      if ((channel.delete_at ?? 0) > 0) continue
      next.add(channel.id)
    }
    this.known = next
    this.refreshedAt = Date.now()
  }
}

export function channelScope(conn: ConnectionConfig, client: MattermostClient, selfUserId: string): ChannelScope {
  return conn.watchMemberships ? new MembershipScope(client, conn.id, selfUserId) : new StaticScope(conn)
}

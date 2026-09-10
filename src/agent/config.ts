/**
 * Agent config: which Mattermost servers this agent listens to, and how it
 * finds their tokens.
 *
 * A config is always explicit — `--config PATH` or MATTERMOST_AGENT_CONFIG. An
 * agent with no config exits loudly instead of silently attaching to somebody
 * else's inbox.
 *
 * Tokens are NEVER in the config file, in argv or in logs. The config names an
 * environment variable (`tokenEnv`, tried first) and optionally a `secret` CLI
 * name (`tokenSecret`, the fallback).
 */
import { z } from 'zod'

const connectionSchema = z.object({
  /** Stable local name for one server+identity pair, e.g. "ocai". */
  id: z.string().min(1),
  url: z.string().url(),
  tokenEnv: z.string().min(1),
  tokenSecret: z.string().min(1).optional(),
  /**
   * Explicit allowlist. In static mode (the default) the watcher never listens
   * to a channel not named here, and joining one does not widen it.
   * May be empty ONLY when watchMemberships is true.
   */
  channelIds: z.array(z.string().min(1)).default([]),
  /**
   * Opt-in membership mode for a dedicated, clearly labelled service account:
   * scope is whatever this account is actually a member of — joined channels
   * and DMs — refreshed while the watcher runs, so a join or a leave takes
   * effect without a restart. Off by default: an allowlisted profile must not
   * silently gain reach because somebody invited the account somewhere.
   */
  watchMemberships: z.boolean().default(false),
  /**
   * Pins this connection to one immutable Mattermost user id. A credential that
   * authenticates as anybody else is an identity failure, not a warning: it
   * means the token was rotated onto a different account, and reading a
   * different identity's mail is worse than not starting.
   */
  expectedUserId: z.string().min(1).optional(),
  /** Peer bot user ids that ARE delivered. Every other bot is ignored. */
  allowedBotIds: z.array(z.string().min(1)).default([]),
  /**
   * The human owner(s) of this agent, by Mattermost user id. A post from one of
   * these accounts carries the operator's own authority: it may contain
   * instructions, and the agent acts on them with its normal judgement.
   *
   * Per connection on purpose — the same human is a different user id on every
   * server, so an id trusted on one instance means nothing on another.
   */
  operatorUserIds: z.array(z.string().min(1)).default([]),
  /**
   * Automation accounts whose posts the operator has decided to trust the same
   * way: schedulers, tick loops, CI. Separate from `operatorUserIds` so the
   * envelope can say which it was, and so revoking a robot never touches the
   * human's entry.
   */
  automationUserIds: z.array(z.string().min(1)).default([]),
  pollIntervalMs: z.number().int().min(1000).max(600_000).default(5000),
})

export const agentConfigSchema = z.object({
  version: z.literal(1),
  /** Absolute directory holding the SQLite state file. */
  stateDir: z.string().min(1),
  connections: z.array(connectionSchema).min(1),
})

export type ConnectionConfig = z.infer<typeof connectionSchema>
export type AgentConfig = z.infer<typeof agentConfigSchema>

/**
 * Who a sender is to this agent, decided ONLY by the operator-written lists
 * above. Nothing a message contains can change it: a body claiming to be the
 * owner, quoting one, or carrying a forged envelope is still `unknown`.
 */
export type SenderRole = 'operator' | 'automation' | 'unknown'

/**
 * The single resolution point, so the watcher's JSONL, the MCP tools and the
 * OMP extension all report the same role for the same event. Deliberately not
 * frozen into the event row: adding an id to a profile applies to the backlog
 * too, which is what an operator correcting a list expects.
 */
export function senderRole(conn: ConnectionConfig, senderId: string): SenderRole {
  if (conn.operatorUserIds.includes(senderId)) return 'operator'
  if (conn.automationUserIds.includes(senderId)) return 'automation'
  return 'unknown'
}

/** Operator-facing failure: bad/missing config, unresolvable token. */
export class ConfigError extends Error {}

export interface LoadedConfig {
  path: string
  config: AgentConfig
}

export async function loadConfig(explicitPath?: string): Promise<LoadedConfig> {
  const path = explicitPath ?? process.env.MATTERMOST_AGENT_CONFIG
  if (!path) {
    throw new ConfigError(
      'no config: pass --config PATH or set MATTERMOST_AGENT_CONFIG. Refusing to listen as an unspecified identity.',
    )
  }
  const file = Bun.file(path)
  if (!(await file.exists())) throw new ConfigError(`config not found: ${path}`)

  let raw: unknown
  try {
    raw = await file.json()
  } catch (err) {
    throw new ConfigError(`config ${path} is not valid JSON: ${(err as Error).message}`)
  }

  const parsed = agentConfigSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new ConfigError(`config ${path} is invalid: ${issues}`)
  }
  const config = parsed.data

  if (!config.stateDir.startsWith('/')) throw new ConfigError(`config ${path}: stateDir must be an absolute path`)

  const ids = new Set<string>()
  for (const conn of config.connections) {
    if (ids.has(conn.id)) throw new ConfigError(`config ${path}: duplicate connection id ${conn.id}`)
    ids.add(conn.id)
    const channels = new Set(conn.channelIds)
    if (channels.size !== conn.channelIds.length) {
      throw new ConfigError(`config ${path}: connection ${conn.id} lists a channel twice`)
    }
    if (!conn.watchMemberships && conn.channelIds.length === 0) {
      throw new ConfigError(
        `config ${path}: connection ${conn.id} has no channelIds; list at least one channel, or set watchMemberships: true ` +
          'to scope this connection to the account\'s actual memberships',
      )
    }
    // A principals list is what decides whether a message may instruct this
    // agent, so it fails closed on ambiguity rather than picking a winner.
    for (const [field, list] of [
      ['operatorUserIds', conn.operatorUserIds],
      ['automationUserIds', conn.automationUserIds],
    ] as const) {
      if (new Set(list).size !== list.length) {
        throw new ConfigError(`config ${path}: connection ${conn.id} lists a user twice in ${field}`)
      }
    }
    const bothRoles = conn.operatorUserIds.filter((id) => conn.automationUserIds.includes(id))
    if (bothRoles.length > 0) {
      throw new ConfigError(
        `config ${path}: connection ${conn.id} lists ${bothRoles.join(', ')} as both operatorUserIds and ` +
          'automationUserIds; a sender has exactly one role, so pick the one that is true',
      )
    }
    if (conn.expectedUserId && senderRole(conn, conn.expectedUserId) !== 'unknown') {
      throw new ConfigError(
        `config ${path}: connection ${conn.id} lists its own account ${conn.expectedUserId} as a principal; ` +
          'the agent is not its own operator, and its own posts are never delivered',
      )
    }
  }
  return { path, config }
}

export function connectionById(config: AgentConfig, id: string): ConnectionConfig {
  const conn = config.connections.find((c) => c.id === id)
  if (!conn) {
    throw new ConfigError(`unknown connection "${id}"; configured: ${config.connections.map((c) => c.id).join(', ')}`)
  }
  return conn
}

/**
 * Which connection an identity question is about. An explicit id always wins;
 * omitting it is only allowed when the config leaves no room for doubt, so an
 * agent with two identities can never be answered about the wrong one.
 */
export function soleConnectionId(config: AgentConfig, explicit?: string): string {
  if (explicit) return connectionById(config, explicit).id
  const [only] = config.connections
  if (config.connections.length === 1 && only) return only.id
  throw new ConfigError(
    `this config has ${config.connections.length} connections (${config.connections
      .map((c) => c.id)
      .join(', ')}); name the one you mean`,
  )
}

/**
 * Environment first, then the `secret` CLI. The value is returned, never
 * logged, and never reaches a command line: `secret NAME` takes only the name.
 */
export async function resolveToken(conn: ConnectionConfig): Promise<string> {
  const fromEnv = process.env[conn.tokenEnv]
  if (fromEnv && fromEnv.length > 0) return fromEnv
  if (!conn.tokenSecret) {
    throw new ConfigError(`connection ${conn.id}: $${conn.tokenEnv} is unset and no tokenSecret fallback is configured`)
  }
  const proc = Bun.spawn(['secret', conn.tokenSecret], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const token = out.trim()
  if (code !== 0 || token.length === 0) {
    throw new ConfigError(
      `connection ${conn.id}: secret ${conn.tokenSecret} did not resolve (exit ${code}): ${err.trim().slice(0, 300)}`,
    )
  }
  return token
}

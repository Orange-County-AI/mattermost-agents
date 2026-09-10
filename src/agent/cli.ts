#!/usr/bin/env bun
/**
 * The agent CLI. One process, one config, no daemon. `help` prints the same
 * list USAGE holds below; every command writes one JSON value to stdout.
 *
 * stdout during `watch` carries ONLY message events, one JSON object per line.
 * Everything else — readiness, sweeps, warnings — goes to stderr prefixed
 * `mattermost-agent:` and must never be treated as a turn.
 *
 * Exit codes: 0 clean, 1 unexpected, 2 config missing/invalid,
 * 3 another watcher holds the lock, 4 auth/identity failure.
 *
 * There is no provisioning command here on purpose: creating accounts and
 * handing out credentials is an operator job (src/admin), never an agent one.
 */
import {
  closeSessions,
  createPost,
  listPending,
  markHandled,
  openSession,
  openSessions,
  BackendError,
  IdentityError,
  type Session,
} from './backend'
import {
  addChannelMember,
  addTeamMember,
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
import { ConfigError, loadConfig, soleConnectionId, type AgentConfig } from './config'
import { runMcpServer } from './mcp'
import { ConnectionWatcher, errorText } from './watcher'

const EXIT_UNEXPECTED = 1
const EXIT_CONFIG = 2
const EXIT_LOCKED = 3
const EXIT_AUTH = 4

const HEARTBEAT_MS = 5000

const USAGE = `mattermost-agents core CLI — bun src/agent/cli.ts --config PATH <command> [flags]

  watch                                    resident JSONL message stream on stdout
  pending    [--connection ID] [--limit N] events delivered but not settled
  ack        --connection ID --event-id ID settle one event without replying
  send       --connection ID --channel-id ID --message TEXT --request-id ID [--root-id ID]
  status     [--connection ID]             identity, checkpoints, pending, watcher lock, gaps
  mcp                                      MCP stdio server

  whoami     [--connection ID]             identity, scope mode, teams, real memberships
  search-users   --term TEXT [--limit N]
  list-teams
  create-team    --name SLUG --display-name TEXT [--public]
  join-team      (--team-id ID | --team-name SLUG)
  add-team-member (--team-id ID | --team-name SLUG) (--user-id ID | --username NAME)
  list-channels  --team-id ID [--joined-only]
  create-channel --team-id ID --name SLUG --display-name TEXT [--private] [--purpose TEXT]
  join-channel   (--channel-id ID | --team-id ID --channel-name SLUG)
  add-channel-member --channel-id ID (--user-id ID | --username NAME)
  dm             (--username NAME | --user-id ID) --message TEXT --request-id ID

Every collaboration command needs --connection ID unless the config has exactly
one connection. Teams are created invite-only unless --public; channels are
created public WITHIN their team unless --private.

search-users, list-teams, create-team, join-team, add-team-member,
list-channels, create-channel, join-channel, add-channel-member and dm require
a connection with watchMemberships: true. On a static allowlist connection they
refuse without contacting the server: that profile's reach is its channelIds,
however broad its credential happens to be. whoami works either way and reports
in-scope metadata only.`

export interface CliArgs {
  command: string
  configPath?: string
  connection?: string
  eventId?: string
  limit?: number
  channelId?: string
  message?: string
  rootId?: string
  requestId?: string
  term?: string
  teamId?: string
  teamName?: string
  name?: string
  displayName?: string
  channelName?: string
  purpose?: string
  userId?: string
  username?: string
  public?: boolean
  private?: boolean
  joinedOnly?: boolean
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { command: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--config') args.configPath = argv[++i]
    else if (arg === '--connection') args.connection = argv[++i]
    else if (arg === '--event-id') args.eventId = argv[++i]
    else if (arg === '--limit') args.limit = Number(argv[++i])
    else if (arg === '--channel-id') args.channelId = argv[++i]
    else if (arg === '--message') args.message = argv[++i]
    else if (arg === '--root-id') args.rootId = argv[++i]
    else if (arg === '--request-id') args.requestId = argv[++i]
    else if (arg === '--term') args.term = argv[++i]
    else if (arg === '--team-id') args.teamId = argv[++i]
    else if (arg === '--team-name') args.teamName = argv[++i]
    else if (arg === '--name') args.name = argv[++i]
    else if (arg === '--display-name') args.displayName = argv[++i]
    else if (arg === '--channel-name') args.channelName = argv[++i]
    else if (arg === '--purpose') args.purpose = argv[++i]
    else if (arg === '--user-id') args.userId = argv[++i]
    else if (arg === '--username') args.username = argv[++i]
    else if (arg === '--public') args.public = true
    else if (arg === '--private') args.private = true
    else if (arg === '--joined-only') args.joinedOnly = true
    else if (arg === '--help' || arg === '-h') args.command = 'help'
    else if (arg?.startsWith('-')) throw new ConfigError(`unknown flag ${arg}`)
    else if (arg && !args.command) args.command = arg
    else if (arg) throw new ConfigError(`unexpected argument ${arg}`)
  }
  return args
}

const log = (line: string) => process.stderr.write(`mattermost-agent: ${line}\n`)

async function main(): Promise<number> {
  let args: CliArgs
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    log(`config-error: ${errorText(err)}`)
    return EXIT_CONFIG
  }
  if (!args.command) {
    log('config-error: no command. Run `help` for the command list.')
    return EXIT_CONFIG
  }
  if (args.command === 'help') {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  let config: AgentConfig
  try {
    config = (await loadConfig(args.configPath)).config
  } catch (err) {
    log(`config-error: ${errorText(err)}`)
    return EXIT_CONFIG
  }

  switch (args.command) {
    case 'watch':
      return watch(config)
    case 'pending':
      return withSessions(config, args.connection, (sessions) => {
        process.stdout.write(`${JSON.stringify(listPending(sessions, args.limit ?? 50), null, 2)}\n`)
      })
    case 'ack': {
      const connection = args.connection
      const eventId = args.eventId
      if (!connection || !eventId) {
        log('config-error: ack needs --connection ID and --event-id ID')
        return EXIT_CONFIG
      }
      return withSessions(config, connection, (sessions) => {
        const [session] = sessions
        if (!session) throw new BackendError(`connection ${connection} did not open`)
        process.stdout.write(`${JSON.stringify(markHandled(session, eventId))}\n`)
      })
    }
    case 'status': {
      process.stdout.write(`${JSON.stringify(await status(config, args.connection), null, 2)}\n`)
      return 0
    }
    case 'send': {
      const connection = args.connection
      const channelId = args.channelId
      const message = args.message
      const requestId = args.requestId
      if (!connection || !channelId || !message || !requestId) {
        log('config-error: send needs --connection ID --channel-id ID --message TEXT --request-id ID [--root-id ID]')
        return EXIT_CONFIG
      }
      return withSessions(config, connection, async (sessions) => {
        const [session] = sessions
        if (!session) throw new BackendError(`connection ${connection} did not open`)
        const result = await createPost(session, { channel_id: channelId, message, root_id: args.rootId, request_id: requestId })
        process.stdout.write(`${JSON.stringify(result)}\n`)
      })
    }
    case 'mcp':
      await runMcpServer(config)
      return 0
    default:
      return collaborate(config, args)
  }
}

const COLLAB_COMMANDS: Record<string, true> = {
  whoami: true,
  'search-users': true,
  'list-teams': true,
  'create-team': true,
  'join-team': true,
  'add-team-member': true,
  'list-channels': true,
  'create-channel': true,
  'join-channel': true,
  'add-channel-member': true,
  dm: true,
}

/**
 * The collaboration commands all work the same way: one connection, one
 * operation, one JSON result. The identity is the connection's credential, so
 * nothing here takes a "who am I acting as" argument.
 */
async function collaborate(config: AgentConfig, args: CliArgs): Promise<number> {
  if (!COLLAB_COMMANDS[args.command]) {
    log(`config-error: unknown command ${args.command}. Run \`help\` for the command list.`)
    return EXIT_CONFIG
  }
  let connection: string
  try {
    connection = soleConnectionId(config, args.connection)
  } catch (err) {
    log(`config-error: ${errorText(err)}`)
    return EXIT_CONFIG
  }
  return withSessions(config, connection, async (sessions) => {
    const [session] = sessions
    if (!session) throw new BackendError(`connection ${connection} did not open`)
    const result = await runCollab(session, args)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  })
}

async function runCollab(session: Session, args: CliArgs): Promise<unknown> {
  switch (args.command) {
    case 'whoami':
      return whoami(session)
    case 'search-users':
      return { users: await searchUsers(session, { term: required(args.term, '--term'), limit: args.limit }) }
    case 'list-teams':
      return listTeams(session)
    case 'create-team':
      return createTeam(session, {
        name: required(args.name, '--name'),
        display_name: required(args.displayName, '--display-name'),
        public: args.public,
      })
    case 'join-team':
      return joinTeam(session, { team_id: args.teamId, team_name: args.teamName })
    case 'add-team-member':
      return addTeamMember(session, {
        team_id: args.teamId,
        team_name: args.teamName,
        user_id: args.userId,
        username: args.username,
      })
    case 'list-channels':
      return listChannels(session, { team_id: required(args.teamId, '--team-id'), joined_only: args.joinedOnly })
    case 'create-channel':
      return createChannel(session, {
        team_id: required(args.teamId, '--team-id'),
        name: required(args.name, '--name'),
        display_name: required(args.displayName, '--display-name'),
        private: args.private,
        purpose: args.purpose,
      })
    case 'join-channel':
      return joinChannel(session, {
        channel_id: args.channelId,
        team_id: args.teamId,
        channel_name: args.channelName,
      })
    case 'add-channel-member':
      return addChannelMember(session, {
        channel_id: required(args.channelId, '--channel-id'),
        user_id: args.userId,
        username: args.username,
      })
    case 'dm':
      return dm(session, {
        user_id: args.userId,
        username: args.username,
        message: required(args.message, '--message'),
        request_id: required(args.requestId, '--request-id'),
      })
    default:
      throw new ConfigError(`unknown command ${args.command}`)
  }
}

/** A missing flag is a usage error (exit 2), not a runtime failure. */
function required(value: string | undefined, flag: string): string {
  if (!value || value.length === 0) throw new ConfigError(`${flag} is required. Run \`help\` for the command list.`)
  return value
}

async function withSessions(
  config: AgentConfig,
  connection: string | undefined,
  run: (s: Session[]) => void | Promise<void>,
): Promise<number> {
  let sessions: Session[]
  try {
    sessions = await openSessions(config, connection)
  } catch (err) {
    return reportOpenFailure(err)
  }
  try {
    await run(sessions)
    return 0
  } catch (err) {
    if (err instanceof ConfigError) {
      log(`config-error: ${err.message}`)
      return EXIT_CONFIG
    }
    log(err instanceof BackendError ? `error: ${err.message}` : `error: ${errorText(err)}`)
    return EXIT_UNEXPECTED
  } finally {
    closeSessions(sessions)
  }
}

function reportOpenFailure(err: unknown): number {
  if (err instanceof ConfigError) {
    log(`config-error: ${err.message}`)
    return EXIT_CONFIG
  }
  if (err instanceof IdentityError) {
    log(`identity-error: ${err.message}`)
    return EXIT_AUTH
  }
  log(`auth-error: ${errorText(err)}`)
  return EXIT_AUTH
}

interface ConnectionStatus {
  connection: string
  url: string
  /**
   * "live" once the identity resolved; "identity-mismatch" when the credential
   * belongs to a different user than the config pins it to; "unreachable"
   * carries any other reason instead.
   */
  health: 'live' | 'unreachable' | 'identity-mismatch'
  error?: string
  authenticated_as?: { id: string; username: string }
  /** How this connection decides what it watches. */
  scope?: 'static' | 'membership'
  channels?: { channel_id: string; checkpoint: number | null }[]
  pending?: number
  watcher_lock?: { pid: number; host: string; heartbeat_at: number } | null
  gaps?: { channel_id: string; from_ms: number; to_ms: number; observed: number }[]
}

/** Never fails as a whole: one dead server is reported as one unreachable row. */
async function status(config: AgentConfig, connectionId?: string): Promise<ConnectionStatus[]> {
  const conns = connectionId ? config.connections.filter((c) => c.id === connectionId) : config.connections
  const rows: ConnectionStatus[] = []
  for (const conn of conns) {
    let session: Session
    try {
      session = await openSession(config, conn.id)
    } catch (err) {
      rows.push({
        connection: conn.id,
        url: conn.url,
        health: err instanceof IdentityError ? 'identity-mismatch' : 'unreachable',
        error: errorText(err),
      })
      continue
    }
    const holder = session.state.lockHolder()
    rows.push({
      connection: conn.id,
      url: conn.url,
      health: 'live',
      authenticated_as: { id: session.selfUserId, username: session.selfUsername },
      scope: session.scope.mode,
      channels: session.scope
        .channels()
        .map((channel_id) => ({ channel_id, checkpoint: session.state.checkpoint(channel_id) ?? null })),
      pending: session.state.pending(1000).length,
      watcher_lock: holder ? { pid: holder.pid, host: holder.host, heartbeat_at: holder.heartbeat_at } : null,
      gaps: session.state.gaps().map(({ channel_id, from_ms, to_ms, observed }) => ({ channel_id, from_ms, to_ms, observed })),
    })
    session.state.close()
  }
  return rows
}

/** Bounded retry for a connection that is down: 1s doubling to a minute. */
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 60_000

type ConnectionOutcome = 'live' | 'lock-held' | 'auth' | 'config'

/**
 * One supervisor per configured connection. Connections are independent by
 * construction: an unreachable or misconfigured server becomes a DEGRADED
 * connection that keeps retrying, and never stops another connection's
 * listener or delays its mail. Signal handlers are installed before any network
 * I/O, so a hung startup is still killable and only owned locks are released.
 */
async function watch(config: AgentConfig): Promise<number> {
  const running = new Map<string, { session: Session; watcher: ConnectionWatcher }>()
  const outcomes = new Map<string, ConnectionOutcome>()
  const retryTimers = new Set<ReturnType<typeof setTimeout>>()
  let stopping = false

  const heartbeat = setInterval(() => {
    for (const { session } of running.values()) session.state.heartbeat()
  }, HEARTBEAT_MS)

  const { promise, resolve } = Promise.withResolvers<number>()
  const shutdown = (signal: string) => {
    if (stopping) return
    stopping = true
    log(`shutting down on ${signal}`)
    clearInterval(heartbeat)
    for (const timer of retryTimers) clearTimeout(timer)
    for (const { session, watcher } of running.values()) {
      watcher.stop()
      session.state.releaseLock()
      session.state.close()
    }
    resolve(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  const bring = async (conn: (typeof config.connections)[number], attempt: number): Promise<ConnectionOutcome> => {
    if (stopping) return 'config'
    let session: Session
    try {
      session = await openSession(config, conn.id)
    } catch (err) {
      // An identity mismatch is retried like any other credential failure —
      // the token can be put back — but it is never logged as a plain auth
      // error, because the remedy is completely different.
      const reason =
        err instanceof ConfigError ? 'config-error' : err instanceof IdentityError ? 'identity-error' : 'auth-error'
      log(`${reason}: connection=${conn.id} DEGRADED (attempt ${attempt}): ${errorText(err)}`)
      return err instanceof ConfigError ? 'config' : 'auth'
    }
    const lock = session.state.acquireLock()
    if (!lock.ok) {
      log(`lock-held: pid=${lock.holder.pid} host=${lock.holder.host} scope=${session.state.scope}`)
      session.state.close()
      return 'lock-held'
    }
    const watcher = new ConnectionWatcher(conn, session.client, session.state, session.token, session.selfUserId, {
      emit: (line) => process.stdout.write(`${line}\n`),
      log,
    })
    try {
      await watcher.start()
    } catch (err) {
      log(`warn: connection=${conn.id} DEGRADED (attempt ${attempt}): ${errorText(err)}`)
      watcher.stop()
      session.state.releaseLock()
      session.state.close()
      return 'auth'
    }
    running.set(conn.id, { session, watcher })
    return 'live'
  }

  const supervise = async (conn: (typeof config.connections)[number], attempt: number): Promise<ConnectionOutcome> => {
    const outcome = await bring(conn, attempt)
    outcomes.set(conn.id, outcome)
    // A held lock is another live watcher's territory; retrying would fight it.
    // Everything else — bad token, DNS, refused connection, 5xx — is retried,
    // because the server coming back must not need a restart here.
    if (outcome !== 'live' && outcome !== 'lock-held' && !stopping) {
      const delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS)
      const timer = setTimeout(() => {
        retryTimers.delete(timer)
        void supervise(conn, attempt + 1)
      }, delay)
      retryTimers.add(timer)
    }
    return outcome
  }

  const first = await Promise.all(config.connections.map((conn) => supervise(conn, 1)))
  const live = first.filter((o) => o === 'live').length
  if (live === 0 && first.every((o) => o === 'lock-held')) {
    shutdown('lock-held')
    return EXIT_LOCKED
  }
  if (live === 0 && first.every((o) => o === 'config')) {
    shutdown('config-error')
    return EXIT_CONFIG
  }
  if (live === 0 && !first.includes('lock-held')) {
    shutdown('auth-error')
    return EXIT_AUTH
  }
  log(`ready connections=${live} degraded=${first.length - live}`)
  return promise
}

const code = await main().catch((err) => {
  log(`error: ${errorText(err)}`)
  return EXIT_UNEXPECTED
})
process.exit(code)

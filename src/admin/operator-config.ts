/**
 * Operator authority and scope, supplied explicitly.
 *
 * This repository ships NO production target. There is no default server, no
 * default team, no built-in identities and no built-in credential name: a
 * tool that can create accounts and mint tokens must be told, in one auditable
 * file, WHICH installation it is allowed to act on. That also keeps the public
 * source free of anybody's instance host, team id or human user id.
 *
 * The file holds references only — a secret NAME, never a token value.
 *
 *   ~/.config/mattermost-agents/operator.json   (0600)
 *   {
 *     "version": 1,
 *     "url": "https://mattermost.example.com",
 *     "tokenSecret": "MATTERMOST_ADMIN_TOKEN",
 *     "teamId": "<team id>",
 *     "observerUserIds": ["<human user id>"]
 *   }
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { OPERATOR_CONFIG_DIR } from './record'

export interface OperatorConfig {
  version: 1
  /** Base URL of the Mattermost installation this operator may act on. */
  url: string
  /** Secret NAME holding the operator's admin token. Never a value. */
  tokenSecret: string
  /** Team new identities join, and the team `probe`/`verify` inspect. */
  teamId?: string
  /**
   * Humans whose team membership `verify` asserts — the people who are
   * supposed to be able to see what the agents are doing.
   */
  observerUserIds?: string[]
  /** Optional local shorthand: name -> identity definition, for repeat runs. */
  agents?: Record<
    string,
    {
      username?: string
      email?: string
      displayLabel?: string
      secretName?: string
      position?: string
      connectionId?: string
    }
  >
}

export class OperatorConfigError extends Error {}

export function operatorConfigPath(explicit?: string): string {
  return explicit ?? process.env.MATTERMOST_AGENTS_OPERATOR_CONFIG ?? join(OPERATOR_CONFIG_DIR, 'operator.json')
}

/**
 * Validate an already-parsed config. Kept separate from the file read so the
 * rules are testable without a filesystem, and so every refusal names the
 * field an operator has to fix.
 */
export function parseOperatorConfig(raw: unknown, source: string): OperatorConfig {
  if (!raw || typeof raw !== 'object') throw new OperatorConfigError(`${source}: not a JSON object`)
  const value = raw as Record<string, unknown>
  if (value.version !== 1) throw new OperatorConfigError(`${source}: version must be 1`)
  if (typeof value.url !== 'string' || !/^https?:\/\/[^\s]+$/.test(value.url)) {
    throw new OperatorConfigError(`${source}: "url" must be the http(s) base URL of your Mattermost server`)
  }
  if (typeof value.tokenSecret !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(value.tokenSecret)) {
    throw new OperatorConfigError(`${source}: "tokenSecret" must be a secret NAME (UPPER_SNAKE) — never a token value`)
  }
  if (/^[a-z0-9]{26}$/.test(value.tokenSecret)) {
    throw new OperatorConfigError(`${source}: "tokenSecret" looks like a token value`)
  }
  const teamId = value.teamId
  if (teamId !== undefined && (typeof teamId !== 'string' || teamId.length === 0)) {
    throw new OperatorConfigError(`${source}: "teamId" must be a non-empty string when present`)
  }
  const observers = value.observerUserIds
  if (observers !== undefined && (!Array.isArray(observers) || observers.some((o) => typeof o !== 'string' || o.length === 0))) {
    throw new OperatorConfigError(`${source}: "observerUserIds" must be an array of user ids`)
  }
  const agents = value.agents
  if (agents !== undefined && (typeof agents !== 'object' || agents === null || Array.isArray(agents))) {
    throw new OperatorConfigError(`${source}: "agents" must be an object keyed by local agent name`)
  }
  return {
    version: 1,
    url: value.url.replace(/\/+$/, ''),
    tokenSecret: value.tokenSecret,
    teamId: teamId as string | undefined,
    observerUserIds: observers as string[] | undefined,
    agents: agents as OperatorConfig['agents'],
  }
}

/** Load and validate; a missing file is an operator error, not a default. */
export async function loadOperatorConfig(explicitPath?: string): Promise<OperatorConfig> {
  const path = operatorConfigPath(explicitPath)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new OperatorConfigError(
        `no operator config at ${path}\n  Create it (0600) with {"version":1,"url":"https://mattermost.example.com","tokenSecret":"MY_ADMIN_TOKEN_NAME","teamId":"<team id>"}, or pass --operator-config FILE`,
      )
    }
    throw err
  }
  // A file that can create accounts should not be world-readable.
  const mode = (await stat(path)).mode & 0o777
  if (mode & 0o077) {
    throw new OperatorConfigError(`${path} is mode ${mode.toString(8)} — run: chmod 600 ${path}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new OperatorConfigError(`${path}: invalid JSON (${(err as Error).message})`)
  }
  return parseOperatorConfig(parsed, path)
}

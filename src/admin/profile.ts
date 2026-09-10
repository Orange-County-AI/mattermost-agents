/**
 * The agent profile: the one file an agent reads to know WHICH identity it is.
 *
 * Two invariants:
 *   - it names its token by secret NAME only, never a value;
 *   - `expectedUserId` pins the immutable Mattermost user id the provisioning
 *     run created, so a profile that resolves somebody else's token fails
 *     closed at startup.
 *
 * A profile is also an operator-owned file: it can gain a second Mattermost
 * instance, a narrowed channel scope, a custom stateDir. Provisioning is a
 * repeatable command, so it MUST NOT rewrite what it did not create. The
 * planner below decides between create / keep / refuse, and only an explicit
 * `--replace-profile` overwrites an existing file.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PROFILE_DIR } from './record'

export interface ProfileConnection {
  id: string
  url: string
  tokenEnv: string
  tokenSecret: string
  expectedUserId: string
  channelIds: string[]
  watchMemberships: boolean
  allowedBotIds: string[]
  /** Mattermost user ids whose posts carry the operator's own authority. */
  operatorUserIds: string[]
  /** Automation accounts the operator trusts the same way. */
  automationUserIds: string[]
  pollIntervalMs: number
}

export interface AgentProfile {
  version: 1
  stateDir: string
  connections: ProfileConnection[]
}

export function profilePath(name: string): string {
  return join(PROFILE_DIR, `${name}.json`)
}

export function buildProfile(args: {
  name: string
  connectionId: string
  url: string
  secretName: string
  expectedUserId: string
  stateDir?: string
  allowedBotIds?: string[]
  operatorUserIds?: string[]
  automationUserIds?: string[]
  pollIntervalMs?: number
}): AgentProfile {
  return {
    version: 1,
    stateDir: args.stateDir ?? `${process.env.HOME}/.local/share/mattermost-agents/${args.name}`,
    connections: [
      {
        id: args.connectionId,
        url: args.url,
        tokenEnv: args.secretName,
        tokenSecret: args.secretName,
        expectedUserId: args.expectedUserId,
        // Membership mode: the agent watches whatever it is joined to, so an
        // explicit allowlist would only fight with the channels it creates.
        channelIds: [],
        watchMemberships: true,
        allowedBotIds: args.allowedBotIds ?? [],
        // Written out empty rather than omitted: an operator editing a fresh
        // profile can see the knob that decides whose messages may instruct
        // this agent, instead of having to know the field name exists.
        operatorUserIds: args.operatorUserIds ?? [],
        automationUserIds: args.automationUserIds ?? [],
        pollIntervalMs: args.pollIntervalMs ?? 5000,
      },
    ],
  }
}

export type ProfileAction = 'create' | 'keep' | 'replace' | 'refuse'

export interface ProfilePlan {
  action: ProfileAction
  reason: string
}

/**
 * Decide what to do with an existing profile, comparing only the BINDING —
 * connection id, server url, identity, and the two secret references. Scope
 * (`channelIds`, `watchMemberships`), `stateDir`, `allowedBotIds`, poll
 * interval and any other connection are the operator's business: if the
 * binding already matches, the right action is to change nothing at all.
 */
export function planProfileWrite(
  existing: AgentProfile | null,
  intended: ProfileConnection,
  options: { replace?: boolean } = {},
): ProfilePlan {
  if (options.replace) {
    return { action: 'replace', reason: 'operator asked for a replacement profile' }
  }
  if (!existing) return { action: 'create', reason: 'no profile yet' }
  if (existing.version !== 1 || !Array.isArray(existing.connections)) {
    return {
      action: 'refuse',
      reason: 'the existing profile is not a version 1 profile with a connections array — fix it by hand, or re-run with --replace-profile',
    }
  }
  const current = existing.connections.find((c) => c?.id === intended.id)
  if (!current) {
    const present = existing.connections.map((c) => c?.id).join(', ') || '(none)'
    return {
      action: 'refuse',
      reason: `the profile exists but has no connection "${intended.id}" (it has: ${present}). Add that connection by hand, or re-run with --replace-profile to overwrite the whole file`,
    }
  }
  const differences: string[] = []
  if (current.url !== intended.url) differences.push(`url ${current.url} != ${intended.url}`)
  if (current.expectedUserId !== intended.expectedUserId) {
    differences.push(`expectedUserId ${current.expectedUserId} != ${intended.expectedUserId}`)
  }
  if (current.tokenEnv !== intended.tokenEnv) differences.push(`tokenEnv ${current.tokenEnv} != ${intended.tokenEnv}`)
  if (current.tokenSecret !== intended.tokenSecret) {
    differences.push(`tokenSecret ${current.tokenSecret} != ${intended.tokenSecret}`)
  }
  if (differences.length > 0) {
    return {
      action: 'refuse',
      reason: `connection "${intended.id}" is bound to something else: ${differences.join('; ')}. Resolve that by hand, or re-run with --replace-profile`,
    }
  }
  return { action: 'keep', reason: `connection "${intended.id}" already binds ${intended.expectedUserId} via ${intended.tokenEnv}` }
}

/**
 * A profile is a config file, and the one thing a config file must never hold
 * is the credential. Secret NAMES are uppercase identifiers; a Mattermost
 * access token is 26 chars of lowercase base32 — that is the shape we reject.
 */
export function assertNoTokenValues(profile: AgentProfile): void {
  for (const conn of profile.connections) {
    for (const key of ['tokenEnv', 'tokenSecret'] as const) {
      if (/^[a-z0-9]{26}$/.test(conn[key])) {
        throw new Error(`profile connection ${conn.id}: ${key} looks like a token value, not a secret name`)
      }
    }
    if (!/^[A-Z][A-Z0-9_]*$/.test(conn.tokenEnv)) {
      throw new Error(`profile connection ${conn.id}: tokenEnv must be an env-var style secret NAME`)
    }
  }
}

/**
 * Write 0600 and read back the INTENDED connection by id — connection order
 * is the operator's, so `connections[0]` proves nothing.
 */
export async function writeProfile(name: string, profile: AgentProfile, connectionId: string): Promise<string> {
  assertNoTokenValues(profile)
  const intended = profile.connections.find((c) => c.id === connectionId)
  if (!intended) throw new Error(`profile ${name}: no connection "${connectionId}" to write`)
  const path = profilePath(name)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
  const parsed = JSON.parse(await readFile(path, 'utf8')) as AgentProfile
  const written = parsed.connections.find((c) => c.id === connectionId)
  if (written?.expectedUserId !== intended.expectedUserId || written.tokenSecret !== intended.tokenSecret) {
    throw new Error(`profile ${path} did not read back as written for connection "${connectionId}"`)
  }
  return path
}

export async function readProfile(name: string): Promise<AgentProfile | null> {
  try {
    return JSON.parse(await readFile(profilePath(name), 'utf8')) as AgentProfile
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * Credential-free provisioning record.
 *
 * This is the file that makes provisioning idempotent AND safe: without it,
 * "the username already exists" is indistinguishable from "somebody else's
 * account happens to be called that", and the only safe answer to the second
 * one is to refuse. The record says which server + user id THIS tool created,
 * which token id it minted, and how far it got before any failure.
 *
 * It holds identifiers and digests only — no token, no password, ever.
 */
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const OPERATOR_CONFIG_DIR = process.env.MATTERMOST_AGENTS_CONFIG_DIR ?? `${process.env.HOME}/.config/mattermost-agents`
export const RECORD_DIR = join(OPERATOR_CONFIG_DIR, 'provisioning')
export const PROFILE_DIR = join(OPERATOR_CONFIG_DIR, 'profiles')

/** How far provisioning got. A partial run leaves the truth here, not in a log. */
export interface ProvisioningSteps {
  accountCreated: boolean
  teamJoined: boolean
  tokenRoleGranted: boolean
  tokenIssued: boolean
  secretWritten: boolean | 'unknown'
  profileWritten: boolean
}

export interface ProvisioningRecord {
  version: 1
  /** Local agent name; also the profile filename and the record filename. */
  name: string
  serverUrl: string
  /** Immutable Mattermost user id — the thing identity is pinned to. */
  userId: string
  username: string
  email: string
  displayLabel: string
  /** What the server says this account is. Reported, never assumed. */
  accountType: 'bot' | 'user'
  roles: string
  teamId: string
  teamName: string
  secretName: string
  /**
   * True when this identity was bound to a PRE-EXISTING account with
   * `provision --adopt <user-id>` instead of being created here. The
   * distinction is worth keeping: the account's history, its email and
   * whatever else it already had are not this tool's doing.
   */
  adopted?: true
  /**
   * True when an operator accepted a PRIVILEGED account (one holding
   * `system_admin`) with `--adopt … --allow-privileged`. It records consent,
   * not a grant: provisioning never gave this account a role and never took
   * one away. A later run reads it and does not ask again.
   */
  allowPrivileged?: true
  /** The exact role string that was accepted, as the server reported it. */
  adoptedRoles?: string
  /** Which profile connection this identity is bound to. */
  connectionId: string
  /** Access token id (an identifier, not the credential) so it can be revoked. */
  tokenId: string | null
  /** sha256 prefix of the minted token, to prove the store still holds it. */
  tokenDigest: string | null
  profilePath: string
  /** Who provisioned it: the operator identity that held the admin token. */
  provisionedBy: { userId: string; username: string }
  createdAt: string
  updatedAt: string
  steps: ProvisioningSteps
  /** Free-text state for a partial run: what is left to do by hand. */
  incomplete?: string
}

export function recordPath(name: string): string {
  return join(RECORD_DIR, `${name}.json`)
}

export async function readRecord(name: string): Promise<ProvisioningRecord | null> {
  try {
    const text = await readFile(recordPath(name), 'utf8')
    return JSON.parse(text) as ProvisioningRecord
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function writeRecord(record: ProvisioningRecord): Promise<string> {
  const path = recordPath(record.name)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
  return path
}

export async function listRecords(): Promise<ProvisioningRecord[]> {
  let names: string[]
  try {
    names = await readdir(RECORD_DIR)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: ProvisioningRecord[] = []
  for (const file of names.filter((n) => n.endsWith('.json'))) {
    const record = await readRecord(file.slice(0, -'.json'.length))
    if (record) out.push(record)
  }
  return out
}

/**
 * A record must never grow a credential. Provisioning writes through here, and
 * anything that looks like a Mattermost token or a password field stops it.
 */
export function assertCredentialFree(record: ProvisioningRecord): void {
  const forbidden = ['token', 'password', 'secret']
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      // Token ids are 26 chars too, so key names decide: only *Digest / *Id /
      // *Name keys may hold an id-shaped string.
      const key = path.split('.').pop() ?? ''
      const looksSensitive = forbidden.some((f) => key.toLowerCase().includes(f))
      const allowed = /(Id|Digest|Name)$/.test(key)
      if (looksSensitive && !allowed) {
        throw new Error(`provisioning record ${record.name}: field ${path} may hold a credential`)
      }
      return
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`)
    }
  }
  walk(record, 'record')
}

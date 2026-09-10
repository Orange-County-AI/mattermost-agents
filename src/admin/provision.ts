/**
 * Idempotent provisioning of one agent identity.
 *
 * The whole point of this file is that running it twice is safe and running it
 * once, badly, is recoverable:
 *
 *   - a username that already exists is only reused when the provisioning
 *     record proves THIS tool created that exact user id. An unrelated account
 *     with a nice-looking name is never adopted and never has a token minted
 *     for it;
 *   - a secret that already exists is never blindly overwritten: the stored
 *     value is checked against the server (whoami) and reused when it already
 *     authenticates as the right user;
 *   - every step updates the record, so a partial run leaves a truthful state
 *     instead of a mystery;
 *   - a token that was minted but could not be stored is revoked, because an
 *     unstored credential is a live credential nobody can use or rotate. The
 *     one exception is an UNVERIFIED secret write (exit 4), where the store
 *     may in fact hold it — that is reported as unknown and left alone.
 */
import { OperatorClient, type MMUser } from './api'
import {
  buildProfile,
  planProfileWrite,
  profilePath,
  readProfile,
  writeProfile,
  type ProfileConnection,
} from './profile'
import { digest, readSecret, readSecretFromStore, writeSecret, type StoreRead } from './secrets'
import type { OperatorConfig } from './operator-config'
import {
  assertCredentialFree,
  readRecord,
  recordPath,
  writeRecord,
  type ProvisioningRecord,
  type ProvisioningSteps,
} from './record'

/**
 * There are deliberately NO constants here for a server, a team, a human or
 * a credential name. Authority and scope come from the operator config
 * (see ./operator-config.ts) or from explicit flags, so this source names no
 * installation and ships no production target.
 */

export interface AgentDefinition {
  /** Local name: profile filename, record filename, connection state dir. */
  name: string
  username: string
  displayLabel: string
  email: string
  secretName: string
  position: string
  /**
   * Profile connection id: which server binding inside the profile this
   * identity is. Never guessed for a non-default server — a profile can hold
   * several instances and picking the wrong id rebinds the wrong one.
   */
  connectionId: string
}

/**
 * Build a definition for ANY identity from operator-supplied values.
 *
 * There is no built-in list of agents: a public tool that knew about
 * somebody's real fleet would be documenting it. Callers assemble the values
 * from explicit flags, the `agents` shorthand in the operator config, and the
 * provisioning record of an earlier run. Everything is validated here because
 * these values become a server account, a secret NAME and a profile path —
 * three things that are painful to take back.
 */
export function defineAgent(args: {
  name: string
  username?: string
  email?: string
  displayLabel?: string
  secretName?: string
  position?: string
  connectionId?: string
}): AgentDefinition {
  const def: AgentDefinition = {
    name: args.name,
    username: args.username ?? args.name,
    email: args.email ?? '',
    displayLabel: args.displayLabel ?? '',
    secretName: args.secretName ?? '',
    position: args.position ?? 'AI agent — automated account, not a person',
    connectionId: args.connectionId ?? '',
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(def.connectionId)) {
    throw new ProvisionError(
      `invalid or missing connection id for ${args.name}`,
      'pass --connection-id ID; it names the connection inside the profile and is never guessed',
    )
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(def.name)) {
    throw new ProvisionError(`invalid agent name "${def.name}"`, 'it becomes a profile filename: lowercase, digits, . _ -')
  }
  // Mattermost usernames: 3-22 chars, lowercase letters/digits and . - _
  if (!/^[a-z0-9][a-z0-9._-]{2,21}$/.test(def.username)) {
    throw new ProvisionError(`invalid username "${def.username}"`, 'Mattermost allows 3-22 chars of lowercase letters, digits, and . - _')
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(def.email)) {
    throw new ProvisionError(`invalid or missing email for ${def.name}`, 'pass --email; use a service address no human reads')
  }
  if (def.displayLabel.trim().length === 0) {
    throw new ProvisionError(`missing display label for ${def.name}`, 'pass --label; it is what humans see in the channel')
  }
  // The profile stores a NAME, so a value pasted here would be stored in
  // plaintext for good. Shape-check it as an env-var identifier.
  if (!/^[A-Z][A-Z0-9_]*$/.test(def.secretName)) {
    throw new ProvisionError(`invalid or missing secret NAME for ${def.name}`, 'pass --secret NAME (UPPER_SNAKE); never a token value')
  }
  return def
}

export class ProvisionError extends Error {
  /** What authority or precondition was missing, in operator terms. */
  readonly detail: string
  constructor(message: string, detail = '') {
    super(detail ? `${message}\n  ${detail}` : message)
    this.name = 'ProvisionError'
    this.detail = detail
  }
}

export interface Operator {
  client: OperatorClient
  identity: MMUser
  serverUrl: string
  config: OperatorConfig
}

/**
 * Resolve the operator credential and prove who it is before anything is
 * created. Provisioning with an unidentified token is how the wrong account
 * ends up owning a fleet.
 */
export async function resolveOperator(config: OperatorConfig, serverUrlOverride?: string): Promise<Operator> {
  const serverUrl = serverUrlOverride ?? config.url
  const token = await readSecret(config.tokenSecret)
  if (!token) {
    throw new ProvisionError(
      `operator credential ${config.tokenSecret} not resolvable`,
      `neither $${config.tokenSecret} nor \`secret ${config.tokenSecret}\` produced a value`,
    )
  }
  const client = new OperatorClient(serverUrl, token)
  const who = await client.whoami()
  if (!who.ok || !who.data) {
    throw new ProvisionError(`operator credential rejected by ${serverUrl}`, `GET /users/me answered HTTP ${who.status}`)
  }
  return { client, identity: who.data, serverUrl, config }
}

/** Scope is never defaulted to a production target: flag, then config, then refuse. */
export function requireTeamId(config: OperatorConfig, override?: string): string {
  const teamId = override ?? config.teamId
  if (!teamId) {
    throw new ProvisionError('no team id', 'pass --team ID, or set "teamId" in the operator config')
  }
  return teamId
}

export type AccountAction = 'create' | 'reuse' | 'refuse'

export interface AccountDecision {
  action: AccountAction
  reason: string
}

/**
 * Ownership check, kept pure so the refusal paths are testable without a
 * server. "The name is taken" and "we own the name" are different facts and
 * only the second one may mint a credential.
 */
export function decideAccountAction(args: {
  existing: { id: string; username: string } | null
  record: ProvisioningRecord | null
  allowRecreate: boolean
}): AccountDecision {
  const { existing, record, allowRecreate } = args
  if (existing && record && record.userId === existing.id) {
    return { action: 'reuse', reason: `record owns user ${existing.id}` }
  }
  if (existing && record) {
    return {
      action: 'refuse',
      reason: `username ${existing.username} now resolves to ${existing.id}, but the provisioning record owns ${record.userId} — refusing to adopt a different account`,
    }
  }
  if (existing) {
    return {
      action: 'refuse',
      reason: `username ${existing.username} already exists (${existing.id}) and no provisioning record claims it — refusing to adopt an unrelated account`,
    }
  }
  if (record && !allowRecreate) {
    return {
      action: 'refuse',
      reason: `record claims user ${record.userId} but that username is free — the account was deleted or renamed; re-run with --recreate to provision a new one`,
    }
  }
  return { action: 'create', reason: record ? 'recreating after a vanished account' : 'no account, no record' }
}

export type SecretAction = 'mint' | 'reuse' | 'refuse'

export interface SecretDecision {
  action: SecretAction
  reason: string
}

/** Never overwrite a stored credential you have not identified. */
export function decideSecretAction(args: {
  /** What the STORE actually said — not "did a read succeed". */
  storeStatus: StoreRead['status']
  storedIdentity: string | null
  expectedUserId: string
  rotate: boolean
  reason?: string
}): SecretDecision {
  const { storeStatus, storedIdentity, expectedUserId, rotate } = args
  if (storeStatus === 'unknown') {
    return {
      action: 'refuse',
      reason: `the store did not answer authoritatively for this name, so nothing may be minted or written: ${args.reason ?? 'no detail'}`,
    }
  }
  if (storeStatus === 'stale') {
    // A cached value proves what the store held once, not what it holds. Both
    // minting and overwriting would be decided on evidence we do not have.
    return {
      action: 'refuse',
      reason: `the value came from the local cache, not the store (${args.reason ?? 'authority unreachable'}) — retry when the store is reachable`,
    }
  }
  if (storeStatus === 'absent') return { action: 'mint', reason: 'the store positively has no value under this name' }
  if (rotate) return { action: 'mint', reason: 'rotation requested' }
  if (storedIdentity === expectedUserId) {
    return { action: 'reuse', reason: `stored token already authenticates as ${expectedUserId}` }
  }
  if (storedIdentity === null) {
    return {
      action: 'refuse',
      reason: 'a token is stored under this name but the server rejects it — refusing to overwrite; re-run with --rotate to replace it deliberately',
    }
  }
  return {
    action: 'refuse',
    reason: `stored token authenticates as ${storedIdentity}, not ${expectedUserId} — refusing to overwrite somebody else's credential`,
  }
}

/**
 * Password for an account that will only ever authenticate by access token.
 * It exists because native user creation requires one; it is generated here,
 * used once, and never written anywhere — not argv, not a log, not the record.
 */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+'
  const bytes = new Uint8Array(48)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  // Mattermost's default policy wants lower, upper, number and symbol present.
  return `Aa1!${out}`
}

/** Who does this token belong to? null = the server does not accept it. */
export async function tokenIdentity(serverUrl: string, token: string): Promise<{ userId: string | null; status: number }> {
  const probe = new OperatorClient(serverUrl, token)
  const who = await probe.whoami()
  return { userId: who.ok && who.data ? who.data.id : null, status: who.status }
}

function emptySteps(): ProvisioningSteps {
  return {
    accountCreated: false,
    teamJoined: false,
    tokenRoleGranted: false,
    tokenIssued: false,
    secretWritten: false,
    profileWritten: false,
  }
}

export interface ProvisionOptions {
  teamId?: string
  allowRecreate?: boolean
  rotate?: boolean
  dryRun?: boolean
  /** Overwrite an existing profile wholesale. Off by default, on purpose. */
  replaceProfile?: boolean
}

export interface ProvisionOutcome {
  record: ProvisioningRecord
  actions: string[]
  warnings: string[]
}

/**
 * Exit status for a provisioning run, so automation cannot read "unknown" as
 * "ready".
 *
 * A secret write that came back UNVERIFIED (`secret set` exit 4) means the
 * request left this host and nothing here knows what the store did. The
 * account, the token and the record are all correct and deliberately left
 * alone — but the agent is NOT known-provisioned, so the process must not
 * exit 0. It exits 4, the same number the secret CLI uses for the same
 * meaning.
 */
export const EXIT_UNVERIFIED = 4

export function provisionExitCode(record: ProvisioningRecord): number {
  return record.steps.secretWritten === 'unknown' ? EXIT_UNVERIFIED : 0
}

export async function provisionAgent(
  operator: Operator,
  def: AgentDefinition,
  options: ProvisionOptions = {},
): Promise<ProvisionOutcome> {
  const { client, serverUrl } = operator
  const teamId = requireTeamId(operator.config, options.teamId)
  const actions: string[] = []
  const warnings: string[] = []

  // Pre-flight the secret store BEFORE any mutation. If the store cannot say
  // authoritatively whether this name holds something, no account is created
  // and no credential is minted: an uncertain read must cost nothing.
  const preflightStore = await readSecretFromStore(def.secretName)
  if (preflightStore.status === 'unknown' || preflightStore.status === 'stale') {
    throw new ProvisionError(
      `refusing to provision ${def.name}: the secret store is not answering authoritatively`,
      `${preflightStore.reason}\n  Nothing was created, minted or written. Retry when the store is reachable.`,
    )
  }

  const existingRecord = await readRecord(def.name)
  const byUsername = await client.userByUsername(def.username)
  if (!byUsername.ok && byUsername.status !== 404) {
    throw new ProvisionError(
      `cannot look up username ${def.username}`,
      `GET /users/username/${def.username} answered HTTP ${byUsername.status} ${byUsername.body}`,
    )
  }
  const existing = byUsername.ok ? byUsername.data : null

  const decision = decideAccountAction({
    existing: existing ? { id: existing.id, username: existing.username } : null,
    record: existingRecord,
    allowRecreate: options.allowRecreate ?? false,
  })
  if (decision.action === 'refuse') throw new ProvisionError(`refusing to provision ${def.name}`, decision.reason)

  // Pre-flight the profile BEFORE anything irreversible: a profile the
  // operator has extended (second instance, narrowed scope, custom stateDir)
  // must stop the run here, not after a credential has been minted.
  const intendedFor = (expectedUserId: string): ProfileConnection => ({
    id: def.connectionId,
    url: serverUrl,
    tokenEnv: def.secretName,
    tokenSecret: def.secretName,
    expectedUserId,
    channelIds: [],
    watchMemberships: true,
    allowedBotIds: [],
    pollIntervalMs: 5000,
  })
  const existingProfile = await readProfile(def.name)
  const preflight = planProfileWrite(
    existingProfile,
    intendedFor(existing?.id ?? '(created by this run)'),
    { replace: options.replaceProfile },
  )
  if (preflight.action === 'refuse') {
    throw new ProvisionError(`refusing to touch profile ${profilePath(def.name)}`, preflight.reason)
  }

  if (options.dryRun) {
    actions.push(`would ${decision.action} account ${def.username} (${decision.reason})`)
    actions.push(`would ${preflight.action} profile ${profilePath(def.name)} (${preflight.reason})`)
    return {
      record: {
        version: 1,
        name: def.name,
        serverUrl,
        connectionId: def.connectionId,
        userId: existing?.id ?? '(unknown until created)',
        username: def.username,
        email: def.email,
        displayLabel: def.displayLabel,
        accountType: existing?.is_bot ? 'bot' : 'user',
        roles: existing?.roles ?? '(unknown)',
        teamId,
        teamName: '(unresolved in dry run)',
        secretName: def.secretName,
        tokenId: null,
        tokenDigest: null,
        profilePath: profilePath(def.name),
        provisionedBy: { userId: operator.identity.id, username: operator.identity.username },
        createdAt: existingRecord?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: existingRecord?.steps ?? emptySteps(),
        incomplete: 'dry run — nothing was changed',
      },
      actions,
      warnings,
    }
  }

  // --- account -------------------------------------------------------------
  let user: MMUser
  if (decision.action === 'reuse') {
    user = existing as MMUser
    actions.push(`reused existing account ${user.username} (${user.id})`)
  } else {
    const emailOwner = await client.userByEmail(def.email)
    if (emailOwner.ok && emailOwner.data) {
      throw new ProvisionError(
        `refusing to provision ${def.name}`,
        `email ${def.email} already belongs to ${emailOwner.data.username} (${emailOwner.data.id})`,
      )
    }
    const created = await client.createUser({
      username: def.username,
      email: def.email,
      password: generatePassword(),
      nickname: def.displayLabel,
      first_name: def.displayLabel,
      position: def.position,
    })
    if (!created.ok || !created.data) {
      throw new ProvisionError(
        `native account creation for ${def.username} failed`,
        `POST /users answered HTTP ${created.status} ${created.body}`,
      )
    }
    user = created.data
    actions.push(`created account ${user.username} (${user.id})`)
  }

  if (/(^|\s)system_admin(\s|$)/.test(user.roles)) {
    throw new ProvisionError(
      `refusing to use ${user.username}`,
      `account holds system_admin (${user.roles}); agent identities must be ordinary users`,
    )
  }

  const record: ProvisioningRecord = {
    version: 1,
    name: def.name,
    serverUrl,
    connectionId: def.connectionId,
    userId: user.id,
    username: user.username,
    email: def.email,
    displayLabel: def.displayLabel,
    accountType: user.is_bot ? 'bot' : 'user',
    roles: user.roles,
    teamId,
    teamName: '',
    secretName: def.secretName,
    tokenId: existingRecord?.tokenId ?? null,
    tokenDigest: existingRecord?.tokenDigest ?? null,
    profilePath: profilePath(def.name),
    provisionedBy: { userId: operator.identity.id, username: operator.identity.username },
    createdAt: existingRecord?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: { ...emptySteps(), accountCreated: true },
    incomplete: 'provisioning in progress',
  }
  assertCredentialFree(record)
  await writeRecord(record)

  // --- display label -------------------------------------------------------
  if (decision.action === 'reuse' && (user.nickname !== def.displayLabel || user.position !== def.position)) {
    const patched = await client.patchUser(user.id, {
      nickname: def.displayLabel,
      first_name: def.displayLabel,
      position: def.position,
    })
    if (patched.ok) actions.push('refreshed display label')
    else warnings.push(`display label patch answered HTTP ${patched.status}`)
  }

  // --- team ----------------------------------------------------------------
  const team = await client.getTeam(teamId)
  if (!team.ok || !team.data) {
    throw new ProvisionError(`team ${teamId} not readable`, `GET /teams/${teamId} answered HTTP ${team.status}`)
  }
  record.teamName = team.data.name
  const member = await client.getTeamMember(teamId, user.id)
  if (member.ok) {
    actions.push(`already a member of team ${team.data.name} (roles: ${member.data?.roles})`)
  } else {
    const added = await client.addTeamMember(teamId, user.id)
    if (!added.ok) {
      record.incomplete = `account exists but is not in team ${teamId}: POST /teams/${teamId}/members answered HTTP ${added.status}`
      await writeRecord(record)
      throw new ProvisionError(
        `could not add ${user.username} to team ${teamId}`,
        `POST /teams/{team}/members answered HTTP ${added.status} ${added.body}`,
      )
    }
    actions.push(`joined team ${team.data.name} (roles: ${added.data?.roles})`)
  }
  record.steps.teamJoined = true
  record.updatedAt = new Date().toISOString()
  await writeRecord(record)

  // --- token ---------------------------------------------------------------
  const storeRead = await readSecretFromStore(def.secretName)
  const storedToken = storeRead.status === 'present' || storeRead.status === 'stale' ? storeRead.value : null
  const storedIdentity = storedToken ? (await tokenIdentity(serverUrl, storedToken)).userId : null
  const secretDecision = decideSecretAction({
    storeStatus: storeRead.status,
    storedIdentity,
    expectedUserId: user.id,
    rotate: options.rotate ?? false,
    reason: 'reason' in storeRead ? storeRead.reason : undefined,
  })
  if (secretDecision.action === 'refuse') {
    record.incomplete = `token step blocked: ${secretDecision.reason}`
    await writeRecord(record)
    throw new ProvisionError(`refusing to touch secret ${def.secretName}`, secretDecision.reason)
  }

  if (secretDecision.action === 'reuse' && storedToken) {
    record.tokenDigest = await digest(storedToken)
    record.steps.tokenIssued = true
    record.steps.secretWritten = true
    actions.push(`reused stored token in ${def.secretName} (${secretDecision.reason})`)
  } else {
    // Personal access tokens need the system_user_access_token role. That is a
    // token-issuing capability, NOT an admin grant.
    const roles = user.roles.split(/\s+/).filter(Boolean)
    if (!roles.includes('system_user_access_token')) {
      const next = [...roles, 'system_user_access_token'].join(' ')
      const granted = await client.setUserRoles(user.id, next)
      if (!granted.ok) {
        record.incomplete = `cannot grant system_user_access_token: HTTP ${granted.status}`
        await writeRecord(record)
        throw new ProvisionError(
          `cannot grant token capability to ${user.username}`,
          `PUT /users/{id}/roles answered HTTP ${granted.status} ${granted.body}`,
        )
      }
      record.roles = next
      actions.push(`granted role system_user_access_token (roles now: ${next})`)
    }
    record.steps.tokenRoleGranted = true
    await writeRecord(record)

    const minted = await client.createUserAccessToken(user.id, `mattermost-agents ${def.name} (${def.secretName})`)
    if (!minted.ok || !minted.data?.token) {
      record.incomplete = `token mint failed: HTTP ${minted.status}`
      await writeRecord(record)
      throw new ProvisionError(
        `cannot mint an access token for ${user.username}`,
        `POST /users/{id}/tokens answered HTTP ${minted.status} ${minted.body}`,
      )
    }
    const tokenValue = minted.data.token
    const tokenId = minted.data.id
    record.tokenId = tokenId
    record.tokenDigest = await digest(tokenValue)
    record.steps.tokenIssued = true
    await writeRecord(record)

    // Prove the credential before storing it: a token that does not
    // authenticate as this user must never reach the store.
    const proof = await tokenIdentity(serverUrl, tokenValue)
    if (proof.userId !== user.id) {
      await client.revokeUserAccessToken(tokenId)
      record.tokenId = null
      record.tokenDigest = null
      record.steps.tokenIssued = false
      record.incomplete = `minted token authenticated as ${proof.userId ?? 'nobody'}; revoked, nothing stored`
      await writeRecord(record)
      throw new ProvisionError(
        `minted token did not authenticate as ${user.username}`,
        `it answered as ${proof.userId ?? `HTTP ${proof.status}`}; the token was revoked`,
      )
    }

    const write = await writeSecret(def.secretName, tokenValue)
    if (write.outcome === 'failed') {
      // Nothing was stored: an unstored live credential is a liability, so it
      // goes away again and the run fails clean.
      const revoked = await client.revokeUserAccessToken(tokenId)
      record.tokenId = null
      record.tokenDigest = null
      record.steps.tokenIssued = false
      record.steps.secretWritten = false
      record.incomplete = `secret write failed (exit ${write.exitCode}); minted token ${revoked.ok ? 'revoked' : 'REVOKE FAILED — revoke by hand'}`
      await writeRecord(record)
      throw new ProvisionError(
        `could not store ${def.secretName}`,
        `${write.diagnostics}\n  minted token was ${revoked.ok ? 'revoked' : 'NOT revoked — revoke it manually'}`,
      )
    }
    if (write.outcome === 'unverified') {
      // Exit 4: the request left the host and no one here knows what happened.
      // Revoking would be the wrong move if the store does hold it.
      record.steps.secretWritten = 'unknown'
      record.incomplete = `secret write UNVERIFIED (exit 4) for ${def.secretName}: token ${tokenId} may or may not be stored. Do not assume failure and do not revoke: re-run \`provision ${def.name}\` (idempotent) and confirm with \`verify ${def.name}\`, which proves the identity without printing the value.`
      await writeRecord(record)
      warnings.push(record.incomplete)
    } else {
      record.steps.secretWritten = true
      actions.push(`stored new token in ${def.secretName} (${record.tokenDigest})`)
    }
  }

  // --- profile -------------------------------------------------------------
  // Re-plan against the profile as it is NOW and with the identity we ended
  // up with. "keep" is the common repeat-run answer, and keeping means the
  // file is not opened at all — an operator's second instance, narrowed
  // scope and custom stateDir survive every re-provision.
  const plan = planProfileWrite(await readProfile(def.name), intendedFor(user.id), { replace: options.replaceProfile })
  if (plan.action === 'refuse') {
    record.incomplete = `profile not written: ${plan.reason}`
    await writeRecord(record)
    throw new ProvisionError(`refusing to touch profile ${profilePath(def.name)}`, plan.reason)
  }
  if (plan.action === 'keep') {
    record.profilePath = profilePath(def.name)
    actions.push(`left profile ${profilePath(def.name)} unchanged (${plan.reason})`)
  } else {
    const profile = buildProfile({
      name: def.name,
      connectionId: def.connectionId,
      url: serverUrl,
      secretName: def.secretName,
      expectedUserId: user.id,
    })
    record.profilePath = await writeProfile(def.name, profile, def.connectionId)
    actions.push(`${plan.action === 'replace' ? 'replaced' : 'wrote'} profile ${record.profilePath}`)
  }
  record.steps.profileWritten = true
  // One authoritative re-read: roles, account type and the token capability
  // are all reported as the SERVER has them, never as this run assumed them.
  const fresh = (await client.userById(user.id)).data
  record.roles = fresh?.roles ?? record.roles
  record.accountType = fresh?.is_bot ? 'bot' : 'user'
  record.steps.tokenRoleGranted = /(^|\s)system_user_access_token(\s|$)/.test(record.roles)
  record.updatedAt = new Date().toISOString()
  if (record.steps.secretWritten === true) delete record.incomplete
  assertCredentialFree(record)
  await writeRecord(record)
  actions.push(`wrote record ${recordPath(def.name)}`)

  return { record, actions, warnings }
}

/**
 * End-to-end check that a provisioned identity is real: the stored secret
 * authenticates, it is the account the profile pins, and it is in the team.
 */
export async function verifyAgent(
  operator: Operator,
  def: AgentDefinition,
  teamIdOverride?: string,
): Promise<{ ok: boolean; findings: string[] }> {
  const teamId = requireTeamId(operator.config, teamIdOverride)
  const findings: string[] = []
  let ok = true
  const record = await readRecord(def.name)
  if (!record) {
    return { ok: false, findings: [`no provisioning record at ${recordPath(def.name)}`] }
  }
  const read = await readSecretFromStore(def.secretName)
  if (read.status === 'absent') {
    return { ok: false, findings: [`secret ${def.secretName} is positively absent from the store`] }
  }
  if (read.status === 'unknown') {
    return { ok: false, findings: [`secret ${def.secretName} could not be read authoritatively: ${read.reason}`] }
  }
  const token = read.value
  if (read.status === 'stale') {
    findings.push(`WARNING: value came from the local cache, not the store — ${read.reason}`)
  }
  const identity = await tokenIdentity(record.serverUrl, token)
  if (identity.userId !== record.userId) {
    ok = false
    findings.push(`stored token authenticates as ${identity.userId ?? `HTTP ${identity.status}`}, record says ${record.userId}`)
  } else {
    findings.push(`stored token authenticates as ${record.username} (${record.userId})`)
  }
  const asAgent = new OperatorClient(record.serverUrl, token)
  const self = await asAgent.whoami()
  if (self.ok && self.data) {
    findings.push(`server reports is_bot=${Boolean(self.data.is_bot)} roles="${self.data.roles}" auth_service="${self.data.auth_service ?? ''}"`)
    if (/(^|\s)system_admin(\s|$)/.test(self.data.roles)) {
      ok = false
      findings.push('ACCOUNT HOLDS system_admin — this must never be an agent identity')
    }
  }
  const teams = await asAgent.raw<{ id: string; name: string }[]>('GET', '/users/me/teams')
  const teamNames = (teams.data ?? []).map((t) => `${t.name}:${t.id}`)
  findings.push(`team memberships: ${teamNames.join(', ') || '(none)'}`)
  if (!(teams.data ?? []).some((t) => t.id === teamId)) {
    ok = false
    findings.push(`NOT a member of team ${teamId}`)
  }
  // Observers are the humans who must be able to see the agents work. None
  // configured means the operator did not ask for that assertion.
  for (const observer of operator.config.observerUserIds ?? []) {
    const member = await operator.client.getTeamMember(teamId, observer)
    findings.push(
      member.ok
        ? `observer ${observer} is a team member (roles: ${member.data?.roles})`
        : `observer ${observer} is NOT a member of ${teamId} (HTTP ${member.status})`,
    )
    if (!member.ok) ok = false
  }

  const profile = await readProfile(def.name)
  const conn = profile?.connections?.find((c) => c.id === def.connectionId)
  if (!conn) {
    ok = false
    findings.push(`profile ${profilePath(def.name)} missing or has no connection "${def.connectionId}"`)
  } else {
    if (conn.expectedUserId !== record.userId) {
      ok = false
      findings.push(`profile expectedUserId ${conn.expectedUserId} != ${record.userId}`)
    }
    if (conn.tokenSecret !== def.secretName || conn.tokenEnv !== def.secretName) {
      ok = false
      findings.push(`profile names secret ${conn.tokenEnv}/${conn.tokenSecret}, expected ${def.secretName}`)
    }
    findings.push(`profile ${profilePath(def.name)} pins ${conn.expectedUserId} via ${conn.tokenEnv} (watchMemberships=${conn.watchMemberships})`)
  }
  const storedDigest = await digest(token)
  if (record.tokenDigest && record.tokenDigest !== storedDigest) {
    findings.push(`WARNING: stored token ${storedDigest} differs from the recorded ${record.tokenDigest} (rotated outside this tool?)`)
  }
  return { ok, findings }
}

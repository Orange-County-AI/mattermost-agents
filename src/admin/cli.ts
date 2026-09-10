#!/usr/bin/env bun
/**
 * mattermost-agents operator CLI — administrative and human-run.
 *
 * It is NOT exposed through the ordinary agent MCP surface, and it ships no
 * production target: the server, the admin credential's secret NAME, the
 * team and any observer ids all come from an operator config file
 * (default ~/.config/mattermost-agents/operator.json, override with
 * --operator-config FILE or $MATTERMOST_AGENTS_OPERATOR_CONFIG). On a
 * single-user host the enforceable boundary is that credential, not this
 * file's permissions — protect the credential.
 *
 *   bun src/admin/cli.ts whoami                  who is the operator token
 *   bun src/admin/cli.ts probe [--team ID]       read-only capability probe
 *   bun src/admin/cli.ts provision <name> [...]  idempotent identity provisioning
 *   bun src/admin/cli.ts verify [name...]        prove the identity end to end
 *   bun src/admin/cli.ts agent-probe <name>      what that identity may do
 *   bun src/admin/cli.ts list                    provisioning records
 *   bun src/admin/cli.ts revoke <name>           revoke the recorded token
 *
 * Registration is generic: `provision <name> --username U --email E --label L
 * --secret NAME --connection-id ID [--team ID]` registers any identity. An
 * account this tool did not create is refused by default; `provision <name>
 * --adopt <user-id>` is the operator saying, explicitly, that the account with
 * that id IS this agent. A privileged (system_admin) account is still refused
 * unless that adoption also carries --allow-privileged, which lifts the
 * refusal and nothing else: no role is granted, removed or patched.
 *
 * No command prints a token, and no command takes one on the command line.
 */
import { OperatorClient } from './api'
import { loadOperatorConfig, operatorConfigPath, OperatorConfigError, type OperatorConfig } from './operator-config'
import { readProfile } from './profile'
import {
  defineAgent,
  ProvisionError,
  provisionAgent,
  provisionExitCode,
  requireTeamId,
  resolveOperator,
  tokenIdentity,
  verifyAgent,
  type AgentDefinition,
  type Operator,
} from './provision'
import { listRecords, readRecord, recordPath, writeRecord } from './record'
import { digest, readSecretFromStore, writeSecret, type StoreRead } from './secrets'

function flag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`)
}

function option(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

async function operatorFor(argv: string[]): Promise<Operator> {
  return resolveOperator(await loadOperatorConfig(option(argv, 'operator-config')))
}

/**
 * Assemble a definition: explicit flags first, then the `agents` shorthand in
 * the operator config, then the provisioning record of an earlier run. No
 * built-in identities exist, so a first run must supply the values.
 */
async function definitionFor(name: string, argv: string[] = [], config?: OperatorConfig): Promise<AgentDefinition> {
  const prior = await readRecord(name)
  const fromConfig = config?.agents?.[name]
  return defineAgent({
    name,
    username: option(argv, 'username') ?? fromConfig?.username ?? prior?.username,
    email: option(argv, 'email') ?? fromConfig?.email ?? prior?.email,
    displayLabel: option(argv, 'label') ?? fromConfig?.displayLabel ?? prior?.displayLabel,
    secretName: option(argv, 'secret') ?? fromConfig?.secretName ?? prior?.secretName,
    position: option(argv, 'position') ?? fromConfig?.position,
    connectionId: option(argv, 'connection-id') ?? fromConfig?.connectionId ?? prior?.connectionId,
  })
}

async function cmdWhoami(argv: string[]): Promise<void> {
  const operator = await operatorFor(argv)
  const me = operator.identity
  console.log(`config        ${operatorConfigPath(option(argv, 'operator-config'))}`)
  console.log(`server        ${operator.serverUrl}`)
  console.log(`token secret  ${operator.config.tokenSecret}`)
  console.log(`operator      ${me.username} (${me.id})`)
  console.log(`is_bot        ${Boolean(me.is_bot)}`)
  console.log(`roles         ${me.roles}`)
  const teams = await operator.client.getMyTeams()
  console.log(`teams         ${(teams.data ?? []).map((t) => `${t.name}:${t.id}`).join(', ') || '(none)'}`)
}


/**
 * Read-only probe of everything provisioning depends on. Run this before
 * provisioning and after: it answers "may this operator do it" and "did it".
 */
async function cmdProbe(argv: string[]): Promise<void> {
  const operator = await operatorFor(argv)
  const teamId = requireTeamId(operator.config, option(argv, 'team'))
  const { client } = operator
  console.log(`operator      ${operator.identity.username} (${operator.identity.id}) roles=${operator.identity.roles} is_bot=${Boolean(operator.identity.is_bot)}`)

  const cfg = await client.serverConfig()
  if (cfg.ok && cfg.data) {
    const s = cfg.data.ServiceSettings ?? {}
    const t = cfg.data.TeamSettings ?? {}
    const e = cfg.data.EmailSettings ?? {}
    console.log('--- server policy (admin /config) ---')
    console.log(`EnableUserAccessTokens        ${s.EnableUserAccessTokens}`)
    console.log(`EnableBotAccountCreation      ${s.EnableBotAccountCreation}`)
    console.log(`EnableOpenServer              ${t.EnableOpenServer}`)
    console.log(`EnableUserCreation            ${t.EnableUserCreation}`)
    console.log(`RestrictCreationToDomains     ${JSON.stringify(t.RestrictCreationToDomains ?? '')}`)
    console.log(`RequireEmailVerification      ${e.RequireEmailVerification}`)
    console.log(`EnableSignUpWithEmail         ${e.EnableSignUpWithEmail}`)
    console.log(`EnableSignUpWithGitLab        ${cfg.data.GitLabSettings?.Enable}`)
    // Note for operators: a bot-account admin credential may be refused
    // native bot creation (POST /bots -> 403) even when
    // EnableBotAccountCreation is true, because a bot session may not create
    // bots. That is when clearly-labelled service USERS are the honest path.
  } else {
    console.log(`--- admin /config unavailable: HTTP ${cfg.status} ${cfg.body} ---`)
  }

  const team = await client.getTeam(teamId)
  console.log('--- team ---')
  console.log(
    team.ok && team.data
      ? `${team.data.name} (${team.data.id}) type=${team.data.type} display="${team.data.display_name}"`
      : `team ${teamId} unreadable: HTTP ${team.status}`,
  )
  for (const observer of operator.config.observerUserIds ?? []) {
    const member = await client.getTeamMember(teamId, observer)
    console.log(member.ok ? `observer ${observer} member, roles=${member.data?.roles}` : `observer ${observer} NOT a member (HTTP ${member.status})`)
  }

  console.log('--- identities this operator has provisioned ---')
  for (const record of await listRecords()) {
    const byName = await client.userByUsername(record.username)
    const stored = await readSecretFromStore(record.secretName)
    console.log(
      `${record.name.padEnd(16)} account=${byName.ok && byName.data ? `${byName.data.id} is_bot=${Boolean(byName.data.is_bot)} roles="${byName.data.roles}"` : `absent (HTTP ${byName.status})`}`,
    )
    console.log(`${' '.repeat(16)} record=${recordPath(record.name)} secret ${record.secretName} store=${stored.status}`)
  }

  console.log('--- unprivileged role permissions (what a team_user/channel_user may do) ---')
  for (const roleName of ['system_user', 'team_user', 'channel_user']) {
    const role = await client.raw<{ name: string; permissions: string[] }>('GET', `/roles/name/${roleName}`)
    if (!role.ok || !role.data) {
      console.log(`${roleName}: unreadable (HTTP ${role.status})`)
      continue
    }
    const interesting = role.data.permissions.filter((p) =>
      /create_direct_channel|create_group_channel|create_private_channel|create_public_channel|join_public_channel|manage_private_channel_members|create_post|add_user_to_team/.test(p),
    )
    console.log(`${roleName}: ${interesting.join(', ') || '(none of interest)'}`)
  }
}

async function cmdProvision(argv: string[]): Promise<void> {
  const name = argv[0]
  if (!name) {
    throw new ProvisionError(
      'usage: provision <name> [--operator-config FILE] [--username U] [--email E] [--label L] [--secret NAME] [--connection-id ID] [--position P] [--team ID] [--adopt USER_ID [--allow-privileged]] [--dry-run] [--rotate] [--recreate] [--replace-profile]',
      'a first run must supply --username --email --label --secret --connection-id (or an "agents" entry in the operator config); later runs reuse the provisioning record',
    )
  }
  // `--adopt` without a value is not "adopt nothing": it is an operator who
  // meant to name an id, and silently provisioning past that is how the
  // wrong account gets bound.
  const adoptUserId = option(argv, 'adopt')
  if (flag(argv, 'adopt') && (!adoptUserId || adoptUserId.startsWith('--'))) {
    throw new ProvisionError(
      '--adopt needs the user id of the account to bind',
      'find it with `probe`, or with the id printed by the refusal that sent you here: --adopt <USER_ID>',
    )
  }
  // The privilege escape hatch is bound to adoption: on its own it would be a
  // standing licence to make an admin account into an agent identity.
  const allowPrivileged = flag(argv, 'allow-privileged')
  if (allowPrivileged && !adoptUserId) {
    throw new ProvisionError(
      'refusing --allow-privileged on its own',
      'it only lifts the system_admin refusal for an account you are adopting: pass --adopt <USER_ID> with it',
    )
  }
  const operator = await operatorFor(argv)
  const def = await definitionFor(name, argv, operator.config)
  const outcome = await provisionAgent(operator, def, {
    teamId: option(argv, 'team'),
    dryRun: flag(argv, 'dry-run'),
    rotate: flag(argv, 'rotate'),
    allowRecreate: flag(argv, 'recreate'),
    replaceProfile: flag(argv, 'replace-profile'),
    ...(adoptUserId ? { adoptUserId } : {}),
    ...(allowPrivileged ? { allowPrivileged } : {}),
  })
  for (const action of outcome.actions) console.log(`ok    ${action}`)
  for (const warning of outcome.warnings) console.log(`WARN  ${warning}`)
  const r = outcome.record
  console.log('---')
  console.log(`name          ${r.name}`)
  console.log(`user          ${r.username} (${r.userId})`)
  console.log(`accountType   ${r.accountType} (is_bot=${r.accountType === 'bot'})${r.adopted ? ' adopted — pre-existing account, not created here' : ''}`)
  console.log(`roles         ${r.roles}${r.allowPrivileged ? '  PRIVILEGED — accepted by the operator, never granted here' : ''}`)
  console.log(`team          ${r.teamName} (${r.teamId})`)
  console.log(`secret NAME   ${r.secretName}`)
  console.log(`profile       ${r.profilePath}`)
  console.log(`record        ${recordPath(r.name)}`)
  const code = provisionExitCode(r)
  if (code !== 0) {
    // Nothing is rolled back and nothing is assumed failed: the credential
    // may well be in the store. It is the CERTAINTY that is missing, and an
    // exit 0 here would tell automation the agent is ready.
    console.error(`status        UNVERIFIED (exit ${code}) — this agent is NOT known-provisioned`)
    console.error(`recover       bun src/admin/cli.ts verify ${r.name}   # proves the identity without printing anything secret`)
    console.error(`              then re-run: bun src/admin/cli.ts provision ${r.name}   (idempotent; reuses a token that is already stored)`)
    console.error(`              the token was NOT revoked; ${recordPath(r.name)} records the unknown state. Never echo the secret value.`)
    process.exitCode = code
  }
}

async function cmdVerify(argv: string[]): Promise<void> {
  // A flag's VALUE is not an agent name: skip the token after a value flag.
  const names: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string
    if (!arg.startsWith('--')) {
      names.push(arg)
      continue
    }
    if (['operator-config', 'team'].includes(arg.slice(2))) i += 1
  }
  const operator = await operatorFor(argv)
  let allOk = true
  // No names given: everything this operator has provisioned.
  const known = (await listRecords()).map((r) => r.name)
  if (names.length === 0 && known.length === 0) {
    throw new ProvisionError('nothing to verify', 'no provisioning records yet — pass a name, or provision one first')
  }
  for (const name of names.length > 0 ? names : known) {
    const { ok, findings } = await verifyAgent(operator, await definitionFor(name, argv, operator.config), option(argv, 'team'))
    console.log(`--- ${name}: ${ok ? 'OK' : 'FAILED'} ---`)
    for (const f of findings) console.log(`  ${f}`)
    allOk = allOk && ok
  }
  if (!allOk) process.exitCode = 1
}

/**
 * What can this identity actually do, asked with ITS OWN token: teams,
 * channels it is in, and the permissions its roles carry. Read-only — it
 * creates nothing and posts nowhere.
 */
async function cmdAgentProbe(argv: string[]): Promise<void> {
  const name = argv[0]
  if (!name) throw new ProvisionError('usage: agent-probe <name>')
  // Deliberately profile-only: this command needs NO operator credential, so
  // anyone holding the agent's own secret can check that identity.
  const profile = await readProfile(name)
  const conn = option(argv, 'connection')
    ? profile?.connections.find((c) => c.id === option(argv, 'connection'))
    : profile?.connections[0]
  if (!conn) throw new ProvisionError(`no profile connection for ${name}`, 'pass --connection <id> to pick one')
  const read = await readSecretFromStore(conn.tokenSecret)
  if (read.status === 'absent') throw new ProvisionError(`secret ${conn.tokenSecret} is absent from the store`)
  if (read.status === 'unknown') throw new ProvisionError(`secret ${conn.tokenSecret} could not be read`, read.reason)
  if (read.status === 'stale') console.log(`WARN  value served from the local cache, not the store — ${read.reason}`)
  const token = read.value
  const identity = await tokenIdentity(conn.url, token)
  if (identity.userId !== conn.expectedUserId) {
    throw new ProvisionError(
      `token identity mismatch`,
      `stored token is ${identity.userId ?? `HTTP ${identity.status}`}, profile expects ${conn.expectedUserId}`,
    )
  }
  const client = new OperatorClient(conn.url, token)
  const me = (await client.whoami()).data
  console.log(`identity      ${me?.username} (${me?.id}) is_bot=${Boolean(me?.is_bot)} roles="${me?.roles}"`)
  const teams = await client.getMyTeams()
  console.log(`teams         ${(teams.data ?? []).map((t) => `${t.name}:${t.id}:${t.type}`).join(', ') || '(none)'}`)
  const channels = await client.getMyChannels()
  console.log(`channels      ${(channels.data ?? []).map((c) => `${c.name}(${c.type})`).join(', ') || '(none)'}`)
  for (const team of teams.data ?? []) {
    const member = await client.raw<{ roles: string }>('GET', `/teams/${team.id}/members/${me?.id}`)
    console.log(`team ${team.name} roles=${member.data?.roles ?? `HTTP ${member.status}`}`)
  }
  // Read-only capability question: which channels of each team it can see.
  // Everything here is a GET; nothing is created and nothing is posted.
  for (const team of teams.data ?? []) {
    const visible = await client.raw<unknown[]>('GET', `/users/me/teams/${team.id}/channels`)
    console.log(`GET /users/me/teams/${team.id}/channels -> HTTP ${visible.status}`)
  }
  for (const observer of (option(argv, 'observer') ?? '').split(',').filter(Boolean)) {
    const seen = await client.raw<{ username: string }>('GET', `/users/${observer}`)
    console.log(`GET /users/${observer} -> HTTP ${seen.status} ${seen.data?.username ?? ''}`)
  }
}

async function cmdList(): Promise<void> {
  const records = await listRecords()
  if (records.length === 0) {
    console.log('(no provisioning records)')
    return
  }
  for (const r of records) {
    console.log(`${r.name}: ${r.username} (${r.userId}) type=${r.accountType}${r.adopted ? ' adopted' : ''}${r.allowPrivileged ? ` PRIVILEGED roles="${r.adoptedRoles ?? r.roles}"` : ''} team=${r.teamId} secret=${r.secretName}`)
    console.log(`  steps ${JSON.stringify(r.steps)}${r.incomplete ? ` incomplete: ${r.incomplete}` : ''}`)
  }
}

/** Recovery: revoke the recorded access token. The secret is left for `secret unset`. */
async function cmdRevoke(argv: string[]): Promise<void> {
  const name = argv[0]
  if (!name) throw new ProvisionError('usage: revoke <name>')
  const record = await readRecord(name)
  if (!record?.tokenId) throw new ProvisionError(`no recorded token id for ${name}`)
  const operator = await resolveOperator(await loadOperatorConfig(option(argv, 'operator-config')), record.serverUrl)
  const res = await operator.client.revokeUserAccessToken(record.tokenId)
  if (!res.ok) throw new ProvisionError(`revoke failed`, `POST /users/tokens/revoke answered HTTP ${res.status} ${res.body}`)
  record.tokenId = null
  record.tokenDigest = null
  record.steps.tokenIssued = false
  record.steps.secretWritten = false
  record.incomplete = `token revoked ${new Date().toISOString()}; secret ${record.secretName} still holds the dead value — \`secret unset ${record.secretName}\` or re-provision`
  record.updatedAt = new Date().toISOString()
  await writeRecord(record)
  console.log(`revoked token for ${name}; run: secret unset ${record.secretName}`)
}

interface MMSession {
  id: string
  user_id: string
  create_at: number
  last_activity_at: number
  expires_at: number
  device_id: string
  props: Record<string, string>
}

/**
 * Operator credential inventory — metadata and fingerprints only.
 *
 * Rotation needs one hard fact first: WHICH access token id the configured
 * credential actually is, and nothing here proves that.
 * Session timestamps are NOT probative: a personal access token reuses its
 * existing session, other consumers of this account run concurrently, and
 * Mattermost only refreshes last_activity_at coarsely. Treat this output as
 * candidates plus sharing evidence; the mapping is proved by
 * `rotate-operator`.
 */
async function cmdOperatorTokens(argv: string[]): Promise<void> {
  const operator = await operatorFor(argv)
  const secretName = operator.config.tokenSecret
  const me = operator.identity
  console.log(`operator      ${me.username} (${me.id}) roles=${me.roles} is_bot=${Boolean(me.is_bot)}`)

  const envValue = process.env[secretName] ?? null
  const storeRead = await readSecretFromStore(secretName)
  const storeValue = 'value' in storeRead ? storeRead.value : null
  const describe = async (read: StoreRead): Promise<string> =>
    'value' in read ? `${await digest(read.value)} (${read.status})` : `(${read.status}${'reason' in read ? `: ${read.reason}` : ''})`
  console.log('--- credential fingerprints (digests, never values) ---')
  console.log(`env   ${secretName}  ${envValue ? await digest(envValue) : '(unset)'}`)
  console.log(`store ${secretName}  ${await describe(storeRead)}`)
  console.log(`env and store agree: ${Boolean(envValue && storeValue && envValue === storeValue)}`)
  // Any other secret holding the SAME value is a sharing fact rotation must
  // know about: revoking one name breaks every consumer of the other.
  for (const other of argv.filter((a) => !a.startsWith('--'))) {
    const read = await readSecretFromStore(other)
    const same = 'value' in read && storeValue && read.value === storeValue ? '  <-- SAME VALUE' : ''
    console.log(`store ${other}  ${await describe(read)}${same}`)
  }

  const tokens = await operator.client.listUserAccessTokens(me.id)
  console.log('--- personal access tokens on this account ---')
  for (const t of tokens.data ?? []) {
    console.log(`${t.id}  active=${t.is_active}  "${t.description}"`)
  }
  if (!tokens.ok) console.log(`(token list unavailable: HTTP ${tokens.status} ${tokens.body})`)

  const sessions = await operator.client.raw<MMSession[]>('GET', `/users/${me.id}/sessions`)
  console.log('--- sessions (a PAT session names its token id; timestamps are NOT proof of which one is ours) ---')
  for (const s of (sessions.data ?? []).sort((a, b) => b.last_activity_at - a.last_activity_at)) {
    console.log(
      `token=${s.props?.user_access_token_id ?? '(not a PAT session)'} session=${s.id} created=${new Date(s.create_at).toISOString()} lastActivity=${new Date(s.last_activity_at).toISOString()}`,
    )
  }
  if (!sessions.ok) console.log(`(session list unavailable: HTTP ${sessions.status} ${sessions.body})`)
}

/**
 * Prove which access token id a credential IS, without disabling anything.
 *
 * A personal access token authenticates through a session, and `POST
 * /users/logout` revokes the session the request itself is using. So: list
 * sessions with a second credential, log out with the credential under test,
 * list again. The session that disappeared names the token id in its props.
 *
 * This is causal, not circumstantial — no timestamp is consulted — and it is
 * harmless: the token keeps working, Mattermost simply builds a fresh session
 * on its next request. That is why it is preferred over disabling a token
 * that other consumers might be using right now.
 */
async function proveTokenId(args: {
  serverUrl: string
  credential: string
  observer: OperatorClient
  userId: string
}): Promise<{ tokenId: string | null; reason: string }> {
  const before = await args.observer.raw<MMSession[]>('GET', `/users/${args.userId}/sessions`)
  if (!before.ok) return { tokenId: null, reason: `session list unavailable (HTTP ${before.status})` }
  const underTest = new OperatorClient(args.serverUrl, args.credential)
  const loggedOut = await underTest.raw<unknown>('POST', '/users/logout')
  if (!loggedOut.ok) return { tokenId: null, reason: `POST /users/logout answered HTTP ${loggedOut.status}` }
  const after = await args.observer.raw<MMSession[]>('GET', `/users/${args.userId}/sessions`)
  if (!after.ok) return { tokenId: null, reason: `second session list unavailable (HTTP ${after.status})` }

  const survivors = new Set((after.data ?? []).map((s) => s.id))
  const vanished = (before.data ?? []).filter((s) => !survivors.has(s.id))
  if (vanished.length !== 1) {
    return {
      tokenId: null,
      reason: `expected exactly one session to end, ${vanished.length} did — concurrent activity makes this inconclusive`,
    }
  }
  const tokenId = vanished[0]?.props?.user_access_token_id
  if (!tokenId) return { tokenId: null, reason: `the session that ended (${vanished[0]?.id}) is not backed by an access token` }
  return { tokenId, reason: `session ${vanished[0]?.id} ended with the credential's own logout and names token ${tokenId}` }
}

/**
 * The operator credential, or a hard stop. Absence, an outage and a cached
 * value are three different answers and none of them may be silently treated
 * as "carry on" when the next step mints or revokes something.
 */
async function requireStoredOperatorToken(secretName: string): Promise<string> {
  const read = await readSecretFromStore(secretName)
  if (read.status === 'present') return read.value
  if (read.status === 'absent') throw new ProvisionError(`${secretName} is absent from the store`)
  if (read.status === 'stale') {
    throw new ProvisionError(
      `${secretName} was served from the local cache, not the store`,
      `${read.reason} — a cached value is not proof of what the store holds; retry when the store is reachable`,
    )
  }
  throw new ProvisionError(`${secretName} could not be read authoritatively`, read.reason)
}

/**
 * The proof on its own, so an operator can see the mapping before deciding to
 * rotate. It mints nothing and revokes nothing; the only side effect is that
 * the credential's session is replaced by a fresh one.
 */
async function cmdProveOperatorToken(argv: string[]): Promise<void> {
  const operator = await operatorFor(argv)
  const secretName = operator.config.tokenSecret
  const current = await requireStoredOperatorToken(secretName)
  const proof = await proveTokenId({
    serverUrl: operator.serverUrl,
    credential: current,
    observer: operator.client,
    userId: operator.identity.id,
  })
  const after = await tokenIdentity(operator.serverUrl, current)
  console.log(`credential ${secretName} (${await digest(current)})`)
  console.log(proof.tokenId ? `token id   ${proof.tokenId}` : 'token id   UNPROVEN')
  console.log(`evidence   ${proof.reason}`)
  console.log(`still authenticates afterwards: ${after.userId ?? `no (HTTP ${after.status})`}`)
}

/**
 * Rotate the operator credential, proving the token id BEFORE destroying it.
 *
 * Order matters: mint the replacement first (escape hatch), prove the mapping
 * second, store third, revoke last. Anything that fails leaves a working
 * credential and says exactly what state the world is in.
 *
 * `--expect-token-id` is a cross-check, not an input: if the proof disagrees
 * with it, nothing is revoked.
 */
async function cmdRotateOperator(argv: string[]): Promise<void> {
  const expected = option(argv, 'expect-token-id')
  const operator = await operatorFor(argv)
  const secretName = operator.config.tokenSecret
  const current = await requireStoredOperatorToken(secretName)
  const me = operator.identity
  const currentIdentity = await tokenIdentity(operator.serverUrl, current)
  if (currentIdentity.userId !== me.id) {
    throw new ProvisionError(
      'the stored credential and the credential this process uses are different identities',
      `store=${currentIdentity.userId ?? `HTTP ${currentIdentity.status}`} process=${me.id}; resolve that before rotating`,
    )
  }

  const minted = await operator.client.createUserAccessToken(me.id, `mattermost-agents operator (rotated ${new Date().toISOString()})`)
  if (!minted.ok || !minted.data?.token) {
    throw new ProvisionError('could not mint a replacement operator token', `POST /users/{id}/tokens answered HTTP ${minted.status} ${minted.body}`)
  }
  const replacement = minted.data.token
  const replacementId = minted.data.id
  const replacementClient = new OperatorClient(operator.serverUrl, replacement)
  const replacementIdentity = await replacementClient.whoami()
  if (!replacementIdentity.ok || replacementIdentity.data?.id !== me.id) {
    await operator.client.revokeUserAccessToken(replacementId)
    throw new ProvisionError('replacement token did not authenticate as the operator', 'revoked; nothing stored, nothing revoked')
  }
  console.log(`ok    minted replacement ${replacementId} (${await digest(replacement)}) — escape hatch is live`)

  const proof = await proveTokenId({ serverUrl: operator.serverUrl, credential: current, observer: replacementClient, userId: me.id })
  if (!proof.tokenId) {
    await replacementClient.revokeUserAccessToken(replacementId)
    throw new ProvisionError(
      `could not prove which token id ${secretName} is`,
      `${proof.reason}. Replacement revoked; NOTHING was rotated or revoked. Retry when the account is quiet, or rotate by hand.`,
    )
  }
  const provenId = proof.tokenId
  if (provenId === replacementId) {
    await replacementClient.revokeUserAccessToken(replacementId)
    throw new ProvisionError('the proof named the replacement token', 'this should be impossible; replacement revoked, nothing else touched')
  }
  if (expected && expected !== provenId) {
    await replacementClient.revokeUserAccessToken(replacementId)
    throw new ProvisionError(
      `the proof disagrees with --expect-token-id`,
      `proved ${provenId}, you expected ${expected}. Replacement revoked; nothing revoked or rotated.`,
    )
  }
  // The credential must still work: the proof is a session end, not a lockout.
  const stillAlive = await tokenIdentity(operator.serverUrl, current)
  console.log(`ok    proved ${secretName} is token ${provenId} — ${proof.reason}`)
  console.log(`ok    credential still authenticates after the proof (${stillAlive.userId ?? `HTTP ${stillAlive.status}`})`)

  const write = await writeSecret(secretName, replacement)
  if (write.outcome === 'unverified') {
    throw new ProvisionError(
      `secret write UNVERIFIED (exit 4) for ${secretName}`,
      `the store may or may not hold replacement ${replacementId}. Exposed token ${provenId} was NOT revoked and still works. Re-run \`rotate-operator\` once the store is reachable; check with \`prove-operator-token\`, which prints digests only — never echo the value.`,
    )
  }
  if (write.outcome === 'failed') {
    const revoked = await replacementClient.revokeUserAccessToken(replacementId)
    throw new ProvisionError(
      `could not store ${secretName}`,
      `${write.diagnostics}\n  replacement ${revoked.ok ? 'revoked' : 'NOT revoked — revoke it manually'}; exposed token ${provenId} left ACTIVE (still exposed)`,
    )
  }

  const storedRead = await readSecretFromStore(secretName)
  const stored = storedRead.status === 'present' ? storedRead.value : null
  const storedIdentity = stored ? await tokenIdentity(operator.serverUrl, stored) : { userId: null, status: 0 }
  if (!stored || storedIdentity.userId !== me.id) {
    throw new ProvisionError(
      'the store does not serve a credential that authenticates as the operator',
      `nothing revoked; exposed token ${provenId} still works`,
    )
  }
  console.log(`ok    store serves ${await digest(stored)} and it authenticates as ${me.username} (${me.id})`)

  const revoked = await replacementClient.revokeUserAccessToken(provenId)
  if (!revoked.ok) {
    throw new ProvisionError(
      'replacement is stored and live, but the exposed token was NOT revoked',
      `POST /users/tokens/revoke answered HTTP ${revoked.status} ${revoked.body} — revoke ${provenId} by hand.`,
    )
  }
  console.log(`ok    revoked exposed token ${provenId}`)
  console.log(`note  the exposed value is dead, but every process that already exported ${secretName}`)
  console.log(`      still holds it and \`secret\` resolves the environment first. Run operator commands as:`)
  console.log(`      env -u ${secretName} bun src/admin/cli.ts whoami`)
  console.log(`      and restart anything long-running that inherited it.`)
}

const [command = 'help', ...rest] = process.argv.slice(2)
try {
  switch (command) {
    case 'whoami':
      await cmdWhoami(rest)
      break
    case 'probe':
      await cmdProbe(rest)
      break
    case 'provision':
      await cmdProvision(rest)
      break
    case 'verify':
      await cmdVerify(rest)
      break
    case 'agent-probe':
      await cmdAgentProbe(rest)
      break
    case 'list':
      await cmdList()
      break
    case 'revoke':
      await cmdRevoke(rest)
      break
    case 'operator-tokens':
      await cmdOperatorTokens(rest)
      break
    case 'prove-operator-token':
      await cmdProveOperatorToken(rest)
      break
    case 'rotate-operator':
      await cmdRotateOperator(rest)
      break
    default:
      console.log(
        [
          'mattermost-agents operator CLI — administrative; requires an operator credential.',
          'Not exposed through the ordinary agent MCP surface.',
          '',
          '  Every command reads an operator config for the server, the admin',
          '  token secret NAME, and optionally a team and observer user ids:',
          '    --operator-config FILE | $MATTERMOST_AGENTS_OPERATOR_CONFIG',
          `    default: ${operatorConfigPath()}`,
          '',
          '  whoami                 identify the operator credential',
          '  probe [--team ID]      read-only capability + policy probe',
          '  provision <name> [--username U] [--email E] [--label L] [--secret NAME]',
          '                   [--connection-id ID] [--position P] [--team ID] [--dry-run]',
          '                   [--rotate] [--recreate] [--replace-profile]',
          '                   [--adopt USER_ID [--allow-privileged]]',
          '  verify [name...] [--team ID]   prove stored token, profile and membership agree',
          '  agent-probe <name> [--connection ID] [--observer ID,ID]',
          '                         what that identity can see (needs only ITS secret,',
          '                         no operator config, no admin credential)',
          '  list                   provisioning records (credential-free)',
          '  revoke <name>          revoke the recorded access token',
          '  operator-tokens [SECRET_NAME...]  operator PAT inventory + digest comparison',
          '  prove-operator-token   prove which token id the operator credential is (no changes)',
          '  rotate-operator [--expect-token-id <id>]   proves the mapping, then rotates',
          '',
          '  There are no built-in identities: a first `provision` supplies',
          '  --username --email --label --secret --connection-id, and later runs',
          '  reuse the provisioning record. An existing account this tool did not',
          '  create is refused; --adopt <user-id> binds it deliberately, once,',
          '  and --adopt … --allow-privileged accepts one that holds system_admin',
          '  without ever granting, removing or patching a role.',
          '  Exit codes: 0 ok, 2 refusal, 4 unverified secret write',
          '  (NOT known-provisioned).',
        ].join('\n'),
      )
  }
} catch (err) {
  if (err instanceof ProvisionError || err instanceof OperatorConfigError) {
    console.error(`error: ${err.message}`)
    process.exit(2)
  }
  throw err
}

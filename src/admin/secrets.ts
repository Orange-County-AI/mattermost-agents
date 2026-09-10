/**
 * `secret` CLI wrapper for the operator process.
 *
 * Rules this encodes (see the `secrets` skill):
 *   - environment first, then the CLI: an interactive titan shell already
 *     exports every name, and an unconditional CLI call there fails while the
 *     value is right there in the environment;
 *   - a value NEVER reaches argv — `secret set NAME` takes the value on stdin
 *     only, so it stays out of /proc/<pid>/cmdline and shell history;
 *   - the CLI is called by absolute path with an explicit OP_VAULT, because a
 *     bare `secret` in a non-interactive environment silently degrades to the
 *     local cache while reporting an outage;
 *   - exit 4 is UNVERIFIED, not failure: the request left the host and nothing
 *     here knows what the far end did. Callers must treat it as unknown.
 */
/**
 * Absolute path, resolved per call so a test (or a recovery shell) can point
 * at a different binary. A bare `secret` in a non-interactive environment
 * silently skips 1Password and serves the cache while reporting an outage.
 */
function secretBin(): string {
  return process.env.SECRET_BIN ?? `${process.env.HOME}/.local/bin/secret`
}

function secretEnv(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    OP_VAULT: process.env.OP_VAULT ?? 'titan',
  }
}

export type SecretWriteOutcome = 'written' | 'unverified' | 'failed'

export interface SecretWriteResult {
  outcome: SecretWriteOutcome
  exitCode: number
  /** stderr of the CLI: diagnostics only, the CLI keeps values off it. */
  diagnostics: string
}

/**
 * Read one secret. Environment first, then the CLI. Returns null when the name
 * resolves nowhere — a miss is an answer, not an error.
 */
export async function readSecret(name: string): Promise<string | null> {
  const fromEnv = process.env[name]
  if (fromEnv) return fromEnv
  const proc = Bun.spawn([secretBin(), name], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: secretEnv(),
  })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) return null
  const value = out.trim()
  return value.length > 0 ? value : null
}

/**
 * What the STORE says about a name.
 *
 * The distinction is load-bearing. A failed read is NOT absence: an outage,
 * an expired service-account token or a broker 500 all exit nonzero, and
 * collapsing them into "not there" is how provisioning mints a second
 * credential for an identity that already has one, or overwrites a value it
 * never saw. Absence is only ever established positively, by an authoritative
 * `secret list` that answers and does not contain the name.
 *
 * `stale` is the cache case: `secret` serves a cached value when the
 * authority was unreachable and says so on stderr. That value is evidence
 * about the past, never proof of what the store holds now.
 */
export type StoreRead =
  | { status: 'present'; value: string }
  | { status: 'stale'; value: string; reason: string }
  | { status: 'absent' }
  | { status: 'unknown'; reason: string }

/** `secret` keeps values off stderr; belt and braces, token-shaped runs go too. */
function safeDiagnostics(text: string): string {
  return text.replace(/[a-z0-9]{26,}/g, '<redacted>').trim().slice(0, 500)
}

async function runSecret(args: string[], name?: string): Promise<{ code: number; out: string; err: string }> {
  const env = secretEnv()
  // Bypass the environment tier: this must report the STORE, not the shell
  // this process happened to inherit.
  if (name) delete env[name]
  const proc = Bun.spawn([secretBin(), ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

/**
 * Read what the store holds for one name, reporting uncertainty as
 * uncertainty. Callers must never mint or overwrite on anything but `absent`.
 */
export async function readSecretFromStore(name: string): Promise<StoreRead> {
  const read = await runSecret([name], name)
  const value = read.out.trim()
  if (read.code === 0 && value.length > 0) {
    // "served X from the local cache (…)" — the authority never answered.
    const cached = /from the local cache/i.test(read.err)
    return cached
      ? { status: 'stale', value, reason: safeDiagnostics(read.err) }
      : { status: 'present', value }
  }
  if (read.code === 0) {
    return { status: 'unknown', reason: `secret ${name} exited 0 with no value` }
  }

  // A failed read decides nothing. Ask the authoritative index.
  const list = await runSecret(['list'])
  if (list.code !== 0) {
    return {
      status: 'unknown',
      reason: `secret ${name} exited ${read.code} and \`secret list\` exited ${list.code} — the store did not answer, so absence is NOT established: ${safeDiagnostics(list.err) || safeDiagnostics(read.err)}`,
    }
  }
  const names = list.out.split('\n').map((line) => line.trim())
  if (names.includes(name)) {
    return {
      status: 'unknown',
      reason: `\`secret list\` contains ${name} but reading it exited ${read.code}: ${safeDiagnostics(read.err)}`,
    }
  }
  return { status: 'absent' }
}

/**
 * Write a secret, value on stdin only.
 *
 * `secret set` reads the value back through the ordinary read path before it
 * reports success, so exit 0 already means "the store holds this". Exit 4 is
 * the one outcome a caller must not collapse into failure.
 */
export async function writeSecret(name: string, value: string): Promise<SecretWriteResult> {
  if (value.length === 0) throw new Error(`refusing to write empty secret ${name}`)
  const proc = Bun.spawn([secretBin(), 'set', name], {
    stdin: new TextEncoder().encode(value),
    stdout: 'pipe',
    stderr: 'pipe',
    env: secretEnv(),
  })
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  const diagnostics = err.trim().slice(0, 2000)
  if (code === 0) return { outcome: 'written', exitCode: code, diagnostics }
  if (code === 4) return { outcome: 'unverified', exitCode: code, diagnostics }
  return { outcome: 'failed', exitCode: code, diagnostics }
}

/** sha256 prefix of a credential — provable identity of a value, never the value. */
export async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `sha256:${hex.slice(0, 12)}`
}

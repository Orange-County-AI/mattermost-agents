/**
 * Exit-status contract for the operator CLI.
 *
 * Automation reads exit codes, not prose. The one that matters is the
 * UNVERIFIED secret write: the account and token are fine and nothing is
 * rolled back, but nobody knows whether the store holds the credential, so
 * the run MUST NOT look like success.
 *
 * The subprocess cases below reach no network — they fail in argument
 * validation and in the dispatcher — so this file is safe to run anywhere.
 */
import { describe, expect, test } from 'bun:test'
import { EXIT_UNVERIFIED, provisionExitCode } from './provision'
import type { ProvisioningRecord } from './record'

const steps = (secretWritten: ProvisioningRecord['steps']['secretWritten']): ProvisioningRecord =>
  ({
    steps: {
      accountCreated: true,
      teamJoined: true,
      tokenRoleGranted: true,
      tokenIssued: true,
      secretWritten,
      profileWritten: true,
    },
  }) as ProvisioningRecord

describe('provisionExitCode', () => {
  test('an unverified secret write is not success', () => {
    expect(provisionExitCode(steps('unknown'))).toBe(EXIT_UNVERIFIED)
  })

  test('a verified write is success', () => {
    expect(provisionExitCode(steps(true))).toBe(0)
  })
})

describe('cli process exit codes', () => {
  const run = async (args: string[]): Promise<number> => {
    const proc = Bun.spawn(['bun', 'src/admin/cli.ts', ...args], {
      cwd: new URL('../..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
      // No operator config: every administrative command must refuse rather
      // than fall back to some built-in installation.
      env: { ...process.env, MATTERMOST_AGENTS_OPERATOR_CONFIG: '/nonexistent/operator.json' },
    })
    return proc.exited
  }

  test('help exits 0', async () => {
    expect(await run([])).toBe(0)
  })

  test('a bad invocation exits 2, not the unverified status', async () => {
    // No name: refused in argument validation, before any config or network.
    expect(await run(['provision'])).toBe(2)
  })

  test('a missing operator config exits 2 instead of targeting anything', async () => {
    expect(await run(['whoami'])).toBe(2)
  })
})

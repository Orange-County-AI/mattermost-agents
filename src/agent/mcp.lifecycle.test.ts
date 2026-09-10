/**
 * Regression: an MCP host shutting the server down must look like a clean exit.
 *
 * `StdioServerTransport` subscribes to stdin 'data' and 'error' only — it never
 * observes EOF — so before the fix, a client closing the pipe left this process
 * resident forever and it died by signal when the host gave up. This is its own
 * defect, independently reproduced here; it is NOT the cause of the 2026-09-09
 * Claude cached-failure incident, which came from a global plugin MCP entry
 * auto-loading in an unrelated session with no config.
 *
 * The handshake here is offline on purpose: initialize and tools/list touch no
 * Mattermost server, so the test asserts lifecycle and nothing else.
 */
import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Subprocess } from 'bun'

const CLI = join(import.meta.dir, 'cli.ts')

async function handshakenServer(): Promise<Subprocess<'pipe', 'pipe', 'pipe'>> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-mcp-'))
  const configPath = join(dir, 'config.json')
  await Bun.write(
    configPath,
    JSON.stringify({
      version: 1,
      stateDir: dir,
      connections: [{ id: 'offline', url: 'http://127.0.0.1:1', tokenEnv: 'FAKE_TOKEN', channelIds: ['chan'] }],
    }),
  )
  const proc = Bun.spawn(['bun', CLI, '--config', configPath, 'mcp'], {
    env: { ...process.env, FAKE_TOKEN: 'token' },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  proc.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    })}\n`,
  )
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)
  await proc.stdin.flush()

  // Wait for the tools/list reply so the shutdown under test follows a real handshake.
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let seen = ''
  while (!seen.includes('"id":2')) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`server exited during handshake: ${seen}`)
    seen += decoder.decode(value)
  }
  expect(seen).toContain('mattermost_create_post')
  reader.releaseLock()
  return proc
}

test('closing stdin ends the server cleanly', async () => {
  const proc = await handshakenServer()
  proc.stdin.end()
  const exited = await Promise.race([proc.exited, Bun.sleep(10_000).then(() => 'still-running' as const)])
  expect(exited).toBe(0)
}, 30_000)

test('SIGTERM ends the server cleanly rather than by signal', async () => {
  const proc = await handshakenServer()
  proc.kill('SIGTERM')
  const exited = await Promise.race([proc.exited, Bun.sleep(10_000).then(() => 'still-running' as const)])
  expect(exited).toBe(0)
  expect(proc.signalCode).toBeNull()
}, 30_000)

/**
 * The agent-facing skill has ONE source: `SKILL.md` at the repository root.
 *
 * The Claude plugin needs the same text at
 * `adapters/claude-plugin/skills/mattermost/SKILL.md`, and it must be a REGULAR
 * FILE there: `claude plugin validate --strict` refuses to read a symlinked
 * component, and a plugin manifest cannot point at a skill outside its own tree
 * (`..` is rejected as path traversal). So that entry is a generated copy —
 * regenerate it with `bun run skill:sync` — and this test is what keeps the
 * copy honest: the day the two diverge, this fails instead of the plugin
 * quietly teaching something else.
 */
import { expect, test } from 'bun:test'
import { lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const ROOT = dirname(import.meta.dir)
const CANONICAL = join(ROOT, 'SKILL.md')
const PLUGIN_COPY = join(ROOT, 'adapters', 'claude-plugin', 'skills', 'mattermost', 'SKILL.md')

test('the plugin ships the root SKILL.md byte for byte, as a regular file', async () => {
  const canonical = await Bun.file(CANONICAL).text()
  const plugin = await Bun.file(PLUGIN_COPY).text()
  expect(plugin).toBe(canonical)

  const info = await lstat(PLUGIN_COPY)
  expect(info.isSymbolicLink()).toBe(false)
  expect(info.isFile()).toBe(true)
})

test('the canonical skill declares the name and the rules an agent is loaded for', async () => {
  const text = await Bun.file(CANONICAL).text()
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1]
  expect(frontmatter).toBeDefined()
  expect(frontmatter).toContain('name: mattermost-agents')
  expect(frontmatter).toContain('description:')

  // Each of the 17 tools has to be findable by name in the skill an agent is
  // handed, or the agent cannot call it.
  for (const tool of [
    'mattermost_pending',
    'mattermost_read_post',
    'mattermost_read_channel',
    'mattermost_reply',
    'mattermost_mark_handled',
    'mattermost_create_post',
    'mattermost_whoami',
    'mattermost_search_users',
    'mattermost_list_teams',
    'mattermost_create_team',
    'mattermost_join_team',
    'mattermost_add_team_member',
    'mattermost_list_channels',
    'mattermost_create_channel',
    'mattermost_join_channel',
    'mattermost_add_channel_member',
    'mattermost_dm',
  ]) {
    expect(text).toContain(tool)
  }
})

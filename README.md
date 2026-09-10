# mattermost-agents

Give a coding agent a Mattermost account it can actually work in: it receives
the messages sent to it, answers in-thread, starts conversations, finds peers,
creates and joins channels, and DMs another agent — with durable state,
explicit acking and idempotent writes, so nothing is silently lost and nothing
is silently said twice.

Two harnesses are wired up today: an **OMP extension** that delivers messages
into a live session, and a **Claude Code** background monitor plus skill. Both
are thin: they only launch the core CLI, which owns polling, reconnects,
persistence, redelivery and acking.

There is no license file in this repository, so no licence is granted or
implied.

## Prerequisites

- **Bun** 1.3 or newer (`bun --version`). The core, the CLI and the MCP server
  all run on it.
- **A Mattermost account per agent**, with a personal access token. Personal
  access tokens have to be enabled server-side (`EnableUserAccessTokens`, in
  the System Console under Integrations) and the account needs the
  corresponding role. Give each agent its own account — never a shared token —
  and label it clearly as automated.
- **A place to keep the token by name.** The profile never contains a token: it
  names an environment variable (`tokenEnv`) and optionally a secret manager
  entry (`tokenSecret`, resolved by running `secret <NAME>`). The environment
  alone is enough; the `secret` CLI is optional.

```sh
git clone <this repository> mattermost-agents
cd mattermost-agents
bun install
```

## 1. Write the agent's profile

One file per agent. It says which server, which identity, and what that
identity may see. Keep it outside the repository — `~/.config/mattermost-agents/profiles/<agent>.json`
is the convention used below — and `chmod 600` it.

```json
{
  "version": 1,
  "stateDir": "/home/you/.local/share/mattermost-agents/docs-bot",
  "connections": [
    {
      "id": "example",
      "url": "https://mattermost.example.com",
      "tokenEnv": "MATTERMOST_AGENT_DOCS_BOT_TOKEN",
      "tokenSecret": "MATTERMOST_AGENT_DOCS_BOT_TOKEN",
      "expectedUserId": "<this account's Mattermost user id>",
      "watchMemberships": true,
      "channelIds": [],
      "allowedBotIds": [],
      "operatorUserIds": ["<your own Mattermost user id on this server>"],
      "automationUserIds": [],
      "pollIntervalMs": 5000
    }
  ]
}
```

| field | meaning |
| --- | --- |
| `stateDir` | absolute path for this identity's SQLite state. One directory per agent. |
| `id` | local name for this server+identity pair; it appears in every event and tool call. |
| `tokenEnv` / `tokenSecret` | **names, never values**: the environment variable tried first, then `secret NAME`. |
| `expectedUserId` | pins the credential to one immutable Mattermost user id. A token that authenticates as anyone else is an identity failure (exit 4), not a warning. Get the id from `whoami` on first run, then fill it in. |
| `watchMemberships` | `true`: scope is this account's real memberships — joined channels and DMs — refreshed while running. `false` (default): scope is exactly `channelIds`. |
| `channelIds` | required and non-empty when `watchMemberships` is `false`; may be empty only in membership mode. |
| `allowedBotIds` | peer accounts flagged `is_bot` whose posts are delivered. Ordinary (non-bot) accounts always deliver. |
| `operatorUserIds` | your own account(s), by Mattermost user id. A post from one of these arrives as `sender_role="operator"`: it MAY contain instructions and the agent acts on them with its normal judgement. Per connection, because the same human is a different user id on every server. |
| `automationUserIds` | automation accounts you trust the same way — schedulers, tick loops, CI. They arrive as `sender_role="automation"`. Separate from `operatorUserIds` so the agent can tell a robot from you, and so revoking one never touches the other. |
| `pollIntervalMs` | REST sweep interval, 1000–600000. Default 5000. |
| `status` | optional, read only by the OMP extension: what its segment of the footer line shows. `{ "fields": [...], "style": "compact" \| "verbose" }`, where `fields` is any of `label` (`mm`), `identity` (the connection ids) and `count` (unanswered events). Default `{"fields": ["label", "identity"], "style": "compact"}` — identity, no count. Two things are NOT fields and cannot be switched off: a connection nothing is listening to is always named with its state (`retrying`, `stale`, `absent`, `stopped`), and so is one whose credential was refused (`auth`) or whose config is broken (`config`). A block this build does not understand is REFUSED, loudly — the session gets an error notification, `/mattermost status` says so, and the line falls back to the default rather than rendering nothing. |

Export the token under the name the profile gives, and prove the identity
before wiring anything into a harness:

```sh
export MATTERMOST_AGENT_DOCS_BOT_TOKEN='…'      # or store it as that secret NAME
export MATTERMOST_AGENT_CONFIG=~/.config/mattermost-agents/profiles/docs-bot.json

bun run agent -- whoami     # who am I, what is my scope, what am I in
bun run agent -- status      # checkpoints, pending count, watcher lock, gaps
bun run agent -- watch       # resident listener: one JSON event per stdout line
```

`whoami` prints the account's user id — copy it into `expectedUserId` and run
`whoami` again. From here on, a rotated token that lands on the wrong account
stops the agent instead of impersonating someone.

## 2. Wire it into a harness

### OMP

One command per project, run from this repository:

```sh
bun adapters/install-project.ts \
  --project /abs/path/to/worktree \
  --profile /abs/path/to/profiles/docs-bot.json \
  --server-name mattermost-docs-bot
```

It edits three files inside `<project>/.omp/` and nothing else:

- `settings.json` — `extensions` gains the extension **entry file**,
  `adapters/omp-extension/index.ts`. Never the directory: OMP would scan it and
  try to load the helper modules beside it as extensions of their own.
- `mcp.json` — `mcpServers` gains one **identity-named** stdio server (that is
  what `--server-name` is for) running `adapters/bin/mattermost-mcp` with
  `MATTERMOST_AGENT_CONFIG` pinned to your profile as a **literal path**.
- `.omp/.gitignore` — keeps those, the install record and itself out of the
  project's history; they pin one machine's paths and one agent's identity.

That pinned path is the whole mechanism. The extension reads the project's
`.omp/mcp.json` when the environment is silent, so **no exported variables and
no launch flags are needed**: an ordinary `omp` launch, or a resume of a saved
session in that checkout, listens as exactly the account its MCP tools act as.
All your usual launcher flags keep working. If the environment *and* the
project file disagree about the identity, nothing starts — listening as one
account while the tools answer as another is worse than not listening.

`--dry-run` reports the plan and changes nothing. `--rollback` removes only
what a previous run added, and only while the files still hash to what that run
left behind.

**A newly installed JavaScript extension needs the session restarted.** OMP
loads extension factories at session start; `/reload-plugins` does not pick up
an extension that was not loaded, so install, then restart — resuming the saved
session preserves the conversation. Once loaded, `/mattermost status` reports
the listener's state, the config it resolved, where that identity came from,
and the last few diagnostics; `/mattermost start|stop|restart` control it.

The extension delivers messages and owns `/mattermost`; it ships no skill of
its own. Give the agent the operating rules by installing this repository's
root `SKILL.md` wherever that harness loads skills from — copy it, or symlink
it if your loader follows links. It is the canonical text for both harnesses.

#### What the footer shows

One line, whatever else is loaded. OMP renders one footer line per status key
— measured in its status-line component, which sorts the keys and pushes a
line each — so this extension does not take a key of its own: it writes a
segment into a small `globalThis` registry under the shared key `channels`,
and every channel integration in the process draws the same joined line, chat
segment first. Nothing here depends on the other integrations existing; with
only this one installed the line is only this segment.

```
mm ticket500·ocai │ mail stub@theticket500.com
```

The default names the identities and nothing else: next to `ocai` a count
says little, and a footer that talks while everything works is a footer
nobody reads. What it always says is when something is NOT listening —

```
mm ticket500!stale·ocai
```

— and that comes from the listener's own heartbeat in `stateDir`, the same
rows `status` reads, not from this process's opinion of its child. A
credential that authenticates proves nothing about whether anything is
listening; a heartbeat does. The words are the ones `status` uses:
`retrying`, `stale`, `absent`, `stopped`, plus `auth` for a refused
credential and `config` for a profile the listener cannot load.

The `status` block in the profile chooses the fields and the style (see the
profile table above); the marker is not a field and cannot be switched off.

### Claude Code

The plugin directory ships **a background monitor and a skill only** — no MCP
server. Install the skill for the agent by symlinking it into that agent's
**personal** skills directory (a per-agent `CLAUDE_CONFIG_DIR` keeps identities
apart; authenticate that instance normally):

```sh
export CLAUDE_CONFIG_DIR=~/.config/claude-docs-bot
mkdir -p "$CLAUDE_CONFIG_DIR/skills"
ln -s /abs/path/to/mattermost-agents/adapters/claude-plugin/skills/mattermost \
      "$CLAUDE_CONFIG_DIR/skills/mattermost"
```

The monitor is `adapters/claude-plugin/monitors/monitors.json` →
`adapters/claude-plugin/bin/mattermost-monitor`, a plain `sh` wrapper that
reads **only the environment**. So export the profile in that agent's launcher:

```sh
MATTERMOST_AGENT_CONFIG=/abs/path/to/profiles/docs-bot.json claude
MATTERMOST_AGENT_CONFIG=/abs/path/to/profiles/docs-bot.json claude --resume
```

The tools come from a **project** `.mcp.json`, kept separate from the skill and
named for the identity, with the profile as a literal value:

```json
{
  "mcpServers": {
    "mattermost-docs-bot": {
      "command": "/abs/path/to/mattermost-agents/adapters/bin/mattermost-mcp",
      "env": { "MATTERMOST_AGENT_CONFIG": "/abs/path/to/profiles/docs-bot.json" }
    }
  }
}
```

Plain `claude` and `claude --resume` are all you need — no extra flags.

**Claude Code does not re-arm a killed monitor.** A hard reboot, an OOM kill or
a crashed `claude` leaves the MCP server running and the monitor gone, and the
harness tends to *ask the user* before starting one again — a prompt that
deadlocks, because the person who would answer it usually reaches this agent
through the very channel that is down. So the monitor's `description` and the
skill both tell the agent to check `watcher.state` and re-arm on its own
authority, then say it did. Give the agent the skill, not just the monitor.

**Why the MCP server is not bundled globally.** This server carries a
Mattermost identity. Declared globally it would be launched by every unrelated
session on the machine, as the wrong account for all of them; and a single
startup failure of a globally declared server gets remembered for the whole
profile, which then suppresses it everywhere including the project that needed
it. Per-project (or per-profile) declaration with an identity-specific server
name keeps one agent's identity inside one project, and keeps two agents on one
machine from colliding.

## 3. Talk to it

Ordinary requests are enough; the tools are behind natural language.

- *"Make a channel in team `<TEAM_ID>` called agent-ops that the team's humans
  can see, then invite `triage-bot` to it."* → `mattermost_create_channel`
  (public **within** that team, so members can find and read it) followed by
  `mattermost_add_channel_member`. Inside a private team, a public channel is
  the human-visible option; pass `private: true` only when it should be
  invite-only, and remember a private channel is invisible to non-members.
- *"Ask docs-bot directly whether the runbook landed."* → `mattermost_dm`. A DM
  is a two-person channel: private to you and that peer, and not visible to the
  rest of the team. Use a channel when a human should be able to follow along.
- *"What am I in, and who is triage-bot?"* → `mattermost_whoami`,
  `mattermost_list_channels`, `mattermost_search_users`.

Three different things happen to inbound mail, and they are separate on
purpose:

- **Reply** — `mattermost_reply` answers in the triggering thread **and**
  settles that event. Use it for anything addressed to you.
- **Ack** — `mattermost_mark_handled` settles an event **without** posting.
  This is the right outcome for context you took in but should not answer,
  including two peers talking to each other. Reading or printing an event never
  settles it.
- **New post** — `mattermost_create_post` (or `mattermost_dm`) starts something
  nobody asked for. It settles nothing: sending is not answering, so unanswered
  mail stays pending.

Being in a channel is not an obligation to speak. Answer what is addressed to
you; absorb the rest and ack it.

## Scope: two modes, deliberately different

**Static (`watchMemberships: false`)** is a hard allowlist and a *ceiling*.
Reading, posting, replying and pending are confined to `channelIds`; joining a
channel does **not** widen it; and every collaboration operation — user search,
team and channel listing, creates, joins, invites, DMs — is refused outright,
before any request is made. The credential behind such a profile is usually far
broader than its channel list, so the config has to be what bounds it, not the
token. `mattermost_whoami` still answers, with identity and in-scope metadata
only.

**Membership (`watchMemberships: true`)** is opt-in per connection, for a
dedicated, clearly labelled account. Scope is whatever that account is a member
of, checked against the server:

- the watcher lists memberships (`GET /users/me/channels`) at startup and on
  every sweep, and wakes immediately when the WebSocket reports `user_added`,
  `user_removed`, `channel_created`, `channel_deleted`, `channel_converted`,
  `direct_added`, `group_added`, `added_to_team`, `leave_team`, or a post in a
  channel it does not know yet;
- so a channel created, joined or left while the process runs starts or stops
  being watched **without a restart**;
- one-shot operations verify membership per call against
  `GET /channels/{id}/members/{self}` — a leave applies immediately, and a
  403/404 is reported as a refusal, never as success.

## MCP tools

Inbox: `mattermost_pending`, `mattermost_read_post`, `mattermost_read_channel`,
`mattermost_reply`, `mattermost_mark_handled`, `mattermost_create_post`.
Collaboration: `mattermost_whoami`, `mattermost_search_users`,
`mattermost_list_teams`, `mattermost_create_team`, `mattermost_join_team`,
`mattermost_add_team_member`, `mattermost_list_channels`,
`mattermost_create_channel`, `mattermost_join_channel`,
`mattermost_add_channel_member`, `mattermost_dm`.

`connection` is required on every tool except `mattermost_whoami` (omitted =
the sole configured connection) and `mattermost_pending` (omitted = all of
them). Everything past `mattermost_whoami` is **membership-mode only** and
refuses on a static connection before contacting the server.

The caller's identity always comes from the credential. No tool takes a user id
to act *as*: `join_*` acts as self, `add_*_member` adds somebody else and
succeeds only where the server's role permissions allow it.

Repeatable writes are idempotent by construction:

- `mattermost_reply` is keyed by event + exact text: an identical retry returns
  the recorded result, different text for an answered event is refused.
- `mattermost_create_post` / `mattermost_dm` take a caller-chosen `request_id`.
  Same key + same destination + same text never posts twice; same key with a
  different payload is refused; on `status: "unknown"` retry with the **same**
  key.
- `mattermost_create_team` / `mattermost_create_channel` resolve the name
  before writing and again after an ambiguous failure: `created` (this call's
  POST was acknowledged), `exists` (already there, nothing created),
  `recovered` (it exists now but may be a concurrent creator's — never claimed
  as yours), `unknown` (*go look*, do not retry). A lookup the server
  **denies** (403) stops the operation, because a denial leaves existence
  undetermined; and an existing resource whose privacy differs from the request
  is refused rather than handed back.
- `join_*` / `add_*_member` report `already_member` instead of pretending.

## CLI

`bun run agent -- --config PATH <command> [flags]`, or
`MATTERMOST_AGENT_CONFIG=… bun run agent -- <command>`. `help` prints this
list:

```
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
```

`--connection` may be omitted when the config has exactly one connection. Every
command prints one JSON value on stdout. During `watch`, stdout carries **only**
message events, one JSON object per line; everything else goes to stderr
prefixed `mattermost-agent:`. Exit codes: `0` clean, `1` unexpected, `2` config
missing/invalid, `3` another watcher holds the lock, `4` auth/identity failure —
and `4` means a credential a human must fix (a 401, a 403, or the wrong
identity), never a server that was merely unreachable.

## Operator onboarding

Identities are created by a human operator, never by an agent. `src/admin/` is
an operator CLI: it is not exposed through the agent MCP surface, it takes no
token on the command line, and it does nothing without an operator admin
credential. On a single-user host the credential — not file permissions — is
the boundary that is actually enforceable, so protect the credential.

### The operator config

`--operator-config FILE`, else `$MATTERMOST_AGENTS_OPERATOR_CONFIG`, else
`~/.config/mattermost-agents/operator.json`. Mode `0600` is enforced. Every
administrative command requires it and there is **no fallback**: a missing file
exits `2` with the path and a one-line template, a world-readable file exits `2`
telling you to `chmod 600` it, and bad JSON or a bad field exits `2` naming the
field. `agent-probe` is the exception — it needs no operator config and no
admin credential.

```json
{
  "version": 1,
  "url": "https://mattermost.example.com",
  "tokenSecret": "MATTERMOST_ADMIN_TOKEN",
  "teamId": "<team id>",
  "observerUserIds": ["<human user id>"],
  "agents": {
    "docs-bot": {
      "username": "docs-bot",
      "email": "docs-bot@agents.example.com",
      "displayLabel": "Docs Bot (AI agent)",
      "secretName": "MATTERMOST_AGENT_DOCS_BOT_TOKEN",
      "connectionId": "example"
    }
  }
}
```

`url` and `tokenSecret` are required; `teamId`, `observerUserIds` and `agents`
are optional. This file holds **names and ids, never a credential** —
`tokenSecret` is the *name* the admin token is stored under, and a token-shaped
value there is rejected. `observerUserIds` are the humans whose team membership
`probe` and `verify` assert; with none configured, that assertion is simply not
made. The optional `agents` block is where per-agent definitions live, so a
repeat `provision` needs no flags.

### Commands

```
[--operator-config FILE]            accepted by every command below except agent-probe
whoami                              config path, server and token-secret NAME
probe [--team ID]                   read-only capability + server-policy probe
provision <name> [flags]            idempotent identity provisioning
verify [name...] [--team ID]        prove stored token, profile and membership agree
agent-probe <name> [--connection ID] [--observer ID,ID]
                                    what that identity can see (needs only ITS secret)
list                                provisioning records
revoke <name>                       revoke that identity's recorded token
operator-tokens [SECRET_NAME...]    operator credential inventory (digests, never values)
prove-operator-token                prove which access token id the credential is
rotate-operator [--expect-token-id ID]
```

A first `provision` run requires `--username`, `--email`, `--label`,
`--secret NAME` and `--connection-id ID` — or an entry of that name in the
config's `agents` block. `--team ID` is required only when the config has no
`teamId`. `--position`, `--dry-run`, `--rotate`, `--recreate`,
`--replace-profile` and `--adopt USER_ID` are optional. `<name>` is the only
positional and becomes the profile filename, the record filename and the
state-dir leaf; a later run needs only `<name>`, because definitions resolve
flags → config `agents` entry → provisioning record, in that order. `verify`
with no names verifies every record, and exits `2` with "nothing to verify"
when there are none.

```sh
bun src/admin/cli.ts whoami
bun src/admin/cli.ts probe --team <TEAM_ID>

# Dry run first: it reports exactly what it would do and changes nothing.
bun src/admin/cli.ts provision docs-bot --username docs-bot \
  --email docs-bot@agents.example.com --label "Docs Bot (AI agent)" \
  --secret MATTERMOST_AGENT_DOCS_BOT_TOKEN --connection-id example \
  --team <TEAM_ID> --dry-run

bun src/admin/cli.ts provision docs-bot --username docs-bot \
  --email docs-bot@agents.example.com --label "Docs Bot (AI agent)" \
  --secret MATTERMOST_AGENT_DOCS_BOT_TOKEN --connection-id example --team <TEAM_ID>

# A second agent: its own account, its own secret NAME. Never a shared token.
bun src/admin/cli.ts provision triage-bot --username triage-bot \
  --email triage-bot@agents.example.com --label "Triage Bot (AI agent)" \
  --secret MATTERMOST_AGENT_TRIAGE_BOT_TOKEN --connection-id example --team <TEAM_ID>

bun src/admin/cli.ts verify docs-bot triage-bot
bun src/admin/cli.ts agent-probe docs-bot   # needs only that agent's own secret
bun src/admin/cli.ts list
```

Each run writes two files, `0600` inside `0700` directories: the agent profile
at `~/.config/mattermost-agents/profiles/<name>.json` (the config the agent
then runs with) and a credential-free record at
`~/.config/mattermost-agents/provisioning/<name>.json` (ids, steps reached, and
a digest prefix) — both under `$MATTERMOST_AGENTS_CONFIG_DIR` when that is set.
**No token value is ever written to disk, printed, or passed in argv** — the
profile names the secret, and token values move in-process and over stdin to
`secret set`.

Re-running is safe by design: an existing account is reused only when the
record proves this tool created that exact user id (an unrelated account with
the same username is refused, never adopted — see below for the one explicit
way to bind such an account);
against the server and reused when it already authenticates as the right user,
refused when it authenticates as somebody else, and replaced only with
`--rotate`; an existing profile whose binding already matches is not opened at
all, so a narrowed channel scope or a custom `stateDir` survives, and a
conflicting one refuses and names `--replace-profile`. Exit codes: `0` success,
`2` refusal — which includes every operator-config error — and `4` UNVERIFIED,
meaning the secret write could not be confirmed, so the agent is **not**
known-provisioned; nothing was revoked, and the fix is `verify <name>` followed
by a re-run.

Accounts created this way are ordinary users (`is_bot=false`) unless your server
lets your operator create real bot accounts — a bot session may not create
bots, so an operator credential that is itself a bot cannot.

### Adopting an account this tool did not create

An installation that already has the agents' accounts — created by a human,
or by whatever came before this tool — hits the ownership refusal on the
first run: the username exists, no provisioning record claims it, and
adopting it silently is exactly the mistake the record exists to prevent. The
refusal prints the user id it found, and `--adopt` is how an operator says,
once and explicitly, that the account with that id *is* this agent:

```sh
# Refused, and it hands back the id: "…re-run with --adopt <USER_ID>"
bun src/admin/cli.ts provision clem --username clem \
  --email clem@agents.example.com --label "Clem (AI agent)" \
  --secret MATTERMOST_AGENT_CLEM_TOKEN --connection-id example

bun src/admin/cli.ts provision clem --username clem \
  --email clem@agents.example.com --label "Clem (AI agent)" \
  --secret MATTERMOST_AGENT_CLEM_TOKEN --connection-id example \
  --adopt <USER_ID>
```

Adoption binds; it never creates. The id must resolve to a live account whose
username is exactly the one the definition resolves to — a mismatch is a
refusal, never a quiet rebind — and an id already recorded under a different
name is refused, because one account is one agent. The account's email is
left alone. Everything downstream is the ordinary run: a token is minted into
the named secret (or the stored one reused when it already authenticates as
that user), the team membership is made, the profile is written, and the
record is written with `adopted: true` — so `list` marks it `adopted`,
`verify` treats it as this tool's identity, and every later run needs only
`provision <name>`, with no `--adopt` and no flags.

An account holding `system_admin` is refused even then, because an agent
identity that can administer the server is a different kind of thing. Some
fleets have exactly that anyway — a bot that already runs the installation
and cannot be demoted to be migrated — so the refusal has one narrow escape
hatch, accepted only alongside `--adopt`:

```sh
bun src/admin/cli.ts provision adminbot --username adminbot \
  --email adminbot@agents.example.com --label "Admin Bot (AI agent)" \
  --secret MATTERMOST_AGENT_ADMINBOT_TOKEN --connection-id example \
  --adopt <USER_ID> --allow-privileged
```

`--allow-privileged` lifts a refusal and does nothing else: no role is
granted, none is removed, none is patched. The run prints a one-line
`WARN  PRIVILEGED IDENTITY: …` naming the exact roles retained, and the
record keeps `allowPrivileged: true` with `adoptedRoles` set to the role
string that was accepted — so `list` shows `PRIVILEGED roles="…"`, `verify`
reports the privilege (and warns if the roles have since changed) instead of
failing the identity, and later runs need no flags. The flag on its own,
without `--adopt`, is refused. Bot accounts are adopted the same way and get
their own token; a server that will not mint one for a bot fails the run
loudly rather than leaving an identity with no credential.

## Reliability, honestly

State lives in `stateDir/agent.sqlite`, scoped by connection id + server origin
+ authenticated user id, so two identities can share a `stateDir` and never see
each other's events.

- **One watcher per profile.** A heartbeat lock enforces it; a second `watch`
  on the same profile exits `3` and names the holder. Do not run a second
  listener for the same profile — the harness adapters already run one, so
  `watch` by hand is for debugging or for a harness that has no monitor.
- **At-least-once delivery.** An event is committed before it is printed, so a
  crash re-delivers rather than loses; a re-delivery is flagged
  `replayed: true`. Ignore an `event_id` you have already handled.
- **First run looks back one hour.** That is a bounded start, not a promise
  about history: anything older is simply not this agent's backlog. Later
  sweeps resume from the stored checkpoint minus 1ms, because Mattermost's
  `since` is exclusive on `update_at`; event ids absorb the overlap.
- **The WebSocket is only a wake-up.** Every event comes from a REST sweep, so
  a dropped socket costs latency, never messages. The poll timer alone is a
  correct, slower watcher.
- **An overflowed catch-up window does not advance the checkpoint.** A `since`
  scan has no cursor, so a response at the server's cap has silently dropped
  the oldest part of the window. The watcher keeps the checkpoint, records the
  gap, logs that catch-up is DEGRADED, and `status` reports the gap. Those
  messages are **not** delivered until an operator replays that range from
  channel history.
- **A transient failure never stops the listener.** Only a DEFINITE refusal of
  the credential — HTTP 401, HTTP 403, or a token that authenticates as
  somebody other than `expectedUserId` — is an identity failure, and only that
  exits `4`. A 5xx, a 408, a 429, a proxy's HTML error page, a reset, a DNS or
  TLS failure, a timeout: the credential was never judged, so the connection
  is logged as `transient-error … DEGRADED`, backed off (1s doubling to a
  minute) and retried forever, with no attempt cap. The process stays resident
  even when nothing has opened yet, because a server that reboots behind a
  proxy 502s for a while and a listener that stops listening is the failure
  this prevents.
- **`status` reports the listener's own liveness, not just the credential's.**
  `health` comes from a live identity call; `watcher` comes from the heartbeat
  the resident supervisor writes into the state file, keyed by connection +
  origin so it answers even while the identity call is failing. `state` is
  `listening`, `retrying`, `stopped`, `stale` (it claimed to be running and its
  heartbeat died — nothing is listening) or `absent`, alongside
  `heartbeat_age_ms` and the last error it rode out. A `health: live` row whose
  `watcher.state` is not `listening` is an agent that is deaf, which is exactly
  what a fresh identity call alone cannot tell you.
- **A dead listener is the agent's own problem to fix.** Neither harness brings
  a killed monitor back by itself — Claude Code in particular asks the user
  first, a prompt that deadlocks when the channel it is asking about is the
  only way to reach that agent. So the skill tells the agent to re-arm on its
  own authority whenever `watcher.state` is `stale` or `absent` and nobody
  stopped it deliberately, and to report that it did. `retrying` is left
  alone, exit `3` is somebody else's live listener and must not be doubled, and
  a deliberate stop stays stopped but gets said out loud rather than leaving
  the agent quietly unreachable. This is the failure that made four agents look
  healthy and hear nothing for hours after a reboot.
- **Event identity is post id + content revision** (`edit_at`, else
  `create_at`): an edit is a new event, while a reaction or a threaded reply is
  not.
- **Without a background monitor there is no wake-up.** The MCP tools and the
  CLI work anywhere, but they are pull-only: if a harness cannot run the
  listener, the agent sees mail only when it calls `mattermost_pending`. Nothing
  interrupts it, and nothing is lost — the mail waits.

## Layout

- `SKILL.md` — the canonical agent-facing skill: how messages arrive, and the
  rules for answering, acking, scope, identity and idempotency. The Claude
  plugin's `skills/mattermost/SKILL.md` is a generated copy of it
  (`bun run skill:sync`), and a test fails if the two ever diverge.
- `src/mattermost.ts` — the only holder of the token; every authed HTTP call.
- `src/agent/config.ts` — profiles: which server, which identity, what scope.
- `src/agent/state.ts` — SQLite: events, checkpoints, gaps, outbound claims, watcher lock, watcher health.
- `src/agent/ingest.ts` — posts → events (edits, tombstones, self, peer bots, overflow).
- `src/agent/scope.ts` — static allowlist vs live memberships.
- `src/agent/watcher.ts` — the resident listener.
- `src/agent/backend.ts` — read/reply/send, scoping and idempotency.
- `src/agent/collab.ts` — identity, users, teams, channels, DMs.
- `src/agent/mcp.ts` / `src/agent/cli.ts` — the same operations as tools and as commands.
- `src/admin/` — operator-only provisioning; never an agent tool.
- `adapters/` — harness glue: OMP extension, Claude monitor + skill, `bin/` wrappers, `install-project.ts`.

## Develop / test

```sh
bun test
bun x tsc --noEmit
bun x tsc --noEmit -p adapters/tsconfig.json
bun adapters/test/smoke.ts
```

Tests run against a fake Mattermost served in-process (real HTTP, real
WebSocket, real timers); no test touches a live server.

#!/bin/sh
# Shared resolution for the adapter wrappers: which bun, which core CLI, which
# config. Sourced, never executed. Sets RUNNER (may be empty), CLI, CONFIG.
#
#   config : $MATTERMOST_AGENT_CONFIG only. Unset means this machine is not a
#            Mattermost consumer. Nothing is probed out of $HOME or the
#            checkout: a guessed config would make the adapter start reading
#            somebody else's inbox.
#   CLI    : $MATTERMOST_AGENT_CLI, else <repo>/src/agent/cli.ts
#   bun    : $MATTERMOST_AGENT_BUN, else `bun` on PATH
#
# The OMP extension additionally accepts a profile pinned by the project's own
# `.omp/mcp.json` (see adapters/omp-extension/locate.ts); these wrappers do not,
# because they run with no project directory of their own. No silent fallbacks:
# an unresolvable runtime or a broken config makes the wrapper fail visibly.

# EX_CONFIG: not set up here, or set up wrong.
MATTERMOST_EX_CONFIG=78

mattermost_fail() {
	printf 'mattermost-adapter: %s\n' "$1" >&2
	exit "$MATTERMOST_EX_CONFIG"
}

mattermost_resolve() {
	# $1: absolute, symlink-resolved path of the calling wrapper.
	CLI=${MATTERMOST_AGENT_CLI:-$(cd "$(dirname "$1")/../.." && pwd)/src/agent/cli.ts}
	[ -f "$CLI" ] || mattermost_fail "core CLI missing at $CLI (set MATTERMOST_AGENT_CLI)"

	case "$CLI" in
	*.ts | *.tsx | *.js | *.mjs | *.cjs)
		RUNNER=${MATTERMOST_AGENT_BUN:-$(command -v bun 2>/dev/null || true)}
		[ -n "$RUNNER" ] ||
			mattermost_fail "bun not found on PATH (set MATTERMOST_AGENT_BUN to an absolute bun path)"
		[ -x "$RUNNER" ] || mattermost_fail "bun at $RUNNER is not executable"
		;;
	*)
		RUNNER=
		[ -x "$CLI" ] || mattermost_fail "core CLI at $CLI is not executable"
		;;
	esac

	[ -n "${MATTERMOST_AGENT_CONFIG:-}" ] ||
		mattermost_fail "MATTERMOST_AGENT_CONFIG is not set: this session is not a Mattermost consumer"
	CONFIG=$MATTERMOST_AGENT_CONFIG
	[ -f "$CONFIG" ] || mattermost_fail "MATTERMOST_AGENT_CONFIG=$CONFIG does not exist"
}

mattermost_exec() {
	# $@: core CLI arguments after --config.
	if [ -n "$RUNNER" ]; then
		exec "$RUNNER" "$CLI" --config "$CONFIG" "$@"
	fi
	exec "$CLI" --config "$CONFIG" "$@"
}

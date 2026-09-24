#!/usr/bin/env bash
#
# acceptance-lib.sh — the harness the real-pane acceptance scripts share.
#
# Sourced, never executed:
#
#   source "$(dirname "$0")/acceptance-lib.sh"
#
# The entry points stay separate on purpose. acceptance.sh covers Phase 1/2 and
# has to keep finishing in about a minute; acceptance-fork.sh builds a scratch
# repository and drives real model sessions, so it takes minutes; and
# acceptance-view.sh starts real Pi sessions in different states for the fleet
# view. Why that is a third script, and not a section of either of the other
# two, is argued in DESIGN.md §7 ("実 pane 受入の入口が 3 本になる理由").
#
# What they share lives here: the counters, the pane helpers, the observer Pi,
# and — the part that used to be hand-written in each script and drifted — the
# teardown. One script closed only its panes, the other closed a workspace too,
# so whichever was edited next could quietly leak resources.
#
# A script sets `set -uo pipefail` and calls `fleet_preflight` first.
# `fleet_cleanup` is installed here as the EXIT trap, so whatever has been
# registered before a failure is still removed.

FLEET_PACKAGE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_ROOT="$(cd "$FLEET_PACKAGE/../.." && pwd)"
FLEET_EXTENSION="$FLEET_PACKAGE/index.ts"
# The observer loads this extension and nothing else, so another installed
# extension cannot take ctrl+shift+a or paint over the screen the checks read.
FLEET_OBSERVER_ARGS=(-ne -e "$FLEET_EXTENSION")
# Pi needs a moment after `agent start` before it has loaded the extension and
# registered its commands. Measured, not derived; shorten it and the first
# `/fleet` command can arrive before the command exists.
FLEET_OBSERVER_SETTLE="${FLEET_OBSERVER_SETTLE:-3}"

# ---------------------------------------------------------------- reporting

FLEET_PASS=0
FLEET_FAIL=0

say() { printf '\n== %s\n' "$1"; }
ok() {
	FLEET_PASS=$((FLEET_PASS + 1))
	printf '   ok    %s\n' "$1"
}
fail() {
	FLEET_FAIL=$((FLEET_FAIL + 1))
	printf '   FAIL  %s\n' "$1"
}

# A here-string, not a pipe: `grep -q` exits on the first match, and under
# `pipefail` the SIGPIPE that gives `printf` turns a matching check into a
# failure once the sampled text grows past a pipe buffer.
check() { # check <description> <pattern> <text>
	if grep -qE "$2" <<<"$3"; then ok "$1"; else fail "$1 (no match for /$2/)"; fi
}
expect_absent() { # expect_absent <description> <pattern> <text>
	if grep -qE "$2" <<<"$3"; then fail "$1 (unexpected match for /$2/)"; else ok "$1"; fi
}

# The line a check was looking at. A screen is wide and a toast is one line of
# it, so a failure is much easier to read next to the text it matched.
observed() { # observed <label> <pattern> <text>
	local line
	line="$(printf '%s' "$3" | grep -aoE "$2" | tail -1 | cut -c1-200)"
	printf '   observed: %s -> %s\n' "$1" "${line:-(no match)}"
}

# The tail of a pane's screen, for the failure paths that have nothing to match
# against — a session that never started, a pane that never appeared.
dump_pane() { # dump_pane <pane> [lines]
	local lines="${2:-30}"
	printf '   observed: %s (last %s lines)\n' "$1" "$lines"
	herdr pane read "$1" --source visible --lines "$lines" 2>/dev/null | tail -"$lines" | sed 's/^/   | /'
}

fleet_result() {
	printf '\n%s passed, %s failed\n' "$FLEET_PASS" "$FLEET_FAIL"
	[ "$FLEET_FAIL" -eq 0 ]
}

# ------------------------------------------------------------ pane helpers

# `herdr pane read` prints the pane text directly; `visible` is the screen.
screen() { herdr pane read "$1" --source visible --lines 60 2>/dev/null; }

# `recent-unwrapped` keeps the toasts the scripts assert on. The read is bounded
# by a watchdog: a read that never returns would hang the whole run, and the
# polling loops only re-check their deadline between calls.
history() { # history <pane>
	local file pid watchdog
	file="$(mktemp)"
	herdr pane read "$1" --source recent-unwrapped --lines 200 >"$file" 2>/dev/null </dev/null &
	pid=$!
	# The watchdog's own fds are closed: a live child holding the command
	# substitution's stdout open would make `$(history ...)` wait for it.
	(sleep 20; kill -9 "$pid" 2>/dev/null) </dev/null >/dev/null 2>&1 &
	watchdog=$!
	wait "$pid" 2>/dev/null
	kill "$watchdog" 2>/dev/null
	wait "$watchdog" 2>/dev/null
	cat "$file"
	rm -f "$file"
}

pane_id_of() { sed -n 's/.*"pane_id":"\([^"]*\)".*/\1/p' | head -1; }

# Sets FLEET_NEW_PANE rather than printing it: a command substitution would run
# in a subshell, and the registration below has to survive.
split_pane() { # split_pane <pane> <direction> <cwd>
	FLEET_NEW_PANE="$(herdr pane split "$1" --direction "$2" --cwd "$3" --no-focus 2>/dev/null | pane_id_of)"
	register_pane "$FLEET_NEW_PANE"
	[ -n "$FLEET_NEW_PANE" ]
}

# Sets FLEET_NEW_WORKSPACE and FLEET_NEW_PANE (its root pane).
new_workspace() { # new_workspace <cwd> <label>
	local created
	created="$(herdr workspace create --cwd "$1" --label "$2" --no-focus 2>/dev/null)"
	FLEET_NEW_WORKSPACE="$(printf '%s' "$created" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["workspace"]["workspace_id"])' 2>/dev/null)"
	FLEET_NEW_PANE="$(printf '%s' "$created" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])' 2>/dev/null)"
	register_workspace "$FLEET_NEW_WORKSPACE"
	[ -n "$FLEET_NEW_WORKSPACE" ]
}

# ---------------------------------------------------------------- observer

# A Pi running this extension in its own pane. `-ne` isolates the test from
# whatever else is installed; the extension is passed by path so the code under
# test is the code in this checkout.
start_observer() { # start_observer <description> <agent name> <pane> [pi args...]
	local description="$1" name="$2" pane="$3"
	shift 3
	if herdr agent start "$name" --kind pi --pane "$pane" --timeout 60000 -- "${FLEET_OBSERVER_ARGS[@]}" "$@" >/dev/null 2>&1; then
		ok "$description"
	else
		fail "$description"
		dump_pane "$pane"
		return 1
	fi
	sleep "$FLEET_OBSERVER_SETTLE"
}

# ---------------------------------------------------------------- teardown

# Everything the run created. The scripts register as they go, so a failure in
# the middle of a section still removes what that section made.
FLEET_PANES=()
FLEET_WORKSPACES=()
FLEET_WORKTREES=() # "<workspace id>\t<checkout path>"
FLEET_PATHS=() # files and directories this run created
FLEET_CLEANUP_HOOKS=()

register_pane() { [ -n "${1:-}" ] && FLEET_PANES[${#FLEET_PANES[@]}]="$1"; }
register_workspace() { [ -n "${1:-}" ] && FLEET_WORKSPACES[${#FLEET_WORKSPACES[@]}]="$1"; }
register_worktree() { # register_worktree <workspace id> [checkout path]
	[ -n "${1:-}" ] && FLEET_WORKTREES[${#FLEET_WORKTREES[@]}]="$1"$'\t'"${2:-}"
}
register_path() { [ -n "${1:-}" ] && FLEET_PATHS[${#FLEET_PATHS[@]}]="$1"; }
# Script-specific teardown — a prefix scan for worktrees herdr was never told
# about, direnv trust to withdraw — run first, while everything still exists.
on_cleanup() { FLEET_CLEANUP_HOOKS[${#FLEET_CLEANUP_HOOKS[@]}]="$1"; }

fleet_cleanup() {
	local index entry workspace path
	for ((index = 0; index < ${#FLEET_CLEANUP_HOOKS[@]}; index += 1)); do
		"${FLEET_CLEANUP_HOOKS[$index]}"
	done
	for ((index = 0; index < ${#FLEET_WORKTREES[@]}; index += 1)); do
		entry="${FLEET_WORKTREES[$index]}"
		workspace="${entry%%$'\t'*}"
		path="${entry#*$'\t'}"
		# direnv records trust per path, so the record goes before the checkout.
		[ -n "$path" ] && direnv deny "$path" >/dev/null 2>&1
		herdr worktree remove --workspace "$workspace" --force >/dev/null 2>&1
	done
	# Closing a workspace takes its panes with it, and closing either twice is a no-op.
	for ((index = 0; index < ${#FLEET_WORKSPACES[@]}; index += 1)); do
		herdr workspace close "${FLEET_WORKSPACES[$index]}" >/dev/null 2>&1
	done
	for ((index = 0; index < ${#FLEET_PANES[@]}; index += 1)); do
		herdr pane close "${FLEET_PANES[$index]}" >/dev/null 2>&1
	done
	# Last, once nothing has to read them: the run's own scratch directories.
	for ((index = 0; index < ${#FLEET_PATHS[@]}; index += 1)); do
		rm -rf "${FLEET_PATHS[$index]}"
	done
}
trap fleet_cleanup EXIT

# ---------------------------------------------------------------- preflight

fleet_preflight() {
	if [ "${HERDR_ENV:-}" != "1" ]; then
		echo "not running inside a herdr pane (HERDR_ENV != 1)" >&2
		exit 2
	fi
	if [ ! -f "$FLEET_EXTENSION" ]; then
		echo "missing extension entry: $FLEET_EXTENSION" >&2
		exit 2
	fi
}

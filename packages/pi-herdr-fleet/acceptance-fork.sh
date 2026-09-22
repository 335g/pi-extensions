#!/usr/bin/env bash
#
# End-to-end acceptance for `/fleet fork`, against a real herdr server, real git,
# real npm, real direnv and a real Pi TUI. `selfcheck.ts` covers the logic
# against a fake socket; this covers what only exists when all of those are real.
#
# A fork creates real worktrees, workspaces and panes, so this script does not
# use this repository. It builds its own git repository in a temp directory with
# a lockfile-less base commit, its own workspace for the observer Pi, and removes
# every worktree, workspace and pane it created on the way out. Nothing else is
# touched: other workspaces and other worktrees are never read or closed.
#
# The last check needs a working model, because the point of a fork is that the
# forked session does the task. Set OPENCODE_API_KEY (or have direnv provide it,
# as this repository's own `.envrc` does) or the forked sessions will have no
# provider.
#
# Run it from inside a herdr pane (HERDR_ENV=1) anywhere in this repository.
#
#   packages/pi-herdr-fleet/acceptance-fork.sh
#
set -uo pipefail

EXTENSION="$(cd "$(dirname "$0")" && pwd)/index.ts"
SCRATCH="$(mktemp -d -t fleet-fork-accept)"
# The name is unique so the worktree parent directory herdr creates for it is
# this run's alone, and safe to remove.
REPO="$SCRATCH/fleet-fork-accept-$$"
WT_PARENT="$HOME/.herdr/worktrees/fleet-fork-accept-$$"
PREFIX="fleet-accept-$$"
OBSERVER_WS=""
OBSERVER=""
PASS=0
FAIL=0

# Every workspace a fork created is reached through the worktree herdr opened for
# it, so the branch prefix is the only handle needed to clean up. The path comes
# along because direnv records trust per path, and the record has to go before
# the checkout it points at does.
fork_worktrees() {
	herdr worktree list --cwd "$REPO" 2>/dev/null | python3 -c '
import json, sys
try:
    worktrees = json.load(sys.stdin)["result"]["worktrees"]
except Exception:
    worktrees = []
for worktree in worktrees:
    if (worktree.get("branch") or "").startswith(sys.argv[1]) and worktree.get("open_workspace_id"):
        print(worktree["open_workspace_id"] + "\t" + worktree["path"])
' "$PREFIX"
}

cleanup() {
	if [ -d "$REPO" ]; then
		while IFS=$'\t' read -r workspace path; do
			[ -n "$path" ] && direnv deny "$path" >/dev/null 2>&1
			[ -n "$workspace" ] && herdr worktree remove --workspace "$workspace" --force >/dev/null 2>&1
		done < <(fork_worktrees)
	fi
	[ -n "$OBSERVER_WS" ] && herdr workspace close "$OBSERVER_WS" >/dev/null 2>&1
	direnv deny "$REPO" >/dev/null 2>&1
	rm -rf "$SCRATCH" "$WT_PARENT"
}
trap cleanup EXIT

say() { printf '\n== %s\n' "$1"; }
ok() { PASS=$((PASS + 1)); printf '   ok    %s\n' "$1"; }
fail() {
	FAIL=$((FAIL + 1))
	printf '   FAIL  %s\n' "$1"
}
check() { # check <description> <pattern> <text>
	if printf '%s' "$3" | grep -qE "$2"; then ok "$1"; else fail "$1 (no match for /$2/)"; fi
}

# `herdr pane read` prints the pane text directly; `recent-unwrapped` keeps the
# toasts this script asserts on.
history() { herdr pane read "$1" --source recent-unwrapped --lines 200 2>/dev/null; }

worktree_field() { # worktree_field <branch> <json field>
	herdr worktree list --cwd "$REPO" 2>/dev/null | python3 -c '
import json, sys
try:
    worktrees = json.load(sys.stdin)["result"]["worktrees"]
except Exception:
    worktrees = []
match = next((w for w in worktrees if w.get("branch") == sys.argv[1]), None)
print((match or {}).get(sys.argv[2], ""))
' "$1" "$2"
}

pane_session() { # pane_session <pane> -> the session file herdr knows for that pane
	herdr pane list 2>/dev/null | python3 -c '
import json, sys
try:
    panes = json.load(sys.stdin)["result"]["panes"]
except Exception:
    panes = []
match = next((p for p in panes if p["pane_id"] == sys.argv[1]), None)
print(((match or {}).get("agent_session") or {}).get("value", ""))
' "$1"
}

pane_in_workspace() { # pane_in_workspace <workspace> [agent] -> the pane running that agent
	herdr pane list 2>/dev/null | python3 -c '
import json, sys
try:
    panes = json.load(sys.stdin)["result"]["panes"]
except Exception:
    panes = []
want = sys.argv[2] if len(sys.argv) > 2 else ""
match = next((p for p in panes if p["workspace_id"] == sys.argv[1] and (not want or p.get("agent") == want)), None)
print((match or {}).get("pane_id", ""))
' "$1" "${2:-}"
}

panes_in_workspace() { # panes_in_workspace <workspace> -> every pane id in it
	herdr pane list 2>/dev/null | python3 -c '
import json, sys
try:
    panes = json.load(sys.stdin)["result"]["panes"]
except Exception:
    panes = []
print(" ".join(p["pane_id"] for p in panes if p["workspace_id"] == sys.argv[1]))
' "$1"
}

# The fork is asynchronous from this script's point of view: it finishes when the
# worktree herdr opened shows up.
fork() { # fork <branch> <task> [flags...]
	local branch="$1" task="$2"
	shift 2
	herdr pane send-text "$OBSERVER" "/fleet fork $branch --task \"$task\" $*" >/dev/null 2>&1
	sleep 0.7
	herdr pane send-keys "$OBSERVER" enter >/dev/null 2>&1
}

# Wait for a fork to be done while sampling the observer's screen. The worktree
# appears first; the pane and the agent follow the install, and the notification
# comes after the seed, so sampling continues past the point where work is done —
# a toast only lives on screen for a few seconds.
await_fork() { # await_fork <branch> <yes|no: expect an agent> -> the sampled screen
	local branch="$1" want_agent="$2" deadline=$((SECONDS + 300)) text="" done_at=""
	while [ "$SECONDS" -lt "$deadline" ]; do
		text="$text$(history "$OBSERVER")"
		if [ -n "$(worktree_field "$branch" path)" ]; then
			if [ "$want_agent" = "no" ]; then
				[ -n "$done_at" ] || done_at=$SECONDS
			elif [ -n "$(pane_in_workspace "$(worktree_field "$branch" open_workspace_id)" pi)" ]; then
				[ -n "$done_at" ] || done_at=$SECONDS
			fi
		fi
		if [ -n "$done_at" ] && [ $((SECONDS - done_at)) -ge 8 ]; then break; fi
		sleep 0.5
	done
	printf '%s' "$text"
}

# The install runs in the pane, after the worktree exists.
await_dir() { # await_dir <path>
	local deadline=$((SECONDS + 180))
	while [ "$SECONDS" -lt "$deadline" ]; do
		[ -d "$1" ] && return 0
		sleep 1
	done
	return 1
}

# ---------------------------------------------------------------- preflight

if [ "${HERDR_ENV:-}" != "1" ]; then
	echo "not running inside a herdr pane (HERDR_ENV != 1)" >&2
	exit 2
fi
[ -f "$EXTENSION" ] || {
	echo "missing extension entry: $EXTENSION" >&2
	exit 2
}
[ -n "${OPENCODE_API_KEY:-}" ] || printf 'warning: no OPENCODE_API_KEY; the forked sessions will have no provider\n' >&2

# ---------------------------------------------------------------- 1. repository

say "1. scratch repository (no lockfile at the base commit)"
mkdir -p "$REPO/fleet-dep"
cd "$REPO" || exit 1
cat >package.json <<'JSON'
{
  "name": "fleet-fork-accept",
  "version": "1.0.0",
  "private": true,
  "dependencies": { "fleet-dep": "file:./fleet-dep" }
}
JSON
cat >fleet-dep/package.json <<'JSON'
{ "name": "fleet-dep", "version": "1.0.0", "main": "index.js" }
JSON
printf 'module.exports = 1;\n' >fleet-dep/index.js
printf 'node_modules/\n.env\n.envrc\n' >.gitignore
git init -q .
git add -A
git -c user.email=fleet@accept -c user.name=fleet commit -qm "base without a lockfile"
BASE="$(git rev-parse HEAD)"
# The environment the fork has to carry over. Neither file is tracked, exactly
# like the real repository this extension was written for.
printf 'FLEET_ENV_MARKER=1\n' >.env
[ -n "${OPENCODE_API_KEY:-}" ] && printf 'OPENCODE_API_KEY=%s\n' "$OPENCODE_API_KEY" >>.env
printf 'dotenv\n' >.envrc
direnv allow "$REPO" >/dev/null 2>&1
npm install --silent >/dev/null 2>&1
git add package-lock.json
git -c user.email=fleet@accept -c user.name=fleet commit -qm "add the lockfile"
HEAD="$(git rev-parse HEAD)"
rm -rf node_modules
ok "scratch repository at $REPO (base $BASE, head $HEAD)"

# ---------------------------------------------------------------- 2. observer

say "2. observer pane (Pi + this extension)"
OBSERVER_WS="$(herdr workspace create --cwd "$REPO" --label "fleet-fork-accept-$$" --no-focus 2>/dev/null |
	python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["workspace"]["workspace_id"])')"
OBSERVER="$(pane_in_workspace "$OBSERVER_WS")"
if [ -z "$OBSERVER" ]; then
	fail "could not open an observer workspace"
	exit 1
fi
printf '   observer: %s (%s)\n' "$OBSERVER" "$OBSERVER_WS"
herdr agent start "fleet-fork-accept-$$" --kind pi --pane "$OBSERVER" --timeout 60000 \
	-- -ne -e "$EXTENSION" >/dev/null 2>&1
if [ $? -eq 0 ]; then
	ok "observer Pi started with the extension"
else
	fail "observer Pi did not start"
	exit 1
fi
sleep 3

# ---------------------------------------------------------------- 3. full fork

say "3. fork --base HEAD: worktree, environment, install, pane, Pi, seed"
BRANCH="$PREFIX/full"
TASK="Create a file named fork-marker.txt containing the word FORKED, then commit it."
fork "$BRANCH" "$TASK" --base HEAD
TOASTS="$(await_fork "$BRANCH" yes)"
FULL_PATH="$(worktree_field "$BRANCH" path)"
FULL_WS="$(worktree_field "$BRANCH" open_workspace_id)"
if [ -z "$FULL_PATH" ]; then
	fail "the fork did not open a worktree"
	printf '%s\n' "$TOASTS" | tail -20
	exit 1
fi
ok "worktree opened on $BRANCH at $FULL_PATH"
printf '   notification: %s\n' "$(printf '%s' "$TOASTS" | grep -ao "fork $BRANCH.*" | tail -1)"

check "the fork reports the worktree, the pane and the agent" "$BRANCH.*pane .*:p[0-9].*agent $PREFIX-full" "$TOASTS"
check "the environment is carried over (.env)" 'FLEET_ENV_MARKER=1' "$(cat "$FULL_PATH/.env" 2>/dev/null)"
check "the environment is carried over (.envrc)" 'dotenv' "$(cat "$FULL_PATH/.envrc" 2>/dev/null)"
check "the new .envrc is trusted like the source's" '"allowed": 0' "$(cd "$FULL_PATH" && direnv status --json 2>/dev/null)"

if await_dir "$FULL_PATH/node_modules"; then
	ok "the lockfile made fork install (node_modules exists)"
else
	fail "the lockfile did not produce node_modules"
fi

FULL_PANE="$(pane_in_workspace "$FULL_WS" pi)"
if [ -n "$FULL_PANE" ]; then
	ok "a Pi agent runs in the fork's workspace ($FULL_PANE)"
else
	fail "no Pi agent in the fork's workspace"
fi

# The seed is delivered when the forked session has it as a user message, so the
# session file is the evidence — not the screen, which cannot tell a submitted
# message from text sitting in the editor.
SESSION_FILE="$(pane_session "$FULL_PANE")"
SEEDED=""
deadline=$((SECONDS + 120))
while [ "$SECONDS" -lt "$deadline" ]; do
	if [ -n "$SESSION_FILE" ] && grep -q "$TASK" "$SESSION_FILE" 2>/dev/null; then SEEDED="yes"; break; fi
	sleep 1
done
if [ -n "$SEEDED" ]; then
	ok "the seed reached the forked session as a message"
else
	fail "the seed never reached the forked session ($SESSION_FILE)"
	herdr pane read "$FULL_PANE" --source visible --lines 30 2>/dev/null | tail -20
fi

# And the session is working, not just seeded: the task asks for a commit.
deadline=$((SECONDS + 180))
while [ "$SECONDS" -lt "$deadline" ]; do
	if [ -f "$FULL_PATH/fork-marker.txt" ] && git -C "$FULL_PATH" log --oneline -1 2>/dev/null | grep -q .; then break; fi
	sleep 2
done
check "the forked session did the task" 'FORKED' "$(cat "$FULL_PATH/fork-marker.txt" 2>/dev/null)"
check "the work is committed on the fork's branch" 'fork-marker' "$(git -C "$FULL_PATH" log -1 --stat --oneline 2>/dev/null)"

# ---------------------------------------------------------------- 4. no lockfile

say "4. fork --base <commit without a lockfile>: no install"
BRANCH="$PREFIX/nolock"
fork "$BRANCH" "Reply with the single word NOLOCK and do nothing else." --base "$BASE"
await_fork "$BRANCH" yes >/dev/null
NOLOCK_PATH="$(worktree_field "$BRANCH" path)"
if [ -n "$NOLOCK_PATH" ]; then
	ok "worktree opened on $BRANCH at $NOLOCK_PATH"
else
	fail "the second fork did not open a worktree"
fi
[ -f "$NOLOCK_PATH/package-lock.json" ] && fail "the base commit should not carry a lockfile" || ok "the base commit carries no lockfile"
if [ -d "$NOLOCK_PATH/node_modules" ]; then
	fail "a checkout without a lockfile was installed into"
else
	ok "no lockfile means no install"
fi
NOLOCK_PANE="$(pane_in_workspace "$(worktree_field "$BRANCH" open_workspace_id)" pi)"
[ -n "$NOLOCK_PANE" ] && ok "the pane and the agent were still created" || fail "no pane in the fork's workspace"

# ---------------------------------------------------------------- 5. --no-install

say "5. fork --no-install: the lockfile is ignored on request"
BRANCH="$PREFIX/noinstall"
fork "$BRANCH" "Reply with the single word NOINSTALL and do nothing else." --base HEAD --no-install
await_fork "$BRANCH" yes >/dev/null
NOINSTALL_PATH="$(worktree_field "$BRANCH" path)"
if [ -n "$NOINSTALL_PATH" ]; then
	ok "worktree opened on $BRANCH at $NOINSTALL_PATH"
else
	fail "the --no-install fork did not open a worktree"
fi
[ -f "$NOINSTALL_PATH/package-lock.json" ] && ok "the lockfile is there to be ignored" || fail "the lockfile is missing from the checkout"
if [ -d "$NOINSTALL_PATH/node_modules" ]; then
	fail "--no-install still installed"
else
	ok "--no-install did not install"
fi

# ---------------------------------------------------------------- 6. --no-start

say "6. fork --no-start: worktree only"
BRANCH="$PREFIX/nostart"
fork "$BRANCH" "This task is never sent." --base HEAD --no-start
await_fork "$BRANCH" no >/dev/null
NOSTART_PATH="$(worktree_field "$BRANCH" path)"
NOSTART_WS="$(worktree_field "$BRANCH" open_workspace_id)"
if [ -n "$NOSTART_PATH" ]; then
	ok "worktree opened on $BRANCH at $NOSTART_PATH"
else
	fail "the --no-start fork did not open a worktree"
fi
NOSTART_PANES="$(panes_in_workspace "$NOSTART_WS")"
check "--no-start left the workspace with only its own pane" "^[^ ]+$" "$NOSTART_PANES"
NOSTART_AGENTS="$(pane_in_workspace "$NOSTART_WS" pi)"
if [ -z "$NOSTART_AGENTS" ]; then
	ok "--no-start started no agent"
else
	fail "--no-start started an agent ($NOSTART_AGENTS)"
fi

# ---------------------------------------------------------------- result

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]

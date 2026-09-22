#!/usr/bin/env bash
#
# End-to-end acceptance for `/fleet fork`, `/fleet review` and the worktree
# resolution a fork needs, against a real herdr server, real git, real npm, real
# direnv and a real Pi TUI. `selfcheck.ts` covers the logic against a fake
# socket; this covers what only exists when all of those are real.
#
# A fork creates real worktrees, workspaces and panes, so this script does not
# use this repository. It builds its own git repository in a temp directory with
# a lockfile-less base commit, its own workspace for the observer Pi, and removes
# every worktree, workspace and pane it created on the way out. Nothing else is
# touched: other workspaces and other worktrees are never read or closed.
#
# A working model is needed from section 3 on, because the point of a fork is
# that the forked session does the task, and the point of a review is that a
# second session judges it. Set OPENCODE_API_KEY (or have direnv provide it, as
# this repository's own `.envrc` does) or the forked sessions will have no
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
# The observer runs with `-ne`, so herdr's own integration is not loaded and the
# pane never reports a session path. Pinning the file is how the checks below can
# read what the observer's agent actually did.
OBSERVER_SESSION="$SCRATCH/observer.jsonl"
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

pane_in_workspace() { # pane_in_workspace <workspace> [agent kind] -> the pane running it
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

# Agent *names* are reported by `agent list`, not by `pane list`: a fork and the
# review of it are two agents in one workspace, and only the name tells them apart.
pane_by_agent_name() { # pane_by_agent_name <workspace> <agent name> -> its pane
	herdr agent list 2>/dev/null | python3 -c '
import json, sys
try:
    agents = json.load(sys.stdin)["result"]["agents"]
except Exception:
    agents = []
match = next((a for a in agents if a.get("workspace_id") == sys.argv[1] and a.get("name") == sys.argv[2]), None)
print((match or {}).get("pane_id", ""))
' "$1" "$2"
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
await_fork() { # await_fork <branch> <yes|no: expect an agent> [pane] -> the sampled screen
	local branch="$1" want_agent="$2" pane="${3:-$OBSERVER}" deadline=$((SECONDS + 300)) text="" done_at=""
	while [ "$SECONDS" -lt "$deadline" ]; do
		text="$text$(history "$pane")"
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

# The author's last assistant text: the report the reviewer has to be given.
assistant_report() { # assistant_report <session file>
	python3 - "$1" <<'PY'
import json, sys
texts = []
try:
    for line in open(sys.argv[1]):
        try:
            record = json.loads(line)
        except Exception:
            continue
        message = record.get("message") or {}
        if record.get("type") != "message" or message.get("role") != "assistant":
            continue
        for part in message.get("content") or []:
            if isinstance(part, dict) and part.get("type") == "text" and part.get("text", "").strip():
                texts.append(part["text"].strip())
except Exception:
    pass
print(texts[-1] if texts else "")
PY
}

# A fragment of the author's own report inside the reviewer's seed. Decoded here,
# because the seed is one JSON string and a raw grep would trip over escaping.
author_report_in_seed() { # author_report_in_seed <author session> <reviewer session>
	python3 - "$1" "$2" <<'PY'
import json, sys


def decode(path):
    texts = []
    try:
        handle = open(path)
    except OSError:
        return texts
    for line in handle:
        try:
            record = json.loads(line)
        except Exception:
            continue
        message = record.get("message") or {}
        if record.get("type") != "message":
            continue
        for part in message.get("content") or []:
            if isinstance(part, dict) and part.get("type") == "text" and part.get("text", "").strip():
                texts.append(part["text"])
    return texts


author = decode(sys.argv[1])
reviewer = "\n".join(decode(sys.argv[2]))
fragment = ""
for text in reversed(author):
    for line in text.splitlines():
        if len(line.strip()) >= 24:
            fragment = line.strip()
            break
    if fragment:
        break
print(fragment)
sys.exit(0 if fragment and fragment in reviewer else 1)
PY
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
	-- -ne -e "$EXTENSION" --session "$OBSERVER_SESSION" >/dev/null 2>&1
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

# And the session is working, not just seeded: the task asks for a commit. Wait
# for the commit to be the one that carries the file, not for any commit at all —
# the base commit is already there.
deadline=$((SECONDS + 240))
while [ "$SECONDS" -lt "$deadline" ]; do
	if git -C "$FULL_PATH" log -1 --name-only --oneline 2>/dev/null | grep -q fork-marker.txt; then break; fi
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

# ---------------------------------------------------------------- 7. the tool

# The tool is the primary path, and it differs from the command in the two places
# that matter: the arguments arrive from a model, through a schema, instead of
# from a command line, and the result goes back into the conversation.

say "7. tool: the observer's agent forks through fleet_fork"
BRANCH="$PREFIX/tool"
TOOL_TASK="Reply with the single word TOOLMARKER and do nothing else."
ask() { # ask <prompt>
	herdr pane send-text "$OBSERVER" "$1" >/dev/null 2>&1
	sleep 0.7
	herdr pane send-keys "$OBSERVER" enter >/dev/null 2>&1
}
ask "Call the fleet_fork tool exactly once with branch \"$BRANCH\" and task \"$TOOL_TASK\" Then stop."
await_fork "$BRANCH" yes >/dev/null
TOOL_PATH="$(worktree_field "$BRANCH" path)"
TOOL_WS="$(worktree_field "$BRANCH" open_workspace_id)"
if [ -n "$TOOL_PATH" ]; then
	ok "the tool created a worktree ($TOOL_PATH)"
else
	fail "the agent's fleet_fork call created no worktree"
	herdr pane read "$OBSERVER" --source visible --lines 30 2>/dev/null | tail -20
fi
TOOL_PANE="$(pane_in_workspace "$TOOL_WS" pi)"
[ -n "$TOOL_PANE" ] && ok "the tool started a Pi session in it ($TOOL_PANE)" || fail "no Pi agent from the tool path"

# The tool result is a conversation entry, so the observer's own session is where
# to see that the call happened and what it returned.
TOOL_SEEN=""
SESSION_FILE="$(pane_session "$TOOL_PANE")"
SEEDED=""
deadline=$((SECONDS + 180))
while [ "$SECONDS" -lt "$deadline" ]; do
	if grep -q "forked $BRANCH" "$OBSERVER_SESSION" 2>/dev/null; then TOOL_SEEN="yes"; fi
	if [ -n "$SESSION_FILE" ] && grep -q "TOOLMARKER" "$SESSION_FILE" 2>/dev/null; then SEEDED="yes"; fi
	[ -n "$TOOL_SEEN" ] && [ -n "$SEEDED" ] && break
	sleep 1
done
check "the tool result reached the observer's conversation" "forked $BRANCH.*agent: $PREFIX-tool" "$(grep -a "forked $BRANCH" "$OBSERVER_SESSION" 2>/dev/null | tail -1)"
if [ -n "$SEEDED" ]; then
	ok "the tool path's seed reached the forked session"
else
	fail "the tool path's seed never arrived ($SESSION_FILE)"
fi

# ---------------------------------------------------------------- 8. refused

# The tool's arguments arrive from a model, through a schema, so there are two
# ways a bad call is stopped: the schema refuses it before `execute` runs, and
# `forkWorktree` refuses what the schema cannot express. Both are checked here,
# because neither is reachable from the command line.

say "8. tool: a call with nothing in it is refused"

# 8a. An empty task passes the schema (a string is a string) and has to be
# refused by the validation the tool does for its model caller.
BRANCH="$PREFIX/empty"
ask "Call the fleet_fork tool with branch \"$BRANCH\" and task set to the empty string. Report the exact error you get, and do not retry or use another tool."
REFUSED=""
deadline=$((SECONDS + 180))
while [ "$SECONDS" -lt "$deadline" ]; do
	if grep -q "branch and task are both required" "$OBSERVER_SESSION" 2>/dev/null; then REFUSED="yes"; break; fi
	sleep 1
done
if [ -n "$REFUSED" ]; then
	ok "the tool refused an empty task"
else
	fail "the empty call was not refused"
	herdr pane read "$OBSERVER" --source visible --lines 30 2>/dev/null | tail -20
fi
if [ -z "$(worktree_field "$BRANCH" path)" ]; then
	ok "the refused call created no worktree"
else
	fail "the refused call created a worktree"
fi

# 8b. A missing task never reaches the tool: the schema is what the model's
# arguments are validated against.
BRANCH="$PREFIX/notask"
ask "Call the fleet_fork tool with branch \"$BRANCH\" and do not pass any task argument at all. Report the exact error you get, and do not retry or use another tool."
REFUSED=""
deadline=$((SECONDS + 180))
while [ "$SECONDS" -lt "$deadline" ]; do
	if grep -q "must have required properties task" "$OBSERVER_SESSION" 2>/dev/null; then REFUSED="yes"; break; fi
	sleep 1
done
if [ -n "$REFUSED" ]; then
	ok "the schema refused a call without a task"
else
	fail "the call without a task was not refused by the schema"
fi
if [ -z "$(worktree_field "$BRANCH" path)" ]; then
	ok "the call without a task created no worktree"
else
	fail "the call without a task created a worktree"
fi

# ---------------------------------------------------------------- 9. review

# The review is the other half of the loop: the implementation session's branch
# is read back by a second Pi, in the author's own worktree, with the material a
# `git diff` cannot produce — what was asked, and what the author said.

say "9. review: a reviewer inside the implementation worktree"
FULL_BRANCH="$PREFIX/full"
AUTHOR_SESSION="$(pane_session "$FULL_PANE")"
AUTHOR_REPORT="$(assistant_report "$AUTHOR_SESSION")"
if [ -n "$AUTHOR_REPORT" ]; then
	ok "the author's session has an assistant report to hand over"
else
	fail "the author's session has no assistant text ($AUTHOR_SESSION)"
fi

review() { # review <branch> <task> [flags...]
	herdr pane send-text "$OBSERVER" "/fleet review $1 --task \"$2\" ${3:-}" >/dev/null 2>&1
	sleep 0.7
	herdr pane send-keys "$OBSERVER" enter >/dev/null 2>&1
}

review "$FULL_BRANCH" "$TASK"

# The reviewer is a second agent in the worktree the author worked in: a second
# worktree cannot hold the same branch, so the branch's own workspace is where it
# has to be.
REVIEW_AGENT="$PREFIX-full-review"
REVIEW_PANE=""
deadline=$((SECONDS + 180))
while [ "$SECONDS" -lt "$deadline" ]; do
	REVIEW_PANE="$(pane_by_agent_name "$FULL_WS" "$REVIEW_AGENT")"
	[ -n "$REVIEW_PANE" ] && break
	sleep 1
done
if [ -n "$REVIEW_PANE" ]; then
	ok "the reviewer runs in the author's worktree ($REVIEW_PANE, agent $REVIEW_AGENT)"
else
	fail "no reviewer pane appeared in $FULL_WS"
	herdr pane read "$OBSERVER" --source visible --lines 30 2>/dev/null | tail -20
fi

# The seed is the evidence: it has to arrive as a message, and it has to carry
# the task, the diff and the author's own words. The screen cannot tell a
# submitted message from text sitting in an editor.
REVIEW_SESSION=""
ON_SCREEN=""
deadline=$((SECONDS + 180))
while [ "$SECONDS" -lt "$deadline" ]; do
	[ -n "$REVIEW_PANE" ] && REVIEW_SESSION="$(pane_session "$REVIEW_PANE")"
	[ -n "$REVIEW_SESSION" ] && grep -qF 'VERDICT: approve | request-changes' "$REVIEW_SESSION" 2>/dev/null && break
	sleep 1
done
ON_SCREEN="$(cat "$REVIEW_SESSION" 2>/dev/null)"
check "the seed carries the task the author was given" 'fork-marker.txt containing the word FORKED' "$ON_SCREEN"
check "the seed carries the diff under review" '\+FORKED' "$ON_SCREEN"
check "the seed carries the branch's worktree" "$FULL_PATH" "$ON_SCREEN"
check "the seed fixes the verdict shape" 'VERDICT: approve' "$ON_SCREEN"

# The author's own report is the material no git command produces. A fragment of
# it inside the reviewer's seed is the proof that the session was read and passed
# on — both the file path and the text have to be there.
check "the seed says where the author's session is" "$AUTHOR_SESSION" "$ON_SCREEN"
FRAGMENT="$(author_report_in_seed "$AUTHOR_SESSION" "$REVIEW_SESSION")"
if [ $? -eq 0 ] && [ -n "$FRAGMENT" ]; then
	ok "the seed carries the author's own report ($FRAGMENT)"
else
	fail "the author's report did not reach the reviewer (fragment: $FRAGMENT)"
fi

# Whether the reviewer *answered*, not whether the seed told it to: the seed's own
# "VERDICT: approve | request-changes" is a user message, so the last assistant
# text is the only place a real verdict can be.
reviewer_verdict() { # reviewer_verdict <reviewer session> -> the verdict line it ended with
	python3 - "$1" <<'PY'
import json, re, sys
texts = []
try:
    handle = open(sys.argv[1])
except OSError:
    handle = []
for line in handle:
    try:
        record = json.loads(line)
    except Exception:
        continue
    message = record.get("message") or {}
    if record.get("type") != "message" or message.get("role") != "assistant":
        continue
    for part in message.get("content") or []:
        if isinstance(part, dict) and part.get("type") == "text" and part.get("text", "").strip():
            texts.append(part["text"])
match = re.search(r"^VERDICT:\s*(approve|request-changes)\s*$", texts[-1] if texts else "", re.M)
print(match.group(0) if match else "")
PY
}

# A review that edits the worktree is not a review. The reviewer is left time to
# answer first, so this is checked against a session that has finished working.
VERDICT=""
deadline=$((SECONDS + 300))
while [ "$SECONDS" -lt "$deadline" ]; do
	VERDICT="$(reviewer_verdict "$REVIEW_SESSION")"
	[ -n "$VERDICT" ] && break
	sleep 5
done
if [ -n "$VERDICT" ]; then
	ok "the reviewer answers with a verdict ($VERDICT)"
else
	fail "the reviewer's last reply has no VERDICT line"
fi
if [ -z "$(git -C "$FULL_PATH" status --porcelain 2>/dev/null)" ]; then
	ok "the reviewer left the worktree alone"
else
	fail "the reviewer changed the worktree: $(git -C "$FULL_PATH" status --porcelain | head -3)"
fi

# ---------------------------------------------------------------- 10. linked worktree

# herdr refuses a linked worktree as `worktree.create`'s source, so a fork from
# one is created from the main checkout with the caller's own HEAD pinned. The
# commit here is what proves the pinning: it exists only in the linked worktree.

say "10. fork from a linked worktree (resolved to the main checkout)"
OUTER_BRANCH="$PREFIX/outer"
herdr pane send-text "$OBSERVER" "/fleet worktree create $OUTER_BRANCH --label outer-$$" >/dev/null 2>&1
sleep 0.7
herdr pane send-keys "$OBSERVER" enter >/dev/null 2>&1
deadline=$((SECONDS + 180))
while [ "$SECONDS" -lt "$deadline" ] && [ -z "$(worktree_field "$OUTER_BRANCH" path)" ]; do sleep 1; done
OUTER_PATH="$(worktree_field "$OUTER_BRANCH" path)"
OUTER_WS="$(worktree_field "$OUTER_BRANCH" open_workspace_id)"
if [ -n "$OUTER_PATH" ]; then
	ok "linked worktree opened on $OUTER_BRANCH at $OUTER_PATH"
else
	fail "the linked worktree was not created"
fi

# A commit that exists only here, and a change that was never committed.
printf 'outer\n' >"$OUTER_PATH/outer-marker.txt"
git -C "$OUTER_PATH" add -A
git -C "$OUTER_PATH" -c user.email=fleet@accept -c user.name=fleet commit -qm "outer base"
printf 'dirty\n' >>"$OUTER_PATH/outer-marker.txt"
OUTER_HEAD="$(git -C "$OUTER_PATH" rev-parse HEAD)"
ok "the linked worktree is at its own commit ($OUTER_HEAD), with an uncommitted change"

OUTER_OBSERVER="$(pane_in_workspace "$OUTER_WS")"
OUTER_SESSION="$SCRATCH/outer-observer.jsonl"
herdr agent start "fleet-outer-$$" --kind pi --pane "$OUTER_OBSERVER" --timeout 60000 \
	-- -ne -e "$EXTENSION" --session "$OUTER_SESSION" >/dev/null 2>&1
if [ $? -eq 0 ]; then
	ok "observer Pi started inside the linked worktree"
else
	fail "observer Pi did not start in the linked worktree"
fi
sleep 3

INNER_BRANCH="$PREFIX/inner"
INNER_TASK="Reply with the single word LINKED and do nothing else."
herdr pane send-text "$OUTER_OBSERVER" "/fleet fork $INNER_BRANCH --task \"$INNER_TASK\" --no-install" >/dev/null 2>&1
sleep 0.7
herdr pane send-keys "$OUTER_OBSERVER" enter >/dev/null 2>&1
INNER_TOASTS="$(await_fork "$INNER_BRANCH" yes "$OUTER_OBSERVER")"
INNER_PATH="$(worktree_field "$INNER_BRANCH" path)"
if [ -n "$INNER_PATH" ]; then
	ok "the fork from a linked worktree opened a worktree ($INNER_PATH)"
else
	fail "the fork from a linked worktree created no worktree"
	herdr pane read "$OUTER_OBSERVER" --source visible --lines 30 2>/dev/null | tail -20
fi

# The fork point is the caller's own commit, which exists nowhere else. The log
# is captured first: `grep -q` in a pipeline exits on the first match, and under
# `pipefail` that can turn a match into a failure.
INNER_LOG="$(git -C "$INNER_PATH" log --oneline 2>/dev/null)"
if printf '%s' "$INNER_LOG" | grep -q "outer base"; then
	ok "the fork point is the caller's HEAD, not the main checkout's"
else
	fail "the fork did not branch from the caller's HEAD: $(printf '%s' "$INNER_LOG" | head -3)"
fi
check "the uncommitted change was not carried in" '^outer$' "$(cat "$INNER_PATH/outer-marker.txt" 2>/dev/null)"
check "the fork says it was created from the main checkout" 'created from the main checkout at' "$INNER_TOASTS"
check "the fork says the uncommitted change stays behind" 'uncommitted changes' "$INNER_TOASTS"
INNER_PANE="$(pane_in_workspace "$(worktree_field "$INNER_BRANCH" open_workspace_id)" pi)"
[ -n "$INNER_PANE" ] && ok "the fork started a Pi session as usual ($INNER_PANE)" || fail "no Pi agent in the inner fork's workspace"

# ---------------------------------------------------------------- result

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]

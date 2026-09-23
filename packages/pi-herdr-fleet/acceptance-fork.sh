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
# The harness is shared with acceptance.sh, which stays the fast one.
#
#   packages/pi-herdr-fleet/acceptance-fork.sh
#
set -uo pipefail
source "$(cd "$(dirname "$0")" && pwd)/acceptance-lib.sh"

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
register_path "$SCRATCH"
register_path "$WT_PARENT"

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

# The registry in the harness removes every worktree this run recorded. This
# catches the one case that cannot record itself: a fork that died before the
# script could read its worktree back.
cleanup_fork_leftovers() {
	local workspace path
	while IFS=$'\t' read -r workspace path; do
		[ -n "$path" ] && direnv deny "$path" >/dev/null 2>&1
		[ -n "$workspace" ] && herdr worktree remove --workspace "$workspace" --force >/dev/null 2>&1
	done < <(fork_worktrees)
	direnv deny "$REPO" >/dev/null 2>&1
}
on_cleanup cleanup_fork_leftovers

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

# The 3c run record: the file the gate reads instead of a live pane.
run_file() { # run_file <branch>
	printf '%s/.pi/herdr-fleet/runs/%s.json' "$REPO" "$(printf '%s' "$1" | tr '/' '-')"
}

run_field() { # run_field <branch> <dotted key>
	python3 - "$(run_file "$1")" "$2" <<'PY'
import json, sys
try:
    node = json.load(open(sys.argv[1]))
except Exception:
    node = {}
for key in sys.argv[2].split("."):
    node = node.get(key) if isinstance(node, dict) else None
print("" if node is None else node)
PY
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
# comes after the seed, so a caller that reads the toast keeps sampling past the
# point where the work is done — a toast only lives on screen for a few seconds.
# A caller that only needs the fork to have happened passes `dwell 0` and skips
# that wait; the agent is still awaited either way.
await_fork() { # await_fork <branch> <yes|no: expect an agent> [pane] [dwell seconds] -> the sampled screen
	local branch="$1" want_agent="$2" pane="${3:-$OBSERVER}" dwell="${4:-25}" deadline=$((SECONDS + 300)) text="" done_at=""
	while [ "$SECONDS" -lt "$deadline" ]; do
		text="$text$(history "$pane")"
		if [ -n "$(worktree_field "$branch" path)" ]; then
			if [ "$want_agent" = "no" ]; then
				[ -n "$done_at" ] || done_at=$SECONDS
			elif [ -n "$(pane_in_workspace "$(worktree_field "$branch" open_workspace_id)" pi)" ]; then
				[ -n "$done_at" ] || done_at=$SECONDS
			fi
		fi
		if [ -n "$done_at" ] && [ $((SECONDS - done_at)) -ge "$dwell" ]; then break; fi
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

fleet_preflight
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
if ! new_workspace "$REPO" "fleet-fork-accept-$$"; then
	fail "could not open an observer workspace"
	exit 1
fi
OBSERVER_WS="$FLEET_NEW_WORKSPACE"
OBSERVER="$FLEET_NEW_PANE"
if [ -z "$OBSERVER" ]; then
	fail "could not open an observer workspace"
	exit 1
fi
printf '   observer: %s (%s)\n' "$OBSERVER" "$OBSERVER_WS"
start_observer "observer Pi started with the extension" "fleet-fork-accept-$$" "$OBSERVER" --session "$OBSERVER_SESSION" || exit 1

# ---------------------------------------------------------------- 3. full fork

say "3. fork --base HEAD: worktree, environment, install, pane, Pi, seed"
BRANCH="$PREFIX/full"
TASK="Create a file named fork-marker.txt containing the word FORKED, then commit it."
fork "$BRANCH" "$TASK" --base HEAD
TOASTS="$(await_fork "$BRANCH" yes)"
FULL_PATH="$(worktree_field "$BRANCH" path)"
FULL_WS="$(worktree_field "$BRANCH" open_workspace_id)"
register_worktree "$FULL_WS" "$FULL_PATH"
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
	dump_pane "$FULL_PANE" 20
fi

# And the session is working, not just seeded: the task asks for a commit. Wait
# for the commit to be the one that carries the file, not for any commit at all —
# the base commit is already there.
deadline=$((SECONDS + 360))
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
await_fork "$BRANCH" yes "" 0 >/dev/null
NOLOCK_PATH="$(worktree_field "$BRANCH" path)"
NOLOCK_WS="$(worktree_field "$BRANCH" open_workspace_id)"
register_worktree "$NOLOCK_WS" "$NOLOCK_PATH"
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
NOLOCK_PANE="$(pane_in_workspace "$NOLOCK_WS" pi)"
[ -n "$NOLOCK_PANE" ] && ok "the pane and the agent were still created" || fail "no pane in the fork's workspace"

# ---------------------------------------------------------------- 5. --no-install

say "5. fork --no-install: the lockfile is ignored on request"
BRANCH="$PREFIX/noinstall"
fork "$BRANCH" "Reply with the single word NOINSTALL and do nothing else." --base HEAD --no-install
await_fork "$BRANCH" yes "" 0 >/dev/null
NOINSTALL_PATH="$(worktree_field "$BRANCH" path)"
register_worktree "$(worktree_field "$BRANCH" open_workspace_id)" "$NOINSTALL_PATH"
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
await_fork "$BRANCH" no "" 0 >/dev/null
NOSTART_PATH="$(worktree_field "$BRANCH" path)"
NOSTART_WS="$(worktree_field "$BRANCH" open_workspace_id)"
register_worktree "$NOSTART_WS" "$NOSTART_PATH"
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
await_fork "$BRANCH" yes "" 0 >/dev/null
TOOL_PATH="$(worktree_field "$BRANCH" path)"
TOOL_WS="$(worktree_field "$BRANCH" open_workspace_id)"
register_worktree "$TOOL_WS" "$TOOL_PATH"
if [ -n "$TOOL_PATH" ]; then
	ok "the tool created a worktree ($TOOL_PATH)"
else
	fail "the agent's fleet_fork call created no worktree"
	dump_pane "$OBSERVER" 20
fi
TOOL_PANE="$(pane_in_workspace "$TOOL_WS" pi)"
[ -n "$TOOL_PANE" ] && ok "the tool started a Pi session in it ($TOOL_PANE)" || fail "no Pi agent from the tool path"

# The tool result is a conversation entry, so the observer's own session is where
# to see that the call happened and what it returned.
#
# The forked pane's session path is re-read every turn: the pane exists as soon
# as `pane.split` returns, but herdr only reports the agent's session once Pi has
# started in it, so a path read once can still be empty.
TOOL_SEEN=""
SEEDED=""
SESSION_FILE=""
deadline=$((SECONDS + 300))
while [ "$SECONDS" -lt "$deadline" ]; do
	[ -n "$TOOL_PANE" ] && SESSION_FILE="$(pane_session "$TOOL_PANE")"
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
	dump_pane "$OBSERVER" 20
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
deadline=$((SECONDS + 300))
while [ "$SECONDS" -lt "$deadline" ]; do
	REVIEW_PANE="$(pane_by_agent_name "$FULL_WS" "$REVIEW_AGENT")"
	[ -n "$REVIEW_PANE" ] && break
	sleep 1
done
if [ -n "$REVIEW_PANE" ]; then
	ok "the reviewer runs in the author's worktree ($REVIEW_PANE, agent $REVIEW_AGENT)"
else
	fail "no reviewer pane appeared in $FULL_WS"
	dump_pane "$OBSERVER" 20
fi

# The seed is the evidence: it has to arrive as a message, and it has to carry
# the task, the diff and the author's own words. The screen cannot tell a
# submitted message from text sitting in an editor.
REVIEW_SESSION=""
ON_SCREEN=""
deadline=$((SECONDS + 300))
while [ "$SECONDS" -lt "$deadline" ]; do
	[ -n "$REVIEW_PANE" ] && REVIEW_SESSION="$(pane_session "$REVIEW_PANE")"
	[ -n "$REVIEW_SESSION" ] && grep -qF 'fleet_verdict' "$REVIEW_SESSION" 2>/dev/null && break
	sleep 1
done
ON_SCREEN="$(cat "$REVIEW_SESSION" 2>/dev/null)"
check "the seed carries the task the author was given" 'fork-marker.txt containing the word FORKED' "$ON_SCREEN"
check "the seed carries the diff under review" '\+FORKED' "$ON_SCREEN"
check "the seed carries the branch's worktree" "$FULL_PATH" "$ON_SCREEN"
check "the seed fixes the verdict as a fleet_verdict call" 'fleet_verdict' "$ON_SCREEN"

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

# Whether the reviewer *answered*, not whether the seed told it to: the verdict
# is recorded through `fleet_verdict`, so the run's record is the only place a
# real verdict can be — the seed's own text is a user message, and the reply is prose.
VERDICT=""
deadline=$((SECONDS + 420))
while [ "$SECONDS" -lt "$deadline" ]; do
	VERDICT="$(run_field "$FULL_BRANCH" verdict.verdict)"
	[ -n "$VERDICT" ] && break
	sleep 5
done
if [ -n "$VERDICT" ]; then
	ok "the reviewer answers with a verdict ($VERDICT)"
else
	fail "the reviewer recorded no verdict through fleet_verdict"
fi
# A review that edits the worktree is not a review. The reviewer was given time
# to answer first, so this is checked against a session that has finished working.
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
register_worktree "$OUTER_WS" "$OUTER_PATH"
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
start_observer "observer Pi started inside the linked worktree" "fleet-outer-$$" "$OUTER_OBSERVER" --session "$OUTER_SESSION"

INNER_BRANCH="$PREFIX/inner"
INNER_TASK="Reply with the single word LINKED and do nothing else."
herdr pane send-text "$OUTER_OBSERVER" "/fleet fork $INNER_BRANCH --task \"$INNER_TASK\" --no-install" >/dev/null 2>&1
sleep 0.7
herdr pane send-keys "$OUTER_OBSERVER" enter >/dev/null 2>&1
INNER_TOASTS="$(await_fork "$INNER_BRANCH" yes "$OUTER_OBSERVER")"
INNER_PATH="$(worktree_field "$INNER_BRANCH" path)"
INNER_WS="$(worktree_field "$INNER_BRANCH" open_workspace_id)"
register_worktree "$INNER_WS" "$INNER_PATH"
if [ -n "$INNER_PATH" ]; then
	ok "the fork from a linked worktree opened a worktree ($INNER_PATH)"
else
	fail "the fork from a linked worktree created no worktree"
	dump_pane "$OUTER_OBSERVER" 20
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
INNER_PANE="$(pane_in_workspace "$INNER_WS" pi)"
[ -n "$INNER_PANE" ] && ok "the fork started a Pi session as usual ($INNER_PANE)" || fail "no Pi agent in the inner fork's workspace"

# ---------------------------------------------------------------- 11. verdict and merge gate

# 3c: the record is a file, the verdict is a tool call, and the merge gate reads
# only that. Everything here runs on the scratch repository, and the merge is a
# real one — into `$REPO`, never into the repository this script lives in.

say "11. run record, /fleet status, and the gate before any verdict"
GATE_BRANCH="$PREFIX/gate"
GATE_TASK="Create a file named gate-marker.txt containing the word GATE, then commit it."
fork "$GATE_BRANCH" "$GATE_TASK" --base HEAD
await_fork "$GATE_BRANCH" yes "" 0 >/dev/null
GATE_PATH="$(worktree_field "$GATE_BRANCH" path)"
GATE_WS="$(worktree_field "$GATE_BRANCH" open_workspace_id)"
register_worktree "$GATE_WS" "$GATE_PATH"
GATE_PANE="$(pane_in_workspace "$GATE_WS" pi)"
if [ -n "$GATE_PATH" ] && [ -n "$GATE_PANE" ]; then
	ok "the gate branch was forked ($GATE_PATH, pane $GATE_PANE)"
else
	fail "the gate branch was not forked"
fi

deadline=$((SECONDS + 300))
while [ "$SECONDS" -lt "$deadline" ]; do
	if git -C "$GATE_PATH" log -1 --name-only --oneline 2>/dev/null | grep -q gate-marker.txt; then break; fi
	sleep 2
done
check "the gate branch carries the committed work" 'GATE' "$(cat "$GATE_PATH/gate-marker.txt" 2>/dev/null)"

GATE_RUN="$(run_file "$GATE_BRANCH")"
if [ -f "$GATE_RUN" ]; then
	ok "the fork wrote a run record ($GATE_RUN)"
else
	fail "the fork wrote no run record"
fi
check "the record carries the branch and the scope" "\"branch\": \"$GATE_BRANCH\"" "$(cat "$GATE_RUN" 2>/dev/null)"
check "the record carries the base the fork used" '"base":' "$(cat "$GATE_RUN" 2>/dev/null)"

# `/fleet status` prints one line per run: branch · scope · state · verdict.
status() { herdr pane send-text "$OBSERVER" "/fleet status" >/dev/null 2>&1; sleep 0.7; herdr pane send-keys "$OBSERVER" enter >/dev/null 2>&1; }
status
STATUS_TEXT=""
deadline=$((SECONDS + 60))
while [ "$SECONDS" -lt "$deadline" ]; do
	STATUS_TEXT="$(history "$OBSERVER")"
	printf '%s' "$STATUS_TEXT" | grep -q "$GATE_BRANCH · implementation" && break
	sleep 1
done
check "status lists the run with its scope" "$GATE_BRANCH · implementation · (作業中|working)" "$STATUS_TEXT"
observed "status line" "$GATE_BRANCH · implementation · .*" "$STATUS_TEXT"

# The gate has to refuse while no verdict exists, and git must not run.
merge() { herdr pane send-text "$OBSERVER" "/fleet merge $1 $2" >/dev/null 2>&1; sleep 0.7; herdr pane send-keys "$OBSERVER" enter >/dev/null 2>&1; }
merge "$GATE_BRANCH" ""
REFUSED_TEXT=""
deadline=$((SECONDS + 60))
while [ "$SECONDS" -lt "$deadline" ]; do
	REFUSED_TEXT="$(history "$OBSERVER")"
	printf '%s' "$REFUSED_TEXT" | grep -q 'no approve verdict' && break
	sleep 1
done
check "the gate refuses a branch with no approve" 'no approve verdict' "$REFUSED_TEXT"
observed "gate refusal" 'merge: .*no approve verdict.*' "$REFUSED_TEXT"
if git -C "$REPO" log --oneline 2>/dev/null | grep -q 'gate-marker'; then
	fail "the refused merge still merged"
else
	ok "the refused merge left main alone"
fi

# ---------------------------------------------------------------- 12. reviewer

# The reviewer records its verdict with `fleet_verdict`, which is what the gate
# reads — and only the pane the run recorded as the reviewer may call it.

say "12. the reviewer's fleet_verdict and the pane check"
review "$GATE_BRANCH" "$GATE_TASK"
GATE_REVIEW_PANE=""
deadline=$((SECONDS + 420))
while [ "$SECONDS" -lt "$deadline" ]; do
	GATE_REVIEW_PANE="$(run_field "$GATE_BRANCH" reviewer.paneId)"
	[ -n "$GATE_REVIEW_PANE" ] && break
	sleep 1
done
if [ -n "$GATE_REVIEW_PANE" ]; then
	ok "the review started, and the run recorded its reviewer ($GATE_REVIEW_PANE)"
else
	fail "the review recorded no reviewer pane"
	dump_pane "$OBSERVER" 20
fi
REVIEW_AGENT="$(run_field "$GATE_BRANCH" reviewer.agentName)"
[ -n "$REVIEW_AGENT" ] && ok "the record names the reviewer's agent ($REVIEW_AGENT)" || fail "the record has no reviewer agent"

# The reviewer is a real model in a real pane: give it time to read, judge and
# call the tool. The record is the evidence, not the screen.
VERDICT=""
deadline=$((SECONDS + 600))
while [ "$SECONDS" -lt "$deadline" ]; do
	VERDICT="$(run_field "$GATE_BRANCH" verdict.verdict)"
	[ -n "$VERDICT" ] && break
	sleep 5
done
if [ -n "$VERDICT" ]; then
	ok "the reviewer recorded a verdict with fleet_verdict ($VERDICT)"
else
	fail "the reviewer never called fleet_verdict"
	dump_pane "$GATE_REVIEW_PANE" 20
fi

# The extension is loaded in every session, so the pane check is what keeps a
# verdict to the reviewer — the observer's own pane must be refused.
ask "Call the fleet_verdict tool with verdict \"approve\" and findings []. Report the exact error you get, and do not retry."
STRANGER=""
deadline=$((SECONDS + 240))
while [ "$SECONDS" -lt "$deadline" ]; do
	if grep -aq 'not the reviewer' "$OBSERVER_SESSION" 2>/dev/null; then STRANGER="yes"; break; fi
	sleep 1
done
if [ -n "$STRANGER" ]; then
	ok "a pane that is not the reviewer is refused a verdict"
else
	fail "the observer was allowed to write a verdict"
	dump_pane "$OBSERVER" 20
fi

# ---------------------------------------------------------------- 13. the gate opens

# This is the reason the verdict lives in a file: close the reviewer's pane, and
# the gate still sees the approve. The merge then really happens, in $REPO.
say "13. the verdict survives the reviewer's pane, and the merge runs"
if [ "$VERDICT" = "approve" ]; then
	herdr pane close "$GATE_REVIEW_PANE" >/dev/null 2>&1
	sleep 3
	if herdr pane get "$GATE_REVIEW_PANE" >/dev/null 2>&1; then
		fail "the reviewer's pane is still open"
	else
		ok "the reviewer's pane is closed"
	fi
	check "the approve is still in the run record" '"verdict": "approve"' "$(cat "$GATE_RUN" 2>/dev/null)"

	merge "$GATE_BRANCH" ""
	MERGED_TEXT=""
	deadline=$((SECONDS + 120))
	while [ "$SECONDS" -lt "$deadline" ]; do
		MERGED_TEXT="$(history "$OBSERVER")"
		printf '%s' "$MERGED_TEXT" | grep -qE "merge $GATE_BRANCH 完了|Merged $GATE_BRANCH" && break
		sleep 1
	done
	check "the merge runs with the reviewer gone" "merge $GATE_BRANCH 完了|Merged $GATE_BRANCH" "$MERGED_TEXT"
	observed "merge result" "merge $GATE_BRANCH 完了.*|Merged $GATE_BRANCH.*" "$MERGED_TEXT"
	check "main now carries the merged work" 'GATE' "$(cat "$REPO/gate-marker.txt" 2>/dev/null)"

	status
	STATUS_AFTER=""
	deadline=$((SECONDS + 60))
	while [ "$SECONDS" -lt "$deadline" ]; do
		STATUS_AFTER="$(history "$OBSERVER")"
		printf '%s' "$STATUS_AFTER" | grep -qE 'マージ済み|merged' && break
		sleep 1
	done
	check "status shows the run as merged" 'マージ済み|merged' "$STATUS_AFTER"
	observed "status line" "$GATE_BRANCH · implementation · .*" "$STATUS_AFTER"
else
	fail "the reviewer did not approve (verdict: ${VERDICT:-none}), so the gate could not be shown to open"
fi

# ---------------------------------------------------------------- 14. review tool

# `fleet_review` as a tool, not a command: this is the call an agent makes in the
# loop, with its arguments validated by the schema before `reviewWorktree` sees
# them. The branch here is the one section 7 forked through `fleet_fork`, so the
# whole loop — fork, review — is exercised through tools. The reviewer's verdict
# is not asserted: this is about the tool being callable and being recorded as
# the reviewer, and its worktree is empty so it has nothing to approve.

say "14. fleet_review as a tool"
TOOL_REVIEW_BRANCH="$PREFIX/tool"
TOOL_REVIEW_TASK="Reply with the single word TOOLMARKER and do nothing else."
ask "Call the fleet_review tool exactly once with branch \"$TOOL_REVIEW_BRANCH\" and task \"$TOOL_REVIEW_TASK\". Then stop."
TOOL_REVIEW_PANE=""
deadline=$((SECONDS + 420))
while [ "$SECONDS" -lt "$deadline" ]; do
	TOOL_REVIEW_PANE="$(run_field "$TOOL_REVIEW_BRANCH" reviewer.paneId)"
	[ -n "$TOOL_REVIEW_PANE" ] && break
	sleep 1
done
if [ -n "$TOOL_REVIEW_PANE" ]; then
	ok "the fleet_review tool started a reviewer in the author's worktree ($TOOL_REVIEW_PANE)"
else
	fail "the fleet_review tool started no reviewer"
	dump_pane "$OBSERVER" 20
fi
check "the tool result reached the observer's conversation" "reviewing $TOOL_REVIEW_BRANCH" "$(grep -a "reviewing $TOOL_REVIEW_BRANCH" "$OBSERVER_SESSION" 2>/dev/null | tail -1)"
TOOL_REVIEW_AGENT="$(run_field "$TOOL_REVIEW_BRANCH" reviewer.agentName)"
[ -n "$TOOL_REVIEW_AGENT" ] && ok "the tool path recorded its reviewer ($TOOL_REVIEW_AGENT)" || fail "the tool path recorded no reviewer"

# ---------------------------------------------------------------- 15. audit log

# herdr keeps no history, so the fleet's lifecycle is written into the observer's
# session as it happens — that is what makes "why did we abandon that worktree?"
# answerable a month later. Section 3 forked `$PREFIX/full`, whose creation is
# the one to look for; section 6's `--no-start` worktree is the one nothing else
# needs, so it is the one removed here.

say "15. audit log: herdr lifecycle becomes session entries"
audit_entry() { # audit_entry <fixed fragment of the summary>
	grep -a 'herdr-event' "$OBSERVER_SESSION" 2>/dev/null | grep -aF "$1" | tail -1
}

deadline=$((SECONDS + 30))
while [ "$SECONDS" -lt "$deadline" ]; do
	[ -n "$(audit_entry "worktree created $PREFIX/full")" ] && break
	sleep 1
done
check "a created worktree is a herdr-event entry" "customType.:.herdr-event.*worktree created $PREFIX/full" "$(audit_entry "worktree created $PREFIX/full")"

herdr worktree remove --workspace "$NOSTART_WS" --force >/dev/null 2>&1
sleep 2
check "a forced removal says so" "customType.:.herdr-event.*worktree removed $PREFIX/nostart \(forced\)" "$(audit_entry "worktree removed $PREFIX/nostart")"

# ---------------------------------------------------------------- 16. status and merge tools

# The loop has to close without a human at the keyboard. `/fleet status` and
# `/fleet merge` were commands, and an agent cannot type one; both are tools now.
# This is the only place the tool path runs end to end — a real model calling
# `fleet_status` for the list, being refused a merge with no approve, and being
# allowed it once the approve is recorded. The merge runs in the scratch
# repository, never in the repository this script lives in.

say "16. fleet_status and fleet_merge as tools"
TOOL_GATE_BRANCH="$PREFIX/toolgate"
# A branch with a real commit on it, so the merge has something to bring in. It
# is built in the gate worktree, which is already merged and idle by now.
git -C "$GATE_PATH" checkout -q -b "$TOOL_GATE_BRANCH"
printf 'TOOLGATE\n' >"$GATE_PATH/toolgate-marker.txt"
git -C "$GATE_PATH" add toolgate-marker.txt
git -C "$GATE_PATH" -c user.email=fleet@accept -c user.name=fleet commit -qm "toolgate"
# The record, with no verdict: the gate has to refuse it. That a real reviewer
# writes an approve is section 12's subject; what is under test here is the gate
# the tool drives.
python3 - "$(run_file "$GATE_BRANCH")" "$(run_file "$TOOL_GATE_BRANCH")" "$TOOL_GATE_BRANCH" <<'PY'
import json, sys
record = json.load(open(sys.argv[1]))
for key in ("verdict", "reviewer", "mergedAt"):
    record.pop(key, None)
record["branch"] = sys.argv[3]
json.dump(record, open(sys.argv[2], "w"), indent=2)
PY
if [ -f "$(run_file "$TOOL_GATE_BRANCH")" ]; then
	ok "a run with no verdict is on record for the tool merge"
else
	fail "no run record was written for $TOOL_GATE_BRANCH"
fi

# The list is the agent's view of the loop, returned as a tool result.
ask "Call the fleet_status tool exactly once. It takes no arguments. Then stop."
STATUS_TOOL=""
deadline=$((SECONDS + 240))
while [ "$SECONDS" -lt "$deadline" ]; do
	if grep -aq "$TOOL_GATE_BRANCH · implementation · working" "$OBSERVER_SESSION" 2>/dev/null; then STATUS_TOOL="yes"; break; fi
	sleep 1
done
if [ -n "$STATUS_TOOL" ]; then
	ok "the agent's fleet_status call returned the run list"
else
	fail "the agent's fleet_status call returned no run list"
	dump_pane "$OBSERVER" 20
fi
check "the tool's list carries branch, scope, state and verdict" "$TOOL_GATE_BRANCH · implementation · working · -" "$(grep -a "$TOOL_GATE_BRANCH" "$OBSERVER_SESSION" 2>/dev/null | tail -1)"

# No approve: the tool must refuse, and git must not run.
ask "Call the fleet_merge tool with branch \"$TOOL_GATE_BRANCH\". Report the exact error you get, and do not retry or use another tool."
TOOL_REFUSED=""
deadline=$((SECONDS + 240))
while [ "$SECONDS" -lt "$deadline" ]; do
	if grep -aq 'no approve verdict' "$OBSERVER_SESSION" 2>/dev/null; then TOOL_REFUSED="yes"; break; fi
	sleep 1
done
if [ -n "$TOOL_REFUSED" ]; then
	ok "the tool refused a merge with no approve"
else
	fail "the tool did not refuse the merge"
	dump_pane "$OBSERVER" 20
fi
if [ -f "$REPO/toolgate-marker.txt" ]; then
	fail "the refused tool merge still merged"
else
	ok "the refused tool merge left main alone"
fi

# With the approve recorded, the same call goes through.
python3 - "$(run_file "$TOOL_GATE_BRANCH")" <<'PY'
import json, sys
record = json.load(open(sys.argv[1]))
record["verdict"] = {"verdict": "approve", "findings": [], "at": "2020-01-01T00:00:00.000Z"}
json.dump(record, open(sys.argv[1], "w"), indent=2)
PY
ask "Call the fleet_merge tool with branch \"$TOOL_GATE_BRANCH\". Then stop."
TOOL_MERGED=""
deadline=$((SECONDS + 240))
while [ "$SECONDS" -lt "$deadline" ]; do
	if grep -aq "merged $TOOL_GATE_BRANCH" "$OBSERVER_SESSION" 2>/dev/null; then TOOL_MERGED="yes"; break; fi
	sleep 1
done
if [ -n "$TOOL_MERGED" ]; then
	ok "the tool merged the approved branch"
else
	fail "the tool did not merge the approved branch"
	dump_pane "$OBSERVER" 20
fi
check "main now carries the tool-merged work" 'TOOLGATE' "$(cat "$REPO/toolgate-marker.txt" 2>/dev/null)"
check "the tool reports the surviving worktree" 'worktree was left in place' "$(grep -a "merged $TOOL_GATE_BRANCH" "$OBSERVER_SESSION" 2>/dev/null | tail -1)"
if git -C "$REPO" worktree list --porcelain 2>/dev/null | grep -qF "worktree $GATE_PATH"; then
	ok "the worktree survived the merge"
else
	fail "the merge removed the worktree"
fi

# ---------------------------------------------------------------- result

fleet_result

#!/usr/bin/env bash
#
# End-to-end acceptance for `/fleet view`, against a real herdr server and real
# Pi sessions. `selfcheck.ts` covers the reading and the rendering against a fake
# socket; this covers what only exists when herdr, Pi and a session JSONL are all
# real: which pane herdr says a session belongs to, and what a live session
# actually contains.
#
# Four panes besides the caller are needed:
#
#   observer  Pi with this extension, in a scratch checkout: the self row, and
#             the pane the overlay is drawn in
#   idle      a real Pi agent that has answered once: model, cost, last user
#   working   a real Pi agent busy inside `sleep`: the state, and the tool call
#             the detail view reports as running
#   shell     a plain shell with no agent: the row that has no Pi session
#
# The observer runs in its own workspace, because the overlay needs a full-height
# pane to show a whole fleet at once. The subjects and the observer load herdr's
# own Pi integration, which is what reports `agent_session.value` to herdr; `-ne`
# on the observer would hide its session, so the integration is passed explicitly
# beside this extension.
#
# A model is needed: the subjects and the observer have to produce real usage for
# the view to have something to read. The scratch checkout gets this repository's
# `.env` and `.envrc`, so direnv supplies the same environment the repository does.
#
# Run it from inside a herdr pane (HERDR_ENV=1) anywhere in this repository.
# It closes only the panes and workspaces it created, and removes only its own
# scratch.
#
#   packages/pi-herdr-fleet/acceptance-view.sh
#
set -uo pipefail
source "$(cd "$(dirname "$0")" && pwd)/acceptance-lib.sh"

SCRATCH="$(mktemp -d -t fleet-view-accept)"
REPO="$SCRATCH/repo"
REPO_REAL=""
PREFIX="fleet-view-$$"
register_path "$SCRATCH"

# herdr installs this beside the Pi config; it is what tells herdr a pane's
# session path, and the whole point of the view is that path.
HERDR_INTEGRATION="$HOME/.pi/agent/extensions/herdr-agent-state.ts"

OBSERVER=""
IDLE_PANE=""
WORKING_PANE=""
SHELL_PANE=""
IDLE_SESSION=""
OBSERVER_SESSION=""

# The harness runs registered hooks as commands, so this has to be a function.
cleanup_view() { direnv deny "$REPO" >/dev/null 2>&1; }
on_cleanup cleanup_view

# ---------------------------------------------------------------- helpers

pane_field() { # pane_field <pane> <field>
	herdr pane list 2>/dev/null | python3 -c '
import json, sys
try:
    panes = json.load(sys.stdin)["result"]["panes"]
except Exception:
    panes = []
match = next((p for p in panes if p["pane_id"] == sys.argv[1]), None)
if sys.argv[2] == "agent_session":
    value = ((match or {}).get("agent_session") or {}).get("value", "")
else:
    value = (match or {}).get(sys.argv[2])
print("" if value is None else value)
' "$1" "$2"
}

agent_state() { pane_field "$1" agent_status; }
session_of() { pane_field "$1" agent_session; }

wait_for() { # wait_for <description> <seconds> <command...>
	local description="$1" seconds="$2"
	shift 2
	local deadline=$((SECONDS + seconds))
	while [ "$SECONDS" -lt "$deadline" ]; do
		if "$@"; then ok "$description"; return 0; fi
		sleep 1
	done
	fail "$description (timed out)"
	return 1
}

has_assistant() { grep -q '"role":"assistant"' "$1" 2>/dev/null; }
is_state() { [ "$(agent_state "$1")" = "$2" ]; }
is_idle() { case "$(agent_state "$1")" in idle | done) return 0 ;; *) return 1 ;; esac; }

start_subject() { # start_subject <description> <agent name> <pane> [pi args...]
	local description="$1" name="$2" pane="$3"
	shift 3
	if herdr agent start "$name" --kind pi --pane "$pane" --timeout 60000 -- "$@" >/dev/null 2>&1; then
		ok "$description"
	else
		fail "$description"
		dump_pane "$pane"
		return 1
	fi
	sleep "$FLEET_OBSERVER_SETTLE"
}

prompt() { # prompt <pane> <text>
	herdr pane send-text "$1" "$2" >/dev/null 2>&1
	sleep 0.5
	herdr pane send-keys "$1" enter >/dev/null 2>&1
}

# The overlay is a snapshot: one fetch when it opens, another on `r`. Nothing
# here waits on a live update, because there is none. The wait is for the fetch
# itself: `/fleet view` in the editor already contains the words, and the title
# paints before the rows (the snapshot and every session tail are read on open,
# and keys are ignored while that is in flight), so only the calling pane's row
# proves the list is ready to be read.
open_view() {
	herdr pane send-text "$OBSERVER" "/fleet view" >/dev/null 2>&1
	sleep 0.5
	herdr pane send-keys "$OBSERVER" enter >/dev/null 2>&1
	wait_ready "$OBSERVER" 60
}

# Wait until a row for `$1` is on the overlay's screen.
wait_ready() { # wait_ready <pane id> [seconds]
	local deadline=$((SECONDS + ${2:-60}))
	while [ "$SECONDS" -lt "$deadline" ]; do
		screen "$OBSERVER" | grep -qE 'fleet view ·' || { sleep 1; continue; }
		screen "$OBSERVER" | grep -qF "$1" && return 0
		sleep 1
	done
	return 1
}

# Walk the selection to a pane and leave it there. The list can be longer than
# the overlay, so a row is read by selecting it rather than by being on screen.
select_pane() { # select_pane <pane id>
	local i
	for i in $(seq 1 40); do herdr pane send-keys "$OBSERVER" up >/dev/null 2>&1; done
	sleep 0.5
	for i in $(seq 1 40); do
		if screen "$OBSERVER" | grep -qE "> .*$1"; then return 0; fi
		herdr pane send-keys "$OBSERVER" down >/dev/null 2>&1
		sleep 0.2
	done
	return 1
}

selected_row() { # selected_row <pane id>
	select_pane "$1" || return 1
	screen "$OBSERVER" | grep -E "> .*$1" | head -1
}

# The row is cut from the right, so a field that comes first is the one that
# survives a narrow pane. Presence alone would pass on the old order.
check_order() { # check_order <description> <text> <first> <second>
	if python3 -c '
import sys
text, first, second = sys.argv[1], sys.argv[2], sys.argv[3]
a, b = text.find(first), text.find(second)
sys.exit(0 if 0 <= a < b else 1)
' "$2" "$3" "$4"; then
		ok "$1"
	else
		fail "$1 ($3 must come before $4)"
	fi
}

check_once() { # check_once <description> <text> <literal>
	local count
	count="$(printf '%s' "$2" | grep -oF "$3" | wc -l | tr -d ' ')"
	if [ "$count" = "1" ]; then ok "$1"; else fail "$1 ($3 appears $count times)"; fi
}

# ---------------------------------------------------------------- preflight

fleet_preflight
if [ ! -f "$HERDR_INTEGRATION" ]; then
	echo "missing herdr's Pi integration: $HERDR_INTEGRATION" >&2
	exit 2
fi
if [ ! -f "$FLEET_ROOT/.envrc" ]; then
	printf 'warning: no .envrc at %s; the sessions may have no API key\n' "$FLEET_ROOT" >&2
fi

# ---------------------------------------------------------------- 1. scratch repo

# A real checkout, because the detail view names the worktree branch and the
# branch comes from `worktree.list`. It carries this repository's environment so
# the Pi sessions started in it have a provider.
say "1. scratch repository"
mkdir -p "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" -c user.email=fleet@example.com -c user.name=fleet commit -q --allow-empty -m "view acceptance"
cp "$FLEET_ROOT/.env" "$REPO/.env" 2>/dev/null || true
cp "$FLEET_ROOT/.envrc" "$REPO/.envrc" 2>/dev/null || true
direnv allow "$REPO" >/dev/null 2>&1
mkdir -p "$SCRATCH/sessions"
REPO_REAL="$(cd "$REPO" && pwd -P)"
if [ -n "$(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null)" ]; then
	ok "scratch repository is on a branch"
else
	fail "scratch repository has no branch"
fi

# ---------------------------------------------------------------- 2. panes

# The observer gets its own workspace: an overlay squeezed into half a pane
# cannot show a fleet at once, and the point is to read the rows without
# switching panes. The subjects are split off the shell pane below it, so the
# observer keeps the full width the rows need.
say "2. panes: observer, a plain shell, an idle subject, a working subject"
if ! new_workspace "$REPO" "$PREFIX-view"; then
	echo "could not create the observer workspace" >&2
	exit 1
fi
OBSERVER="$FLEET_NEW_PANE"
sleep 1
if ! split_pane "$OBSERVER" down "$REPO"; then
	echo "could not split the shell pane" >&2
	exit 1
fi
SHELL_PANE="$FLEET_NEW_PANE"
sleep 1
if ! split_pane "$SHELL_PANE" right "$REPO"; then
	echo "could not split the idle subject" >&2
	exit 1
fi
IDLE_PANE="$FLEET_NEW_PANE"
sleep 1
if ! split_pane "$IDLE_PANE" right "$REPO"; then
	echo "could not split the working subject" >&2
	exit 1
fi
WORKING_PANE="$FLEET_NEW_PANE"
sleep 1

# ---------------------------------------------------------------- 3. subjects

say "3. real Pi sessions: one idle, one working"
# The subjects run with herdr's own integration loaded, so herdr learns their
# session path — which is the only way a pane's session can reach the view.
start_subject "the idle subject started" "$PREFIX-idle" "$IDLE_PANE" --session-dir "$SCRATCH/sessions" || exit 1
start_subject "the working subject started" "$PREFIX-working" "$WORKING_PANE" --session-dir "$SCRATCH/sessions" || exit 1

IDLE_SESSION="$(session_of "$IDLE_PANE")"
WORKING_SESSION="$(session_of "$WORKING_PANE")"
if [ -n "$IDLE_SESSION" ] && [ -n "$WORKING_SESSION" ]; then
	ok "herdr knows both subjects' session files"
else
	fail "herdr reported no session for a subject (idle=$IDLE_SESSION working=$WORKING_SESSION)"
fi

prompt "$IDLE_PANE" "Reply with exactly: VIEW-A-DONE"
# The working subject has to stay working while the observer starts, answers its
# own turn, and then two rounds of select_pane run (up to 40 key sends each), so
# the sleep is minutes rather than the seconds the checks themselves take. The
# script never waits for it to finish; cleanup closes the pane.
prompt "$WORKING_PANE" "Use the bash tool to run sleep 300, then reply with exactly: VIEW-B-DONE"

wait_for "the idle subject produced an assistant message" 180 has_assistant "$IDLE_SESSION"
wait_for "the idle subject is idle again" 60 is_idle "$IDLE_PANE"
wait_for "the working subject is working" 60 is_state "$WORKING_PANE" working

# ---------------------------------------------------------------- 4. observer

say "4. observer pane (Pi + this extension + herdr's integration)"
start_observer "observer Pi started with its session reported" "$PREFIX-observer" "$OBSERVER" \
	--session-dir "$SCRATCH/sessions" -e "$HERDR_INTEGRATION" || exit 1
OBSERVER_SESSION="$(session_of "$OBSERVER")"
if [ -n "$OBSERVER_SESSION" ]; then
	ok "herdr knows the observer's own session too"
else
	fail "herdr does not know the observer's session"
fi
# One turn, so the observer's own row has a model and a cost to show: Pi only
# writes the session file once the first assistant message exists.
prompt "$OBSERVER" "Reply with exactly: VIEW-SELF-DONE"
wait_for "the observer produced an assistant message" 180 has_assistant "$OBSERVER_SESSION"

# ---------------------------------------------------------------- 5. the list

say "5. /fleet view lists every pane, self included"
if open_view; then
	ok "the view opened"
else
	fail "the view did not open"
	dump_pane "$OBSERVER" 20
fi
LIST="$(screen "$OBSERVER")"
check "the view title is on screen" 'fleet view ·' "$LIST"

SELF_ROW="$(selected_row "$OBSERVER")"
check "the calling pane is listed" "$OBSERVER" "$SELF_ROW"
check "the calling pane is marked as self" '\[(自分|self)\]' "$SELF_ROW"
check_order "the pane id comes before the last user message" "$SELF_ROW" "$OBSERVER" 'VIEW-SELF-DONE'
check_order "the last user message comes before the name and the state" "$SELF_ROW" 'VIEW-SELF-DONE' "$PREFIX-observer"
check "the calling pane shows its own session" 'VIEW-SELF-DONE' "$SELF_ROW"

IDLE_ROW="$(selected_row "$IDLE_PANE")"
check "the idle subject is listed" "$IDLE_PANE" "$IDLE_ROW"
check_order "the pane id comes before the last user message" "$IDLE_ROW" "$IDLE_PANE" 'VIEW-A-DONE'
check_order "the last user message comes before the name and the state" "$IDLE_ROW" 'VIEW-A-DONE' "$PREFIX-idle"
check "the idle subject shows its state" 'idle|done' "$IDLE_ROW"
check "the idle subject shows its last user message" 'VIEW-A-DONE' "$IDLE_ROW"

WORKING_ROW="$(selected_row "$WORKING_PANE")"
check "the working subject is listed" "$WORKING_PANE" "$WORKING_ROW"
check_order "the last user message comes before the name and the state" "$WORKING_ROW" 'VIEW-B-DONE' "$PREFIX-working"
check "the working subject shows its state" 'working' "$WORKING_ROW"
check "the working subject shows its last user message" 'VIEW-B-DONE' "$WORKING_ROW"

SHELL_ROW="$(selected_row "$SHELL_PANE")"
check "a pane with no agent is listed" "$SHELL_PANE" "$SHELL_ROW"
check_once "a pane with no name shows its id once" "$SHELL_ROW" "$SHELL_PANE"
check "a pane with no agent says it has no Pi session" '(Pi セッションなし|no Pi session)' "$SHELL_ROW"

# ---------------------------------------------------------------- 6. the detail

say "6. detail: model, context, cost, cwd, branch, and the running tool"
selected_row "$OBSERVER" >/dev/null
herdr pane send-keys "$OBSERVER" enter >/dev/null 2>&1
sleep 1.5
DETAIL="$(screen "$OBSERVER")"
check "the detail names the cwd" "$REPO_REAL" "$DETAIL"
check "the detail names the worktree branch" 'branch: main' "$DETAIL"
check "the detail offers a way back" 'Esc' "$DETAIL"
herdr pane send-keys "$OBSERVER" esc >/dev/null 2>&1
sleep 1

# The numbers are detail-only: the list keeps the pane id and the last user
# message, so a narrow pane still says what the pane is doing.
selected_row "$IDLE_PANE" >/dev/null
herdr pane send-keys "$OBSERVER" enter >/dev/null 2>&1
sleep 1.5
IDLE_DETAIL="$(screen "$OBSERVER")"
check "the detail shows the model" '(モデル|model): [a-z0-9._-]+/[a-z0-9._-]+' "$IDLE_DETAIL"
check "the detail shows the context tokens" '(文脈|context): [0-9]' "$IDLE_DETAIL"
check "the detail shows the cost" '(コスト|cost): \$' "$IDLE_DETAIL"
herdr pane send-keys "$OBSERVER" esc >/dev/null 2>&1
sleep 1

selected_row "$WORKING_PANE" >/dev/null
herdr pane send-keys "$OBSERVER" enter >/dev/null 2>&1
sleep 1.5
RUNNING="$(screen "$OBSERVER")"
check "the running tool is named" '(実行中|running): .*bash' "$RUNNING"
herdr pane send-keys "$OBSERVER" esc >/dev/null 2>&1
sleep 1

# ---------------------------------------------------------------- 7. refresh

say "7. r re-reads the snapshot"
herdr pane send-keys "$OBSERVER" r >/dev/null 2>&1
wait_ready "$IDLE_PANE" 60
REFRESHED="$(screen "$OBSERVER")"
check "the view is still up after r" 'fleet view ·' "$REFRESHED"
check "the rows came back" "$IDLE_PANE" "$REFRESHED"

# ---------------------------------------------------------------- 8. a large session

# The view must read only the tail. The idle subject's session is padded past
# the 2MB cap and the view is refreshed: the newest words still have to show,
# and the cost has to say it is now a lower bound.
say "8. a session past the tail cap is read from the end and marked approximate"
if [ -n "$IDLE_SESSION" ] && [ -f "$IDLE_SESSION" ]; then
	python3 - "$IDLE_SESSION" <<'PY'
import sys
path = sys.argv[1]
body = open(path, "rb").read()
pad = b'{"type":"message","message":{"role":"toolResult","content":[{"type":"text","text":"' + b"x" * 3_000_000 + b'"}]}}\n'
with open(path, "wb") as handle:
    handle.write(pad + body)
PY
	SIZE="$(wc -c <"$IDLE_SESSION" | tr -d ' ')"
	check "the session is now past 2MB" '^[0-9]{7,}$' "$SIZE"
	herdr pane send-keys "$OBSERVER" r >/dev/null 2>&1
	wait_ready "$IDLE_PANE" 60
	BIG_ROW="$(selected_row "$IDLE_PANE")"
	check "the newest user message still shows after the cut" 'VIEW-A-DONE' "$BIG_ROW"
	# The cost moved to the detail with the rest of the numbers; the `≥` is there.
	selected_row "$IDLE_PANE" >/dev/null
	herdr pane send-keys "$OBSERVER" enter >/dev/null 2>&1
	sleep 1.5
	BIG_DETAIL="$(screen "$OBSERVER")"
	check "the cost is shown as a lower bound" '(コスト|cost): ≥' "$BIG_DETAIL"
	herdr pane send-keys "$OBSERVER" esc >/dev/null 2>&1
	sleep 1
else
	fail "no session file to pad"
fi

# ---------------------------------------------------------------- 9. close

say "9. Esc closes the view"
herdr pane send-keys "$OBSERVER" esc >/dev/null 2>&1
sleep 1.5
if screen "$OBSERVER" | grep -qE 'fleet view ·'; then
	fail "the view is still open after Esc"
else
	ok "Esc closed the view"
fi

# ---------------------------------------------------------------- result

fleet_result

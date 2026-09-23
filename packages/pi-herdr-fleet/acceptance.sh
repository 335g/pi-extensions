#!/usr/bin/env bash
#
# End-to-end acceptance for the approval broker, against a real herdr server and
# real panes. `selfcheck.ts` covers the logic against a fake socket; this covers
# what only exists when herdr, direnv and a Pi TUI are all real.
#
# Three panes are needed, and that is not a harness accident:
#
#   subject   a shell waiting on `read`, reported to herdr as a blocked agent
#   observer  a Pi running this extension, in a different pane
#   caller    the pane this script runs in
#
# The broker deliberately excludes its own pane, so the observer can never see
# itself as blocked; the subject has to be somewhere else entirely.
#
# Run it from inside a herdr pane (HERDR_ENV=1) anywhere in this repository.
# It closes only the panes it created. The harness is shared with
# acceptance-fork.sh; this script stays the fast one, at about half a minute.
#
#   packages/pi-herdr-fleet/acceptance.sh
#
set -uo pipefail
source "$(cd "$(dirname "$0")" && pwd)/acceptance-lib.sh"

PROMPT_SCRIPT="$(mktemp -t fleet-acceptance)"
register_path "$PROMPT_SCRIPT"

# ---------------------------------------------------------------- preflight

fleet_preflight
[ -f "$FLEET_ROOT/.envrc" ] || printf 'warning: no .envrc at %s; the observer may have no API key\n' "$FLEET_ROOT" >&2

# The subject asks a question and waits. A synthetic agent is enough: herdr only
# needs to report the pane as blocked, and this keeps the run deterministic.
cat >"$PROMPT_SCRIPT" <<'SH'
printf 'Approve deploy? [y/n] '
read -r ans
printf '\nanswered: %s\n' "$ans"
SH

# ---------------------------------------------------------------- 1. subject

say "1. subject pane"
if ! split_pane "${HERDR_PANE_ID}" down "$FLEET_ROOT"; then
	echo "could not split a subject pane" >&2
	exit 1
fi
SUBJECT="$FLEET_NEW_PANE"
printf '   subject: %s\n' "$SUBJECT"
sleep 1

# ---------------------------------------------------------------- 2. observer

say "2. observer pane (Pi + this extension)"
if ! split_pane "$SUBJECT" right "$FLEET_ROOT"; then
	echo "could not split an observer pane" >&2
	exit 1
fi
OBSERVER="$FLEET_NEW_PANE"
printf '   observer: %s\n' "$OBSERVER"
sleep 1

# The cwd is the repository root, so direnv loads .envrc and hands the observer
# an API key. Without the environment copy that Phase 2 does, this Pi dies on
# startup.
start_observer "observer Pi started (direnv supplied the environment)" "fleet-accept-$$" "$OBSERVER" || exit 1

# ---------------------------------------------------------------- 3. blocked

say "3. subject becomes blocked -> notification"
herdr pane run "$SUBJECT" "sh $PROMPT_SCRIPT" >/dev/null 2>&1
sleep 1
check "subject is waiting at the prompt" 'Approve deploy\? \[y/n\]' "$(history "$SUBJECT")"

# Reported after the observer is up, so this is a transition the broker sees as
# new. A pane that was already blocked at startup is not news, by design.
herdr pane report-agent "$SUBJECT" --source fleet-acceptance --agent subject --state blocked >/dev/null 2>&1
sleep 2
# The notification is locale-dependent: ja "…が承認待ちです", en "… is waiting for approval".
check "blocked pane raises a notification" '承認待ちです|is waiting for approval' "$(history "$OBSERVER")"

# ---------------------------------------------------------------- 4. overlay

say "4. overlay lists the blocked pane"
herdr pane send-keys "$OBSERVER" "ctrl+shift+a" >/dev/null 2>&1
sleep 2
LIST="$(screen "$OBSERVER")"
check "overlay opened on ctrl+shift+a" 'fleet ·|fleet .' "$LIST"
check "subject row is listed with its agent name and pane" "subject +$SUBJECT" "$LIST"
check "the row is marked blocked" 'blocked' "$LIST"

# ---------------------------------------------------------------- 5. question

say "5. detail view shows the question"
herdr pane send-keys "$OBSERVER" enter >/dev/null 2>&1
sleep 2
DETAIL="$(screen "$OBSERVER")"
check "the blocked pane's question is shown" 'Approve deploy\? \[y/n\]' "$DETAIL"
check "an answer editor is offered" '回答|Answer' "$DETAIL"

# ---------------------------------------------------------------- 6. text route

say "6. answer by text (Enter)"
herdr pane send-text "$OBSERVER" "y" >/dev/null 2>&1
sleep 0.5
herdr pane send-keys "$OBSERVER" enter >/dev/null 2>&1
sleep 2
check "the overlay reports the send" '送信しました|Sent' "$(screen "$OBSERVER")"
check "the subject received the answer" 'answered: y' "$(history "$SUBJECT")"

# ---------------------------------------------------------------- 7. key route

say "7. answer by raw keys (ctrl+k)"
# A successful send returns the overlay to the list, so re-open the detail view.
herdr pane send-keys "$OBSERVER" enter >/dev/null 2>&1
sleep 1.5
herdr pane send-keys "$SUBJECT" ctrl+c >/dev/null 2>&1
sleep 0.5
herdr pane run "$SUBJECT" "sh $PROMPT_SCRIPT" >/dev/null 2>&1
sleep 1
herdr pane send-text "$OBSERVER" "n enter" >/dev/null 2>&1
sleep 0.5
herdr pane send-keys "$OBSERVER" ctrl+k >/dev/null 2>&1
sleep 2
# The confirmation text from the previous round is still on screen, so the
# absence of an error is the discriminating check here.
expect_absent "the send reported no error" 'agent\.|pane\.|失敗|failed' "$(screen "$OBSERVER")"
check "the subject received the keys" 'answered: n' "$(history "$SUBJECT")"

# ---------------------------------------------------------------- 8. close

say "8. overlay closes"
herdr pane send-keys "$OBSERVER" esc >/dev/null 2>&1
sleep 1.5
if screen "$OBSERVER" | grep -qE 'fleet ·'; then
	fail "the overlay is still open after Esc"
else
	ok "Esc closed the overlay"
fi

# ---------------------------------------------------------------- result

fleet_result

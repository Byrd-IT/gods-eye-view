#!/bin/bash
# celestrak-halt-check — Byrd-IT, 2026-10-01.
# God's Eye View STOPS all CelesTrak requests after any upstream error and
# writes a halt file (CelesTrak usage policy + Dr. Kelso 2026-09-30: on any
# non-200 response, stop and report to a human). This check exits non-zero
# while that file exists, so job-failure-notify-cron pages Telegram
# (debounced via /usr/local/etc/notify-intervals.conf).
#
# To clear after checking https://celestrak.org is healthy:
#   rm /home/brandonabyrd/gods-eye-view/.gev-cache/celestrak-HALT.json
# GEV re-enables upstream on the next request; no restart needed.
set -u
HALT="/home/brandonabyrd/gods-eye-view/.gev-cache/celestrak-HALT.json"
[ -e "$HALT" ] || exit 0
INFO="$(python3 -c 'import json,sys,datetime
d=json.load(open(sys.argv[1]))
t=datetime.datetime.fromtimestamp(d.get("at",0)/1000).strftime("%Y-%m-%d %H:%M")
print(f"group={d.get(\"group\",\"?\")} reason={d.get(\"reason\",\"?\")} since={t}")' "$HALT" 2>/dev/null || echo "halt file unreadable")"
echo "God's Eye View has STOPPED all CelesTrak requests ($INFO)." >&2
echo "Check https://celestrak.org from S4, then clear: rm $HALT" >&2
exit 1

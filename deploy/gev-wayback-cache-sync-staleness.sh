#!/bin/bash
# Staleness check for the nightly copy (use when the run ledger is not wired):
# exit 0 when the last good copy is younger than MAX_HOURS (default 36), else 1.
STATE="${GEV_WAYBACK_SYNC_STATE:-$HOME/.local/state/gev-wayback-sync}/last-ok"
MAX_HOURS="${1:-36}"
[ -f "$STATE" ] || { echo "STALE: no successful gev-wayback-cache-sync yet"; exit 1; }
age=$(( ( $(date +%s) - $(date -d "$(cat "$STATE")" +%s) ) / 3600 ))
if [ "$age" -gt "$MAX_HOURS" ]; then echo "STALE: last good copy ${age}h ago (limit ${MAX_HOURS}h)"; exit 1; fi
echo "OK: last good copy ${age}h ago"

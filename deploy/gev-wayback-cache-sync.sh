#!/bin/bash
# Nightly append-only copy of the Wayback tile cache to S1 (GEV_BYRDIT_WAYBACK).
#
#   source : $GEV_WAYBACK_CACHE_DIR            (default /srv/gev-wayback-cache, on S4)
#   target : $GEV_WAYBACK_SYNC_DEST            (default S1:/srv/gev-basemap/wayback-cache)
#
# APPEND-ONLY: rsync never gets --delete, and --ignore-existing keeps a copy
# that is already on S1 untouched, so a damaged tile on S4 can never
# overwrite a good copy (tiles are immutable once written: the cache is
# keyed by the resolved release). Temporary files (*.tmp) and the stats file
# are skipped. Nothing here touches the live cache.
#
# RESTORE (S1 -> S4, e.g. after losing /srv/gev-wayback-cache; stop nothing,
# the server just starts hitting again; never use --delete):
#   rsync -a --ignore-existing --exclude '*.tmp' \
#     S1:/srv/gev-basemap/wayback-cache/ /srv/gev-wayback-cache/
# The tiny stats.json is rebuilt as tiles are written; /cache-status "tiles"
# and "bytes" restart from the saved counts only (they are advisory: the
# size guard and the free-space guard still protect the disk).
set -euo pipefail
SRC="${GEV_WAYBACK_CACHE_DIR:-/srv/gev-wayback-cache}"
DEST="${GEV_WAYBACK_SYNC_DEST:-S1:/srv/gev-basemap/wayback-cache}"
STAMP_DIR="${GEV_WAYBACK_SYNC_STATE:-$HOME/.local/state/gev-wayback-sync}"

[ -d "$SRC" ] || { echo "gev-wayback-cache-sync: $SRC does not exist (nothing to copy yet)"; exit 0; }
mkdir -p "$STAMP_DIR"

# --partial-dir keeps an interrupted file out of the destination tree.
# --bwlimit keeps the nightly copy from competing with GEV for the LAN.
# A failing rsync fails the script (and the unit): the output is captured, not piped.
out=$(rsync -a --ignore-existing --partial --partial-dir=.rsync-partial \
  --exclude '*.tmp' --exclude 'stats.json' --exclude '.rsync-partial' \
  --bwlimit="${GEV_WAYBACK_SYNC_BWLIMIT_KB:-40000}" \
  --stats --no-human-readable \
  "$SRC"/ "$DEST"/)
printf '%s\n' "$out" | grep -E 'Number of (regular )?files|Number of created|Total transferred file size' || true
date -u +%FT%TZ > "$STAMP_DIR/last-ok"
echo "gev-wayback-cache-sync: ok"

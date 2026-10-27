# Esri Wayback time travel (Byrd-IT fork)

A "Time travel" control that takes the Esri World Imagery layer back through
the ~197 Wayback releases (2014 to now), worldwide. It is separate from the
NAIP year slider (Texas, `GEV_BASEMAP_NAIP`) and does not change it.

Where it lives: the "Time travel" card (`#time-travel-panel`) is a real
right-rail card next to DISPLAY, CCTV, STREET LEVEL and CONTEXT. It stays hidden
until a section is claimed (`src/byrdit/timeTravel/menu.js`): History, Imagery
(this control, flag on) and Aerial (NAIP) (the NAIP year slider, while Byrd-IT
Open imagery with a NAIP offer is on screen; without the card it floats at the
bottom as before). Open/closed state is the standard rail one (remembered like
other rail cards); on phones it is in the Context sheet.

Off unless `GEV_BYRDIT_WAYBACK=1`. With the flag off no route exists (404), no
meta tag is rendered and the browser makes no request.

## Why Wayback and not Google

Google serves historical imagery only inside the Google Earth app; no Maps
Platform API exposes it and scraping breaks the terms. Esri Wayback is an
open, keyless archive of World Imagery releases.

## Pieces

| Where | What |
| --- | --- |
| `server/byrdit/wayback/releases.js` | Release list: `waybackconfig.json` fetched at most once per 24 h, last-good copy on disk, exponential backoff after a failure. |
| `server/byrdit/wayback/tileCache.js` | Perpetual view-through tile cache, single-flight, concurrency and requests/s caps, circuit breaker, disk guard. |
| `server/byrdit/wayback/index.js` | Routes and the Vite plugin (`waybackPlugins`). |
| `src/byrdit/wayback/` | Browser: model, imagery provider, panel, `attachWayback`. |
| `deploy/gev-wayback-cache-sync.*` | Nightly append-only copy of the cache to S1. |
| `scripts/qa-wayback.mjs` | Browser gate. |

Upstream-file seams (everything else is new files): `server/standalone/vite.config.js`
(one import, one plugin line), `src/app/scene.js` (one import and a no-op-when-off
`attachWayback` call), `src/byrdit/cleanView/cleanView.css` (`#gev-wayback` joins the
Clear view hide list), `src/i18n/locales/{es,ru,zh-CN}.json` (10 strings).

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `GEV_BYRDIT_WAYBACK` | off | `1` turns the feature on. |
| `GEV_BYRDIT_WAYBACK_CACHE_DIR` | `/srv/gev-wayback-cache` | Tile cache and last-good release list. |
| `GEV_BYRDIT_WAYBACK_CACHE_MAX_GB` | `500` | Stop writing new tiles above this size. |
| `GEV_BYRDIT_WAYBACK_CONCURRENCY` | `8` | Max simultaneous upstream tile fetches. |
| `GEV_BYRDIT_WAYBACK_RPS` | `20` | Upstream requests per second cap. |
| `GEV_BYRDIT_WAYBACK_INFO` | off | `1` adds the per-location capture date (below). |

## Routes

* `GET /api/byrdit/wayback/releases` -> `{releases:[{release,date,label}], stale, fetchedAt, attribution, info}`, newest first. 502 when there is neither a fresh nor a last-good list.
* `GET /api/byrdit/wayback/tile/<release>/<z>/<row>/<col>` -> the tile (`Cache-Control: public, max-age=2592000`, `X-Wayback-Cache: HIT|MISS`, upstream `ETag` kept). 404 for an unknown release (no upstream request), a bad address or "no imagery here"; 502/503 (`no-store`) for upstream trouble. GET/HEAD only.
* `GET /api/byrdit/wayback/cache-status` -> tile and byte counts, hit/miss counters, disk-guard and breaker state. No paths.
* `GET /api/byrdit/wayback/info?release=&lat=&lon=&z=` (sub-flag only) -> `{captured, resolutionM, source, provider}` from that release's Esri metadata layer (layer index `23 - z`, clamped 0..13). One request per call, cached 24 h in memory.

## Tile cache (owner decision 2026-10-22)

Keep what we view, never expire, never evict, no bulk prefetch. The owner
accepted the licence risk: Esri sends `Cache-Control: max-age=86400` and the
Wayback item says it is "not intended to be used to export tiles for offline".

* Files: `t/<resolved>/<z>/<row>/<col>` (one header line + image bytes, written to a
  `.tmp` and renamed), `a/<release>/<z>/<row>/<col>` (alias to the resolved
  release), `n/<release>/...` ("no tile here", 30-day TTL).
* Esri 301-redirects an unchanged release to the release that holds the image
  (sometimes two hops). The redirect is followed by hand, the target URL is rebuilt
  from our own template (an upstream can never send us to another host), and the
  image is stored once under the resolved release.
* A hit is served from disk with zero upstream requests. A miss is one upstream
  fetch (single-flight per tile), identified User-Agent, no cookies or caller headers.
* 429 opens the circuit breaker at once and honours `Retry-After`; 5xx/timeouts open
  it after 5 in a row (30 s doubling to 10 min, one probe). Cached tiles keep serving.
* Disk guard: new tiles stop being written when the cache exceeds the size cap or free
  space on the cache filesystem is under 15 %. Hits keep serving, misses pass through
  uncached, one log line per state change.

## Browser behaviour

Turning it on takes the same imagery-comparison lease the Recent Imagery layer uses
(`switchPolicy: 'esri'`): Google photorealistic 3D (or Byrd-IT Open) is replaced by the
Esri imagery stack, and the Wayback layer draws above the Esri base. Turning it off
releases the lease, which puts back exactly the stack that was active. If another tool
holds the lease the toggle says so and stays off; if the operator picks Google 3D or
Byrd-IT Open while it is on, it turns itself off.

Dragging the slider moves the date label at once; tiles for a release load only after
the slider has been quiet for 350 ms. The panel sits top-centre on desktop and in the free
band under the HUD summary on phones; it is hidden by Clear view, the attribution is not.

### Per-location capture date (`GEV_BYRDIT_WAYBACK_INFO=1`)

After the slider settles (and after the camera stops), at least one second later, one
request asks the release's metadata layer for the real acquisition date, resolution and
source at the view centre. The panel then reads "Captured 2018-04-19 · 31 cm · Vivid /
DigitalGlobe"; without an answer it shows "Wayback release <date>".

**Not built:** the "only dates that changed here" filter (what Esri's own Wayback app
does). It needs one metadata query per release (197) for each new location, far above
the one-request-per-step budget, so it is skipped.

## Nightly copy to S1 and restore

`deploy/gev-wayback-cache-sync.{sh,service,timer}` run `rsync -a --ignore-existing`
(no `--delete`, `*.tmp` and `stats.json` skipped) from the cache to
`GEV_WAYBACK_SYNC_DEST` (set it to a real S1 login in the unit; S4 has no `S1` ssh alias
at the time of writing). Optional run-ledger drop-in: `gev-wayback-cache-sync.service.d/`.
Without the ledger, `deploy/gev-wayback-cache-sync-staleness.sh [hours]` exits 1 when the
last good copy is older than 36 h.

Restore after losing the cache directory (never with `--delete`):

    rsync -a --ignore-existing --exclude '*.tmp' \
      <S1 login>:/srv/gev-basemap/wayback-cache/ /srv/gev-wayback-cache/

## Attribution

"Esri, Maxar, Earthstar Geographics, and the GIS User Community" plus the release date,
as a static credit while the layer is on (the Esri base keeps its own "Powered by Esri").

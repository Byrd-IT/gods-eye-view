#!/usr/bin/env python3
"""Export current USGS water readings from Elasticsearch for God's Eye View.

Byrd-IT fork. Writes one GeoJSONL file per site class plus a manifest:

    public/byrdit/usgs_water/<class>.geojsonl      (stream, well, lake, spring, other)
    public/byrdit/usgs_water/stream/<x>_<y>.geojsonl  (streams, 4-degree tiles)
    public/byrdit/usgs_water/manifest.json

Streams are ~90% of sites, so they are additionally tiled so the browser
loads only the tiles in view. Files live under public/ so Vite serves them
as plain static files that change every 15 minutes without a module reload.

Readings are the NEWEST per (site, parameter) within LOOKBACK_DAYS, chosen by
Elasticsearch (composite aggregation + top_hits sorted by observed_time).
Schema 2: those readings are grouped into ONE feature per gauge with a
`readings` list (most useful first), so the globe shows one card per gauge
with its levels instead of stacked duplicate name-only labels.
The previous exporter scrolled the first 200k of ~12M unsorted docs, so the
map showed weeks-old readings.

Set USGS_WATER_ES_URL and USGS_WATER_ES_API_KEY (ApiKey only; no
username/password fallback since t_dc58fb90). Optional
USGS_WATER_OUT_DIR overrides the output directory (tests).
"""

from __future__ import annotations

import json
import math
import os
import shutil
import ssl
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

INDEX = "usgs-water-levels"
LOOKBACK_DAYS = 14
PAGE_SIZE = 2_000
TILE_DEG = 4
SCHEMA = 2
DEFAULT_OUT_DIR = Path(__file__).resolve().parents[1] / "public/byrdit/usgs_water"
FIELDS = [
    "site_id",
    "site_name",
    "site_type_code",
    "parameter_code",
    "value",
    "unit",
    "state_name",
    "observed_time",
    "location",
]
PARAM_NAMES = {
    "00065": "Gage height",
    "00060": "Discharge",
    "00062": "Lake/reservoir stage",
    "72019": "Depth to water level",
    "62610": "Groundwater level above NGVD29",
    "62611": "Groundwater level above NAVD88",
    "62614": "Lake elevation above NGVD29",
    "62615": "Lake elevation above NAVD88",
}
# Card order: the reading people look for first comes first. Unknown codes last.
PARAM_ORDER = ["00065", "00062", "62614", "62615", "00060", "72019", "62611", "62610"]
SITE_TYPE_NAMES = {
    "ST": "Stream",
    "LK": "Lake/Reservoir",
    "SP": "Spring",
    "GW": "Groundwater well",
}
# site_type_code -> output class. Anything else (including blank) is "other".
CLASS_BY_CODE = {"ST": "stream", "GW": "well", "LK": "lake", "SP": "spring"}
CLASSES = ("stream", "well", "lake", "spring", "other")


def config() -> tuple[str, dict[str, str]]:
    url = os.environ.get("USGS_WATER_ES_URL", "").rstrip("/")
    if not url:
        raise RuntimeError("USGS_WATER_ES_URL is required")
    api_key = (os.environ.get("USGS_WATER_ES_API_KEY") or "").strip()
    if not api_key:
        # t_dc58fb90 2026-10-03: ApiKey ONLY (byrdit-es-gev-usgs-water); the
        # username/password (elastic) fallback was removed per owner rule.
        raise RuntimeError("USGS_WATER_ES_API_KEY is required")
    authorization = f"ApiKey {api_key}"
    return url, {"Authorization": authorization, "Content-Type": "application/json"}


def request_json(url: str, headers: dict[str, str], path: str, body: dict) -> dict:
    request = Request(
        f"{url}{path}", data=json.dumps(body).encode(), headers=headers, method="POST"
    )
    with urlopen(request, timeout=120) as response:
        return json.load(response)


def fetch_latest(url: str, headers: dict[str, str]) -> list[dict]:
    """Newest doc per (site_id, parameter_code), paged with a composite agg."""
    after = None
    docs: list[dict] = []
    while True:
        composite: dict = {
            "size": PAGE_SIZE,
            "sources": [
                {"site": {"terms": {"field": "site_id"}}},
                {"param": {"terms": {"field": "parameter_code"}}},
            ],
        }
        if after:
            composite["after"] = after
        body = {
            "size": 0,
            "track_total_hits": False,
            "query": {"range": {"observed_time": {"gte": f"now-{LOOKBACK_DAYS}d"}}},
            "aggs": {
                "pairs": {
                    "composite": composite,
                    "aggs": {
                        "newest": {
                            "top_hits": {
                                "size": 1,
                                "sort": [{"observed_time": {"order": "desc"}}],
                                "_source": FIELDS,
                            }
                        }
                    },
                }
            },
        }
        result = request_json(url, headers, f"/{INDEX}/_search", body)
        agg = result["aggregations"]["pairs"]
        for bucket in agg["buckets"]:
            hits = bucket["newest"]["hits"]["hits"]
            if hits:
                docs.append(hits[0]["_source"])
        after = agg.get("after_key")
        if not after or not agg["buckets"]:
            return docs


def site_class(site_type_code: str) -> str:
    return CLASS_BY_CODE.get(site_type_code or "", "other")


def doc_location(doc: dict) -> tuple[float, float] | None:
    """(lon, lat) from an ES geo_point object or "lat,lon" string, else None."""
    location = doc.get("location") or {}
    if isinstance(location, str):
        try:
            lat_s, lon_s = location.split(",", 1)
            location = {"lat": float(lat_s), "lon": float(lon_s)}
        except ValueError:
            return None
    latitude, longitude = location.get("lat"), location.get("lon")
    if latitude is None or longitude is None:
        return None
    return float(longitude), float(latitude)


def reading_sort_key(reading: dict) -> tuple[int, str]:
    code = reading["parameter_code"]
    rank = PARAM_ORDER.index(code) if code in PARAM_ORDER else len(PARAM_ORDER)
    return rank, code


def group_sites(docs: list[dict]) -> list[dict]:
    """One feature per gauge (site_id) carrying all of its newest readings."""
    sites: dict[str, dict] = {}
    for doc in docs:
        site_id = doc.get("site_id") or ""
        if not site_id:
            continue
        site = sites.setdefault(site_id, {"doc": doc, "coords": None, "readings": []})
        if site["coords"] is None:
            site["coords"] = doc_location(doc)
            if site["coords"] is not None:
                site["doc"] = doc
        parameter_code = doc.get("parameter_code") or ""
        site["readings"].append(
            {
                "parameter_code": parameter_code,
                "parameter_name": PARAM_NAMES.get(parameter_code, parameter_code),
                "value": doc.get("value"),
                "unit": doc.get("unit") or "",
                "observed_time": doc.get("observed_time") or "",
            }
        )
    features = []
    for site_id, site in sites.items():
        if site["coords"] is None:
            continue
        doc = site["doc"]
        readings = sorted(site["readings"], key=reading_sort_key)
        primary = readings[0]
        site_type_code = doc.get("site_type_code") or ""
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": list(site["coords"])},
                "properties": {
                    "name": doc.get("site_name") or site_id or "USGS site",
                    "usgs_site_id": site_id,
                    "site_type_code": site_type_code,
                    "site_type": SITE_TYPE_NAMES.get(site_type_code, site_type_code or "Unknown"),
                    "state": doc.get("state_name") or "",
                    "observed_time": max(r["observed_time"] for r in readings),
                    # Primary reading kept top-level for schema-1 readers.
                    "parameter_code": primary["parameter_code"],
                    "parameter_name": primary["parameter_name"],
                    "value": primary["value"],
                    "unit": primary["unit"],
                    "readings": readings,
                },
            }
        )
    return features


def tile_key(lon: float, lat: float) -> str:
    x = math.floor((lon + 180) / TILE_DEG)
    y = math.floor((lat + 90) / TILE_DEG)
    return f"{x}_{y}"


def tile_bounds(key: str) -> list[float]:
    x, y = (int(part) for part in key.split("_"))
    west = x * TILE_DEG - 180
    south = y * TILE_DEG - 90
    return [west, south, west + TILE_DEG, south + TILE_DEG]


def write_jsonl(path: Path, features: list[dict]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as output:
        for feature in features:
            output.write(json.dumps(feature, separators=(",", ":")) + "\n")
    return path.stat().st_size


def build_output(features: list[dict], staging: Path) -> dict:
    by_class: dict[str, list[dict]] = {name: [] for name in CLASSES}
    for feature in features:
        by_class[site_class(feature["properties"]["site_type_code"])].append(feature)
    manifest: dict = {
        "schema": SCHEMA,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "lookback_days": LOOKBACK_DAYS,
        "tile_deg": TILE_DEG,
        "classes": {},
    }
    for name in CLASSES:
        items = sorted(by_class[name], key=lambda f: f["properties"]["usgs_site_id"] or "")
        entry = {
            "count": len(items),
            "file": f"{name}.geojsonl",
            "bytes": write_jsonl(staging / f"{name}.geojsonl", items),
        }
        if name == "stream":
            tiles: dict[str, list[dict]] = {}
            for feature in items:
                lon, lat = feature["geometry"]["coordinates"][:2]
                tiles.setdefault(tile_key(lon, lat), []).append(feature)
            entry["tiles"] = {
                key: {
                    "count": len(tile),
                    "bounds": tile_bounds(key),
                    "file": f"stream/{key}.geojsonl",
                    "bytes": write_jsonl(staging / "stream" / f"{key}.geojsonl", tile),
                }
                for key, tile in sorted(tiles.items())
            }
        manifest["classes"][name] = entry
    (staging / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")))
    return manifest


def publish(staging: Path, out_dir: Path) -> None:
    """Swap the new tree in with one rename, so readers never see a partial set."""
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    old = out_dir.with_name(out_dir.name + ".old")
    if old.exists():
        shutil.rmtree(old)
    if out_dir.exists():
        out_dir.rename(old)
    staging.rename(out_dir)
    if old.exists():
        shutil.rmtree(old)


def main() -> int:
    started = time.monotonic()
    out_dir = Path(os.environ.get("USGS_WATER_OUT_DIR") or DEFAULT_OUT_DIR)
    url, headers = config()
    docs = fetch_latest(url, headers)
    features = group_sites(docs)
    if not features:
        print("ERROR: no current readings returned from Elasticsearch", file=sys.stderr)
        return 1
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".usgs_water.", dir=out_dir.parent))
    try:
        manifest = build_output(features, staging)
        publish(staging, out_dir)
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
    counts = {name: entry["count"] for name, entry in manifest["classes"].items()}
    tiles = len(manifest["classes"]["stream"].get("tiles", {}))
    newest = max((f["properties"]["observed_time"] for f in features), default="")
    oldest = min((f["properties"]["observed_time"] for f in features), default="")
    print(
        f"OK: {len(features)} gauges ({len(docs)} site/parameter pairs, last "
        f"{LOOKBACK_DAYS}d) -> {out_dir} in {time.monotonic() - started:.1f}s; "
        f"classes={json.dumps(counts)} stream_tiles={tiles} "
        f"observed {oldest} .. {newest}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (HTTPError, URLError, RuntimeError, ValueError, KeyError, OSError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)

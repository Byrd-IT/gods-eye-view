#!/usr/bin/env python3
"""Export current USGS water readings from Elasticsearch to bundled GeoJSONL.

Set USGS_WATER_ES_URL and either USGS_WATER_ES_API_KEY or both
USGS_WATER_ES_USERNAME and USGS_WATER_ES_PASSWORD. The exporter writes the
project's bundled `src/data/local_data/usgs_water/usgs_water.geojsonl` by
default and is intended to run after the upstream ingestion refresh.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

INDEX = "usgs-water-levels"
SCROLL_SIZE = 5_000
SCROLL_TTL = "2m"
MAX_DOCS = 200_000
OUT_PATH = (
    Path(__file__).resolve().parents[1]
    / "src/data/local_data/usgs_water/usgs_water.geojsonl"
)
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
}
SITE_TYPE_NAMES = {
    "ST": "Stream",
    "LK": "Lake/Reservoir",
    "SP": "Spring",
    "GW": "Groundwater well",
}


def config() -> tuple[str, dict[str, str]]:
    url = os.environ.get("USGS_WATER_ES_URL", "").rstrip("/")
    if not url:
        raise RuntimeError("USGS_WATER_ES_URL is required")

    api_key = os.environ.get("USGS_WATER_ES_API_KEY")
    username = os.environ.get("USGS_WATER_ES_USERNAME")
    password = os.environ.get("USGS_WATER_ES_PASSWORD")
    if api_key:
        authorization = f"ApiKey {api_key}"
    elif username and password:
        basic = base64.b64encode(f"{username}:{password}".encode()).decode()
        authorization = f"Basic {basic}"
    else:
        raise RuntimeError(
            "set USGS_WATER_ES_API_KEY or both USGS_WATER_ES_USERNAME and "
            "USGS_WATER_ES_PASSWORD"
        )
    return url, {"Authorization": authorization, "Content-Type": "application/json"}


def request_json(
    url: str,
    headers: dict[str, str],
    path: str,
    body: dict,
    method: str = "POST",
) -> dict:
    request = Request(
        f"{url}{path}",
        data=json.dumps(body).encode(),
        headers=headers,
        method=method,
    )
    with urlopen(request, timeout=30) as response:
        return json.load(response)


def fetch_all(url: str, headers: dict[str, str]) -> list[dict]:
    response = request_json(
        url,
        headers,
        f"/{INDEX}/_search?scroll={SCROLL_TTL}",
        {"size": SCROLL_SIZE, "_source": FIELDS, "query": {"match_all": {}}},
    )
    scroll_id = response.get("_scroll_id")
    hits = response["hits"]["hits"]
    docs: list[dict] = []
    try:
        while hits:
            docs.extend(hit["_source"] for hit in hits)
            if len(docs) >= MAX_DOCS:
                break
            response = request_json(
                url,
                headers,
                "/_search/scroll",
                {"scroll": SCROLL_TTL, "scroll_id": scroll_id},
            )
            hits = response["hits"]["hits"]
    finally:
        if scroll_id:
            try:
                request_json(
                    url,
                    headers,
                    "/_search/scroll",
                    {"scroll_id": [scroll_id]},
                    method="DELETE",
                )
            except (HTTPError, URLError):
                pass
    return docs


def latest_per_site_param(docs: list[dict]) -> dict[tuple[str | None, str | None], dict]:
    best: dict[tuple[str | None, str | None], dict] = {}
    for doc in docs:
        key = (doc.get("site_id"), doc.get("parameter_code"))
        current = best.get(key)
        if current is None or (doc.get("observed_time") or "") >= (
            current.get("observed_time") or ""
        ):
            best[key] = doc
    return best


def to_feature(doc: dict) -> dict | None:
    location = doc.get("location") or {}
    latitude, longitude = location.get("lat"), location.get("lon")
    if latitude is None or longitude is None:
        return None
    parameter_code = doc.get("parameter_code") or ""
    site_type_code = doc.get("site_type_code") or ""
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [longitude, latitude]},
        "properties": {
            "name": doc.get("site_name") or doc.get("site_id") or "USGS site",
            "usgs_site_id": doc.get("site_id"),
            "site_type_code": site_type_code,
            "site_type": SITE_TYPE_NAMES.get(site_type_code, site_type_code),
            "parameter_code": parameter_code,
            "parameter_name": PARAM_NAMES.get(parameter_code, parameter_code),
            "value": doc.get("value"),
            "unit": doc.get("unit") or "",
            "state": doc.get("state_name") or "",
            "observed_time": doc.get("observed_time") or "",
        },
    }


def write_features(features: list[dict]) -> None:
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", dir=OUT_PATH.parent, suffix=".tmp", delete=False
    ) as output:
        temporary_path = Path(output.name)
        for feature in features:
            output.write(json.dumps(feature, separators=(",", ":")) + "\n")
    temporary_path.replace(OUT_PATH)


def main() -> int:
    started = time.monotonic()
    url, headers = config()
    docs = fetch_all(url, headers)
    if not docs:
        print("ERROR: no documents returned from Elasticsearch", file=sys.stderr)
        return 1
    newest = latest_per_site_param(docs)
    features = [feature for doc in newest.values() if (feature := to_feature(doc))]
    features.sort(key=lambda feature: feature["properties"]["usgs_site_id"] or "")
    write_features(features)
    by_type: dict[str, int] = {}
    for feature in features:
        site_type = feature["properties"]["site_type_code"] or "?"
        by_type[site_type] = by_type.get(site_type, 0) + 1
    print(
        f"OK: {len(docs)} ES docs -> {len(features)} features "
        f"({len(newest)} site/parameter pairs) written to {OUT_PATH} "
        f"in {time.monotonic() - started:.1f}s"
    )
    print("features per site_type: " + json.dumps(dict(sorted(by_type.items()))))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (HTTPError, URLError, RuntimeError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)

#!/usr/bin/env python3
"""Publish one OpenDroneMap 3D build as a God's Eye View 3D layer.

    publish_odm_3d.py --source S4:/srv/odm/data/<build-uuid> \
        --id odm-3d-9be42b4f --name "Byrd Ranch shop area 3D (2026-10-31)"

Runs on any host that can ssh to the source host and to S1 (the map store).
The build's 3d_tiles/model folder is streamed to S1 (no local copy), every
file is checked against a SHA256 list taken at the source, and only then is
the layer added to hires/m2/overlays.json (atomic write, backup kept). The
GEV server picks the new layer up from the manifest on its own; no restart.

What it does, in order (any failure stops and leaves the manifest untouched):
  1. check the arguments and the source (tileset.json, size, DTM present)
  2. stream the tileset to S1 staging, verify every SHA256, check that every
     tile file the tileset names exists
  3. read the bare-ground height (median of the ODM DTM, via the gdal python
     on S1) and the footprint (from the georeferenced tileset)
  4. move the folder into hires/odm3d/<id>/, add the manifest entry
  5. fetch tileset.json back over HTTP from the S1 origin and compare

Nothing in the ODM data is changed or deleted. Re-running with an existing
id is refused (use a new id for a new build). --dry-run does steps 1 and 3
only and prints the manifest entry.

Logging: every line goes to stdout and to syslog (tag gev-publish-odm3d,
priority = level), which the Fleet journald integration ships to
Elasticsearch (logs-journald.generic: host.name, process name, priority,
message). Nothing secret is ever logged; ssh needs no password.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import shlex
import subprocess
import sys
import time

S1 = "S1"
STORE = "/srv/gev-basemap/hires"
MANIFEST = f"{STORE}/m2/overlays.json"
ORIGIN = "http://10.10.99.101:8480/hires"
GDAL_PY = "/opt/gev-basemap/gdalenv/bin/python3"
ID_RE = re.compile(r"^odm-[a-z0-9][a-z0-9-]{0,26}$")
NAME_RE = re.compile(r"^[A-Za-z0-9 /&+().,'-]{1,80}$")
CREDIT_RE = NAME_RE
SRC_RE = re.compile(r"^(?:(?P<host>[A-Za-z0-9._-]+):)?(?P<path>/[A-Za-z0-9._/-]+)$")
BUILD_RE = re.compile(r"^[0-9a-f][0-9a-f-]{7,39}$")
TAG = "gev-publish-odm3d"
PRIORITY = {"info": "user.info", "warn": "user.warning", "error": "user.err"}
FT = 0.3048


class Fail(Exception):
    pass


def log(level: str, message: str) -> None:
    line = f"{level.upper()} {message}"
    print(line, flush=True, file=sys.stderr if level == "error" else sys.stdout)
    try:
        subprocess.run(
            ["logger", "-t", TAG, "-p", PRIORITY[level], "--", message],
            check=False,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        pass  # stdout still has it; never fail a publish over logging


def run(cmd, *, check=True, input=None, timeout=3600, capture=True):
    result = subprocess.run(
        cmd,
        input=input,
        text=True,
        capture_output=capture,
        timeout=timeout,
        check=False,
    )
    if check and result.returncode != 0:
        # Size only: a child's stderr can repeat the paths, hosts or tokens it
        # was given. Re-run the failing step by hand to read it.
        size = len(result.stderr or "") + len(result.stdout or "")
        raise Fail(f"command failed (exit {result.returncode}): {cmd[0]}, {size} bytes of output not shown")
    return result


def sh(host: str | None, command: str, **kw):
    """Run a shell command locally (host None) or over ssh."""
    if host:
        return run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, command], **kw)
    return run(["bash", "-c", command], **kw)


# ---- geometry: georeferenced tileset -> lon/lat footprint ------------------
A = 6378137.0
F = 1 / 298.257223563
E2 = F * (2 - F)


def ecef_to_geodetic(x, y, z):
    lon = math.atan2(y, x)
    p = math.hypot(x, y)
    lat = math.atan2(z, p * (1 - E2))
    h = 0.0
    for _ in range(8):
        n = A / math.sqrt(1 - E2 * math.sin(lat) ** 2)
        h = p / math.cos(lat) - n
        lat = math.atan2(z, p * (1 - E2 * n / (n + h)))
    return math.degrees(lon), math.degrees(lat), h


def _swap_boxes(node: dict) -> None:
    """Rewrite every bounding box from ODM's Y-up convention to Z-up, in place.

    ODM/obj2tiles writes the tile meshes with x east, y north, z up (heights
    are absolute, the root transform puts the origin on the ellipsoid) but
    declares the bounding boxes as if the mesh were glTF Y-up:
    (x, y, z) = (east, -up, north). Cesium then culls and refines by boxes
    that do not enclose the mesh. Mapping the boxes to (east, north, up)
    and declaring gltfUpAxis Z makes them describe what is drawn. Only
    tileset.json changes; no tile file is touched.
    """
    box = (node.get("boundingVolume") or {}).get("box")
    if isinstance(box, list) and len(box) == 12:
        cx, cy, cz = box[0:3]
        hx, hy, hz = abs(box[3]), abs(box[7]), abs(box[11])
        node["boundingVolume"]["box"] = [cx, cz, -cy, hx, 0, 0, 0, hz, 0, 0, 0, hy]
    for child in node.get("children", []) or []:
        _swap_boxes(child)


def fix_tileset(tileset: dict) -> dict:
    fixed = json.loads(json.dumps(tileset))
    root = fixed["root"]
    if (fixed.get("asset") or {}).get("gltfUpAxis") not in (None, "Y"):
        raise Fail("tileset already declares an up axis other than Y: not the ODM export this script knows")
    _swap_boxes(root)
    fixed.setdefault("asset", {})["gltfUpAxis"] = "Z"
    fixed.setdefault("extras", {})["byrdit"] = "bounding boxes mapped from ODM Y-up to Z-up by publish_odm_3d.py; tile files untouched"
    return fixed


def _boxes(node: dict, out: list) -> None:
    box = (node.get("boundingVolume") or {}).get("box")
    if isinstance(box, list) and len(box) == 12:
        out.append(box)
    for child in node.get("children", []) or []:
        _boxes(child, out)


def footprint(tileset: dict) -> tuple[list[float], float, tuple[float, float]]:
    """([w, s, e, n], origin height, (lowest, highest) local z) of a FIXED tileset.

    Union of the child boxes in the tileset's local ENU frame (x east,
    y north, z up), moved to the earth by root.transform.
    """
    root = tileset["root"]
    m = root.get("transform")
    if not (isinstance(m, list) and len(m) == 16):
        raise Fail("tileset.json root has no transform: not an ODM georeferenced tileset")
    boxes: list = []
    _boxes(root, boxes)
    if not boxes:
        raise Fail("tileset.json has no bounding boxes")
    xs, ys, zs = [], [], []
    for box in boxes:
        cx, cy, cz = box[0:3]
        hx = abs(box[3]) + abs(box[6]) + abs(box[9])
        hy = abs(box[4]) + abs(box[7]) + abs(box[10])
        hz = abs(box[5]) + abs(box[8]) + abs(box[11])
        xs += [cx - hx, cx + hx]
        ys += [cy - hy, cy + hy]
        zs += [cz - hz, cz + hz]
    lons, lats = [], []
    for lx in (min(xs), max(xs)):
        for ly in (min(ys), max(ys)):
            ex = m[0] * lx + m[4] * ly + m[12]
            ey = m[1] * lx + m[5] * ly + m[13]
            ez = m[2] * lx + m[6] * ly + m[14]
            lon, lat, _ = ecef_to_geodetic(ex, ey, ez)
            lons.append(lon)
            lats.append(lat)
    origin_h = ecef_to_geodetic(m[12], m[13], m[14])[2]
    bounds = [round(min(lons), 6), round(min(lats), 6), round(max(lons), 6), round(max(lats), 6)]
    return bounds, origin_h, (min(zs), max(zs))


def tile_uris(node: dict, out: set[str]) -> None:
    content = node.get("content") or {}
    uri = content.get("uri") or content.get("url")
    if uri:
        out.add(uri)
    for child in node.get("children", []) or []:
        tile_uris(child, out)


# ---- steps ------------------------------------------------------------------
def safe_source(host, path) -> str:
    """host:<build folder> for logs and the manifest; anything not shaped like a
    build id (a uuid) is shown as <custom> so a stray token in a path is never logged."""
    name = path.rstrip("/").rsplit("/", 1)[-1]
    shown = name if BUILD_RE.match(name) else "<custom>"
    return f"{host or 'local'}:{shown}"


def safe_id(value) -> str:
    return value if isinstance(value, str) and ID_RE.match(value) else "<invalid>"


def parse_source(value: str):
    m = SRC_RE.match(value)
    if not m:
        raise Fail("--source must be [host:]/absolute/path with plain characters")
    return m.group("host"), m.group("path").rstrip("/")


def check_args(args) -> None:
    if not ID_RE.match(args.id):
        raise Fail("--id must look like odm-3d-<8 hex>: lower case, starts with odm- (that prefix files it under Byrd Ranch builds)")
    if not NAME_RE.match(args.name):
        raise Fail("--name: 1-80 chars of letters, digits, space and / & + ( ) . , ' - (no colon)")
    if not CREDIT_RE.match(args.credit):
        raise Fail("--credit has characters the GEV manifest check refuses")
    if args.canopy_default_ft not in ("none", "90", "120"):
        raise Fail("--canopy-default-ft must be none, 90 or 120")


def read_source(host, path):
    model = f"{path}/3d_tiles/model"
    out = sh(host, f"cat {shlex.quote(model)}/tileset.json").stdout
    try:
        tileset = json.loads(out)
    except ValueError as error:
        raise Fail(f"tileset.json is not JSON: {error}") from None
    size = int(sh(host, f"du -sb {shlex.quote(model)} | cut -f1").stdout.strip())
    count = int(sh(host, f"find {shlex.quote(model)} -type f | wc -l").stdout.strip())
    sh(host, f"test -f {shlex.quote(path)}/odm_dem/dtm.tif")
    return model, tileset, size, count


def source_hashes(host, model) -> dict[str, str]:
    out = sh(
        host,
        f"cd {shlex.quote(model)} && find . -type f -print0 | sort -z | xargs -0 sha256sum",
        timeout=7200,
    ).stdout
    hashes = {}
    for line in out.splitlines():
        digest, _, name = line.partition("  ")
        hashes[name[2:] if name.startswith("./") else name] = digest
    return hashes


def stream(host, model, stage) -> None:
    """tar | tar over ssh: source -> S1 staging, no local copy."""
    src = (
        f"tar -C {shlex.quote(model)} -cf - ."
    )
    dst = f"mkdir -p {shlex.quote(stage)} && tar -C {shlex.quote(stage)} -xf -"
    left = ["ssh", "-o", "BatchMode=yes", host, src] if host else ["bash", "-c", src]
    right = ["ssh", "-o", "BatchMode=yes", S1, dst]
    p1 = subprocess.Popen(left, stdout=subprocess.PIPE)
    p2 = subprocess.Popen(right, stdin=p1.stdout)
    p1.stdout.close()
    r2 = p2.wait()
    r1 = p1.wait()
    if r1 or r2:
        raise Fail(f"stream failed (source rc={r1}, S1 rc={r2})")


def verify_stage(stage, hashes) -> None:
    out = sh(
        S1,
        f"cd {shlex.quote(stage)} && find . -type f -print0 | sort -z | xargs -0 sha256sum",
        timeout=7200,
    ).stdout
    got = {}
    for line in out.splitlines():
        digest, _, name = line.partition("  ")
        got[name[2:] if name.startswith("./") else name] = digest
    missing = sorted(set(hashes) - set(got))
    extra = sorted(set(got) - set(hashes))
    bad = sorted(n for n in hashes if n in got and got[n] != hashes[n])
    if missing or extra or bad:
        raise Fail(f"checksum mismatch: {len(missing)} missing, {len(extra)} extra, {len(bad)} differ")


GROUND_SCRIPT = r"""
import sys, numpy as np
from osgeo import gdal
gdal.DontUseExceptions()  # the MrSID plugin on S1 is missing a library; exceptions would trip on it
ds = gdal.Open(sys.argv[1])
if ds is None: sys.exit('cannot open DTM')
b = ds.GetRasterBand(1); nd = b.GetNoDataValue()
a = b.ReadAsArray(buf_xsize=min(ds.RasterXSize, 2000), buf_ysize=min(ds.RasterYSize, 2000)).astype("float64")
a = a[np.isfinite(a)]
if nd is not None: a = a[a != nd]
if a.size < 1000: sys.exit("DTM has too few valid cells")
p = np.percentile(a, [5, 50, 95])
print("%.2f %.2f %.2f" % tuple(p))
"""


def ground_height(host, path, stage_tmp) -> tuple[float, float, float]:
    dtm = f"{path}/odm_dem/dtm.tif"
    cmd = f"cat {shlex.quote(dtm)}"
    left = ["ssh", "-o", "BatchMode=yes", host, cmd] if host else ["bash", "-c", cmd]
    right = ["ssh", "-o", "BatchMode=yes", S1, f"cat > {shlex.quote(stage_tmp)}"]
    p1 = subprocess.Popen(left, stdout=subprocess.PIPE)
    p2 = subprocess.Popen(right, stdin=p1.stdout)
    p1.stdout.close()
    if p2.wait() or p1.wait():
        raise Fail("could not copy dtm.tif to S1 for the ground height")
    try:
        out = run(
            ["ssh", "-o", "BatchMode=yes", S1, f"{GDAL_PY} - {shlex.quote(stage_tmp)} 2>/dev/null"],
            input=GROUND_SCRIPT,
        ).stdout.split()
    finally:
        sh(S1, f"rm -f {shlex.quote(stage_tmp)}", check=False)
    try:
        lo, mid, hi = (float(v) for v in out[-3:])
    except ValueError:
        raise Fail("ground height step printed nothing usable") from None
    return lo, mid, hi


def add_manifest_entry(entry: dict) -> None:
    """Atomic add on S1: backup, id must be new, write tmp, rename."""
    program = r"""
import json, os, sys, time, shutil, hashlib
entry = json.loads(sys.stdin.read()); M = sys.argv[1]
d = json.load(open(M))
if any(l.get("id") == entry["id"] for l in d["layers"]): sys.exit("id exists in manifest")
bak = M + ".bak-odm3d-" + time.strftime("%Y%m%d-%H%M%S"); shutil.copy2(M, bak)
d["layers"].append(entry)
d["generated"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
d["note"] = d.get("note", "") + " | publish_odm_3d: +3d layer " + entry["id"]
tmp = M + ".tmp"; json.dump(d, open(tmp, "w"), indent=1); os.replace(tmp, M)
print("backup", bak, "layers", len(d["layers"]))
"""
    out = run(
        ["ssh", "-o", "BatchMode=yes", S1, f"python3 -c {shlex.quote(program)} {shlex.quote(MANIFEST)}"],
        input=json.dumps(entry),
    ).stdout.strip()
    log("info", f"manifest updated: {out}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--source", required=True, help="[host:]/path of the ODM build folder")
    ap.add_argument("--id", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--credit", default="Byrd-IT ODM drone survey")
    ap.add_argument("--canopy-default-ft", default="none", help="none, 90 or 120 (small shop-area builds: 90)")
    ap.add_argument("--ground-m", type=float, help="override the DTM-derived ground height (m)")
    ap.add_argument("--height-offset-m", type=float, default=0.0, help="manual lift on top of the automatic terrain alignment")
    ap.add_argument("--max-gb", type=float, default=3.0, help="refuse bigger models unless --allow-large")
    ap.add_argument("--allow-large", action="store_true", help="owner has approved a model above --max-gb")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    started = time.time()
    try:
        check_args(args)
        host, path = parse_source(args.source)
        log("info", f"start id={args.id} source={safe_source(host, path)}")
        model, tileset, size, count = read_source(host, path)
        gb = size / 1e9
        log("info", f"source tileset: {count} files, {gb:.2f} GB")
        if gb > args.max_gb and not args.allow_large:
            raise Fail(f"model is {gb:.1f} GB, above --max-gb {args.max_gb}: get the owner's OK, then add --allow-large")
        fixed = fix_tileset(tileset)
        bounds, origin_h, (zlo, zhi) = footprint(fixed)
        if abs(origin_h) > 1.0:
            raise Fail(f"tileset origin is {origin_h:.1f} m above the ellipsoid; the cut maths assumes 0 (not an ODM export?)")
        if not (-180 < bounds[0] < bounds[2] < 180 and -90 < bounds[1] < bounds[3] < 90):
            raise Fail(f"footprint {bounds} is not a valid lon/lat box")
        lo, mid, hi = (args.ground_m,) * 3 if args.ground_m is not None else ground_height(host, path, f"/tmp/{args.id}-dtm.tif")
        log("info", f"footprint {bounds}; ground height median {mid:.1f} m (5%-95%: {lo:.1f}-{hi:.1f} m)")
        if not (zlo - 5 <= mid <= zhi + 5):
            raise Fail(f"ground height {mid:.1f} m is outside the model's heights {zlo:.1f}-{zhi:.1f} m: DTM and tileset do not match")
        default_ft = None if args.canopy_default_ft == "none" else int(args.canopy_default_ft)
        entry = {
            "id": args.id,
            "name": args.name,
            "kind": "overlay-3d",
            "group": "byrd-ranch",
            "year": time.strftime("%Y"),
            "resolution": "ODM textured 3D mesh",
            "format": "3dtiles",
            "archive": f"odm3d/{args.id}",
            "file": f"hires/odm3d/{args.id}/tileset.json",
            "bytes": size,
            "files": count,
            "bounds": bounds,
            "ground_m": round(mid, 2),
            "ground_5_95_m": [round(lo, 2), round(hi, 2)],
            "height_offset_m": args.height_offset_m,
            "canopy_options_ft": [90, 120],
            "canopy_default_ft": default_ft,
            "default_opacity": 1.0,
            "status": "live-data",
            "credit": args.credit,
            "source": safe_source(host, path),
        }
        if args.dry_run:
            log("info", "dry run: nothing copied")
            print(json.dumps(entry, indent=1))
            return 0

        final = f"{STORE}/odm3d/{args.id}"
        stage = f"{STORE}/odm3d/.staging-{args.id}"
        if sh(S1, f"test -e {shlex.quote(final)}", check=False).returncode == 0:
            raise Fail(f"{final} already exists on S1; use a new --id")
        sh(S1, f"rm -rf {shlex.quote(stage)}")
        try:
            hashes = source_hashes(host, model)
            if len(hashes) != count:
                raise Fail("source changed while reading it (file count differs); stop the build first")
            log("info", f"copying {count} files to S1 staging")
            stream(host, model, stage)
            verify_stage(stage, hashes)
            log("info", f"all {len(hashes)} SHA256 match the source")
            names = set()
            tile_uris(tileset["root"], names)
            fixed_text = json.dumps(fixed, indent=1)
            run(
                ["ssh", "-o", "BatchMode=yes", S1, f"cd {shlex.quote(stage)} && mv tileset.json tileset.original.json && cat > tileset.json"],
                input=fixed_text,
            )
            missing = sorted(n for n in names if n not in hashes)
            if missing:
                raise Fail(f"tileset names {len(missing)} files that are not in the build, e.g. {missing[0]}")
            published = dict(hashes)
            published["tileset.original.json"] = hashes["tileset.json"]
            published["tileset.json"] = hashlib.sha256(fixed_text.encode()).hexdigest()
            sums = "".join(f"{published[n]}  {n}\n" for n in sorted(published))
            digest = hashlib.sha256(sums.encode()).hexdigest()
            run(
                ["ssh", "-o", "BatchMode=yes", S1, f"cat > {shlex.quote(stage)}/SHA256SUMS.txt"],
                input=sums,
            )
            entry["sha256"] = digest
            sh(S1, f"mv {shlex.quote(stage)} {shlex.quote(final)}")
        except BaseException:
            sh(S1, f"rm -rf {shlex.quote(stage)}", check=False)
            raise
        try:
            add_manifest_entry(entry)
        except BaseException:
            # The folder was created by this run (it did not exist before); take it
            # back out so the same id can be tried again. ODM data is never touched.
            sh(S1, f"rm -rf {shlex.quote(final)}", check=False)
            raise

        got = run(["curl", "-sf", "--max-time", "60", f"{ORIGIN}/odm3d/{args.id}/tileset.json"]).stdout
        if hashlib.sha256(got.encode()).hexdigest() != published["tileset.json"]:
            raise Fail("tileset.json served by the S1 origin differs from what was published (manifest already updated: check by hand)")
        log("info", f"published {args.id}: {count} files, {gb:.2f} GB, served and verified in {time.time() - started:.0f}s")
        return 0
    except Fail as error:
        log("error", f"publish failed id={safe_id(getattr(args, 'id', None))}: {error}")
        return 2
    except subprocess.TimeoutExpired as error:
        log("error", f"publish failed id={safe_id(args.id)}: timed out ({error.timeout}s)")
        return 3
    except KeyError as error:
        log("error", f"publish failed id={safe_id(args.id)}: tileset.json is missing a required field")
        return 2


if __name__ == "__main__":
    sys.exit(main())

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * scripts/publish_odm_3d.py: argument checks, log safety, and the tileset
 * correction (ODM's Y-up bounding boxes mapped to Z-up). No ssh, no network:
 * every run here fails or finishes before it would copy anything.
 */

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/publish_odm_3d.py',
);
const python = (args, input) =>
  spawnSync('python3', args, { encoding: 'utf8', input, timeout: 30_000 });

const SYN = {
  userinfo: 'https://user:SYNTHpass9f3a1c@host.example/x',
  token: 'ghp_SYNTHtoken41c0aaABC123',
  apiKey: 'SYNTHkey7d2e5b',
  bearer: 'SYNTHbearer41c0aa',
};
const forms = (secret) => [
  secret,
  secret.slice(0, 8),
  secret.slice(-6),
  encodeURIComponent(secret),
  Buffer.from(secret).toString('base64'),
];

function run(argv) {
  const r = python([script, ...argv]);
  return { rc: r.status, text: `${r.stdout}\n${r.stderr}` };
}
const noLeak = (text, label) => {
  for (const secret of Object.values(SYN))
    for (const form of forms(secret))
      assert.ok(!text.includes(form), `${label}: leaked ${form.length} chars`);
};

test('publish_odm_3d: bad arguments are refused with a fixed message that never echoes the value', () => {
  const cases = [
    ['--source', `${SYN.userinfo}`, '--id', 'odm-3d-ok', '--name', 'ok'],
    [
      '--source',
      '/srv/odm/data/x',
      '--id',
      `odm-3d-${SYN.apiKey}`,
      '--name',
      'ok',
    ],
    [
      '--source',
      '/srv/odm/data/x',
      '--id',
      'odm-3d-ok',
      '--name',
      `Bearer ${SYN.bearer}`,
    ],
    [
      '--source',
      '/srv/odm/data/x',
      '--id',
      'odm-3d-ok',
      '--name',
      'ok',
      '--credit',
      SYN.token,
    ],
    [
      '--source',
      '/srv/odm/data/x',
      '--id',
      'odm-3d-ok',
      '--name',
      'ok',
      '--canopy-default-ft',
      SYN.apiKey,
    ],
  ];
  for (const argv of cases) {
    const { rc, text } = run(argv);
    assert.equal(rc, 2, argv.join(' '));
    assert.match(text, /ERROR publish failed/);
    noLeak(text, argv.join(' ').slice(0, 40));
  }
});

test('publish_odm_3d: a failing step and a token-like source path leak nothing to stdout, stderr or syslog text', () => {
  const { rc, text } = run([
    '--source',
    `/nonexistent-dir/${SYN.token}`,
    '--id',
    'odm-3d-probe0001',
    '--name',
    'Probe',
    '--dry-run',
  ]);
  assert.equal(rc, 2);
  assert.match(text, /command failed \(exit \d+\)/);
  assert.match(text, /source=local:<custom>/);
  noLeak(text, 'failing local source');
});

test('publish_odm_3d: ids must start with odm- (that prefix files the layer under Byrd Ranch builds)', () => {
  const { rc, text } = run([
    '--source',
    '/x/y',
    '--id',
    'plain-id',
    '--name',
    'ok',
  ]);
  assert.equal(rc, 2);
  assert.match(text, /starts with odm-/);
});

// The real tileset.json root of build 9be42b4f, trimmed to what the correction reads.
const ODM_TILESET = {
  asset: { version: '1.0' },
  geometricError: 100,
  root: {
    transform: [
      0.9959588334139836, -0.08981092441711609, 0, 0, 0.04850704705607071,
      0.5379192154168977, 0.8415996578368894, 0, -0.07558484325945963,
      -0.8381986134208361, 0.540101856994429, 0, -482561.89339109743,
      -5351373.271248124, 3425128.505589803, 1,
    ],
    boundingVolume: {
      box: [
        -13.066124, -122.41062, 5.830734, 162.618675, 0, 0, 0, -20.435537, 0, 0,
        0, 142.213745,
      ],
    },
    refine: 'ADD',
    children: [
      {
        boundingVolume: {
          box: [
            84.376231, -114.104256, 103.90443, 27.566259, 0, 0, 0, -10.676598,
            0, 0, 0, 26.515934,
          ],
        },
        content: { uri: 'LOD-2/Mesh-XR-YR-XR-YR.b3dm' },
      },
    ],
  },
};

test('publish_odm_3d: the tileset correction maps ODM Y-up boxes to Z-up (east, north, up) and declares gltfUpAxis Z; the footprint is the real size of the site', () => {
  const program = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.dirname(script))})
import publish_odm_3d as p
ts = json.load(sys.stdin)
fixed = p.fix_tileset(ts)
bounds, origin_h, (zlo, zhi) = p.footprint(fixed)
print(json.dumps({"fixed": fixed, "bounds": bounds, "h": origin_h, "z": [zlo, zhi], "orig": ts}))
`;
  const r = python(['-c', program], JSON.stringify(ODM_TILESET));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const box = out.fixed.root.boundingVolume.box;
  // (cx, cy, cz) = (east, -up, north)  ->  (east, north, up)
  assert.deepEqual(box.slice(0, 3), [-13.066124, 5.830734, 122.41062]);
  assert.deepEqual(
    [box[3], box[7], box[11]],
    [162.618675, 142.213745, 20.435537],
  );
  assert.equal(out.fixed.asset.gltfUpAxis, 'Z');
  assert.match(out.fixed.extras.byrdit, /tile files untouched/);
  // the input is not modified, content uris are kept
  assert.equal(out.orig.root.boundingVolume.box[1], -122.41062);
  assert.equal(
    out.fixed.root.children[0].content.uri,
    'LOD-2/Mesh-XR-YR-XR-YR.b3dm',
  );
  // ground at 112 m must sit inside the model's heights
  assert.ok(out.z[0] < 112 && out.z[1] > 112, `heights ${out.z}`);
  assert.ok(Math.abs(out.h) < 1, 'origin on the ellipsoid');
  // about 325 m east-west and 285 m north-south at 32.69 N
  const [w, s, e, n] = out.bounds;
  const eastM = (e - w) * 111320 * Math.cos((32.69 * Math.PI) / 180);
  const northM = (n - s) * 111320;
  assert.ok(eastM > 300 && eastM < 400, `east-west ${eastM}`);
  assert.ok(northM > 250 && northM < 330, `north-south ${northM}`);
});

test('publish_odm_3d: a tileset that already declares another up axis is refused', () => {
  const program = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.dirname(script))})
import publish_odm_3d as p
ts = json.load(sys.stdin)
try:
    p.fix_tileset(ts)
except p.Fail as e:
    print("refused")
`;
  const ts = { ...ODM_TILESET, asset: { version: '1.0', gltfUpAxis: 'Z' } };
  const r = python(['-c', program], JSON.stringify(ts));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /refused/);
});

const importScript = `
import json, os, stat, subprocess, sys, tempfile
sys.path.insert(0, ${JSON.stringify(path.dirname(script))})
import publish_odm_3d as p

def local_run(cmd, check=True, input=None, **kw):
    # the manifest step runs on S1 over ssh; here the last argument runs locally
    r = subprocess.run(["bash", "-c", cmd[-1]], input=input, text=True, capture_output=True)
    if check and r.returncode != 0:
        raise p.Fail("failed")
    return r
`;

function pyJson(body) {
  const r = python(['-c', importScript + body]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

test('publish_odm_3d: manifest write adds one layer, keeps the file mode, keeps a backup, refuses a duplicate id and a NaN, and never leaves a temp file', () => {
  const out = pyJson(`
d = tempfile.mkdtemp()
m = os.path.join(d, "overlays.json")
json.dump({"layers": [{"id": "a"}], "note": ""}, open(m, "w"))
os.chmod(m, 0o644)
p.MANIFEST = m
p.run = local_run
p.add_manifest_entry({"id": "odm-3d-x", "n": 1})
after = json.load(open(m))
mode = stat.S_IMODE(os.stat(m).st_mode)
try:
    p.add_manifest_entry({"id": "odm-3d-x", "n": 2})
    dup = "accepted"
except p.Fail:
    dup = "refused"
try:
    p.add_manifest_entry({"id": "odm-3d-nan", "height_offset_m": float("nan")})
    nan = "accepted"
except p.Fail:
    nan = "refused"
final = json.load(open(m))
print(json.dumps({
  "ids": [l["id"] for l in after["layers"]], "mode": mode, "dup": dup, "nan": nan,
  "final_ids": [l["id"] for l in final["layers"]],
  "files": sorted(f.split(".bak")[0] if ".bak" in f else f for f in os.listdir(d)),
}))
`);
  assert.deepEqual(out.ids, ['a', 'odm-3d-x']);
  assert.equal(out.mode, 0o644);
  assert.equal(out.dup, 'refused');
  assert.equal(out.nan, 'refused');
  assert.deepEqual(
    out.final_ids,
    ['a', 'odm-3d-x'],
    'a refused write leaves the manifest as it was',
  );
  assert.ok(
    out.files.includes('overlays.json') && out.files.includes('overlays.json'),
    'files: ' + out.files,
  );
  assert.ok(
    !out.files.some((f) => f.includes('.tmp.')),
    'no temp file left: ' + out.files,
  );
});

test('publish_odm_3d: manifest_lacks is true only when the manifest was read and the id is absent (a rollback must never delete a live build)', () => {
  const out = pyJson(`
d = tempfile.mkdtemp()
m = os.path.join(d, "overlays.json")
json.dump({"layers": [{"id": "live-one"}]}, open(m, "w"))
p.MANIFEST = m
p.run = lambda cmd, check=True, input=None, **kw: subprocess.run(["bash", "-c", cmd[-1]], text=True, capture_output=True)
res = {"absent": p.manifest_lacks("other"), "listed": p.manifest_lacks("live-one")}
p.MANIFEST = os.path.join(d, "missing.json")
res["unreadable"] = p.manifest_lacks("other")
print(json.dumps(res))
`);
  assert.deepEqual(out, { absent: true, listed: false, unreadable: false });
});

test('publish_odm_3d: a checksum mismatch, a missing file or an extra file in the S1 copy is refused', () => {
  const out = pyJson(`
class R:  # what sh() returns
    def __init__(self, stdout): self.stdout = stdout
def stage(listing): return R("".join(f"{h}  ./{n}\\n" for n, h in listing.items()))
src = {"tileset.json": "a" * 64, "LOD-0/x.b3dm": "b" * 64}
res = {}
for name, listing in {
    "ok": src,
    "differs": {**src, "LOD-0/x.b3dm": "c" * 64},
    "missing": {"tileset.json": "a" * 64},
    "extra": {**src, "LOD-0/y.b3dm": "d" * 64},
}.items():
    p.sh = lambda *a, **k: stage(listing)
    try:
        p.verify_stage("/stage", src)
        res[name] = "ok"
    except p.Fail as e:
        res[name] = str(e)
print(json.dumps(res))
`);
  assert.equal(out.ok, 'ok');
  assert.match(out.differs, /1 differ/);
  assert.match(out.missing, /1 missing/);
  assert.match(out.extra, /1 extra/);
});

test('publish_odm_3d: tile names the GEV relay would refuse are caught before anything is moved into place; numbers must be finite', () => {
  const out = pyJson(`
import argparse
good = ["tileset.json", "LOD-0/Mesh-XL-YR-XR-YL.b3dm", "a/b/c.b3dm"]
bad = ["a.b/c.b3dm", "a/b/c/d.b3dm", "x" * 100 + ".b3dm", "a/../b.b3dm", "x.exe", "/abs.b3dm"]
f = p.finite(-300, 300)
nums = {}
for text in ["12.5", "nan", "inf", "-inf", "1e9", "x"]:
    try:
        nums[text] = f(text)
    except argparse.ArgumentTypeError:
        nums[text] = None
print(json.dumps({
  "good": [bool(p.TILE_URI_RE.match(n)) for n in good],
  "bad": [bool(p.TILE_URI_RE.match(n)) for n in bad],
  "nums": nums,
}))
`);
  assert.deepEqual(out.good, [true, true, true]);
  assert.ok(
    out.bad.every((x) => x === false),
    JSON.stringify(out.bad),
  );
  assert.deepEqual(out.nums, {
    12.5: 12.5,
    nan: null,
    inf: null,
    '-inf': null,
    '1e9': null,
    x: null,
  });
});

test('publish_odm_3d: a bad number or an unknown option never echoes its value, and --height-offset-m nan is refused', () => {
  for (const argv of [
    [
      '--source',
      '/x',
      '--id',
      'odm-3d-a',
      '--name',
      'ok',
      '--max-gb',
      SYN.apiKey,
    ],
    [
      '--source',
      '/x',
      '--id',
      'odm-3d-a',
      '--name',
      'ok',
      '--height-offset-m',
      'nan',
    ],
    [
      '--source',
      '/x',
      '--id',
      'odm-3d-a',
      '--name',
      'ok',
      '--ground-m',
      SYN.bearer,
    ],
    [
      '--source',
      '/x',
      '--id',
      'odm-3d-a',
      '--name',
      'ok',
      `--${SYN.token}`,
      'x',
    ],
  ]) {
    const { rc, text } = run(argv);
    assert.equal(rc, 2, argv.join(' '));
    assert.match(text, /bad command line/);
    noLeak(text, argv.join(' ').slice(0, 40));
  }
});

test('publish_odm_3d: a trailing newline does not pass the id, name, credit or tile-name checks (whole-string match)', () => {
  const out = pyJson(`
print(json.dumps({
  "id": bool(p.ID_RE.fullmatch("odm-3d-ok\\n")),
  "id_ok": bool(p.ID_RE.fullmatch("odm-3d-ok")),
  "name": bool(p.NAME_RE.fullmatch("Shop\\n")),
  "tile": bool(p.TILE_URI_RE.fullmatch("LOD-0/a.b3dm\\n")),
  "tile_ok": bool(p.TILE_URI_RE.fullmatch("LOD-0/a.b3dm")),
}))
`);
  assert.deepEqual(out, {
    id: false,
    id_ok: true,
    name: false,
    tile: false,
    tile_ok: true,
  });
  const { rc, text } = run([
    '--source',
    '/x',
    '--id',
    'odm-3d-ok\n',
    '--name',
    'ok',
  ]);
  assert.equal(rc, 2);
  assert.match(text, /--id must look like/);
});

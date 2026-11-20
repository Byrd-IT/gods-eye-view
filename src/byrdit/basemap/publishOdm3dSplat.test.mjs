import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * scripts/publish_odm_3d.py: the --splat path (a 3D Tiles directory exported
 * from a Gaussian splat). No ssh and no network: every run is --dry-run or
 * fails before it would copy anything. The ODM path is covered next to it so
 * the new option cannot change the correction, ground or canopy behaviour.
 */

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/publish_odm_3d.py',
);

function run(argv) {
  const r = spawnSync('python3', [script, ...argv], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { rc: r.status, text: `${r.stdout}\n${r.stderr}` };
}

const entryOf = (text) => {
  const start = text.indexOf('\n{\n');
  assert.ok(start >= 0, `no manifest entry printed:\n${text}`);
  return JSON.parse(text.slice(start + 1));
};

const tmp = () => mkdtempSync(path.join(tmpdir(), 'gev-publish-3d-'));

const TRANSFORM = [
  0.9959588334139836, -0.08981092441711609, 0, 0, 0.04850704705607071,
  0.5379192154168977, 0.8415996578368894, 0, -0.07558484325945963,
  -0.8381986134208361, 0.540101856994429, 0, -482561.89339109743,
  -5351373.271248124, 3425128.505589803, 1,
];

/** A Z-up splat tileset: standard glTF up axis, boxes already in ENU. */
const splatTileset = (extra = {}) => ({
  asset: { version: '1.0', gltfUpAxis: 'Z' },
  geometricError: 0,
  root: {
    transform: TRANSFORM,
    boundingVolume: {
      box: [0, 0, 112, 80, 0, 0, 0, 80, 0, 0, 0, 40],
    },
    refine: 'REPLACE',
    ...extra,
  },
});

/** The ODM fixture: Y-up boxes that the ODM path must keep correcting. */
const ODM_TILESET = {
  asset: { version: '1.0' },
  geometricError: 100,
  root: {
    transform: TRANSFORM,
    boundingVolume: {
      box: [
        -13.066124, -122.41062, 5.830734, 162.618675, 0, 0, 0, -20.435537, 0,
        0, 0, 142.213745,
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

function writeSplat(dir, tileset = splatTileset()) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'tileset.json'), JSON.stringify(tileset, null, 1));
}

function writeOdm(root, tileset = ODM_TILESET) {
  const model = path.join(root, '3d_tiles', 'model');
  mkdirSync(model, { recursive: true });
  writeFileSync(path.join(model, 'tileset.json'), JSON.stringify(tileset, null, 1));
  mkdirSync(path.join(root, 'odm_dem'), { recursive: true });
  writeFileSync(path.join(root, 'odm_dem', 'dtm.tif'), 'not read with --ground-m');
}

test('splat dry run: explicit ground, no ODM Y-up correction, unchanged entry schema', () => {
  const dir = tmp();
  try {
    writeSplat(dir, splatTileset({ extras: { keep: 'as exported' } }));
    const { rc, text } = run([
      '--splat',
      dir,
      '--ground-m',
      '112',
      '--id',
      'odm-3d-splat001',
      '--name',
      'Byrd Ranch splat',
      '--dry-run',
    ]);
    assert.equal(rc, 0, text);
    const entry = entryOf(text);
    assert.equal(entry.splat, true);
    assert.equal(entry.kind, 'overlay-3d');
    assert.equal(entry.format, '3dtiles');
    assert.equal(entry.ground_m, 112);
    assert.match(entry.resolution, /splat/i);
    assert.equal(entry.archive, 'odm3d/odm-3d-splat001');
    assert.equal(entry.file, 'hires/odm3d/odm-3d-splat001/tileset.json');
    // The manifest schema stays the same (the panel uses splat to hide the
    // canopy control); a splat still defaults that cut to off.
    assert.deepEqual(entry.canopy_options_ft, [90, 120]);
    assert.equal(entry.canopy_default_ft, null);
    assert.equal('sha256' in entry, false, 'a dry run copies nothing');
    // A Y-up correction would have refused this tileset (it declares Z).
    assert.equal(
      JSON.parse(readFileSync(path.join(dir, 'tileset.json'), 'utf8')).asset
        .gltfUpAxis,
      'Z',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('splat: --ground-m is required before any source is read', () => {
  const { rc, text } = run([
    '--splat',
    '/nonexistent/splat/tileset',
    '--id',
    'odm-3d-splat001',
    '--name',
    'Splat',
    '--dry-run',
  ]);
  assert.equal(rc, 2);
  assert.match(text, /--splat requires an explicit --ground-m/);
  assert.doesNotMatch(text, /command failed/);
});

test('splat: source/splat and phone/splat combinations are refused', () => {
  const cases = [
    [
      '--source',
      '/x',
      '--splat',
      '/y',
      '--ground-m',
      '1',
      '--id',
      'odm-3d-a',
      '--name',
      'ok',
    ],
    [
      '--source',
      '/x',
      '--phone-splat',
      '/y',
      '--id',
      'odm-3d-a',
      '--name',
      'ok',
    ],
    ['--id', 'odm-3d-a', '--name', 'ok'],
  ];
  for (const argv of cases) {
    const { rc, text } = run(argv);
    assert.equal(rc, 2, argv.join(' '));
    assert.match(text, /ERROR publish failed/);
  }
  // '<id>-phone' must still fit the relay's 32-character id check.
  const { rc, text } = run([
    '--splat',
    '/x',
    '--phone-splat',
    '/y',
    '--ground-m',
    '1',
    '--id',
    `odm-3d-${'a'.repeat(24)}`,
    '--name',
    'ok',
  ]);
  assert.equal(rc, 2);
  assert.match(text, /too long for a phone variant/);
});

test('splat phone variant: dry run records phone_archive and its file count', () => {
  const main = tmp();
  const phone = tmp();
  try {
    writeSplat(main);
    writeSplat(
      phone,
      splatTileset({
        boundingVolume: { box: [0, 0, 110, 40, 0, 0, 0, 40, 0, 0, 0, 30] },
      }),
    );
    const { rc, text } = run([
      '--splat',
      main,
      '--phone-splat',
      phone,
      '--ground-m',
      '112',
      '--id',
      'odm-3d-splat001',
      '--name',
      'Byrd Ranch splat',
      '--dry-run',
    ]);
    assert.equal(rc, 0, text);
    const entry = entryOf(text);
    assert.equal(entry.phone_archive, 'odm3d/odm-3d-splat001-phone');
    assert.equal(entry.phone_files, 1);
    assert.ok(entry.phone_bytes > 0);
    assert.equal(entry.splat, true);
  } finally {
    rmSync(main, { recursive: true, force: true });
    rmSync(phone, { recursive: true, force: true });
  }
});

test('splat: a ground height outside the tileset heights is refused', () => {
  const dir = tmp();
  try {
    writeSplat(dir);
    const { rc, text } = run([
      '--splat',
      dir,
      '--ground-m',
      '-400',
      '--id',
      'odm-3d-splat001',
      '--name',
      'Splat',
      '--dry-run',
    ]);
    assert.equal(rc, 2);
    assert.match(text, /outside the model's heights/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ODM regression: --source still corrects the tileset and keeps canopy fields; no splat flag', () => {
  const dir = tmp();
  try {
    writeOdm(dir);
    const { rc, text } = run([
      '--source',
      dir,
      '--ground-m',
      '112',
      '--canopy-default-ft',
      '90',
      '--id',
      'odm-3d-odm0001',
      '--name',
      'ODM build',
      '--dry-run',
    ]);
    assert.equal(rc, 0, text);
    const entry = entryOf(text);
    assert.equal('splat' in entry, false);
    assert.equal(entry.resolution, 'ODM textured 3D mesh');
    assert.deepEqual(entry.canopy_options_ft, [90, 120]);
    assert.equal(entry.canopy_default_ft, 90);
    // The correction is still the ODM one (covered in publishOdm3d.test.mjs);
    // this dry run proves the ODM path still reaches the entry unchanged.
    assert.equal(entry.ground_m, 112);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('splat full flow: both folders are placed, the tileset is unchanged, and the manifest records both', () => {
  const main = tmp();
  const phone = tmp();
  try {
    writeSplat(main, splatTileset({ extras: { keep: 'as exported' } }));
    writeSplat(
      phone,
      splatTileset({
        boundingVolume: { box: [0, 0, 110, 40, 0, 0, 0, 40, 0, 0, 0, 30] },
        children: [{ content: { uri: 'tiles/phone.glb' } }],
      }),
    );
    mkdirSync(path.join(phone, 'tiles'));
    writeFileSync(path.join(phone, 'tiles', 'phone.glb'), 'phone tile');
    const program = `
import json, os, shutil, subprocess, sys, tempfile
sys.path.insert(0, ${JSON.stringify(path.dirname(script))})
import publish_odm_3d as p

main, phone = sys.argv[1], sys.argv[2]
root = tempfile.mkdtemp()
store = os.path.join(root, "hires")
os.makedirs(os.path.join(store, "m2"))
os.makedirs(os.path.join(store, "odm3d"))
p.STORE = store
p.MANIFEST = os.path.join(store, "m2", "overlays.json")
json.dump({"layers": [], "note": ""}, open(p.MANIFEST, "w"))

def local_run(cmd, check=True, input=None, **kw):
    if cmd[0] == "curl":  # the origin check: serve the placed file back
        name = cmd[-1].split("/")[-2]
        text = open(os.path.join(store, "odm3d", name, "tileset.json")).read()
        return subprocess.CompletedProcess(cmd, 0, stdout=text, stderr="")
    r = subprocess.run(["bash", "-c", cmd[-1]], input=input, text=True, capture_output=True)
    if check and r.returncode != 0:
        raise p.Fail("failed")
    return r
p.run = local_run
p.stream = lambda host, model, stage: shutil.copytree(model, stage)

rc = p.main(["--splat", main, "--phone-splat", phone, "--ground-m", "112",
             "--id", "odm-3d-full001", "--name", "Full splat"])
layer = json.load(open(p.MANIFEST))["layers"][-1]
base = os.path.join(store, "odm3d")
print(json.dumps({
  "rc": rc,
  "splat": layer.get("splat"),
  "phone": layer.get("phone_archive"),
  "main_files": sorted(os.listdir(os.path.join(base, "odm-3d-full001"))),
  "phone_files": sorted(os.listdir(os.path.join(base, "odm-3d-full001-phone"))),
  "up_axis": json.load(open(os.path.join(main, "tileset.json")))["asset"]["gltfUpAxis"],
  "extras": json.load(open(os.path.join(main, "tileset.json")))["root"].get("extras"),
  "sha": bool(layer.get("sha256")), "phone_sha": bool(layer.get("phone_sha256")),
}))
`;
    const r = spawnSync(
      'python3',
      ['-c', program, main, phone],
      { encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
    assert.equal(out.rc, 0);
    assert.equal(out.splat, true);
    assert.equal(out.phone, 'odm3d/odm-3d-full001-phone');
    assert.ok(out.main_files.includes('tileset.json'));
    assert.ok(
      !out.main_files.includes('tileset.original.json'),
      'a splat tileset is not rewritten',
    );
    assert.ok(out.phone_files.includes('tileset.json'));
    assert.ok(out.phone_files.includes('SHA256SUMS.txt'));
    assert.equal(out.up_axis, 'Z');
    assert.deepEqual(out.extras, { keep: 'as exported' });
    assert.equal(out.sha, true);
    assert.equal(out.phone_sha, true);
  } finally {
    rmSync(main, { recursive: true, force: true });
    rmSync(phone, { recursive: true, force: true });
  }
});

test('ODM full flow: the corrected tileset, the original and the checksums are published', () => {
  const dir = tmp();
  try {
    writeOdm(dir);
    mkdirSync(path.join(dir, '3d_tiles', 'model', 'LOD-2'), {
      recursive: true,
    });
    writeFileSync(
      path.join(dir, '3d_tiles', 'model', 'LOD-2', 'Mesh-XR-YR-XR-YR.b3dm'),
      'odm tile',
    );
    const program = `
import json, os, shutil, subprocess, sys, tempfile
sys.path.insert(0, ${JSON.stringify(path.dirname(script))})
import publish_odm_3d as p

root = sys.argv[1]
work = tempfile.mkdtemp()
store = os.path.join(work, "hires")
os.makedirs(os.path.join(store, "m2"))
os.makedirs(os.path.join(store, "odm3d"))
p.STORE = store
p.MANIFEST = os.path.join(store, "m2", "overlays.json")
json.dump({"layers": [], "note": ""}, open(p.MANIFEST, "w"))

def local_run(cmd, check=True, input=None, **kw):
    if cmd[0] == "curl":
        name = cmd[-1].split("/")[-2]
        text = open(os.path.join(store, "odm3d", name, "tileset.json")).read()
        return subprocess.CompletedProcess(cmd, 0, stdout=text, stderr="")
    r = subprocess.run(["bash", "-c", cmd[-1]], input=input, text=True, capture_output=True)
    if check and r.returncode != 0:
        raise p.Fail("failed")
    return r
p.run = local_run
p.stream = lambda host, model, stage: shutil.copytree(model, stage)

rc = p.main(["--source", root, "--ground-m", "112", "--canopy-default-ft", "90",
             "--id", "odm-3d-odmfull1", "--name", "ODM full"])
final = os.path.join(store, "odm3d", "odm-3d-odmfull1")
fixed = json.load(open(os.path.join(final, "tileset.json")))
orig = json.load(open(os.path.join(final, "tileset.original.json")))
layer = json.load(open(p.MANIFEST))["layers"][-1]
print(json.dumps({
  "rc": rc,
  "files": sorted(os.listdir(final)),
  "up_axis": fixed["asset"].get("gltfUpAxis"),
  "fixed_box": fixed["root"]["boundingVolume"]["box"][:3],
  "orig_y": orig["root"]["boundingVolume"]["box"][1],
  "splat": "splat" in layer,
  "canopy": [layer.get("canopy_options_ft"), layer.get("canopy_default_ft")],
  "sha": bool(layer.get("sha256")),
}))
`;
    const r = spawnSync(
      'python3',
      ['-c', program, dir],
      { encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
    assert.equal(out.rc, 0);
    assert.ok(out.files.includes('tileset.json'));
    assert.ok(out.files.includes('tileset.original.json'));
    assert.ok(out.files.includes('SHA256SUMS.txt'));
    assert.equal(out.up_axis, 'Z');
    assert.deepEqual(out.fixed_box, [-13.066124, 5.830734, 122.41062]);
    assert.equal(out.orig_y, -122.41062);
    assert.equal(out.splat, false);
    assert.deepEqual(out.canopy, [[90, 120], 90]);
    assert.equal(out.sha, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('splat failure: a bad phone tile rolls the already-placed main folder back', () => {
  const main = tmp();
  const phone = tmp();
  try {
    writeSplat(main);
    writeSplat(
      phone,
      splatTileset({
        children: [{ content: { uri: 'tiles/phone.exe' } }],
      }),
    );
    mkdirSync(path.join(phone, 'tiles'));
    writeFileSync(path.join(phone, 'tiles', 'phone.exe'), 'not served');
    const program = `
import json, os, shutil, subprocess, sys, tempfile
sys.path.insert(0, ${JSON.stringify(path.dirname(script))})
import publish_odm_3d as p

main, phone = sys.argv[1], sys.argv[2]
work = tempfile.mkdtemp()
store = os.path.join(work, "hires")
os.makedirs(os.path.join(store, "m2"))
os.makedirs(os.path.join(store, "odm3d"))
p.STORE = store
p.MANIFEST = os.path.join(store, "m2", "overlays.json")
json.dump({"layers": [], "note": ""}, open(p.MANIFEST, "w"))

def local_run(cmd, check=True, input=None, **kw):
    if cmd[0] == "curl":
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
    r = subprocess.run(["bash", "-c", cmd[-1]], input=input, text=True, capture_output=True)
    if check and r.returncode != 0:
        raise p.Fail("failed")
    return r
p.run = local_run
p.stream = lambda host, model, stage: shutil.copytree(model, stage)

rc = p.main(["--splat", main, "--phone-splat", phone, "--ground-m", "112",
             "--id", "odm-3d-roll001", "--name", "Rollback"])
print(json.dumps({
  "rc": rc,
  "layers": len(json.load(open(p.MANIFEST))["layers"]),
  "final": os.path.exists(os.path.join(store, "odm3d", "odm-3d-roll001")),
  "phone_final": os.path.exists(os.path.join(store, "odm3d", "odm-3d-roll001-phone")),
  "staging": [n for n in os.listdir(os.path.join(store, "odm3d")) if n.startswith(".staging-")],
}))
`;
    const r = spawnSync(
      'python3',
      ['-c', program, main, phone],
      { encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      `${r.stdout}\n${r.stderr}`,
      /not ones the GEV server will serve/,
    );
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
    assert.equal(out.rc, 2);
    assert.equal(out.layers, 0, 'the manifest was never touched');
    assert.equal(out.final, false, 'the placed main folder was removed');
    assert.equal(out.phone_final, false);
    assert.deepEqual(out.staging, []);
  } finally {
    rmSync(main, { recursive: true, force: true });
    rmSync(phone, { recursive: true, force: true });
  }
});

test('splat: a token-like source path is not echoed in a failing run', () => {
  const secret = 'ghp_SYNTHtoken41c0aaABC123';
  const { rc, text } = run([
    '--splat',
    `/nonexistent/${secret}`,
    '--ground-m',
    '1',
    '--id',
    'odm-3d-splat001',
    '--name',
    'Splat',
    '--dry-run',
  ]);
  assert.equal(rc, 2);
  assert.match(text, /source=local:<custom>/);
  assert.ok(!text.includes(secret));
});

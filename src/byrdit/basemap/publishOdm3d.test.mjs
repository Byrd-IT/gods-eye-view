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

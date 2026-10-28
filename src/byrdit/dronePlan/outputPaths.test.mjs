import assert from 'node:assert/strict';
import test from 'node:test';
import { readZip, makeZip } from './zip.js';
import {
  assembleMissions,
  footprint,
  normalizeOptions,
  planFlight,
} from './planner.js';
import { getPreset } from './presets.js';
import { buildBundleZip, buildKmz, esc, readmeText } from './wpml.js';
import { planErrorText, warningText } from './format.js';
import { validateDroneBox } from './limits.js';
import { sampleGround } from './terrain.js';

// Synthetic secrets in every shape the pre-review gate names. They are fake,
// built from a random nonce each run, and never real credentials.
const nonce = Math.random().toString(36).slice(2, 10);
const SECRETS = {
  bearer: `Bearer synth-${nonce}-bearer`,
  userinfo: `https://svc:synth-${nonce}-pw@internal.example/path`,
  suffixed: `synth-${nonce}-tok-ABC123`,
  header: `X-Api-Key: synth-${nonce}-hdr`,
  query: `https://api.example/v1?api_key=synth-${nonce}-qs`,
};
const forms = (secret) => {
  const body = secret.replace(/^.*?(synth-[a-z0-9-]+).*$/i, '$1');
  return [
    secret,
    body,
    body.slice(0, 8),
    body.slice(-6),
    encodeURIComponent(secret),
    Buffer.from(secret).toString('base64'),
    Buffer.from(body).toString('base64'),
  ];
};
const ALL = Object.values(SECRETS).flatMap(forms);
const clean = (text, where) => {
  for (const needle of ALL) {
    assert.ok(
      !String(text).includes(needle),
      `${where} leaked ${needle.slice(0, 6)}...`,
    );
  }
};
const caught = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected a throw');
};
const dump = (error) =>
  [
    error.message,
    error.stack,
    JSON.stringify(error),
    String(error.cause ?? ''),
  ].join('\n');

const BOX = { west: -97.772, east: -97.768, south: 30.268, north: 30.271 };

test('secret-looking option values never reach a plan, a KMZ, a README or a warning', () => {
  const hostile = Object.values(SECRETS);
  const plan = planFlight(BOX, {
    presetId: hostile[0],
    pattern: hostile[1],
    photoMode: hostile[2],
    direction: hostile[3],
    aglM: hostile[4],
    speedMs: hostile[0],
    orbitHeightsM: hostile,
    takeoff: { lon: hostile[1], lat: hostile[2] },
    note: hostile[3],
    [hostile[4]]: hostile[0],
  });
  assert.equal(plan.error, undefined);
  assert.equal(
    plan.preset.id,
    'dji-mini-5-pro',
    'unknown aircraft falls back, it is not echoed',
  );
  const ids = plan.legs.flatMap((l) => l.waypoints.map((w) => w.id));
  const result = assembleMissions(plan, {
    known: true,
    takeoffM: 1,
    wpM: ids.map(() => 1),
  });
  clean(JSON.stringify(plan.options), 'normalized options');
  assert.equal(
    plan.options.takeoff,
    null,
    'a takeoff that is not two numbers is dropped',
  );
  assert.equal(plan.takeoff.custom, false);
  assert.deepEqual(
    Object.keys(plan.options).sort(),
    Object.keys(normalizeOptions({}).options).sort(),
    'options carry only the known names',
  );
  clean(JSON.stringify(result.warnings), 'warnings');
  clean(readmeText(result), 'README');
  const zip = readZip(buildBundleZip(result));
  for (const [name, bytes] of zip) {
    clean(name, 'zip entry name');
    clean(new TextDecoder().decode(bytes), `zip entry ${name}`);
  }
  for (const w of result.warnings) clean(warningText(w), 'warning text');
  clean(
    warningText({ code: SECRETS.bearer, params: { distanceM: SECRETS.query } }),
    'unknown warning',
  );
  assert.equal(
    warningText({ code: SECRETS.bearer, params: {} }),
    '',
    'unknown codes are dropped',
  );
});

test('error and refusal paths carry no caller text', () => {
  clean(planErrorText(SECRETS.userinfo), 'plan error');
  const refusal = validateDroneBox({
    west: SECRETS.header,
    south: 0,
    east: 1,
    north: 1,
  });
  clean(JSON.stringify(refusal), 'box refusal');
  const tilt = caught(() => footprint(getPreset('dji-mini-5-pro'), 100, 80));
  clean(dump(tilt), 'tilt RangeError');
  const bad = caught(() =>
    readZip(new TextEncoder().encode(Object.values(SECRETS).join(' '))),
  );
  clean(dump(bad), 'readZip on junk');
  const corrupt = makeZip([{ name: 'a.txt', data: SECRETS.suffixed }]);
  corrupt[Buffer.from(corrupt).indexOf(SECRETS.suffixed)] ^= 1; // flip a stored byte
  const crc = caught(() => readZip(corrupt));
  clean(dump(crc), 'readZip CRC error');
  assert.match(crc.message, /Bad CRC for a\.txt/);
});

test('the terrain sampler swallows a failing provider without surfacing its message', async () => {
  const logs = [];
  const original = {
    error: console.error,
    warn: console.warn,
    log: console.log,
  };
  console.error = console.warn = console.log = (...a) => logs.push(a.join(' '));
  try {
    const out = await sampleGround({
      viewer: { terrainProvider: { requestTileGeometry() {} } },
      cesium: {
        EllipsoidTerrainProvider: class {},
        Cartographic: { fromDegrees: () => ({}) },
        sampleTerrainMostDetailed: async () => {
          throw new Error(`upstream said ${SECRETS.bearer} ${SECRETS.query}`);
        },
      },
      points: [{ lon: -95, lat: 30 }],
      takeoff: { lon: -95, lat: 30 },
    });
    assert.equal(out.known, false);
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(logs, [], 'nothing is logged');
});

test('an author name is XML-escaped and appears only where the caller put it', () => {
  const plan = planFlight(BOX, {});
  const ids = plan.legs.flatMap((l) => l.waypoints.map((w) => w.id));
  const result = assembleMissions(plan, {
    known: false,
    wpM: ids.map(() => 0),
  });
  const name = `<x a="${SECRETS.header}">&`;
  const files = readZip(buildKmz(result.missions[0], result.plan, { name }));
  const template = new TextDecoder().decode(files.get('wpmz/template.kml'));
  assert.ok(!template.includes('<x a='), 'markup is escaped');
  assert.equal(esc(name).includes('<'), false);
  const waylines = new TextDecoder().decode(files.get('wpmz/waylines.wpml'));
  clean(waylines, 'waylines.wpml');
  assert.equal(
    normalizeOptions({ presetId: SECRETS.bearer }).options.presetId,
    'dji-mini-5-pro',
  );
});

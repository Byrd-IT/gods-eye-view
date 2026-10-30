// Reading and checking DJI Fly waypoint files: two REAL DJI Fly Mini 5 Pro
// files (saved 2026-10-30) and the KMZ this tool writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { checkMission, distanceM, missionIdFromFileName, parseDjiKmz } from './djiKmz.js';
import { parseXml } from './xml.js';
import { DRONE_PRESETS, getPreset } from './presets.js';
import { assembleMissions, planFlight } from './planner.js';
import { buildKmz } from './wpml.js';
import { makeZip, readZipAsync } from './zip.js';
import { metersPerDegree } from './geo.js';

const dir = new URL('./fixtures/djifly-mini5pro/', import.meta.url);
const A = '9560F7B3-DAA9-481A-B2F5-37CCF3B8B996';
const B = '8A05BD5F-A9CE-4867-923F-7AACC02AF9A9';
const load = (id) => new Uint8Array(readFileSync(new URL(`${id}.kmz`, dir)));
const mini5 = getPreset('dji-mini-5-pro');
const codes = (list) => list.map((x) => x.code);

test('the fixtures are the real DJI Fly files (sha256)', () => {
  const sha = (id) => createHash('sha256').update(load(id)).digest('hex');
  assert.match(sha(A), /^674137ca.*6608$/);
  assert.match(sha(B), /^ba616447.*a4a3$/);
});

test('missionIdFromFileName: UUID, browser suffixes stripped', () => {
  assert.equal(missionIdFromFileName(`${A}.kmz`), A);
  assert.equal(missionIdFromFileName(`${A.toLowerCase()} (1).kmz`), A);
  assert.equal(missionIdFromFileName(`${A}[2].kmz`), A);
  assert.equal(missionIdFromFileName(`C:\\Users\\x\\Downloads\\${A} (12).KMZ`), A);
  assert.equal(missionIdFromFileName('gev-drone-plan-20261028.kmz'), null);
  assert.equal(missionIdFromFileName(null), null);
});

test('DJI Fly file 9560 (3 waypoints) is read from waylines.wpml', async () => {
  const m = await parseDjiKmz(load(A), { fileName: `${A} (1).kmz` });
  assert.equal(m.error, undefined);
  assert.equal(m.uuid, A);
  assert.equal(m.namespace, 'http://www.uav.com/wpmz/1.0.2');
  assert.equal(m.usedTemplateFallback, false);
  assert.equal(m.waypoints.length, 3);
  assert.deepEqual(m.templateChildren, ['wpml:author', 'wpml:createTime', 'wpml:updateTime', 'wpml:missionConfig']);
  assert.equal(m.config.droneEnumValue, 68);
  assert.equal(m.config.droneSubEnumValue, 0);
  assert.equal(m.wayline.executeHeightMode, 'relativeToStartPoint');
  const w0 = m.waypoints[0];
  assert.equal(w0.index, 0);
  assert.ok(Math.abs(w0.lon - -95.1526365616652) < 1e-9);
  assert.ok(Math.abs(w0.lat - 32.6907613486555) < 1e-9);
  assert.equal(w0.heightM, 50);
  assert.equal(w0.speedMs, 2.5);
  assert.equal(w0.heading.mode, 'followWayline');
  assert.equal(w0.heading.poi, null);
  assert.equal(w0.turn.mode, 'toPointAndStopWithContinuityCurvature');
  assert.deepEqual(w0.groups.map((g) => [g.id, g.mode, g.actions[0].func]), [
    [1, 'parallel', 'gimbalRotate'],
    [2, 'parallel', 'gimbalEvenlyRotate'],
  ]);
});

test('DJI Fly file 8A05 (2 waypoints, towardPOI): POI is LAT,LON,ALT', async () => {
  const m = await parseDjiKmz(load(B), { fileName: `${B}.kmz` });
  assert.equal(m.waypoints.length, 2);
  const w0 = m.waypoints[0];
  assert.equal(w0.heading.mode, 'towardPOI');
  assert.deepEqual(w0.heading.poi, { lat: 32.203121, lon: -95.728449, altM: 50 });
  assert.equal(m.waypoints[1].heading.mode, 'followWayline');
  assert.equal(m.waypoints[1].heading.poi, null);
});

test('compatibility check: the real files are clean for a Mini 5 Pro; 8A05 is flagged far apart', async () => {
  const a = checkMission(await parseDjiKmz(load(A), { fileName: `${A}.kmz` }), { preset: mini5 });
  assert.deepEqual(a, []);
  const b = checkMission(await parseDjiKmz(load(B), { fileName: `${B}.kmz` }), { preset: mini5 });
  assert.deepEqual(codes(b), ['far-apart']);
  assert.ok(b[0].args.km >= 140 && b[0].args.km <= 160, `km ${b[0].args.km}`);
});

test('the file for another aircraft is flagged, a different model override too', async () => {
  const m = await parseDjiKmz(load(A), { fileName: `${A}.kmz` });
  assert.ok(codes(checkMission(m, { preset: mini5, droneEnumValue: 77 })).includes('drone-mismatch'));
  assert.ok(!codes(checkMission(m, { preset: mini5, droneEnumValue: 68 })).includes('drone-mismatch'));
  const other = Object.values(DRONE_PRESETS).find(
    (p) => p.wpml && p.wpml.droneEnumValue !== 68,
  );
  if (other) {
    assert.ok(codes(checkMission(m, { preset: other })).includes('drone-mismatch'));
  }
});

/** Rewrite one entry of a fixture and re-zip it. */
async function mutate(id, edit) {
  const files = await readZipAsync(load(id));
  const out = [];
  for (const [name, data] of files) {
    out.push({ name, data: edit(name, new TextDecoder().decode(data)) });
  }
  return makeZip(out);
}

test('the checker flags every rule it states', async () => {
  const check = async (edit) =>
    codes(checkMission(await parseDjiKmz(await mutate(A, edit), { fileName: `${A}.kmz` }), { preset: mini5 }));
  const way = (fn) => (name, text) => (name.endsWith('waylines.wpml') ? fn(text) : text);
  const both = (fn) => (name, text) => fn(text);
  assert.ok((await check(both((t) => t.replaceAll('http://www.uav.com/wpmz/1.0.2', 'http://x/1.0.1')))).includes('namespace'));
  assert.ok((await check(way((t) => t.replace('<wpml:index>1</wpml:index>', '<wpml:index>5</wpml:index>')))).includes('index-gap'));
  assert.ok((await check(way((t) => t.replace('relativeToStartPoint', 'EGM96')))).includes('height-mode'));
  assert.ok((await check(way((t) => t.replace('<wpml:executeHeight>50</wpml:executeHeight>', '<wpml:executeHeight>400</wpml:executeHeight>')))).includes('height-range'));
  assert.ok((await check(way((t) => t.replaceAll('<wpml:actionGroupMode>parallel', '<wpml:actionGroupMode>sequence').replaceAll('parallel</wpml:actionGroupMode>', 'sequence</wpml:actionGroupMode>')))).includes('group-mode'));
  assert.ok((await check(way((t) => t.replace('<wpml:actionGroupId>1<', '<wpml:actionGroupId>0<')))).includes('group-ids'));
  assert.ok((await check(way((t) => t.replace('<wpml:actionId>2<', '<wpml:actionId>1<')))).includes('action-ids'));
  assert.ok((await check((name, t) => (name.endsWith('template.kml') ? t.replace('</Document>', '<Folder></Folder></Document>') : t))).includes('template-shape'));
  assert.ok((await check(way((t) => t.replace('<wpml:waypointSpeed>2.5<', '<wpml:waypointSpeed>40<')))).includes('speed-range'));
  const many = await check(way((t) => t));
  assert.deepEqual(many, []);
});

test('legacy layout (waypoints in template.kml only) is read with an info note', async () => {
  const files = await readZipAsync(load(A));
  const way = new TextDecoder().decode(files.get('wpmz/waylines.wpml'));
  const folder = way.slice(way.indexOf('<Folder>'), way.indexOf('</Folder>') + 9);
  const tpl = new TextDecoder().decode(files.get('wpmz/template.kml')).replace('</Document>', `${folder}</Document>`);
  const kmz = makeZip([{ name: 'wpmz/template.kml', data: tpl }]);
  const m = await parseDjiKmz(kmz, { fileName: 'x.kmz' });
  assert.equal(m.waypoints.length, 3);
  assert.equal(m.usedTemplateFallback, true);
  const got = codes(checkMission(m, { preset: mini5 }));
  assert.ok(got.includes('no-waylines') && got.includes('template-shape'));
});

test('unreadable input comes back as an error code, never a throw', async () => {
  for (const [bytes, code] of [
    [new Uint8Array(), 'empty'],
    [new Uint8Array([1, 2, 3, 4]), 'not-a-kmz'],
    [makeZip([{ name: 'a.txt', data: 'x' }]), 'no-wpmz'],
    [makeZip([{ name: 'wpmz/waylines.wpml', data: '<kml><oops></kml>' }]), 'bad-xml'],
  ]) {
    const m = await parseDjiKmz(bytes, { fileName: 'x.kmz' });
    assert.equal(m.error, code);
    assert.equal(codes(checkMission(m, { preset: mini5 }))[0], `read-${code}`);
  }
});

test('XML reader: entities, CDATA, nesting limit, no external entities', () => {
  const doc = parseXml('<?xml version="1.0"?><a b="1&amp;2"><c><![CDATA[<x>]]>&lt;&#65;</c><d/></a>');
  // A DTD (the way external entities are declared) is refused, never processed.
  assert.throws(
    () => parseXml('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><a>&e;</a>'),
    /Malformed/,
  );
  assert.equal(doc.children[0].attrs.b, '1&2');
  assert.equal(doc.children[0].children[0].text, '<x><A');
  assert.throws(() => parseXml('<a>'.repeat(100)), /deep/);
  assert.throws(() => parseXml('<a></b>'), /Mismatched/);
  const ent = parseXml('<a>&e;</a>');
  assert.equal(ent.children[0].text, '&e;', 'unknown entity stays text');
});

test('what this tool exports passes its own check and reads back', async () => {
  const m = metersPerDegree(30.27);
  const box = { west: -97.77 - 200 / m.lon, east: -97.77 + 200 / m.lon, south: 30.27 - 100 / m.lat, north: 30.27 + 100 / m.lat };
  const plan = planFlight(box, { aglM: 60, batteryMin: 60 });
  const ids = plan.legs.flatMap((l) => l.waypoints.map((w) => w.id));
  const result = assembleMissions(plan, { known: true, takeoffM: 100, wpM: ids.map(() => 100) });
  const mission = result.missions[0];
  const parsed = await parseDjiKmz(buildKmz(mission, result.plan), { fileName: 'gev.kmz' });
  assert.equal(parsed.waypoints.length, mission.waypointCount);
  assert.deepEqual(checkMission(parsed, { preset: result.plan.preset }), []);
  assert.ok(distanceM(parsed.waypoints[0], parsed.waypoints[1]) > 0);
});

test('zip bomb: total inflated size is capped and unwanted entries are never inflated', async () => {
  const chunk = new Uint8Array(15 * 1024 * 1024); // compresses to almost nothing
  const bomb = makeZip(Array.from({ length: 4 }, (_, i) => ({ name: `junk/${i}.bin`, data: chunk })));
  await assert.rejects(() => readZipAsync(bomb), /too large/);
  const files = await readZipAsync(bomb, { only: (n) => n === 'nothing' });
  assert.equal(files.size, 0, 'skipped entries are not read');
  const kmz = makeZip([
    { name: 'junk/a.bin', data: chunk },
    { name: 'junk/b.bin', data: chunk },
    { name: 'junk/c.bin', data: chunk },
    { name: 'wpmz/template.kml', data: '<kml/>' },
  ]);
  const m = await parseDjiKmz(kmz, { fileName: 'x.kmz' });
  assert.notEqual(m.error, 'not-a-kmz', 'junk entries beside the mission do not trip the cap');
});

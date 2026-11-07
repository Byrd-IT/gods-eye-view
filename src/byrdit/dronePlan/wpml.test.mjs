import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, makeZip, readZip } from './zip.js';
import { assembleMissions, planFlight } from './planner.js';
import { minShutterDenominator, SHUTTER_DENOMINATORS } from './speed.js';
import { getPreset } from './presets.js';
import { metersPerDegree } from './geo.js';
import {
  WPML_NAMESPACE,
  buildBundleZip,
  buildKmz,
  buildMissionFiles,
  esc,
  kmzFileName,
  readmeText,
} from './wpml.js';

const decode = (bytes) => new TextDecoder().decode(bytes);

/** A small strict XML reader: enough to parse back what the writer emits. */
function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re =
    /<\?[^?]*\?>|<!--[\s\S]*?-->|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const [full, close, name, attrText, selfClose, chars] = m;
    if (chars !== undefined) {
      stack.at(-1).text += chars;
    } else if (name && !close) {
      const attrs = {};
      for (const a of attrText.matchAll(/([\w:.-]+)="([^"]*)"/g))
        attrs[a[1]] = a[2];
      const node = { name, attrs, children: [], text: '' };
      stack.at(-1).children.push(node);
      if (!selfClose) stack.push(node);
    } else if (name && close) {
      const open = stack.pop();
      assert.equal(
        open.name,
        name,
        `mismatched </${name}> (open ${open.name})`,
      );
    } else if (!full.startsWith('<?') && !full.startsWith('<!--')) {
      assert.fail(`unparsed markup ${full}`);
    }
  }
  assert.equal(stack.length, 1, 'unclosed element');
  return root.children[0];
}
const find = (node, name) => node.children.find((c) => c.name === name);
const all = (node, name, out = []) => {
  if (node.name === name) out.push(node);
  node.children.forEach((c) => all(c, name, out));
  return out;
};
const textOf = (node, name) => all(node, name)[0]?.text.trim();

const box = (() => {
  const m = metersPerDegree(30.27);
  return {
    west: -97.77 - 200 / m.lon,
    east: -97.77 + 200 / m.lon,
    south: 30.27 - 100 / m.lat,
    north: 30.27 + 100 / m.lat,
  };
})();
function build(options = {}) {
  const plan = planFlight(box, { aglM: 100, batteryMin: 60, ...options });
  const ids = plan.legs.flatMap((l) => l.waypoints.map((w) => w.id));
  return assembleMissions(plan, {
    known: true,
    takeoffM: 100,
    wpM: ids.map((id) => 100 + (id % 5)),
  });
}

test('KMZ holds exactly template.kml and waylines.wpml and both parse', () => {
  const result = build();
  const files = readZip(buildKmz(result.missions[0], result.plan));
  assert.deepEqual(
    [...files.keys()],
    ['wpmz/template.kml', 'wpmz/waylines.wpml'],
  );
  for (const name of files.keys()) {
    const doc = parseXml(decode(files.get(name)));
    assert.equal(doc.name, 'kml');
    assert.equal(doc.attrs['xmlns:wpml'], WPML_NAMESPACE);
    assert.equal(doc.attrs.xmlns, 'http://www.opengis.net/kml/2.2');
  }
});

test('template.kml holds ONLY author, times and missionConfig (as DJI Fly writes it)', () => {
  const result = build();
  const mission = result.missions[0];
  const { templateKml } = buildMissionFiles(mission, result.plan, {
    createdMs: 1793176000000,
  });
  const doc = parseXml(templateKml);
  assert.equal(textOf(doc, 'wpml:createTime'), '1793176000000');
  assert.equal(textOf(doc, 'wpml:finishAction'), 'goHome');
  assert.equal(textOf(doc, 'wpml:flyToWaylineMode'), 'safely');
  assert.equal(textOf(doc, 'wpml:droneEnumValue'), '68');
  assert.equal(textOf(doc, 'wpml:droneSubEnumValue'), '0');
  assert.equal(all(doc, 'Folder').length, 0, 'no Folder');
  assert.equal(all(doc, 'Placemark').length, 0, 'no waypoints');
  const document = all(doc, 'Document')[0];
  assert.deepEqual(
    document.children.map((c) => c.name),
    ['wpml:author', 'wpml:createTime', 'wpml:updateTime', 'wpml:missionConfig'],
  );
});

test('waylines.wpml lists every waypoint with height, speed and turn mode', () => {
  const result = build();
  const mission = result.missions[0];
  const { waylinesWpml } = buildMissionFiles(mission, result.plan);
  const doc = parseXml(waylinesWpml);
  assert.equal(textOf(doc, 'wpml:executeHeightMode'), 'relativeToStartPoint');
  const marks = all(doc, 'Placemark');
  assert.equal(marks.length, mission.waypointCount);
  marks.forEach((mark, i) => {
    const wp = mission.waypoints[i];
    assert.equal(textOf(mark, 'wpml:index'), String(i));
    const [lon, lat] = textOf(mark, 'coordinates').split(',').map(Number);
    assert.ok(Math.abs(lon - wp.lon) < 1e-7 && Math.abs(lat - wp.lat) < 1e-7);
    assert.equal(
      Number(textOf(mark, 'wpml:executeHeight')).toFixed(1),
      wp.relHeightM.toFixed(1),
    );
    assert.equal(
      Number(textOf(mark, 'wpml:waypointSpeed')),
      result.plan.speedMs,
    );
    // DJI Fly writes the first and the last waypoint as stops.
    assert.equal(
      textOf(mark, 'wpml:waypointTurnMode'),
      i === 0 || i === marks.length - 1
        ? 'toPointAndStopWithContinuityCurvature'
        : 'toPointAndPassWithContinuityCurvature',
    );
    assert.equal(
      textOf(mark, 'wpml:waypointHeadingAngleEnable'),
      i === 0 || i === marks.length - 1 ? '1' : '0',
    );
    assert.equal(textOf(mark, 'wpml:waypointGimbalPitchAngle'), '-90');
  });
  // The folder is written as DJI Fly re-saves it; each waypoint's own speed flies.
  assert.equal(textOf(doc, 'wpml:distance'), '0');
  assert.equal(textOf(doc, 'wpml:duration'), '0');
  assert.equal(textOf(doc, 'wpml:autoFlightSpeed'), '2.5');
});

test('photo at every waypoint: one group per waypoint, tilt on the first, gradual tilt per leg', () => {
  const result = build();
  const mission = result.missions[0];
  const { waylinesWpml } = buildMissionFiles(mission, result.plan);
  const doc = parseXml(waylinesWpml);
  const funcs = all(doc, 'wpml:actionActuatorFunc').map((n) => n.text.trim());
  const count = (f) => funcs.filter((x) => x === f).length;
  assert.equal(count('takePhoto'), mission.photoCount);
  assert.equal(
    count('gimbalRotate'),
    mission.waypointCount,
    'every waypoint states its own pitch with a gimbalRotate',
  );
  assert.equal(count('gimbalEvenlyRotate'), mission.legs.length - 1);
  assert.ok(mission.legs.length > 2, 'the test needs several legs');
  const actionIds = all(doc, 'wpml:actionId').map((n) => Number(n.text));
  assert.deepEqual(
    [...actionIds].sort((a, b) => a - b),
    actionIds.map((_, i) => i + 1),
    'action ids are unique across the mission: 1..n',
  );
  const marks = all(doc, 'Placemark');
  marks.forEach((mark, i) => {
    const groups = all(mark, 'wpml:actionGroup');
    groups.forEach((g, n) => {
      assert.equal(textOf(g, 'wpml:actionTriggerType'), 'reachPoint');
      // Every photo waypoint: rotate and photo are one ORDERED group (rotate
      // first). The gradual tilt group is parallel.
      assert.equal(textOf(g, 'wpml:actionGroupMode'), n === 0 ? 'sequence' : 'parallel');
      assert.equal(textOf(g, 'wpml:actionGroupId'), String(n + 1), 'group ids restart at 1');
    });
    const first = groups[0];
    assert.equal(textOf(first, 'wpml:actionGroupStartIndex'), String(i));
    assert.equal(textOf(first, 'wpml:actionGroupEndIndex'), String(i));
    const fns = all(first, 'wpml:actionActuatorFunc').map((n) => n.text.trim());
    // First waypoint: tilt and photo in ONE sequence group, TILT first, so the
    // first photo is taken at the planned pitch (DJI Fly's parallel form took it
    // at the leftover pitch on the 2026-11-01 flight).
    assert.deepEqual(fns, ['gimbalRotate', 'takePhoto']);
    if (groups[1]) {
      assert.equal(groups.length, 2);
      assert.equal(textOf(groups[1], 'wpml:actionGroupStartIndex'), String(i));
      assert.equal(textOf(groups[1], 'wpml:actionGroupEndIndex'), String(i + 1));
      assert.deepEqual(
        all(groups[1], 'wpml:actionActuatorFunc').map((n) => n.text.trim()),
        ['gimbalEvenlyRotate'],
      );
    }
  });
  // The tilt of a leg sits on the waypoint BEFORE the leg's first waypoint.
  const starts = mission.legs.slice(1).map((l) => l.waypoints[0].index - 1);
  const withTilt = marks
    .map((m, i) => (all(m, 'wpml:actionActuatorFunc').some((n) => n.text.trim() === 'gimbalEvenlyRotate') ? i : -1))
    .filter((i) => i >= 0);
  assert.deepEqual(withTilt, starts);
  assert.equal(all(doc, 'wpml:gimbalPitchRotateAngle')[0].text.trim(), '-90');
  assert.equal((waylinesWpml.match(/<wpml:useGlobalPayloadLensIndex>0</g) ?? []).length, mission.photoCount);
});

test('interval mode: one distance-triggered photo group per leg', () => {
  const result = build({ photoMode: 'interval' });
  const mission = result.missions[0];
  const doc = parseXml(buildMissionFiles(mission, result.plan).waylinesWpml);
  const groups = all(doc, 'wpml:actionGroup').filter(
    (g) => textOf(g, 'wpml:actionTriggerType') === 'multipleDistance',
  );
  assert.equal(groups.length, mission.legs.length);
  const g = groups[0];
  assert.equal(textOf(g, 'wpml:actionTriggerParam'), '20.0');
  assert.equal(textOf(g, 'wpml:actionGroupStartIndex'), '0');
  assert.equal(
    textOf(g, 'wpml:actionGroupEndIndex'),
    String(mission.legs[0].waypoints.length - 1),
  );
  assert.equal(textOf(g, 'wpml:actionActuatorFunc'), 'takePhoto');
  // The first tilt shares waypoint 0 with the interval group (own group, id 1,
  // ahead of it); later legs get the gradual tilt on the waypoint before.
  const marks = all(doc, 'Placemark');
  const first = all(marks[0], 'wpml:actionGroup');
  assert.equal(first.length, 2);
  assert.equal(textOf(first[0], 'wpml:actionActuatorFunc'), 'gimbalRotate');
  assert.equal(textOf(first[0], 'wpml:actionGroupId'), '1');
  assert.equal(textOf(first[1], 'wpml:actionTriggerType'), 'multipleDistance');
  const evenly = marks.flatMap((m, i) =>
    all(m, 'wpml:actionGroup')
      .filter((x) => textOf(x, 'wpml:actionActuatorFunc') === 'gimbalEvenlyRotate')
      .map((x) => [i, textOf(x, 'wpml:actionGroupStartIndex'), textOf(x, 'wpml:actionGroupEndIndex')]),
  );
  assert.deepEqual(
    evenly,
    mission.legs.slice(1).map((l) => [
      l.waypoints[0].index - 1,
      String(l.waypoints[0].index - 1),
      String(l.waypoints[0].index),
    ]),
  );
});

test('double grid writes the tilted gimbal pitch', () => {
  const result = build({ pattern: 'double', tiltPitchDeg: -60 });
  const doc = parseXml(
    buildMissionFiles(result.missions[0], result.plan).waylinesWpml,
  );
  assert.ok(
    all(doc, 'wpml:waypointGimbalPitchAngle').every(
      (n) => n.text.trim() === '-60',
    ),
  );
  assert.equal(all(doc, 'wpml:gimbalPitchRotateAngle')[0].text.trim(), '-60');
});

test('orbit waypoints turn the aircraft to face the centre', () => {
  const result = build({
    pattern: 'orbit',
    orbitRadiusM: 50,
    orbitHeightsM: [30],
  });
  const doc = parseXml(
    buildMissionFiles(result.missions[0], result.plan).waylinesWpml,
  );
  const modes = all(doc, 'wpml:waypointHeadingMode').map((n) => n.text.trim());
  assert.ok(modes.every((m) => m === 'smoothTransition'));
  const angles = all(doc, 'wpml:waypointHeadingAngle').map((n) =>
    Number(n.text),
  );
  assert.ok(angles.every((a) => a > -180 && a <= 180));
});

test('every mission stays within 200 waypoints and indexes are continuous', () => {
  const plan = planFlight(
    (() => {
      const m = metersPerDegree(30.27);
      return {
        west: -97.77 - 600 / m.lon,
        east: -97.77 + 600 / m.lon,
        south: 30.27 - 400 / m.lat,
        north: 30.27 + 400 / m.lat,
      };
    })(),
    { aglM: 80, batteryMin: 60 },
  );
  const ids = plan.legs.flatMap((l) => l.waypoints.map((w) => w.id));
  const result = assembleMissions(plan, {
    known: true,
    takeoffM: 0,
    wpM: ids.map(() => 0),
  });
  assert.ok(result.missions.length > 1);
  for (const mission of result.missions) {
    const doc = parseXml(buildMissionFiles(mission, result.plan).waylinesWpml);
    const marks = all(doc, 'Placemark');
    assert.ok(marks.length <= 200);
    marks.forEach((mark, i) =>
      assert.equal(textOf(mark, 'wpml:index'), String(i)),
    );
  }
});

test('names are XML-escaped', () => {
  assert.equal(esc('a<b>&"c'), 'a&lt;b&gt;&amp;&quot;c');
  const result = build();
  const { templateKml } = buildMissionFiles(result.missions[0], result.plan, {
    name: 'Ranch <north> & "gate"',
  });
  const doc = parseXml(templateKml);
  assert.equal(
    textOf(doc, 'wpml:author'),
    'Ranch &lt;north&gt; &amp; &quot;gate&quot;',
  );
});

test('the bundle ZIP holds one KMZ per mission plus a README', () => {
  const result = build({ maxWaypoints: 50 });
  const when = new Date(2026, 9, 28, 15, 30);
  const zip = readZip(buildBundleZip(result, { when }));
  const names = [...zip.keys()];
  assert.equal(names.length, result.missions.length + 1);
  assert.equal(names.at(-1), 'README.txt');
  result.missions.forEach((mission, i) => {
    const name = kmzFileName(i, result.missions.length, when);
    assert.equal(
      name,
      `gev-drone-plan-20261028-1530-m${i + 1}of${result.missions.length}.kmz`,
    );
    assert.ok(zip.has(name));
    const inner = readZip(zip.get(name));
    assert.deepEqual(
      [...inner.keys()],
      ['wpmz/template.kml', 'wpmz/waylines.wpml'],
    );
    const marks = all(
      parseXml(decode(inner.get('wpmz/waylines.wpml'))),
      'Placemark',
    );
    assert.equal(marks.length, mission.waypointCount);
  });
  const readme = decode(zip.get('README.txt'));
  assert.match(readme, /NOT FLIGHT-TESTED/);
  assert.match(readme, new RegExp(`Missions: ${result.missions.length}`));
  assert.equal(readmeText(result, when), readme);
});

test('zip: round trip, CRC and CRC-32 known value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const zip = makeZip([
    { name: 'a.txt', data: 'hello' },
    { name: 'dir/b.bin', data: new Uint8Array([0, 1, 2, 255]) },
  ]);
  const files = readZip(zip);
  assert.equal(decode(files.get('a.txt')), 'hello');
  assert.deepEqual([...files.get('dir/b.bin')], [0, 1, 2, 255]);
  const bad = zip.slice();
  const at = bad.indexOf(104); // the 'h' of "hello"
  bad[at] = 72;
  assert.throws(() => readZip(bad), /Bad CRC/);
  assert.throws(() => readZip(new Uint8Array(10)), /Not a ZIP/);
});

test('zip: an independent unzip tool accepts the KMZ', (t) => {
  const result = build();
  const kmz = buildKmz(result.missions[0], result.plan);
  const dir = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'kmz-'));
  const file = path.join(dir, 'mission.kmz');
  writeFileSync(file, kmz);
  const probe = spawnSync('unzip', ['-v'], { encoding: 'utf8' });
  if (probe.error) {
    const py = spawnSync(
      'python3',
      [
        '-c',
        'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(",".join(z.namelist()))',
        file,
      ],
      { encoding: 'utf8' },
    );
    if (py.error) return t.skip('no unzip or python3 available');
    assert.equal(py.status, 0, py.stderr);
    assert.equal(py.stdout.trim(), 'wpmz/template.kml,wpmz/waylines.wpml');
    return;
  }
  const test = spawnSync('unzip', ['-tq', file], { encoding: 'utf8' });
  assert.equal(test.status, 0, test.stdout + test.stderr);
});

test('distance capture writes one unverified multipleDistance group per line', () => {
  const result = build({
    captureMode: 'distance',
    photoSpacingM: 25,
    batteryMin: 60,
  });
  const mission = result.missions[0];
  assert.ok(mission.legs.every((leg) => leg.waypoints.length === 2));
  const xml = buildMissionFiles(mission, result.plan).waylinesWpml;
  const doc = parseXml(xml);
  const groups = all(doc, 'wpml:actionGroup').filter(
    (group) => textOf(group, 'wpml:actionTriggerType') === 'multipleDistance',
  );
  assert.equal(groups.length, mission.legs.length);
  assert.equal(textOf(groups[0], 'wpml:actionTriggerParam'), '25.0');
  assert.equal(textOf(groups[0], 'wpml:actionGroupStartIndex'), '0');
  assert.equal(textOf(groups[0], 'wpml:actionGroupEndIndex'), '1');
  assert.equal(textOf(groups[0], 'wpml:actionActuatorFunc'), 'takePhoto');
  assert.equal(
    all(doc, 'wpml:actionActuatorFunc').filter((node) => node.text.trim() === 'takePhoto')
      .length,
    mission.legs.length,
  );
  assert.equal(xml.includes('multipleTiming'), false);
  const first = all(all(doc, 'Placemark')[0], 'wpml:actionGroup');
  assert.equal(textOf(first[0], 'wpml:actionActuatorFunc'), 'gimbalRotate');
  assert.equal(textOf(first[1], 'wpml:actionTriggerType'), 'multipleDistance');
  assert.match(readmeText(result), /NOT verified by a real file/);
  assert.match(readmeText(result), /multipleTiming is not written/);
});

test('timed capture keeps the gimbal and writes no photo action', () => {
  const result = build({ captureMode: 'timed', photoSpacingM: 25, batteryMin: 60 });
  const mission = result.missions[0];
  const xml = buildMissionFiles(mission, result.plan).waylinesWpml;
  const doc = parseXml(xml);
  assert.equal(xml.includes('takePhoto'), false);
  assert.equal(xml.includes('multipleTiming'), false);
  assert.equal(xml.includes('multipleDistance'), false);
  const marks = all(doc, 'Placemark');
  assert.ok(marks.length >= 2);
  assert.deepEqual(
    all(marks[0], 'wpml:actionActuatorFunc').map((node) => node.text.trim()),
    ['gimbalRotate'],
  );
  const pitches = all(doc, 'wpml:gimbalPitchRotateAngle').map((node) => node.text.trim());
  assert.ok(pitches.includes('-90'));
  assert.ok(
    marks.some((mark) =>
      all(mark, 'wpml:actionActuatorFunc').some(
        (node) => node.text.trim() === 'gimbalEvenlyRotate',
      ),
    ),
  );
});

test('stop captureMode leaves legacy interval WPML groups alone', () => {
  const result = build({ photoMode: 'interval', captureMode: 'stop' });
  const mission = result.missions[0];
  const doc = parseXml(buildMissionFiles(mission, result.plan).waylinesWpml);
  const groups = all(doc, 'wpml:actionGroup').filter(
    (group) => textOf(group, 'wpml:actionTriggerType') === 'multipleDistance',
  );
  assert.equal(groups.length, mission.legs.length);
  assert.equal(textOf(groups[0], 'wpml:actionTriggerParam'), '20.0');
  assert.ok(mission.legs[0].waypoints.length > 2);
  const marks = all(doc, 'Placemark');
  assert.ok(marks.every((mark) => textOf(mark, 'wpml:useStraightLine') === '0'));
});

test('distance lines fly straight and action bounds support the action', () => {
  const result = build({
    captureMode: 'distance',
    continuousRoute: true,
    photoSpacingM: 25,
    batteryMin: 60,
  });
  const mission = result.missions[0];
  assert.ok(mission.legs.length >= 2, 'needs a corner between lines');
  const xml = buildMissionFiles(mission, result.plan).waylinesWpml;
  const doc = parseXml(xml);
  const marks = all(doc, 'Placemark');
  assert.ok(marks.every((mark) => textOf(mark, 'wpml:useStraightLine') === '1'));
  marks.forEach((mark, i) => {
    const turn = textOf(mark, 'wpml:waypointTurnMode');
    const damping = Number(textOf(mark, 'wpml:waypointTurnDampingDist'));
    if (i === 0 || i === marks.length - 1) {
      assert.equal(turn, 'toPointAndStopWithContinuityCurvature');
      assert.equal(damping, 0);
    } else {
      assert.equal(turn, 'toPointAndPassWithContinuityCurvature');
      assert.ok(damping > 0, 'pass-through straight needs a positive damping');
    }
  });
  for (let i = 0; i < marks.length - 1; i += 1) {
    const seg = Number(textOf(marks[i], 'wpml:waypointTurnDampingDist'))
      + Number(textOf(marks[i + 1], 'wpml:waypointTurnDampingDist'));
    const a = mission.waypoints[i];
    const b = mission.waypoints[i + 1];
    const dx = (b.lon - a.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180);
    const dy = (b.lat - a.lat) * 110540;
    assert.ok(Math.hypot(dx, dy) > seg, 'segment longer than the two turn intercepts');
  }
  const groups = all(doc, 'wpml:actionGroup').filter(
    (group) => textOf(group, 'wpml:actionTriggerType') === 'multipleDistance',
  );
  const supports = (index) => {
    const mark = marks[index];
    const turn = textOf(mark, 'wpml:waypointTurnMode');
    return (
      turn.startsWith('toPointAndStop') ||
      textOf(mark, 'wpml:useStraightLine') === '1'
    );
  };
  for (const group of groups) {
    const start = Number(textOf(group, 'wpml:actionGroupStartIndex'));
    const end = Number(textOf(group, 'wpml:actionGroupEndIndex'));
    assert.ok(start < end);
    assert.equal(supports(start), true);
    assert.equal(supports(end), true);
  }
  const legacy = build();
  const legacyMarks = all(
    parseXml(buildMissionFiles(legacy.missions[0], legacy.plan).waylinesWpml),
    'Placemark',
  );
  assert.ok(legacyMarks.every((mark) => textOf(mark, 'wpml:useStraightLine') === '0'));
});

test('foot spacing round-trips through parseDjiKmz and deriveImportShots', async () => {
  const { parseDjiKmz } = await import('./djiKmz.js');
  const { deriveImportShots } = await import('./importShots.js');
  const { writtenSpacingM, linePhotoCount } = await import('./planner.js');
  for (const feet of [8.5, 25, 50, 100]) {
    const spacing = feet * 0.3048;
    const written = writtenSpacingM(spacing);
    const result = build({
      captureMode: 'distance',
      continuousRoute: true,
      photoSpacingM: spacing,
      batteryMin: 60,
    });
    const mission = result.missions[0];
    assert.ok(mission.legs.every((leg) => leg.photoSpacingM === written));
    assert.equal(
      mission.photoCount,
      mission.legs.reduce(
        (sum, leg) => sum + linePhotoCount(leg.lengthM, written, leg.continued === true),
        0,
      ),
    );
    const xml = buildMissionFiles(mission, result.plan).waylinesWpml;
    const doc = parseXml(xml);
    const groups = all(doc, 'wpml:actionGroup').filter(
      (group) => textOf(group, 'wpml:actionTriggerType') === 'multipleDistance',
    );
    assert.equal(textOf(groups[0], 'wpml:actionTriggerParam'), written.toFixed(1));
    const parsed = await parseDjiKmz(buildKmz(mission, result.plan), {
      fileName: 'feet.kmz',
    });
    const param = parsed.waypoints
      .flatMap((wp) => wp.groups ?? [])
      .find((group) => group.trigger === 'multipleDistance')?.triggerParam;
    assert.equal(param, written);
    const shots = deriveImportShots(parsed);
    assert.equal(shots.stations.length, mission.photoCount, `${feet} ft`);
  }
});

test('the README does not claim one battery per file and states the safety limits', () => {
  const result = build({ captureMode: 'distance', photoSpacingM: 25 });
  const readme = readmeText(result);
  assert.doesNotMatch(readme, /one battery each/i);
  assert.match(readme, /One file is one flight, not one battery/);
  assert.match(readme, /not verified that DJI Fly resumes/);
  assert.match(readme, /not\s+slowed to the camera or blur limit/);
  assert.match(readme, /not verified in DJI Fly/);
  assert.match(readme, /do not approve a flight/);
  assert.match(readme, /VISUAL aid only/);
  assert.match(readme, /multipleTiming is not written/);
});

test('each file README lists settings, and continuous distance lists battery breaks', () => {
  const stop = build();
  const stopReadme = readmeText(stop);
  assert.match(stopReadme, /Requested mode: A stop/);
  assert.match(stopReadme, /Waypoint cap: 200/);
  assert.match(stopReadme, /Height: 100\.0 m/);
  assert.match(stopReadme, /Speed: /);
  assert.match(stopReadme, /Spacing: /);
  assert.match(stopReadme, /Interval: /);
  assert.match(stopReadme, /Camera minimum: /);
  assert.match(stopReadme, /Shutter required: 1\//);
  assert.match(stopReadme, /Shutter chosen: 1\//);
  assert.match(stopReadme, /Overlap: /);
  assert.match(stopReadme, /Photo count: /);
  assert.match(stopReadme, /Check the first resume/);
  assert.match(stopReadme, /Camera settings \(set in DJI Fly/);
  assert.match(stopReadme, /Pause markers are not estimated/);
  assert.doesNotMatch(stopReadme, /UNREACHABLE/);
  assert.equal(stop.options?.usableBatteryMin ?? stop.plan.options.usableBatteryMin, 20);

  const distance = build({
    captureMode: 'distance',
    continuousRoute: true,
    photoSpacingM: 25,
    batteryMin: 60,
    usableBatteryMin: 20,
    presetId: 'dji-mini-5-pro',
  });
  assert.equal(distance.plan.options.usableBatteryMin, 20);
  const readme = readmeText(distance);
  assert.match(readme, /Requested mode: B distance/);
  assert.match(readme, /NOT proven on the Mini 5 Pro/);
  assert.match(readme, /Waypoint cap: /);
  assert.match(readme, /Height: /);
  assert.match(readme, /Speed: /);
  assert.match(readme, /Spacing: 25\.0 m/);
  assert.match(readme, /Interval: /);
  assert.match(readme, /Camera minimum: 5\.0 s/);
  assert.match(readme, /Shutter required: 1\//);
  assert.match(readme, /Shutter chosen: 1\//);
  assert.match(readme, /Overlap: /);
  assert.match(readme, /Photo count: /);
  assert.match(readme, /not proven to continue after a resume/);
  assert.match(readme, /Check the first resume/);
  assert.match(readme, /Check it for trees/);
  assert.match(readme, /Camera settings \(set in DJI Fly/);
  assert.match(readme, /Usable battery: 20 min/);
  assert.match(readme, /Estimated battery breaks/);
  assert.match(readme, /not waypoints/);
  assert.match(readme, /-?\d+\.\d{6}, -?\d+\.\d{6}|fits in 20 usable minutes/);
});

test('timed README does not count camera photos and names the hand start', () => {
  const result = build({
    captureMode: 'timed',
    continuousRoute: true,
    photoSpacingM: 25,
    batteryMin: 60,
    presetId: 'dji-mini-5-pro',
  });
  const readme = readmeText(result);
  assert.match(readme, /Requested mode: C timed shot/);
  assert.match(readme, /You start the timed shot by hand/);
  assert.match(readme, /not a count of photos the camera will take/);
  assert.match(readme, /Timed shot may stop/);
  assert.match(readme, /Camera settings \(set in DJI Fly/);
  assert.match(readme, /multipleTiming is not written/);
  assert.doesNotMatch(readme, /Photos: \d+/);
  assert.doesNotMatch(readme, /\d+ photos,/);
  assert.equal(result.plan.options.usableBatteryMin, 20);
});

test('a long continuous file lists break lat/lon and an unreachable warning', () => {
  const m = metersPerDegree(30.27);
  const wide = {
    west: -97.77 - 2000 / m.lon,
    east: -97.77 + 2000 / m.lon,
    south: 30.27 - 40 / m.lat,
    north: 30.27 + 40 / m.lat,
  };
  const planBreaks = planFlight(wide, {
    aglM: 80,
    direction: 'ew',
    captureMode: 'distance',
    continuousRoute: true,
    photoSpacingM: 25,
    batteryMin: 60,
    usableBatteryMin: 20,
    speedMs: 5,
    presetId: 'dji-mini-5-pro',
  });
  const ids = planBreaks.legs.flatMap((leg) => leg.waypoints.map((wp) => wp.id));
  const ground = { known: true, takeoffM: 100, wpM: ids.map(() => 100) };
  const broken = readmeText(assembleMissions(planBreaks, ground));
  assert.match(broken, /Requested mode: B distance/);
  assert.match(broken, /NOT proven/);
  assert.match(
    broken,
    /Estimated battery breaks \(not waypoints; this file is not split at these points\):/,
  );
  assert.match(
    broken,
    /1\. -?\d+\.\d{6}, -?\d+\.\d{6}  distance \d+ m from the file start, photo count \d+ from the file start, about \d+\.\d min/,
  );
  assert.match(broken, /not waypoints and the route is not split/);
  assert.equal(planBreaks.options.usableBatteryMin, 20);

  const planStuck = planFlight(wide, {
    aglM: 80,
    direction: 'ew',
    captureMode: 'timed',
    continuousRoute: true,
    photoSpacingM: 25,
    batteryMin: 60,
    usableBatteryMin: 5,
    speedMs: 15,
    presetId: 'dji-mini-5-pro',
  });
  const stuckIds = planStuck.legs.flatMap((leg) => leg.waypoints.map((wp) => wp.id));
  const stuck = readmeText(
    assembleMissions(planStuck, {
      known: true,
      takeoffM: 100,
      wpM: stuckIds.map(() => 100),
    }),
  );
  assert.match(stuck, /Requested mode: C timed shot/);
  assert.match(stuck, /You start the timed shot by hand/);
  assert.match(stuck, /not a count of photos the camera will take/);
  assert.doesNotMatch(stuck, /Photos: \d+/);
  assert.match(
    stuck,
    /UNREACHABLE: from -?\d+\.\d{6}, -?\d+\.\d{6} the rest of this file cannot be paused inside 5 usable minutes \(reason: round-trip-exceeds-usable-minutes\)\. Remaining distance about \d+ m/,
  );
});

test('reading a mission back refuses interval photos (one leg or several)', async () => {
  const { missionFromWaylines } = await import('./wpmlCompare.mjs');
  const result = build({ photoMode: 'interval' });
  const xml = buildMissionFiles(result.missions[0], result.plan).waylinesWpml;
  assert.throws(() => missionFromWaylines(xml), /interval-photo/);
  // One leg: the interval group sits behind the tilt group on waypoint 0.
  const one = { ...result.missions[0], legs: result.missions[0].legs.slice(0, 1) };
  const oneXml = buildMissionFiles(one, result.plan).waylinesWpml;
  assert.throws(() => missionFromWaylines(oneXml), /interval-photo/);
});

test('README shutter safety uses the blur minimum rounded up, not the chosen shutter', () => {
  const feet = 500 * 0.3048;
  const result = build({
    aglM: feet,
    speedMs: 7.8,
    shutterDenominator: 500,
    captureMode: 'distance',
    continuousRoute: true,
    photoSpacingM: 30,
    batteryMin: 60,
    presetId: 'dji-mini-5-pro',
  });
  const preset = getPreset('dji-mini-5-pro');
  const raw = minShutterDenominator(preset, result.plan.gsdCm, result.plan.speedMs);
  const standard = SHUTTER_DENOMINATORS.find((d) => d >= raw);
  assert.ok(raw > 500 && raw <= 1000, `raw ${raw}`);
  assert.equal(standard, 1000, '500 ft at 7.8 m/s rounds up to 1/1000, not 1/500');
  const readme = readmeText(result);
  assert.match(readme, /Shutter required: 1\/1000 s or faster/);
  assert.match(readme, /Shutter chosen: 1\/500 s/);
  assert.match(readme, /chosen shutter is not the required minimum/);
  assert.doesNotMatch(readme, /Shutter required: 1\/500/);
  assert.doesNotMatch(readme, /1\/500 s or faster/);
});

test('README warns when the required shutter is faster than the available table', () => {
  const result = build({
    aglM: 15,
    speedMs: 15,
    shutterDenominator: 4000,
    captureMode: 'distance',
    continuousRoute: true,
    photoSpacingM: 40,
    batteryMin: 60,
    presetId: 'dji-mini-5-pro',
  });
  const raw = minShutterDenominator(
    getPreset('dji-mini-5-pro'),
    result.plan.gsdCm,
    result.plan.speedMs,
  );
  assert.ok(raw > 4000, `raw ${raw}`);
  const readme = readmeText(result);
  assert.match(readme, /Shutter required: faster than 1\/4000 s/);
  assert.match(readme, /Not safe in available table/);
  assert.match(readme, /Shutter chosen: 1\/4000 s/);
  assert.doesNotMatch(readme, /Shutter required: 1\/4000 s or faster/);
  assert.doesNotMatch(readme, /1\/4000 s or faster/);
});

test('a forged intervalTriggerProven true does not drop the Mini 5 Pro unproven notice', () => {
  const plain = build({ captureMode: 'distance', photoSpacingM: 25 });
  assert.equal(plain.plan.options.intervalTriggerProven, false);
  const result = build({
    captureMode: 'distance',
    photoSpacingM: 25,
    intervalTriggerProven: true,
  });
  assert.equal(result.plan.options.intervalTriggerProven, false);
  const when = new Date('2026-11-06T18:00:00Z');
  const readme = readmeText(result, when);
  assert.match(readme, /Requested mode: B distance\./);
  assert.match(readme, /NOT proven on the Mini 5 Pro/);
  assert.match(readme, /unproven distance trigger/);
  assert.match(readme, /NOT proven\./);
  assert.doesNotMatch(readme, /real-world proven/i);
  assert.doesNotMatch(readme, /trigger is proven/i);
  assert.match(readme, /not proven to continue after a resume/);
  assert.match(readme, /estimated photos if the unproven distance trigger fires/);
  const bundled = new TextDecoder().decode(
    readZip(buildBundleZip(result, { when })).get('README.txt'),
  );
  assert.match(bundled, /NOT proven on the Mini 5 Pro/);
  assert.match(bundled, /unproven distance trigger/);
  assert.match(bundled, /not proven to continue after a resume/);
  assert.doesNotMatch(bundled, /real-world proven/i);
});

test('README camera minimum uses the plan override and keeps 5 s when unset', () => {
  const custom = build({
    minPhotoIntervalS: 8,
    captureMode: 'distance',
    photoSpacingM: 20,
    speedMs: 5,
    presetId: 'dji-mini-5-pro',
  });
  const readme = readmeText(custom);
  assert.equal(custom.plan.preset.minPhotoIntervalS, 8);
  assert.equal(custom.plan.speedLimits.intervalMs, 2.5);
  assert.match(readme, /Camera minimum: 8\.0 s/);
  assert.match(readme, /under the 8\.0 s camera minimum/);

  const legacy = build({ captureMode: 'stop', presetId: 'dji-mini-5-pro' });
  assert.equal(legacy.plan.preset.minPhotoIntervalS, 5);
  assert.match(readmeText(legacy), /Camera minimum: 5\.0 s/);
  assert.doesNotMatch(readmeText(legacy), /Camera minimum: 8/);
});

test('mode A (stop at every photo) writes the same WPML as before the capture modes existed', async () => {
  const { createHash } = await import('node:crypto');
  const m = metersPerDegree(30.27);
  const area = {
    west: -97.77 - 400 / m.lon,
    east: -97.77 + 400 / m.lon,
    south: 30.27 - 300 / m.lat,
    north: 30.27 + 300 / m.lat,
  };
  const out = [];
  for (const o of [
    { aglM: 100 },
    { aglM: 305, speedMs: 7.8 },
    { aglM: 100, photoMode: 'interval' },
  ]) {
    const plan = planFlight(area, { batteryMin: 20, ...o });
    const ids = plan.legs.flatMap((l) => l.waypoints.map((w) => w.id));
    const r = assembleMissions(plan, {
      known: true,
      takeoffM: 100,
      wpM: ids.map((id) => 100 + (id % 5)),
    });
    for (const mi of r.missions) {
      // The pinned hash is the older form, without a gimbalRotate on every
      // waypoint; the new form is covered by wpmlWaypointState.test.mjs.
      const f = buildMissionFiles(mi, r.plan, {
        createdMs: 1793176000000,
        explicitWaypointGimbal: false,
      });
      out.push(f.waylinesWpml, f.templateKml);
    }
  }
  // Hash of the output of the code before this feature (main 90a3cd52).
  assert.equal(
    createHash('sha256').update(out.join('\n')).digest('hex'),
    '7c7266acc4ca5bddf00321c0226b5806df1ee9f067f742247eacedec998e4d7f',
  );
  assert.equal(out.length, 18);
});

test('README worked numbers: 305 m height, 7.8 m/s, 60 m gives 7.7 s; 89 m gives 11.4 s', () => {
  for (const [spacing, seconds] of [
    [60, '7.7'],
    [89, '11.4'],
  ]) {
    const result = build({
      aglM: 305,
      speedMs: 7.8,
      captureMode: 'distance',
      photoSpacingM: spacing,
      batteryMin: 60,
    });
    assert.match(
      readmeText(result),
      new RegExp(`Interval: ${seconds} s between pictures`),
    );
  }
});

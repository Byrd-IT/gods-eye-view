import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, makeZip, readZip } from './zip.js';
import { assembleMissions, planFlight } from './planner.js';
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
    assert.equal(
      textOf(mark, 'wpml:waypointTurnMode'),
      'toPointAndPassWithContinuityCurvature',
    );
    assert.equal(textOf(mark, 'wpml:waypointGimbalPitchAngle'), '-90');
  });
  assert.equal(
    Number(textOf(doc, 'wpml:distance')),
    Math.round(mission.routeM),
  );
  assert.equal(
    Number(textOf(doc, 'wpml:duration')),
    Math.round(mission.durationS),
  );
});

test('photo at every waypoint: takePhoto per waypoint, gimbal rotate per leg', () => {
  const result = build();
  const mission = result.missions[0];
  const { waylinesWpml } = buildMissionFiles(mission, result.plan);
  const doc = parseXml(waylinesWpml);
  const funcs = all(doc, 'wpml:actionActuatorFunc').map((n) => n.text.trim());
  assert.equal(
    funcs.filter((f) => f === 'takePhoto').length,
    mission.photoCount,
  );
  assert.equal(
    funcs.filter((f) => f === 'gimbalRotate').length,
    mission.legs.length,
  );
  const pitch = all(doc, 'wpml:gimbalPitchRotateAngle')[0];
  assert.equal(pitch.text.trim(), '-90');
  const groups = all(doc, 'wpml:actionGroup');
  const ids = groups.map((g) => Number(textOf(g, 'wpml:actionGroupId')));
  assert.deepEqual(
    ids,
    ids.map((_, i) => i + 1),
    'group ids are 1..n',
  );
  const actionIds = all(doc, 'wpml:actionId').map((n) => Number(n.text));
  assert.deepEqual(
    actionIds,
    actionIds.map((_, i) => i + 1),
    'action ids are unique across the mission: 1..n',
  );
  for (const g of groups) {
    assert.equal(textOf(g, 'wpml:actionTriggerType'), 'reachPoint');
    assert.equal(textOf(g, 'wpml:actionGroupMode'), 'parallel');
    assert.equal(
      textOf(g, 'wpml:actionGroupStartIndex'),
      textOf(g, 'wpml:actionGroupEndIndex'),
    );
  }
  // Parallel groups: the gimbal turn is its own group, BEFORE the photo group,
  // so a photo never fires while the gimbal is still turning.
  const perGroup = groups.map((g) =>
    all(g, 'wpml:actionActuatorFunc').map((n) => n.text.trim()),
  );
  assert.ok(perGroup.every((f) => f.length === 1), 'one action per group');
  assert.deepEqual(perGroup.slice(0, 2), [['gimbalRotate'], ['takePhoto']]);
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

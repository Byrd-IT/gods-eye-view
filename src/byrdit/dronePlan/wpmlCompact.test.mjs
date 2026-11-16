import assert from 'node:assert/strict';
import test from 'node:test';
import { readZipAsync, readZip } from './zip.js';
import { assembleMissions, planFlight } from './planner.js';
import { metersPerDegree } from './geo.js';
import {
  COMPACT_OMISSIONS,
  buildBundleZip,
  buildBundleZipCompact,
  buildKmz,
  buildKmzDeflated,
  buildMissionFiles,
  bundleEntriesCompact,
  compactNoticeLines,
  compactXml,
  readmeText,
} from './wpml.js';
import { parseDjiKmz } from './djiKmz.js';
import { openDroneFile } from './importFile.js';
import { deriveImportShots } from './importShots.js';
import { buildSuiteZipCompact, buildSuiteZip } from './suite.js';

const decode = (bytes) => new TextDecoder().decode(bytes);
const CREATED = 1793176000000;
const WHEN = new Date(2026, 10, 16, 12, 30, 10);

function boxOf(width, height) {
  const m = metersPerDegree(30.27);
  return {
    west: -97.77 - width / 2 / m.lon,
    east: -97.77 + width / 2 / m.lon,
    south: 30.27 - height / 2 / m.lat,
    north: 30.27 + height / 2 / m.lat,
  };
}
function build(options = {}, size = [400, 200]) {
  const plan = planFlight(boxOf(...size), {
    aglM: 100,
    batteryMin: 60,
    ...options,
  });
  assert.equal(plan.error, undefined);
  const ids = plan.legs.flatMap((l) => l.waypoints.map((w) => w.id));
  return assembleMissions(plan, {
    known: true,
    takeoffM: 100,
    wpM: ids.map((id) => 100 + (id % 5)),
  });
}

/** A small tree of the XML: element name, trimmed text, children. */
function tree(xml) {
  const root = { name: '#root', text: '', children: [] };
  const stack = [root];
  const re = /<\?[^?]*\?>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const [full, close, name, attrs, selfClose, chars] = m;
    if (chars !== undefined) stack.at(-1).text += chars;
    else if (name && !close) {
      const node = { name, attrs: attrs.trim(), text: '', children: [] };
      stack.at(-1).children.push(node);
      if (!selfClose) stack.push(node);
    } else if (name && close) {
      assert.equal(stack.pop().name, name, 'mismatched close tag');
    } else assert.ok(full.startsWith('<?'), `unparsed ${full}`);
  }
  assert.equal(stack.length, 1, 'unclosed element');
  const clean = (n) => ({
    name: n.name,
    attrs: n.attrs,
    text: n.children.length ? '' : n.text.trim(),
    children: n.children.map(clean),
  });
  return clean(root.children[0]);
}
const walk = (node, fn) => {
  fn(node);
  node.children.forEach((c) => walk(c, fn));
};
const all = (node, name) => {
  const out = [];
  walk(node, (n) => n.name === name && out.push(n));
  return out;
};
const textOf = (node, name) => all(node, name)[0]?.text;

/** The standard tree with exactly the documented omissions removed. */
function withoutOmitted(node) {
  const copy = structuredClone(node);
  walk(copy, (n) => {
    if (n.name !== 'Placemark') return;
    const straight = textOf(n, 'wpml:useStraightLine');
    n.children = n.children.map((c) => {
      if (c.name === 'wpml:waypointHeadingParam') {
        c.children = c.children.filter(
          (x) =>
            !(
              x.name === 'wpml:waypointPoiPoint' &&
              x.text === '0.000000,0.000000,0.000000'
            ),
        );
      }
      if (c.name === 'wpml:waypointTurnParam' && straight === '0') {
        c.children = c.children.filter(
          (x) => !(x.name === 'wpml:waypointTurnDampingDist' && x.text === '0'),
        );
      }
      return c;
    });
  });
  return copy;
}

const PLANS = {
  grid: () => build(),
  timed: () => build({ captureMode: 'timed', photoSpacingM: 25 }),
  distance: () =>
    build({ captureMode: 'distance', photoSpacingM: 25, continuousRoute: true }),
  orbit: () =>
    build({ pattern: 'orbit', orbitRadiusM: 50, orbitHeightsM: [30, 60] }),
};

test('compact is opt-in: without it the files are byte for byte the normal ones', () => {
  for (const [name, make] of Object.entries(PLANS)) {
    const r = make();
    const plain = buildMissionFiles(r.missions[0], r.plan, {
      createdMs: CREATED,
    });
    for (const compact of [false, undefined, 'yes', 1]) {
      const other = buildMissionFiles(r.missions[0], r.plan, {
        createdMs: CREATED,
        compact,
      });
      assert.deepEqual(other, plain, `${name} compact=${String(compact)}`);
    }
    assert.match(plain.waylinesWpml, /\n {6}<Placemark>\n/);
    assert.deepEqual(
      buildKmz(r.missions[0], r.plan, { when: WHEN, createdMs: CREATED }),
      buildKmz(r.missions[0], r.plan, {
        when: WHEN,
        createdMs: CREATED,
        compact: false,
      }),
    );
  }
});

test('compact XML has no whitespace between tags, keeps the declaration and the namespaces', () => {
  const r = build();
  const files = buildMissionFiles(r.missions[0], r.plan, {
    createdMs: CREATED,
    compact: true,
  });
  for (const xml of [files.templateKml, files.waylinesWpml]) {
    assert.ok(
      xml.startsWith(
        '<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.uav.com/wpmz/1.0.2">',
      ),
    );
    assert.ok(xml.endsWith('</kml>'));
    assert.equal(/\n/.test(xml), false, 'no newline');
    assert.equal(/>\s+</.test(xml), false, 'no whitespace between tags');
    assert.equal(/>\s|\s</.test(xml), false, 'no padding around a value');
    const doc = tree(xml);
    assert.equal(doc.name, 'kml');
    assert.match(doc.attrs, /xmlns:wpml="http:\/\/www.uav.com\/wpmz\/1.0.2"/);
  }
  assert.equal(
    textOf(tree(files.waylinesWpml), 'coordinates').includes(','),
    true,
  );
});

test('compact differs from the normal file ONLY by the documented omissions', () => {
  for (const [name, make] of Object.entries(PLANS)) {
    const r = make();
    for (const mission of r.missions) {
      const std = buildMissionFiles(mission, r.plan, { createdMs: CREATED });
      const cmp = buildMissionFiles(mission, r.plan, {
        createdMs: CREATED,
        compact: true,
      });
      assert.deepEqual(
        tree(cmp.waylinesWpml),
        withoutOmitted(tree(std.waylinesWpml)),
        `${name} waylines`,
      );
      assert.deepEqual(tree(cmp.templateKml), tree(std.templateKml), name);
      assert.ok(cmp.waylinesWpml.length < std.waylinesWpml.length * 0.8, name);
    }
  }
});

test('omitted elements are absent, every other per-waypoint element is present', () => {
  const r = PLANS.grid();
  const mission = r.missions[0];
  const std = tree(buildMissionFiles(mission, r.plan).waylinesWpml);
  const cmp = tree(
    buildMissionFiles(mission, r.plan, { compact: true }).waylinesWpml,
  );
  const n = mission.waypointCount;
  assert.equal(all(std, 'wpml:waypointPoiPoint').length, n);
  assert.equal(all(cmp, 'wpml:waypointPoiPoint').length, 0);
  assert.equal(all(cmp, 'wpml:waypointTurnDampingDist').length, 0);
  assert.ok(all(std, 'wpml:waypointTurnDampingDist').length >= n);
  for (const name of [
    'wpml:index',
    'wpml:executeHeight',
    'wpml:waypointSpeed',
    'wpml:waypointHeadingMode',
    'wpml:waypointHeadingAngle',
    'wpml:waypointHeadingAngleEnable',
    'wpml:waypointHeadingPathMode',
    'wpml:waypointHeadingPoiIndex',
    'wpml:waypointTurnMode',
    'wpml:useStraightLine',
    'wpml:waypointGimbalPitchAngle',
    'wpml:waypointGimbalYawAngle',
    'wpml:distance',
    'wpml:duration',
    'wpml:autoFlightSpeed',
  ]) {
    assert.equal(all(cmp, name).length, all(std, name).length, name);
    assert.ok(all(cmp, name).length >= 1, name);
  }
  // Self-contained waypoints: every one states its own speed and gimbal pitch.
  const marks = all(cmp, 'Placemark');
  assert.equal(marks.length, n);
  marks.forEach((mark, i) => {
    assert.equal(
      Number(textOf(mark, 'wpml:waypointSpeed')),
      Number(r.plan.speedMs.toFixed(1)),
    );
    assert.equal(
      Number(textOf(mark, 'wpml:waypointGimbalPitchAngle')),
      mission.waypoints[i].pitchDeg,
    );
  });
});

test('action group and action ids, order and parameters are identical to the normal file', () => {
  for (const [name, make] of Object.entries(PLANS)) {
    const r = make();
    const mission = r.missions[0];
    const std = tree(buildMissionFiles(mission, r.plan).waylinesWpml);
    const cmp = tree(
      buildMissionFiles(mission, r.plan, { compact: true }).waylinesWpml,
    );
    const actions = (doc) =>
      all(doc, 'Placemark').map((m) =>
        all(m, 'wpml:actionGroup').map((g) => ({
          id: textOf(g, 'wpml:actionGroupId'),
          start: textOf(g, 'wpml:actionGroupStartIndex'),
          end: textOf(g, 'wpml:actionGroupEndIndex'),
          mode: textOf(g, 'wpml:actionGroupMode'),
          trigger: textOf(g, 'wpml:actionTriggerType'),
          actions: all(g, 'wpml:action').map((a) => [
            textOf(a, 'wpml:actionId'),
            textOf(a, 'wpml:actionActuatorFunc'),
            JSON.stringify(all(a, 'wpml:actionActuatorFuncParam')),
          ]),
        })),
      );
    assert.deepEqual(actions(cmp), actions(std), name);
  }
});

test('a damping distance above 0 and any useStraightLine 1 waypoint keep their elements', () => {
  const r = PLANS.distance();
  const mission = r.missions[0];
  const std = tree(buildMissionFiles(mission, r.plan).waylinesWpml);
  const cmp = tree(
    buildMissionFiles(mission, r.plan, { compact: true }).waylinesWpml,
  );
  const straight = all(cmp, 'Placemark').filter(
    (m) => textOf(m, 'wpml:useStraightLine') === '1',
  );
  assert.ok(straight.length > 0, 'a continuous line has straight waypoints');
  const damped = all(std, 'wpml:waypointTurnDampingDist').filter(
    (n) => Number(n.text) > 0,
  );
  assert.ok(damped.length > 0, 'and some have a damping distance');
  assert.equal(
    all(cmp, 'wpml:waypointTurnDampingDist').filter((n) => Number(n.text) > 0)
      .length,
    damped.length,
  );
  // A straight waypoint that is a stop writes damping 0: that one is kept.
  for (const mark of straight) {
    assert.ok(all(mark, 'wpml:waypointTurnDampingDist').length === 1);
  }
  // Every Placemark without useStraightLine 1 lost its zero damping.
  for (const mark of all(cmp, 'Placemark')) {
    if (textOf(mark, 'wpml:useStraightLine') === '0') {
      assert.equal(all(mark, 'wpml:waypointTurnDampingDist').length, 0);
    }
  }
});

test('compactXml leaves a towardPOI waypoint and a non-zero POI alone', () => {
  const xml = `<Placemark>
  <wpml:waypointHeadingMode>towardPOI</wpml:waypointHeadingMode>
  <wpml:waypointPoiPoint>0.000000,0.000000,0.000000</wpml:waypointPoiPoint>
  <wpml:useStraightLine>0</wpml:useStraightLine>
</Placemark>
<Placemark>
  <wpml:waypointPoiPoint>30.270000,-97.770000,10.000000</wpml:waypointPoiPoint>
  <wpml:waypointTurnMode>coordinateTurn</wpml:waypointTurnMode>
  <wpml:waypointTurnDampingDist>0</wpml:waypointTurnDampingDist>
  <wpml:useStraightLine>0</wpml:useStraightLine>
</Placemark>`;
  const out = compactXml(xml);
  assert.equal(out.split('waypointPoiPoint>').length - 1, 4, 'both POIs kept');
  assert.equal(out.includes('waypointTurnDampingDist'), true, 'coordinateTurn');
  assert.equal(/\s/.test(out.replaceAll(' ', '')), false);
});

test('the compact KMZ is deterministic, DEFLATE, and holds the same two files', async () => {
  const r = PLANS.grid();
  const opts = { when: WHEN, createdMs: CREATED };
  const a = await buildKmzDeflated(r.missions[0], r.plan, opts);
  const b = await buildKmzDeflated(r.missions[0], r.plan, opts);
  assert.deepEqual(a, b);
  const files = await readZipAsync(a);
  assert.deepEqual([...files.keys()], ['wpmz/template.kml', 'wpmz/waylines.wpml']);
  const direct = buildMissionFiles(r.missions[0], r.plan, {
    ...opts,
    compact: true,
  });
  assert.equal(decode(files.get('wpmz/waylines.wpml')), direct.waylinesWpml);
  assert.equal(decode(files.get('wpmz/template.kml')), direct.templateKml);
  assert.throws(() => readZip(a), /Unsupported ZIP method/);
  const std = buildKmz(r.missions[0], r.plan, opts);
  assert.ok(a.length < std.length / 5, `${a.length} vs ${std.length}`);
});

test('our importer reads a compact KMZ back to the same mission as the normal one', async () => {
  for (const [name, make] of Object.entries(PLANS)) {
    const r = make();
    for (const mission of r.missions.slice(0, 2)) {
      const opts = { when: WHEN, createdMs: CREATED };
      const std = await parseDjiKmz(buildKmz(mission, r.plan, opts), {
        fileName: 'a.kmz',
      });
      const cmp = await parseDjiKmz(
        await buildKmzDeflated(mission, r.plan, opts),
        { fileName: 'a.kmz' },
      );
      assert.equal(std.error, undefined, name);
      assert.ok(std.waypoints.length >= 2, name);
      assert.deepEqual(cmp, std, `${name}: parsed mission`);
      assert.deepEqual(deriveImportShots(cmp), deriveImportShots(std), name);
      const sOpen = await openDroneFile(
        buildKmz(mission, r.plan, opts),
        'a.kmz',
      );
      const cOpen = await openDroneFile(
        await buildKmzDeflated(mission, r.plan, opts),
        'a.kmz',
      );
      assert.equal(cOpen.kind, 'mission', name);
      // Each opened file gets its own random list id; nothing else may differ.
      delete cOpen.item.id;
      delete sOpen.item.id;
      assert.deepEqual(cOpen, sOpen, `${name}: openDroneFile`);
    }
  }
});

test('the compact README opens with the notice; the normal README is unchanged', () => {
  const r = PLANS.grid();
  const std = readmeText(r, WHEN);
  assert.equal(readmeText(r, WHEN, { compact: false }), std);
  assert.equal(std.startsWith('GEV Drone Flight Plan\n'), true);
  assert.equal(/COMPACT/.test(std), false);
  const cmp = readmeText(r, WHEN, { compact: true });
  const [first] = cmp.split('\n');
  assert.equal(
    first,
    'COMPACT TEST FILE: whitespace removed, compressed and these optional fields left out: waypointPoiPoint (0,0,0, at waypoints that do not point at a place), waypointTurnDampingDist (0, where useStraightLine is 0); not yet flown on a controller; use the normal export to compare.',
  );
  assert.match(cmp, /UNVERIFIED on DJI Fly and on the remote controller/);
  assert.ok(cmp.endsWith(std), 'the rest is the normal README');
  assert.deepEqual(compactNoticeLines().slice(-1), ['']);
  for (const o of COMPACT_OMISSIONS) assert.ok(first.includes(o.element.replace('wpml:', '')));
});

test('the compact bundle: DEFLATE ZIP of DEFLATE KMZs and a README with the notice', async () => {
  const r = PLANS.grid();
  const opts = { when: WHEN, createdMs: CREATED };
  const zip = await buildBundleZipCompact(r, opts);
  const again = await buildBundleZipCompact(r, opts);
  assert.deepEqual(zip, again);
  const files = await readZipAsync(zip);
  const names = [...files.keys()];
  assert.ok(names.includes('README.txt'));
  assert.ok(decode(files.get('README.txt')).startsWith('COMPACT TEST FILE:'));
  const kmz = names.filter((n) => n.endsWith('.kmz'));
  assert.equal(kmz.length, r.missions.length);
  for (const [i, name] of kmz.entries()) {
    const inner = await readZipAsync(files.get(name));
    assert.deepEqual(
      decode(inner.get('wpmz/waylines.wpml')),
      buildMissionFiles(r.missions[i], r.plan, { ...opts, compact: true })
        .waylinesWpml,
    );
  }
  const entries = await bundleEntriesCompact(r, opts);
  assert.deepEqual(
    entries.map((e) => e.name),
    names,
  );
  // The normal bundle is untouched and has no notice.
  const std = readZip(buildBundleZip(r, opts));
  assert.equal(decode(std.get('README.txt')).includes('COMPACT'), false);
});

test('the compact all-passes suite ZIP carries the notice in every README', async () => {
  const pass = (id) => ({ id, label: id, result: build() });
  const passes = [pass('nadir'), pass('oblique60')];
  const zip = await buildSuiteZipCompact(passes, { when: WHEN, createdMs: CREATED });
  const files = await readZipAsync(zip);
  const readmes = [...files.keys()].filter((n) => n.endsWith('README.txt'));
  assert.equal(readmes.length, 3);
  for (const n of readmes) {
    assert.ok(decode(files.get(n)).startsWith('COMPACT TEST FILE:'), n);
  }
  const std = readZip(buildSuiteZip(passes, { when: WHEN, createdMs: CREATED }));
  assert.equal(decode(std.get('README.txt')).includes('COMPACT'), false);
});

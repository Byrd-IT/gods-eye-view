/**
 * Height mode (Above ground / Flat), extra terrain points on distance and
 * timed lines, and the height figures the panel shows. Every check reads the
 * finished KMZ where the claim is about what the aircraft gets.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assembleAreaPlan, planAreas } from './areas.js';
import { makeFrame } from './geo.js';
import {
  DJI_DEFAULT_HEIGHT_LIMIT_M,
  addTerrainPoints,
  assembleMissions,
  cleanHeightMode,
  cleanTerrainStepM,
  isFlatHeight,
  linePhotoCount,
  normalizeOptions,
  planFlight,
  terrainPointsApply,
} from './planner.js';
import { buildBundleZip, buildKmz } from './wpml.js';
import { readZip } from './zip.js';
import { readPlan, serializePlan } from './planDoc.js';
import { suiteOptions } from './suite.js';
import { warningText, warningTone, takeoffUnsetText } from './format.js';

const WHEN = {
  when: new Date('2026-01-01T12:00:00Z'),
  createdMs: 1767268800000,
};
const BOX = { west: -95.158, east: -95.15, south: 32.687, north: 32.693 };
const CENTRE = {
  lon: (BOX.west + BOX.east) / 2,
  lat: (BOX.south + BOX.north) / 2,
};
const frame = makeFrame(CENTRE.lon, CENTRE.lat);
const area = (box = BOX) => [{ id: 'a', name: 'Field', kind: 'rect', box }];

/** Ground that rises 0.05 m per metre east of the centre, plus a bump. */
const slope = (p) => {
  const { x } = frame.toXY(p.lon, p.lat);
  return 140 + 0.05 * x;
};
const wavy = (p) => {
  const { x } = frame.toXY(p.lon, p.lat);
  return 140 + 20 * Math.sin(x / 80);
};

function groundFor(plan, fn, takeoffM = fn(plan.takeoff)) {
  const wpM = [];
  for (const leg of plan.legs) for (const w of leg.waypoints) wpM[w.id] = fn(w);
  return { known: true, takeoffM, wpM, obstacleM: {} };
}

/** executeHeight of every waypoint of every mission, from the KMZ itself. */
function kmzHeights(result) {
  const out = [];
  for (const mission of result.missions) {
    const files = readZip(buildKmz(mission, result.plan, WHEN));
    const xml = new TextDecoder().decode(files.get('wpmz/waylines.wpml'));
    for (const m of xml.matchAll(
      /<wpml:executeHeight>([-\d.]+)<\/wpml:executeHeight>/g,
    ))
      out.push(Number(m[1]));
    assert.equal(
      (xml.match(/<Placemark>/g) ?? []).length,
      mission.waypointCount,
    );
  }
  return out;
}

const kmzHash = (result) =>
  createHash('sha256')
    .update(
      Buffer.concat(
        result.missions.map((m) => Buffer.from(buildKmz(m, result.plan, WHEN))),
      ),
    )
    .digest('hex');

test('cleaners: unknown height mode is Above ground; terrain spacing is 10-500 m or off', () => {
  assert.equal(cleanHeightMode(undefined), 'terrain');
  assert.equal(cleanHeightMode('flat'), 'flat');
  assert.equal(cleanHeightMode('FLAT'), 'terrain');
  assert.equal(cleanTerrainStepM(null), null);
  assert.equal(cleanTerrainStepM(''), null);
  assert.equal(cleanTerrainStepM('50'), 50);
  assert.equal(cleanTerrainStepM(5), null);
  assert.equal(cleanTerrainStepM(600), null);
  assert.equal(cleanTerrainStepM(true), null);
  const o = normalizeOptions({}, BOX).options;
  assert.equal(o.heightMode, 'terrain');
  assert.equal(o.terrainStepM, null);
  // Orbits always fly above the ground around their targets.
  assert.equal(isFlatHeight({ heightMode: 'flat', pattern: 'orbit' }), false);
  assert.equal(isFlatHeight({ heightMode: 'flat', pattern: 'double' }), true);
});

test('Flat: every KMZ height equals the set height above takeoff, on sloping ground', () => {
  for (const pattern of ['grid', 'double']) {
    for (const captureMode of ['stop', 'timed', 'distance']) {
      const plan = planAreas(area(), {
        aglM: 60.96,
        pattern,
        captureMode,
        heightMode: 'flat',
        batteryMin: 60,
      });
      assert.ok(!plan.error, plan.message);
      const result = assembleAreaPlan(plan, groundFor(plan, slope));
      const heights = kmzHeights(result);
      assert.ok(heights.length > 4);
      for (const h of heights) assert.equal(h, 61, `${pattern}/${captureMode}`);
      // Display = file: one height above takeoff, the real height above the
      // ground varies by the ground difference.
      assert.equal(result.heights.mode, 'flat');
      assert.equal(result.heights.relMinM, 61);
      assert.equal(result.heights.relMaxM, 61);
      const wps = result.missions.flatMap((m) => m.waypoints);
      const real = wps.map((w) => result.ground.takeoffM + 60.96 - w.groundM);
      assert.ok(
        Math.abs(result.heights.aglMinM - Math.min(...real)) < 0.11,
        `${result.heights.aglMinM} vs ${Math.min(...real)}`,
      );
      assert.ok(Math.abs(result.heights.aglMaxM - Math.max(...real)) < 0.11);
      assert.ok(result.heights.aglMaxM - result.heights.aglMinM > 10);
      // Straight flat lines do not get the steep-ground drift note.
      assert.ok(!result.warnings.some((w) => w.code === 'steep-segment'));
    }
  }
});

test('Flat with no terrain read: heights are the set height and the real AGL is unknown', () => {
  const plan = planAreas(area(), { aglM: 50, heightMode: 'flat' });
  const result = assembleAreaPlan(plan, { known: false });
  for (const h of kmzHeights(result)) assert.equal(h, 50);
  assert.equal(result.heights.aglMinM, null);
  assert.equal(result.heights.relMaxM, 50);
});

test('Flat: rising ground under the route warns with the real lowest height', () => {
  const plan = planAreas(area(), { aglM: 30, heightMode: 'flat' });
  // Takeoff on the low west side: the east side is ~17 m higher.
  const result = assembleAreaPlan(plan, groundFor(plan, slope, 125));
  const warn = result.warnings.find((w) => w.code === 'flat-low-clearance');
  assert.ok(warn, JSON.stringify(result.warnings.map((w) => w.code)));
  assert.equal(warn.params.needM, 20); // 15 m trees + 5 m margin
  assert.equal(warn.params.minAglM, result.heights.aglMinM);
  assert.ok(warn.params.minAglM < 20);
  assert.ok(warn.params.count > 0);
  assert.equal(warningTone('flat-low-clearance'), 'bad');
  assert.match(warningText(warn), /only .* above the ground/);
  // The export README gives the same pilot sentence, not a code dump.
  const readme = new TextDecoder().decode(
    readZip(buildBundleZip(result, WHEN)).get('README.txt'),
  );
  assert.ok(readme.includes(`  - ${warningText(warn, 'metric')}`));
  assert.doesNotMatch(readme, /flat-low-clearance \{/);
  // Same plan Above ground: no such warning.
  const terrain = assembleAreaPlan(
    planAreas(area(), { aglM: 30 }),
    groundFor(plan, slope, 125),
  );
  assert.ok(!terrain.warnings.some((w) => w.code === 'flat-low-clearance'));
});

test('Flat: the 400 ft rule uses the real height above the ground', () => {
  const plan = planAreas(area(), { aglM: 115, heightMode: 'flat' });
  // Takeoff 20 m above the highest ground: up to ~135 m above ground (443 ft).
  const result = assembleAreaPlan(plan, groundFor(plan, slope, 180));
  for (const h of kmzHeights(result)) assert.equal(h, 115);
  assert.ok(result.warnings.some((w) => w.code === 'agl-above-400ft'));
  assert.ok(!result.warnings.some((w) => w.code === 'rel-height-over-limit'));
  // The DJI 120 m limit is about the height above TAKEOFF.
  const highPlan = planAreas(area(), {
    aglM: DJI_DEFAULT_HEIGHT_LIMIT_M + 5,
    heightMode: 'flat',
  });
  const high = assembleAreaPlan(highPlan, groundFor(highPlan, slope, 140));
  assert.ok(high.warnings.some((w) => w.code === 'rel-height-over-limit'));
});

test('Flat: an obstacle column is cleared using the real height above the ground', () => {
  // A 40 m column near the east edge, where flat 50 m is only ~33 m up.
  const east = frame.toLonLat(140, 0);
  const obstacles = [
    { id: 'tower', lon: east.lon, lat: east.lat, heightM: 40, radiusM: 30 },
  ];
  const plan = planAreas(area(), { aglM: 50, heightMode: 'flat', obstacles });
  const result = assembleAreaPlan(plan, {
    ...groundFor(plan, slope, 140),
    obstacleM: { tower: slope(east) },
  });
  assert.ok(result.warnings.some((w) => w.code === 'obstacle-raised'));
  const lifted = result.missions
    .flatMap((m) => m.waypoints)
    .filter((w) => w.relHeightM > 50.05);
  assert.ok(lifted.length > 0);
  for (const w of lifted) assert.ok(w.relHeightM + 140 - w.groundM >= 45 - 0.1); // 40 + 5 margin
});

test('Above ground stays byte-identical: no setting, terrain, and a spacing that does not apply', () => {
  const base = { aglM: 70, captureMode: 'stop', batteryMin: 60 };
  const ref = planAreas(area(), base);
  const g = groundFor(ref, wavy);
  const hash = kmzHash(assembleAreaPlan(ref, g));
  for (const extra of [
    { heightMode: 'terrain' },
    { heightMode: 'bogus' },
    { terrainStepM: 25 }, // stop capture: points never apply
    { heightMode: 'terrain', terrainStepM: null },
  ]) {
    const plan = planAreas(area(), { ...base, ...extra });
    assert.equal(plan.terrainPoints, undefined);
    assert.equal(
      kmzHash(assembleAreaPlan(plan, g)),
      hash,
      JSON.stringify(extra),
    );
  }
  // Timed without the spacing set: lines stay two points.
  const timed = planAreas(area(), { ...base, captureMode: 'timed' });
  assert.ok(timed.legs.every((leg) => leg.waypoints.length === 2));
  assert.equal(addTerrainPoints(timed), timed);
});

test('terrain points: timed lines follow curved ground within 0.5 m, photos and route unchanged', () => {
  const base = {
    aglM: 60,
    captureMode: 'timed',
    batteryMin: 60,
    maxWaypoints: 200,
    photoSpacingM: 20,
  };
  const without = planAreas(area(), base);
  const plan = planAreas(area(), { ...base, terrainStepM: 25 });
  assert.ok(!plan.error);
  assert.ok(terrainPointsApply(plan.options));
  let expected = 0;
  plan.legs.forEach((leg, i) => {
    const before = without.legs[i];
    const a = frame.toXY(before.waypoints[0].lon, before.waypoints[0].lat);
    const b = frame.toXY(before.waypoints[1].lon, before.waypoints[1].lat);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    expected += Math.ceil(len / 25 - 1e-9) - 1;
    // Same ends, same photo count, every stretch <= 25 m, points on the line.
    assert.deepEqual(
      [leg.waypoints[0].lon, leg.waypoints.at(-1).lon],
      [before.waypoints[0].lon, before.waypoints[1].lon],
    );
    assert.equal(leg.photoCount, before.photoCount);
    assert.equal(
      leg.photoCount,
      linePhotoCount(leg.lengthM, leg.photoSpacingM),
    );
    for (let k = 1; k < leg.waypoints.length; k += 1) {
      const p = frame.toXY(leg.waypoints[k - 1].lon, leg.waypoints[k - 1].lat);
      const q = frame.toXY(leg.waypoints[k].lon, leg.waypoints[k].lat);
      assert.ok(Math.hypot(q.x - p.x, q.y - p.y) <= 25 + 1e-6);
      // Distance from the original straight line.
      const cross =
        Math.abs((b.x - a.x) * (a.y - q.y) - (a.x - q.x) * (b.y - a.y)) / len;
      assert.ok(cross < 0.01, `off line by ${cross}`);
    }
  });
  assert.equal(plan.terrainPoints.added, expected);
  assert.ok(expected > 0);
  const ids = plan.legs.flatMap((l) => l.waypoints.map((w) => w.id));
  assert.deepEqual(
    ids,
    ids.map((_, i) => i),
  );

  const g = groundFor(plan, wavy);
  const result = assembleAreaPlan(plan, g);
  const old = assembleAreaPlan(without, groundFor(without, wavy));
  assert.equal(result.totals.photoCount, old.totals.photoCount);
  const heights = kmzHeights(result);
  // Each KMZ height is ground + 60 - takeoff at that point, and between two
  // points the straight line the aircraft flies stays within 0.5 m of 60 m
  // above the true ground (without points it is off by many metres).
  const worst = (res) => {
    let err = 0;
    for (const m of res.missions) {
      for (const leg of m.legs) {
        for (let k = 1; k < leg.waypoints.length; k += 1) {
          const p = leg.waypoints[k - 1];
          const q = leg.waypoints[k];
          for (let s = 1; s < 10; s += 1) {
            const f = s / 10;
            const pt = {
              lon: p.lon + (q.lon - p.lon) * f,
              lat: p.lat + (q.lat - p.lat) * f,
            };
            const rel = p.relHeightM + (q.relHeightM - p.relHeightM) * f;
            const agl = rel + g.takeoffM - wavy(pt);
            err = Math.max(err, Math.abs(agl - 60));
          }
        }
      }
    }
    return err;
  };
  assert.ok(worst(result) < 0.5, `with points ${worst(result)}`);
  assert.ok(worst(old) > 5, `without points ${worst(old)}`);
  let i = 0;
  for (const m of result.missions) {
    for (const w of m.waypoints) {
      assert.ok(Math.abs(heights[i] - (w.groundM + 60 - g.takeoffM)) <= 0.051);
      i += 1;
    }
  }
  assert.equal(i, heights.length);
  // README names the added points.
  const readme = new TextDecoder().decode(
    readZip(buildBundleZip(result, WHEN)).get('README.txt'),
  );
  assert.match(
    readme,
    new RegExp(`${expected} terrain points added, every 25\\.0 m`),
  );
});

/** The distance trigger groups of a mission KMZ: [start, end, spacing]. */
function distanceGroups(mission, plan) {
  const xml = new TextDecoder().decode(
    readZip(buildKmz(mission, plan, WHEN)).get('wpmz/waylines.wpml'),
  );
  const out = [];
  for (const g of xml.matchAll(
    /<wpml:actionGroupStartIndex>(\d+)<\/wpml:actionGroupStartIndex>\s*<wpml:actionGroupEndIndex>(\d+)<\/wpml:actionGroupEndIndex>[\s\S]*?<wpml:actionTriggerType>([a-zA-Z]+)<\/wpml:actionTriggerType>(?:\s*<wpml:actionTriggerParam>([\d.]+)<\/wpml:actionTriggerParam>)?/g,
  )) {
    if (g[3] === 'multipleDistance')
      out.push([Number(g[1]), Number(g[2]), g[4]]);
  }
  return out;
}

test('terrain points count against the waypoint cap and the mission split; a line is never cut', () => {
  const base = {
    aglM: 60,
    captureMode: 'distance',
    batteryMin: 60,
    maxWaypoints: 20,
    photoSpacingM: 20,
  };
  const offPlan = planAreas(area(), base);
  const off = assembleAreaPlan(offPlan, groundFor(offPlan, wavy));
  const onPlan = planAreas(area(), { ...base, terrainStepM: 25 });
  const on = assembleAreaPlan(onPlan, groundFor(onPlan, wavy));
  // A ~750 m line wants 30 pieces at 25 m; the cap is 20 per file, so its
  // points are spread wider and the line still fits one file whole.
  assert.ok(onPlan.terrainPoints.widenedLines > 0);
  assert.ok(onPlan.terrainPoints.maxGapM > 25);
  for (const leg of onPlan.legs) assert.ok(leg.waypoints.length <= 20);
  // README says the spacing was widened and gives the real gap.
  const widenedReadme = new TextDecoder().decode(
    readZip(buildBundleZip(on, WHEN)).get('README.txt'),
  );
  assert.match(
    widenedReadme,
    /spread wider to fit the waypoint cap \(up to \d+(\.\d)? m apart\)/,
  );
  // Not widened: no such sentence.
  assert.doesNotMatch(
    new TextDecoder().decode(
      readZip(
        buildBundleZip(
          assembleAreaPlan(
            planAreas(area(), { ...base, maxWaypoints: 200, terrainStepM: 25 }),
            groundFor(onPlan, wavy),
          ),
          WHEN,
        ),
      ).get('README.txt'),
    ),
    /spread wider/,
  );
  assert.ok(on.missions.length > off.missions.length);
  for (const m of on.missions) assert.ok(m.waypointCount <= 20);
  assert.ok(
    on.totals.waypointCount >=
      off.totals.waypointCount + onPlan.terrainPoints.added,
  );
  // Same lines, same ends, same photos, same trigger spacing.
  const lines = (r) =>
    r.missions.flatMap((m) =>
      m.legs
        .filter((l) => l.kind === 'grid')
        .map((l) => ({
          a: [l.waypoints[0].lon, l.waypoints[0].lat],
          b: [l.waypoints.at(-1).lon, l.waypoints.at(-1).lat],
          photos: l.photoCount,
          continued: l.continued === true,
        })),
    );
  assert.deepEqual(lines(on), lines(off));
  assert.ok(lines(on).every((l) => !l.continued));
  assert.equal(on.totals.photoCount, off.totals.photoCount);
  // Distance photos: one trigger group per line spans the whole line, with
  // the same spacing as without terrain points.
  const groups = (r) =>
    r.missions.flatMap((m) => {
      const gs = distanceGroups(m, r.plan);
      assert.equal(gs.length, m.legs.filter((l) => l.kind === 'grid').length);
      return gs.map(([s, e, spacing], i) => {
        assert.equal(
          e - s + 1,
          m.legs.filter((l) => l.kind === 'grid')[i].waypoints.length,
        );
        return spacing;
      });
    });
  assert.deepEqual(groups(on), groups(off));
});

test('terrain points: a line over the battery time stays whole (warned), it is not cut', () => {
  const base = {
    aglM: 60,
    captureMode: 'distance',
    batteryMin: 1,
    photoSpacingM: 20,
  };
  const offPlan = planAreas(area(), base);
  const off = assembleAreaPlan(offPlan, groundFor(offPlan, wavy));
  const onPlan = planAreas(area(), { ...base, terrainStepM: 25 });
  const on = assembleAreaPlan(onPlan, groundFor(onPlan, wavy));
  assert.ok(onPlan.terrainPoints.added > 0);
  const codes = (r) => r.warnings.map((w) => w.code);
  assert.ok(codes(on).includes('mission-over-budget'));
  assert.equal(
    codes(on).includes('mission-over-budget'),
    codes(off).includes('mission-over-budget'),
  );
  const ends = (r) =>
    r.missions.flatMap((m) =>
      m.legs
        .filter((l) => l.kind === 'grid')
        .map((l) => [
          l.waypoints[0].lon,
          l.waypoints.at(-1).lon,
          l.photoCount,
          l.continued === true,
        ]),
    );
  assert.deepEqual(ends(on), ends(off));
  assert.equal(on.totals.photoCount, off.totals.photoCount);
});

test('Flat ignores terrain points (they would do nothing) and orbit ignores both', () => {
  const plan = planAreas(area(), {
    captureMode: 'timed',
    heightMode: 'flat',
    terrainStepM: 25,
  });
  assert.equal(plan.terrainPoints, undefined);
  assert.ok(plan.legs.every((leg) => leg.waypoints.length === 2));
  const orbit = planFlight(BOX, { pattern: 'orbit', heightMode: 'flat' });
  assert.equal(isFlatHeight(orbit.options), false);
  const r = assembleMissions(orbit, groundFor(orbit, slope));
  assert.equal(r.heights.mode, 'terrain');
});

test('takeoff: unset is reported (box centre), a set point is not', () => {
  const plan = planAreas(area(), { aglM: 60 });
  const r = assembleAreaPlan(plan, groundFor(plan, slope));
  assert.equal(r.heights.takeoffSet, false);
  assert.match(takeoffUnsetText(), /box centre/);
  assert.equal(warningTone('takeoff-unset'), 'warn');
  // It is a plan warning: the panel lists it and the export README says it.
  assert.ok(r.warnings.some((w) => w.code === 'takeoff-unset'));
  assert.equal(
    warningText({ code: 'takeoff-unset', params: {} }),
    takeoffUnsetText(),
  );
  const readme = new TextDecoder().decode(
    readZip(buildBundleZip(r, WHEN)).get('README.txt'),
  );
  assert.match(
    readme,
    /No takeoff point was set: every height in these files is measured from the box centre/,
  );
  assert.doesNotMatch(readme, /takeoff-unset \{/);
  const set = planAreas(area(), {
    aglM: 60,
    takeoff: { lon: BOX.west + 0.001, lat: BOX.south + 0.001 },
  });
  const rs = assembleAreaPlan(set, groundFor(set, slope));
  assert.equal(rs.heights.takeoffSet, true);
  assert.ok(!rs.warnings.some((w) => w.code === 'takeoff-unset'));
  // Above ground: DJI Fly's numbers are 60 + ground - takeoff ground.
  const heights = kmzHeights(rs);
  assert.equal(Math.min(...heights), rs.heights.relMinM);
  assert.equal(Math.max(...heights), rs.heights.relMaxM);
  assert.ok(rs.heights.relMaxM > 60 + 5);
  assert.ok(Math.abs(rs.heights.aglMinM - 60) < 0.11);
  assert.ok(Math.abs(rs.heights.aglMaxM - 60) < 0.11);
});

test('saved plans: the setting round-trips; an older plan without it loads as Above ground', () => {
  const state = {
    areas: [{ id: 'a', name: 'Field', kind: 'rect', box: BOX }],
    nextArea: 2,
    jobGrouping: 'per-area',
    takeoff: null,
    options: {
      presetId: 'dji-mini-5-pro',
      aglM: 60,
      heightMode: 'flat',
      terrainStepM: 50,
    },
    wpml: {},
  };
  const doc = JSON.parse(JSON.stringify(serializePlan(state)));
  const back = readPlan(doc);
  assert.equal(back.options.heightMode, 'flat');
  assert.equal(back.options.terrainStepM, 50);
  delete doc.options.heightMode;
  delete doc.options.terrainStepM;
  const old = readPlan(doc);
  assert.equal('heightMode' in old.options, false);
  assert.equal(
    normalizeOptions(old.options, BOX).options.heightMode,
    'terrain',
  );
  // Junk from a file is dropped.
  doc.options.heightMode = 'sideways';
  doc.options.terrainStepM = 3;
  const junk = readPlan(doc);
  assert.equal('heightMode' in junk.options, false);
  assert.equal('terrainStepM' in junk.options, false);
  // An older plan's KMZ is the same as before the setting existed.
  const oldPlan = planAreas(area(), { ...old.options, takeoff: old.takeoff });
  const before = planAreas(area(), { presetId: 'dji-mini-5-pro', aglM: 60 });
  const g = groundFor(before, slope);
  assert.equal(
    kmzHash(assembleAreaPlan(oldPlan, g)),
    kmzHash(assembleAreaPlan(before, g)),
  );
});

test('PLAN ALL passes keep the height mode and terrain spacing', () => {
  const passes = suiteOptions({
    presetId: 'dji-mini-5-pro',
    heightMode: 'flat',
    terrainStepM: 50,
  });
  assert.ok(passes.length > 1);
  for (const p of passes) {
    assert.equal(p.options.heightMode, 'flat');
    assert.equal(p.options.terrainStepM, 50);
  }
});

test('README: Flat names the requested height and the range the file writes', () => {
  const plan = planAreas(area(), {
    aglM: 60,
    heightMode: 'flat',
    takeoff: { lon: BOX.west + 0.001, lat: BOX.south + 0.001 },
  });
  const r = assembleAreaPlan(plan, groundFor(plan, slope));
  const readme = new TextDecoder().decode(
    readZip(buildBundleZip(r, WHEN)).get('README.txt'),
  );
  assert.match(
    readme,
    /Height: 60(\.0)? m above the takeoff point \(Flat, requested\)\. This file: 60(\.0)? m above the takeoff point at every waypoint\./,
  );
  // An Above-ground plan keeps the line every earlier export had.
  const above = planAreas(area(), { aglM: 60 });
  const ra = assembleAreaPlan(above, groundFor(above, slope));
  const readmeA = new TextDecoder().decode(
    readZip(buildBundleZip(ra, WHEN)).get('README.txt'),
  );
  assert.match(readmeA, /\n  Height: 60(\.0)? m above ground \(requested\)\n/);
});

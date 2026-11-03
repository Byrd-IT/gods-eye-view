import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleMissions, planFlight } from './planner.js';
import { metersPerDegree } from './geo.js';
import { readZip } from './zip.js';
import { buildBundleZip, buildKmz } from './wpml.js';
import { buildSuiteZip } from './suite.js';
import { checkMission, parseDjiKmz } from './djiKmz.js';
import {
  flightCode,
  flightCodePadded,
  flightFileName,
  flightTitle,
  hasLabel,
  labelStem,
  missionCode,
} from './missionLabel.js';
import {
  THUMB_H,
  THUMB_W,
  drawThumb,
  renderThumb,
  thumbFrame,
  tileUrl,
} from './missionThumb.js';
import {
  cheatSheetHtml,
  cheatSheetText,
  numberedPlans,
} from './cheatSheet.js';

const decode = (b) => new TextDecoder().decode(b);

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

test('codes: M7, M7-2 for flight 2 of several, padded for files', () => {
  assert.equal(missionCode(7), 'M7');
  assert.equal(flightCode(7), 'M7');
  assert.equal(flightCode(7, 1, 3), 'M7-2');
  assert.equal(flightCodePadded(7), 'M07');
  assert.equal(flightCodePadded(12, 0, 2), 'M12-1');
  assert.equal(flightTitle({ no: 7, name: 'Byrd Ranch ring A' }), 'M07 Byrd Ranch ring A');
  assert.equal(
    flightTitle({ no: 7, name: 'ring A' }, 1, 3),
    'M07-2 ring A (2 of 3)',
  );
  assert.equal(flightTitle({ no: 3, name: '' }), 'M03');
});

test('file names: M07_ring-A.kmz, plain ASCII, never a path', () => {
  assert.equal(flightFileName({ no: 7, name: 'ring A' }), 'M07_ring-A.kmz');
  assert.equal(
    flightFileName({ no: 7, name: 'ring A' }, 1, 3),
    'M07-2_ring-A.kmz',
  );
  assert.equal(flightFileName({ no: 7, name: '' }), 'M07.kmz');
  assert.equal(
    flightFileName({ no: 9, name: '../../etc/pässwd & <x>\n' }),
    'M09_etc-passwd-x.kmz',
  );
  assert.match(flightFileName({ no: 1, name: 'x'.repeat(200) }), /^M01_x{40}\.kmz$/);
  assert.equal(labelStem({ no: 7, name: 'ring A' }), 'M07_ring-A');
  assert.equal(hasLabel({ no: 7, name: '' }), true);
  assert.equal(hasLabel({ no: 0 }), false);
  assert.equal(hasLabel(null), false);
  assert.equal(hasLabel({ no: 1.5 }), false);
});

/** A 2D context that records the calls the drawing makes. */
function recorder() {
  const calls = [];
  const ctx = new Proxy(
    {},
    {
      get: (target, key) =>
        key in target
          ? target[key]
          : (...args) => {
              calls.push([String(key), ...args]);
            },
      set: (target, key, value) => {
        target[key] = value;
        if (key === 'font') calls.push(['font', value]);
        return true;
      },
    },
  );
  return { ctx, calls };
}

test('thumbnail frame keeps every point inside the picture, with a margin', () => {
  const pts = [
    { lat: 30.27, lon: -97.77 },
    { lat: 30.2712, lon: -97.7688 },
    { lat: 30.2705, lon: -97.7701 },
  ];
  const f = thumbFrame(pts);
  for (const p of pts) {
    const { x, y } = f.project(p);
    assert.ok(x > 0 && x < THUMB_W && y > 0 && y < THUMB_H, `${x},${y}`);
  }
  assert.equal(thumbFrame([]), null);
  assert.equal(thumbFrame([{ lat: NaN, lon: 1 }]), null);
  // One point does not blow up: it sits in the middle.
  const one = thumbFrame([{ lat: 30, lon: -97 }]).project({ lat: 30, lon: -97 });
  assert.ok(Math.abs(one.x - THUMB_W / 2) < 1 && Math.abs(one.y - THUMB_H / 2) < 1);
  assert.match(tileUrl(f), /^https:\/\/services\.arcgisonline\.com\/.*bboxSR=3857.*size=400,300/);
});

test('the picture draws the route, the takeoff and the big code', () => {
  const { ctx, calls } = recorder();
  drawThumb(ctx, {
    code: 'M7',
    title: 'M07 ring A',
    points: [
      { lat: 30.27, lon: -97.77 },
      { lat: 30.271, lon: -97.769 },
    ],
    takeoff: { lat: 30.27, lon: -97.77 },
  });
  const texts = calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
  assert.ok(texts.includes('M7'), 'the code is written');
  assert.ok(texts.includes('ring A'), 'the name is written without its code');
  assert.ok(texts.includes('H'), 'the takeoff is marked');
  assert.ok(calls.some((c) => c[0] === 'lineTo'), 'the route is stroked');
  const codeFont = calls.find((c) => c[0] === 'font' && /bold 1\d\dpx/.test(c[1]));
  assert.ok(codeFont, 'the code is big (100px+)');
  // A long code shrinks so it still fits the plate.
  const long = recorder();
  drawThumb(long.ctx, { code: 'M123-4', points: [] });
  assert.ok(long.calls.some((c) => c[0] === 'font' && /bold 54px/.test(c[1])));
});

function fakeCanvas({ taint = false } = {}) {
  const rec = recorder();
  const canvas = {
    getContext: () => rec.ctx,
    toBlob: (cb, type) => {
      if (taint && rec.calls.some((c) => c[0] === 'drawImage')) {
        throw new Error('SecurityError: tainted canvas');
      }
      cb({ arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9, type.length]).buffer });
    },
  };
  return { canvas, rec };
}
const okImage = () => {
  const img = {};
  Object.defineProperty(img, 'src', {
    set() {
      setTimeout(() => img.onload?.(), 0);
    },
  });
  return img;
};
const badImage = () => {
  const img = {};
  Object.defineProperty(img, 'src', {
    set() {
      setTimeout(() => img.onerror?.(), 0);
    },
  });
  return img;
};
const spec = {
  code: 'M7',
  points: [
    { lat: 30.27, lon: -97.77 },
    { lat: 30.271, lon: -97.769 },
  ],
};

test('renderThumb: tile first, JPEG bytes out', async () => {
  const f = fakeCanvas();
  const out = await renderThumb(spec, { createCanvas: () => f.canvas, createImage: okImage });
  assert.equal(out.tile, true);
  assert.deepEqual([...out.bytes.slice(0, 2)], [0xff, 0xd8]);
  assert.ok(f.rec.calls.some((c) => c[0] === 'drawImage'));
});

test('renderThumb: a tile that will not load, or taints the canvas, still gives a labelled picture', async () => {
  const noTile = fakeCanvas();
  const a = await renderThumb(spec, { createCanvas: () => noTile.canvas, createImage: badImage });
  assert.equal(a.tile, false);
  assert.ok(noTile.rec.calls.some((c) => c[0] === 'fillText' && c[1] === 'M7'));
  const tainted = fakeCanvas({ taint: true });
  // Each attempt gets its own canvas, as in the browser.
  const made = [];
  const b = await renderThumb(spec, {
    createCanvas: () => {
      const f = fakeCanvas({ taint: true });
      made.push(f);
      return f.canvas;
    },
    createImage: okImage,
  });
  assert.equal(b.tile, false);
  assert.equal(made.length, 2);
  assert.ok(tainted);
  // No canvas at all: null, never a throw.
  assert.equal(await renderThumb(spec, { createCanvas: () => null, createImage: badImage }), null);
});

test('cheat sheet: M numbers, flown state and date, trash left out', () => {
  const plans = [
    { id: 'b', missionNo: 2, name: 'Shop <roof>', status: 'flown', flownAt: Date.UTC(2026, 10, 3, 18) },
    { id: 'a', missionNo: 1, name: 'Ring A', status: 'planned', site: 'Byrd Ranch' },
    { id: 'c', missionNo: 3, name: 'Gone', status: 'planned', deletedAt: 5 },
    { id: 'd', name: 'no number yet', status: 'planned' },
  ];
  assert.deepEqual(numberedPlans(plans).map((p) => p.missionNo), [1, 2]);
  const text = cheatSheetText(plans, { when: new Date(2026, 10, 3), user: 'brandon' });
  assert.match(text, /\[ \] M1 +Ring A @ Byrd Ranch +- not flown/);
  assert.match(text, /\[x\] M2 +Shop <roof> +- FLOWN 2026-11-0[34]/);
  assert.doesNotMatch(text, /Gone|no number yet/);
  assert.match(text, /Placeholders to create: M1, M2/);
  assert.match(text, /RENAME it to that number/);
  const html = cheatSheetHtml(plans, { when: new Date(2026, 10, 3) });
  assert.match(html, /Shop &lt;roof&gt;/);
  assert.doesNotMatch(html, /Shop <roof>/);
  assert.match(cheatSheetText([]), /No saved plans yet/);
});

test('export with a label: M07 file names, picture, README; still DJI Fly\'s form', async () => {
  const result = build();
  const label = { no: 7, name: 'Byrd Ranch ring A' };
  const pic = new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
  const files = readZip(
    buildBundleZip(result, { label, previews: [pic], when: new Date(2026, 10, 3) }),
  );
  const names = [...files.keys()];
  const total = result.missions.length;
  assert.ok(names.includes(flightFileName(label, 0, total)), names.join());
  assert.ok(names.includes(`${flightFileName(label, 0, total, 'jpg').replace(/\.jpg$/, '')}_preview.jpg`));
  assert.deepEqual([...files.get(names.find((n) => n.endsWith('_preview.jpg')))], [...pic]);
  const readme = decode(files.get('README.txt'));
  assert.match(readme, /MISSION LABELS/);
  assert.match(readme, new RegExp(`M7${total > 1 ? '-1' : ''} +M07`));
  assert.match(readme, /NAME from the placeholder/);
  // The KMZ is the same structure DJI Fly writes: the structural check is clean.
  const kmzName = names.find((n) => n.endsWith('.kmz'));
  const parsed = await parseDjiKmz(files.get(kmzName), { fileName: kmzName });
  const findings = checkMission(parsed, { droneEnumValue: 68 });
  assert.deepEqual(
    findings.filter((f) => f.code === 'template-shape' || f.code === 'namespace'),
    [],
  );
  assert.equal(parsed.meta.author, flightTitle(label, 0, total));
  // The waypoints are not touched by the label.
  const plain = readZip(buildBundleZip(result, { when: new Date(2026, 10, 3) }));
  const plainKmz = [...plain.keys()].find((n) => n.endsWith('.kmz'));
  const way = (zip, n) => decode(readZip(zip.get(n)).get('wpmz/waylines.wpml'));
  assert.equal(way(files, kmzName), way(plain, plainKmz));
});

test('export with a label and controller ids: <UUID>.kmz stays, picture also goes to map_preview/<UUID>/<UUID>.jpg', () => {
  const result = build();
  const uuid = '8A05BD5F-A9CE-4867-923F-7AACC02AF9A9';
  const pic = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const files = readZip(
    buildBundleZip(result, {
      label: { no: 3, name: 'x' },
      previews: [pic],
      controllerIds: [uuid],
    }),
  );
  const names = [...files.keys()];
  assert.ok(names.includes(`${uuid}.kmz`));
  assert.ok(names.includes(`map_preview/${uuid}/${uuid}.jpg`));
  assert.match(decode(files.get('README.txt')), new RegExp(`waypoint/${uuid}/${uuid}\\.kmz`));
});

test('export without a label is exactly what it was (no pictures, no label block)', () => {
  const result = build();
  const files = readZip(buildBundleZip(result, { when: new Date(2026, 10, 3, 15, 30) }));
  const names = [...files.keys()];
  assert.ok(names.every((n) => n === 'README.txt' || /^gev-drone-plan-20261103-1530-m\dof\d\.kmz$/.test(n)), names.join());
  assert.doesNotMatch(decode(files.get('README.txt')), /MISSION LABELS/);
});

test('suite zip: flights are numbered across the passes', () => {
  const r1 = build();
  const r2 = build({ aglM: 80 });
  const passes = [
    { id: 'a', label: 'nadir', result: r1 },
    { id: 'b', label: 'oblique', result: r2 },
  ];
  const files = readZip(buildSuiteZip(passes, { label: { no: 5, name: 'field' } }));
  const kmz = [...files.keys()].filter((n) => n.endsWith('.kmz'));
  const total = r1.missions.length + r2.missions.length;
  const base = new Set(kmz.map((n) => n.split('/').pop()));
  assert.equal(base.size, total, 'every flight has its own M05-n file name');
  assert.ok(kmz.every((n) => /\/M05(-\d+)?_field\.kmz$/.test(n)), kmz.join());
});

test('buildKmz with a label writes the title as the author and nothing else changes', async () => {
  const result = build();
  const bytes = buildKmz(result.missions[0], result.plan, { name: 'M07 ring A' });
  const parsed = await parseDjiKmz(bytes);
  assert.equal(parsed.meta.author, 'M07 ring A');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decodeQuantizedMesh,
  geographicTileBounds,
  sampleHeight,
} from './fixtures/quantizedMesh.mjs';

/**
 * P6 item 5: building bases vs the open terrain, on real served data.
 *
 * fixtures/terrain-14-7487-10947.terrain is the gev-basemap tile (P1,
 * mh0.0.13-wm20261011, cesium-mesh/ellipsoid) over downtown Austin, byte for
 * byte. fixtures/alignment-austin.json holds the lowest vertex of every 5th
 * building of the gev-buildings glb 14/3743/6745 (P5, ov2026-09-23.1-v5-add)
 * that falls in that terrain tile (fixtures/makeAlignmentFixture.mjs). Both
 * layers are ellipsoid heights, so a base that matches the terrain sits on
 * the ground the user sees: no floating or sunken buildings.
 */

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/alignment-austin.json', import.meta.url)),
);
const mesh = decodeQuantizedMesh(
  readFileSync(
    new URL('./fixtures/terrain-14-7487-10947.terrain', import.meta.url),
  ),
  fixture.tile,
);

/** Signed base - terrain offsets (m) for a set of buildings. */
function offsets(buildings, shiftM = 0) {
  return buildings.map(
    (b) => b.baseM + shiftM - sampleHeight(mesh, b.lon, b.lat),
  );
}

/** The acceptance rule: every base within 3 m, median within 1 m, no bias. */
function aligned(values) {
  const abs = values.map(Math.abs).sort((a, b) => a - b);
  const median = abs[Math.floor(abs.length / 2)];
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return {
    ok:
      values.every(Number.isFinite) &&
      abs.at(-1) <= 3 &&
      median <= 1 &&
      Math.abs(mean) <= 0.5,
    max: abs.at(-1),
    median,
    mean,
  };
}

test('fixture: the real Austin terrain tile decodes and covers the buildings', () => {
  assert.equal(mesh.vertexCount, 1253);
  assert.equal(mesh.triangleCount, 2413);
  const [w, s, e, n] = geographicTileBounds(fixture.tile);
  assert.ok(w < -97.7427 && -97.7427 < e && s < 30.2747 && 30.2747 < n);
  assert.ok(fixture.buildings.length >= 50, `${fixture.buildings.length}`);
  for (const b of fixture.buildings) {
    assert.ok(b.lon > w && b.lon < e && b.lat > s && b.lat < n);
    // The height the glb was extruded from sits on its own baked ground.
    assert.ok(Math.abs(b.groundElevM - b.baseM) <= 0.25, JSON.stringify(b));
  }
  // Heights inside the tile's range (Austin downtown ~110-145 m ellipsoid).
  const h = sampleHeight(mesh, -97.7427, 30.2747);
  assert.ok(h > mesh.minimumHeight && h < mesh.maximumHeight, String(h));
});

test('building bases sit on the open terrain (Austin downtown)', () => {
  const result = aligned(offsets(fixture.buildings));
  assert.equal(
    result.ok,
    true,
    `max ${result.max.toFixed(2)} m, median ${result.median.toFixed(2)} m, mean ${result.mean.toFixed(2)} m`,
  );
});

test('the check catches a datum or geoid mistake', () => {
  // EGM96/EGM2008 undulation at Austin is about -26 m; mixing orthometric
  // and ellipsoid heights would float or sink every building by that much.
  assert.equal(aligned(offsets(fixture.buildings, -26)).ok, false);
  assert.equal(aligned(offsets(fixture.buildings, 2)).ok, false);
  // Buildings placed one tile east (wrong tile math) do not line up either.
  const width = 180 / 2 ** fixture.tile.z;
  const moved = fixture.buildings
    .map((b) => ({ ...b, lon: b.lon - width / 2 }))
    .filter((b) => Number.isFinite(sampleHeight(mesh, b.lon, b.lat)));
  assert.ok(moved.length > 10);
  assert.equal(aligned(offsets(moved)).ok, false);
});

test('outside the tile the sampler says so (NaN), it never extrapolates', () => {
  const [w, s] = geographicTileBounds(fixture.tile);
  assert.ok(Number.isNaN(sampleHeight(mesh, w - 0.001, s + 0.001)));
});

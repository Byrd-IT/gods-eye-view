import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planFlight, assembleMissions } from './planner.js';
import { buildKmz } from './wpml.js';
import { getUnitSystem, setUnitSystem } from './units.js';

// Generated from live base d150eb41765c8fc5204245748d8eb7724429de81 with
// the same fixed timestamp and plan, before the mph display changes.
test('speed display units do not change the baseline mission KMZ bytes', () => {
  const box = { west: -97.772, east: -97.768, south: 30.269, north: 30.271 };
  const plan = planFlight(box, {
    aglM: 100,
    batteryMin: 60,
    captureMode: 'timed',
    speedMs: 6.7056,
    photoSpacingM: 25,
  });
  assert.ok(!plan.error);
  const ids = plan.legs.flatMap((leg) =>
    leg.waypoints.map((waypoint) => waypoint.id),
  );
  const result = assembleMissions(plan, {
    known: true,
    takeoffM: 100,
    wpM: ids.map((id) => 100 + (id % 5)),
  });
  const previous = getUnitSystem();
  try {
    for (const system of ['ft', 'm']) {
      setUnitSystem(system);
      const bytes = buildKmz(result.missions[0], result.plan, {
        when: new Date('2026-01-01T12:00:00Z'),
        createdMs: 1767268800000,
      });
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        '4f6a90aab1047daaca63b7758dc07616d7dfdf22e9c2c04bbed9a9163ca9c86a',
      );
    }
  } finally {
    setUnitSystem(previous);
  }
});

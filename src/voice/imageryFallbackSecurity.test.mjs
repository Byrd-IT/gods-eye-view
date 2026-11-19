import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { StyleManager } from '../ui/applicationShell.js';
import { createGevActionRunner } from './gevActions.js';
import { bindRenderer } from '../render/rendererOf.js';
import { createStubRenderer } from '../render/stub/index.js';

test('fallback readback excludes untrusted years and retains all valid years', async () => {
  const marker = `SYNTHETIC_${randomUUID()}`;
  const years = Array.from({ length: 40 }, (_, i) => 1980 + i);
  globalThis.document = {
    body: { classList: { contains: () => false } },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  globalThis.window ??= { setTimeout, clearTimeout };
  const viewer = {
    container: {
      ownerDocument: {
        defaultView: {
          __gevNaip: {
            state: () => ({ year: marker, ticks: [...years, marker] }),
          },
        },
      },
    },
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
    camera: { moveEnd: { addEventListener() {} } },
  };
  viewer.canvas = viewer.scene.canvas;
  const renderer = createStubRenderer();
  renderer.camera.setView({
    destination: { lon: -95, lat: 32, height: 500 },
    orientation: { heading: 0, pitch: -0.5, roll: 0 },
  });
  bindRenderer(viewer, renderer);
  const style = {
    viewer,
    getDetectionState: () => null,
    _visualSettings: {},
    _recording: {},
    getControlState: StyleManager.prototype.getControlState,
  };
  const run = createGevActionRunner({
    viewer,
    styleManager: style,
    dataManager: { layers: new Map(), getAll: () => [] },
  });
  const result = await run('get_current_view_state', {});
  assert.equal(result.controls.imageryYear, null);
  assert.deepEqual(result.controls.imageryYears, years);
  assert.equal(JSON.stringify(result).includes(marker), false);
});

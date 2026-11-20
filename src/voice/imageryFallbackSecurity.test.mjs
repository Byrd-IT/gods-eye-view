import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { StyleManager } from '../ui/applicationShell.js';
import { createGevActionRunner } from './gevActions.js';
import { bindRenderer } from '../render/rendererOf.js';
import { createStubRenderer } from '../render/stub/index.js';

test('fallback readback excludes untrusted years and retains all valid years', async () => {
  const marker = `SYNTHETIC_${randomUUID()}`;
  const opacityMarker = `synthetic-${randomUUID().replaceAll('-', '')}`;
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
    _dataManager: { layers: new Map([['flights', {}]]) },
    _layerOpacityModel: {
      entries: () => [
        ['flights', 0.5],
        [opacityMarker, 0.5],
      ],
    },
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
  assert.deepEqual(result.controls.layerOpacity, { flights: 50 });
  assert.equal(JSON.stringify(result).includes(opacityMarker), false);
  const direct = createGevActionRunner({
    viewer,
    styleManager: { getControlState: () => ({}) },
    dataManager: { layers: new Map([['flights', {}]]), getAll: () => [] },
    layerOpacity: {
      entries: () => [
        ['flights', 0.5],
        [opacityMarker, 0.5],
      ],
      get: () => 0.5,
    },
  });
  const directResult = await direct('get_current_view_state', {});
  assert.deepEqual(directResult.layerOpacity, { flights: 50 });
  assert.equal(JSON.stringify(directResult).includes(opacityMarker), false);
});

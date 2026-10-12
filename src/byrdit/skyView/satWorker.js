/**
 * Sky view satellite module worker (SKYVIEW.md 4.1). Thin message wrapper
 * around satCore.js's engine; all maths lives there (and in the reused
 * src/data/satellitePass.js), so node tests drive the same handler directly.
 *
 * Messages in:
 *   { type: 'gp', path, text }                  load one /api/celestrak group
 *   { type: 'observer', latDeg, lonDeg }        set the observer (resets culling)
 *   { type: 'tick', seq, timeMs, sets, ageSets } compute one tick
 * Messages out:
 *   { type: 'catalog', version, load, meta }    after every 'gp'
 *     (load.warmUp = { calls, durationMs } of the JIT warm-up that ran)
 *   { type: 'observer', ok }
 *   { type: 'tick', seq, timeMs, records, count, sets, sunAltDeg, dark,
 *     computed, culled, dropped, failed, durationMs, age }
 *     `records` is the packed Float32Array (transferred, not copied).
 *   { type: 'error', message, request }
 */
import { createSatEngine } from './satCore.js';

export function createSatWorkerHandler(
  post,
  { engine = createSatEngine() } = {},
) {
  return function handle(data) {
    const type = data?.type;
    try {
      if (type === 'gp') {
        const load = engine.loadGroup(String(data.path || ''), data.text);
        // Compile the tick's code on the new entries now, not inside the
        // first 1 Hz tick (satCore warmUp; reported, not hidden).
        load.warmUp = engine.warmUp();
        post({
          type: 'catalog',
          version: engine.version,
          load,
          meta: engine.meta(),
        });
      } else if (type === 'observer') {
        post({
          type: 'observer',
          ok: engine.setObserver(data.latDeg, data.lonDeg),
        });
      } else if (type === 'tick') {
        const result = engine.tick({
          timeMs: data.timeMs,
          sets: Array.isArray(data.sets) ? data.sets : undefined,
          cull: data.cull !== false,
        });
        const age = engine.ageSummary(
          data.timeMs,
          Array.isArray(data.ageSets) ? data.ageSets : result.sets,
        );
        post({ type: 'tick', seq: data.seq ?? null, ...result, age }, [
          result.records.buffer,
        ]);
      }
    } catch (error) {
      post({
        type: 'error',
        request: type ?? null,
        seq: data?.seq ?? null,
        message: String(error?.message || error),
      });
    }
  };
}

// Inside a real worker only (node tests import the handler above).
const scope = globalThis;
if (
  typeof scope.WorkerGlobalScope !== 'undefined' &&
  scope instanceof scope.WorkerGlobalScope
) {
  const handle = createSatWorkerHandler((message, transfer) =>
    scope.postMessage(message, transfer || []),
  );
  scope.addEventListener('message', (event) => handle(event.data));
}

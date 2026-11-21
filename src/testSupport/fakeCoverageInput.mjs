// Byrd-IT: port doubles for the photo coverage tests (src/byrdit/photoCoverage): an input dispatcher that records
// subscriptions and camera/stock-click holds, and a draw port that keeps sets.
import { fakeDrawPort } from './fakeDrawPort.mjs';

export { fakeDrawPort };

export function fakeInput() {
  const subs = { down: [], move: [], up: [], click: [] };
  const state = { cameraHolds: 0, stockHolds: 0, cameraReasons: [] };
  const add = (list, fn, lease = null) => {
    const entry = { fn, lease };
    list.push(entry);
    return () => {
      const i = list.indexOf(entry);
      if (i >= 0) list.splice(i, 1);
    };
  };
  const hold = (key) => {
    state[key] += 1;
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      state[key] -= 1;
    };
  };
  return {
    state,
    subs,
    onClick: (fn) => add(subs.click, fn),
    onPointer: (type, fn, { lease } = {}) => add(subs[type], fn, lease),
    suspendCamera: (reason) => {
      state.cameraReasons.push(reason);
      return hold('cameraHolds');
    },
    suppressStockClicks: () => hold('stockHolds'),
    /** Deliver a pointer event to every subscriber of `type`. */
    fire(type, event) {
      for (const { fn } of [...subs[type]]) fn(event);
    },
    subscriberCount: () =>
      subs.down.length + subs.move.length + subs.up.length + subs.click.length,
  };
}

import { claimPointer, releasePointer } from '../../data/inputOwnership.js';
import { inputFor } from '../../input/dispatcher.js';
import { canvasOf } from '../../render/rendererOf.js';
import { selectScreenPoints } from './selection.js';

/** The id this tool claims the pointer under. */
export const COVERAGE_SELECTION_POINTER_OWNER = 'photo-coverage-selection';

// One-shot drag selection. Holds the pointer for the session, suppresses the
// stock clicks, freezes the camera only mid-drag, and gives everything back
// on completion, Escape, a newer pointer claim or disposal.
export function beginScreenSelection({
  viewer,
  mode,
  getPoints,
  onSelect,
  input = inputFor(viewer),
  canvas = canvasOf(viewer),
  doc = canvas?.ownerDocument ?? globalThis.document,
}) {
  if (!['box', 'circle'].includes(mode))
    throw new Error('Invalid selection mode');
  const overlay = doc.createElement('div');
  Object.assign(overlay.style, {
    position: 'absolute',
    pointerEvents: 'none',
    border: '2px solid #36bfff',
    background: 'rgba(54,191,255,.12)',
    display: 'none',
    zIndex: '99',
  });
  (canvas?.parentElement ?? viewer.container)?.append(overlay);
  let start = null,
    done = false,
    releaseCamera = null;
  const lease = claimPointer(COVERAGE_SELECTION_POINTER_OWNER, {
    onLost: () => {
      if (lease && !done) dispose();
    },
  });
  function thaw() {
    releaseCamera?.();
    releaseCamera = null;
  }
  function down(e) {
    if (start || !e?.position) return;
    start = { x: e.position.x, y: e.position.y };
    releaseCamera ??= input.suspendCamera('photo-coverage-selection');
    overlay.style.display = 'block';
  }
  function move(e) {
    const p = e?.endPosition;
    if (!start || !p) return;
    const dx = p.x - start.x,
      dy = p.y - start.y,
      r = Math.hypot(dx, dy);
    Object.assign(
      overlay.style,
      mode === 'box'
        ? {
            left: `${Math.min(start.x, p.x)}px`,
            top: `${Math.min(start.y, p.y)}px`,
            width: `${Math.abs(dx)}px`,
            height: `${Math.abs(dy)}px`,
            borderRadius: '0',
          }
        : {
            left: `${start.x - r}px`,
            top: `${start.y - r}px`,
            width: `${2 * r}px`,
            height: `${2 * r}px`,
            borderRadius: '50%',
          },
    );
  }
  function up(e) {
    if (!start || !e?.position) return;
    const end = { x: e.position.x, y: e.position.y };
    let selected = [];
    try {
      selected = selectScreenPoints(getPoints(), start, end, mode);
    } finally {
      dispose();
    }
    onSelect(selected);
  }
  function key(e) {
    if (e.key === 'Escape') {
      e.preventDefault?.();
      dispose();
    }
  }
  const held = { lease: () => lease };
  const offs = [
    input.onPointer('down', down, held),
    input.onPointer('move', move, held),
    input.onPointer('up', up, held),
    input.suppressStockClicks(),
  ];
  doc.addEventListener('keydown', key, true);
  function dispose() {
    if (done) return;
    done = true;
    thaw();
    overlay.remove();
    offs.forEach((off) => off());
    doc.removeEventListener('keydown', key, true);
    releasePointer(lease);
  }
  return dispose;
}

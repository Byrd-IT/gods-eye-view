import { selectScreenPoints } from './selection.js';

// One-shot drag selection. Restores the exact previous camera-input state on
// pointer cancellation, completion, Escape or disposal.
export function beginScreenSelection({
  viewer,
  mode,
  getPoints,
  onSelect,
  doc = viewer.container.ownerDocument,
}) {
  if (!['box', 'circle'].includes(mode))
    throw new Error('Invalid selection mode');
  const canvas = viewer.scene.canvas,
    controller = viewer.scene.screenSpaceCameraController;
  const prior = controller.enableInputs;
  controller.enableInputs = false;
  const overlay = doc.createElement('div');
  Object.assign(overlay.style, {
    position: 'absolute',
    pointerEvents: 'none',
    border: '2px solid #36bfff',
    background: 'rgba(54,191,255,.12)',
    display: 'none',
    zIndex: '99',
  });
  viewer.container.append(overlay);
  let start = null,
    pointer = null,
    done = false;
  function point(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function swallow(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  function down(e) {
    if (pointer !== null || e.button !== 0) return;
    swallow(e);
    pointer = e.pointerId;
    start = point(e);
    canvas.setPointerCapture?.(pointer);
    overlay.style.display = 'block';
  }
  function move(e) {
    if (e.pointerId !== pointer) return;
    swallow(e);
    const p = point(e);
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
    if (e.pointerId !== pointer) return;
    swallow(e);
    const end = point(e);
    let selected = [];
    try {
      selected = selectScreenPoints(getPoints(), start, end, mode);
    } finally {
      dispose();
    }
    onSelect(selected);
  }
  function cancel(e) {
    if (pointer === null || e.pointerId === pointer) {
      e.preventDefault?.();
      dispose();
    }
  }
  function key(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      dispose();
    }
  }
  function dispose() {
    if (done) return;
    done = true;
    controller.enableInputs = prior;
    overlay.remove();
    canvas.removeEventListener('pointerdown', down, true);
    canvas.removeEventListener('pointermove', move, true);
    canvas.removeEventListener('pointerup', up, true);
    canvas.removeEventListener('pointercancel', cancel, true);
    doc.removeEventListener('keydown', key, true);
  }
  canvas.addEventListener('pointerdown', down, true);
  canvas.addEventListener('pointermove', move, true);
  canvas.addEventListener('pointerup', up, true);
  canvas.addEventListener('pointercancel', cancel, true);
  doc.addEventListener('keydown', key, true);
  return dispose;
}

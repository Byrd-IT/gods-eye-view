/**
 * Sky view Canvas overlay (P1 part): cardinal labels and 8-point ticks on the
 * horizon, an optional alt/az grid, a compass strip at the bottom, and the
 * flat-horizon ground. All text is drawn here, never with Cesium labels
 * (noCesiumLabels.test). overlayModel() is pure (tested); drawOverlay() only
 * paints the model.
 */
import {
  fovAngles,
  normalizeAz,
  projectAzEl,
  skyGradient,
  twilightWash,
} from './skyMath.js';

export const CARDINALS = Object.freeze([
  ['N', 0],
  ['NE', 45],
  ['E', 90],
  ['SE', 135],
  ['S', 180],
  ['SW', 225],
  ['W', 270],
  ['NW', 315],
]);
export const GRID_EL_STEP = 15;
export const GRID_AZ_STEP = 30;

const onCanvas = (p, width, height, margin = 40) =>
  p &&
  p.x >= -margin &&
  p.x <= width + margin &&
  p.y >= -margin &&
  p.y <= height + margin;

/** Signed smallest difference a - b in degrees, in (-180, 180]. */
export function azDelta(a, b) {
  let d = normalizeAz(a) - normalizeAz(b);
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Polyline of projected points along a curve, split where it leaves the view. */
function curve(points, view, width, height) {
  const runs = [];
  let run = [];
  for (const [az, el] of points) {
    const p = projectAzEl(az, el, view, width, height);
    if (p && Math.abs(p.x) < width * 20 && Math.abs(p.y) < height * 20)
      run.push(p);
    else {
      if (run.length > 1) runs.push(run);
      run = [];
    }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

/**
 * What to draw, in canvas pixels. Pure.
 * @returns {{horizon: Array, ground: ?Array, cardinals: Array, grid: Array,
 *   compass: Array, gradient: ?object}}
 */
export function overlayModel({
  view,
  width,
  height,
  grid = false,
  flatHorizon = false,
  sunAltDeg = null,
}) {
  const span = [];
  for (let d = -89; d <= 89; d += 1) span.push([view.azDeg + d, 0]);
  const horizonRuns = curve(span, view, width, height);
  const horizon = horizonRuns[0] || [];

  let ground = null;
  if (flatHorizon && horizon.length > 1) {
    // Close the horizon line down to the bottom of the canvas (it is a straight
    // line in a rectilinear view, so extend it past both sides first).
    const a = horizon[0];
    const b = horizon.at(-1);
    const far = Math.max(width, height) * 30;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const left = { x: a.x - (dx / len) * far, y: a.y - (dy / len) * far };
    const right = { x: b.x + (dx / len) * far, y: b.y + (dy / len) * far };
    ground = [
      left,
      ...horizon,
      right,
      { x: right.x, y: height + far },
      { x: left.x, y: height + far },
    ];
  }

  const cardinals = [];
  for (const [label, az] of CARDINALS) {
    const p = projectAzEl(az, 0, view, width, height);
    if (onCanvas(p, width, height, 0))
      cardinals.push({
        label,
        azDeg: az,
        x: p.x,
        y: p.y,
        major: label.length === 1,
      });
  }

  const lines = [];
  if (grid) {
    for (let el = GRID_EL_STEP; el < 90; el += GRID_EL_STEP) {
      const pts = [];
      for (let az = 0; az <= 360; az += 2) pts.push([az, el]);
      for (const run of curve(pts, view, width, height))
        lines.push({ kind: 'alt', value: el, points: run });
    }
    for (let az = 0; az < 360; az += GRID_AZ_STEP) {
      const pts = [];
      for (let el = 0; el <= 88; el += 2) pts.push([az, el]);
      for (const run of curve(pts, view, width, height))
        lines.push({ kind: 'az', value: az, points: run });
    }
  }

  // Compass strip: linear in azimuth across the horizontal fov.
  const { horizontalDeg } = fovAngles(view.fovDeg, width, height);
  const step = horizontalDeg > 60 ? 15 : horizontalDeg > 20 ? 5 : 1;
  const compass = [];
  const half = horizontalDeg / 2;
  const first = Math.ceil((view.azDeg - half) / step) * step;
  for (let az = first; az <= view.azDeg + half + 1e-9; az += step) {
    const x = width / 2 + (azDelta(az, view.azDeg) / horizontalDeg) * width;
    const a = normalizeAz(az);
    const cardinal = CARDINALS.find(([, value]) => Math.abs(value - a) < 1e-9);
    compass.push({
      azDeg: a,
      x,
      label: cardinal
        ? cardinal[0]
        : a % (step * 2) === 0
          ? String(Math.round(a))
          : '',
    });
  }

  return {
    horizon,
    ground,
    cardinals,
    grid: lines,
    compass,
    // Flat mode: our own sky until nautical twilight ends (then the skybox).
    // Real mode: Cesium's atmosphere plus a twilight wash (P1 spike).
    gradient:
      flatHorizon && Number.isFinite(sunAltDeg) && sunAltDeg > -12
        ? { alpha: 0.92, ...skyGradient(sunAltDeg) }
        : null,
    wash: flatHorizon ? null : twilightWash(sunAltDeg),
  };
}

/** Paint a model onto a 2-D context sized width x height (CSS pixels). */
export function drawOverlay(ctx, model, { width, height }) {
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  const sky = model.gradient || model.wash;
  if (sky && sky.alpha > 0) {
    // From the horizon (or the bottom edge when it is below the view) up.
    const yH = model.horizon.length
      ? Math.min(height, Math.max(...model.horizon.map((p) => p.y)))
      : height;
    const top = Math.min(0, yH - height * 2);
    const g = ctx.createLinearGradient(0, yH, 0, top);
    g.addColorStop(0, sky.horizon);
    g.addColorStop(1, sky.zenith);
    ctx.globalAlpha = sky.alpha;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, Math.max(0, yH));
    ctx.globalAlpha = 1;
  }
  if (model.ground) {
    ctx.beginPath();
    model.ground.forEach((p, i) =>
      i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y),
    );
    ctx.closePath();
    ctx.fillStyle = 'rgba(8, 12, 10, 0.96)';
    ctx.fill();
  }
  if (model.horizon.length > 1) {
    ctx.beginPath();
    model.horizon.forEach((p, i) =>
      i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y),
    );
    ctx.strokeStyle = model.gradient
      ? model.gradient.horizon
      : 'rgba(170, 220, 255, 0.45)';
    ctx.lineWidth = model.ground ? 2 : 1;
    ctx.stroke();
  }
  if (model.grid.length) {
    ctx.strokeStyle = 'rgba(120, 190, 255, 0.28)';
    ctx.lineWidth = 1;
    for (const line of model.grid) {
      ctx.beginPath();
      line.points.forEach((p, i) =>
        i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y),
      );
      ctx.stroke();
    }
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (const c of model.cardinals) {
    ctx.font = c.major
      ? '600 16px system-ui, sans-serif'
      : '500 12px system-ui, sans-serif';
    ctx.fillStyle =
      c.label === 'N'
        ? 'rgba(255, 120, 110, 0.95)'
        : 'rgba(230, 240, 255, 0.92)';
    ctx.strokeStyle = 'rgba(230, 240, 255, 0.8)';
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(c.x, c.y - (c.major ? 12 : 7));
    ctx.stroke();
    ctx.fillText(c.label, c.x, c.y - (c.major ? 14 : 9));
  }
  // compass strip
  const y = height - 18;
  ctx.fillStyle = 'rgba(4, 10, 18, 0.55)';
  ctx.fillRect(0, y - 16, width, 30);
  ctx.textBaseline = 'middle';
  ctx.font = '500 11px system-ui, sans-serif';
  for (const tick of model.compass) {
    ctx.strokeStyle = 'rgba(200, 225, 255, 0.7)';
    ctx.beginPath();
    ctx.moveTo(tick.x, y - 16);
    ctx.lineTo(tick.x, y - (tick.label ? 10 : 12));
    ctx.stroke();
    if (tick.label) {
      ctx.fillStyle =
        tick.label === 'N'
          ? 'rgba(255, 120, 110, 0.95)'
          : 'rgba(220, 235, 255, 0.9)';
      ctx.fillText(tick.label, tick.x, y + 2);
    }
  }
  ctx.strokeStyle = 'rgba(255, 210, 120, 0.9)';
  ctx.beginPath();
  ctx.moveTo(width / 2, y - 16);
  ctx.lineTo(width / 2, y + 12);
  ctx.stroke();
  ctx.restore();
}

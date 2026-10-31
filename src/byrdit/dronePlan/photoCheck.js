/**
 * Photo check after a flight: where each photo was really taken, against the
 * planned photo points.
 *
 * Pure maths, no DOM and no network. Inputs are the photos' own metadata
 * (photoExif.readPhotoMeta) and the planned result(s) of the panel.
 *
 * - plannedPhotoPoints(): every place the plan takes a photo.
 * - analyzePhotos(): which planned points have a photo near them, which
 *   photos are off the plan, spacing gaps in the flown order, and the ground
 *   sample distance measured from each photo's own EXIF.
 *
 * GSD: pixel size on the ground = height above ground / focal length in
 * pixels. The focal length in pixels is the camera's own CalibratedFocalLength
 * (DJI XMP) when it has one, otherwise 35 mm-equivalent focal / 36 times the
 * long side of the image. Checked on the Mini 5 Pro against the focal length
 * OpenDroneMap refined from the same 622 photos: 0.665 of the long side
 * (refined) against 0.667 (EXIF 24 mm / 36), 0.3 % apart.
 */
import { makeFrame } from './geo.js';

/** Photos beyond this are not read (a flight is a few hundred to a few thousand). */
export const MAX_PHOTOS = 5000;
/** Match distance limits, metres. */
export const MIN_MATCH_M = 2;
export const MAX_MATCH_M = 100;
/** A spacing gap is a pair this many times the usual spacing. */
export const GAP_FACTOR = 1.6;
/** A pause this many times the usual time between photos is a break, not a gap. */
export const BREAK_TIME_FACTOR = 4;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

const median = (values) => {
  const v = values.filter(finite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

/**
 * Every planned photo place of a plan, in flying order.
 * An all-passes plan (`suite`) wins over the single result; every planned pass
 * counts, hidden ones too. Interval legs take a photo every `photoSpacingM`
 * along the leg (the waypoints only steer); waypoint legs take one at each
 * waypoint with `photo` set.
 * @returns {{ lon, lat, aglM, relHeightM: number|null, pitchDeg: number|null,
 *   mission: number, leg: number, pass: string }[]}
 */
export function plannedPhotoPoints({ suite = null, result = null } = {}) {
  const results = suite?.passes
    ? suite.passes
        .filter((p) => p.result)
        .map((p) => ({ id: String(p.id ?? p.label ?? ''), result: p.result }))
    : result
      ? [{ id: '', result }]
      : [];
  const out = [];
  for (const { id, result: res } of results) {
    for (const mission of res.missions ?? []) {
      for (const leg of mission.legs ?? []) {
        const wps = leg.waypoints ?? [];
        if (leg.photoMode === 'interval') {
          for (const p of intervalPoints(wps, leg.photoSpacingM).slice(
            leg.continued ? 1 : 0,
          )) {
            out.push({
              ...p,
              pitchDeg: finite(leg.pitchDeg) ? leg.pitchDeg : null,
              mission: mission.index ?? 0,
              leg: leg.id ?? 0,
              pass: id,
            });
          }
        } else {
          for (const w of wps) {
            if (!w.photo || !finite(w.lon) || !finite(w.lat)) continue;
            out.push({
              lon: w.lon,
              lat: w.lat,
              aglM: finite(w.aglM) ? w.aglM : null,
              relHeightM: finite(w.relHeightM) ? w.relHeightM : null,
              pitchDeg: finite(w.pitchDeg) ? w.pitchDeg : null,
              mission: mission.index ?? 0,
              leg: leg.id ?? 0,
              pass: id,
            });
          }
        }
      }
    }
  }
  return out;
}

/** Points every `stepM` along a polyline of waypoints, starting at the first. */
function intervalPoints(wps, stepM) {
  const pts = wps.filter((w) => finite(w.lon) && finite(w.lat));
  if (pts.length < 1 || !finite(stepM) || stepM <= 0) return [];
  const frame = makeFrame(pts[0].lon, pts[0].lat);
  const xy = pts.map((w) => ({ ...frame.toXY(w.lon, w.lat), w }));
  const out = [];
  const emit = (x, y, a, b, t) => {
    const ll = frame.toLonLat(x, y);
    const lerp = (k) =>
      finite(a[k]) && finite(b[k]) ? a[k] + (b[k] - a[k]) * t : (a[k] ?? null);
    out.push({
      lon: ll.lon,
      lat: ll.lat,
      aglM: lerp('aglM'),
      relHeightM: lerp('relHeightM'),
    });
  };
  emit(xy[0].x, xy[0].y, xy[0].w, xy[0].w, 0);
  let carry = 0; // distance already covered since the last photo
  for (let i = 1; i < xy.length; i += 1) {
    const a = xy[i - 1];
    const b = xy[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let at = stepM - carry;
    while (at <= len + 1e-9) {
      const t = len ? at / len : 0;
      emit(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.w, b.w, t);
      at += stepM;
    }
    carry = len - (at - stepM);
    if (carry < 0) carry = 0;
  }
  return out;
}

/** The camera's focal length in pixels, from the photo's own metadata. */
export function focalPx(photo) {
  if (finite(photo.calibratedFocalPx) && photo.calibratedFocalPx > 0)
    return photo.calibratedFocalPx;
  if (
    finite(photo.focal35Mm) &&
    photo.focal35Mm > 0 &&
    finite(photo.widthPx) &&
    finite(photo.heightPx)
  )
    return (photo.focal35Mm / 36) * Math.max(photo.widthPx, photo.heightPx);
  return null;
}

/**
 * Ground sample distance and footprint of one photo at `heightM` above the
 * ground. Straight down only: for a tilted photo the figure is the one at the
 * centre of a nadir photo from the same height, so it is a floor.
 * @returns {{ gsdCm: number, acrossM: number, alongM: number } | null}
 */
export function photoGsd(photo, heightM) {
  const f = focalPx(photo);
  if (!f || !finite(heightM) || heightM <= 0) return null;
  const long = Math.max(photo.widthPx, photo.heightPx);
  const short = Math.min(photo.widthPx, photo.heightPx);
  return {
    gsdCm: (heightM / f) * 100,
    acrossM: (heightM / f) * long,
    alongM: (heightM / f) * short,
  };
}

/** Photos that are the same shot (a copied file): same time and place. */
export function dedupePhotos(photos) {
  const seen = new Set();
  const out = [];
  for (const p of photos) {
    const key = `${p.timeMs ?? p.timeText}|${p.lat.toFixed(7)}|${p.lon.toFixed(7)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return { photos: out, duplicates: photos.length - out.length };
}

/**
 * The match distance to use when the user has not set one: a third of the
 * usual distance between neighbouring planned photos, kept within 5-25 m.
 * (DJI Fly cuts corners and GPS is a few metres out, so exact is too tight.)
 */
export function defaultMatchM(planned) {
  const gaps = nearestNeighbourM(planned);
  const m = median(gaps);
  if (m == null) return 10;
  return Math.round(Math.min(25, Math.max(5, m / 3)));
}

function nearestNeighbourM(points) {
  if (points.length < 2) return [];
  const frame = makeFrame(points[0].lon, points[0].lat);
  const xy = points.map((p) => frame.toXY(p.lon, p.lat));
  const index = gridIndex(xy, 60);
  return xy.map((p, i) => {
    let best = Infinity;
    for (const j of index.near(p.x, p.y, 1)) {
      if (j === i) continue;
      best = Math.min(best, Math.hypot(xy[j].x - p.x, xy[j].y - p.y));
    }
    return Number.isFinite(best) ? best : null;
  });
}

/** A hash grid so 5000 x 12000 distance checks stay fast. */
function gridIndex(xy, cellM) {
  const cells = new Map();
  const key = (cx, cy) => `${cx},${cy}`;
  xy.forEach((p, i) => {
    const k = key(Math.floor(p.x / cellM), Math.floor(p.y / cellM));
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(i);
  });
  return {
    near(x, y, rings) {
      const cx = Math.floor(x / cellM);
      const cy = Math.floor(y / cellM);
      const out = [];
      for (let dx = -rings; dx <= rings; dx += 1)
        for (let dy = -rings; dy <= rings; dy += 1) {
          const list = cells.get(key(cx + dx, cy + dy));
          if (list) out.push(...list);
        }
      return out;
    },
  };
}

/**
 * @param {object[]} rawPhotos from readPhotoMeta
 * @param {object[]} planned from plannedPhotoPoints (may be empty)
 * @param {{ matchM?: number }} [opts]
 */
export function analyzePhotos(rawPhotos, planned = [], opts = {}) {
  const { photos: unique, duplicates } = dedupePhotos(
    rawPhotos.slice(0, MAX_PHOTOS),
  );
  const photos = unique.slice().sort((a, b) => {
    const ta = a.timeMs ?? Infinity;
    const tb = b.timeMs ?? Infinity;
    return ta - tb || a.name.localeCompare(b.name);
  });
  const matchM = Math.min(
    MAX_MATCH_M,
    Math.max(
      MIN_MATCH_M,
      finite(opts.matchM) ? opts.matchM : defaultMatchM(planned),
    ),
  );
  const empty = {
    photos: [],
    planned: [],
    gaps: [],
    breaks: [],
    summary: null,
    matchM,
    duplicates,
  };
  if (!photos.length) return empty;

  const origin = photos[0];
  const frame = makeFrame(origin.lon, origin.lat);
  const pxy = photos.map((p) => frame.toXY(p.lon, p.lat));
  const lxy = planned.map((p) => frame.toXY(p.lon, p.lat));
  const photoIndex = gridIndex(pxy, Math.max(matchM, 20));
  const planIndex = gridIndex(lxy, Math.max(matchM, 20));

  // Each planned point: the nearest photo, and whether it is near enough.
  const reach = Math.ceil(matchM / Math.max(matchM, 20));
  const plannedOut = planned.map((p, i) => {
    let best = null;
    let bestD = Infinity;
    for (const j of photoIndex.near(lxy[i].x, lxy[i].y, reach)) {
      const d = Math.hypot(pxy[j].x - lxy[i].x, pxy[j].y - lxy[i].y);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    return {
      ...p,
      covered: best != null && bestD <= matchM,
      photo: best != null && bestD <= matchM ? best : null,
      offsetM: best != null && bestD <= matchM ? bestD : null,
    };
  });

  // Each photo: the nearest planned point (if planned points were given).
  const photosOut = photos.map((p, i) => {
    let near = null;
    let nearD = Infinity;
    for (const j of planIndex.near(pxy[i].x, pxy[i].y, reach)) {
      const d = Math.hypot(lxy[j].x - pxy[i].x, lxy[j].y - pxy[i].y);
      if (d < nearD) {
        nearD = d;
        near = j;
      }
    }
    const onPlan = near != null && nearD <= matchM;
    // Height above ground: the planned height above ground at the matched
    // point, corrected by how much higher or lower the aircraft really was
    // (both heights are above the takeoff point). Without a match or terrain,
    // the height above the takeoff point is all there is.
    let heightM = null;
    let heightBasis = null;
    const m = onPlan ? planned[near] : null;
    if (m && finite(m.aglM) && finite(m.relHeightM) && finite(p.relAltM)) {
      heightM = m.aglM + (p.relAltM - m.relHeightM);
      heightBasis = 'plan';
    } else if (finite(p.relAltM)) {
      heightM = p.relAltM;
      heightBasis = 'takeoff';
    }
    const gsd = photoGsd(p, heightM);
    return {
      ...p,
      onPlan,
      planIndex: onPlan ? near : null,
      offsetM: onPlan ? nearD : null,
      heightM,
      heightBasis,
      gsdCm: gsd?.gsdCm ?? null,
      acrossM: gsd?.acrossM ?? null,
      alongM: gsd?.alongM ?? null,
    };
  });

  // Spacing gaps in the flown (time) order.
  const steps = [];
  for (let i = 1; i < photos.length; i += 1) {
    const dt =
      finite(photos[i].timeMs) && finite(photos[i - 1].timeMs)
        ? photos[i].timeMs - photos[i - 1].timeMs
        : null;
    steps.push({
      from: i - 1,
      to: i,
      distM: Math.hypot(pxy[i].x - pxy[i - 1].x, pxy[i].y - pxy[i - 1].y),
      dtS: dt == null ? null : dt / 1000,
    });
  }
  const usualM = median(steps.map((s) => s.distM).filter((d) => d > 0.5));
  const usualS = median(
    steps.map((s) => s.dtS).filter((d) => d != null && d > 0),
  );
  const gaps = [];
  const breaks = [];
  for (const s of steps) {
    if (usualM == null || s.distM < usualM * GAP_FACTOR) continue;
    if (s.dtS != null && usualS != null && s.dtS > usualS * BREAK_TIME_FACTOR)
      breaks.push(s);
    else gaps.push(s);
  }

  const covered = plannedOut.filter((p) => p.covered).length;
  const offsets = photosOut.filter((p) => p.onPlan).map((p) => p.offsetM);
  const gsds = photosOut.map((p) => p.gsdCm).filter(finite);
  const heights = photosOut.map((p) => p.heightM).filter(finite);
  const times = photos.map((p) => p.timeMs).filter(finite);
  const summary = {
    photoCount: photos.length,
    plannedCount: planned.length,
    coveredCount: covered,
    missingCount: planned.length - covered,
    offPlanCount: planned.length
      ? photosOut.filter((p) => !p.onPlan).length
      : 0,
    medianOffsetM: median(offsets),
    maxOffsetM: offsets.length ? Math.max(...offsets) : null,
    gapCount: gaps.length,
    breakCount: breaks.length,
    usualSpacingM: usualM,
    usualIntervalS: usualS,
    gsdMinCm: gsds.length ? Math.min(...gsds) : null,
    gsdMedianCm: median(gsds),
    gsdMaxCm: gsds.length ? Math.max(...gsds) : null,
    heightMedianM: median(heights),
    gsdFromPlan: photosOut.filter((p) => p.heightBasis === 'plan').length,
    gsdFromTakeoff: photosOut.filter((p) => p.heightBasis === 'takeoff').length,
    gsdMissing: photosOut.filter((p) => p.gsdCm == null).length,
    firstTimeMs: times.length ? Math.min(...times) : null,
    lastTimeMs: times.length ? Math.max(...times) : null,
  };
  return {
    photos: photosOut,
    planned: plannedOut,
    gaps,
    breaks,
    summary,
    matchM,
    duplicates,
  };
}

/** The check as CSV: one row per photo then one per planned point. Numbers only. */
export function reportCsv(analysis) {
  const rows = ['kind,name,lat,lon,height_m,gsd_cm,offset_m,status'];
  const num = (v, d = 2) => (finite(v) ? v.toFixed(d) : '');
  const cell = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  for (const p of analysis.photos)
    rows.push(
      [
        'photo',
        cell(/^[=+\-@\t\r]/.test(p.name) ? `'${p.name}` : p.name),
        num(p.lat, 7),
        num(p.lon, 7),
        num(p.heightM, 1),
        num(p.gsdCm, 2),
        num(p.offsetM, 1),
        analysis.planned.length ? (p.onPlan ? 'on-plan' : 'off-plan') : '',
      ].join(','),
    );
  analysis.planned.forEach((p, i) =>
    rows.push(
      [
        'planned',
        cell(`point ${i + 1}`),
        num(p.lat, 7),
        num(p.lon, 7),
        num(p.aglM, 1),
        '',
        num(p.offsetM, 1),
        p.covered ? 'covered' : 'missing',
      ].join(','),
    ),
  );
  return rows.join('\n');
}

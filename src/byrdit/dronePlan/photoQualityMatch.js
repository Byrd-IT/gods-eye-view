/**
 * One-to-one match of flown photos to planned photo shots.
 *
 * Pure: no DOM and no network. The saved gevplan document does not hold
 * planned waypoints (see planDoc.js); pass the rebuilt result or suite, the
 * same sources photoCheck.plannedPhotoPoints reads.
 */
import { makeFrame } from './geo.js';
import { splitOutwardShots } from './shotWaypoints.js';

/** A photo farther than this is not the planned shot. Metres. */
export const MATCH_PROXIMITY_M = 1.5;
/** Shots at least this close are the same stop, so position cannot tell them apart. */
export const COLOCATED_M = 0.5;
/** Planned pitches farther apart than this can be told apart. Degrees. */
export const PITCH_TOL_DEG = 5;
/** Planned headings farther apart than this can be told apart. Degrees. */
export const HEADING_TOL_DEG = 15;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

const AXES = Object.freeze([
  {
    shot: 'pitchDeg',
    photo: 'gimbalPitchDeg',
    tol: PITCH_TOL_DEG,
    wrap: false,
  },
  {
    shot: 'headingDeg',
    photo: 'gimbalYawDeg',
    tol: HEADING_TOL_DEG,
    wrap: true,
  },
]);

function angleDiff(a, b, wrap) {
  if (!wrap) return Math.abs(a - b);
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function clustersOf(indexes, shotXY) {
  const parent = new Map(indexes.map((i) => [i, i]));
  const find = (i) => {
    let at = i;
    while (parent.get(at) !== at) {
      parent.set(at, parent.get(parent.get(at)));
      at = parent.get(at);
    }
    return at;
  };
  for (let a = 0; a < indexes.length; a += 1) {
    for (let b = a + 1; b < indexes.length; b += 1) {
      const ia = indexes[a];
      const ib = indexes[b];
      const d = Math.hypot(
        shotXY[ia].x - shotXY[ib].x,
        shotXY[ia].y - shotXY[ib].y,
      );
      if (d <= COLOCATED_M) parent.set(find(ia), find(ib));
    }
  }
  const groups = new Map();
  for (const i of indexes) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }
  return [...groups.values()];
}

function separatingAxes(indexes, planned) {
  return AXES.filter((axis) => {
    for (let a = 0; a < indexes.length; a += 1) {
      for (let b = a + 1; b < indexes.length; b += 1) {
        const left = planned[indexes[a]][axis.shot];
        const right = planned[indexes[b]][axis.shot];
        if (
          finite(left) &&
          finite(right) &&
          angleDiff(left, right, axis.wrap) > axis.tol
        )
          return true;
      }
    }
    return false;
  });
}

/** true / false / null. null means one side has no number — never treated as 0. */
function agreesOn(photo, shot, axis) {
  const photoValue = photo[axis.photo];
  const shotValue = shot[axis.shot];
  if (!finite(photoValue) || !finite(shotValue)) return null;
  return angleDiff(photoValue, shotValue, axis.wrap) <= axis.tol;
}

function incompleteAxes(indexes, planned) {
  return AXES.filter((axis) => {
    let hasFinite = false;
    let hasNull = false;
    for (const index of indexes) {
      if (finite(planned[index][axis.shot])) hasFinite = true;
      else hasNull = true;
    }
    return hasFinite && hasNull;
  });
}

function attitudeLabel(photo, shot) {
  const pitch = agreesOn(photo, shot, AXES[0]);
  const heading = agreesOn(photo, shot, AXES[1]);
  if (pitch === false || heading === false) return 'disagreed';
  if (pitch == null || heading == null) return 'unknown';
  return 'agreed';
}

/**
 * Position edges within 1.5 m. Co-located shots whose planned pitch or heading
 * differ are kept only when the photo agrees with exactly one of them. A null
 * angle is never read as 0. When that null is what would decide the shot, the
 * pair is blocked as unknown instead of guessed.
 */
function selectPairs(list, planned, photoXY, shotXY) {
  const byPhoto = Array.from({ length: list.length }, () => []);
  planned.forEach((_, i) => {
    if (!shotXY[i]) return;
    list.forEach((__, j) => {
      if (!photoXY[j]) return;
      const d = Math.hypot(
        photoXY[j].x - shotXY[i].x,
        photoXY[j].y - shotXY[i].y,
      );
      if (d <= MATCH_PROXIMITY_M) byPhoto[j].push({ d, i, j });
    });
  });
  const kept = [];
  const blocks = [];
  for (let j = 0; j < list.length; j += 1) {
    const cands = byPhoto[j];
    if (!cands.length) continue;
    const groups = clustersOf(
      cands.map((edge) => edge.i),
      shotXY,
    );
    for (const group of groups) {
      const edges = cands.filter((edge) => group.includes(edge.i));
      const separating = group.length > 1 ? separatingAxes(group, planned) : [];
      const incomplete = group.length > 1 ? incompleteAxes(group, planned) : [];
      if (!separating.length && !incomplete.length) {
        kept.push(...edges);
        continue;
      }
      const needed = [...separating, ...incomplete];
      const unknownShots = [];
      const eligible = [];
      for (const edge of edges) {
        const shot = planned[edge.i];
        const agreements = needed.map((axis) => agreesOn(list[j], shot, axis));
        // A known disagreement excludes a shot even when another axis is missing.
        if (agreements.includes(false)) continue;
        if (agreements.includes(null)) unknownShots.push(edge.i);
        else eligible.push(edge);
      }
      // Uniqueness is determined jointly across axes, not independently on
      // each axis. An unknown candidate can still be the intended shot.
      if (eligible.length === 1 && unknownShots.length === 0) kept.push(eligible[0]);
      else if (unknownShots.length || eligible.length > 1)
        blocks.push({
          photoIndex: j,
          shotIndexes: [...unknownShots, ...eligible.map((edge) => edge.i)],
          reason: 'attitude-unknown',
        });
    }
  }
  return {
    pairs: kept.map((edge) => [edge.d, edge.i, edge.j]),
    blocks,
  };
}

/**
 * Maximum-cardinality one-to-one assignment. Closest pairs are tried first,
 * then augmenting paths recover a shot the greedy pass would leave bare.
 * @param {Array<[number, number, number]>} pairs [distanceM, shotIndex, photoIndex]
 */
function maximumMatch(pairs, shotCount, photoCount) {
  const photoEdges = Array.from({ length: photoCount }, () => []);
  const distOf = new Map();
  for (const [d, i, j] of pairs) {
    photoEdges[j].push(i);
    const key = `${i},${j}`;
    const prev = distOf.get(key);
    if (prev == null || d < prev) distOf.set(key, d);
  }
  for (let j = 0; j < photoCount; j += 1) {
    photoEdges[j].sort(
      (a, b) => distOf.get(`${a},${j}`) - distOf.get(`${b},${j}`) || a - b,
    );
  }
  const photoOfShot = new Array(shotCount).fill(-1);
  const shotOfPhoto = new Array(photoCount).fill(-1);
  const sorted = pairs
    .slice()
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  for (const [, i, j] of sorted) {
    if (photoOfShot[i] === -1 && shotOfPhoto[j] === -1) {
      photoOfShot[i] = j;
      shotOfPhoto[j] = i;
    }
  }
  const dfs = (photo, seen) => {
    for (const i of photoEdges[photo]) {
      if (seen[i]) continue;
      seen[i] = true;
      const cur = photoOfShot[i];
      if (cur === -1 || dfs(cur, seen)) {
        photoOfShot[i] = photo;
        shotOfPhoto[photo] = i;
        return true;
      }
    }
    return false;
  };
  for (let j = 0; j < photoCount; j += 1) {
    if (shotOfPhoto[j] !== -1) continue;
    dfs(j, new Array(shotCount).fill(false));
  }
  const taken = new Map();
  for (let i = 0; i < shotCount; i += 1) {
    const j = photoOfShot[i];
    if (j !== -1) taken.set(i, { j, d: distOf.get(`${i},${j}`) });
  }
  return taken;
}

function shotKey(shot, index) {
  return [
    `p${shot.pass ?? ''}`,
    `m${shot.mission ?? 0}`,
    `l${shot.leg ?? 0}`,
    `w${shot.waypointId ?? 'x'}`,
    shot.shot ?? '-',
    String(index),
  ].join('|');
}

/**
 * @param {object[]} photos readPhotoMeta photos, caller order (indexes kept)
 * @param {object[]} shots planned shots with lon/lat and identity
 */
export function matchPhotosToShots(photos = [], shots = []) {
  const list = Array.isArray(photos) ? photos : [];
  const planned = Array.isArray(shots) ? shots : [];
  const origin = planned.find((s) => finite(s?.lon) && finite(s?.lat)) ??
    list.find((p) => finite(p?.lon) && finite(p?.lat)) ?? { lon: 0, lat: 0 };
  const frame = makeFrame(origin.lon, origin.lat);
  const shotXY = planned.map((s) =>
    finite(s?.lon) && finite(s?.lat) ? frame.toXY(s.lon, s.lat) : null,
  );
  const photoXY = list.map((p) =>
    finite(p?.lon) && finite(p?.lat) ? frame.toXY(p.lon, p.lat) : null,
  );
  const { pairs, blocks } = selectPairs(list, planned, photoXY, shotXY);
  const takenShot = maximumMatch(pairs, planned.length, list.length);
  const unknownShot = new Map();
  for (const block of blocks) {
    for (const index of block.shotIndexes) {
      if (!takenShot.has(index) && !unknownShot.has(index))
        unknownShot.set(index, block.reason);
    }
  }
  const shotRows = planned.map((shot, index) => {
    const hit = takenShot.get(index);
    const blocked = unknownShot.get(index);
    const status = hit ? 'matched' : blocked ? 'unknown' : 'missing';
    const photo = hit ? list[hit.j] : null;
    return {
      key: shotKey(shot, index),
      index,
      waypointId: shot.waypointId ?? null,
      shot: shot.shot ?? null,
      mission: shot.mission ?? 0,
      leg: shot.leg ?? 0,
      pass: shot.pass ?? '',
      photoMode: shot.photoMode ?? 'waypoint',
      intervalIndex: Number.isInteger(shot.intervalIndex)
        ? shot.intervalIndex
        : null,
      lon: shot.lon,
      lat: shot.lat,
      pitchDeg: finite(shot.pitchDeg) ? shot.pitchDeg : null,
      headingDeg: finite(shot.headingDeg) ? shot.headingDeg : null,
      status,
      reason: blocked && !hit ? blocked : null,
      photoIndex: hit ? hit.j : null,
      photoName: photo ? (photo.name ?? null) : null,
      offsetM: hit ? hit.d : null,
      attitude: hit ? attitudeLabel(photo, shot) : null,
    };
  });
  const matches = shotRows
    .filter((s) => s.status === 'matched')
    .map((s) => ({
      shotKey: s.key,
      photoIndex: s.photoIndex,
      photoName: s.photoName,
      waypointId: s.waypointId,
      shot: s.shot,
      mission: s.mission,
      leg: s.leg,
      pass: s.pass,
      offsetM: s.offsetM,
      attitude: s.attitude,
    }));
  const missing = shotRows.filter((s) => s.status === 'missing');
  const unknown = [];
  for (const row of shotRows) {
    if (row.status !== 'unknown') continue;
    unknown.push({
      kind: 'shot',
      reason: row.reason,
      shotKey: row.key,
      waypointId: row.waypointId,
      shot: row.shot,
      mission: row.mission,
      leg: row.leg,
      pass: row.pass,
    });
  }
  const matchedPhotos = new Set(matches.map((m) => m.photoIndex));
  const unknownPhotoIndexes = new Set(
    blocks
      .filter((block) => !matchedPhotos.has(block.photoIndex))
      .map((block) => block.photoIndex),
  );
  // Existing extra captures are not instructions to re-fly a waypoint.
  const retakes = [];
  const extraPhotos = [];
  const unmatchedPhotos = [];
  list.forEach((photo, photoIndex) => {
    if (matchedPhotos.has(photoIndex) || unknownPhotoIndexes.has(photoIndex))
      return;
    if (!photoXY[photoIndex]) {
      unmatchedPhotos.push({
        photoIndex,
        photoName: photo?.name ?? null,
        reason: 'no-position',
      });
      return;
    }
    let nearest = null;
    shotRows.forEach((row, shotIndex) => {
      if (row.status !== 'matched' || !shotXY[shotIndex]) return;
      const offsetM = Math.hypot(
        photoXY[photoIndex].x - shotXY[shotIndex].x,
        photoXY[photoIndex].y - shotXY[shotIndex].y,
      );
      if (offsetM > MATCH_PROXIMITY_M) return;
      if (!nearest || offsetM < nearest.offsetM) {
        nearest = { row, offsetM };
      }
    });
    if (!nearest) {
      unmatchedPhotos.push({
        photoIndex,
        photoName: photo?.name ?? null,
        reason: 'off-plan',
      });
      return;
    }
    extraPhotos.push({
      photoIndex,
      photoName: photo?.name ?? null,
      offsetM: nearest.offsetM,
      shotKey: nearest.row.key,
      waypointId: nearest.row.waypointId,
      shot: nearest.row.shot,
      mission: nearest.row.mission,
      leg: nearest.row.leg,
      pass: nearest.row.pass,
      reason: 'extra-photo',
    });
  });
  for (const block of blocks) {
    if (matchedPhotos.has(block.photoIndex)) continue;
    if (
      unknown.some(
        (row) => row.kind === 'photo' && row.photoIndex === block.photoIndex,
      )
    )
      continue;
    const photo = list[block.photoIndex];
    unknown.push({
      kind: 'photo',
      reason: block.reason,
      photoIndex: block.photoIndex,
      photoName: photo?.name ?? null,
      candidateKeys: block.shotIndexes.map((index) => shotRows[index].key),
    });
  }
  return {
    proximityM: MATCH_PROXIMITY_M,
    shots: shotRows,
    matches,
    missing,
    retakes,
    extraPhotos,
    unmatchedPhotos,
    unknown,
    summary: {
      plannedCount: planned.length,
      matchedCount: matches.length,
      missingCount: missing.length,
      retakeCount: retakes.length,
      extraPhotoCount: extraPhotos.length,
      unknownCount: unknown.length,
    },
  };
}

/** Results the same way photoCheck.plannedPhotoPoints chooses them. */
function planResults(sources) {
  if (sources?.suite?.passes) {
    return sources.suite.passes
      .filter((pass) => pass?.result)
      .map((pass) => ({
        id: String(pass.id ?? pass.label ?? ''),
        result: pass.result,
      }));
  }
  if (sources?.result) return [{ id: '', result: sources.result }];
  return null;
}

function countImports(plan) {
  const list = plan?.plan?.imports ?? plan?.imports;
  return Array.isArray(list) ? list.length : 0;
}

/** Points every `stepM` along a polyline. Same spacing as photoCheck. */
function intervalPoints(wps, stepM) {
  const pts = wps.filter((w) => finite(w.lon) && finite(w.lat));
  if (pts.length < 1 || !finite(stepM) || stepM <= 0) return [];
  const frame = makeFrame(pts[0].lon, pts[0].lat);
  const xy = pts.map((w) => ({ ...frame.toXY(w.lon, w.lat), w }));
  const out = [];
  const emit = (x, y, a, b, t) => {
    const ll = frame.toLonLat(x, y);
    const lerp = (k) =>
      finite(a[k]) && finite(b[k])
        ? a[k] + (b[k] - a[k]) * t
        : finite(a[k])
          ? a[k]
          : null;
    out.push({
      lon: ll.lon,
      lat: ll.lat,
      aglM: lerp('aglM'),
      relHeightM: lerp('relHeightM'),
    });
  };
  emit(xy[0].x, xy[0].y, xy[0].w, xy[0].w, 0);
  let carry = 0;
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

/**
 * Planned photo shots with waypoint and shot identity.
 * A saved gevplan is not a source: it stores areas and settings, not the
 * rebuilt waypoints. Pass `result` or `suite`, as photoCheck does.
 * In/out photos that are still one waypoint are split here, so each shot has
 * its own identity.
 */
export function plannedShots(sources = {}) {
  const results = planResults(sources);
  if (!results) return [];
  const out = [];
  for (const { id, result } of results) {
    for (const mission of result.missions ?? []) {
      for (const leg of mission.legs ?? []) {
        const wps = splitOutwardShots(leg.waypoints ?? []);
        const missionIndex = mission.index ?? 0;
        const legId = leg.id ?? 0;
        if (leg.photoMode === 'interval') {
          const points = intervalPoints(wps, leg.photoSpacingM).slice(
            leg.continued ? 1 : 0,
          );
          points.forEach((point, intervalIndex) => {
            out.push({
              ...point,
              pitchDeg: finite(leg.pitchDeg) ? leg.pitchDeg : null,
              headingDeg: null,
              waypointId: null,
              shot: null,
              mission: missionIndex,
              leg: legId,
              pass: id,
              photoMode: 'interval',
              intervalIndex,
            });
          });
        } else {
          for (const w of wps) {
            if (!w.photo || !finite(w.lon) || !finite(w.lat)) continue;
            out.push({
              lon: w.lon,
              lat: w.lat,
              aglM: finite(w.aglM) ? w.aglM : null,
              relHeightM: finite(w.relHeightM) ? w.relHeightM : null,
              pitchDeg: finite(w.pitchDeg) ? w.pitchDeg : null,
              headingDeg: finite(w.headingDeg) ? w.headingDeg : null,
              waypointId: w.id == null ? null : w.id,
              shot: w.shot ?? null,
              mission: missionIndex,
              leg: legId,
              pass: id,
              photoMode: 'waypoint',
              intervalIndex: null,
            });
          }
        }
      }
    }
  }
  return out;
}

/**
 * Integration entry. Photos are readPhotoMeta records, in caller order.
 * `sources` is `{ suite, result, plan }`. `plan` is a gevplan document or a
 * `.gevplan` file object; it never supplies shot geometry. Imported drone
 * files on that document are counted and ignored.
 */
export function matchPlanPhotos(photos = [], sources = {}) {
  const importsIgnored = countImports(sources?.plan);
  if (!planResults(sources)) {
    return {
      ...matchPhotosToShots([], []),
      reason: 'plan-has-no-shots',
      importsIgnored,
    };
  }
  return {
    ...matchPhotosToShots(photos, plannedShots(sources)),
    reason: null,
    importsIgnored,
  };
}

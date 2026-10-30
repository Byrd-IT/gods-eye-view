/**
 * Several areas in one Drone Flight Plan.
 *
 * A single rectangle still goes through planFlight, so that plan does not
 * change. A polygon is clipped to its edge, expanded by half the photo
 * footprint so the edge is still covered. Overlapping areas are unioned and
 * flown once. Each area that has photos keeps its own processing job: a line
 * in the overlap is given to the first area that contains it. An area with
 * no photos of its own gets no job. Areas that do not touch stay separate
 * flight blocks. Orbit is planned around the centre of each area and is not
 * merged.
 */

import { deltaLon, groundDistanceM, makeFrame, wrapLon } from './geo.js';
import { validateDroneBox } from './limits.js';
import {
  assembleMissions,
  estimateMission,
  footprint,
  INTERVAL_WAYPOINT_STEP_M,
  MAX_MISSIONS,
  MAX_TAKEOFF_FROM_BOX_M,
  MAX_WAYPOINTS_TOTAL,
  normalizeOptions,
  planFlight,
  takeoffDistanceFromBoxM,
  VLOS_WARN_M,
} from './planner.js';
import { getPreset, DEFAULT_PRESET_ID } from './presets.js';
import {
  areaIndexForPoint,
  assignSegmentToRings,
  clipSegmentCovered,
  offsetRing,
  pointInRing,
  ringsOverlap,
  sampleSegment,
  selfIntersects,
} from './polygon.js';

const MIN_PIECE_M = 0.5;

export function rectRing(box) {
  return [
    { lon: box.west, lat: box.south },
    { lon: box.east, lat: box.south },
    { lon: box.east, lat: box.north },
    { lon: box.west, lat: box.north },
  ];
}

export function jobSlug(name) {
  const slug = String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^\.+/, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug && !/^\.+$/.test(slug) ? slug : 'area';
}

/** `job-1-North-field`. The job number keeps two similar names apart. */
export function jobFolder(job) {
  const n = String(job?.id ?? '').match(/(\d+)/)?.[1] ?? '1';
  return `job-${n}-${jobSlug(job?.name)}`;
}

function areaRing(area) {
  if (area.kind === 'polygon') return area.ring.map((p) => ({ ...p }));
  return rectRing(area.box);
}

function unwrapCenter(points) {
  const lon0 = points[0].lon;
  let lon = 0;
  let lat = 0;
  for (const p of points) {
    lon += deltaLon(lon0, p.lon);
    lat += p.lat;
  }
  return {
    lon: wrapLon(lon0 + lon / points.length),
    lat: lat / points.length,
  };
}

function bboxOfPoints(points) {
  const centre = unwrapCenter(points);
  let minD = Infinity;
  let maxD = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const p of points) {
    const d = deltaLon(centre.lon, p.lon);
    minD = Math.min(minD, d);
    maxD = Math.max(maxD, d);
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
  }
  return {
    west: wrapLon(centre.lon + minD),
    east: wrapLon(centre.lon + maxD),
    south,
    north,
  };
}

function ringXY(ring, frame) {
  return ring.map((p) => frame.toXY(p.lon, p.lat));
}

function checkArea(area, frame) {
  if (area.kind === 'polygon') {
    if (!Array.isArray(area.ring) || area.ring.length < 3) {
      return {
        error: 'bad-box',
        message: 'A polygon needs at least 3 corners',
      };
    }
    if (selfIntersects(ringXY(area.ring, frame))) {
      return {
        error: 'self-intersecting',
        message: 'That polygon crosses itself. Remove a corner or draw it again.',
      };
    }
  }
  const checked = validateDroneBox(area.box);
  if (!checked.ok) return { error: checked.reason, message: checked.message };
  return null;
}

function clusterIndices(areas, frame, margin = 0) {
  const rings = areas.map((area) => {
    const local = ringXY(areaRing(area), frame);
    if (area.kind !== 'polygon' || !(margin > 0)) return local;
    const grown = offsetRing(local, margin);
    // A crossed offset can reach far outside the area. Cluster on the real ring.
    return selfIntersects(grown) ? local : grown;
  });
  const parent = areas.map((_, i) => i);
  const find = (i) => {
    let x = i;
    while (parent[x] !== x) x = parent[x];
    return x;
  };
  for (let i = 0; i < areas.length; i += 1) {
    for (let j = i + 1; j < areas.length; j += 1) {
      if (!ringsOverlap(rings[i], rings[j])) continue;
      parent[find(j)] = find(i);
    }
  }
  const groups = new Map();
  areas.forEach((_, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  });
  return [...groups.values()];
}

function tagLegs(plan, job, blockId) {
  for (const leg of plan.legs) {
    leg.jobId = job.id;
    leg.jobName = job.name;
    leg.blockId = blockId;
    leg.areaIds = [...job.areaIds];
  }
}

function withJob(plan, areas, grouping) {
  const job = {
    id: 'job-1',
    name: grouping === 'whole' && areas.length > 1 ? 'Whole plan' : areas[0].name,
    areaIds: areas.map((area) => area.id),
    areaNames: areas.map((area) => area.name),
  };
  tagLegs(plan, job, 'block-1');
  plan.areas = areas;
  plan.jobs = [job];
  plan.jobGrouping = grouping;
  plan.blocks = [{ id: 'block-1', jobId: job.id, areaIds: job.areaIds }];
  return plan;
}

function marginM(preset, options, hasPolygon) {
  if (!hasPolygon || options.pattern === 'orbit') return 0;
  const tilt = options.pattern === 'double' ? 90 + options.tiltPitchDeg : 0;
  const fp = footprint(preset, options.aglM, tilt);
  return Math.max(fp.acrossM, fp.alongM) / 2;
}

/** Metres the camera looks ahead of the drone. Zero for a nadir grid. */
function lookAheadM(options) {
  if (options.pattern !== 'double') return 0;
  const tilt = ((90 + options.tiltPitchDeg) * Math.PI) / 180;
  const ahead = options.aglM * Math.tan(tilt);
  return Number.isFinite(ahead) && ahead > 0 ? ahead : 0;
}

/** Shift from a drone point to the point the tilted camera is aimed at. */
function travelShift(a, b, lookAhead) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(len > 1e-6) || !(lookAhead > 0)) return { x: 0, y: 0 };
  return {
    x: ((b.x - a.x) / len) * lookAhead,
    y: ((b.y - a.y) / len) * lookAhead,
  };
}

function clipSpec(area, frame, margin) {
  const local = ringXY(areaRing(area), frame);
  if (area.kind !== 'polygon' || !(margin > 0)) return local;
  const grown = offsetRing(local, margin);
  if (selfIntersects(grown)) return { ring: local, margin };
  return grown;
}

function shellRing(area, frame, margin) {
  const local = ringXY(areaRing(area), frame);
  if (area.kind !== 'polygon' || !(margin > 0)) return local;
  const grown = offsetRing(local, margin);
  if (!selfIntersects(grown)) return grown;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of local) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return [
    { x: minX - margin, y: minY - margin },
    { x: maxX + margin, y: minY - margin },
    { x: maxX + margin, y: maxY + margin },
    { x: minX - margin, y: maxY + margin },
  ];
}

/**
 * Build the flown pieces of one survey line. clipShell and splitLegsByArea
 * both shift the camera aim, drop a piece shorter than MIN_PIECE_M, and
 * sample the drone line. `keep` drops a piece before it is sampled
 * (splitLegsByArea skips an unowned piece). withIds keeps clipShell's
 * temporary waypoint ids; splitLegsByArea leaves ids for planAreas.
 * `pieces(aimA, aimB)` returns the clipped aim segments.
 */
function clipLegPieces(
  leg,
  frame,
  lookAhead,
  pieces,
  { withIds = false, keep = () => true } = {},
) {
  const a = frame.toXY(leg.waypoints[0].lon, leg.waypoints[0].lat);
  const b = frame.toXY(
    leg.waypoints[leg.waypoints.length - 1].lon,
    leg.waypoints[leg.waypoints.length - 1].lat,
  );
  const shift = travelShift(a, b, lookAhead);
  const aimA = { x: a.x + shift.x, y: a.y + shift.y };
  const aimB = { x: b.x + shift.x, y: b.y + shift.y };
  const interval = leg.photoMode === 'interval';
  const step = interval ? INTERVAL_WAYPOINT_STEP_M : leg.photoSpacingM;
  const built = [];
  for (const piece of pieces(aimA, aimB)) {
    const start = { x: piece.start.x - shift.x, y: piece.start.y - shift.y };
    const end = { x: piece.end.x - shift.x, y: piece.end.y - shift.y };
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length < MIN_PIECE_M || !keep(piece)) continue;
    const { points } = sampleSegment(start, end, step);
    const waypoints = points.map((p, id) => {
      const ll = frame.toLonLat(p.x, p.y);
      const fields = {
        lon: Number(ll.lon.toFixed(8)),
        lat: Number(ll.lat.toFixed(8)),
        aglM: leg.waypoints[0].aglM,
        pitchDeg: leg.pitchDeg,
        headingDeg: leg.waypoints[0].headingDeg,
        photo: !interval,
      };
      return withIds ? { id, ...fields } : fields;
    });
    built.push({
      piece,
      leg: {
        ...leg,
        waypoints,
        lengthM: length,
        photoCount: interval
          ? Math.floor(length / leg.photoSpacingM + 1e-9) + 1
          : waypoints.length,
      },
    });
  }
  return built;
}

function clipShell(shell, members, frame, margin, lookAhead) {
  const specs = members.map((area) => clipSpec(area, frame, margin));
  const out = [];
  for (const leg of shell.legs) {
    if (leg.kind === 'orbit' || leg.waypoints.length < 2) {
      out.push(leg);
      continue;
    }
    // A tilted camera looks ahead of the drone. Clip that aim, then fly
    // the drone lookAhead back along the same line.
    for (const { leg: built } of clipLegPieces(
      leg,
      frame,
      lookAhead,
      (aimA, aimB) => clipSegmentCovered(aimA, aimB, specs),
      { withIds: true },
    )) {
      out.push(built);
    }
  }
  let nextId = 0;
  out.forEach((leg, index) => {
    leg.id = index;
    for (const w of leg.waypoints) {
      w.id = nextId;
      nextId += 1;
    }
  });
  const waypointCount = out.reduce((sum, leg) => sum + leg.waypoints.length, 0);
  return { legs: out, waypointCount };
}

function orderingTakeoff(box, takeoff) {
  if (!takeoff || !Number.isFinite(takeoff.lon) || !Number.isFinite(takeoff.lat)) {
    return null;
  }
  if (takeoffDistanceFromBoxM(box, takeoff) > MAX_TAKEOFF_FROM_BOX_M) return null;
  return { lon: takeoff.lon, lat: takeoff.lat };
}

function reverseLegPoints(leg) {
  return { ...leg, waypoints: [...leg.waypoints].reverse() };
}

/**
 * planFlight starts a box at its own corner, ignoring the shared takeoff.
 * Turn whole survey lines so the first waypoint is the corner nearest that
 * takeoff. Call this on the shell legs before clipShell. The score uses that
 * outer-box corner, not the first point left after the clip, so a clipped
 * corner can leave the first flown point farther from the takeoff. The four
 * turns are not scored again after the clip: that did not move the start, and
 * turning the pieces after the clip flies the line backwards between them.
 * A tilted line keeps its direction: reversing its points would put the camera
 * look-ahead on the wrong end. Only the order of the lines, and of the points
 * on a nadir line, changes. Notes that depend on order are rebuilt by planAreas.
 */
function orientLegsToward(legs, takeoff, lookAhead) {
  if (!takeoff || !legs?.length) return legs;
  if (legs.some((leg) => leg.kind === 'orbit' || (leg.waypoints?.length ?? 0) < 2)) {
    return legs;
  }
  const startOf = (list) => list[0].waypoints[0];
  const away = (w) => groundDistanceM(takeoff, w);
  const flipped = lookAhead > 0 ? null : legs.map(reverseLegPoints);
  const candidates = [legs, flipped, [...legs].reverse(), flipped ? [...flipped].reverse() : null].filter(
    Boolean,
  );
  let best = legs;
  let bestD = away(startOf(legs));
  for (const list of candidates) {
    const d = away(startOf(list));
    if (d + 0.5 < bestD) {
      best = list;
      bestD = d;
    }
  }
  return best;
}

function planCluster(members, rawOptions, sharedTakeoff) {
  if (members.length === 1 && members[0].kind === 'rect') {
    const box = members[0].box;
    const forOrder = orderingTakeoff(box, sharedTakeoff);
    const planned = planFlight(box, forOrder ? { ...rawOptions, takeoff: forOrder } : rawOptions);
    if (planned.error || !planned.legs?.length || planned.legs[0].kind === 'orbit') {
      return planned;
    }
    planned.legs = orientLegsToward(
      planned.legs,
      sharedTakeoff,
      lookAheadM(planned.options ?? rawOptions),
    );
    return planned;
  }
  const points = members.flatMap((area) => areaRing(area));
  const centre = unwrapCenter(points);
  const frame = makeFrame(centre.lon, centre.lat);
  const { options } = normalizeOptions(rawOptions, bboxOfPoints(points));
  const margin = marginM(
    getPreset(options.presetId) ?? getPreset(DEFAULT_PRESET_ID),
    options,
    members.some((area) => area.kind === 'polygon'),
  );
  const expanded = members.flatMap((area) =>
    shellRing(area, frame, margin).map((p) => frame.toLonLat(p.x, p.y)),
  );
  const shellBox = bboxOfPoints(expanded);
  const expandedCheck = validateDroneBox(shellBox);
  if (!expandedCheck.ok) {
    return { error: expandedCheck.reason, message: expandedCheck.message };
  }
  // rawOptions has no takeoff. decideTakeoff strips it before the shell is
  // planned, so this shell's own takeoff is the shell-box centre.
  // orientLegsToward applies the shared takeoff after. Passing the takeoff
  // into this planFlight call can change the path.
  const shell = planFlight(shellBox, rawOptions);
  if (shell.error) return shell;
  const lookAhead = lookAheadM(options);
  // Turn the shell lines first. Clipping then keeps each line's pieces in
  // travel order. Turning the pieces afterwards can send the drone back
  // along the same line.
  // No custom takeoff: sharedTakeoff is the first area's centre, so a polygon
  // or group turns toward that point, the same as a single rectangle.
  const turned = orientLegsToward(shell.legs, sharedTakeoff, lookAhead);
  const clipped = clipShell({ ...shell, legs: turned }, members, frame, margin, lookAhead);
  if (!clipped.legs.length) {
    return {
      error: 'too-narrow',
      message: 'Nothing to fly inside that area',
    };
  }
  return {
    ...shell,
    legs: clipped.legs,
    waypointCount: clipped.waypointCount,
    box: bboxOfPoints(points),
    clippedToPolygon: members.some((area) => area.kind === 'polygon'),
    footprintMarginM: margin,
    clusterFrame: frame,
  };
}

function renumber(legs) {
  let nextId = 0;
  return legs.map((leg, index) => {
    const waypoints = leg.waypoints.map((w) => {
      const id = nextId;
      nextId += 1;
      return { ...w, id };
    });
    return { ...leg, id: index, waypoints };
  });
}

function jobForArea(area, index) {
  return {
    id: `job-${index + 1}`,
    name: area.name,
    areaIds: [area.id],
    areaNames: [area.name],
  };
}

/**
 * Cut each clipped line where it crosses an area edge. A piece in only one
 * area stays with that area. A piece in the overlap goes to the first area.
 */
function splitLegsByArea(planned, members, frame, margin, lookAhead) {
  const rings = members.map((area) => clipSpec(area, frame, margin));
  const buckets = members.map(() => []);
  for (const leg of planned.legs) {
    if (leg.waypoints.length < 2) {
      // Orbit is planned per area and never reaches this split. A shorter
      // leg is not given to area 0 unless that area actually contains it.
      const w = leg.waypoints[0];
      const owner =
        w && Number.isFinite(w.lon) && Number.isFinite(w.lat)
          ? areaIndexForPoint(frame.toXY(w.lon, w.lat), rings)
          : -1;
      if (owner >= 0) buckets[owner].push(leg);
      continue;
    }
    for (const { piece, leg: built } of clipLegPieces(
      leg,
      frame,
      lookAhead,
      (aimA, aimB) => assignSegmentToRings(aimA, aimB, rings),
      { keep: (piece) => piece.owner >= 0 },
    )) {
      buckets[piece.owner].push(built);
    }
  }
  return buckets;
}

/**
 * One takeoff for the whole plan. A point near any area is kept, even if
 * another area is farther than the single-box limit. planFlight must not
 * see that point, or a far cluster would replace it with its own centre.
 */
function decideTakeoff(list, rawOptions) {
  const home = unwrapCenter(areaRing(list[0]));
  const requested = rawOptions.takeoff;
  const custom =
    requested &&
    Number.isFinite(requested.lon) &&
    Number.isFinite(requested.lat);
  const without = { ...rawOptions };
  delete without.takeoff;
  if (!custom) {
    const spread = list.some(
      (area) => distanceToAreasM([area], home) > MAX_TAKEOFF_FROM_BOX_M,
    );
    return {
      takeoff: { lon: home.lon, lat: home.lat, custom: false },
      notes: spread
        ? [{ code: 'areas-spread', params: { limitM: MAX_TAKEOFF_FROM_BOX_M } }]
        : [],
      options: without,
    };
  }
  const nearest = distanceToAreasM(list, requested);
  if (nearest == null || nearest > MAX_TAKEOFF_FROM_BOX_M) {
    return {
      takeoff: { lon: home.lon, lat: home.lat, custom: false },
      notes: [
        {
          code: 'takeoff-too-far',
          params: {
            distanceM: Math.round(nearest ?? 0),
            limitM: MAX_TAKEOFF_FROM_BOX_M,
          },
        },
      ],
      options: without,
    };
  }
  const spread = list.some(
    (area) => distanceToAreasM([area], requested) > MAX_TAKEOFF_FROM_BOX_M,
  );
  return {
    takeoff: { lon: requested.lon, lat: requested.lat, custom: true },
    notes: spread
      ? [{ code: 'areas-spread', params: { limitM: MAX_TAKEOFF_FROM_BOX_M } }]
      : [],
    options: without,
  };
}

/**
 * @param {Array<{id:string,name:string,kind:'rect'|'polygon',box:object,ring?:object[]}>} areas
 * @param {object} rawOptions planFlight options plus jobGrouping 'per-area' | 'whole'
 */
export function planAreas(areas, rawOptions = {}) {
  const list = (areas ?? []).map((area) => ({
    ...area,
    box: area.kind === 'polygon' ? bboxOfPoints(area.ring) : { ...area.box },
    ring: area.kind === 'polygon' ? area.ring.map((p) => ({ ...p })) : undefined,
  }));
  if (!list.length) {
    return { error: 'bad-box', message: 'Draw a box on the globe first' };
  }
  const centre = unwrapCenter(list.flatMap((area) => areaRing(area)));
  const frame = makeFrame(centre.lon, centre.lat);
  for (const area of list) {
    const bad = checkArea(area, frame);
    if (bad) return bad;
  }
  const grouping = rawOptions.jobGrouping === 'whole' ? 'whole' : 'per-area';
  const hasTargets =
    rawOptions.pattern === 'orbit' && rawOptions.orbitTargets?.length > 0;
  if (hasTargets && !(list.length === 1 && list[0].kind === 'rect')) {
    // Listed targets drive an orbit mission across the whole survey: one
    // box around the areas, one plan, hops between targets above the trees.
    const plan = planFlight(
      bboxOfPoints(list.flatMap((area) => areaRing(area))),
      rawOptions,
    );
    if (plan.error) return plan;
    return withJob(plan, list, 'whole');
  }
  if (list.length === 1 && list[0].kind === 'rect') {
    const plan = planFlight(list[0].box, rawOptions);
    if (plan.error) return plan;
    return withJob(plan, list, grouping);
  }

  const decided = decideTakeoff(list, rawOptions);
  const { options } = normalizeOptions(decided.options, list[0].box);
  const clusters =
    options.pattern === 'orbit'
      ? list.map((_, i) => [i])
      : clusterIndices(
          list,
          frame,
          marginM(
            getPreset(options.presetId) ?? getPreset(DEFAULT_PRESET_ID),
            options,
            list.some((area) => area.kind === 'polygon'),
          ),
        );
  const whole = {
    id: 'job-1',
    name: 'Whole plan',
    areaIds: list.map((area) => area.id),
    areaNames: list.map((area) => area.name),
  };
  const perArea = list.map((area, index) => jobForArea(area, index));
  const jobs = [];
  const blocks = [];
  const legs = [];
  const notes = [...decided.notes];
  let first = null;
  const pushLegs = (planned, job, areaIds) => {
    const blockId = `block-${blocks.length + 1}`;
    blocks.push({ id: blockId, jobId: job.id, areaIds });
    tagLegs(planned, job, blockId);
    legs.push(...planned.legs);
    if (!jobs.some((item) => item.id === job.id)) jobs.push(job);
  };
  for (const indices of clusters) {
    const members = indices.map((i) => list[i]);
    const planned = planCluster(members, decided.options, decided.takeoff);
    if (planned.error) return planned;
    const clusterFrame = planned.clusterFrame;
    delete planned.clusterFrame;
    first ??= planned;
    if (grouping === 'whole' || members.length === 1) {
      const job =
        grouping === 'whole'
          ? whole
          : perArea[list.indexOf(members[0])];
      pushLegs(
        planned,
        job,
        grouping === 'whole' ? whole.areaIds : [members[0].id],
      );
    } else {
      const margin = marginM(
        getPreset(options.presetId) ?? getPreset(DEFAULT_PRESET_ID),
        options,
        members.some((area) => area.kind === 'polygon'),
      );
      const buckets = splitLegsByArea(
        planned,
        members,
        clusterFrame,
        margin,
        lookAheadM(options),
      );
      members.forEach((area, i) => {
        if (!buckets[i].length) return;
        pushLegs(
          { legs: buckets[i] },
          perArea[list.indexOf(area)],
          [area.id],
        );
      });
    }
    for (const note of planned.notes ?? []) {
      if (!notes.some((n) => n.code === note.code)) notes.push(note);
    }
  }
  const numbered = renumber(legs);
  const waypointCount = numbered.reduce(
    (sum, leg) => sum + leg.waypoints.length,
    0,
  );
  if (waypointCount > MAX_WAYPOINTS_TOTAL) {
    return {
      error: 'too-large',
      message: 'Plan needs too many waypoints',
    };
  }
  const usedJobs = (grouping === 'whole' ? [whole] : jobs).filter((job) =>
    numbered.some((leg) => leg.jobId === job.id),
  );
  const farthest = numbered.reduce(
    (max, leg) =>
      leg.waypoints.reduce(
        (m, w) => Math.max(m, groundDistanceM(decided.takeoff, w)),
        max,
      ),
    0,
  );
  const planNotes = notes.filter((note) => note.code !== 'vlos');
  if (farthest > VLOS_WARN_M) {
    planNotes.push({ code: 'vlos', params: { distanceM: Math.round(farthest) } });
  }
  const anyPolygon = list.some((area) => area.kind === 'polygon');
  const preset = getPreset(options.presetId) ?? getPreset(DEFAULT_PRESET_ID);
  return {
    ...first,
    takeoff: decided.takeoff,
    box: bboxOfPoints(list.flatMap((area) => areaRing(area))),
    legs: numbered,
    waypointCount,
    notes: planNotes,
    areas: list,
    jobs: usedJobs,
    jobGrouping: grouping,
    blocks,
    orbitPerArea: options.pattern === 'orbit',
    // A rectangle planned on its own does not carry these. Copy them from
    // the whole list, not from whichever group happened to be first.
    // `options` is the normalized set the lines were clipped with.
    clippedToPolygon: anyPolygon,
    footprintMarginM: marginM(preset, options, anyPolygon),
  };
}

function missionFromLegs(legs, job, plan) {
  const waypoints = [];
  legs.forEach((leg) => {
    leg.waypoints.forEach((w) => {
      waypoints.push({ ...w, index: waypoints.length });
    });
  });
  const est = estimateMission(waypoints, plan.takeoff, plan.speedMs, legs.length);
  return {
    index: 0,
    legs,
    waypoints,
    waypointCount: waypoints.length,
    photoCount: legs.reduce((sum, leg) => sum + leg.photoCount, 0),
    distanceM: est.distanceM,
    routeM: est.routeM,
    durationS: est.durationS,
    jobId: job?.id ?? null,
    jobName: job?.name ?? '',
    areaIds: job?.areaIds ?? [],
  };
}

function tagMission(mission, plan) {
  const jobId = mission.legs[0]?.jobId ?? null;
  const job = (plan.jobs ?? []).find((item) => item.id === jobId);
  return {
    ...mission,
    jobId,
    jobName: job?.name ?? '',
    areaIds: job?.areaIds ?? [],
  };
}

function splitByJob(mission, plan) {
  const runs = [];
  for (const leg of mission.legs) {
    const last = runs[runs.length - 1];
    if (!last || last.jobId !== leg.jobId) {
      runs.push({ jobId: leg.jobId, legs: [leg] });
    } else {
      last.legs.push(leg);
    }
  }
  if (runs.length <= 1) return [tagMission(mission, plan)];
  return runs.map((run) => {
    const job = (plan.jobs ?? []).find((item) => item.id === run.jobId);
    return missionFromLegs(run.legs, job, plan);
  });
}

function areaStatRows(plan, missions) {
  return (plan.areas ?? []).map((area) => {
    const job = (plan.jobs ?? []).find((item) => item.areaIds.includes(area.id));
    const sole = (job?.areaIds ?? []).length === 1;
    const mine = sole
      ? missions.filter((mission) => mission.jobId === job.id)
      : [];
    return {
      areaId: area.id,
      name: area.name,
      kind: area.kind,
      jobId: job?.id ?? null,
      jobName: job?.name ?? '',
      shared: !sole,
      mergedWith: [],
      missions: mine.length,
      photoCount: mine.reduce((sum, mission) => sum + mission.photoCount, 0),
      distanceM: mine.reduce((sum, mission) => sum + mission.distanceM, 0),
      durationS: mine.reduce((sum, mission) => sum + mission.durationS, 0),
    };
  });
}

/**
 * assembleMissions over the whole plan, then split a mission that would
 * otherwise mix two processing jobs. The 200-waypoint, battery and
 * MAX_MISSIONS caps still apply to the whole plan.
 */
export function assembleAreaPlan(plan, ground) {
  if (plan?.error) {
    return { plan, missions: [], totals: null, warnings: [], terrainComplete: false };
  }
  if (!plan.jobs?.length) return assembleMissions(plan, ground);
  const built = assembleMissions(plan, ground);
  let missions = built.missions.flatMap((mission) => splitByJob(mission, plan));
  const warnings = [...built.warnings];
  let truncated = built.truncated;
  if (missions.length > MAX_MISSIONS) {
    missions = missions.slice(0, MAX_MISSIONS);
    truncated = true;
    if (!warnings.some((w) => w.code === 'too-many-missions')) {
      warnings.push({ code: 'too-many-missions', params: { count: MAX_MISSIONS } });
    }
  }
  missions.forEach((mission, index) => {
    mission.index = index;
  });
  const totals = {
    ...built.totals,
    photoCount: missions.reduce((sum, mission) => sum + mission.photoCount, 0),
    distanceM: missions.reduce((sum, mission) => sum + mission.distanceM, 0),
    durationS: missions.reduce((sum, mission) => sum + mission.durationS, 0),
    waypointCount: missions.reduce((sum, mission) => sum + mission.waypointCount, 0),
    missionCount: missions.length,
  };
  return {
    plan,
    missions,
    totals,
    warnings,
    terrainComplete: built.terrainComplete,
    truncated,
    ground: built.ground,
    jobs: plan.jobs,
    areaStats: areaStatRows(plan, missions),
  };
}

function distanceToSegment(p, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.min(
    1,
    Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2),
  );
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

/** Metres from a lon/lat point to the nearest area. 0 when the point is inside. */
export function distanceToAreasM(areas, point) {
  if (!areas?.length || !point) return null;
  const frame = makeFrame(point.lon, point.lat);
  const here = { x: 0, y: 0 };
  let best = Infinity;
  for (const area of areas) {
    if (area.kind !== 'polygon' && takeoffDistanceFromBoxM(area.box, point) === 0) {
      return 0;
    }
    const ring = ringXY(areaRing(area), frame);
    if (area.kind === 'polygon' && pointInRing(here, ring)) return 0;
    for (let i = 0; i < ring.length; i += 1) {
      best = Math.min(best, distanceToSegment(here, ring[i], ring[(i + 1) % ring.length]));
    }
  }
  return best;
}

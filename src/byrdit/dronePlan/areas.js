/**
 * Several areas in one Drone Flight Plan.
 *
 * A single rectangle still goes through planFlight, so that plan does not
 * change. A polygon is clipped to its edge, expanded by half the photo
 * footprint so the edge is still covered. Overlapping areas are unioned and
 * flown once. Each area still keeps its own processing job: a line in the
 * overlap is given to the first area that contains it. Areas that do not
 * touch stay separate flight blocks. Orbit is planned around the centre of
 * each area and is not merged.
 */

import { deltaLon, makeFrame, wrapLon } from './geo.js';
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
} from './planner.js';
import { getPreset, DEFAULT_PRESET_ID } from './presets.js';
import {
  clipSegmentToRings,
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

function clusterIndices(areas, frame) {
  const rings = areas.map((area) => ringXY(areaRing(area), frame));
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

function clipShell(shell, lonLatRings, margin) {
  const frame = shell.frame;
  const xy = lonLatRings.map((ring) => {
    const local = ring.map((p) => frame.toXY(p.lon, p.lat));
    return offsetRing(local, margin);
  });
  const out = [];
  for (const leg of shell.legs) {
    if (leg.kind === 'orbit' || leg.waypoints.length < 2) {
      out.push(leg);
      continue;
    }
    const a = frame.toXY(leg.waypoints[0].lon, leg.waypoints[0].lat);
    const b = frame.toXY(
      leg.waypoints[leg.waypoints.length - 1].lon,
      leg.waypoints[leg.waypoints.length - 1].lat,
    );
    const interval = leg.photoMode === 'interval';
    const step = interval ? INTERVAL_WAYPOINT_STEP_M : leg.photoSpacingM;
    for (const piece of clipSegmentToRings(a, b, xy)) {
      const length = Math.hypot(piece.end.x - piece.start.x, piece.end.y - piece.start.y);
      if (length < MIN_PIECE_M) continue;
      const { points } = sampleSegment(piece.start, piece.end, step);
      const waypoints = points.map((p, id) => {
        const ll = frame.toLonLat(p.x, p.y);
        return {
          id,
          lon: Number(ll.lon.toFixed(8)),
          lat: Number(ll.lat.toFixed(8)),
          aglM: leg.waypoints[0].aglM,
          pitchDeg: leg.pitchDeg,
          headingDeg: null,
          photo: !interval,
        };
      });
      out.push({
        ...leg,
        waypoints,
        lengthM: length,
        photoCount: interval
          ? Math.floor(length / leg.photoSpacingM + 1e-9) + 1
          : waypoints.length,
      });
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

function planCluster(members, rawOptions) {
  if (members.length === 1 && members[0].kind === 'rect') {
    return planFlight(members[0].box, rawOptions);
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
  const rings = members.map((area) => areaRing(area));
  const expanded = rings.flatMap((ring) => {
    const local = offsetRing(ringXY(ring, frame), margin);
    return local.map((p) => frame.toLonLat(p.x, p.y));
  });
  const shell = planFlight(bboxOfPoints(expanded), rawOptions);
  if (shell.error) return shell;
  const clipped = clipShell(shell, rings, margin);
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

/** Which area in this cluster owns a clipped leg. Overlap goes to the first. */
function legOwner(leg, members, frame) {
  if (!leg.waypoints.length) return 0;
  const a = leg.waypoints[0];
  const b = leg.waypoints[leg.waypoints.length - 1];
  const pa = frame.toXY(a.lon, a.lat);
  const pb = frame.toXY(b.lon, b.lat);
  const p = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
  for (let i = 0; i < members.length; i += 1) {
    if (pointInRing(p, ringXY(areaRing(members[i]), frame))) return i;
  }
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < members.length; i += 1) {
    const ring = ringXY(areaRing(members[i]), frame);
    let d = Infinity;
    for (let k = 0; k < ring.length; k += 1) {
      d = Math.min(
        d,
        distanceToSegment(p, ring[k], ring[(k + 1) % ring.length]),
      );
    }
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
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
      : clusterIndices(list, frame);
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
    const planned = planCluster(members, decided.options);
    if (planned.error) return planned;
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
      const buckets = members.map(() => []);
      for (const leg of planned.legs) {
        buckets[legOwner(leg, members, frame)].push(leg);
      }
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
  return {
    ...first,
    takeoff: decided.takeoff,
    box: bboxOfPoints(list.flatMap((area) => areaRing(area))),
    legs: numbered,
    waypointCount,
    notes,
    areas: list,
    jobs: usedJobs,
    jobGrouping: grouping,
    blocks,
    orbitPerArea: options.pattern === 'orbit',
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

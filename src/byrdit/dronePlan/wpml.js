/**
 * DJI WPML writer for DJI Fly: one KMZ per mission, each holding
 * `wpmz/template.kml` and `wpmz/waylines.wpml`.
 *
 * Format source: DJI's published WPML reference (developer.dji.com, Cloud API
 * "DJI WPML": Template.kml, Waylines.wpml, Common Elements) for the element
 * names, actions and trigger types, and two REAL files DJI Fly wrote for a
 * Mini 5 Pro on 2026-10-30 (test fixtures under fixtures/djifly-mini5pro).
 *
 * Layout of a real DJI Fly file: `wpmz/template.kml` holds ONLY author,
 * createTime, updateTime and missionConfig (no waypoints, no Folder); every
 * waypoint lives in `wpmz/waylines.wpml`. So the waypoints are written to
 * waylines.wpml only.
 *
 * The output is written in the form DJI Fly itself produces when it re-saves a
 * mission, so a file loads and flies without opening and saving it first.
 * That form was measured on five real Mini 5 Pro missions (GEV originals of
 * 2026-10-30 against the files DJI Fly wrote back; see wpmlDjiResave.test.mjs):
 *  - one parallel reachPoint group per waypoint with takePhoto and, on the
 *    first waypoint, the gimbalRotate; useGlobalPayloadLensIndex 0 on takePhoto;
 *  - a later tilt is a gimbalEvenlyRotate on the waypoint before it;
 *  - first and last waypoint are stops with waypointHeadingAngleEnable 1, every
 *    other waypoint has the flag 0 (also on orbits: DJI Fly keeps the
 *    smoothTransition mode and the stored angle, and sets only this flag);
 *  - folder autoFlightSpeed 2.5, distance 0, duration 0; numbers without ".0".
 *
 * Deliberate differences from DJI Fly's own re-save, from the first flight
 * (2026-11-01, Mini 5 Pro): DJI Fly took only the first takePhoto of a
 * waypoint's action group, so
 *  - every waypoint holds exactly ONE takePhoto; a ring stop with an outward
 *    photo is two waypoints at one place (shotWaypoints.js), the second a
 *    stop that faces away, tilted by a gimbalRotate that runs BEFORE its photo;
 *  - on the first waypoint of a mission the gimbalRotate and the takePhoto
 *    are one SEQUENCE group (tilt first), not two parallel actions, because
 *    the first photo was taken at the leftover pitch.
 *
 * Still NOT verified by a real DJI Fly file: multipleDistance interval photos,
 * the heading of the outward waypoint, and whether the aircraft honours
 * the smoothTransition angle when the flag is 0 (needs a flight). The
 * namespace and drone enum are constants so a mismatch is a one-line change.
 */
import { jobFolder, jobSlug } from './areas.js';
import { TRANSIT_SPEED_MS } from './planner.js';
import { makeZip } from './zip.js';
import { cameraChecklistLines } from './cameraSettings.js';
import { hasOutwardShot, splitOutwardShots } from './shotWaypoints.js';
import {
  controllerFileId,
  flightCode,
  flightFileName,
  flightTitle,
  hasLabel,
} from './missionLabel.js';
import { labelReadmeLines } from './cheatSheet.js';

/** Namespace used by DJI Fly's own consumer-drone missions. */
export const WPML_NAMESPACE = 'http://www.uav.com/wpmz/1.0.2';

export const esc = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Numbers the way DJI Fly writes them: no trailing zeros and no ".0"
 * (79 not 79.0, 2.8, -82.9). `dp` is the most decimals kept.
 */
const num = (n, dp = 1) => {
  const text = Number(n).toFixed(dp);
  const trimmed = text.includes('.') ? text.replace(/\.?0+$/, '') : text;
  return trimmed === '-0' || trimmed === '' ? '0' : trimmed;
};
const one = (n) => num(n, 1);
const pitchText = (n) => one(n);
/** A coordinate with 8 decimals (about 1 mm), trailing zeros dropped. */
const coord = (n) => num(n, 8);

function missionConfig(preset, plan, wpml) {
  if (preset.kmz?.supported === false) {
    throw new Error(`${preset.name} cannot load a DJI Fly waypoint KMZ`);
  }
  const enumValue = wpml?.droneEnumValue ?? preset.wpml?.droneEnumValue;
  const subEnum =
    wpml?.droneSubEnumValue ?? preset.wpml?.droneSubEnumValue ?? 0;
  // Number(null) is 0: a missing code must stop the file, not become aircraft 0.
  if (!Number.isInteger(enumValue)) {
    throw new Error(`No DJI Fly aircraft code known for ${preset.name}`);
  }
  return `    <wpml:missionConfig>
      <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
      <wpml:finishAction>goHome</wpml:finishAction>
      <wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost>
      <wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>
      <wpml:globalTransitionalSpeed>${one(Math.min(TRANSIT_SPEED_MS, preset.maxSpeedMs))}</wpml:globalTransitionalSpeed>
      <wpml:droneInfo>
        <wpml:droneEnumValue>${Number(enumValue)}</wpml:droneEnumValue>
        <wpml:droneSubEnumValue>${Number(subEnum)}</wpml:droneSubEnumValue>
      </wpml:droneInfo>
    </wpml:missionConfig>`;
}

function gimbalAction(id, pitchDeg) {
  return `          <wpml:action>
            <wpml:actionId>${id}</wpml:actionId>
            <wpml:actionActuatorFunc>gimbalRotate</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:gimbalHeadingYawBase>aircraft</wpml:gimbalHeadingYawBase>
              <wpml:gimbalRotateMode>absoluteAngle</wpml:gimbalRotateMode>
              <wpml:gimbalPitchRotateEnable>1</wpml:gimbalPitchRotateEnable>
              <wpml:gimbalPitchRotateAngle>${pitchText(pitchDeg)}</wpml:gimbalPitchRotateAngle>
              <wpml:gimbalRollRotateEnable>0</wpml:gimbalRollRotateEnable>
              <wpml:gimbalRollRotateAngle>0</wpml:gimbalRollRotateAngle>
              <wpml:gimbalYawRotateEnable>0</wpml:gimbalYawRotateEnable>
              <wpml:gimbalYawRotateAngle>0</wpml:gimbalYawRotateAngle>
              <wpml:gimbalRotateTimeEnable>0</wpml:gimbalRotateTimeEnable>
              <wpml:gimbalRotateTime>0</wpml:gimbalRotateTime>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
            </wpml:actionActuatorFuncParam>
          </wpml:action>`;
}

function photoAction(id) {
  return `          <wpml:action>
            <wpml:actionId>${id}</wpml:actionId>
            <wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
              <wpml:useGlobalPayloadLensIndex>0</wpml:useGlobalPayloadLensIndex>
            </wpml:actionActuatorFuncParam>
          </wpml:action>`;
}

/**
 * The gradual tilt DJI Fly writes in place of a plain gimbalRotate at every
 * waypoint after the first: it sits on the waypoint BEFORE the change, in a
 * group spanning that waypoint and the next, so the camera tilts over the leg.
 */
function gimbalEvenlyAction(id, pitchDeg) {
  return `          <wpml:action>
            <wpml:actionId>${id}</wpml:actionId>
            <wpml:actionActuatorFunc>gimbalEvenlyRotate</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:gimbalPitchRotateAngle>${pitchText(pitchDeg)}</wpml:gimbalPitchRotateAngle>
              <wpml:gimbalRollRotateAngle>0</wpml:gimbalRollRotateAngle>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
            </wpml:actionActuatorFuncParam>
          </wpml:action>`;
}

function actionGroup({
  id,
  start,
  end,
  trigger,
  triggerParam,
  actions,
  mode = 'parallel',
}) {
  const param =
    triggerParam == null
      ? ''
      : `
            <wpml:actionTriggerParam>${Number(triggerParam).toFixed(1)}</wpml:actionTriggerParam>`;
  return `        <wpml:actionGroup>
          <wpml:actionGroupId>${id}</wpml:actionGroupId>
          <wpml:actionGroupStartIndex>${start}</wpml:actionGroupStartIndex>
          <wpml:actionGroupEndIndex>${end}</wpml:actionGroupEndIndex>
          <wpml:actionGroupMode>${mode}</wpml:actionGroupMode>
          <wpml:actionTrigger>
            <wpml:actionTriggerType>${trigger}</wpml:actionTriggerType>${param}
          </wpml:actionTrigger>
${actions.join('\n')}
        </wpml:actionGroup>
`;
}

/**
 * Folder autoFlightSpeed, distance and duration exactly as DJI Fly re-saves
 * them: 2.5 (its default speed), 0 and 0. The speed that flies is each
 * waypoint's own waypointSpeed: the five Oct 30 missions were flown after
 * DJI Fly rewrote them this way and the photos show 2.2-2.8 m/s, the planned
 * speeds. Writing the default here means DJI Fly has nothing left to reset.
 */
const DJI_AUTO_FLIGHT_SPEED = '2.5';
/**
 * Turn mode of a stop. DJI Fly's own stop (first and last waypoint of every
 * file it wrote) is ...StopWithContinuityCurvature; GEV used to write the
 * Discontinuity variant, which no real DJI Fly file contains.
 */
const STOP_TURN = 'toPointAndStopWithContinuityCurvature';
const PASS_TURN = 'toPointAndPassWithContinuityCurvature';

/**
 * One Placemark.
 * `ends` is true for the first and the last waypoint of the mission: DJI Fly
 * writes both as stops with waypointHeadingAngleEnable 1 and every other
 * waypoint with 0, whatever the heading mode (followWayline or
 * smoothTransition with a stored angle). The heading angle and mode are kept.
 */
function placemark(wp, speedMs, groups, ends) {
  const orbit = wp.headingDeg != null;
  // DJI Fly rewrites every orbit photo stop into a pass-through when it
  // re-saves (172 of 174 waypoints of the Oct 30 orbit), so GEV writes the
  // pass-through. The two shots of one stop keep the stop, since the turn and
  // the tilt between them need the aircraft standing still (no DJI Fly file
  // has one), and they carry the heading flag so the stored angle is used.
  const stop = ends || Boolean(wp.shot);
  return `      <Placemark>
        <Point>
          <coordinates>
            ${coord(wp.lon)},${coord(wp.lat)}
          </coordinates>
        </Point>
        <wpml:index>${wp.index}</wpml:index>
        <wpml:executeHeight>${one(wp.relHeightM)}</wpml:executeHeight>
        <wpml:waypointSpeed>${one(speedMs)}</wpml:waypointSpeed>
        <wpml:waypointHeadingParam>
          <wpml:waypointHeadingMode>${orbit ? 'smoothTransition' : 'followWayline'}</wpml:waypointHeadingMode>
          <wpml:waypointHeadingAngle>${orbit ? one(wp.headingDeg) : '0'}</wpml:waypointHeadingAngle>
          <wpml:waypointPoiPoint>0.000000,0.000000,0.000000</wpml:waypointPoiPoint>
          <wpml:waypointHeadingAngleEnable>${ends || wp.shot ? 1 : 0}</wpml:waypointHeadingAngleEnable>
          <wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode>
          <wpml:waypointHeadingPoiIndex>0</wpml:waypointHeadingPoiIndex>
        </wpml:waypointHeadingParam>
        <wpml:waypointTurnParam>
          <wpml:waypointTurnMode>${stop ? STOP_TURN : PASS_TURN}</wpml:waypointTurnMode>
          <wpml:waypointTurnDampingDist>0</wpml:waypointTurnDampingDist>
        </wpml:waypointTurnParam>
        <wpml:useStraightLine>0</wpml:useStraightLine>
${groups}        <wpml:waypointGimbalHeadingParam>
          <wpml:waypointGimbalPitchAngle>${pitchText(wp.pitchDeg)}</wpml:waypointGimbalPitchAngle>
          <wpml:waypointGimbalYawAngle>0</wpml:waypointGimbalYawAngle>
        </wpml:waypointGimbalHeadingParam>
      </Placemark>`;
}

/**
 * Placemark XML for every waypoint of a mission, in the form DJI Fly writes
 * when it re-saves a file (measured on 5 real Mini 5 Pro missions):
 *  - one parallel reachPoint group per waypoint holding takePhoto AND, on the
 *    first waypoint, the gimbalRotate (takePhoto first);
 *  - group ids restart at 1 on every waypoint (the tilt group is 2 even when
 *    the waypoint has no photo group), action ids run 1..n over the
 *    whole mission, handed out waypoint by waypoint (photo, then tilt);
 *  - every later tilt (the first waypoint of a leg) is a gimbalEvenlyRotate
 *    in a second group on the waypoint BEFORE it, start = that waypoint,
 *    end = the next one, keeping the id the tilt would have had.
 * Differences (first flight): the first waypoint of a mission and the outward
 * shot of a ring stop use a sequence group, gimbalRotate then takePhoto, so
 * the photo is taken at the pitch it was planned for. Interval-photo legs are
 * not in any DJI Fly file: they keep GEV's own groups and are only renumbered
 * the same way.
 */
function placemarks(mission, speedMs) {
  const flat = [];
  for (const leg of mission.legs) {
    leg.waypoints.forEach((wp, i) => flat.push({ wp, leg, first: i === 0 }));
  }
  const total = flat.length;
  let actionId = 1;

  // Pass 1: ids and the groups each waypoint owns.
  const own = flat.map(({ wp, leg, first }, k) => {
    const lastIndex = leg.waypoints[leg.waypoints.length - 1].index;
    const item = { groups: [], tilt: null };
    const missionStart = k === 0;
    const outShot = wp.shot === 'out';
    const afterOut = flat[k - 1]?.wp.shot === 'out';
    // A tilt where the leg starts, at the outward shot of a stop, and back
    // again on the waypoint after it.
    if (first || outShot || afterOut) item.tilt = { id: 0, pitch: wp.pitchDeg };
    const interval = leg.photoMode === 'interval';
    // Where the first-waypoint rotate goes: in front of GEV's own groups when
    // they are not the plain photo group, so the tilt is set before they run.
    const tiltFirst = missionStart && interval;
    if (tiltFirst) item.tilt.id = actionId++;
    if (interval) {
      if (first) {
        item.groups.push({
          start: wp.index,
          end: lastIndex,
          trigger: 'multipleDistance',
          triggerParam: Math.max(1, leg.photoSpacingM),
          actions: [photoAction(actionId++)],
        });
      }
    } else if (wp.photo && item.tilt && (missionStart || outShot)) {
      // The camera must be at its pitch BEFORE the photo: one ordered group,
      // tilt then photo. In a parallel group both fire at once and the first
      // photo of the mission was taken at the leftover pitch.
      const tiltId = actionId++;
      item.groups.push({
        start: wp.index,
        end: wp.index,
        trigger: 'reachPoint',
        mode: 'sequence',
        actions: [gimbalAction(tiltId, wp.pitchDeg), photoAction(actionId++)],
      });
      item.tilt = null;
    } else if (wp.photo) {
      item.groups.push({
        start: wp.index,
        end: wp.index,
        trigger: 'reachPoint',
        actions: [photoAction(actionId++)],
      });
    }
    if (item.tilt && !tiltFirst) item.tilt.id = actionId++;
    return item;
  });

  // Pass 2: place the tilts. The first waypoint's is a gimbalRotate; every
  // other is the gimbalEvenlyRotate on the waypoint before it.
  const placed = own.map((item) => ({ groups: [...item.groups] }));
  own.forEach((item, k) => {
    if (!item.tilt) return;
    const { id, pitch } = item.tilt;
    if (k === 0) {
      const rotate = gimbalAction(id, pitch);
      const photoGroup = placed[0].groups.find(
        (g) => g.trigger === 'reachPoint' && g.mode == null,
      );
      if (photoGroup) {
        photoGroup.actions.push(rotate);
      } else if (placed[0].groups.length === 0) {
        placed[0].groups.push({
          start: flat[0].wp.index,
          end: flat[0].wp.index,
          trigger: 'reachPoint',
          actions: [rotate],
        });
      } else {
        placed[0].groups.unshift({
          start: flat[0].wp.index,
          end: flat[0].wp.index,
          trigger: 'reachPoint',
          actions: [rotate],
        });
      }
    } else {
      placed[k - 1].groups.push({
        start: flat[k - 1].wp.index,
        end: flat[k].wp.index,
        trigger: 'reachPoint',
        evenly: true,
        actions: [gimbalEvenlyAction(id, pitch)],
      });
    }
  });

  return flat
    .map(({ wp }, k) => {
      const groups = placed[k].groups;
      const owned = groups.filter((group) => !group.evenly).length;
      // DJI Fly numbers a waypoint's groups from 1, but the tilt group is
      // always at least 2, even on a waypoint that has no photo group.
      const text = groups
        .map((group, g) =>
          actionGroup({
            ...group,
            id: group.evenly ? Math.max(2, owned + 1) : g + 1,
          }),
        )
        .join('');
      return placemark(wp, speedMs, text, k === 0 || k === total - 1);
    })
    .join('\n');
}

/**
 * A mission whose ring stops still hold an outward photo in the same waypoint
 * (hand-built, or made before the planner split them) is split here, so the
 * file never holds two takePhoto actions at one waypoint. Missions the planner
 * made pass through untouched.
 */
function oneShotPerWaypoint(mission) {
  if (!mission.legs.some((leg) => leg.waypoints.some(hasOutwardShot))) {
    return mission;
  }
  let next = 0;
  const legs = mission.legs.map((leg) => ({
    ...leg,
    waypoints: splitOutwardShots(leg.waypoints).map((w) => ({
      ...w,
      index: next++,
    })),
  }));
  const waypoints = legs.flatMap((leg) => leg.waypoints);
  return { ...mission, legs, waypoints, waypointCount: waypoints.length };
}

/**
 * The two XML documents of one mission.
 * @param {object} mission One entry of assembleMissions().missions.
 * @param {object} plan The plan it came from.
 * @param {{ name?: string, createdMs?: number, wpml?: object }} [opts]
 */
export function buildMissionFiles(mission, plan, opts = {}) {
  const preset = plan.preset;
  const speedMs = plan.speedMs;
  const created = opts.createdMs ?? Date.now();
  const author = esc(opts.name ?? 'fly');
  const config = missionConfig(preset, plan, opts.wpml);
  const body = placemarks(oneShotPerWaypoint(mission), speedMs);
  const templateKml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${WPML_NAMESPACE}">
  <Document>
    <wpml:author>${author}</wpml:author>
    <wpml:createTime>${created}</wpml:createTime>
    <wpml:updateTime>${created}</wpml:updateTime>
${config}
  </Document>
</kml>
`;
  const waylinesWpml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${WPML_NAMESPACE}">
  <Document>
${config}
    <Folder>
      <wpml:templateId>0</wpml:templateId>
      <wpml:executeHeightMode>relativeToStartPoint</wpml:executeHeightMode>
      <wpml:waylineId>0</wpml:waylineId>
      <wpml:distance>0</wpml:distance>
      <wpml:duration>0</wpml:duration>
      <wpml:autoFlightSpeed>${DJI_AUTO_FLIGHT_SPEED}</wpml:autoFlightSpeed>
${body}
    </Folder>
  </Document>
</kml>
`;
  return { templateKml, waylinesWpml };
}

/** One mission as KMZ bytes. */
export function buildKmz(mission, plan, opts = {}) {
  const { templateKml, waylinesWpml } = buildMissionFiles(mission, plan, opts);
  return makeZip(
    [
      { name: 'wpmz/template.kml', data: templateKml },
      { name: 'wpmz/waylines.wpml', data: waylinesWpml },
    ],
    opts.when ? new Date(opts.when) : new Date(),
  );
}

const pad = (n) => String(n).padStart(2, '0');

/** `gev-drone-plan-20261028-1530-m2of3.kmz`, or with a job name in the middle. */
export function kmzFileName(index, total, when = new Date(), jobName = '') {
  const stamp = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}`;
  const job = jobName ? `-${jobSlug(jobName)}` : '';
  return `gev-drone-plan-${stamp}${job}-m${index + 1}of${total}.kmz`;
}

/** The text file that rides in the ZIP of all missions. */
export function readmeText(result, when = new Date(), opts = {}) {
  const { plan, missions, totals, warnings } = result;
  const t = plan.takeoff;
  const lines = [
    'GEV Drone Flight Plan',
    `Created ${when.toISOString()}`,
    '',
    `Aircraft: ${plan.preset.name}`,
    `Takeoff point: ${t.lat.toFixed(6)}, ${t.lon.toFixed(6)}  (launch the drone from HERE:`,
    'heights in the missions are measured from the takeoff point).',
    `Missions: ${missions.length}, one battery each.`,
    ...missions.map(
      (m, i) =>
        `  ${i + 1}. ${m.waypointCount} waypoints, ${m.photoCount} photos, ${Math.round(m.distanceM)} m, about ${Math.round(m.durationS / 60)} min`,
    ),
    `Photos: ${totals.photoCount}, ground sample distance ${totals.gsdCm.toFixed(2)} cm/px.`,
    '',
    ...cameraChecklistLines(
      plan.options?.cameraPresetId,
      plan.options?.shutterDenominator,
    ),
    '',
    'NOT FLIGHT-TESTED. These files have not been validated on a real aircraft.',
    'Load one at a time: in DJI Fly make a dummy waypoint mission, save it, then',
    'replace its KMZ with one of these (keep the file name DJI Fly gave it).',
    ...(opts.labelFlights?.length
      ? ['', ...labelReadmeLines(opts.labelFlights)]
      : []),
    ...(opts.controllerIds?.some(controllerFileId)
      ? [
          'Files named <UUID>.kmz carry the mission id of a mission already on the',
          "controller: copy each one over DJI Fly's own file, waypoint/<UUID>/<UUID>.kmz",
          'in the DJI Fly data folder of the controller.',
        ]
      : []),
    'Written in the form DJI Fly itself saves (checked against five real DJI Fly',
    'files): file layout, namespace, aircraft code, photo and gimbal actions,',
    'gradual tilt, stops at the first and last waypoint.',
    'NOT verified by a real file: distance-interval photos, orbit headings in',
    'flight, and the rotateYaw and sequence-mode actions of the outward orbit photo.',
    'Check airspace and local rules, keep the aircraft in sight, and fly the',
    'first mission short and supervised.',
    'The 3D check on the globe is a VISUAL aid only: it does not detect a',
    'collision, and OpenStreetMap has no trees or power lines. Look at the path',
    'over the Google 3D view and check clearance yourself.',
    ...(plan.orbit
      ? [
          'Building orbits use OpenStreetMap footprints. Trees, towers and power lines',
          'are not in that data: check clearance yourself.',
        ]
      : []),
  ];
  if (warnings.length) {
    lines.push('', 'Warnings:');
    for (const w of warnings)
      lines.push(`  - ${w.code} ${JSON.stringify(w.params)}`);
  }
  const jobs = result.jobs ?? [];
  if (jobs.length) {
    lines.push(
      '',
      'Processing jobs:',
      'Process the images from one job together (ODM). Do not mix jobs.',
    );
    if (
      (result.plan?.jobGrouping ?? 'per-area') !== 'whole' &&
      jobs.length > 1
    ) {
      lines.push(
        'Where areas overlap, photos of that ground are only in the first job.',
        'A later job has no photos there.',
      );
    }
    for (const job of jobs) {
      const mine = missions.filter((mission) => mission.jobId === job.id);
      const photos = mine.reduce((sum, mission) => sum + mission.photoCount, 0);
      lines.push(
        `Job: ${job.name} (${job.id})`,
        `  Areas: ${(job.areaNames ?? [job.name]).join(', ')}`,
        `  Missions: ${mine.length}`,
        `  Photos: ${photos}`,
        '  Images from this job should be processed together (ODM).',
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

/** The files of a bundle (every mission plus a README); jobs get a folder each. */
export function bundleEntries(result, opts = {}) {
  const when = opts.when ? new Date(opts.when) : new Date();
  const jobs = result.jobs ?? [];
  const multi = jobs.length > 1;
  // Flights are counted across the passes of a suite, so one counter is shared.
  const counter = opts.flightCounter ?? { n: 0 };
  // A saved plan has a number: its flights are named M7, M7-2, ... in the file
  // names, the preview pictures and the README.
  const label = hasLabel(opts.label) ? opts.label : null;
  const flightTotal = opts.flightTotal ?? result.missions.length;
  const labelFlights = [];
  const extra = [];
  const entries = result.missions.map((mission) => {
    const same = multi
      ? result.missions.filter((item) => item.jobId === mission.jobId)
      : result.missions;
    const index = same.indexOf(mission);
    const job = jobs.find((item) => item.id === mission.jobId);
    // A flight with a controller mission id is named <UUID>.kmz, the name DJI
    // Fly gave it (waypoint/<UUID>/<UUID>.kmz on the controller).
    // Optional chaining would skip the increment when there are no ids.
    const flight = counter.n++;
    // The id becomes a file name: only a real controller mission id is used.
    const uuid = controllerFileId(opts.controllerIds?.[flight]);
    const labelFile = label ? flightFileName(label, flight, flightTotal) : null;
    const file = uuid
      ? `${uuid}.kmz`
      : (labelFile ??
        kmzFileName(index, same.length, when, multi ? mission.jobName : ''));
    const folder = multi
      ? `${jobFolder(job ?? { id: mission.jobId, name: mission.jobName })}/`
      : '';
    if (label) {
      const stem = flightFileName(label, flight, flightTotal, 'jpg');
      const picture = opts.previews?.[flight] ?? null;
      const pictureName = picture
        ? `${folder}${stem.replace(/\.jpg$/, '')}_preview.jpg`
        : null;
      if (picture) {
        extra.push({ name: pictureName, data: picture });
        // The controller keeps its list picture at map_preview/<UUID>/<UUID>.jpg.
        if (uuid) {
          extra.push({
            name: `${folder}map_preview/${uuid}/${uuid}.jpg`,
            data: picture,
          });
        }
      }
      labelFlights.push({
        code: flightCode(label.no, flight, flightTotal),
        title: flightTitle(label, flight, flightTotal),
        file: `${folder}${file}`,
        uuid,
        preview: pictureName,
      });
    }
    return {
      name: `${folder}${file}`,
      data: buildKmz(mission, result.plan, {
        ...opts,
        when,
        ...(label ? { name: flightTitle(label, flight, flightTotal) } : {}),
      }),
    };
  });
  entries.push(...extra);
  entries.push({
    name: 'README.txt',
    data: readmeText(result, when, {
      controllerIds: opts.controllerIds,
      labelFlights,
    }),
  });
  return entries;
}

/** Every mission plus a README, as one ZIP. Jobs get a folder each. */
export function buildBundleZip(result, opts = {}) {
  const when = opts.when ? new Date(opts.when) : new Date();
  return makeZip(bundleEntries(result, { ...opts, when }), when);
}

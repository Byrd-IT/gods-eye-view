/**
 * DJI WPML writer for DJI Fly: one KMZ per mission, each holding
 * `wpmz/template.kml` and `wpmz/waylines.wpml`.
 *
 * Format source: DJI's published WPML reference (developer.dji.com, Cloud API
 * "DJI WPML": Template.kml, Waylines.wpml, Common Elements) for the element
 * names, actions and trigger types, and the namespace/element layout of a
 * native DJI Fly mission made on a DJI RC 2 (documented by the open-source
 * FlyPath planner, verified there against a Mini 4 Pro dump). The same
 * waypoint list is written to BOTH files because DJI Fly rebuilds a mission
 * from template.kml when it is re-saved.
 *
 * NOT YET VERIFIED against a Mini 5 Pro: compare with a KMZ that DJI Fly
 * itself wrote for this aircraft before trusting it in the air. The namespace
 * and drone enum are constants below so a mismatch is a one-line change.
 */
import { jobFolder, jobSlug } from './areas.js';
import { TRANSIT_SPEED_MS } from './planner.js';
import { makeZip } from './zip.js';

/** Namespace used by DJI Fly's own consumer-drone missions. */
export const WPML_NAMESPACE = 'http://www.uav.com/wpmz/1.0.2';

export const esc = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const one = (n) => Number(n).toFixed(1);
const pitchText = (n) => (Number.isInteger(n) ? String(n) : one(n));

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
            </wpml:actionActuatorFuncParam>
          </wpml:action>`;
}

function actionGroup({ id, start, end, trigger, triggerParam, actions }) {
  const param =
    triggerParam == null
      ? ''
      : `
            <wpml:actionTriggerParam>${one(triggerParam)}</wpml:actionTriggerParam>`;
  return `        <wpml:actionGroup>
          <wpml:actionGroupId>${id}</wpml:actionGroupId>
          <wpml:actionGroupStartIndex>${start}</wpml:actionGroupStartIndex>
          <wpml:actionGroupEndIndex>${end}</wpml:actionGroupEndIndex>
          <wpml:actionGroupMode>sequence</wpml:actionGroupMode>
          <wpml:actionTrigger>
            <wpml:actionTriggerType>${trigger}</wpml:actionTriggerType>${param}
          </wpml:actionTrigger>
${actions.join('\n')}
        </wpml:actionGroup>
`;
}

function placemark(wp, speedMs, groups) {
  const orbit = wp.headingDeg != null;
  return `      <Placemark>
        <Point>
          <coordinates>
            ${wp.lon.toFixed(8)},${wp.lat.toFixed(8)}
          </coordinates>
        </Point>
        <wpml:index>${wp.index}</wpml:index>
        <wpml:executeHeight>${one(wp.relHeightM)}</wpml:executeHeight>
        <wpml:waypointSpeed>${one(speedMs)}</wpml:waypointSpeed>
        <wpml:waypointHeadingParam>
          <wpml:waypointHeadingMode>${orbit ? 'smoothTransition' : 'followWayline'}</wpml:waypointHeadingMode>
          <wpml:waypointHeadingAngle>${orbit ? one(wp.headingDeg) : '0'}</wpml:waypointHeadingAngle>
          <wpml:waypointPoiPoint>0.000000,0.000000,0.000000</wpml:waypointPoiPoint>
          <wpml:waypointHeadingAngleEnable>${orbit ? 1 : 0}</wpml:waypointHeadingAngleEnable>
          <wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode>
          <wpml:waypointHeadingPoiIndex>0</wpml:waypointHeadingPoiIndex>
        </wpml:waypointHeadingParam>
        <wpml:waypointTurnParam>
          <wpml:waypointTurnMode>toPointAndPassWithContinuityCurvature</wpml:waypointTurnMode>
          <wpml:waypointTurnDampingDist>0</wpml:waypointTurnDampingDist>
        </wpml:waypointTurnParam>
        <wpml:useStraightLine>0</wpml:useStraightLine>
${groups}        <wpml:waypointGimbalHeadingParam>
          <wpml:waypointGimbalPitchAngle>${pitchText(wp.pitchDeg)}</wpml:waypointGimbalPitchAngle>
          <wpml:waypointGimbalYawAngle>0</wpml:waypointGimbalYawAngle>
        </wpml:waypointGimbalHeadingParam>
      </Placemark>`;
}

/** Placemark XML for every waypoint of a mission, with its photo actions. */
function placemarks(mission, speedMs) {
  const blocks = [];
  let groupId = 0;
  for (const leg of mission.legs) {
    const wps = leg.waypoints;
    const last = wps[wps.length - 1].index;
    wps.forEach((wp, i) => {
      let groups = '';
      if (leg.photoMode === 'interval') {
        if (i === 0) {
          groups += actionGroup({
            id: groupId++,
            start: wp.index,
            end: wp.index,
            trigger: 'reachPoint',
            actions: [gimbalAction(0, wp.pitchDeg)],
          });
          groups += actionGroup({
            id: groupId++,
            start: wp.index,
            end: last,
            trigger: 'multipleDistance',
            triggerParam: Math.max(1, leg.photoSpacingM),
            actions: [photoAction(0)],
          });
        }
      } else {
        const actions = [];
        if (i === 0) actions.push(gimbalAction(actions.length, wp.pitchDeg));
        if (wp.photo) actions.push(photoAction(actions.length));
        if (actions.length) {
          groups += actionGroup({
            id: groupId++,
            start: wp.index,
            end: wp.index,
            trigger: 'reachPoint',
            actions,
          });
        }
      }
      blocks.push(placemark(wp, speedMs, groups));
    });
  }
  return blocks.join('\n');
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
  const author = esc(opts.name ?? 'GEV Drone Flight Plan');
  const config = missionConfig(preset, plan, opts.wpml);
  const body = placemarks(mission, speedMs);
  const templateKml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"
     xmlns:wpml="${WPML_NAMESPACE}">
  <Document>
    <wpml:author>${author}</wpml:author>
    <wpml:createTime>${created}</wpml:createTime>
    <wpml:updateTime>${created}</wpml:updateTime>
${config}
    <Folder>
      <wpml:templateType>waypoint</wpml:templateType>
      <wpml:templateId>0</wpml:templateId>
      <wpml:waylineCoordinateSysParam>
        <wpml:coordinateMode>WGS84</wpml:coordinateMode>
        <wpml:heightMode>relativeToStartPoint</wpml:heightMode>
        <wpml:positioningType>GPS</wpml:positioningType>
      </wpml:waylineCoordinateSysParam>
      <wpml:autoFlightSpeed>${one(speedMs)}</wpml:autoFlightSpeed>
      <wpml:globalHeight>${one(plan.options.aglM)}</wpml:globalHeight>
      <wpml:caliFlightEnable>0</wpml:caliFlightEnable>
      <wpml:gimbalPitchMode>usePointSetting</wpml:gimbalPitchMode>
${body}
    </Folder>
  </Document>
</kml>
`;
  const waylinesWpml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"
     xmlns:wpml="${WPML_NAMESPACE}">
  <Document>
${config}
    <Folder>
      <wpml:templateId>0</wpml:templateId>
      <wpml:executeHeightMode>relativeToStartPoint</wpml:executeHeightMode>
      <wpml:waylineId>0</wpml:waylineId>
      <wpml:distance>${Math.round(mission.routeM)}</wpml:distance>
      <wpml:duration>${Math.round(mission.durationS)}</wpml:duration>
      <wpml:autoFlightSpeed>${one(speedMs)}</wpml:autoFlightSpeed>
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
export function readmeText(result, when = new Date()) {
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
    'NOT FLIGHT-TESTED. These files have not been validated on a real aircraft.',
    'Load one at a time: in DJI Fly make a dummy waypoint mission, save it, then',
    'replace its KMZ with one of these (keep the file name DJI Fly gave it).',
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
    if ((result.plan?.jobGrouping ?? 'per-area') !== 'whole' && jobs.length > 1) {
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
  const entries = result.missions.map((mission) => {
    const same = multi
      ? result.missions.filter((item) => item.jobId === mission.jobId)
      : result.missions;
    const index = same.indexOf(mission);
    const job = jobs.find((item) => item.id === mission.jobId);
    const file = kmzFileName(index, same.length, when, multi ? mission.jobName : '');
    const folder = multi ? `${jobFolder(job ?? { id: mission.jobId, name: mission.jobName })}/` : '';
    return {
      name: `${folder}${file}`,
      data: buildKmz(mission, result.plan, { ...opts, when }),
    };
  });
  entries.push({ name: 'README.txt', data: readmeText(result, when) });
  return entries;
}

/** Every mission plus a README, as one ZIP. Jobs get a folder each. */
export function buildBundleZip(result, opts = {}) {
  const when = opts.when ? new Date(opts.when) : new Date();
  return makeZip(bundleEntries(result, { ...opts, when }), when);
}

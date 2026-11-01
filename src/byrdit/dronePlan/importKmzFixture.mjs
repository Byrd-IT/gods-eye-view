// Builds small DJI-style waypoint KMZ files (synthetic coordinates) for tests.
import { makeZip } from './zip.js';

const NS = 'http://www.uav.com/wpmz/1.0.2';

export function group(id, start, end, trigger, param, func = 'takePhoto') {
  return `<wpml:actionGroup><wpml:actionGroupId>${id}</wpml:actionGroupId>
<wpml:actionGroupStartIndex>${start}</wpml:actionGroupStartIndex><wpml:actionGroupEndIndex>${end}</wpml:actionGroupEndIndex>
<wpml:actionGroupMode>parallel</wpml:actionGroupMode><wpml:actionTrigger><wpml:actionTriggerType>${trigger}</wpml:actionTriggerType>${param === undefined ? '' : `<wpml:actionTriggerParam>${param}</wpml:actionTriggerParam>`}</wpml:actionTrigger>
<wpml:action><wpml:actionId>${id}</wpml:actionId><wpml:actionActuatorFunc>${func}</wpml:actionActuatorFunc><wpml:actionActuatorFuncParam><wpml:payloadPositionIndex>0</wpml:payloadPositionIndex></wpml:actionActuatorFuncParam></wpml:action></wpml:actionGroup>`;
}

export function mark(
  i,
  lon,
  lat,
  {
    h = 60,
    speed = 2,
    mode = 'followWayline',
    angle = 0,
    enable = 0,
    pitch = -55,
    groups = '',
    poi = '0,0,0',
  } = {},
) {
  return `<Placemark><Point><coordinates>${lon},${lat}</coordinates></Point><wpml:index>${i}</wpml:index>
<wpml:executeHeight>${h}</wpml:executeHeight><wpml:waypointSpeed>${speed}</wpml:waypointSpeed>
<wpml:waypointHeadingParam><wpml:waypointHeadingMode>${mode}</wpml:waypointHeadingMode><wpml:waypointHeadingAngle>${angle}</wpml:waypointHeadingAngle><wpml:waypointPoiPoint>${poi}</wpml:waypointPoiPoint><wpml:waypointHeadingAngleEnable>${enable}</wpml:waypointHeadingAngleEnable><wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode></wpml:waypointHeadingParam>
<wpml:waypointTurnParam><wpml:waypointTurnMode>toPointAndStopWithDiscontinuityCurvature</wpml:waypointTurnMode><wpml:waypointTurnDampingDist>0</wpml:waypointTurnDampingDist></wpml:waypointTurnParam>
${groups}
<wpml:waypointGimbalHeadingParam><wpml:waypointGimbalPitchAngle>${pitch}</wpml:waypointGimbalPitchAngle><wpml:waypointGimbalYawAngle>0</wpml:waypointGimbalYawAngle></wpml:waypointGimbalHeadingParam></Placemark>`;
}

export function kmz(marks) {
  const way = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${NS}"><Document>
<wpml:missionConfig><wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode><wpml:finishAction>goHome</wpml:finishAction><wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost><wpml:executeRCLostAction>goBack</wpml:executeRCLostAction><wpml:globalTransitionalSpeed>8</wpml:globalTransitionalSpeed><wpml:droneInfo><wpml:droneEnumValue>68</wpml:droneEnumValue><wpml:droneSubEnumValue>0</wpml:droneSubEnumValue></wpml:droneInfo></wpml:missionConfig>
<Folder><wpml:templateId>0</wpml:templateId><wpml:executeHeightMode>relativeToStartPoint</wpml:executeHeightMode><wpml:waylineId>0</wpml:waylineId><wpml:distance>1</wpml:distance><wpml:duration>1</wpml:duration><wpml:autoFlightSpeed>2</wpml:autoFlightSpeed>${marks.join('')}</Folder></Document></kml>`;
  const tpl = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${NS}"><Document><wpml:author>GEV</wpml:author><wpml:createTime>1</wpml:createTime><wpml:updateTime>1</wpml:updateTime>
<wpml:missionConfig><wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode></wpml:missionConfig></Document></kml>`;
  return makeZip([
    { name: 'wpmz/template.kml', data: tpl },
    { name: 'wpmz/waylines.wpml', data: way },
  ]);
}

export const LAT = 30;
export const LON = -97;
// 0.001 degree of longitude at 30 N is about 96.4 m.
export const east = (m) => LON + m / 96412.5;

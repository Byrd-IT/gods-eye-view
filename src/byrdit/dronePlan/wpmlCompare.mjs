/**
 * Structural comparison of two DJI WPML `waylines.wpml` documents.
 *
 * Built to answer one question: does a file GEV writes differ from the file
 * DJI Fly writes when it re-saves it? Everything is compared except what a
 * re-save legitimately changes by itself:
 *  - the coordinates, which only have to agree to within 1 cm;
 *  - template.kml createTime/updateTime (not in waylines.wpml at all).
 * Element names, element ORDER, ids, counts and every text value are compared
 * exactly, so `79` and `79.0` differ.
 *
 * Used by the unit tests (against synthetic, shifted copies of five real DJI
 * Fly re-saves) and by scripts/compare-dji-resave.mjs on real files.
 */

/** Metres per degree of latitude; longitude is scaled by cos(latitude). */
const M_PER_DEG = 111320;

/** A small strict XML reader: enough for WPML/KML. */
export function parseXml(text) {
  const root = { name: '#root', children: [], text: '' };
  const stack = [root];
  const re =
    /<\?[^?]*\?>|<!--[\s\S]*?-->|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const [full, close, name, , selfClose, chars] = m;
    if (chars !== undefined) {
      stack.at(-1).text += chars;
    } else if (name && !close) {
      const node = { name, children: [], text: '' };
      stack.at(-1).children.push(node);
      if (!selfClose) stack.push(node);
    } else if (name && close) {
      const open = stack.pop();
      if (open.name !== name)
        throw new Error(`mismatched </${name}> (open ${open.name})`);
    } else if (!full.startsWith('<?') && !full.startsWith('<!--')) {
      throw new Error(`unparsed markup ${full}`);
    }
  }
  if (stack.length !== 1) throw new Error('unclosed element');
  return root.children[0];
}

const short = (name) => name.replace(/^wpml:/, '');

/** `name=text` for a leaf, `name(child child)` otherwise. Text is trimmed. */
function line(node) {
  if (!node.children.length) return `${short(node.name)}=${node.text.trim()}`;
  return `${short(node.name)}(${node.children.map(line).join(' ')})`;
}

const find = (node, name) => node.children.find((c) => c.name === name);

/**
 * Reduce a waylines.wpml to { config, folder, waypoints: [{ c, s }] }:
 * `c` the [lon, lat] pair and `s` one string with everything else, element
 * order included.
 */
export function summarizeWaylines(xml) {
  const doc = parseXml(xml);
  const document = find(doc, 'Document');
  const config = find(document, 'wpml:missionConfig');
  const folder = find(document, 'Folder');
  const waypoints = folder.children
    .filter((n) => n.name === 'Placemark')
    .map((mark) => {
      const point = mark.children.find((c) => c.name === 'Point');
      const coordinates = point.children[0].text.trim();
      const [lon, lat] = coordinates.split(',').map(Number);
      const rest = mark.children.filter((c) => c.name !== 'Point');
      return { c: [lon, lat], s: rest.map(line).join(' ') };
    });
  return {
    root: document.children.map((c) => short(c.name)),
    config: line(config),
    folder: folder.children
      .filter((n) => n.name !== 'Placemark')
      .map(line)
      .join(' '),
    waypoints,
  };
}

/** Distance in metres between two [lon, lat] pairs (flat-earth, short range). */
export function metresBetween(a, b) {
  const lat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const dx = (a[0] - b[0]) * M_PER_DEG * Math.cos(lat);
  const dy = (a[1] - b[1]) * M_PER_DEG;
  return Math.hypot(dx, dy);
}

/**
 * Differences between two summaries (`a` = ours, `b` = DJI Fly's).
 * @param {object} opts
 * @param {number} [opts.toleranceM=0.01] Coordinate agreement, metres.
 * @param {(index:number, ours:string, theirs:string) => [string,string]} [opts.relax]
 *   Rewrites one waypoint's two strings before they are compared; the only way
 *   to allow a known, named difference.
 * @param {number} [opts.theirCount] Compare only this many of DJI's waypoints
 *   (the hand-added final waypoint of the nadir file is dropped this way).
 * @returns {string[]} empty when the two agree.
 */
export function compareSummaries(a, b, opts = {}) {
  const tol = opts.toleranceM ?? 0.01;
  const out = [];
  if (JSON.stringify(a.root) !== JSON.stringify(b.root))
    out.push(`document children ${a.root} vs ${b.root}`);
  if (a.config !== b.config) out.push(`config\n  ${a.config}\n  ${b.config}`);
  if (a.folder !== b.folder) out.push(`folder\n  ${a.folder}\n  ${b.folder}`);
  const theirs = b.waypoints.slice(0, opts.theirCount ?? b.waypoints.length);
  if (a.waypoints.length !== theirs.length)
    out.push(`waypoint count ${a.waypoints.length} vs ${theirs.length}`);
  const n = Math.min(a.waypoints.length, theirs.length);
  for (let i = 0; i < n; i += 1) {
    const d = metresBetween(a.waypoints[i].c, theirs[i].c);
    if (d > tol)
      out.push(`waypoint ${i} position differs by ${d.toFixed(3)} m`);
    let [x, y] = [a.waypoints[i].s, theirs[i].s];
    if (opts.relax) [x, y] = opts.relax(i, x, y);
    if (x !== y) out.push(`waypoint ${i}\n  ${x}\n  ${y}`);
  }
  return out;
}

/** compareSummaries on two waylines.wpml texts. */
export const compareWaylines = (oursXml, theirsXml, opts) =>
  compareSummaries(
    summarizeWaylines(oursXml),
    summarizeWaylines(theirsXml),
    opts,
  );

const textOf = (node, name) => {
  const hit = (function walk(n) {
    if (n.name === name) return n;
    for (const c of n.children) {
      const f = walk(c);
      if (f) return f;
    }
    return null;
  })(node);
  return hit ? hit.text.trim() : null;
};
const allOf = (node, name, out = []) => {
  if (node.name === name) out.push(node);
  node.children.forEach((c) => allOf(c, name, out));
  return out;
};

/**
 * The planner-side description of a mission, read back from a waylines.wpml
 * that GEV wrote: what assembleMissions() would have handed the writer.
 * A leg starts at every waypoint that carries a gimbalRotate (older GEV
 * files: one per leg) and at the waypoint after one that carries a
 * gimbalEvenlyRotate (DJI Fly's form, written by the current writer). `shift` moves every point by a constant, so a fixture made from a
 * real file can sit somewhere else on the globe.
 * @returns {{ speedMs: number, legs: object[] }}
 */
export function missionFromWaylines(xml, shift = { dlon: 0, dlat: 0 }) {
  const doc = parseXml(xml);
  const marks = allOf(doc, 'Placemark');
  const legs = [];
  let speedMs = null;
  let nextStartsLeg = false;
  for (const mark of marks) {
    const [lon, lat] = textOf(mark, 'coordinates').split(',').map(Number);
    const funcs = allOf(mark, 'wpml:actionActuatorFunc').map((n) =>
      n.text.trim(),
    );
    speedMs ??= Number(textOf(mark, 'wpml:waypointSpeed'));
    const smooth =
      textOf(mark, 'wpml:waypointHeadingMode') === 'smoothTransition';
    if (
      allOf(mark, 'wpml:actionTriggerType').some((n) =>
        ['multipleDistance', 'multipleTiming'].includes(n.text.trim()),
      )
    )
      throw new Error('interval-photo missions cannot be read back');
    const wp = {
      index: Number(textOf(mark, 'wpml:index')),
      lon: Number((lon + shift.dlon).toFixed(8)),
      lat: Number((lat + shift.dlat).toFixed(8)),
      relHeightM: Number(textOf(mark, 'wpml:executeHeight')),
      pitchDeg: Number(textOf(mark, 'wpml:waypointGimbalPitchAngle')),
      photo: funcs.includes('takePhoto'),
      ...(smooth
        ? { headingDeg: Number(textOf(mark, 'wpml:waypointHeadingAngle')) }
        : {}),
    };
    if (funcs.includes('gimbalRotate') || nextStartsLeg || !legs.length)
      legs.push({ photoMode: 'each', waypoints: [] });
    nextStartsLeg = funcs.includes('gimbalEvenlyRotate');
    legs.at(-1).waypoints.push(wp);
  }
  return { speedMs, legs };
}

/** Shift every coordinate of a summary by a constant (fixture making). */
export function shiftSummary(summary, { dlon, dlat }) {
  return {
    ...summary,
    waypoints: summary.waypoints.map((w) => ({
      ...w,
      c: [
        Number((w.c[0] + dlon).toFixed(8)),
        Number((w.c[1] + dlat).toFixed(8)),
      ],
    })),
  };
}

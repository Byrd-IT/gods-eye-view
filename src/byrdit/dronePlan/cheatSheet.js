/**
 * The mission cheat sheet: which plan is which M-number, whether it has been
 * flown, and what to name each placeholder mission in DJI Fly. Pure text/HTML,
 * for the clipboard, a download and the printer.
 *
 * Why placeholders carry the code: DJI Fly keeps a mission's NAME with the
 * placeholder it was made as (not in the KMZ), and MavenBridge / the manual
 * copy only swap the route file. Name the placeholder "M7" once, and the
 * mission that shows as "M7" in DJI Fly always holds plan M7.
 */
import { flightCode } from './missionLabel.js';

const pad = (n) => String(n).padStart(2, '0');

const dateText = (ms) => {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const STATUS = { planned: 'not flown', flown: 'FLOWN', processed: 'FLOWN' };

/** The plans that count: numbered, not in the trash, in number order. */
export function numberedPlans(plans) {
  return (plans ?? [])
    .filter((p) => Number.isInteger(p?.missionNo) && !p.deletedAt)
    .sort((a, b) => a.missionNo - b.missionNo);
}

const flownText = (p) => {
  const flown = p.status === 'flown' || p.status === 'processed';
  if (!flown) return STATUS.planned;
  const when = dateText(p.flownAt);
  return when ? `FLOWN ${when}` : 'FLOWN';
};

export const STEPS = [
  'In DJI Fly on the controller, make a 2-point waypoint mission for each M number below and RENAME it to that number (M1, M2, ...). Do this once; the name stays.',
  'In MavenBridge, pick the mission with that name on the left and the matching M??_*.kmz file on the right, then transfer. (Or copy the KMZ over the placeholder by hand, named <UUID>.kmz.)',
  'After a flight, tick it FLOWN in GEV (Plan library) so you do not fly it twice. Open the mission in DJI Fly once to see the new route (the list picture may still show the old one).',
];

/** Plain text, one line per plan. */
export function cheatSheetText(plans, { when = new Date(), user = '' } = {}) {
  const list = numberedPlans(plans);
  const top = list.at(-1)?.missionNo ?? 0;
  const lines = [
    `GEV mission cheat sheet${user ? ` (${user})` : ''}`,
    `Printed ${dateText(when.getTime())}`,
    '',
    'DJI Fly shows the name of the placeholder mission, not the file. Name the placeholders:',
    ...STEPS.map((s, i) => `  ${i + 1}. ${s}`),
    '',
    'Placeholder name = plan   (a plan that needs more than one battery makes M7-1, M7-2, ...)',
    '',
  ];
  if (!list.length)
    lines.push(
      '(No saved plans yet: save a plan in the Plan library to get its M number.)',
    );
  for (const p of list) {
    const flown = p.status !== 'planned';
    lines.push(
      `  [${flown ? 'x' : ' '}] ${flightCode(p.missionNo).padEnd(5)} ${p.name}${p.site ? ` @ ${p.site}` : ''}  - ${flownText(p)}`,
    );
  }
  if (top) {
    lines.push(
      '',
      `Placeholders to create: ${list.map((p) => flightCode(p.missionNo)).join(', ')}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );

/** A printable page of the same sheet. */
export function cheatSheetHtml(plans, { when = new Date(), user = '' } = {}) {
  const list = numberedPlans(plans);
  const rows = list
    .map((p) => {
      const flown = p.status !== 'planned';
      return `<tr class="${flown ? 'flown' : ''}"><td class="box">${flown ? '&#9745;' : '&#9744;'}</td><td class="code">${esc(flightCode(p.missionNo))}</td><td>${esc(p.name)}${p.site ? ` <small>@ ${esc(p.site)}</small>` : ''}</td><td>${esc(flownText(p))}</td></tr>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>GEV mission cheat sheet</title>
<style>
body{font:15px/1.4 sans-serif;margin:24px;color:#111}
h1{font-size:22px;margin:0 0 4px}
ol{padding-left:20px}
table{border-collapse:collapse;width:100%;margin-top:14px}
td{border-bottom:1px solid #bbb;padding:6px 8px;vertical-align:top}
td.code{font:bold 22px sans-serif;width:70px}
td.box{font-size:22px;width:30px}
tr.flown td{color:#777}
small{color:#555}
</style></head><body>
<h1>GEV mission cheat sheet${user ? ` (${esc(user)})` : ''}</h1>
<div>Printed ${esc(dateText(when.getTime()))}</div>
<p>DJI Fly shows the <b>name of the placeholder</b> mission, not the KMZ file.</p>
<ol>${STEPS.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
<table>${rows || '<tr><td>No saved plans yet.</td></tr>'}</table>
</body></html>
`;
}

/**
 * The block that rides in an export's README: the code, file and controller
 * folder of every flight.
 * @param {{ code: string, title: string, file: string, uuid?: string|null,
 *   preview?: string|null }[]} flights
 */
export function labelReadmeLines(flights) {
  if (!flights.length) return [];
  return [
    'MISSION LABELS (name each placeholder mission in DJI Fly with its code):',
    ...flights.map(
      (f) =>
        `  ${f.code.padEnd(6)} ${f.title}\n         file: ${f.file}${f.uuid ? `\n         controller folder: waypoint/${f.uuid}/${f.uuid}.kmz` : ''}${f.preview ? `\n         picture: ${f.preview}` : ''}`,
    ),
    'DJI Fly takes the NAME from the placeholder mission, not from the KMZ, and',
    'keeps the old list picture until the mission is opened. DJI Mission Installer',
    '(Windows) writes a new list picture with the KMZ FILE NAME on it, so the M??',
    'file names above show up on the controller picture.',
    '',
  ];
}

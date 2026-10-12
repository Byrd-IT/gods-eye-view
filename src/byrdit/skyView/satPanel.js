/**
 * Sky view satellite panel (SKYVIEW.md 4.2, 4.5): "Overhead now" list,
 * class chips, data-set switches (all active, Starlink), GEO belt switch,
 * the element-age banner and the selected-object card. Text builders are
 * pure (tested); buildSatPanel()/renderSatPanel() only touch the DOM.
 */
import { satelliteClassLabel } from '../../data/satelliteClass.js';
import { DROP_DAYS, SKY_CLASSES, STALE_DAYS, STATE } from './satCore.js';
import { skyClassColor, skyClassLabel } from './satOverlay.js';

const DAY_MS = 86_400_000;
export const LIST_LIMIT = 40;
export const CLASS_CHIPS = Object.freeze(
  SKY_CLASSES.map((klass) => ({ klass, label: skyClassLabel(klass) })),
);
export const STATE_TEXT = Object.freeze({
  [STATE.VISIBLE]: 'Visible: sunlit under a dark sky',
  [STATE.SUNLIT_BRIGHT_SKY]:
    'Sunlit, but the sky is too bright (probably not visible)',
  [STATE.SHADOW]: "In the Earth's shadow (radio-visible only)",
});
export const LEGEND_TEXT =
  '● visible · ○ sunlit, bright sky · ◦ in shadow · grey = old elements. Shadow is a cylinder of radius 6,371 km (a second or two of error at the terminator, no penumbra).';

const compass = (az) =>
  ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(az / 45) % 8];

/** Rows for "Overhead now": above 0 deg, chip filter, sorted by elevation. */
export function overheadList(
  objects,
  { classesOn = null, occlusion = () => 'clear', limit = LIST_LIMIT } = {},
) {
  const rows = [];
  for (const o of objects || []) {
    if (!(o.elDeg > 0)) continue;
    if (classesOn && !classesOn.has(o.klass)) continue;
    const occ = occlusion(o.azDeg, o.elDeg);
    if (occ === 'below') continue;
    rows.push({ ...o, behindTerrain: occ === 'terrain' });
  }
  rows.sort((a, b) => b.elDeg - a.elDeg || a.index - b.index);
  return { total: rows.length, rows: rows.slice(0, limit) };
}

/**
 * The catalogue index a click on the "Overhead now" list refers to, or null.
 * Only a row button inside `list` whose data-index is a plain decimal below
 * `size` counts; a click on the list's padding, an <li> gap or anything
 * outside the list selects nothing (Number(null) would be satellite 0).
 */
export function listIndexFromTarget(list, target, size = Infinity) {
  let node = target ?? null;
  let button = null;
  while (node && node !== list) {
    if (!button && String(node.tagName || '').toUpperCase() === 'BUTTON')
      button = node;
    node = node.parentNode ?? null;
  }
  if (!list || node !== list || !button) return null;
  const raw = button.getAttribute?.('data-index');
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const index = Number(raw);
  return Number.isSafeInteger(index) && index < size ? index : null;
}

const fmtUtc = (ms) =>
  new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

/**
 * Element-age banner (SKYVIEW.md 4.5): age of the newest element set used,
 * plus how many objects are greyed (> 7 d) or removed (> 30 d) at Sky time.
 * @returns {{ level: 'ok'|'warn'|'error', text: string }|null}
 */
export function ageBanner(age, timeMs) {
  if (!age || !age.total || !Number.isFinite(age.newestEpochMs)) return null;
  const days = (timeMs - age.newestEpochMs) / DAY_MS;
  const when =
    days >= 0
      ? `${days.toFixed(1)} d before Sky time`
      : `${(-days).toFixed(1)} d after Sky time`;
  const parts = [
    `Elements: newest epoch ${fmtUtc(age.newestEpochMs)} (${when})`,
  ];
  if (age.stale) parts.push(`${age.stale} older than ${STALE_DAYS} d greyed`);
  if (age.dropped) parts.push(`${age.dropped} beyond ${DROP_DAYS} d hidden`);
  const level =
    Math.abs(days) > DROP_DAYS
      ? 'error'
      : Math.abs(days) > STALE_DAYS
        ? 'warn'
        : 'ok';
  return { level, text: parts.join(' · ') };
}

/** Card lines for the selected object (meta + newest row, may be null). */
export function cardData(found, timeMs) {
  if (!found?.meta) return null;
  const { meta, row } = found;
  const classLabel =
    meta.klass === 'other'
      ? 'ACTIVE'
      : meta.klass === 'comms'
        ? 'COMMS · STARLINK'
        : satelliteClassLabel(meta.group, { isIss: meta.noradId === 25544 });
  const ageDays = (timeMs - meta.epochMs) / DAY_MS;
  const lines = [
    ['NORAD', String(meta.noradId)],
    ['Class', classLabel],
  ];
  if (meta.objectId) lines.push(['Intl. id', meta.objectId]);
  if (row && row.elDeg > 0) {
    lines.push(
      [
        'Az / El',
        `${row.azDeg.toFixed(1)}° ${compass(row.azDeg)} / ${row.elDeg.toFixed(1)}°`,
      ],
      ['Range', `${Math.round(row.rangeKm).toLocaleString('en-US')} km`],
      [
        'Range rate',
        `${row.rangeRateKmS >= 0 ? '+' : ''}${row.rangeRateKmS.toFixed(2)} km/s (${row.rangeRateKmS >= 0 ? 'receding' : 'approaching'})`,
      ],
      ['State', STATE_TEXT[row.state] || '—'],
    );
  } else if (Math.abs(ageDays) > DROP_DAYS) {
    lines.push([
      'Position',
      `Hidden: elements more than ${DROP_DAYS} days from Sky time`,
    ]);
  } else {
    lines.push(['Position', 'Below your horizon now']);
  }
  lines.push([
    'Elements',
    `epoch ${fmtUtc(meta.epochMs)}, ${Math.abs(ageDays).toFixed(1)} d ${ageDays >= 0 ? 'old' : 'ahead'}${Math.abs(ageDays) > STALE_DAYS ? ' (old: position less certain)' : ''}`,
  ]);
  return {
    title: meta.name,
    lines,
    aboveHorizon: Boolean(row && row.elDeg > 0),
  };
}

function el(doc, tag, attrs = {}, text) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') node.className = value;
    else node.setAttribute(key, value);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Build the panel DOM (hidden until Sky view is active). */
export function buildSatPanel(doc) {
  const root = el(doc, 'section', {
    className: 'gev-sky-sats',
    'aria-label': 'Satellites overhead',
    'data-sky': 'sats',
  });
  root.hidden = true;
  const head = el(doc, 'div', { className: 'gev-sky-sats-head' });
  const title = el(doc, 'h2', { 'data-sky': 'sats-title' }, 'Overhead now');
  const fold = el(
    doc,
    'button',
    {
      type: 'button',
      'data-sky': 'sats-fold',
      'aria-expanded': 'true',
      'aria-label': 'Show or hide the satellite list',
    },
    '–',
  );
  head.append(title, fold);
  const body = el(doc, 'div', {
    className: 'gev-sky-sats-body',
    'data-sky': 'sats-body',
  });
  const banner = el(doc, 'div', {
    className: 'gev-sky-sats-banner',
    'data-sky': 'sats-banner',
    role: 'status',
    'aria-live': 'polite',
  });
  const chips = el(doc, 'div', {
    className: 'gev-sky-chips',
    role: 'group',
    'aria-label': 'Satellite classes',
  });
  const chipButtons = {};
  for (const { klass, label } of CLASS_CHIPS) {
    const chip = el(
      doc,
      'button',
      {
        type: 'button',
        'data-sky': `chip-${klass}`,
        'aria-pressed': 'true',
        title: `Show ${label}`,
      },
      label,
    );
    if (chip.style) chip.style.borderColor = skyClassColor(klass);
    chipButtons[klass] = chip;
    chips.append(chip);
  }
  const switches = el(doc, 'div', {
    className: 'gev-sky-chips',
    role: 'group',
    'aria-label': 'Satellite data sets',
  });
  const active = el(
    doc,
    'button',
    {
      type: 'button',
      'data-sky': 'set-active',
      'aria-pressed': 'true',
      title: 'Every active satellite (about 16,700, Starlink separately)',
    },
    'All active',
  );
  const starlink = el(
    doc,
    'button',
    {
      type: 'button',
      'data-sky': 'set-starlink',
      'aria-pressed': 'false',
      title: 'Starlink (about 11,000; updated every 2 s)',
    },
    'Starlink',
  );
  const belt = el(
    doc,
    'button',
    {
      type: 'button',
      'data-sky': 'geo-belt',
      'aria-pressed': 'false',
      title: 'Draw the geostationary belt',
    },
    'GEO belt',
  );
  switches.append(active, starlink, belt);
  const legend = el(
    doc,
    'div',
    {
      className: 'gev-sky-sats-legend',
      'data-sky': 'sats-legend',
      title: LEGEND_TEXT,
    },
    '● visible  ○ sunlit, bright sky  ◦ shadow',
  );
  const list = el(doc, 'ul', {
    className: 'gev-sky-sats-list',
    'data-sky': 'sats-list',
    'aria-label': 'Satellites above the horizon, highest first',
  });
  const card = el(doc, 'div', {
    className: 'gev-sky-sats-card',
    'data-sky': 'sats-card',
    role: 'region',
    'aria-label': 'Selected satellite',
  });
  card.hidden = true;
  // The card is built once: the buttons must survive the 1 Hz refresh, or a
  // click that straddles a refresh is lost.
  const cardTitle = el(doc, 'h3', { 'data-sky': 'sats-card-title' });
  const cardLines = el(doc, 'dl', { 'data-sky': 'sats-card-lines' });
  const cardActions = el(doc, 'div', { className: 'gev-sky-sats-actions' });
  const look = el(
    doc,
    'button',
    { type: 'button', 'data-sky': 'sats-look' },
    'Look at it',
  );
  const clear = el(
    doc,
    'button',
    { type: 'button', 'data-sky': 'sats-clear' },
    'Clear',
  );
  cardActions.append(look, clear);
  card.append(cardTitle, cardLines, cardActions);
  body.append(banner, chips, switches, legend, list, card);
  root.append(head, body);
  return {
    root,
    title,
    fold,
    body,
    banner,
    list,
    rows: [],
    card,
    cardTitle,
    cardLines,
    look,
    clear,
    chips: chipButtons,
    active,
    starlink,
    belt,
  };
}

function clearChildren(node) {
  if (typeof node.replaceChildren === 'function') node.replaceChildren();
  else if (Array.isArray(node.children)) node.children.splice(0);
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function setAttr(node, name, value) {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

/**
 * Fill the panel from the current state. Rows and card buttons are updated
 * in place (never rebuilt), and text only changes when it differs, so clicks
 * and screen readers are not disturbed by the 1 Hz refresh.
 */
export function renderSatPanel(
  dom,
  { list, banner, card, status, statusText, selectedIndex, doc },
) {
  if (!dom) return;
  setText(dom.title, list ? `Overhead now (${list.total})` : 'Overhead now');
  if (banner) {
    setText(dom.banner, banner.text);
    setAttr(dom.banner, 'data-level', banner.level);
  } else {
    setText(
      dom.banner,
      statusText || (status === 'loading' ? 'Loading satellites...' : ''),
    );
    setAttr(
      dom.banner,
      'data-level',
      status === 'unavailable' ? 'error' : 'ok',
    );
  }
  const rows = list?.rows || [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let slot = dom.rows[i];
    if (!slot) {
      const li = doc.createElement('li');
      const button = doc.createElement('button');
      button.setAttribute('type', 'button');
      li.append(button);
      dom.list.append(li);
      slot = { li, button };
      dom.rows.push(slot);
    }
    const { button } = slot;
    setAttr(button, 'data-index', String(row.index));
    setAttr(
      button,
      'aria-current',
      row.index === selectedIndex ? 'true' : 'false',
    );
    const flag =
      row.state === STATE.VISIBLE
        ? '●'
        : row.state === STATE.SHADOW
          ? '◦'
          : '○';
    setText(
      button,
      `${flag} ${row.name}  ${Math.round(row.elDeg)}° ${compass(row.azDeg)}${row.behindTerrain ? ' (behind terrain)' : ''}${row.stale ? ' (old)' : ''}`,
    );
    if (button.style)
      button.style.color = row.stale ? '#8a8f96' : skyClassColor(row.klass);
  }
  for (const slot of dom.rows.splice(rows.length)) slot.li.remove?.();
  dom.card.hidden = !card;
  if (card) {
    setText(dom.cardTitle, card.title);
    clearChildren(dom.cardLines);
    for (const [k, v] of card.lines) {
      const dt = doc.createElement('dt');
      dt.textContent = k;
      const dd = doc.createElement('dd');
      dd.textContent = v;
      dom.cardLines.append(dt, dd);
    }
    dom.look.disabled = !card.aboveHorizon;
  }
}

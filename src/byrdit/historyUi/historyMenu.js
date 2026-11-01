/**
 * The History menu (card t_73beacfb): one row per time-capable layer, each
 * with its own time slider, a LIVE button and a lock tick box, plus Lock all
 * and Unlock all. It sits in the Time travel card under the main History
 * control, which stays the slider of the lock group.
 *
 *   ticked   the row follows the shared time (the main control). Moving a
 *            ticked row's slider moves the whole group.
 *   unticked the row keeps its own time; its slider moves only that row.
 *
 * The model is layerClocks.js (pure, tested); this file is the DOM, the
 * wiring to the router / drivers, and the share-URL state (`hl=`).
 */
import { t } from '../../i18n/index.js';
import { formatUtc, HISTORY_FLOOR_MS } from './historyTimeline.js';
import {
  createLayerClocks,
  readHlFromUrl,
  writeHlToUrl,
} from './layerClocks.js';
import { ALL_ROW_DEFS } from './clockRows.js';

export const HISTORY_MENU_ID = 'gev-history-menu';
const STYLE_ID = 'gev-history-menu-style';
const MINUTE = 60_000;

export const HISTORY_MENU_CSS = `
#${HISTORY_MENU_ID} { display: flex; flex-direction: column; gap: 4px; min-width: 0; margin-top: 6px; }
#${HISTORY_MENU_ID} .gev-hm-head { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
#${HISTORY_MENU_ID} .gev-hm-toggle { flex: 1; text-align: left; }
#${HISTORY_MENU_ID} button { font: inherit; color: inherit; background: rgba(255,255,255,0.06); border: 1px solid var(--glass-border, rgba(255,255,255,0.14)); border-radius: 4px; padding: 2px 6px; cursor: pointer; }
#${HISTORY_MENU_ID} .gev-hm-list[hidden] { display: none; }
#${HISTORY_MENU_ID} .gev-hm-list { display: flex; flex-direction: column; gap: 3px; }
#${HISTORY_MENU_ID} .gev-hm-row { display: grid; grid-template-columns: 16px minmax(70px, 1fr) minmax(70px, 2fr) auto auto; gap: 4px; align-items: center; }
#${HISTORY_MENU_ID} .gev-hm-row[hidden] { display: none; }
#${HISTORY_MENU_ID} .gev-hm-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${HISTORY_MENU_ID} .gev-hm-time { font-variant-numeric: tabular-nums; white-space: nowrap; min-width: 9ch; }
#${HISTORY_MENU_ID} .gev-hm-range { width: 100%; min-width: 0; }
#${HISTORY_MENU_ID} .gev-hm-note { grid-column: 2 / -1; color: var(--text-dim, #8a94a0); font-size: 10px; }
#${HISTORY_MENU_ID} .gev-hm-row[data-live="true"] .gev-hm-time { color: var(--text-dim, #8a94a0); }
`;

function el(doc, tag, { cls, attrs, text } = {}) {
  const node = doc.createElement(tag);
  if (cls) node.setAttribute('class', cls);
  for (const [k, v] of Object.entries(attrs ?? {})) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

/**
 * @param {object} o
 * @param {Document} o.document
 * @param {Element} o.parent where the menu is appended
 * @param {Window} [o.window]
 * @param {{enter: Function, seek: Function, leave: Function, getState: Function}} o.control
 *        the main History control (the lock group's slider)
 * @param {(detail: object) => void} o.onRouter gets the main detail + layerTimes
 * @param {Map<string, object>} o.drivers row id -> driver (clockRows.js)
 * @param {(feed: string) => Promise<number|null>} [o.probeEarliest]
 * @param {() => number} [o.now]
 */
export function mountHistoryMenu({
  document: doc,
  parent,
  window: win = globalThis.window,
  control,
  onRouter,
  drivers = new Map(),
  probeEarliest = null,
  now = () => Date.now(),
}) {
  if (!doc?.createElement || !parent) return null;
  if (!doc.getElementById?.(STYLE_ID)) {
    const style = doc.createElement('style');
    style.setAttribute('id', STYLE_ID);
    style.textContent = HISTORY_MENU_CSS;
    (doc.head ?? doc.body).append(style);
  }
  const clocks = createLayerClocks({
    rows: ALL_ROW_DEFS.map((r) => ({
      id: r.id,
      label: r.label,
      adapterIds: r.adapterIds ?? [],
      earliest: r.since ? Date.parse(`${r.since}T00:00:00Z`) : null,
    })),
    now,
  });
  const defs = new Map(ALL_ROW_DEFS.map((r) => [r.id, r]));
  let lastDetail = { active: false, timeMs: null };
  const applied = new Map();
  let destroyed = false;
  let dragging = null;

  const root = el(doc, 'div', { attrs: { id: HISTORY_MENU_ID } });
  const head = el(doc, 'div', { cls: 'gev-hm-head' });
  const toggle = el(doc, 'button', {
    cls: 'gev-hm-toggle',
    attrs: { type: 'button', 'aria-expanded': 'false' },
    text: `▸ ${t('Layer times')}`,
  });
  const lockAll = el(doc, 'button', { attrs: { type: 'button' }, text: t('Lock all') });
  const unlockAll = el(doc, 'button', { attrs: { type: 'button' }, text: t('Unlock all') });
  head.append(toggle, lockAll, unlockAll);
  const list = el(doc, 'div', { cls: 'gev-hm-list' });
  list.hidden = true;
  root.append(head, list);

  const rowEls = new Map();
  for (const def of ALL_ROW_DEFS) {
    const row = el(doc, 'div', { cls: 'gev-hm-row', attrs: { 'data-row': def.id } });
    const lock = el(doc, 'input', {
      cls: 'gev-hm-lock',
      attrs: { type: 'checkbox', 'aria-label': `${t('Lock to the shared time')}: ${t(def.label)}` },
    });
    lock.checked = true;
    const name = el(doc, 'span', { cls: 'gev-hm-name', text: t(def.label) });
    const range = el(doc, 'input', {
      cls: 'gev-hm-range',
      attrs: { type: 'range', 'aria-label': `${t('History time')}: ${t(def.label)}` },
    });
    const time = el(doc, 'span', { cls: 'gev-hm-time', text: t('LIVE') });
    const live = el(doc, 'button', { cls: 'gev-hm-live', attrs: { type: 'button' }, text: t('LIVE') });
    const note = el(doc, 'span', { cls: 'gev-hm-note' });
    note.hidden = true;
    row.append(lock, name, range, time, live, note);
    list.append(row);
    rowEls.set(def.id, { row, lock, range, time, live, note });
    const id = def.id;
    lock.addEventListener('change', () => clocks.setLocked(id, lock.checked));
    range.addEventListener('input', () => {
      dragging = id;
      preview(id);
    });
    range.addEventListener('change', () => {
      dragging = null;
      commit(id);
    });
    live.addEventListener('click', () => goLive(id));
  }

  // ── model -> DOM ──────────────────────────────────────────

  const releasesOf = (id) => clocks.row(id)?.releases ?? null;
  const floorOf = (id) => {
    const e = clocks.row(id)?.earliest;
    return Number.isFinite(e) ? Math.max(e, HISTORY_FLOOR_MS) : HISTORY_FLOOR_MS;
  };

  function configureRange(id) {
    const { range } = rowEls.get(id);
    const rel = releasesOf(id);
    if (rel?.length) {
      range.min = '0';
      range.max = String(rel.length - 1);
      range.step = '1';
    } else {
      range.min = String(Math.ceil(floorOf(id) / MINUTE));
      range.max = String(Math.floor(now() / MINUTE));
      range.step = '1';
    }
  }

  function valueToMs(id, v) {
    const rel = releasesOf(id);
    if (rel?.length) return rel[Math.max(0, Math.min(rel.length - 1, Math.round(v)))];
    return Number(v) * MINUTE;
  }

  function msToValue(id, ms) {
    const rel = releasesOf(id);
    if (rel?.length) {
      let idx = rel.length - 1;
      if (Number.isFinite(ms)) {
        idx = -1;
        for (let i = 0; i < rel.length; i++) if (rel[i] <= ms) idx = i;
        if (idx < 0) idx = 0;
      }
      return idx;
    }
    return Math.floor((Number.isFinite(ms) ? ms : now()) / MINUTE);
  }

  function preview(id) {
    const e = rowEls.get(id);
    e.time.textContent = formatUtc(valueToMs(id, e.range.value), { seconds: false });
  }

  function statusOf(id, ms) {
    const own = drivers.get(id)?.status?.(ms);
    if (own) return own;
    const first = clocks.row(id)?.earliest;
    if (Number.isFinite(ms) && Number.isFinite(first) && ms < first)
      return `${t('No data before')} ${formatUtc(first, { seconds: false })}`;
    return '';
  }

  function render() {
    if (destroyed) return;
    const state = clocks.getState();
    for (const r of state.rows) {
      const e = rowEls.get(r.id);
      const driver = drivers.get(r.id);
      const isDriverRow = !(defs.get(r.id).adapterIds?.length);
      e.row.hidden = isDriverRow && !driver?.available?.();
      if (e.row.hidden) continue;
      if (dragging !== r.id) {
        configureRange(r.id);
        e.range.value = String(msToValue(r.id, r.timeMs));
        e.time.textContent = Number.isFinite(r.timeMs)
          ? formatUtc(r.timeMs, { seconds: false })
          : r.gap
            ? '—'
            : t('LIVE');
      }
      e.lock.checked = r.locked;
      e.row.setAttribute('data-live', String(!Number.isFinite(r.timeMs) && !r.gap));
      e.live.disabled = !Number.isFinite(r.timeMs) && !r.gap;
      const first = releasesOf(r.id)?.[0];
      const note = r.gap
        ? `${t('No data before')} ${Number.isFinite(first) ? formatUtc(first, { seconds: false }) : ''}`.trim()
        : statusOf(r.id, r.timeMs);
      e.note.textContent = note;
      e.note.hidden = !note;
    }
    lockAll.disabled = state.allLocked;
    unlockAll.disabled = state.noneLocked;
  }

  // ── model -> layers ───────────────────────────────────────

  function pushUrl() {
    if (!win?.history?.replaceState || !win?.location?.href) return;
    try {
      const next = writeHlToUrl(win.location.href, clocks.urlEntries());
      if (next !== win.location.href) win.history.replaceState(win.history.state, '', next);
    } catch {
      /* an address we cannot write is not worth breaking the menu */
    }
  }

  function sync() {
    if (destroyed) return;
    const sharedOn = Boolean(lastDetail.active) && Number.isFinite(lastDetail.timeMs);
    clocks.setShared(sharedOn ? lastDetail.timeMs : null);
    // router feeds: the main detail plus each unlocked row's own time
    const layerTimes = clocks.layerTimes();
    onRouter({ ...lastDetail, layerTimes });
    // other layers: only when the time they show changed (the main control
    // repeats its state every 2 s; a layer must not re-fetch for that)
    for (const def of ALL_ROW_DEFS) {
      if (def.adapterIds?.length) continue;
      const driver = drivers.get(def.id);
      if (!driver?.available?.()) continue;
      const eff = clocks.effective(def.id);
      const locked = clocks.isLocked(def.id);
      // a locked row in a gap (before its first release) is not LIVE: leave it
      if (locked && eff === null && sharedOn) continue;
      // a locked row also follows the shared rate / error (GhostMaps)
      const key = `${locked ? 'L' : 'O'}${eff}${locked ? `|${lastDetail.rate ?? ''}|${lastDetail.error ?? ''}` : ''}`;
      // the shared playing state must keep flowing to a locked GhostMaps row
      const follow = locked && sharedOn && lastDetail.playing;
      if ((applied.get(def.id) ?? 'Lnull') === key && !follow) continue;
      applied.set(def.id, key);
      try {
        const out = driver.apply(eff, { detail: locked ? lastDetail : null });
        out?.catch?.(() => {});
      } catch {
        /* a layer that cannot show the time keeps its own view */
      }
    }
    render();
  }

  function onClocks() {
    pushUrl();
    sync();
  }
  const offClocks = clocks.subscribe(onClocks);

  // ── DOM -> model ──────────────────────────────────────────

  function commit(id) {
    const e = rowEls.get(id);
    const ms = valueToMs(id, e.range.value);
    if (clocks.isLocked(id)) {
      // a ticked row moves the whole group
      if (control.getState().active) control.seek(ms);
      else control.enter(ms);
    } else {
      clocks.setOwn(id, ms);
    }
  }

  function goLive(id) {
    if (clocks.isLocked(id)) control.leave();
    else clocks.setLive(id);
  }

  toggle.addEventListener('click', () => {
    list.hidden = !list.hidden;
    toggle.setAttribute('aria-expanded', String(!list.hidden));
    toggle.textContent = `${list.hidden ? '▸' : '▾'} ${t('Layer times')}`;
  });
  lockAll.addEventListener('click', () => clocks.lockAll());
  unlockAll.addEventListener('click', () => clocks.unlockAll());

  // ── start ─────────────────────────────────────────────────

  parent.append(root);
  const fromUrl = win?.location?.href ? readHlFromUrl(win.location.href, now()) : new Map();
  if (fromUrl.size) {
    clocks.applyHl(fromUrl);
    list.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    toggle.textContent = `▾ ${t('Layer times')}`;
  }
  // release lists and coverage starts arrive later (Wayback, NAIP, probes)
  function refreshRowInfo() {
    for (const [id, driver] of drivers) {
      if (!driver.available?.()) continue;
      if (driver.releases) {
        const rel = driver.releases();
        const have = clocks.row(id)?.releases ?? [];
        if (
          rel.length &&
          (rel.length !== have.length ||
            rel[0] !== have[0] ||
            rel.at(-1) !== have.at(-1))
        )
          clocks.setRowInfo(id, { releases: rel });
      }
      const first = driver.earliest?.();
      if (Number.isFinite(first) && first !== clocks.row(id)?.earliest)
        clocks.setRowInfo(id, { earliest: first });
    }
  }
  if (probeEarliest) {
    for (const def of ALL_ROW_DEFS) {
      if (!def.snapFeed) continue;
      Promise.resolve(probeEarliest(def.snapFeed))
        .then((ms) => {
          if (Number.isFinite(ms) && !destroyed) clocks.setRowInfo(def.id, { earliest: ms });
        })
        .catch(() => {});
    }
  }

  const api = {
    root,
    clocks,
    /** The main control's state ('gev:history-time' detail), 2 s heartbeat included. */
    onHistory(detail) {
      lastDetail = detail ?? { active: false, timeMs: null };
      refreshRowInfo();
      sync();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      offClocks();
      root.remove?.();
    },
  };
  refreshRowInfo();
  render();
  return api;
}

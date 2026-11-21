import { createCoverageStore } from './store.js';
import { createCoverageLayer } from './layer.js';
import { photosForCell, coverageCounts } from './coverageCore.js';
import { rankGaps } from './gaps.js';
import { modelLatLon } from './coordinates.js';
import { beginScreenSelection } from './screenSelection.js';

/** Coverage dates arrive as ISO (2026-11-17) or compact (20261117). */
function compactDate(value) {
  const match = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(String(value ?? '').trim());
  return match ? `${match[1]}${match[2]}${match[3]}` : '';
}
/** Read the first numeric field the coverage schema provides. */
function photoNumber(photo, keys) {
  for (const key of keys) {
    const value = photo?.[key];
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return NaN;
}

/** Small Map Layers card section. No request is made until explicitly enabled. */
export function attachCoveragePanel({
  viewer,
  container,
  doc = container?.ownerDocument,
  fetchImpl = globalThis.fetch,
  createLayer = createCoverageLayer,
  beginSelection = beginScreenSelection,
}) {
  if (!container || !doc) return () => {};
  const store = createCoverageStore({ fetchImpl });
  let layer = null,
    epoch = 0,
    selected = null,
    current = null,
    cancelSelection = null,
    multi = [];
  const section = doc.createElement('section');
  section.className = 'gev-photo-coverage';
  const heading = doc.createElement('h3');
  heading.textContent = 'Photo coverage';
  section.append(heading);
  function el(tag, label, parent = section) {
    const n = doc.createElement(tag);
    if (label) n.textContent = label;
    parent.append(n);
    return n;
  }
  const toggle = el('button', 'Show photo coverage');
  toggle.type = 'button';
  const controls = el('div', '');
  controls.hidden = true;
  const model = el('select', '', controls);
  model.setAttribute('aria-label', 'Coverage model');
  for (const id of ['s4_today', 's6_shop800', 'nov16plus']) {
    const o = el('option', id, model);
    o.value = id;
  }
  model.value = 's4_today';
  const filterDate = el('input', '', controls);
  filterDate.type = 'date';
  filterDate.value = '';
  filterDate.setAttribute('aria-label', 'Flight date');
  const minHeight = el('input', '', controls);
  minHeight.type = 'number';
  minHeight.placeholder = 'Min height ft';
  minHeight.setAttribute('aria-label', 'Minimum height in feet');
  const maxHeight = el('input', '', controls);
  maxHeight.type = 'number';
  maxHeight.placeholder = 'Max height ft';
  maxHeight.setAttribute('aria-label', 'Maximum height in feet');
  const minPitch = el('input', '', controls);
  minPitch.type = 'number';
  minPitch.placeholder = 'Min pitch degrees';
  minPitch.setAttribute('aria-label', 'Minimum pitch in degrees');
  const maxPitch = el('input', '', controls);
  maxPitch.type = 'number';
  maxPitch.placeholder = 'Max pitch degrees';
  maxPitch.setAttribute('aria-label', 'Maximum pitch in degrees');
  const flaggedLabel = el('label', 'Flagged only ', controls);
  const flagged = el('input', '', flaggedLabel);
  flagged.type = 'checkbox';
  const status = el('p', '', controls);
  status.setAttribute('role', 'status');
  el(
    'p',
    'Ground: red 0, orange 1-2, yellow 3-4, green 5+ kept views. Cameras: cyan kept, gray discarded, magenta flagged.',
    controls,
  );
  const undo = el('button', 'Undo', controls);
  undo.type = 'button';
  const selectBox = el('button', 'Box select', controls);
  selectBox.type = 'button';
  const selectCircle = el('button', 'Circle select', controls);
  selectCircle.type = 'button';
  const multiStatus = el('span', '0 selected', controls);
  const footprintsLabel = el(
    'label',
    ' Show selected footprints (max 50) ',
    controls,
  );
  const footprints = el('input', '', footprintsLabel);
  footprints.type = 'checkbox';
  const keepSelected = el('button', 'Keep selected', controls);
  keepSelected.type = 'button';
  const discardSelected = el('button', 'Discard selected', controls);
  discardSelected.type = 'button';
  const detail = el('div', '', controls);
  const saveName = el('input', '', controls);
  saveName.placeholder = 'Keep set name';
  saveName.setAttribute('aria-label', 'Keep set name');
  const save = el('button', 'Save keep set', controls);
  save.type = 'button';
  const sets = el('select', '', controls);
  sets.setAttribute('aria-label', 'Saved keep sets');
  const restore = el('button', 'Load keep set', controls);
  restore.type = 'button';
  const gaps = el('div', '', controls);
  container.append(section);
  function report(message) {
    status.textContent = message;
  }
  async function refreshSets() {
    const modelId = store.snapshot()?.model;
    const rows = await store.listSets();
    if (store.snapshot()?.model !== modelId) return;
    if (!Array.isArray(rows)) throw new Error('Invalid keep-set list');
    sets.replaceChildren();
    for (const row of rows) {
      const o = el('option', String(row.name ?? row.file), sets);
      o.value = row.file;
    }
  }
  function showDetail(s) {
    detail.replaceChildren();
    if (!selected) return;
    if (selected.type === 'photo') {
      const p = s.photos.find((x) => x.name === selected.name);
      if (!p) return;
      const title = el('strong', p.name, detail);
      const img = el('img', '', detail);
      img.alt = `Thumbnail: ${p.name}`;
      img.loading = 'lazy';
      img.style.maxWidth = '100%';
      if (
        typeof p.thumb === 'string' &&
        /^thumbs\/[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.jpg$/.test(p.thumb)
      )
        img.src = `/api/byrdit/coverage/${s.model}/${p.thumb}`;
      // Keep/Discard are server-backed and the service only knows placed
      // photos, so an unplaced photo's detail is read-only.
      if (!p.placed) el('div', 'not placed in this model', detail);
      for (const [name, key, unit] of [
        ['Height', 'height_ft', 'ft'],
        ['Gimbal pitch', 'gimbal_pitch', 'deg'],
        ['Flight date', 'flight_date', ''],
        ['Sharpness', 'sharpness', ''],
        ['Brightness', 'brightness', ''],
        ['3D points', 'points3d', ''],
        ['GPS error', 'gps_err_ft', 'ft'],
        ['Splat loss', 'splat_loss', ''],
      ])
        el('div', `${name}: ${p[key] ?? 'unavailable'} ${unit}`, detail);
      if (p.placed)
        for (const keep of [true, false]) {
          const b = el('button', keep ? 'Keep' : 'Discard', detail);
          b.type = 'button';
          b.onclick = () => update(store.setKept([p.name], keep));
        }
    } else {
      const index = s.cells.k.indexOf(selected.key);
      const list =
        index < 0
          ? []
          : photosForCell(
              s.cells,
              s.photos,
              index,
              s.discarded,
              visibleNames(s),
            );
      el('strong', `${list.length} kept photos see this cell`, detail);
      for (const p of list) {
        const b = el('button', p.name, detail);
        b.type = 'button';
        b.onclick = () => {
          selected = { type: 'photo', name: p.name };
          update(store.snapshot());
        };
      }
    }
  }
  function showGaps(s) {
    gaps.replaceChildren();
    el('strong', 'Needs better coverage', gaps);
    for (const gap of s.gaps.slice(0, 8)) {
      const row = el(
        'div',
        `${Math.round(gap.areaM2 * 10.7639)} sq ft; ${gap.zero} zero-coverage cells `,
        gaps,
      );
      const send = el('button', 'Send bounding box to Drone Flight Plan', row);
      send.type = 'button';
      send.onclick = () => {
        const plan = doc.defaultView?.__gevDronePlan;
        if (!plan?.setPolygon) {
          report('Drone Flight Plan is unavailable');
          return;
        }
        const d = s.cells.cell_m;
        let mini = Infinity,
          maxi = -Infinity,
          minj = Infinity,
          maxj = -Infinity;
        for (const k of gap.cells) {
          const i = k % s.cells.nx,
            j = Math.floor(k / s.cells.nx);
          mini = Math.min(mini, i);
          maxi = Math.max(maxi, i);
          minj = Math.min(minj, j);
          maxj = Math.max(maxj, j);
        }
        const x0 = s.cells.x0 + mini * d,
          x1 = s.cells.x0 + (maxi + 1) * d,
          y0 = s.cells.y0 + minj * d,
          y1 = s.cells.y0 + (maxj + 1) * d;
        const ring = [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
        ].map(([x, y]) => modelLatLon(s.meta.origin, x, y));
        if (plan.setPolygon(ring)) {
          plan.open?.({ draw: false });
          report('Gap bounding box added to Drone Flight Plan');
        } else report('Drone Flight Plan did not accept the gap');
      };
    }
  }
  function visibleNames(s) {
    const minH = minHeight.value === '' ? -Infinity : Number(minHeight.value),
      maxH = maxHeight.value === '' ? Infinity : Number(maxHeight.value),
      minP = minPitch.value === '' ? -Infinity : Number(minPitch.value),
      maxP = maxPitch.value === '' ? Infinity : Number(maxPitch.value),
      date = compactDate(filterDate.value);
    return new Set(
      s.photos
        .filter((p) => {
          const height = photoNumber(p, ['height_ft']);
          const gimbal = photoNumber(p, ['gimbal_pitch']);
          const pitch = Number.isFinite(gimbal)
            ? gimbal
            : -photoNumber(p, ['pitch_deg']);
          return (
            (!date || compactDate(p.flight_date) === date) &&
            (!flagged.checked || p.flags?.length) &&
            (!Number.isFinite(minH) || height >= minH) &&
            (!Number.isFinite(maxH) || height <= maxH) &&
            (!Number.isFinite(minP) || pitch >= minP) &&
            (!Number.isFinite(maxP) || pitch <= maxP)
          );
        })
        .map((p) => p.name),
    );
  }
  // Only placed photos exist in the server's keep model. Bulk selection can
  // never carry a GPS-only name into Keep selected / Discard selected.
  function selectableNames(s) {
    return new Set(
      (s?.photos ?? []).filter((p) => p.placed).map((p) => p.name),
    );
  }
  async function update(s) {
    if (!s) return;
    const shown = visibleNames(s),
      selectable = selectableNames(s);
    multi = multi.filter((n) => shown.has(n) && selectable.has(n));
    multiStatus.textContent = `${multi.length} selected`;
    if (selected?.type === 'photo' && !shown.has(selected.name))
      selected = null;
    const counts = coverageCounts(s.cells, s.photos, s.discarded, shown);
    const names = multi.length
      ? multi
      : selected?.type === 'photo'
        ? [selected.name]
        : [];
    s = {
      ...s,
      visibleNames: shown,
      counts,
      footprintNames: footprints.checked
        ? names.filter((n) => shown.has(n))
        : [],
      gaps: rankGaps(s.cells, s.mask, counts),
    };
    current = s;
    const g = ++epoch;
    cancelSelection?.();
    cancelSelection = null;
    layer?.destroy();
    layer = null;
    report('Drawing coverage...');
    showDetail(s);
    showGaps(s);
    try {
      const next = await createLayer({
        viewer,
        state: s,
        onPick: (p) => {
          selected = p;
          multi = [];
          multiStatus.textContent = '0 selected';
          update(store.snapshot());
        },
      });
      if (g !== epoch) {
        next.destroy();
        return;
      }
      layer = next;
      report(
        `${s.photos.length} photos; ${s.discarded.size} discarded${s.footprintNames.length > 50 ? '; first 50 footprints shown' : ''}`,
      );
    } catch (error) {
      if (g === epoch)
        report(
          error?.message === 'Terrain height unavailable'
            ? 'Terrain heights unavailable; enable a terrain source and reopen coverage'
            : 'Coverage map is unavailable',
        );
    }
  }
  async function load() {
    selected = null;
    multi = [];
    multiStatus.textContent = '0 selected';
    cancelSelection?.();
    cancelSelection = null;
    const g = ++epoch;
    layer?.destroy();
    layer = null;
    report('Loading photo coverage...');
    try {
      const s = await store.load(model.value);
      if (g !== epoch || !s) return;
      await update(s);
      if (store.snapshot()?.model === s.model) {
        try {
          await refreshSets();
        } catch {
          report('Keep sets are unavailable');
        }
      }
    } catch {
      if (g === epoch) report('Coverage data is unavailable');
    }
  }
  toggle.onclick = () => {
    if (controls.hidden) {
      controls.hidden = false;
      toggle.textContent = 'Hide photo coverage';
      load();
    } else {
      controls.hidden = true;
      toggle.textContent = 'Show photo coverage';
      epoch++;
      store.clear();
      cancelSelection?.();
      cancelSelection = null;
      layer?.destroy();
      layer = null;
      selected = null;
      multi = [];
      current = null;
    }
  };
  model.onchange = load;
  undo.onclick = () => update(store.undo());
  for (const input of [
    filterDate,
    minHeight,
    maxHeight,
    minPitch,
    maxPitch,
    flagged,
    footprints,
  ])
    input.onchange = () => update(store.snapshot());
  function startSelect(mode) {
    if (!layer?.screenPoints) {
      report('Coverage map is not ready');
      return;
    }
    cancelSelection?.();
    report(`Drag a ${mode} around camera markers; Escape cancels`);
    cancelSelection = beginSelection({
      viewer,
      mode,
      getPoints: () => layer.screenPoints(),
      doc,
      onSelect: (names) => {
        const selectable = selectableNames(current);
        multi = names.filter((n) => selectable.has(n));
        multiStatus.textContent = `${multi.length} selected`;
        cancelSelection = null;
        update(store.snapshot());
      },
    });
  }
  selectBox.onclick = () => startSelect('box');
  selectCircle.onclick = () => startSelect('circle');
  keepSelected.onclick = () => {
    if (multi.length) update(store.setKept(multi, true));
  };
  discardSelected.onclick = () => {
    if (multi.length) update(store.setKept(multi, false));
  };
  save.onclick = async () => {
    try {
      await store.save(saveName.value);
      await refreshSets();
      report('Keep set saved');
    } catch {
      report('Keep set could not be saved');
    }
  };
  restore.onclick = async () => {
    try {
      await update(await store.loadSet(sets.value));
    } catch {
      report('Keep set could not be loaded');
    }
  };
  return () => {
    epoch++;
    store.clear();
    cancelSelection?.();
    layer?.destroy();
    section.remove();
  };
}

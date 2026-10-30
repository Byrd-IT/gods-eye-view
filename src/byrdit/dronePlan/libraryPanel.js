/**
 * The "Plan library" section of the Drone Flight Plan panel: My Plans (open,
 * rename, duplicate, delete, show on map, versions, trash), save, .gevplan
 * export, drone-file import with the DJI compatibility check, and the
 * controller mission ids. All server calls go through libraryClient.js.
 *
 * `host` is what the panel gives this section (see panel.js):
 *   preset()            the selected aircraft preset
 *   droneEnum()         the aircraft-code override or null
 *   snapshot()          the storable plan (planDoc.serializePlan)
 *   load(plan)          restore a stored plan into the panel (async)
 *   imports()           imported drone files held by the panel
 *   addImport(item) / removeImport(id)
 *   controllerIds() / setControllerIds(list)
 *   showOnMap(items)    draw library plans / imports ({id,color,lines,rings,poi})
 *   download(name, bytes, type)
 */
import { t } from '../../i18n/index.js';
import { buildGevPlanFile } from './planDoc.js';
import { checkMission, missionIdFromFileName, parseDjiKmz } from './djiKmz.js';
import { drawableFor, openDroneFile } from './importFile.js';
import { createLibraryClient } from './libraryClient.js';

const COLORS = [
  '#ff9f1c',
  '#2ec4b6',
  '#e71d36',
  '#9b5de5',
  '#00bbf9',
  '#f15bb5',
];

const el = (doc, tag, parent, { text, cls, attrs } = {}) => {
  const node = doc.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  for (const [k, v] of Object.entries(attrs ?? {})) node.setAttribute(k, v);
  parent?.append(node);
  return node;
};

/** Human text for a compatibility finding (see djiKmz.checkMission). */
export function warningText({ code, args = {} }) {
  switch (code) {
    case 'read-empty':
    case 'read-not-a-kmz':
    case 'read-no-wpmz':
    case 'read-bad-xml':
      return t('This is not a DJI waypoint file: it could not be read');
    case 'read-too-large':
      return t('The file is too large');
    case 'namespace':
      return t(
        'Unexpected WPML namespace {found} (DJI Fly writes {expected})',
        args,
      );
    case 'no-waylines':
      return t('No wpmz/waylines.wpml in the file: DJI Fly may not run it');
    case 'template-fallback':
      return t(
        'Waypoints were read from template.kml because waylines.wpml has none',
      );
    case 'template-shape':
      return t(
        'template.kml holds more than author, times and mission settings (DJI Fly writes only those)',
      );
    case 'no-template':
      return t('No wpmz/template.kml in the file');
    case 'no-config':
      return t('No mission settings (missionConfig) found');
    case 'no-drone':
      return t('The file does not say which aircraft it is for');
    case 'drone-mismatch':
      return t(
        'The file is for aircraft code {found}, but {model} uses {expected}',
        args,
      );
    case 'no-waypoints':
      return t('The file has no waypoints');
    case 'too-many':
      return t(
        '{count} waypoints: DJI Fly allows at most {max} per mission',
        args,
      );
    case 'index-gap':
      return t('Waypoint numbers are not 0, 1, 2 ... without gaps');
    case 'bad-coordinates':
      return t('A waypoint has a coordinate that is not on Earth');
    case 'height-mode':
      return t(
        'Height mode is {found}; DJI Fly missions use relativeToStartPoint',
        args,
      );
    case 'no-height':
      return t('A waypoint has no height');
    case 'height-range':
      return t('Heights {min} to {max} m are outside 0 to {limit} m', args);
    case 'speed-range':
      return t('A waypoint speed is missing, zero or above {max} m/s', args);
    case 'poi-missing':
      return t(
        'Waypoint {index} faces a point of interest that is not set',
        args,
      );
    case 'group-mode':
      return t(
        'Action groups are not in parallel mode (DJI Fly writes parallel)',
      );
    case 'group-ids':
      return t('Action group numbers do not start at 1 and rise');
    case 'action-ids':
      return t('Action numbers are not unique across the mission');
    case 'far-apart':
      return t(
        'Two waypoints are {km} km apart: this is not one flyable mission',
        args,
      );
    default:
      return code;
  }
}

const importErrorText = (code) =>
  ({
    empty: t('The file is empty'),
    'too-large': t('The file is too large'),
    'not-a-plan': t('This is not a GEV plan file'),
    'newer-version': t('This plan file is from a newer GEV version'),
    'not-a-kmz': t('This is not a KMZ file'),
    'no-wpmz': t('This KMZ has no DJI waypoint mission (wpmz folder)'),
    'bad-xml': t('The mission file in this KMZ is damaged'),
    'no-waypoints': t('The file has no waypoints'),
  })[code] ?? t('The file could not be opened');

const apiErrorText = (e) =>
  ({
    'no-identity': t('Sign in through byrd-it.com to save plans'),
    forbidden: t('That is not your plan'),
    'read-only': t('Other users plans are read-only'),
    'not-found': t('That plan no longer exists'),
    'too-large': t('The plan is too large'),
    'too-many': t('Too many plans: delete some first'),
    'in-trash': t('Restore the plan from the trash first'),
    'name-required': t('A plan needs a name'),
    offline: t('The plan library cannot be reached'),
  })[e?.code] ?? t('The plan library had an error');

/**
 * @param {{ doc: Document, container: HTMLElement, host: object,
 *   client?: ReturnType<typeof createLibraryClient>, status: (text: string, tone?: string) => void }} args
 */
export function mountLibrary({
  doc,
  container,
  host,
  client = createLibraryClient(),
  status,
}) {
  const s = {
    me: { library: false },
    scope: 'mine',
    trash: false,
    plans: [],
    current: null, // { id, owner, version, readOnly }
    shown: new Map(), // plan id -> { color, drawable }
    findings: [],
    findingsTitle: '',
    busy: false,
  };
  let colorIndex = 0;
  const importColors = new Map();
  const colorFor = (id) => {
    if (!importColors.has(id))
      importColors.set(id, COLORS[colorIndex++ % COLORS.length]);
    return importColors.get(id);
  };

  const root = el(doc, 'section', container, {
    cls: 'gev-dp-library',
    attrs: { 'data-role': 'plan-library' },
  });
  el(doc, 'h4', root, { cls: 'gev-dp-subtitle', text: t('PLAN LIBRARY') });
  const note = el(doc, 'p', root, {
    cls: 'gev-dp-note',
    attrs: { 'data-role': 'library-note' },
  });
  const form = el(doc, 'div', root, { cls: 'gev-dp-library-form' });
  const input = (label, name, tag = 'input') => {
    const row = el(doc, 'label', form, { cls: 'gev-dp-row' });
    el(doc, 'span', row, { cls: 'gev-dp-label', text: label });
    const control = el(doc, tag, row, {
      cls: 'gev-field gev-field--compact',
      attrs:
        tag === 'input'
          ? { type: 'text', maxlength: '200', 'data-field': name }
          : { rows: '2', maxlength: '5000', 'data-field': name },
    });
    return control;
  };
  const f = {
    name: input(t('Plan name'), 'name'),
    site: input(t('Site'), 'site'),
    customer: input(t('Customer'), 'customer'),
    notes: input(t('Notes'), 'notes', 'textarea'),
  };
  const statusRow = el(doc, 'label', form, { cls: 'gev-dp-row' });
  el(doc, 'span', statusRow, { cls: 'gev-dp-label', text: t('Status') });
  f.status = el(doc, 'select', statusRow, {
    cls: 'pp-select gev-field gev-field--compact',
    attrs: { 'data-field': 'status', 'aria-label': t('Status') },
  });
  for (const [v, label] of [
    ['planned', t('Planned')],
    ['flown', t('Flown')],
    ['processed', t('Processed')],
  ]) {
    el(doc, 'option', f.status, { text: label, attrs: { value: v } });
  }
  f.controllers = input(
    t('Controller mission IDs (one per flight, one per line)'),
    'controller-ids',
    'textarea',
  );

  const buttons = el(doc, 'div', root, { cls: 'gev-dp-library-buttons' });
  const button = (label, action, title) =>
    el(doc, 'button', buttons, {
      cls: 'data-toggle-chip',
      text: label,
      attrs: {
        type: 'button',
        'data-action': action,
        ...(title ? { title } : {}),
      },
    });
  const saveBtn = button(
    t('SAVE PLAN'),
    'library-save',
    t('Save the plan in your library (a new version if it is already saved)'),
  );
  const saveNewBtn = button(t('SAVE AS NEW'), 'library-save-new');
  const exportBtn = button(
    t('EXPORT .GEVPLAN'),
    'library-export-gevplan',
    t('Download the full editable plan as a file'),
  );
  const fileInput = el(doc, 'input', root, {
    cls: 'gev-dp-file',
    attrs: {
      type: 'file',
      accept: '.kmz,.gevplan,.json',
      'data-role': 'library-import',
      'aria-label': t('Import a drone file'),
    },
  });
  el(doc, 'p', root, {
    cls: 'gev-dp-note',
    text: t(
      'Import a DJI Fly KMZ, a GEV KMZ or a .gevplan file. It is drawn on the map and checked against DJI Fly.',
    ),
  });

  const filterRow = el(doc, 'div', root, { cls: 'gev-dp-library-filter' });
  const scopeSel = el(doc, 'select', filterRow, {
    cls: 'pp-select gev-field gev-field--compact',
    attrs: { 'data-role': 'library-scope', 'aria-label': t('Show plans of') },
  });
  scopeSel.hidden = true;
  el(doc, 'option', scopeSel, {
    text: t('My plans'),
    attrs: { value: 'mine' },
  });
  el(doc, 'option', scopeSel, {
    text: t('All users'),
    attrs: { value: 'all' },
  });
  const trashBtn = el(doc, 'button', filterRow, {
    cls: 'data-toggle-chip',
    text: t('TRASH'),
    attrs: {
      type: 'button',
      'data-action': 'library-trash-toggle',
      'aria-pressed': 'false',
    },
  });
  const list = el(doc, 'div', root, {
    cls: 'gev-dp-library-list',
    attrs: { 'data-role': 'library-list' },
  });
  const importsBox = el(doc, 'div', root, {
    cls: 'gev-dp-library-imports',
    attrs: { 'data-role': 'library-imports' },
  });
  const findingsBox = el(doc, 'div', root, {
    cls: 'gev-dp-library-findings',
    attrs: { 'data-role': 'library-findings', 'aria-live': 'polite' },
  });

  const details = () => ({
    name: f.name.value.trim(),
    site: f.site.value.trim(),
    customer: f.customer.value.trim(),
    notes: f.notes.value,
    status: f.status.value,
  });
  const setDetails = (d = {}) => {
    f.name.value = d.name ?? '';
    f.site.value = d.site ?? '';
    f.customer.value = d.customer ?? '';
    f.notes.value = d.notes ?? '';
    f.status.value = d.status ?? 'planned';
  };
  const parseIds = () =>
    f.controllers.value
      .split(/\r?\n/)
      .map((line) => missionIdFromFileName(`${line.trim()}.kmz`));
  const syncIds = () => host.setControllerIds(parseIds());
  f.controllers.addEventListener('change', syncIds);

  const fail = (e) => status(apiErrorText(e), 'warn');
  const readOnly = () => Boolean(s.current?.readOnly);

  function renderFindings() {
    findingsBox.replaceChildren();
    if (!s.findings.length && !s.findingsTitle) return;
    el(doc, 'p', findingsBox, { cls: 'gev-dp-note', text: s.findingsTitle });
    if (!s.findings.length) {
      el(doc, 'p', findingsBox, {
        cls: 'gev-dp-note',
        text: t('No problems found against the DJI Fly checks'),
      });
    }
    for (const w of s.findings) {
      el(doc, 'p', findingsBox, {
        cls: 'gev-dp-warning',
        text: warningText(w),
        attrs: { 'data-level': w.level, 'data-code': w.code },
      });
    }
    el(doc, 'p', findingsBox, {
      cls: 'gev-dp-note',
      text: t(
        'Photo actions (takePhoto), distance-interval photos and smooth-transition orbit headings are not yet verified by a real DJI Fly file.',
      ),
    });
  }

  function drawMap() {
    const items = [];
    for (const [id, v] of s.shown)
      items.push(
        v.drawable ?? { id, color: v.color, lines: [], rings: [], poi: [] },
      );
    for (const imp of host.imports()) {
      if (imp.hidden) continue;
      items.push({
        id: imp.id,
        color: colorFor(imp.id),
        lines: [imp.waypoints],
        rings: [],
        poi: imp.waypoints.filter((w) => w.poi).map((w) => w.poi),
      });
    }
    host.showOnMap(items);
  }

  function renderImports() {
    importsBox.replaceChildren();
    for (const imp of host.imports()) {
      const row = el(doc, 'div', importsBox, {
        cls: 'gev-dp-mission',
        attrs: { 'data-import': imp.id },
      });
      const box = el(doc, 'input', row, {
        cls: 'gev-dp-pass-visible',
        attrs: { type: 'checkbox', 'aria-label': t('Show on map') },
      });
      box.checked = !imp.hidden;
      box.addEventListener('change', () => {
        imp.hidden = !box.checked;
        drawMap();
      });
      const sw = el(doc, 'span', row, { cls: 'gev-dp-swatch' });
      sw.style.background = colorFor(imp.id);
      el(doc, 'span', row, {
        cls: 'gev-dp-mission-label',
        text: `${imp.name} (${t('{count} waypoints', { count: imp.waypoints.length })})`,
      });
      const saveImp = el(doc, 'button', row, {
        cls: 'data-toggle-chip',
        text: t('SAVE TO LIBRARY'),
        attrs: { type: 'button', 'data-action': 'import-save' },
      });
      saveImp.disabled = !s.me.library;
      saveImp.addEventListener('click', () => saveImport(imp));
      const rm = el(doc, 'button', row, {
        cls: 'data-toggle-chip',
        text: t('REMOVE'),
        attrs: { type: 'button', 'data-action': 'import-remove' },
      });
      rm.addEventListener('click', () => {
        host.removeImport(imp.id);
        renderImports();
        drawMap();
      });
    }
  }

  function renderList() {
    list.replaceChildren();
    if (!s.me.library) return;
    if (!s.plans.length) {
      el(doc, 'p', list, {
        cls: 'gev-dp-note',
        text: s.trash ? t('The trash is empty') : t('No saved plans yet'),
      });
    }
    for (const plan of s.plans) {
      const mine = plan.owner === s.me.user;
      const row = el(doc, 'div', list, {
        cls: 'gev-dp-mission gev-dp-library-row',
        attrs: { 'data-plan': plan.id, 'data-owner': plan.owner },
      });
      if (!s.trash) {
        const box = el(doc, 'input', row, {
          cls: 'gev-dp-pass-visible',
          attrs: { type: 'checkbox', 'aria-label': t('Show on map') },
        });
        box.checked = s.shown.has(plan.id);
        box.addEventListener('change', () => toggleShown(plan, box.checked));
        const sw = el(doc, 'span', row, { cls: 'gev-dp-swatch' });
        sw.style.background = s.shown.get(plan.id)?.color ?? 'transparent';
      }
      const owner = !mine ? ` [${plan.owner}]` : '';
      el(doc, 'span', row, {
        cls: 'gev-dp-mission-label',
        text: `${plan.name}${owner} · ${statusLabel(plan.status)} · v${plan.version}${plan.site ? ` · ${plan.site}` : ''}`,
        attrs: { title: new Date(plan.updatedAt).toLocaleString() },
      });
      const act = (label, action, fn, show = true) => {
        if (!show) return;
        const b = el(doc, 'button', row, {
          cls: 'data-toggle-chip',
          text: label,
          attrs: { type: 'button', 'data-action': action },
        });
        b.addEventListener('click', () => fn(plan));
      };
      if (s.trash) {
        act(t('RESTORE'), 'plan-restore', restorePlan, mine);
      } else {
        act(t('OPEN'), 'plan-open', openPlan);
        act(t('RENAME'), 'plan-rename', renamePlan, mine);
        act(t('DUPLICATE'), 'plan-duplicate', duplicatePlan, mine);
        act(t('VERSIONS'), 'plan-versions', showVersions);
        act(t('DELETE'), 'plan-delete', deletePlan, mine);
      }
    }
  }

  const statusLabel = (v) =>
    ({ planned: t('Planned'), flown: t('Flown'), processed: t('Processed') })[
      v
    ] ?? v;

  function renderNote() {
    if (!s.me.library) {
      note.textContent = t('Sign in through byrd-it.com to save plans');
    } else {
      note.textContent = s.current
        ? readOnly()
          ? t('Viewing {name} of {owner} (read-only)', {
              name: s.current.name,
              owner: s.current.owner,
            })
          : t('Editing {name} (version {version})', {
              name: s.current.name,
              version: s.current.version,
            })
        : t('Signed in as {user}', { user: s.me.user });
    }
    const on = s.me.library;
    for (const b of [saveBtn, saveNewBtn]) b.disabled = !on || s.busy;
    saveBtn.disabled = !on || s.busy || readOnly();
    trashBtn.disabled = !on;
    scopeSel.hidden = !s.me.admin;
    f.name.disabled = false;
  }

  async function refresh() {
    if (!s.me.library) {
      s.plans = [];
      renderNote();
      renderList();
      return;
    }
    try {
      const out = await client.list({ scope: s.scope, trash: s.trash });
      s.plans = out.plans ?? [];
    } catch (e) {
      fail(e);
      s.plans = [];
    }
    renderNote();
    renderList();
  }

  async function guarded(fn) {
    if (s.busy) return;
    s.busy = true;
    renderNote();
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      s.busy = false;
      renderNote();
    }
  }

  const planBody = () => {
    syncIds();
    return host.snapshot();
  };

  const saveCurrent = (asNew) =>
    guarded(async () => {
      const d = details();
      if (!d.name) {
        status(t('A plan needs a name'), 'warn');
        return;
      }
      const body = planBody();
      let out;
      if (!asNew && s.current && !readOnly()) {
        out = await client.save(s.current.id, body, d);
      } else {
        out = await client.create(d, body);
      }
      s.current = { ...out.plan, readOnly: false };
      status(
        t('Saved {name} (version {version})', {
          name: out.plan.name,
          version: out.plan.version,
        }),
        'info',
      );
      await refresh();
    });

  async function saveImport(imp) {
    await guarded(async () => {
      const plan = host.snapshot();
      const only = {
        ...plan,
        areas: [],
        imports: [imp],
        controllerIds: imp.uuid ? [imp.uuid] : [],
      };
      const out = await client.create(
        { name: imp.name, status: 'planned' },
        only,
      );
      status(
        t('Saved {name} (version {version})', {
          name: out.plan.name,
          version: 1,
        }),
        'info',
      );
      await refresh();
    });
  }

  async function openPlan(plan) {
    await guarded(async () => {
      const mine = plan.owner === s.me.user;
      const out = await client.open(plan.id, {
        owner: mine ? undefined : plan.owner,
      });
      setDetails(out.meta);
      s.current = {
        id: plan.id,
        owner: plan.owner,
        name: out.meta.name,
        version: out.version,
        readOnly: !mine,
      };
      await host.load(out.plan);
      f.controllers.value = (host.controllerIds() ?? [])
        .filter(Boolean)
        .join('\n');
      renderImports();
      drawMap();
      status(t('Opened {name}', { name: out.meta.name }), 'info');
    });
  }

  async function toggleShown(plan, on) {
    if (!on) {
      s.shown.delete(plan.id);
      drawMap();
      renderList();
      return;
    }
    try {
      const mine = plan.owner === s.me.user;
      const out = await client.open(plan.id, {
        owner: mine ? undefined : plan.owner,
      });
      const color = COLORS[colorIndex++ % COLORS.length];
      s.shown.set(plan.id, {
        color,
        drawable: drawableFor(plan.id, color, out.plan),
      });
    } catch (e) {
      fail(e);
    }
    drawMap();
    renderList();
  }

  const renamePlan = (plan) =>
    guarded(async () => {
      const name = (
        doc.defaultView?.prompt?.(t('New name'), plan.name) ?? ''
      ).trim();
      if (!name || name === plan.name) return;
      await client.update(plan.id, { name });
      if (s.current?.id === plan.id) {
        s.current.name = name;
        f.name.value = name;
      }
      await refresh();
    });

  const duplicatePlan = (plan) =>
    guarded(async () => {
      await client.duplicate(plan.id);
      await refresh();
    });

  const deletePlan = (plan) =>
    guarded(async () => {
      if (
        doc.defaultView?.confirm &&
        !doc.defaultView.confirm(
          t('Move {name} to the trash? It is kept for 30 days.', {
            name: plan.name,
          }),
        )
      )
        return;
      await client.trash(plan.id);
      s.shown.delete(plan.id);
      if (s.current?.id === plan.id) s.current = null;
      drawMap();
      await refresh();
    });

  const restorePlan = (plan) =>
    guarded(async () => {
      await client.restore(plan.id);
      await refresh();
    });

  const showVersions = (plan) =>
    guarded(async () => {
      const mine = plan.owner === s.me.user;
      const out = await client.versions(plan.id, {
        owner: mine ? undefined : plan.owner,
      });
      const row = list.querySelector(`[data-plan="${plan.id}"]`);
      row?.querySelector('.gev-dp-versions')?.remove();
      const box = el(doc, 'div', row ?? list, { cls: 'gev-dp-versions' });
      for (const v of out.versions) {
        const line = el(doc, 'div', box, {
          cls: 'gev-dp-mission',
          attrs: { 'data-version': String(v.version) },
        });
        el(doc, 'span', line, {
          cls: 'gev-dp-mission-label',
          text: `v${v.version} · ${new Date(v.savedAt).toLocaleString()}`,
        });
        const open = el(doc, 'button', line, {
          cls: 'data-toggle-chip',
          text: t('OPEN'),
          attrs: { type: 'button' },
        });
        open.addEventListener('click', () =>
          guarded(async () => {
            const got = await client.open(plan.id, {
              owner: mine ? undefined : plan.owner,
              version: v.version,
            });
            s.current = {
              id: plan.id,
              owner: plan.owner,
              name: got.meta.name,
              version: got.version,
              readOnly: !mine,
            };
            await host.load(got.plan);
            drawMap();
          }),
        );
        if (mine && v.version !== plan.version) {
          const rest = el(doc, 'button', line, {
            cls: 'data-toggle-chip',
            text: t('RESTORE'),
            attrs: { type: 'button', 'data-action': 'version-restore' },
          });
          rest.addEventListener('click', () =>
            guarded(async () => {
              await client.restoreVersion(plan.id, v.version);
              await refresh();
            }),
          );
        }
      }
    });

  saveBtn.addEventListener('click', () => saveCurrent(false));
  saveNewBtn.addEventListener('click', () => saveCurrent(true));
  exportBtn.addEventListener('click', () => {
    const d = details();
    const text = buildGevPlanFile(d, planBody());
    const base =
      (d.name || 'gev-plan').replace(/[^\w.-]+/g, '-').slice(0, 60) ||
      'gev-plan';
    host.download(
      `${base}.gevplan`,
      new TextEncoder().encode(text),
      'application/json',
    );
  });
  trashBtn.addEventListener('click', () => {
    s.trash = !s.trash;
    trashBtn.setAttribute('aria-pressed', String(s.trash));
    refresh();
  });
  scopeSel.addEventListener('change', () => {
    s.scope = scopeSel.value;
    refresh();
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      status(importErrorText('too-large'), 'warn');
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    await importBytes(bytes, file.name);
  });

  async function importBytes(bytes, fileName) {
    const out = await openDroneFile(bytes, fileName, {
      preset: host.preset(),
      droneEnumValue: host.droneEnum(),
    });
    if (out.kind === 'error') {
      s.findings = out.warnings ?? [];
      s.findingsTitle = `${fileName}: ${importErrorText(out.code)}`;
      renderFindings();
      status(importErrorText(out.code), 'warn');
      return out;
    }
    if (out.kind === 'gevplan') {
      setDetails(out.details);
      s.current = null;
      await host.load(out.plan);
      f.controllers.value = (host.controllerIds() ?? [])
        .filter(Boolean)
        .join('\n');
      renderImports();
      drawMap();
      renderNote();
      s.findings = [];
      s.findingsTitle = '';
      renderFindings();
      status(
        t('Opened {name}', { name: out.details.name || fileName }),
        'info',
      );
      return out;
    }
    host.addImport(out.item);
    if (out.item.uuid) {
      const ids = host.controllerIds().filter(Boolean);
      if (!ids.includes(out.item.uuid))
        host.setControllerIds([...ids, out.item.uuid]);
      f.controllers.value = host.controllerIds().filter(Boolean).join('\n');
    }
    s.findings = out.warnings;
    s.findingsTitle = t('Compatibility check of {name}', { name: fileName });
    renderFindings();
    renderImports();
    drawMap();
    status(
      t('{name}: {count} waypoints drawn on the map', {
        name: out.item.name,
        count: out.item.waypoints.length,
      }),
      'info',
    );
    return out;
  }

  /**
   * Check the KMZ files this tool just built (called by the panel on every
   * export). `files` is [{ bytes, name }]; findings are merged by code.
   */
  async function checkExport(files, title) {
    const seen = new Map();
    for (const { bytes, name } of files.slice(0, 12)) {
      const mission = await parseDjiKmz(bytes, { fileName: name });
      for (const w of checkMission(mission, {
        preset: host.preset(),
        droneEnumValue: host.droneEnum(),
      })) {
        if (!seen.has(w.code)) seen.set(w.code, w);
      }
    }
    s.findings = [...seen.values()];
    s.findingsTitle = t('Compatibility check of {name}', { name: title });
    renderFindings();
    return s.findings;
  }

  async function init() {
    try {
      s.me = await client.me();
    } catch {
      s.me = { library: false };
    }
    scopeSel.hidden = !s.me.admin;
    renderNote();
    await refresh();
    renderImports();
  }

  setDetails();
  renderNote();
  init();

  return {
    refresh,
    importBytes,
    checkExport,
    renderImports,
    state: s,
    destroy() {
      root.remove?.();
    },
  };
}

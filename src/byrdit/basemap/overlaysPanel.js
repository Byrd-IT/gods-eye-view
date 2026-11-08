import { t } from '../../i18n/index.js';
import { ensureMapLayersCard } from './mapLayersCard.js';
import { syncChipGroup } from '../../ui/chipGroup.js';
import { createSlider } from '../../ui/slider.js';
import {
  ALL_OVERLAY_GROUPS,
  groupOfOverlay,
  overlayMatches,
} from './overlayGroups.js';

/**
 * Map layers panel (BASEMAP M2 follow-up): one row per overlay with a
 * checkbox, an opacity range and raise/lower buttons. In the Map layers rail
 * card (grouped) the rows sit in collapsible groups (Lakes, Topo, Hillshade
 * ...) under a search box; elsewhere (and in tests) they are one flat list,
 * top of the stack first. Floats bottom-left when no card can host it.
 * Plain DOM, text via textContent only.
 */

export const OVERLAYS_PANEL_ID = 'gev-overlays-panel';

/** Groups that start expanded in the card; the others open on demand. */
const DEFAULT_OPEN_GROUPS = Object.freeze(['lakes', 'byrd-ranch']);

// All look and layout is CSS (src/ui/styles/map-layers.css, .gev-ov-*) on the
// shared tokens; raise/lower are the shared .data-toggle-chip (chipGroup.js)
// and the opacity range is the shared .gev-quantitative-slider (ui/slider.js).

/** What a 3D row says while its model loads or when it did not load. */
function loadNote(status) {
  if (status === 'loading') return t('Loading 3D model...');
  if (status === 'failed') return t('The 3D model could not be loaded');
  return '';
}

function el(doc, tag, parent, { text, cls, attrs } = {}) {
  const node = doc.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  for (const [k, v] of Object.entries(attrs ?? {})) node.setAttribute(k, v);
  parent?.append(node);
  return node;
}

/**
 * @param {{container: object, state: {layers: object[]}, onEnabled: Function,
 *   onOpacity: Function, onMove?: Function, onCanopy?: Function,
 *   onFlyTo?: Function, embedded?: boolean,
 *   grouped?: boolean, onOpenAerial?: Function|null, doc?: object}} options
 */
export function createOverlaysPanel({
  container,
  state,
  onEnabled,
  onOpacity,
  onMove = () => {},
  onCanopy = () => {},
  onFlyTo = () => {},
  embedded = false,
  grouped = false,
  onOpenAerial = null,
  doc = container?.ownerDocument ?? globalThis.document,
}) {
  if (!doc?.createElement || !container) return null;
  const panel = el(doc, 'div', null, {
    attrs: {
      id: OVERLAYS_PANEL_ID,
      role: 'group',
      'aria-label': t('Map layers'),
      ...(embedded ? { 'data-embedded': 'true' } : {}),
    },
    cls: embedded ? 'gev-ov-panel' : 'gev-ov-panel gev-ov-float',
  });

  // ---- grouped chrome: search, aerial hint, empty note, group sections ----
  const groups = new Map(); // group id -> {section, head, count, body, open, title}
  let search = null;
  let empty = null;
  let query = '';
  if (grouped) {
    const bar = el(doc, 'div', panel, { cls: 'gev-ov-search' });
    search = el(doc, 'input', bar, {
      cls: 'gev-ov-search-input',
      attrs: {
        type: 'search',
        'aria-label': t('Search map layers'),
        placeholder: t('Search map layers'),
        autocomplete: 'off',
        spellcheck: 'false',
      },
    });
    if (typeof onOpenAerial === 'function') {
      const aerial = el(doc, 'button', panel, {
        cls: 'data-toggle-chip gev-ov-aerial',
        text: t('Aerial and historic imagery: open Time Travel'),
        attrs: { type: 'button' },
      });
      aerial.addEventListener('click', () => onOpenAerial());
    }
    empty = el(doc, 'p', panel, {
      cls: 'gev-ov-empty',
      text: t('No map layers match your search'),
      attrs: { role: 'status' },
    });
    empty.hidden = true;
    for (const group of ALL_OVERLAY_GROUPS) {
      const section = el(doc, 'section', panel, {
        cls: 'gev-ov-group',
        attrs: { 'data-group': group.id },
      });
      const title = t(group.title);
      const head = el(doc, 'button', section, {
        cls: 'gev-ov-group-head',
        attrs: { type: 'button', 'aria-expanded': 'false' },
      });
      const caret = el(doc, 'span', head, {
        cls: 'gev-ov-group-caret',
        attrs: { 'aria-hidden': 'true' },
      });
      el(doc, 'span', head, { cls: 'gev-ov-group-title', text: title });
      const count = el(doc, 'span', head, { cls: 'gev-ov-group-count' });
      const body = el(doc, 'div', section, { cls: 'gev-ov-group-body' });
      const entry = {
        section,
        head,
        count,
        caret,
        body,
        title,
        open: DEFAULT_OPEN_GROUPS.includes(group.id),
        rows: 0,
      };
      head.addEventListener('click', () => {
        // While searching every matching group is forced open, so a click
        // would change nothing on screen: ignore it and keep the saved state.
        if (query.trim() !== '') return;
        entry.open = !entry.open;
        applyView();
      });
      groups.set(group.id, entry);
    }
  }

  const rows = new Map();
  const rowGroup = new Map(); // layer id -> group id
  for (const layer of state.layers) {
    const groupId = groupOfOverlay(layer.id).id;
    rowGroup.set(layer.id, groupId);
    const row = el(doc, 'div', grouped ? groups.get(groupId).body : panel, {
      cls: 'gev-ov-row',
      attrs: { 'data-overlay': layer.id },
    });
    if (grouped) groups.get(groupId).rows += 1;
    const head = el(doc, 'div', row, { cls: 'gev-ov-head' });
    const label = el(doc, 'label', head, {
      text: ` ${layer.name}`,
      cls: 'gev-ov-name',
    });
    const box = el(doc, 'input', null, {
      attrs: { type: 'checkbox', 'aria-label': layer.name },
    });
    label.prepend(box);
    const moves = el(doc, 'span', head, { cls: 'gev-ov-moves' });
    const moveSpecs = [
      ['up', '\u25B2', t('Raise layer')],
      ['down', '\u25BC', t('Lower layer')],
    ];
    syncChipGroup(
      moves,
      moveSpecs.map(([direction, glyph, text]) => ({
        id: direction,
        label: glyph,
        title: text,
      })),
    );
    const [up, down] = [...moves.children];
    moveSpecs.forEach(([direction, , text], i) => {
      const button = [up, down][i];
      button.setAttribute('data-move', direction);
      button.setAttribute('aria-label', `${text}: ${layer.name}`);
      // Actions, not toggles: drop the pressed/busy state chips carry.
      button.removeAttribute?.('aria-pressed');
      button.removeAttribute?.('aria-busy');
      button.addEventListener('click', () => onMove(layer.id, direction));
    });
    // A 3D model is not part of the imagery stack: nothing to raise or lower.
    if (layer.kind === '3d') moves.hidden = true;
    const line = el(doc, 'div', row, { cls: 'gev-ov-line' });
    const range = createSlider({
      documentRef: doc,
      min: '0',
      max: '100',
      step: '5',
      ariaLabel: `${layer.name}: ${t('Opacity')}`,
    });
    line.append(range);
    const out = el(doc, 'output', line, { cls: 'gev-slider-value' });
    // 3D builds: canopy cut (Off / 90 ft / 120 ft above local ground) and a
    // shortcut to fly to the model. Rows of flat layers have neither.
    let cut = null;
    let note = null;
    if (layer.kind === '3d') {
      cut = el(doc, 'div', row, {
        cls: 'gev-ov-cut',
        attrs: { role: 'group', 'aria-label': t('Cut canopy above') },
      });
      note = el(doc, 'span', row, {
        cls: 'gev-ov-3d-note',
        attrs: { role: 'status' },
      });
    }
    box.addEventListener('change', () =>
      onEnabled(layer.id, Boolean(box.checked)),
    );
    range.addEventListener('input', () =>
      onOpacity(layer.id, Number(range.value) / 100),
    );
    rows.set(layer.id, {
      cut,
      note,
      row,
      box,
      range,
      out,
      up,
      down,
      layer,
      on: Boolean(layer.enabled),
    });
  }

  /** Search + expand state -> row / group visibility and the group counts. */
  function applyView() {
    if (!grouped) return;
    const searching = query.trim() !== '';
    let shown = 0;
    for (const [groupId, entry] of groups) {
      let matches = 0;
      let on = 0; // enabled layers in the group
      let onShown = 0; // enabled layers among the rows the search shows
      for (const [id, r] of rows) {
        if (rowGroup.get(id) !== groupId) continue;
        const hit = overlayMatches(r.layer, entry.title, query);
        r.row.hidden = !hit;
        if (hit) matches += 1;
        if (r.on) on += 1;
        if (r.on && hit) onShown += 1;
      }
      shown += matches;
      entry.section.hidden = entry.rows === 0 || matches === 0;
      const expanded = searching ? matches > 0 : entry.open;
      entry.body.hidden = !expanded;
      entry.head.setAttribute('aria-expanded', String(expanded));
      entry.caret.textContent = expanded ? '\u25BE' : '\u25B8';
      // The badge always describes the rows on screen: on/total, or the match
      // count while searching (on among the matches / the matches).
      entry.count.textContent = searching
        ? onShown
          ? `${onShown}/${matches}`
          : `${matches}`
        : on
          ? `${on}/${entry.rows}`
          : `${entry.rows}`;
    }
    empty.hidden = shown > 0 || !rows.size;
  }
  if (grouped) {
    search.addEventListener('input', () => {
      query = String(search.value ?? '');
      applyView();
    });
    applyView();
  }

  container.append(panel);
  let shownOrder = state.layers.map((layer) => layer.id).join();
  const api = {
    element: panel,
    update(next) {
      const nextOrder = next.layers.map((layer) => layer.id);
      // Reorder rows only for a full, changed ordering (append moves a node).
      if (
        nextOrder.length === rows.size &&
        nextOrder.every((id) => rows.has(id)) &&
        nextOrder.join() !== shownOrder
      ) {
        shownOrder = nextOrder.join();
        for (const id of nextOrder)
          (grouped ? groups.get(rowGroup.get(id)).body : panel).append(
            rows.get(id).row,
          );
      }
      next.layers.forEach((layer, index) => {
        const row = rows.get(layer.id);
        if (!row) return;
        const pct = Math.round(layer.opacity * 100);
        row.on = Boolean(layer.enabled);
        row.box.checked = row.on;
        row.range.value = String(pct);
        row.range.disabled = !layer.enabled;
        row.range.setAttribute('aria-valuetext', `${pct}%`);
        row.out.textContent = `${pct}%`;
        if (row.cut) {
          const feet = layer.canopyFt ?? null;
          syncChipGroup(row.cut, [
            {
              id: 'off',
              label: t('Full model'),
              active: feet === null,
              title: t('Show the whole model, tree tops included'),
            },
            ...(layer.canopyOptionsFt ?? []).map((ft) => ({
              id: String(ft),
              label: t('Cut above {ft} ft', { ft }),
              active: feet === ft,
              title: t(
                'Hide everything higher than {ft} ft above local ground',
                {
                  ft,
                },
              ),
            })),
            {
              id: 'fly',
              label: t('Fly to'),
              disabled: !layer.enabled,
              title: t('Fly to this model and keep Byrd-IT Open selected'),
            },
          ]);
          for (const button of row.cut.children) {
            const chip = button.dataset.chipId;
            if (chip === 'fly') {
              button.removeAttribute?.('aria-pressed');
              button.removeAttribute?.('aria-busy');
            }
            if (button.dataset.bound === '1') continue;
            button.dataset.bound = '1';
            button.addEventListener('click', () => {
              if (chip === 'fly') onFlyTo(layer.id);
              else onCanopy(layer.id, chip === 'off' ? null : Number(chip));
            });
          }
          row.note.textContent = loadNote(layer.status);
        }
        if (nextOrder.length === rows.size) {
          row.up.disabled = index === 0;
          row.down.disabled = index === nextOrder.length - 1;
        }
      });
      applyView();
    },
    setVisible(visible) {
      panel.hidden = !visible; // .gev-ov-panel[hidden] in map-layers.css
    },
    destroy() {
      panel.remove();
    },
  };
  api.update(state);
  return api;
}

/**
 * createPanel for attachOverlays(): the Map layers rail card, else float.
 * `onOpenAerial` (optional) adds the "open Time Travel" shortcut for the
 * NAIP / historic aerial year slider, which stays in the Time Travel card.
 */
export function createOverlaysMenuPanel(
  options,
  { ensureCard = ensureMapLayersCard, create = createOverlaysPanel } = {},
) {
  const doc =
    options.doc ?? options.container?.ownerDocument ?? globalThis.document;
  const card = ensureCard(doc);
  if (!card) return create(options);
  const panel = create({
    ...options,
    container: card.body,
    embedded: true,
    grouped: true,
    doc,
  });
  if (!panel) return null;
  let claimed = false;
  const release = () => {
    if (!claimed) return;
    claimed = false;
    card.hide();
  };
  return {
    element: panel.element,
    update: (next) => panel.update(next),
    setVisible(visible) {
      panel.setVisible(visible);
      if (visible && !claimed) {
        claimed = true;
        card.show();
      } else if (!visible) release();
    },
    destroy() {
      release();
      panel.destroy();
    },
  };
}

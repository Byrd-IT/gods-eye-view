import { msg } from '../i18n/index.js';

/**
 * Layer-panel rows that present several independent layers as one row: a
 * single on/off switch plus one chip per member. The member layers keep their
 * own ids, tokens, loaders and voice names; the row is presentation only and
 * derives all of its state from the members' enabled flags.
 */
export const COMBINED_ROWS = Object.freeze([
  Object.freeze({
    id: 'usgs-water',
    icon: '💧',
    name: msg('USGS Water'),
    members: Object.freeze([
      Object.freeze({
        id: 'local-usgs-water',
        label: msg('Rivers & Streams'),
        color: '#33ffaa',
      }),
      Object.freeze({
        id: 'local-usgs-wells',
        label: msg('Groundwater Wells'),
        color: '#c58cff',
      }),
      Object.freeze({
        id: 'local-usgs-lakes',
        label: msg('Lakes & Reservoirs'),
        color: '#3fa9ff',
      }),
      Object.freeze({
        id: 'local-usgs-springs',
        label: msg('Springs'),
        color: '#ffd23f',
      }),
    ]),
  }),
]);

/** The combined row a layer belongs to, or null. */
export function combinedRowOf(layerId) {
  return (
    COMBINED_ROWS.find((row) => row.members.some(({ id }) => id === layerId)) ||
    null
  );
}

/**
 * Row state from the members' real enabled flags.
 * @param {object} row Entry of COMBINED_ROWS.
 * @param {(id: string) => boolean} isEnabled
 * @returns {{enabled: boolean, selected: string[], all: boolean, partial: boolean}}
 */
export function combinedRowState(row, isEnabled) {
  const selected = row.members
    .filter(({ id }) => isEnabled(id))
    .map(({ id }) => id);
  return {
    enabled: selected.length > 0,
    selected,
    all: selected.length === row.members.length,
    partial: selected.length > 0 && selected.length < row.members.length,
  };
}

/**
 * Remembers the last non-empty selection per row (default: every member).
 * The live state is observed only when the user acts on the row (never from
 * refreshes), so a half-finished switch-off cannot overwrite it, and URL-
 * restored or voice-toggled layers are still what gets remembered.
 */
export class CombinedSelection {
  constructor() {
    this._last = new Map();
  }
  /** Record the live selection when non-empty. */
  observe(row, selected) {
    if (selected.length) this._last.set(row.id, [...selected]);
  }
  /** Members to enable when the row switch goes on. */
  remembered(row) {
    const last = this._last.get(row.id);
    return last?.length ? last : row.members.map(({ id }) => id);
  }
}

/**
 * Layer ids to switch for a click on the row's on/off switch.
 * @returns {Array<[string, boolean]>} [layerId, enable] pairs (changes only).
 */
export function planRowSwitch(row, isEnabled, selection) {
  const state = combinedRowState(row, isEnabled);
  selection.observe(row, state.selected);
  if (state.enabled) return state.selected.map((id) => [id, false]);
  return selection.remembered(row).map((id) => [id, true]);
}

/** Layer ids to switch for a click on one chip. */
export function planChipToggle(row, memberId, isEnabled, selection) {
  if (!row.members.some(({ id }) => id === memberId)) return [];
  const state = combinedRowState(row, isEnabled);
  selection.observe(row, state.selected);
  return [[memberId, !isEnabled(memberId)]];
}

/** Chip descriptors (syncChipGroup input) for the row's current state. */
export function combinedChips(row, isEnabled, translate = (text) => text) {
  return row.members.map(({ id, label, color }) => {
    const active = isEnabled(id);
    return {
      id,
      label: translate(label),
      color,
      active,
      title: translate(label),
    };
  });
}

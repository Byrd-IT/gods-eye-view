/**
 * Voice adapter for the map overlay layers (src/byrdit/basemap/overlays.js).
 *
 * The overlays controller offers one method per overlay operation; this turns
 * those into the six voice actions the GEV tool exposes: enable, opacity,
 * raise, lower, phone_mode and status.
 *
 * Every action reads controller state back; mounting does not prove that an
 * overlay is visible at the current camera or that 3D loading succeeded.
 * An enabled overlay can be absent when another basemap is selected.
 *
 * Failures are reported, never thrown: a raw controller error must not reach
 * the model. The controller also refuses (returns false) for an unknown id, a
 * value it cannot take, and a move that has nowhere to go; each of those is
 * answered with the reason the operator can act on.
 *
 * The prose (error, say) never repeats what the caller sent: an overlay name
 * typed by a person can carry text meant for the model, so the requested id
 * stays in the structured fields and the message says only what happened. The
 * names that DO appear come from the server's overlay manifest and are safe.
 */

/** The actions the GEV tool may call. */
export const OVERLAY_VOICE_ACTIONS = Object.freeze([
  'enable',
  'opacity',
  'raise',
  'lower',
  'phone_mode',
  'status',
]);

/** One adapter per controller, so the voice layer holds no new state. */
const voices = new WeakMap();

/**
 * The adapter for a controller, created once per controller.
 * @param {object|null} controller The published overlay controller.
 * @returns {object|null} The voice adapter, or null without a controller.
 */
export function overlaysVoiceFor(controller) {
  if (!controller || !['object', 'function'].includes(typeof controller))
    return null;
  let voice = voices.get(controller);
  if (!voice) {
    voice = createOverlaysVoice(controller);
    voices.set(controller, voice);
  }
  return voice;
}

/**
 * Build the voice adapter over an overlay controller.
 * @param {object} controller The overlay controller (src/byrdit/basemap/overlays.js).
 * @returns {object} The voice adapter.
 */
export function createOverlaysVoice(controller) {
  /** The controller state, or null when the controller cannot be read. */
  const readState = () => {
    try {
      const state = controller?.state?.();
      return state && typeof state === 'object' ? state : null;
    } catch {
      return null;
    }
  };

  /** The overlay rows as the panel lists them: top of the stack first. */
  const readRows = (state) => {
    const active = Array.isArray(state?.active) ? state.active : [];
    return (Array.isArray(state?.layers) ? state.layers : []).map((layer) => ({
      id: String(layer?.id || ''),
      name: String(layer?.name || layer?.id || ''),
      kind: String(layer?.kind || ''),
      enabled: layer?.enabled === true,
      opacityPct: Math.round(Number(layer?.opacity ?? 0) * 100),
      // Active means mounted in the scene, not necessarily visible at the
      // current camera. A mounted 3D model may still be loading or failed.
      drawn:
        layer?.kind === '3d' && active.includes(layer?.id)
          ? null
          : active.includes(layer?.id),
      ...(layer?.kind === '3d'
        ? {
            modelStatus: ['idle', 'loading', 'ready', 'failed'].includes(
              layer.status,
            )
              ? layer.status
              : 'unknown',
          }
        : {}),
      phoneMode: layer?.phoneMode === true,
    }));
  };

  const rowById = (rows, id) => rows.find((row) => row.id === id) || null;

  /**
   * Resolve the requested overlay: by id, then by name. A name that matches
   * several overlays is a question, not a choice.
   */
  const resolve = (rows, query) => {
    const raw = String(query || '').trim();
    if (!raw) return { missing: true };
    const lower = raw.toLowerCase();
    const byId = rows.find((row) => row.id.toLowerCase() === lower);
    if (byId) return { row: byId };
    const named = rows.filter((row) => row.name.toLowerCase() === lower);
    if (named.length === 1) return { row: named[0] };
    if (named.length > 1) return { ambiguous: named };
    const partial = rows.filter(
      (row) =>
        row.name.toLowerCase().includes(lower) ||
        row.id.toLowerCase().includes(lower),
    );
    if (partial.length) return { ambiguous: partial };
    return { unknown: true };
  };

  /** The ids and names the model can choose from, for a refusal. */
  const catalog = (rows) =>
    rows.map((row) => ({ id: row.id, name: row.name, kind: row.kind }));

  const refused = (error, extra = {}) => ({
    ok: false,
    error,
    say: error,
    ...extra,
  });

  /**
   * The overlay a request names, or the refusal that replaces it.
   *
   * The message never repeats the requested text: it says what happened, and
   * the catalogue that would help comes back as data.
   */
  const resolveOrRefuse = (rows, query) => {
    const found = resolve(rows, query);
    if (found.row) return { row: found.row };
    if (found.missing)
      return {
        refusal: refused('Which map overlay? Name one of the map layers.', {
          overlays: catalog(rows),
        }),
      };
    if (found.ambiguous)
      return {
        refusal: refused('Name a matching map overlay exactly.', {
          overlays: catalog(found.ambiguous),
        }),
      };
    return {
      refusal: refused('There is no map overlay with that name.', {
        overlays: catalog(rows),
      }),
    };
  };

  /**
   * The drawable overlays, bottom of the stack first (3D builds aside: a
   * model is not an imagery layer and has no place in the stack).
   */
  const drawableOrder = (rows, state) => {
    const ids = Array.isArray(state?.stack) ? state.stack : [];
    if (ids.length)
      return ids.filter((id) => {
        const row = rowById(rows, id);
        return row && row.kind !== '3d';
      });
    // No stack published: the panel order (top first) reversed is the same
    // bottom-first order, so a position is still a position.
    return [...rows]
      .reverse()
      .filter((row) => row.kind !== '3d')
      .map((row) => row.id);
  };

  const enable = (args = {}) => {
    const state = readState();
    if (!state) return refused('Map overlays are unavailable in this host.');
    const rows = readRows(state);
    const { row: target, refusal } = resolveOrRefuse(rows, args.overlayId);
    if (refusal) return refusal;
    if (typeof args.enabled !== 'boolean')
      return refused(
        'Turning a map overlay on or off needs enabled true or false.',
        { overlayId: target.id },
      );
    let applied = false;
    try {
      applied = controller.setEnabled(target.id, args.enabled);
    } catch {
      applied = false;
    }
    if (applied === false)
      return refused(
        `The ${target.name} overlay could not be turned ${args.enabled ? 'on' : 'off'}.`,
        { overlayId: target.id, name: target.name },
      );
    const afterState = readState();
    const row = afterState && rowById(readRows(afterState), target.id);
    if (!row || row.enabled !== args.enabled)
      return refused('Map overlay state did not confirm the change.');
    const on = row.enabled;
    const say = on
      ? row.drawn === null
        ? `${row.name} overlay on; visibility is unconfirmed.`
        : row.drawn
          ? `${row.name} overlay on.`
          : `${row.name} overlay on, but it is not drawn on this map.`
      : `${row.name} overlay off.`;
    return {
      ok: true,
      overlayId: row.id,
      name: row.name,
      enabled: on,
      opacityPct: row.opacityPct,
      drawn: row.drawn,
      say,
      ...(row.modelStatus ? { modelStatus: row.modelStatus } : {}),
    };
  };

  const opacity = (args = {}) => {
    const state = readState();
    if (!state) return refused('Map overlays are unavailable in this host.');
    const rows = readRows(state);
    const { row: target, refusal } = resolveOrRefuse(rows, args.overlayId);
    if (refusal) return refusal;
    const pct = args.opacityPct;
    if (!Number.isInteger(pct) || pct < 0 || pct > 100)
      return refused('Overlay opacity must be from 0 to 100 percent.', {
        overlayId: target.id,
        name: target.name,
      });
    let applied = false;
    try {
      applied = controller.setOpacity(target.id, pct / 100);
    } catch {
      applied = false;
    }
    if (applied === false)
      return refused(`The ${target.name} overlay opacity could not be set.`, {
        overlayId: target.id,
        name: target.name,
      });
    const afterState = readState();
    const row = afterState && rowById(readRows(afterState), target.id);
    if (!row || row.opacityPct !== pct)
      return refused('Map overlay state did not confirm the change.');
    return {
      ok: true,
      overlayId: row.id,
      name: row.name,
      enabled: row.enabled,
      opacityPct: row.opacityPct,
      drawn: row.drawn,
      say: `${row.name} overlay at ${row.opacityPct} percent.`,
    };
  };

  const move = (direction, args = {}) => {
    const state = readState();
    if (!state) return refused('Map overlays are unavailable in this host.');
    const rows = readRows(state);
    const { row: target, refusal } = resolveOrRefuse(rows, args.overlayId);
    if (refusal) return refusal;
    // A 3D build is a model, not an imagery layer: it has no place in the
    // stack to move in.
    if (target.kind === '3d')
      return refused(
        `The ${target.name} build is a 3D model and cannot be raised or lowered.`,
        { overlayId: target.id, name: target.name },
      );
    const order = drawableOrder(rows, state);
    const position = order.indexOf(target.id);
    if (direction === 'raise' && position === order.length - 1)
      return refused(`The ${target.name} overlay is already at the top.`, {
        overlayId: target.id,
        name: target.name,
      });
    if (direction === 'lower' && position === 0)
      return refused(`The ${target.name} overlay is already at the bottom.`, {
        overlayId: target.id,
        name: target.name,
      });
    let applied = false;
    try {
      applied = controller.moveLayer(
        target.id,
        direction === 'raise' ? 'up' : 'down',
      );
    } catch {
      applied = false;
    }
    if (applied === false)
      return refused(
        `The ${target.name} overlay could not be ${direction === 'raise' ? 'raised' : 'lowered'}.`,
        { overlayId: target.id, name: target.name },
      );
    const afterState = readState();
    if (!afterState)
      return refused('Map overlay state could not be read after the change.');
    const after = readRows(afterState);
    const row = rowById(after, target.id);
    const nextOrder = drawableOrder(after, afterState);
    const nextPosition = nextOrder.indexOf(target.id);
    if (
      !row ||
      nextPosition < 0 ||
      (direction === 'raise'
        ? nextPosition <= position
        : nextPosition >= position)
    )
      return refused('Map overlay state did not confirm the change.');
    return {
      ok: true,
      overlayId: row.id,
      name: row.name,
      enabled: row.enabled,
      opacityPct: row.opacityPct,
      drawn: row.drawn,
      // 1 is the bottom of the stack, the highest number the top.
      position: {
        index: nextPosition + 1,
        of: nextOrder.length,
        scope: 'imagery overlays only, bottom to top',
      },
      say: `${row.name} overlay ${direction === 'raise' ? 'raised' : 'lowered'}.`,
    };
  };

  const phoneMode = (args = {}) => {
    const state = readState();
    if (!state) return refused('Map overlays are unavailable in this host.');
    const rows = readRows(state);
    if (typeof args.enabled !== 'boolean')
      return refused('Phone mode needs enabled true or false.');
    const model = rows.find((row) => row.kind === '3d');
    if (!model)
      return refused(
        'There is no 3D build here, so phone mode has nothing to switch.',
      );
    let applied = false;
    try {
      applied = controller.setPhoneMode(args.enabled);
    } catch {
      applied = false;
    }
    if (applied === false)
      return refused(
        `Phone mode could not be turned ${args.enabled ? 'on' : 'off'}.`,
      );
    const afterState = readState();
    const row = afterState && rowById(readRows(afterState), model.id);
    if (!row || row.phoneMode !== args.enabled)
      return refused('Map overlay state did not confirm the change.');
    return {
      ok: true,
      phoneMode: row.phoneMode,
      overlayId: row.id,
      name: row.name,
      say: `Phone mode ${row.phoneMode ? 'on' : 'off'} for the 3D builds.`,
    };
  };

  const status = () => {
    const state = readState();
    if (!state) return refused('Map overlays are unavailable in this host.');
    const rows = readRows(state);
    const model = rows.find((row) => row.kind === '3d');
    return {
      ok: true,
      overlays: rows.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        enabled: row.enabled,
        opacityPct: row.opacityPct,
        drawn: row.drawn,
        ...(row.modelStatus ? { modelStatus: row.modelStatus } : {}),
      })),
      phoneMode: model ? model.phoneMode : null,
      say: null,
    };
  };

  return {
    enable,
    opacity,
    raise: (args = {}) => move('raise', args),
    lower: (args = {}) => move('lower', args),
    phone_mode: phoneMode,
    status,
  };
}

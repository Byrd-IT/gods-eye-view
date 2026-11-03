import { mapStackChipModels } from '../mapStackChips.js';
import { onLocaleChange, t } from '../i18n/index.js';

/**
 * Own Map Source presentation and selection without constructing map providers.
 * The supplied controller remains authoritative for availability and active state.
 * The chip row and the status badge are presented as a plain view and handed to
 * `publish`; Core's dock renders them and calls `select()` for a chip.
 */
export function createMapSourceControls({
  controller,
  subscribe,
  publish = () => {},
  claimSelection = () => {},
  onStateChanged = () => {},
  onError = () => {},
}) {
  let destroyed = false;
  let generation = 0;
  // Availability tracks the ion token, so the stacks are read on refresh only.
  let stacks = [];
  function present(state) {
    const stack = state.activeStack;
    // Byrd-IT Open health: working but reported degraded by its service.
    const degraded =
      typeof stack?.degradedReason === 'string' &&
      stack.degradedReason.trim() !== '';
    const name = stack?.shortLabel || stack?.label || t('MAP');
    return {
      chips: mapStackChipModels(stacks, state.activeId),
      status: {
        text:
          state.status === 'switching'
            ? '...'
            : degraded
              ? t('{name} (degraded)', { name })
              : name,
        warn: !!state.lastError || degraded,
        // The degraded reason is the status tooltip; absent when healthy.
        ...(degraded ? { title: stack.degradedReason } : {}),
      },
    };
  }
  function render(state) {
    if (destroyed || !state) return;
    // Health arrives after the first paint, so read the stacks again whenever
    // the state carries them (Byrd-IT Open degraded flag).
    if (Array.isArray(state.stacks)) stacks = state.stacks;
    publish(present(state));
  }
  /**
   * `intent` tells the controller who chose the stack: 'user' (a chip, the
   * dropdown, voice, the API - every selection that also updates the share
   * link) or 'restore' (a share link or recipe being applied).
   */
  async function select(
    stackId,
    { syncShare = true, intent = syncShare ? 'user' : 'restore' } = {},
  ) {
    if (destroyed) return null;
    const current = ++generation;
    if (syncShare) claimSelection();
    const before = controller.getActiveId();
    render(controller.getState('switching'));
    let state;
    try {
      state = await controller.setStack(stackId, { intent });
    } catch (error) {
      if (!destroyed && current === generation) {
        render(controller.getState());
        onError(error?.message || String(error));
      }
      throw error;
    }
    if (destroyed || current !== generation) return state;
    render(controller.getState());
    if (state?.activeId === before && stackId !== before && state?.lastError)
      onError(state.lastError);
    if (syncShare) onStateChanged();
    return state;
  }
  function refresh() {
    if (destroyed) return;
    stacks = controller.getStacks();
    render(controller.getState());
  }
  const unsubscribe = subscribe(() => {
    if (destroyed) return;
    render(controller.getState());
    onStateChanged();
  });
  // The chips' names and hints are translated; read them again in a new
  // locale.
  const offLocale = onLocaleChange(refresh);
  refresh();
  return {
    render,
    select,
    refresh,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation++;
      unsubscribe?.();
      offLocale();
    },
  };
}

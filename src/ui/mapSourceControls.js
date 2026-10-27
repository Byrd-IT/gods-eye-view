import {
  renderMapStackChips,
  syncMapStackChipStatus,
  syncMapStackChips,
} from '../mapStackChips.js';
import { t } from '../i18n/index.js';

/**
 * Own Map Source presentation and selection without constructing map providers.
 * The supplied controller remains authoritative for availability and active state.
 */
export function createMapSourceControls({
  container,
  statusElement,
  controller,
  subscribe,
  claimSelection = () => {},
  onStateChanged = () => {},
  onError = () => {},
}) {
  let destroyed = false;
  let generation = 0;
  let statusTitled = false;
  const removers = [];
  const bind = (element, type, listener) => {
    element.addEventListener(type, listener);
    removers.push(() => element.removeEventListener(type, listener));
  };
  function render(state) {
    if (destroyed || !state) return;
    syncMapStackChips(container, state.activeId);
    if (Array.isArray(state.stacks))
      syncMapStackChipStatus(container, state.stacks);
    if (statusElement) {
      const stack = state.activeStack;
      const degraded =
        typeof stack?.degradedReason === 'string' &&
        stack.degradedReason.trim() !== '';
      const name = stack?.shortLabel || stack?.label || t('MAP');
      statusElement.textContent =
        state.status === 'switching'
          ? '...'
          : degraded
            ? t('{name} (degraded)', { name })
            : name;
      // Only clear a tooltip this control set itself.
      if (degraded) {
        statusElement.title = stack.degradedReason;
        statusTitled = true;
      } else if (statusTitled) {
        statusElement.title = '';
        statusTitled = false;
      }
      statusElement.classList.toggle('warn', !!state.lastError || degraded);
    }
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
    for (const remove of removers.splice(0)) remove();
    renderMapStackChips(container, controller.getStacks(), {
      activeId: controller.getActiveId(),
      onSelect: (id) => {
        void select(id).catch(() => {});
      },
      bind,
    });
    render(controller.getState());
  }
  const unsubscribe = subscribe(() => {
    if (destroyed) return;
    render(controller.getState());
    onStateChanged();
  });
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
      for (const remove of removers.splice(0)) remove();
    },
  };
}

/**
 * Shell entry for the History control (card B11) and the history layer
 * swap (card B12a). The app shell's only touch point is one dynamic import
 * + one call (src/ui/applicationShell.js _initNavControl, next to the Sky
 * view mount):
 *
 *   import('../byrdit/historyUi/historyShell.js').then((h) => h.mountHistoryForShell(this))
 *
 * B12a adds, all in fork code:
 *   - layerChips: the B11 feed chips + a LIVE chip for every enabled layer
 *     not answered from history (D5)
 *   - historyRouter: the window.fetch router, installed AFTER the B11 chip
 *     observer (router -> chips -> browser), driven by the control state
 *   - historyRefresh: refreshLayer on released time changes / playback
 *     frames, prefetch of the next 2 frames, the LIVE refresh (D4)
 *
 * A failure to load or mount is logged and leaves the app live.
 */
import { mountHistoryControl } from './historyControl.js';
import { createTileOutlines } from './tileOutlines.js';
import { createFeedChips } from './feedChips.js';
import { createLayerChips } from './layerChips.js';
import { createHistoryRouter } from './historyRouter.js';
import { createRefreshDriver } from './historyRefresh.js';
import { createHistoryClient } from './historyClient.js';

const SCRUB_SELECTOR = '.gev-hist-scrub';

export function mountHistoryForShell(
  shell,
  { window: win = globalThis.window, document: doc } = {},
) {
  const getDataManager = () => shell?._dataManager ?? null;
  let router = null;
  const chips = createLayerChips({
    feedChips: createFeedChips({ target: win }),
    getRouter: () => router,
    getDataManager,
  });
  const handle = mountHistoryControl({
    window: win,
    ...(doc ? { document: doc } : {}),
    chips,
    tileOutlines: shell?.viewer ? createTileOutlines(shell.viewer) : null,
  });
  if (handle.router) return handle; // already mounted on this host
  router = createHistoryRouter({ target: win });
  router.install();
  chips.connect();
  const driver = createRefreshDriver({
    router,
    getDataManager,
    client: createHistoryClient({ fetchImpl: router.innerFetch }),
  });
  const offHistory = handle.subscribe((detail) => driver.onHistory(detail));
  // the control may already be in history (ht in the address)
  driver.onHistory(handle.getState());

  // no refresh while the scrub is dragged; capture runs before the
  // control's own pointerdown (which already moves the time)
  const root = handle.root;
  const onDown = (e) => {
    if (e?.target?.closest?.(SCRUB_SELECTOR)) driver.setDragging(true);
  };
  const onUp = () => driver.setDragging(false);
  root?.addEventListener?.('pointerdown', onDown, true);
  root?.addEventListener?.('pointerup', onUp, true);
  root?.addEventListener?.('pointercancel', onUp, true);

  const destroyControl = handle.destroy.bind(handle);
  let destroyed = false;
  const destroyAll = () => {
    if (destroyed) return;
    destroyed = true;
    offHistory?.();
    root?.removeEventListener?.('pointerdown', onDown, true);
    root?.removeEventListener?.('pointerup', onUp, true);
    root?.removeEventListener?.('pointercancel', onUp, true);
    driver.destroy();
    router.destroy();
    destroyControl();
    if (win?.__gevHistorySwap?.router === router) delete win.__gevHistorySwap;
  };
  shell?._lifetime?.removers?.add?.(destroyAll);
  // QA / console hook (read-only use): the router and driver state
  if (win) win.__gevHistorySwap = { router, driver, handle };
  return Object.assign(handle, { router, driver, destroy: destroyAll });
}

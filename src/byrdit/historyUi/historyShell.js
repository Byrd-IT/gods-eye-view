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
 * B12b adds the event feeds (historyEventAdapters.js) and the camera view
 * box FIRMS asks with (D7), refreshed after a camera move.
 * B12f adds the N5 live-layer drawing: liveFeedDraw (a fetch gate BELOW the
 * router, router -> gate -> chips -> browser: a cleared feed's live answer
 * is emptied) and greyPainter (a grey feed's layer is drawn grey).
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
import { cameraViewBox } from '../history/flightView.js';
import { createLiveFeedDraw } from './liveFeedDraw.js';
import { createGreyPainter } from './greyPainter.js';
import { createHistoryVoice } from './historyVoice.js';
import { createGhostMapsHistory } from './ghostMapsHistory.js';
import { ensureTimeTravelMenu } from '../timeTravel/menu.js';
import { mountHistoryMenu } from './historyMenu.js';
import { HISTORY_FLOOR_MS } from './historyTimeline.js';
import {
  ghostMapsDriver,
  layerDriver,
  naipDriver,
  waybackDriver,
  weatherDriver,
} from './clockRows.js';

const SCRUB_SELECTOR = '.gev-hist-scrub';

export function mountHistoryForShell(
  shell,
  { window: win = globalThis.window, document: doc } = {},
) {
  const getDataManager = () => shell?._dataManager ?? null;
  let router = null;
  // G1: GhostMaps as published at the slider time (the S4 git archive)
  const ghostMaps = createGhostMapsHistory({ getDataManager });
  const chips = createLayerChips({
    feedChips: createFeedChips({ target: win }),
    getRouter: () => router,
    getDataManager,
    getHistoryLayers: () => ghostMaps.historyLayers(),
  });
  // The control lives in the right-hand Time travel menu (History section);
  // without a document to host it, it falls back to its own fixed box.
  const menu = ensureTimeTravelMenu(doc ?? win?.document);
  const historyHost = menu?.claim('history') ?? null;
  const handle = mountHistoryControl({
    window: win,
    ...(doc ? { document: doc } : {}),
    ...(historyHost ? { parent: historyHost, embedded: true } : {}),
    chips,
    tileOutlines: shell?.viewer ? createTileOutlines(shell.viewer) : null,
  });
  if (handle.router) return handle; // already mounted on this host
  // FIRMS asks its slice with the camera view (D7, B12b)
  const getViewBox = () => (shell?.viewer ? cameraViewBox(shell.viewer) : null);
  router = createHistoryRouter({ target: win, getViewBox });
  // N5 (B12f): the gate goes in first, so the router sits above it
  const liveDraw = createLiveFeedDraw({
    target: win,
    getRouter: () => router,
    getDataManager,
  });
  liveDraw.install();
  router.install();
  const painter = shell?.viewer
    ? createGreyPainter({
        viewer: shell.viewer,
        modeOf: (layerId) => liveDraw.paintModeOf(layerId),
      })
    : null;
  painter?.start();
  const offLiveDraw = liveDraw.subscribe(() => painter?.changed());
  // entering / leaving history changes which layers the painter may touch
  const offRouterPaint = router.subscribe(() => painter?.changed());
  chips.connect();
  const historyClient = createHistoryClient({ fetchImpl: router.innerFetch });
  const driver = createRefreshDriver({
    router,
    getDataManager,
    client: historyClient,
  });
  const offGhostChip = ghostMaps.subscribe(() =>
    chips.refresh({ base: false }),
  );
  // The History menu (card t_73beacfb): a time slider per layer and the lock
  // group. It sits between the main control and the layers: the router and
  // GhostMaps get the shared time plus each unlocked layer's own time.
  const clockDrivers = new Map([
    ['satellites', layerDriver(getDataManager, 'satellites')],
    ['weather', weatherDriver(() => getDataManager()?.weatherClock)],
    ['ghostmaps', ghostMapsDriver(ghostMaps)],
    ['wayback', waybackDriver(win)],
    ['naip', naipDriver(win)],
  ]);
  const clockMenu = historyHost
    ? mountHistoryMenu({
        document: doc ?? win?.document,
        parent: historyHost,
        window: win,
        control: handle,
        drivers: clockDrivers,
        onRouter: (detail) => driver.onHistory(detail),
        // the nearest stored snapshot to the API floor is the first one
        probeEarliest: async (feed) =>
          (
            await historyClient.snapshots({
              feed,
              around: HISTORY_FLOOR_MS,
              n: 1,
            })
          )[0] ?? null,
      })
    : null;
  const offHistory = handle.subscribe((detail) => {
    if (clockMenu) clockMenu.onHistory(detail);
    else {
      driver.onHistory(detail);
      ghostMaps.onHistory(detail);
    }
  });
  // the control may already be in history (ht in the address)
  if (clockMenu) clockMenu.onHistory(handle.getState());
  else {
    driver.onHistory(handle.getState());
    ghostMaps.onHistory(handle.getState());
  }

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
  // a camera move can change the FIRMS slice box (B12b)
  const onMoveEnd = () => driver.viewChanged();
  let offMoveEnd = null;
  try {
    offMoveEnd =
      shell?.viewer?.camera?.moveEnd?.addEventListener?.(onMoveEnd) ?? null;
  } catch {
    offMoveEnd = null;
  }

  const destroyControl = handle.destroy.bind(handle);
  let destroyed = false;
  const destroyAll = () => {
    if (destroyed) return;
    destroyed = true;
    offHistory?.();
    clockMenu?.destroy();
    offGhostChip?.();
    ghostMaps.destroy();
    root?.removeEventListener?.('pointerdown', onDown, true);
    root?.removeEventListener?.('pointerup', onUp, true);
    root?.removeEventListener?.('pointercancel', onUp, true);
    try {
      offMoveEnd?.();
    } catch {
      /* the viewer is already gone */
    }
    driver.destroy();
    offLiveDraw?.();
    offRouterPaint?.();
    painter?.destroy();
    router.destroy();
    liveDraw.destroy();
    destroyControl();
    if (historyHost) menu.release('history');
    if (win?.__gevHistorySwap?.router === router) delete win.__gevHistorySwap;
  };
  shell?._lifetime?.removers?.add?.(destroyAll);
  // Voice (control_history): the adapter over the control and the router
  const voice = createHistoryVoice({
    getHandle: () => handle,
    getRouter: () => router,
  });
  // QA / console hook, and the voice tool's way in
  if (win)
    win.__gevHistorySwap = {
      router,
      driver,
      handle,
      liveDraw,
      painter,
      voice,
      ghostMaps,
      clockMenu,
    };
  return Object.assign(handle, {
    router,
    driver,
    liveDraw,
    painter,
    voice,
    ghostMaps,
    destroy: destroyAll,
  });
}

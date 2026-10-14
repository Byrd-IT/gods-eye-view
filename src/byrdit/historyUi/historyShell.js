/**
 * Shell entry for the History control (card B11). The app shell's only
 * touch point is one dynamic import + one call (src/ui/applicationShell.js
 * _initNavControl, next to the Sky view mount):
 *
 *   import('../byrdit/historyUi/historyShell.js').then((h) => h.mountHistoryForShell(this))
 *
 * A failure to load or mount is logged and leaves the app live.
 */
import { mountHistoryControl } from './historyControl.js';
import { createTileOutlines } from './tileOutlines.js';

export function mountHistoryForShell(shell) {
  const handle = mountHistoryControl({
    tileOutlines: shell?.viewer ? createTileOutlines(shell.viewer) : null,
  });
  shell?._lifetime?.removers?.add?.(() => handle.destroy());
  return handle;
}

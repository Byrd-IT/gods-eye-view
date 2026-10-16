/**
 * History control styles, injected once as a <style id> so the control needs
 * no stylesheet import in an upstream file (DESIGN.md 4.1: one touch point).
 * Uses the app's glass/mono design tokens like navControl.css.
 */
export const HISTORY_STYLE_ID = 'gev-history-style';

export const HISTORY_CSS = `
.gev-hist {
  position: fixed;
  /* bottom-left, above the coordinate readout and clear of the bottom-centre
     search/voice bar and the bottom-right navigation control */
  left: 48px;
  bottom: 178px;
  z-index: 95;
  width: min(640px, calc(100vw - 560px));
  min-width: 320px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--glass-border, rgba(255,255,255,0.14));
  border-radius: 14px;
  background: var(--glass-bg, rgba(10,14,20,0.72));
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  color: var(--text-secondary, #c8d0da);
  font: 500 11px/1.35 var(--font-mono, ui-monospace, monospace);
  user-select: none;
  -webkit-user-select: none;
}
.gev-hist[data-expanded='false'] { width: auto; min-width: 0; max-width: calc(100vw - 560px); }
.gev-hist-bar, .gev-hist-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.gev-hist-top { justify-content: space-between; }
.gev-hist-edges { justify-content: space-between; opacity: 0.7; font-size: 10px; }
.gev-hist-badge {
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid rgba(64, 220, 120, 0.6);
  background: rgba(64, 220, 120, 0.16);
  color: #6ff0a0;
  font: 700 11px/1.2 var(--font-mono, ui-monospace, monospace);
  letter-spacing: 0.06em;
  cursor: pointer;
}
.gev-hist[data-mode='history'] .gev-hist-badge {
  border-color: rgba(255, 190, 80, 0.7);
  background: rgba(255, 190, 80, 0.16);
  color: #ffd27a;
}
.gev-hist-barhud { opacity: 0.9; }
.gev-hist-btn {
  min-width: 28px;
  height: 24px;
  padding: 0 7px;
  border: 1px solid var(--glass-border, rgba(255,255,255,0.14));
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  color: var(--text-secondary, #c8d0da);
  font: 600 11px/1 var(--font-mono, ui-monospace, monospace);
  cursor: pointer;
}
.gev-hist-btn:hover { border-color: var(--glass-border-hover, rgba(255,255,255,0.3)); color: var(--accent, #7fd3ff); }
.gev-hist-btn[aria-pressed='true'] { background: var(--accent-dim, rgba(127,211,255,0.18)); color: var(--accent, #7fd3ff); }
.gev-hist-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.gev-hist-live { border-color: rgba(64, 220, 120, 0.6); color: #6ff0a0; }
.gev-hist-presets, .gev-hist-rates { display: flex; gap: 4px; }
.gev-hist-readout { color: var(--text-primary, #eef3f8); font-weight: 700; }
.gev-hist-scrub {
  position: relative;
  height: 18px;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--glass-border, rgba(255,255,255,0.14));
  cursor: pointer;
  touch-action: none;
}
.gev-hist-thumb {
  position: absolute;
  top: -3px;
  width: 4px;
  height: 22px;
  margin-left: -2px;
  border-radius: 2px;
  background: #ffd27a;
  box-shadow: 0 0 6px rgba(255, 210, 122, 0.8);
  pointer-events: none;
}
.gev-hist[data-mode='live'] .gev-hist-thumb { background: #6ff0a0; box-shadow: 0 0 6px rgba(111, 240, 160, 0.8); }
.gev-hist-ribbon { display: flex; flex-direction: column; gap: 2px; }
.gev-hist-lane { display: flex; align-items: center; gap: 6px; }
.gev-hist-lane-label { width: 64px; flex: none; font-size: 10px; opacity: 0.75; text-align: right; }
.gev-hist-lane-track { position: relative; flex: 1; height: 7px; background: transparent; border-bottom: 1px dotted rgba(255,255,255,0.12); }
.gev-hist-lane-empty { font-size: 10px; opacity: 0.7; }
.gev-hist-seg { position: absolute; top: 0; height: 100%; min-width: 1px; }
.gev-hist-seg-recorded { background: rgba(127, 211, 255, 0.85); }
.gev-hist-seg-unverified { background: rgba(127, 211, 255, 0.45); }
.gev-hist-seg-partial { background: repeating-linear-gradient(90deg, rgba(127,211,255,0.8) 0 3px, rgba(127,211,255,0.2) 3px 6px); }
.gev-hist-seg-gap { background: repeating-linear-gradient(135deg, rgba(255,120,90,0.9) 0 2px, transparent 2px 5px); }
.gev-hist-seg-pending { background: rgba(255, 255, 255, 0.12); }
.gev-hist-hud { min-height: 14px; color: #ffd27a; }
.gev-hist[data-unavailable='true'] .gev-hist-hud { color: #9aa4b0; }
.gev-hist-chips { display: flex; gap: 4px; flex-wrap: wrap; }
.gev-hist-chip { padding: 1px 7px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.2); font-size: 10px; }
.gev-hist-chip-live { border-color: rgba(64, 220, 120, 0.6); color: #6ff0a0; }
.gev-hist-chip-grey, .gev-hist-chip-cleared, .gev-hist-chip-none, .gev-hist-chip-paused { color: #b8bec6; background: rgba(150, 150, 150, 0.18); border-color: rgba(180, 180, 180, 0.45); }
.gev-hist-chip-cleared { opacity: 0.8; font-style: italic; }
.gev-hist-chip-unswapped { border-color: rgba(64, 220, 120, 0.75); color: #6ff0a0; background: rgba(20, 90, 50, 0.35); font-weight: 600; }
.gev-hist-chip-truncated { border-color: rgba(255, 196, 0, 0.75); color: #ffd666; background: rgba(90, 70, 10, 0.35); }
@media (max-width: 900px) {
  .gev-hist { left: 12px; width: calc(100vw - 24px); min-width: 0; max-width: none; bottom: 232px; }
  .gev-hist[data-expanded='false'] { width: auto; max-width: calc(100vw - 24px); }
  .gev-hist-btn { min-height: 32px; }
}
@media (pointer: coarse) {
  .gev-hist-btn { min-width: 44px; min-height: 44px; }
  .gev-hist-scrub { height: 28px; }
  .gev-hist-thumb { height: 32px; }
}
@media (prefers-reduced-motion: reduce) { .gev-hist * { transition: none !important; } }
`;

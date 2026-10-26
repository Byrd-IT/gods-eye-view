/**
 * Voice surface of the History control (owner decision 2026-10-26: full
 * voice control of History playback). One thin adapter over the mounted
 * control handle (historyControl.js) and the router (historyRouter.js);
 * the voice tool `control_history` (src/voice/gevActions.js) reaches it
 * through `currentHistoryVoice()`, which the shell registers with
 * `bindHistoryVoice`. The page hook `window.__gevHistorySwap` stays a
 * QA handle and does not carry this adapter.
 *
 *   jump    move to a time (ISO 8601 with a zone, or minutes ago); enters
 *           History when live, snaps to recorded data like a scrub release
 *   play    start playback from the current history time
 *   pause   stop playback, keep the time
 *   speed   1 / 10 / 60 / 600 history seconds per second (RATES)
 *   live    leave History, back to the live globe
 *   status  read-only state
 *   feeds   which feed layers play from History is a layer choice: the
 *           caller enables / disables the layers named in `feedLayerIds`
 *           (an enabled swapped layer plays recorded data, anything else
 *           stays LIVE and carries a LIVE chip)
 *
 * It adds no state of its own and never throws: an unusable request answers
 * {ok:false, error} so the model can say why.
 */
import { RATES, HISTORY_SPAN_MS } from './historyTimeline.js';

export const HISTORY_VOICE_ACTIONS = Object.freeze([
  'jump',
  'play',
  'pause',
  'speed',
  'live',
  'status',
  'feeds',
]);

const MAX_MINUTES_AGO = Math.floor(HISTORY_SPAN_MS / 60_000);
const ZONE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// End-anchored. A time of day must use T, and Z is uppercase; a space is not
// ISO. The zone is optional here so a missing zone still fails the zone check
// below, not this one. No i flag: a lowercase t or z fails this shape check
// on every engine, instead of depending on Date.parse.
const ISO_HEAD =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

const SNAP_WAIT_MS = 3_000;

let boundVoice = null;

/** Register the mounted adapter. The returned unbind clears only that adapter. */
export function bindHistoryVoice(voice) {
  boundVoice = voice ?? null;
  return () => {
    if (boundVoice === voice) boundVoice = null;
  };
}

/** The adapter the voice tool reads. Null when History is not mounted. */
export function currentHistoryVoice() {
  return boundVoice;
}

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

/** Date.parse does not accept an hour-only offset (+05). Read it as +05:00. */
function withMinuteOffset(text) {
  return text.replace(/([+-]\d{2})$/, '$1:00');
}

/**
 * Parse a jump target. Returns {ms} or {error}. A date alone means 00:00
 * UTC; a time of day must carry a zone, so the answer never depends on the
 * browser's own time zone.
 */
export function parseJumpTime(value, now) {
  if (typeof value !== 'string' || !value.trim())
    return { error: 'time must be an ISO 8601 date-time string' };
  const text = value.trim();
  if (!ISO_HEAD.test(text))
    return {
      error: 'time must be an ISO 8601 date-time such as 2026-03-04T15:30:00Z',
    };
  if (!DATE_ONLY.test(text) && !ZONE.test(text))
    return {
      error:
        'time needs a zone (Z or an offset such as -06:00); convert the spoken local time first',
    };
  const ms = Date.parse(
    DATE_ONLY.test(text) ? `${text}T00:00:00Z` : withMinuteOffset(text),
  );
  if (!Number.isFinite(ms)) return { error: 'time is not a valid date' };
  return { ms };
}

/**
 * @param {object} options
 *   getHandle  () => mounted History control handle, or null
 *   getRouter  () => history router, or null
 *   now        wall clock ms
 */
export function createHistoryVoice({
  getHandle,
  getRouter = () => null,
  now = () => Date.now(),
  snapWaitMs = SNAP_WAIT_MS,
}) {
  const handle = () => {
    const h = getHandle?.();
    return h && !h.destroyed ? h : null;
  };
  const unavailable = () => fail('History playback is not available right now');

  const snapshot = () => {
    const h = handle();
    if (!h) return null;
    const state = h.getState();
    const router = getRouter?.();
    const swapped = router?.getState?.().swapped ?? [];
    const layerOf = new Map(
      (router?.adapters ?? []).map((a) => [a.id, a.layerId]),
    );
    return {
      mode: state.active ? 'history' : 'live',
      time:
        state.active && Number.isFinite(state.timeMs)
          ? new Date(state.timeMs).toISOString()
          : null,
      playing: Boolean(state.playing),
      rate: state.rate,
      unavailable: Boolean(state.unavailable),
      playingFeeds: swapped.map((id) => layerOf.get(id) ?? id),
    };
  };

  const done = (extra = {}) => ({ ok: true, ...snapshot(), ...extra });

  return {
    feedLayerIds: () => (getRouter?.()?.adapters ?? []).map((a) => a.layerId),
    status() {
      return handle() ? done() : unavailable();
    },
    async jump({ time, minutesAgo } = {}) {
      const h = handle();
      if (!h) return unavailable();
      const t = now();
      let ms;
      if (time !== undefined && time !== null && time !== '') {
        const parsed = parseJumpTime(time, t);
        if (parsed.error) return fail(parsed.error);
        ms = parsed.ms;
      } else if (minutesAgo !== undefined && minutesAgo !== null) {
        const minutes = Number(minutesAgo);
        if (!Number.isFinite(minutes) || minutes < 0)
          return fail('minutesAgo must be a number of minutes, zero or more');
        ms = t - Math.min(minutes, MAX_MINUTES_AGO) * 60_000;
      } else return fail('jump needs time (ISO 8601) or minutesAgo');
      const earliest = t - HISTORY_SPAN_MS;
      const clamped = ms > t ? 'future' : ms < earliest ? 'past' : null;
      const target = Math.min(t, Math.max(earliest, ms));
      // A stalled /snapshots must not hold the voice turn. The control keeps
      // snapping; the answer says the time it holds now is not settled yet.
      const settle = Promise.resolve(h.seek(target, { snap: true })).then(
        (result) => {
          if (result?.superseded) return { superseded: true };
          if (result && result.landed === false) return { snapPending: true };
          return {};
        },
        () => ({}),
      );
      let timer;
      const timed = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ snapPending: true }), snapWaitMs);
      });
      const snap = await Promise.race([settle, timed]);
      clearTimeout(timer);
      if (!handle()) return unavailable();
      const requested = new Date(ms).toISOString();
      if (snap.superseded) {
        return done({
          requested,
          ...(clamped ? { clamped } : {}),
          time: new Date(target).toISOString(),
          superseded: true,
        });
      }
      return done({
        requested,
        ...(clamped ? { clamped } : {}),
        ...(snap.snapPending ? { snapPending: true } : {}),
      });
    },
    play() {
      const h = handle();
      if (!h) return unavailable();
      if (!h.getState().active)
        return fail('History is not open: jump to a time first', {
          ...snapshot(),
        });
      h.play();
      const s = h.getState();
      if (!s.playing)
        return fail('Already at the present: nothing to play forward to', {
          ...snapshot(),
        });
      return done();
    },
    pause() {
      const h = handle();
      if (!h) return unavailable();
      h.pause();
      return done();
    },
    speed(rate) {
      const h = handle();
      if (!h) return unavailable();
      const n = Number(rate);
      if (!RATES.includes(n))
        return fail(`speed must be one of ${RATES.join(', ')}`, {
          allowed: [...RATES],
        });
      h.setRate(n);
      return done();
    },
    live() {
      const h = handle();
      if (!h) return unavailable();
      h.leave();
      return done();
    },
  };
}

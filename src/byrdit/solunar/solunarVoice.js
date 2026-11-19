/**
 * Voice adapter for the Solunar card.
 *
 * The rail card already draws the week, the 12 h / 24 h chips, the map-centre
 * button and the gold spot marker. This module adds no state of its own: every
 * action calls the same handle the buttons call, so voice and mouse cannot
 * drift apart. It validates its arguments first, answers {ok:true, ...} or
 * {ok:false, error}, never throws, and never puts a caller's value in an
 * error message.
 *
 *   open    open the card (the shell's own panel disclosure)
 *   spot    set the spot by latitude and longitude
 *   center  go back to the middle of the map
 *   clock   choose the 12 h / 24 h clock
 *   status  read the card's state back
 */
export const SOLUNAR_VOICE_ACTIONS = Object.freeze([
  'open',
  'spot',
  'center',
  'clock',
  'status',
]);

const UNAVAILABLE = 'Solunar is not available right now';
const NO_SPOT =
  'A spot needs a latitude between -90 and 90 and a longitude between -180 and 180';
const BAD_CLOCK =
  'The clock takes true for 12 hour time or false for 24 hour time';

/** A finite number inside the globe. */
function isDegrees(value, limit) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= -limit &&
    value <= limit
  );
}

/** The spot the caller asked for, or null when the request is not a place. */
export function readSpotArgs(args = {}) {
  const lat = args.latitude ?? args.lat;
  const lon = args.longitude ?? args.lon ?? args.lng;
  if (!isDegrees(lat, 90) || !isDegrees(lon, 180)) return null;
  return { latDeg: lat, lonDeg: lon };
}

const round5 = (value) => Math.round(value * 1e5) / 1e5;

/**
 * @param {object} deps The card's own handles. Every one of them is the
 *   function the matching button already calls.
 * @param {() => void} [deps.open] Opens the card.
 * @param {() => boolean} [deps.isOpen] Whether the card is open.
 * @param {(latDeg: number, lonDeg: number) => boolean} [deps.setSpot]
 * @param {() => object|null} [deps.getSpot]
 * @param {() => boolean} [deps.useCenter] The "Use map centre" button.
 * @param {(hour12: boolean) => boolean} [deps.setHour12] The clock chips.
 * @param {() => boolean} [deps.getHour12]
 * @param {() => boolean} [deps.isDestroyed] Whether the card is gone.
 * @param {() => object|null} [deps.readToday] The day's facts, if the card
 *   has a spot: what the model should hear about "today" at that place.
 */
export function createSolunarVoice(deps = {}) {
  const {
    open,
    isOpen,
    setSpot,
    getSpot,
    useCenter,
    setHour12,
    getHour12,
    isDestroyed,
    readToday,
  } = deps;

  const fail = (error) => ({ ok: false, error });
  const gone = () => isDestroyed?.() === true;

  /** The card can answer only while every handle it needs is there. */
  function ready() {
    return (
      !gone() &&
      typeof isOpen === 'function' &&
      typeof getSpot === 'function' &&
      typeof setSpot === 'function' &&
      typeof useCenter === 'function' &&
      typeof setHour12 === 'function' &&
      typeof getHour12 === 'function'
    );
  }

  /** The card's state, as the model should hear it. */
  function snapshot() {
    const spot = getSpot();
    let today = null;
    try {
      today = readToday?.() ?? null;
    } catch {
      today = null; // a readback problem never fails the action
    }
    return {
      open: isOpen() === true,
      hour12: getHour12() === true,
      spot: spot
        ? {
            latitude: round5(spot.latDeg),
            longitude: round5(spot.lonDeg),
            zone: spot.zone ?? null,
            source: spot.source ?? null,
          }
        : null,
      today,
    };
  }

  /** Every action runs the same way: check, act, answer, never throw. */
  function guard(run) {
    try {
      if (!ready()) return fail(UNAVAILABLE);
      return run();
    } catch {
      return fail(UNAVAILABLE);
    }
  }

  async function guardAsync(run) {
    try {
      if (!ready()) return fail(UNAVAILABLE);
      return await run();
    } catch {
      return fail(UNAVAILABLE);
    }
  }

  async function ensureOpen() {
    await open?.();
    return !gone() && isOpen() === true;
  }

  return {
    async open() {
      return guardAsync(async () => {
        await open?.();
        if (gone() || isOpen() !== true) return fail(UNAVAILABLE);
        return { ok: true, ...snapshot() };
      });
    },
    async spot(args = {}) {
      return guardAsync(async () => {
        const deg = readSpotArgs(args);
        if (!deg) return fail(NO_SPOT);
        if (!(await ensureOpen())) return fail(UNAVAILABLE);
        if (setSpot(deg.latDeg, deg.lonDeg) !== true) return fail(UNAVAILABLE);
        return { ok: true, ...snapshot() };
      });
    },
    async center() {
      return guardAsync(async () => {
        if (!(await ensureOpen())) return fail(UNAVAILABLE);
        if (useCenter() !== true) return fail(UNAVAILABLE);
        return { ok: true, ...snapshot() };
      });
    },
    clock(args = {}) {
      return guard(() => {
        const hour12 = args.hour12;
        if (typeof hour12 !== 'boolean') return fail(BAD_CLOCK);
        if (setHour12(hour12) !== true) return fail(UNAVAILABLE);
        return { ok: true, ...snapshot() };
      });
    },
    status() {
      return guard(() => ({ ok: true, ...snapshot() }));
    },
  };
}

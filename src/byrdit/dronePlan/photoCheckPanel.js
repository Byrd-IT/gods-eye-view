/**
 * The "Photo check after flight" section of the Drone Flight Plan panel.
 *
 * The person picks (or drops) the photos from a flight. Only the first
 * HEADER_BYTES of each file are read, in this browser: no photo is uploaded,
 * kept or written anywhere. What stays in memory is each photo's position,
 * height, time and camera numbers, and it goes when the section is cleared or
 * the panel closes. The only thing that can be saved is the CSV report, and
 * only when the person presses SAVE REPORT.
 *
 * `host` is what the panel gives this section (see panel.js):
 *   planned()       { suite, result } of the plan on the panel
 *   plannedGsdCm()  the plan's ground detail, cm/px, or null
 *   showOnMap(data) draw the check on the globe (null clears it)
 *   flyToMap()      fly over it
 *   download(name, bytes, type)
 */
import { formatNumber, t, tn } from '../../i18n/index.js';
import { HEADER_BYTES, readPhotoMeta } from './photoExif.js';
import {
  GAP_FACTOR,
  MAX_PHOTOS,
  analyzePhotos,
  defaultMatchM,
  plannedPhotoPoints,
  reportCsv,
} from './photoCheck.js';
import { lengthText } from './format.js';
import { lengthFromM, lengthToM, lengthUnit } from './units.js';

const READ_AT_ONCE = 6;

const el = (doc, tag, parent, { text, cls, attrs } = {}) => {
  const node = doc.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  for (const [k, v] of Object.entries(attrs ?? {})) node.setAttribute(k, v);
  parent?.append(node);
  return node;
};

const fixed = (v, digits) =>
  formatNumber(v, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

/** The first bytes of a File (or of a test double holding `bytes`). */
async function readHeader(file) {
  if (file?.bytes instanceof Uint8Array)
    return file.bytes.subarray(0, HEADER_BYTES);
  const buffer = await file.slice(0, HEADER_BYTES).arrayBuffer();
  return new Uint8Array(buffer);
}

export function mountPhotoCheck({ doc, container, host }) {
  const s = {
    photos: [], // metadata of the photos read (no pixels)
    unreadable: 0,
    notPhoto: 0,
    skippedOver: 0,
    matchM: null, // null: the default for the plan
    analysis: null,
    planRef: null,
    queued: [],
    busy: false,
    token: 0,
  };

  const root = el(doc, 'section', container, {
    cls: 'gev-dp-photocheck',
    attrs: { 'data-role': 'photo-check' },
  });
  el(doc, 'h4', root, {
    cls: 'gev-dp-subtitle',
    text: t('PHOTO CHECK AFTER FLIGHT'),
  });
  el(doc, 'p', root, {
    cls: 'gev-dp-note',
    text: t(
      'Choose the photos from the flight. They are read in this browser only: nothing is uploaded or saved. Straight JPEG files from the aircraft or its card work; copies sent through a chat app have lost their position.',
    ),
  });
  const buttons = el(doc, 'div', root, { cls: 'gev-dp-library-buttons' });
  const input = el(doc, 'input', null, {
    attrs: {
      type: 'file',
      multiple: '',
      accept: '.jpg,.jpeg,image/jpeg',
      'data-role': 'photo-input',
      hidden: '',
    },
  });
  root.append(input);
  const choose = el(doc, 'button', buttons, {
    cls: 'data-toggle-chip',
    text: t('CHOOSE PHOTOS'),
    attrs: { type: 'button', 'data-action': 'photos-choose' },
  });
  const clear = el(doc, 'button', buttons, {
    cls: 'data-toggle-chip',
    text: t('CLEAR PHOTOS'),
    attrs: { type: 'button', 'data-action': 'photos-clear' },
  });
  const zoom = el(doc, 'button', buttons, {
    cls: 'data-toggle-chip',
    text: t('ZOOM TO PHOTOS'),
    attrs: { type: 'button', 'data-action': 'photos-zoom' },
  });
  const save = el(doc, 'button', buttons, {
    cls: 'data-toggle-chip',
    text: t('SAVE REPORT (CSV)'),
    attrs: {
      type: 'button',
      'data-action': 'photos-report',
      title: t('A table of positions and numbers. It holds no photos.'),
    },
  });
  const matchRow = el(doc, 'label', root, { cls: 'gev-dp-row' });
  el(doc, 'span', matchRow, {
    cls: 'gev-dp-label',
    text: t('Match distance'),
  });
  const matchWrap = el(doc, 'span', matchRow, { cls: 'gev-dp-control' });
  const matchInput = el(doc, 'input', matchWrap, {
    cls: 'gev-field gev-field--compact',
    attrs: {
      type: 'number',
      min: '1',
      step: '1',
      'data-field': 'match-distance',
      'aria-label': t('Match distance'),
      title: t(
        'A planned photo point counts as photographed when a photo was taken within this distance',
      ),
    },
  });
  const matchUnit = el(doc, 'output', matchWrap, {
    cls: 'gev-slider-value',
  });
  const progress = el(doc, 'p', root, {
    cls: 'gev-dp-note',
    attrs: {
      role: 'status',
      'aria-live': 'polite',
      'data-role': 'photo-progress',
    },
  });
  const results = el(doc, 'div', root, {
    cls: 'gev-dp-photocheck-results',
    attrs: { 'data-role': 'photo-results' },
  });

  const line = (text, level = 'info') =>
    el(doc, 'p', results, {
      cls: 'gev-dp-warning',
      text,
      attrs: { 'data-level': level },
    });

  function plannedNow() {
    const plan = host.planned?.() ?? {};
    return plannedPhotoPoints(plan);
  }

  function render() {
    results.replaceChildren();
    const a = s.analysis;
    const has = s.photos.length > 0;
    clear.disabled = !has && !s.busy;
    zoom.disabled = !a?.summary;
    save.disabled = !a?.summary;
    matchInput.disabled = !has;
    matchUnit.textContent = lengthUnit();
    if (a?.summary && s.matchM == null)
      matchInput.value = String(Math.round(lengthFromM(a.matchM)));
    if (!a?.summary) return;
    const sum = a.summary;
    line(
      tn(sum.photoCount, '{count} photo read', '{count} photos read', {
        count: sum.photoCount,
      }),
    );
    if (a.duplicates)
      line(
        tn(
          a.duplicates,
          '{count} copy of the same photo was counted once',
          '{count} copies of the same photos were counted once',
          { count: a.duplicates },
        ),
      );
    if (s.unreadable)
      line(
        tn(
          s.unreadable,
          '{count} file has no position in it and was skipped',
          '{count} files have no position in them and were skipped',
          { count: s.unreadable },
        ),
        'warn',
      );
    if (s.notPhoto)
      line(
        tn(
          s.notPhoto,
          '{count} file is not a JPEG and was skipped',
          '{count} files are not JPEGs and were skipped',
          { count: s.notPhoto },
        ),
        'warn',
      );
    if (s.skippedOver)
      line(
        t('Only the first {max} photos were read', { max: MAX_PHOTOS }),
        'warn',
      );

    if (sum.plannedCount) {
      line(
        t(
          '{covered} of {total} planned photo points have a photo within {dist}',
          {
            covered: sum.coveredCount,
            total: sum.plannedCount,
            dist: lengthText(a.matchM),
          },
        ),
        sum.missingCount ? 'warn' : 'info',
      );
      if (sum.missingCount)
        line(
          tn(
            sum.missingCount,
            '{count} planned photo point has no photo (red on the map)',
            '{count} planned photo points have no photo (red on the map)',
            { count: sum.missingCount },
          ),
          'warn',
        );
      if (sum.offPlanCount)
        line(
          tn(
            sum.offPlanCount,
            '{count} photo was taken away from the plan (orange on the map)',
            '{count} photos were taken away from the plan (orange on the map)',
            { count: sum.offPlanCount },
          ),
          'warn',
        );
      if (sum.medianOffsetM != null)
        line(
          t(
            'Photos near a planned point: typically {typical} off, at most {max}',
            {
              typical: lengthText(sum.medianOffsetM, 1),
              max: lengthText(sum.maxOffsetM, 1),
            },
          ),
        );
    } else {
      line(
        t(
          'No plan on the panel, so only the spacing and the ground detail are checked. Plan the flight first to see which points are missing.',
        ),
      );
    }

    if (sum.gapCount)
      line(
        tn(
          sum.gapCount,
          '{count} place where neighbouring photos are over {factor} times further apart than usual ({usual}); red line on the map',
          '{count} places where neighbouring photos are over {factor} times further apart than usual ({usual}); red lines on the map',
          {
            count: sum.gapCount,
            factor: fixed(GAP_FACTOR, 1),
            usual: lengthText(sum.usualSpacingM, 1),
          },
        ),
        'warn',
      );
    else if (sum.usualSpacingM != null)
      line(
        t('No spacing gaps: photos are about {usual} apart', {
          usual: lengthText(sum.usualSpacingM, 1),
        }),
      );
    if (sum.breakCount)
      line(
        tn(
          sum.breakCount,
          '{count} long pause between photos (a new leg or battery) is not counted as a gap',
          '{count} long pauses between photos (new legs or batteries) are not counted as gaps',
          { count: sum.breakCount },
        ),
      );

    if (sum.gsdMedianCm != null) {
      line(
        t(
          'Ground detail measured from the photos: {min} to {max} cm/px, typically {median} cm/px, at about {height} above the ground',
          {
            min: fixed(sum.gsdMinCm, 2),
            max: fixed(sum.gsdMaxCm, 2),
            median: fixed(sum.gsdMedianCm, 2),
            height: lengthText(sum.heightMedianM),
          },
        ),
      );
      if (sum.gsdFromTakeoff)
        line(
          t(
            'For photos that matched no planned point the height is measured from the takeoff point, so on higher or lower ground the real ground detail differs',
          ),
        );
      const planned = host.plannedGsdCm?.();
      if (
        Number.isFinite(planned) &&
        planned > 0 &&
        Math.abs(sum.gsdMedianCm / planned - 1) > 0.15
      )
        line(
          t(
            'The plan says {planned} cm/px but the photos measure {measured} cm/px. Check the picture size and camera in Aircraft & camera.',
            { planned: fixed(planned, 2), measured: fixed(sum.gsdMedianCm, 2) },
          ),
          'warn',
        );
    }
    if (sum.gsdMissing)
      line(
        tn(
          sum.gsdMissing,
          '{count} photo has no height or camera data, so no ground detail',
          '{count} photos have no height or camera data, so no ground detail',
          { count: sum.gsdMissing },
        ),
      );
  }

  function draw() {
    const a = s.analysis;
    if (!a?.summary) {
      host.showOnMap?.(null);
      return;
    }
    host.showOnMap?.({
      planned: a.planned.map((p) => ({
        lon: p.lon,
        lat: p.lat,
        covered: p.covered,
      })),
      photos: a.photos.map((p) => ({
        lon: p.lon,
        lat: p.lat,
        onPlan: a.planned.length ? p.onPlan : null,
      })),
      gaps: a.gaps.map((g) => [
        { lon: a.photos[g.from].lon, lat: a.photos[g.from].lat },
        { lon: a.photos[g.to].lon, lat: a.photos[g.to].lat },
      ]),
    });
  }

  function analyze() {
    const plan = host.planned?.() ?? {};
    s.planRef = plan.suite ?? plan.result ?? null;
    const planned = plannedPhotoPoints(plan);
    const matchM = s.matchM ?? defaultMatchM(planned);
    s.analysis = s.photos.length
      ? analyzePhotos(s.photos, planned, { matchM })
      : null;
    draw();
    render();
  }

  /** Read the metadata of `files` (File objects) and check them. */
  async function addFiles(files) {
    const list = Array.from(files ?? []);
    if (!list.length) return null;
    if (s.busy) {
      // Files chosen while others are still being read wait their turn.
      s.queued.push(...list);
      return null;
    }
    const token = ++s.token;
    s.busy = true;
    const room = Math.max(0, MAX_PHOTOS - s.photos.length);
    if (list.length > room) s.skippedOver += list.length - room;
    const todo = list.slice(0, room);
    let done = 0;
    let next = 0;
    const worker = async () => {
      while (next < todo.length && token === s.token) {
        const file = todo[next++];
        let out;
        try {
          out = readPhotoMeta(await readHeader(file), String(file.name ?? ''));
        } catch {
          out = { ok: false, reason: 'not-jpeg' };
        }
        if (token !== s.token) return;
        if (out.ok) s.photos.push(out.photo);
        else if (out.reason === 'no-position') s.unreadable += 1;
        else s.notPhoto += 1;
        done += 1;
        if (done % 25 === 0 || done === todo.length)
          progress.textContent = t('Reading photos: {done} of {total}', {
            done,
            total: todo.length,
          });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(READ_AT_ONCE, todo.length) }, worker),
    );
    if (token !== s.token) return null;
    s.busy = false;
    progress.textContent = '';
    if (!s.photos.length) {
      progress.textContent = t(
        'None of the files has a position in it. Use the original JPEG files, not copies sent through a chat app.',
      );
    }
    analyze();
    if (s.queued.length) {
      const more = s.queued;
      s.queued = [];
      return addFiles(more);
    }
    return s.analysis;
  }

  function reset() {
    s.token += 1;
    s.busy = false;
    s.photos = [];
    s.queued = [];
    s.unreadable = 0;
    s.notPhoto = 0;
    s.skippedOver = 0;
    s.analysis = null;
    s.matchM = null;
    matchInput.value = '';
    progress.textContent = '';
    host.showOnMap?.(null);
    render();
  }

  choose.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []);
    input.value = '';
    addFiles(files);
  });
  clear.addEventListener('click', reset);
  zoom.addEventListener('click', () => host.flyToMap?.());
  save.addEventListener('click', () => {
    if (!s.analysis?.summary) return;
    host.download?.(
      'photo-check.csv',
      new TextEncoder().encode(reportCsv(s.analysis)),
      'text/csv',
    );
  });
  matchInput.addEventListener('change', () => {
    const v = Number(matchInput.value);
    if (!Number.isFinite(v) || v <= 0) {
      s.matchM = null;
    } else s.matchM = lengthToM(v);
    analyze();
  });
  // Dropping files on the section works like CHOOSE PHOTOS.
  root.addEventListener('dragover', (e) => e.preventDefault());
  root.addEventListener('drop', (e) => {
    e.preventDefault();
    addFiles(e.dataTransfer?.files ?? []);
  });
  render();

  return {
    addFiles,
    clear: reset,
    /** Check again when the plan on the panel changed. */
    refresh() {
      if (!s.photos.length || s.busy) return;
      const plan = host.planned?.() ?? {};
      const ref = plan.suite ?? plan.result ?? null;
      if (ref === s.planRef) return;
      analyze();
    },
    analysis: () => s.analysis,
    destroy() {
      s.token += 1;
      s.photos = [];
      s.analysis = null;
      host.showOnMap?.(null);
      root.remove?.();
    },
  };
}

/** Independent local quality-review section; never stores or uploads photos. */
import { t } from '../../i18n/index.js';
import { reviewPhotoFiles } from './photoReview.js';
import { buildPhotoReviewReport } from './photoReviewReport.js';
import { plannedShots } from './photoQualityMatch.js';

export function mountPhotoReviewPanel({
  doc,
  container,
  host,
  reviewFiles = reviewPhotoFiles,
}) {
  const add = (tag, parent, text, role) => {
    const node = doc.createElement(tag);
    if (text != null) node.textContent = text;
    if (role) node.setAttribute('data-role', role);
    parent.append(node);
    return node;
  };
  const root = add('section', container, null, 'photo-quality-review');
  add('h4', root, t('PHOTO QUALITY REVIEW'));
  add(
    'p',
    root,
    t(
      'Local heuristic review only. Inspect flagged photos before re-flying; unflagged photos are not guaranteed usable. Nothing is uploaded.',
    ),
  );
  root.className = 'gev-dp-photocheck';
  const input = add('input', root, null, 'quality-input');
  input.setAttribute('aria-label', t('Choose a photo folder'));
  input.setAttribute('webkitdirectory', '');
  input.setAttribute('type', 'file');
  input.setAttribute('multiple', '');
  input.setAttribute('accept', '.jpg,.jpeg,image/jpeg');
  const clear = add('button', root, t('CLEAR PHOTOS'));
  clear.setAttribute('type', 'button');
  const save = add('button', root, t('SAVE QUALITY REPORT (JSON)'));
  save.setAttribute('type', 'button');
  save.disabled = true;
  const status = add('p', root, '', 'quality-status');
  status.setAttribute('role', 'status');
  const results = add('div', root, null, 'quality-results');
  let controller = null;
  let photos = [];
  let batchInfo = null;
  let report = null;
  let destroyed = false;
  const render = () => {
    results.replaceChildren();
    report = batchInfo
      ? {
          ...buildPhotoReviewReport(
            photos,
            plannedShots(host.planned?.() ?? {}),
            batchInfo,
          ),
          ...batchInfo,
        }
      : null;
    save.disabled = report == null;
    if (!report) return;
    add(
      'p',
      results,
      t('{count} photos; {candidates} re-fly candidates require inspection', {
        count: report.photos.length,
        candidates: report.refly.length,
      }),
    );
    for (const shot of report.refly) {
      add(
        'p',
        results,
        `${shot.key}: ${shot.lon}, ${shot.lat} — ${shot.reasons.join(', ')}`,
      );
    }
    for (const rejected of report.rejected)
      add('p', results, `${rejected.name}: — — ${rejected.reason}`);
    // User-controlled filenames are always text, never HTML.
    for (const row of report.photos) {
      add(
        'p',
        results,
        `${row.name}: ${row.score ?? '—'} — ${row.reasons.join(', ') || t('No sampled finding')}`,
      );
    }
  };
  const reset = () => {
    controller?.abort();
    controller = null;
    photos = [];
    batchInfo = null;
    report = null;
    input.value = '';
    input.disabled = false;
    status.textContent = '';
    results.replaceChildren();
    save.disabled = true;
  };
  async function addFiles(files) {
    if (destroyed) return null;
    reset();
    const current = new AbortController();
    controller = current;
    input.disabled = true;
    status.textContent = t('Reviewing photos locally…');
    try {
      const batch = await reviewFiles(files, { signal: current.signal });
      if (destroyed || controller !== current || current.signal.aborted)
        return null;
      photos = batch.photos;
      batchInfo = { rejected: batch.rejected, skippedOver: batch.skippedOver };
      render();
      status.textContent = t(
        '{rejected} unreadable files; {skipped} files over the limit',
        { rejected: batch.rejected.length, skipped: batch.skippedOver },
      );
      return report;
    } catch {
      if (!destroyed && controller === current)
        status.textContent = t(
          'Photo review unavailable. No results were accepted.',
        );
      return null;
    } finally {
      if (controller === current) {
        controller = null;
        input.disabled = false;
      }
    }
  }
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []);
    input.value = '';
    void addFiles(files);
  });
  clear.addEventListener('click', reset);
  save.addEventListener('click', () => {
    // Plan may have changed while the section remained open.
    render();
    if (report)
      host.download?.(
        'photo-quality-review.json',
        new TextEncoder().encode(JSON.stringify(report, null, 2)),
        'application/json',
      );
  });
  return {
    addFiles,
    clear: reset,
    refresh: render,
    report: () => report,
    destroy() {
      destroyed = true;
      reset();
      root.remove?.();
    },
  };
}

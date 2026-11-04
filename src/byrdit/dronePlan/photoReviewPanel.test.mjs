import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPhotoReviewPanel } from './photoReviewPanel.js';
// Minimal DOM surface used by this section; no browser globals or network.
function setup(reviewFiles) {
  const nodes = [];
  const doc = { createElement(tag) { const node = { tag, textContent: '', children: [], attrs: {}, handlers: {}, append(child) { this.children.push(child); }, setAttribute(k,v) { this.attrs[k]=v; }, replaceChildren() { this.children=[]; }, addEventListener(k,fn) { this.handlers[k]=fn; }, remove() {} }; nodes.push(node); return node; } };
  const container = doc.createElement('div');
  const downloads = [];
  const panel = mountPhotoReviewPanel({ doc, container, host: { planned: () => ({}), download: (...args) => downloads.push(args) }, reviewFiles });
  return { panel, nodes, downloads };
}
const photo = { name: '<script>not markup</script>.jpg', lon: null, lat: null, review: { sampleCount: 1, score: 30, reasons: ['soft-detail'] } };
const batch = { photos: [photo], rejected: [], skippedOver: 0 };

test('local quality section renders text-only names and exports report on click only', async () => {
  const {panel,nodes,downloads} = setup(async () => batch);
  const report = await panel.addFiles([{}]);
  assert.equal(report.photos.length, 1);
  assert.equal(downloads.length, 0);
  assert.ok(nodes.some(n => n.textContent.startsWith(photo.name)));
  nodes.find(n => n.textContent === 'SAVE QUALITY REPORT (JSON)').handlers.click();
  assert.equal(downloads.length, 1);
  assert.equal(JSON.parse(new TextDecoder().decode(downloads[0][1])).photos[0].name, photo.name);
  panel.clear();
  assert.equal(panel.report(), null);
});

test('clearing or destroying during decode prevents stale publication', async () => {
  let resolve; let signal;
  const {panel} = setup((files, opts) => { signal=opts.signal; return new Promise(r => {resolve=r;}); });
  const pending = panel.addFiles([{}]);
  panel.clear();
  assert.equal(signal.aborted,true);
  resolve(batch); await pending;
  assert.equal(panel.report(),null);
  panel.destroy();
  assert.equal(await panel.addFiles([{}]),null);
});

test('exceptions are hidden from the UI and leave no accepted report', async () => {
  const secret='Bearer synthetic-private-ABC123';
  const {panel,nodes} = setup(async () => { throw new Error(secret); });
  assert.equal(await panel.addFiles([{}]),null);
  assert.equal(nodes.some(n => n.textContent.includes(secret)),false);
  assert.ok(nodes.some(n => n.textContent === 'Photo review unavailable. No results were accepted.'));
});

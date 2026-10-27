import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SECTIONS,
  TIME_TRAVEL_CSS,
  TIME_TRAVEL_ID,
  TIME_TRAVEL_STYLE_ID,
  ensureTimeTravelMenu,
} from './menu.js';
import { mountHistoryControl } from '../historyUi/historyControl.js';
import { mountHistoryForShell } from '../historyUi/historyShell.js';
import { HISTORY_CSS } from '../historyUi/historyStyles.js';
import { fakeDocument, fakeWindow } from '../historyUi/fakeDom.mjs';
import { fixtureFetch, fixtureWorld } from '../historyUi/fixtures/b11Coverage.mjs';

const NOW = Date.parse('2026-10-14T16:00:00Z');
const HREF = 'https://gev.example/#lat=29.7&lon=-95.3';

test('no document, no menu', () => {
  assert.equal(ensureTimeTravelMenu({}), null);
});

test('built once per document, collapsed, hidden until a host claims a section', () => {
  const doc = fakeDocument();
  const menu = ensureTimeTravelMenu(doc);
  assert.equal(ensureTimeTravelMenu(doc), menu);
  assert.equal(doc.body.findAll((n) => n.id === TIME_TRAVEL_ID).length, 1);
  assert.equal(doc.head.findAll((n) => n.id === TIME_TRAVEL_STYLE_ID).length, 1);
  assert.equal(menu.root.hidden, true, 'nothing to show yet');
  assert.equal(menu.isOpen(), false);
  assert.equal(menu.root.getAttribute('data-expanded'), 'false');
  assert.equal(menu.toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(menu.toggle.getAttribute('aria-controls'), menu.body.id);
  assert.equal(menu.body.hidden, true);
  for (const { name } of SECTIONS)
    assert.equal(
      menu.root.find(`[data-section="${name}"]`).hidden,
      true,
      `${name} starts hidden`,
    );
});

test('toggle opens and closes; Escape closes and returns focus to the header', () => {
  const doc = fakeDocument();
  const menu = ensureTimeTravelMenu(doc);
  menu.claim('history');
  assert.equal(menu.root.hidden, false);
  assert.equal(menu.root.getAttribute('data-expanded'), 'false', 'still collapsed');
  menu.toggle.click();
  assert.equal(menu.isOpen(), true);
  assert.equal(menu.toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(menu.root.getAttribute('data-expanded'), 'true');
  assert.equal(menu.body.hidden, false);
  menu.toggle.click();
  assert.equal(menu.isOpen(), false);
  assert.equal(menu.body.hidden, true);
  menu.toggle.click();
  menu.body.dispatch('keydown', { key: 'Escape' });
  assert.equal(menu.isOpen(), false);
  assert.equal(doc.activeElement, menu.toggle);
  // Escape while closed is ignored
  menu.body.dispatch('keydown', { key: 'Escape' });
  assert.equal(menu.isOpen(), false);
});

test('sections: History and Imagery are claimed separately; Imagery absent unless claimed', () => {
  const doc = fakeDocument();
  const menu = ensureTimeTravelMenu(doc);
  const history = menu.claim('history');
  const section = (n) => menu.root.find(`[data-section="${n}"]`);
  assert.equal(history, menu.slot('history'));
  assert.equal(section('history').hidden, false);
  assert.equal(section('imagery').hidden, true, 'Wayback flag off: no Imagery');
  assert.equal(
    section('history').find('.gev-tt-heading').textContent,
    'History',
  );
  const imagery = menu.claim('imagery');
  assert.notEqual(imagery, history);
  assert.equal(section('imagery').hidden, false);
  assert.equal(
    section('imagery').find('.gev-tt-heading').textContent,
    'Imagery',
  );
  menu.release('imagery');
  assert.equal(section('imagery').hidden, true);
  assert.equal(menu.root.hidden, false, 'History still there');
  menu.release('history');
  assert.equal(menu.root.hidden, true);
  assert.throws(() => menu.claim('nope'), RangeError);
});

test('destroy removes the menu; the next ensure builds a fresh one', () => {
  const doc = fakeDocument();
  const menu = ensureTimeTravelMenu(doc);
  menu.destroy();
  assert.equal(doc.body.findAll((n) => n.id === TIME_TRAVEL_ID).length, 0);
  const next = ensureTimeTravelMenu(doc);
  assert.notEqual(next, menu);
  assert.equal(next.isOpen(), false);
});

test('CSS: a right-side panel, a phone sheet clear of the bottom nav, hidden for cockpit', () => {
  assert.match(TIME_TRAVEL_CSS, /\.gev-tt \{[^}]*right: var\(--right-rail-x/);
  assert.doesNotMatch(TIME_TRAVEL_CSS, /\.gev-tt \{[^}]*\bleft:/);
  assert.match(TIME_TRAVEL_CSS, /@media \(max-width: 900px\)/);
  assert.match(TIME_TRAVEL_CSS, /\.gev-tt\[data-expanded='true'\] \{ left: 8px;/);
  assert.match(TIME_TRAVEL_CSS, /cockpit-mode[^{]*\.gev-tt \{ display: none !important/);
});

test('History embedded in the menu: flows in the section, drops its bottom-left box', () => {
  const doc = fakeDocument();
  const menu = ensureTimeTravelMenu(doc);
  const win = fakeWindow(HREF, fixtureFetch(fixtureWorld(NOW)));
  const control = mountHistoryControl({
    document: doc,
    window: win,
    parent: menu.claim('history'),
    embedded: true,
  });
  assert.equal(control.root.parentNode, menu.slot('history'));
  assert.equal(control.root.getAttribute('data-embedded'), 'true');
  assert.equal(control.root.getAttribute('data-expanded'), 'false');
  assert.equal(
    doc.body.children.filter((c) => c.className.split(' ').includes('gev-hist'))
      .length,
    0,
    'nothing History at the bottom of the page',
  );
  const embedded = HISTORY_CSS.slice(HISTORY_CSS.lastIndexOf("[data-embedded='true']"));
  assert.match(embedded, /position: static/);
  // the old placement rules stay only as the un-hosted fallback
  assert.match(HISTORY_CSS, /\.gev-hist \{\s*position: fixed;/);
  control.destroy();
});

test('History without the flag param keeps its fallback box (not embedded)', () => {
  const doc = fakeDocument();
  const win = fakeWindow(HREF, fixtureFetch(fixtureWorld(NOW)));
  const control = mountHistoryControl({ document: doc, window: win });
  assert.equal(control.root.getAttribute('data-embedded'), null);
  assert.equal(control.root.parentNode, doc.body);
  control.destroy();
});

test('shell mounts History into the menu and releases the section on destroy', () => {
  const doc = fakeDocument();
  const win = fakeWindow(HREF, fixtureFetch(fixtureWorld(NOW)));
  const handle = mountHistoryForShell(null, { window: win, document: doc });
  const menu = ensureTimeTravelMenu(doc);
  assert.equal(handle.root.parentNode, menu.slot('history'));
  assert.equal(menu.root.hidden, false);
  assert.equal(menu.isOpen(), false, 'collapsed on load');
  assert.equal(menu.root.find('[data-section="imagery"]').hidden, true);
  // the voice tool and QA hook still get the same handle
  assert.equal(win.__gevHistorySwap.handle, handle);
  handle.destroy();
  assert.equal(menu.root.hidden, true);
});

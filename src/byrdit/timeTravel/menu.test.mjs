import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SECTIONS,
  TIME_TRAVEL_CSS,
  TIME_TRAVEL_BODY_ID,
  TIME_TRAVEL_ID,
  TIME_TRAVEL_TOGGLE_ID,
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
  assert.match(menu.root.className, /\bpanel-collapsible\b/);
  assert.match(menu.root.className, /\bcollapsed\b/);
  assert.equal(menu.root.getAttribute('data-panel-id'), TIME_TRAVEL_ID);
  assert.equal(menu.toggle.getAttribute('data-collapse-target'), TIME_TRAVEL_ID);
  assert.equal(menu.toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(menu.toggle.getAttribute('aria-controls'), menu.body.id);
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
  assert.equal(menu.isOpen(), false, 'still collapsed');
  menu.toggle.click();
  assert.equal(menu.isOpen(), true);
  assert.equal(menu.toggle.getAttribute('aria-expanded'), 'true');
  assert.doesNotMatch(menu.root.className, /\bcollapsed\b/);
  assert.equal(menu.toggle.textContent, '▶');
  menu.toggle.click();
  assert.equal(menu.isOpen(), false);
  assert.match(menu.root.className, /\bcollapsed\b/);
  assert.equal(menu.toggle.textContent, '◀');
  menu.toggle.click();
  menu.body.dispatch('keydown', { key: 'Escape' });
  assert.equal(menu.isOpen(), false);
  assert.equal(doc.activeElement, menu.toggle);
  // Escape while closed is ignored
  menu.body.dispatch('keydown', { key: 'Escape' });
  assert.equal(menu.isOpen(), false);
});

test('sections: History, Imagery and Aerial are claimed separately; absent unless claimed', () => {
  const doc = fakeDocument();
  const menu = ensureTimeTravelMenu(doc);
  const history = menu.claim('history');
  const section = (n) => menu.root.find(`[data-section="${n}"]`);
  assert.equal(history, menu.slot('history'));
  assert.equal(section('history').hidden, false);
  assert.equal(section('imagery').hidden, true, 'Wayback flag off: no Imagery');
  assert.equal(section('aerial').hidden, true, 'no NAIP offer: no Aerial');
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
  const aerial = menu.claim('aerial');
  assert.equal(aerial, menu.slot('aerial'));
  assert.notEqual(aerial, imagery);
  assert.equal(section('aerial').hidden, false);
  assert.equal(
    section('aerial').find('.gev-tt-heading').textContent,
    'Aerial (NAIP)',
  );
  assert.deepEqual(
    menu.body.findAll('section').map((n) => n.getAttribute('data-section')),
    ['history', 'imagery', 'aerial', 'overlays'],
    'sections keep their order',
  );
  menu.release('aerial');
  assert.equal(section('aerial').hidden, true);
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

test('CSS: sections only; the card itself is rail CSS, not a fixed box', () => {
  assert.doesNotMatch(TIME_TRAVEL_CSS, /position:\s*fixed/);
  assert.doesNotMatch(TIME_TRAVEL_CSS, /\.gev-tt \{/);
  assert.match(TIME_TRAVEL_CSS, /\.gev-tt-section\[hidden\]/);
});

function railDocument() {
  const doc = fakeDocument();
  const rail = doc.createElement('aside');
  rail.setAttribute('id', 'right-context-rail');
  const context = doc.createElement('div');
  context.setAttribute('id', 'global-context-panel');
  rail.append(context);
  doc.body.append(rail);
  return { doc, rail, context };
}

test('without a static card one is built in the rail (before Context)', () => {
  const { doc, rail } = railDocument();
  const menu = ensureTimeTravelMenu(doc);
  assert.equal(menu.root.parentNode, rail);
  assert.equal(doc.getElementById(TIME_TRAVEL_ID), menu.root);
});

function staticCard(doc, { chrome = false } = {}) {
  const root = doc.createElement('div');
  root.setAttribute('id', TIME_TRAVEL_ID);
  root.setAttribute('class', 'panel-collapsible collapsed');
  root.hidden = true;
  const inner = doc.createElement('div');
  const button = doc.createElement('button');
  button.setAttribute('id', TIME_TRAVEL_TOGGLE_ID);
  button.setAttribute('class', 'panel-collapse-btn');
  const body = doc.createElement('div');
  body.setAttribute('id', TIME_TRAVEL_BODY_ID);
  inner.append(button, body);
  root.append(inner);
  doc.body.append(root);
  let clicks = 0;
  if (chrome)
    // what panelChrome binds for [data-collapse-target]
    button.addEventListener('click', () => {
      clicks++;
      const open = root.className.includes('collapsed');
      root.setAttribute(
        'class',
        open ? 'panel-collapsible' : 'panel-collapsible collapsed',
      );
    });
  return { root, button, body, clicks: () => clicks };
}

test('adopts the static rail card instead of building a floating one', () => {
  const doc = fakeDocument();
  const card = staticCard(doc);
  const menu = ensureTimeTravelMenu(doc);
  assert.equal(menu.root, card.root);
  assert.equal(menu.toggle, card.button);
  assert.equal(menu.body, card.body);
  assert.equal(doc.body.findAll((n) => n.id === TIME_TRAVEL_ID).length, 1);
  assert.equal(card.root.hidden, true, 'stays hidden until claimed');
  assert.equal(card.button.getAttribute('aria-controls'), TIME_TRAVEL_BODY_ID);
  menu.claim('aerial');
  assert.equal(card.root.hidden, false);
  assert.equal(card.body.findAll('section').length, SECTIONS.length);
  menu.release('aerial');
  assert.equal(card.root.hidden, true);
  menu.destroy();
  assert.equal(doc.getElementById(TIME_TRAVEL_ID), card.root, 'static card stays');
  assert.equal(card.root.hidden, true);
  assert.equal(card.body.children.length, 0, 'sections removed');
});

test('adopted card: open/close goes through the panel chrome button', () => {
  const doc = fakeDocument();
  const card = staticCard(doc, { chrome: true });
  const menu = ensureTimeTravelMenu(doc);
  menu.claim('history');
  assert.equal(menu.isOpen(), false);
  menu.setOpen(true);
  assert.equal(card.clicks(), 1, 'the chrome handler did the work');
  assert.equal(menu.isOpen(), true);
  menu.setOpen(true);
  assert.equal(card.clicks(), 1, 'no click when already open');
  card.root.dispatch('keydown', { key: 'Escape' });
  assert.equal(menu.isOpen(), false);
  assert.equal(card.clicks(), 2);
  assert.equal(doc.activeElement, card.button);
});

test('adopted card without a chrome handler is still opened by setOpen', () => {
  const doc = fakeDocument();
  const card = staticCard(doc);
  const menu = ensureTimeTravelMenu(doc);
  menu.setOpen(true);
  assert.equal(menu.isOpen(), true);
  assert.equal(card.button.getAttribute('aria-expanded'), 'true');
  menu.setOpen(false);
  assert.equal(menu.isOpen(), false);
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

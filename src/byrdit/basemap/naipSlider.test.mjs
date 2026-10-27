import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NAIP_SLIDER_ID,
  createNaipMenuSlider,
  createNaipSlider,
} from './naipSlider.js';
import { ensureTimeTravelMenu } from '../timeTravel/menu.js';
import { fakeDocument } from '../historyUi/fakeDom.mjs';

const STATE = Object.freeze({
  ticks: [2012, 2016, 2020, 2024],
  year: 2024,
  yearB: 2016,
  enabled: true,
  compare: false,
  label: '2024: NAIP 2024',
  labelB: '',
});

function options(doc, container) {
  return {
    container,
    doc,
    state: { ...STATE },
    onYear() {},
    onYearB() {},
    onEnabled() {},
    onCompare() {},
  };
}

test('floating slider keeps its absolute bottom bar', () => {
  const doc = fakeDocument();
  const slider = createNaipSlider(options(doc, doc.body));
  assert.equal(slider.element.id, NAIP_SLIDER_ID);
  assert.equal(slider.element.style.position, 'absolute');
  assert.equal(slider.element.style.bottom, '118px');
  assert.equal(slider.element.getAttribute('data-embedded'), null);
});

test('embedded slider has no absolute positioning and no own chrome', () => {
  const doc = fakeDocument();
  const host = doc.createElement('div');
  doc.body.append(host);
  const slider = createNaipSlider({ ...options(doc, host), embedded: true });
  const { style } = slider.element;
  assert.equal(slider.element.parentNode, host);
  assert.equal(slider.element.getAttribute('data-embedded'), 'true');
  assert.equal(style.position, 'static');
  assert.equal(style.width, '100%');
  assert.equal(style.background, 'transparent');
  for (const k of ['left', 'bottom', 'transform', 'zIndex'])
    assert.equal(style[k], undefined, `${k} not set`);
  // labels come through the catalog helper (English here)
  const text = slider.element.textContent;
  assert.match(text, /Aerial/);
  assert.match(text, /Compare/);
});

test('embedded slider: update, setVisible and destroy', () => {
  const doc = fakeDocument();
  const host = doc.createElement('div');
  doc.body.append(host);
  const slider = createNaipSlider({ ...options(doc, host), embedded: true });
  const [aerialBox, compareBox] = slider.element.findAll(
    (n) => n.tagName === 'INPUT' && n.getAttribute('type') === 'checkbox',
  );
  assert.equal(aerialBox.checked, true);
  assert.equal(compareBox.checked, false);
  slider.update({ ...STATE, enabled: false, compare: true, labelB: '2016' });
  assert.equal(aerialBox.checked, false);
  assert.equal(compareBox.checked, true);
  slider.setVisible(false);
  assert.equal(slider.element.hidden, true);
  assert.equal(slider.element.style.display, 'none');
  slider.setVisible(true);
  assert.equal(slider.element.hidden, false);
  assert.equal(slider.element.style.display, 'flex');
  slider.destroy();
  assert.equal(slider.element.parentNode, null);
});

test('menu slider mounts in the Aerial section; claims only while visible', () => {
  const doc = fakeDocument();
  const menu = ensureTimeTravelMenu(doc);
  const slider = createNaipMenuSlider(options(doc, doc.body));
  const section = menu.root.find('[data-section="aerial"]');
  assert.equal(slider.element.parentNode, menu.slot('aerial'));
  assert.equal(slider.element.getAttribute('data-embedded'), 'true');
  assert.equal(section.hidden, true, 'not shown before NAIP is on screen');
  assert.equal(menu.root.hidden, true);
  slider.setVisible(true);
  assert.equal(section.hidden, false);
  assert.equal(menu.root.hidden, false);
  slider.setVisible(false);
  assert.equal(section.hidden, true, 'released when NAIP is not on screen');
  assert.equal(menu.root.hidden, true);
  slider.setVisible(true);
  slider.destroy();
  assert.equal(section.hidden, true, 'destroy releases the section');
  assert.equal(slider.element.parentNode, null);
  assert.equal(
    doc.body.findAll((n) => n.id === NAIP_SLIDER_ID).length,
    0,
    'no floating slider',
  );
});

test('menu slider falls back to the floating bar when no menu can host it', () => {
  const doc = fakeDocument();
  const slider = createNaipMenuSlider(options(doc, doc.body), {
    ensureMenu: () => null,
  });
  assert.equal(slider.element.parentNode, doc.body);
  assert.equal(slider.element.style.position, 'absolute');
  assert.equal(slider.element.getAttribute('data-embedded'), null);
});

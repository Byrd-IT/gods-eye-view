import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDiscreteSlider,
  createTimeSlider,
  parsePickerValue,
  pickerValue,
  timeSliderCss,
} from './timeSlider.js';
import { fakeDocument } from '../historyUi/fakeDom.mjs';

function make(extra = {}) {
  const doc = fakeDocument();
  const calls = [];
  const slider = createTimeSlider({
    document: doc,
    parent: doc.body,
    ariaLabel: 'Test time',
    rates: [1, 10],
    picker: { kind: 'datetime-local', zone: 'utc', label: 'Go to' },
    onScrub: (f, p) => calls.push(['scrub', f, p]),
    onStep: (d, c) => calls.push(['step', d, c]),
    onJump: (w) => calls.push(['jump', w]),
    onPlay: (w) => calls.push(['play', w]),
    onRate: (r) => calls.push(['rate', r]),
    onPick: (ms) => calls.push(['pick', ms]),
    ...extra,
  });
  slider.scrub.getBoundingClientRect = () => ({ left: 0, width: 200 });
  return { doc, slider, calls };
}

test('picker text <-> ms round trips in utc and for date-only', () => {
  const ms = Date.UTC(2026, 9, 31, 4, 5);
  assert.equal(pickerValue(ms), '2026-10-31T04:05');
  assert.equal(parsePickerValue('2026-10-31T04:05'), ms);
  assert.equal(pickerValue(ms, { kind: 'date' }), '2026-10-31');
  assert.equal(
    parsePickerValue('2026-10-31', { kind: 'date' }),
    Date.UTC(2026, 9, 31),
  );
  assert.ok(Number.isNaN(parsePickerValue('2026-10')));
  assert.equal(pickerValue(Number.NaN), '');
});

test('css is scoped to the prefix', () => {
  assert.match(timeSliderCss('gev-hist'), /\.gev-hist/);
  assert.doesNotMatch(timeSliderCss('gev-hist'), /\.gev-ts-/);
});

test('component: pointer drag reports start/move/end fractions', () => {
  const { slider, calls } = make();
  slider.scrub.dispatch('pointerdown', { clientX: 100, pointerId: 1 });
  slider.scrub.dispatch('pointermove', { clientX: 150 });
  slider.scrub.dispatch('pointerup', {});
  assert.deepEqual(calls, [
    ['scrub', 0.5, 'start'],
    ['scrub', 0.75, 'move'],
    ['scrub', 0.75, 'end'],
  ]);
});

test('component: keys step, Shift and PageUp move 10, Home/End jump, keys stay inside', () => {
  const { slider, calls } = make();
  const key = (k, extra = {}) =>
    slider.scrub.dispatch('keydown', {
      key: k,
      stopPropagation() {
        this.stopped = true;
      },
      ...extra,
    });
  assert.equal(key('ArrowRight').stopped, true);
  key('ArrowLeft', { shiftKey: true });
  key('PageUp');
  key('PageDown');
  key('Home');
  key('End');
  assert.deepEqual(calls, [
    ['step', 1, 1],
    ['step', -1, 10],
    ['step', 1, 10],
    ['step', -1, 10],
    ['jump', 'start'],
    ['jump', 'end'],
  ]);
  const other = key('x');
  assert.notEqual(other.stopped, true, 'unrelated keys are not swallowed');
});

test('component: position, aria and value text follow the caller', () => {
  const { slider } = make();
  slider.setFraction(0.25, 'T1');
  assert.equal(slider.scrub.getAttribute('role'), 'slider');
  assert.equal(slider.scrub.getAttribute('aria-label'), 'Test time');
  assert.equal(slider.scrub.getAttribute('aria-valuenow'), '250');
  assert.equal(slider.scrub.getAttribute('aria-valuetext'), 'T1');
  slider.setFraction(5);
  assert.equal(slider.scrub.getAttribute('aria-valuenow'), '1000', 'clamped');
});

test('component: play, speed and picker callbacks', () => {
  const { slider, calls } = make();
  slider.play.click();
  slider.rateButtons.get(10).click();
  slider.picker.value = '2026-10-31T04:05';
  slider.picker.dispatch('change', {});
  slider.picker.value = 'garbage';
  slider.picker.dispatch('change', {});
  assert.deepEqual(calls, [
    ['play', true],
    ['rate', 10],
    ['pick', Date.UTC(2026, 9, 31, 4, 5)],
  ]);
});

test('discrete: one item per step, clamped, fraction = index / (n - 1)', () => {
  const doc = fakeDocument();
  const got = [];
  const s = createDiscreteSlider({
    document: doc,
    parent: doc.body,
    items: ['2010', '2014', '2018', '2022'].map((y) => ({
      value: y,
      label: y,
      ms: Date.UTC(Number(y), 0, 1),
    })),
    picker: { kind: 'date', zone: 'utc', label: 'd' },
    onChange: (i, { source }) => got.push([i, source]),
  });
  s.scrub.getBoundingClientRect = () => ({ left: 0, width: 300 });
  assert.equal(s.getIndex(), 3, 'starts on the newest');
  s.back.click();
  s.back.click();
  s.back.click();
  s.back.click();
  assert.equal(s.getIndex(), 0, 'clamped at the oldest');
  assert.equal(s.back.disabled, true);
  s.fwd.click();
  assert.equal(s.getIndex(), 1);
  s.scrub.dispatch('pointerdown', { clientX: 300, pointerId: 1 });
  s.scrub.dispatch('pointerup', {});
  assert.equal(s.getIndex(), 3);
  s.picker.value = '2018-06-01';
  s.picker.dispatch('change', {});
  assert.equal(s.getIndex(), 2, 'the picker takes the nearest item');
  assert.deepEqual(
    got.map((g) => g[1]),
    ['step', 'step', 'step', 'step', 'scrub', 'pick'],
    'one onChange per real move (clamped steps are silent)',
  );
});

test('discrete: play moves forward one item per tick and stops at the newest', () => {
  const doc = fakeDocument();
  const timers = {
    fns: [],
    setInterval(fn) {
      this.fns.push(fn);
      return this.fns.length;
    },
    clearInterval() {
      this.fns = [];
    },
  };
  const got = [];
  const s = createDiscreteSlider({
    document: doc,
    parent: doc.body,
    timers,
    index: 0,
    items: [1, 2, 3].map((v) => ({ value: v, label: String(v) })),
    onChange: (i, { source }) => got.push([i, source]),
  });
  s.play.click();
  assert.equal(s.isPlaying(), true);
  timers.fns[0]();
  timers.fns[0]?.();
  assert.deepEqual(got, [
    [1, 'play'],
    [2, 'play'],
  ]);
  assert.equal(s.isPlaying(), false, 'stopped on the newest');
});

test('discrete: a drag stops playback and destroyed / dragging read live', () => {
  const doc = fakeDocument();
  const timers = {
    fns: [],
    setInterval(fn) {
      this.fns.push(fn);
      return 1;
    },
    clearInterval() {
      this.fns = [];
    },
  };
  const s = createDiscreteSlider({
    document: doc,
    parent: doc.body,
    timers,
    index: 0,
    items: [1, 2, 3, 4].map((v) => ({ value: v, label: String(v) })),
  });
  s.scrub.getBoundingClientRect = () => ({ left: 0, width: 300 });
  s.play.click();
  assert.equal(s.isPlaying(), true);
  s.scrub.dispatch('pointerdown', { clientX: 100, pointerId: 1 });
  assert.equal(s.isPlaying(), false, 'the drag took over');
  assert.equal(s.dragging, true);
  s.scrub.dispatch('pointerup', {});
  assert.equal(s.dragging, false);
  assert.equal(s.destroyed, false);
  s.destroy();
  assert.equal(s.destroyed, true);
});

test('discrete: tick labels replace the edges row; many items draw no ticks', () => {
  const doc = fakeDocument();
  const few = createDiscreteSlider({
    document: doc,
    parent: doc.body,
    tickLabels: true,
    items: [2010, 2014, 2018].map((v) => ({ value: v, label: String(v) })),
  });
  assert.equal(few.edges.hidden, true);
  const many = createDiscreteSlider({
    document: doc,
    parent: doc.body,
    items: Array.from({ length: 200 }, (_, i) => ({ value: i, label: `${i}` })),
  });
  assert.equal(many.scrub.children.length, 1, 'only the thumb: no tick marks');
});

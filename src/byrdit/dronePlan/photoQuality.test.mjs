import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_THRESHOLDS,
  LIMITATIONS,
  analyzeBlur,
  analyzeClipping,
  analyzeDirectionalMotion,
  analyzeGlare,
  analyzeNoise,
  analyzePhotoQuality,
  analyzeShadows,
  normalizeThresholds,
} from './photoQuality.js';

/** RGBA image. `fill(x, y)` returns [r, g, b] or [r, g, b, a]. */
function image(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const px = fill(x, y);
      const o = (y * width + x) * 4;
      data[o] = px[0];
      data[o + 1] = px[1];
      data[o + 2] = px[2];
      data[o + 3] = px[3] ?? 255;
    }
  }
  return { width, height, data };
}

const gray = (v) => [v, v, v];

function checker(cell = 8, size = 64, dark = 20, light = 220) {
  return image(size, size, (x, y) => {
    const on = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
    return gray(on ? dark : light);
  });
}

/** Box average along x. Used only to build a fixture, not by the module. */
function smearX(img, radius) {
  return image(img.width, img.height, (x, y) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let dx = -radius; dx <= radius; dx += 1) {
      const xx = Math.min(img.width - 1, Math.max(0, x + dx));
      const o = (y * img.width + xx) * 4;
      r += img.data[o];
      g += img.data[o + 1];
      b += img.data[o + 2];
      n += 1;
    }
    return [r / n, g / n, b / n];
  });
}

function addNoise(img, amp, seed = 1) {
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return (s / 2147483647) * 2 - 1;
  };
  return image(img.width, img.height, (x, y) => {
    const o = (y * img.width + x) * 4;
    const n = rnd() * amp;
    return [img.data[o] + n, img.data[o + 1] + n, img.data[o + 2] + n];
  });
}

const flat = () => image(64, 64, () => gray(128));
const barsV = () =>
  image(64, 64, (x) => gray(Math.floor(x / 8) % 2 === 0 ? 20 : 220));

const OVERCLAIM =
  /out of focus|motion blur detected|lens flare|underexposed|iso noise|photogrammetry (pass|fail|accept|reject)/i;

function assertNoOverclaim(result) {
  const texts = [result.reason, result.scoreNote];
  if (result.metrics) {
    for (const metric of Object.values(result.metrics)) {
      texts.push(metric.reason, metric.code);
    }
  }
  for (const text of texts) {
    if (typeof text === 'string') assert.doesNotMatch(text, OVERCLAIM);
  }
}

test('unusable pixel inputs are refused without throwing', () => {
  for (const bad of [
    null,
    undefined,
    'nope',
    {},
    { width: 8, height: 8 },
    { width: 0, height: 8, data: new Uint8ClampedArray(32) },
    { width: 8.5, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) },
    { width: -1, height: 8, data: new Uint8ClampedArray(8) },
    { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8) },
    { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4 - 1) },
  ]) {
    assert.doesNotThrow(() => analyzePhotoQuality(bad));
    const r = analyzePhotoQuality(bad);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'not-image');
    assert.equal(r.score, null);
    assert.equal(r.metrics, null);
  }
});

test('a tiny image is too small to grade, and the pixels are not mutated', () => {
  const tiny = image(7, 7, () => gray(40));
  const before = tiny.data[0];
  const r = analyzePhotoQuality(tiny);
  assert.equal(r.ok, true);
  assert.equal(r.code, 'too-small');
  assert.equal(r.score, null);
  assert.equal(tiny.data[0], before);
  for (const metric of Object.values(r.metrics)) {
    assert.equal(metric.status, 'unknown');
    assert.equal(metric.score, null);
    assert.equal(metric.countsTowardScore, false);
    assert.equal(metric.code, 'too-small');
  }
});

test('a flat frame has low edge energy, so blur is not inferred', () => {
  const r = analyzeBlur(flat());
  assert.equal(r.status, 'unknown');
  assert.equal(r.score, null);
  assert.equal(r.countsTowardScore, false);
  assert.equal(r.code, 'low-edge-energy');
  assert.equal(r.metrics.laplacianVariance, 0);
  assert.match(r.reason, /not inferred/i);
  assert.match(r.reason, /low-texture|flat/i);
});

test('a checkerboard has enough edge energy to be called sharp at the working sample', () => {
  const r = analyzeBlur(checker());
  assert.equal(r.status, 'sharp');
  assert.equal(r.code, 'sharp-edges');
  assert.equal(r.countsTowardScore, true);
  assert.equal(r.score, 100);
  assert.ok(r.metrics.laplacianVariance >= DEFAULT_THRESHOLDS.blurSharpMin);
  assert.match(r.reason, /not a focus/i);
});

test('blur thresholds are configurable and non-finite overrides are ignored', () => {
  const sharp = checker();
  const raised = analyzeBlur(sharp, { blurSharpMin: 1e12 });
  assert.equal(raised.status, 'unknown');
  assert.equal(raised.code, 'low-edge-energy');
  const ignored = analyzeBlur(sharp, { blurSharpMin: Number.NaN });
  assert.equal(ignored.status, 'sharp');
  const resolved = normalizeThresholds({ blurScoreFull: 1e18, clipNearWhite: 'nope' });
  assert.equal(resolved.blurScoreFull, 1e18);
  assert.equal(resolved.clipNearWhite, DEFAULT_THRESHOLDS.clipNearWhite);
  assert.equal(resolved.blurSharpMin, DEFAULT_THRESHOLDS.blurSharpMin);
});

test('directional smear is reported as an observation and never as a warning', () => {
  const none = analyzeDirectionalMotion(checker());
  const smeared = analyzeDirectionalMotion(smearX(checker(), 5));
  const facade = analyzeDirectionalMotion(barsV());
  const blank = analyzeDirectionalMotion(flat());

  assert.equal(none.metrics.observation, 'balanced');
  assert.equal(smeared.metrics.observation, 'horizontal-detail-weaker');
  assert.equal(facade.metrics.observation, 'vertical-detail-weaker');
  assert.equal(blank.metrics.observation, 'unmeasurable');

  for (const r of [none, smeared, facade, blank]) {
    assert.equal(r.status, 'unknown');
    assert.equal(r.warning, null);
    assert.equal(r.score, null);
    assert.equal(r.countsTowardScore, false);
    assert.equal(r.code, 'not-inferable');
    assert.match(r.reason, /no directional motion warning/i);
    assert.match(r.reason, /scene/i);
  }
  assert.ok(smeared.metrics.horizontalEnergy < smeared.metrics.verticalEnergy);
  assert.ok(facade.metrics.horizontalEnergy > facade.metrics.verticalEnergy);
});

test('clipping counts 8-bit end-of-range samples and does not call a clean frame a pass', () => {
  const clean = analyzeClipping(flat());
  assert.equal(clean.status, 'ok');
  assert.equal(clean.countsTowardScore, false);
  assert.equal(clean.score, 100);
  assert.equal(clean.metrics.highlightCount, 0);
  assert.equal(clean.metrics.shadowClipCount, 0);

  const one = image(32, 32, (x, y) => {
    if (x === 0 && y === 0) return [250, 10, 10];
    if (x === 1 && y === 0) return [249, 249, 249];
    if (x === 2 && y === 0) return [0, 0, 0];
    if (x === 3 && y === 0) return [6, 0, 0];
    return gray(128);
  });
  const counts = analyzeClipping(one);
  assert.equal(counts.metrics.highlightCount, 1);
  assert.equal(counts.metrics.shadowClipCount, 1);
  assert.equal(counts.status, 'ok');

  const blown = image(32, 32, (x) => (x < 4 ? [255, 255, 255] : gray(128)));
  const clipped = analyzeClipping(blown);
  assert.equal(clipped.status, 'clipped');
  assert.equal(clipped.code, 'end-of-range');
  assert.equal(clipped.countsTowardScore, true);
  assert.equal(clipped.metrics.highlightFraction, 4 / 32);
  assert.ok(clipped.score < 100);
  assert.match(clipped.reason, /does not say whether the camera/i);

  const lenient = analyzeClipping(blown, { clipFractionWarn: 0.5 });
  assert.equal(lenient.status, 'ok');
  assert.equal(lenient.countsTowardScore, false);
});

test('shadows describe dark pixels and do not infer crushed shadows or underexposure', () => {
  const bright = analyzeShadows(image(64, 64, () => gray(140)));
  assert.equal(bright.status, 'ok');
  assert.equal(bright.code, 'few-dark-pixels');
  assert.equal(bright.countsTowardScore, false);
  assert.match(bright.reason, /not an exposure grade/i);

  const detailed = image(64, 64, (x) => gray(x % 2 === 0 ? 8 : 28));
  const kept = analyzeShadows(detailed);
  assert.equal(kept.status, 'ok');
  assert.equal(kept.code, 'dark-areas-have-contrast');
  assert.ok(kept.metrics.darkLocalContrast >= DEFAULT_THRESHOLDS.shadowLocalMin);

  const crushed = analyzeShadows(image(64, 64, () => gray(8)));
  assert.equal(crushed.status, 'unknown');
  assert.equal(crushed.score, null);
  assert.equal(crushed.code, 'dark-contrast-unknown');
  assert.match(crushed.reason, /not inferred|neither is inferred/i);
  assert.ok(crushed.metrics.darkFraction > DEFAULT_THRESHOLDS.shadowFractionMin);
});

test('noise is estimated only from flat blocks, otherwise unknown', () => {
  const quiet = analyzeNoise(flat());
  assert.equal(quiet.status, 'low');
  assert.equal(quiet.countsTowardScore, false);
  assert.equal(quiet.score, 100);
  assert.match(quiet.reason, /jpeg/i);

  const grain = analyzeNoise(addNoise(flat(), 20));
  assert.equal(grain.status, 'elevated');
  assert.equal(grain.countsTowardScore, true);
  assert.equal(grain.score, DEFAULT_THRESHOLDS.noiseScoreElevated);
  assert.match(grain.reason, /not separated/i);

  const busy = analyzeNoise(checker(1));
  assert.equal(busy.status, 'unknown');
  assert.equal(busy.score, null);
  assert.equal(busy.code, 'no-flat-blocks');
  assert.match(busy.reason, /not called noisy/i);
});

test('glare is a heuristic and is withheld when the cue is the whole frame or has no context', () => {
  const none = analyzeGlare(checker());
  assert.equal(none.status, 'none');
  assert.equal(none.score, null);
  assert.equal(none.countsTowardScore, false);
  assert.match(none.reason, /not ruled out/i);

  const blob = image(64, 64, (x, y) => {
    if (x > 40 && y > 40) return [252, 252, 250];
    return [40 + (x % 9) * 8, 50 + (y % 7) * 10, 30];
  });
  const possible = analyzeGlare(blob);
  assert.equal(possible.status, 'possible');
  assert.equal(possible.code, 'bright-desaturated-region');
  assert.equal(possible.countsTowardScore, true);
  assert.ok(possible.score > 0 && possible.score < 100);
  assert.match(possible.reason, /heuristic/i);
  assert.match(possible.reason, /not a detection/i);

  const snow = analyzeGlare(image(64, 64, () => [250, 250, 250]));
  assert.equal(snow.status, 'unknown');
  assert.equal(snow.score, null);
  assert.match(snow.reason, /not inferred/i);

  const blobOnFlat = image(64, 64, (x, y) =>
    x > 40 && y > 40 ? [252, 252, 252] : gray(128),
  );
  assert.equal(analyzeGlare(blobOnFlat).status, 'unknown');
});

test('the composite scores only sharpness readings and defect findings', () => {
  const blank = analyzePhotoQuality(flat());
  assert.equal(blank.ok, true);
  assert.equal(blank.code, 'measured');
  assert.equal(blank.score, null);
  assert.ok(blank.unknown.includes('blur'));
  assert.ok(blank.unknown.includes('directionalMotion'));
  assert.deepEqual(blank.findings, []);
  assert.match(blank.scoreNote, /not treated as passes/i);
  assert.match(blank.scoreNote, /not a photogrammetry/i);

  const sharp = analyzePhotoQuality(checker());
  assert.equal(sharp.score, sharp.metrics.blur.score);
  assert.equal(sharp.findings.includes('clipping'), false);
  assert.ok(sharp.unknown.includes('directionalMotion'));

  const blown = analyzePhotoQuality(
    image(32, 32, (x) => (x < 4 ? [255, 255, 255] : gray(128))),
  );
  assert.ok(blown.findings.includes('clipping'));
  assert.equal(blown.metrics.clipping.countsTowardScore, true);
  assert.ok(blown.score == null || blown.score < 100);

  const lenient = analyzePhotoQuality(
    image(32, 32, (x) => (x < 4 ? [255, 255, 255] : gray(128))),
    { thresholds: { clipFractionWarn: 0.5 } },
  );
  assert.equal(lenient.metrics.clipping.status, 'ok');
  assert.equal(lenient.findings.includes('clipping'), false);

  assertNoOverclaim(blank);
  assertNoOverclaim(sharp);
  assertNoOverclaim(blown);
});

test('histogram metrics stride above the scan cap and can miss a one-pixel speck', () => {
  const speck = image(40, 40, (x, y) =>
    x === 1 && y === 1 ? [255, 255, 255] : gray(128),
  );
  const strided = analyzeClipping(speck, { maxFullScanPixels: 100 });
  assert.equal(strided.metrics.stride, 4);
  assert.equal(strided.metrics.highlightCount, 0);
  assert.equal(analyzeClipping(speck).metrics.highlightCount, 1);

  const band = image(40, 40, (x) => (x < 16 ? [255, 0, 0] : gray(90)));
  const wide = analyzeClipping(band, { maxFullScanPixels: 100 });
  assert.equal(wide.metrics.stride, 4);
  assert.equal(wide.metrics.highlightFraction, 0.4);
  assert.equal(wide.status, 'clipped');
});

test('working-sample size and returned thresholds are explicit and isolated', () => {
  assert.equal(Object.isFrozen(DEFAULT_THRESHOLDS), true);
  const r = analyzePhotoQuality(checker(), {
    thresholds: { maxSampleEdge: 32 },
  });
  assert.ok(r.metrics.blur.metrics.sampledWidth <= 32);
  assert.ok(r.metrics.blur.metrics.sampledHeight <= 32);
  assert.equal(r.metrics.blur.status, 'sharp');
  r.thresholds.blurSharpMin = 1;
  assert.equal(DEFAULT_THRESHOLDS.blurSharpMin > 1, true);
  assert.ok(LIMITATIONS.length >= 4);
  assert.match(LIMITATIONS.join(' '), /single frame/);
  assert.match(LIMITATIONS.join(' '), /heuristic/);
});

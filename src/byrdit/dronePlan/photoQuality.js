/**
 * Browser-local photo quality from RGBA pixels. Pure functions, no DOM, no
 * network, no EXIF. A caller decodes the file (canvas, createImageBitmap) and
 * passes `{ width, height, data }` with 4 bytes per pixel.
 *
 * These are pixel measurements with explicit holes, not a grade of the photo
 * and not a photogrammetry accept/reject:
 *
 * - Blur reads two things. Laplacian energy on the working sample, and
 *   full-resolution acutance (steepest edge divided by frame contrast). A
 *   steep edge is sharp. Spread edges with contrast left are a softness
 *   reading, not a focus grade. No contrast is unknown: blur and a flat
 *   scene look the same.
 * - Directional motion is not a detection. A score is given only when both
 *   axes have texture and one is spread. A facade, a horizon, or sharp edges
 *   on both axes are not scored, and no warning is issued.
 * - Clipping counts samples already at the end of the 8-bit range. It does
 *   not say whether the camera or a later step put them there.
 * - Shadows report dark-pixel share and local contrast. A flat dark area is
 *   unknown: crushed shadows and a dark scene look the same.
 * - Noise is the spread in flat blocks only. A busy frame is unknown, not
 *   "noisy". JPEG artifacts can raise the figure.
 * - Glare is a heuristic for a bright, desaturated patch with contrast around
 *   it. Snow, fog, sky, and a white wall are not called glare.
 *
 * Scores are 0-100 where a number exists, higher meaning fewer problems or
 * more edge energy. Unknown metrics and absent cues have a null score and do
 * not count as passes. Thresholds are overridable; non-finite overrides are
 * ignored. See LIMITATIONS.
 */

export const DEFAULT_THRESHOLDS = Object.freeze({
  /** Longest side of the working sample used for spatial metrics. */
  maxSampleEdge: 256,
  /** Below this, every metric is unknown. */
  minEdge: 8,
  /** Histogram metrics scan every pixel up to this count, then stride. */
  maxFullScanPixels: 1_500_000,
  /** Laplacian variance at or above this is "sharp edges", not a focus grade. */
  blurSharpMin: 80,
  /** Variance that maps to a sharpness score of 100. */
  blurScoreFull: 800,
  /**
   * p99 luminance minus p01 luminance. Below this, acutance is not trusted
   * and a flat frame stays unknown.
   */
  blurContrastFloor: 12,
  /**
   * Full-resolution acutance (p99 gradient / contrast) below this, with
   * contrast still present, is a softness reading. It is not a focus grade.
   */
  blurAcutanceSoft: 0.62,
  /**
   * Axis energy below this fraction of the other axis is an observation.
   * It never becomes a motion warning.
   */
  motionWeakRatio: 0.35,
  /** Axis energy below this is too weak to describe a direction. */
  motionMinEnergy: 30,
  /**
   * Full-resolution axis acutance below this is an absent axis, not smear.
   * A facade fails this gate and is not scored.
   */
  motionAcutanceMin: 0.12,
  /**
   * Weaker-axis acutance over stronger-axis acutance below this is a
   * directional-softness reading. It never becomes a motion warning.
   */
  motionPeakRatio: 0.55,
  /** Channel at or above this counts as highlight clipping. */
  clipNearWhite: 250,
  /** All channels at or below this count as shadow clipping. */
  clipNearBlack: 5,
  /** Either clipped fraction at or above this is status `clipped`. */
  clipFractionWarn: 0.02,
  /** Clipped fraction that maps to a clipping score of 0. */
  clipScoreZero: 0.25,
  /** Luminance below this, and above the black clip, counts as dark. */
  shadowLuma: 40,
  /** Dark share at or above this is "a large dark area". */
  shadowFractionMin: 0.2,
  /** Mean neighbor difference that counts as contrast inside dark pixels. */
  shadowLocalMin: 3,
  noiseBlock: 8,
  /** Mean neighbor difference below this is a flat block. */
  noiseFlatGradMax: 16,
  /** Fewer flat blocks than this, and noise is unknown. */
  noiseMinFlatBlocks: 4,
  /** Flat-block stddev at or above this is moderate. */
  noiseModerate: 3.5,
  /** Flat-block stddev at or above this is elevated. */
  noiseElevated: 6.5,
  noiseScoreModerate: 65,
  noiseScoreElevated: 25,
  glareLumaMin: 235,
  /** (max-min)/max at or below this is desaturated. */
  glareSaturationMax: 0.12,
  /** Glare-pixel share below this is cue absent, not a proof. */
  glareFractionMin: 0.01,
  /** Share above this is the whole frame (snow, fog, sky): unknown. */
  glareFractionMax: 0.45,
  /** Non-glare luminance stddev below this is no context: unknown. */
  glareRestStdMin: 12,
});

export const LIMITATIONS = Object.freeze([
  'Pixels only. No network, no cloud, and no EXIF. Alpha is ignored, and the layout must be RGBA.',
  'Laplacian, noise, and shadow spatial metrics use a downsampled working sample, so they are not full-resolution lab figures. Blur acutance is a full-resolution percentile, not a lab MTF. Histogram metrics stride above maxFullScanPixels, and that stride can miss a small speck.',
  'Low edge energy is not inferred as blur when the frame has no contrast. A flat scene stays unknown. Softness is scored only when contrast is present and edges are spread, and it is not a focus grade.',
  'A single frame cannot separate directional smear from scene edges, so no directional motion warning is issued. A directional-softness score is only given when both axes have texture and one is spread.',
  'Clipping is an 8-bit end-of-range count, not a camera diagnosis.',
  'Shadows are not an exposure grade. A flat dark area is unknown.',
  'Noise is estimated only from flat blocks. JPEG artifacts and fine texture are not separated, and a busy scene is not called noisy.',
  'Glare is a heuristic for a bright desaturated region. It is not a detection of the sun, snow, fog, or a white surface.',
]);

const SCORE_NOTE =
  'Averages sharpness readings and defect findings, capped by any soft-detail score. Unknown metrics and absent cues are left out, not treated as passes. This is not a photogrammetry grade; changes in other findings can still change the score.';

const METRIC_IDS = Object.freeze([
  'blur',
  'directionalMotion',
  'clipping',
  'shadows',
  'noise',
  'glare',
]);

/**
 * Copy defaults and apply finite numeric overrides. Unknown keys are ignored.
 * @param {object} [overrides]
 */
export function normalizeThresholds(overrides) {
  const out = { ...DEFAULT_THRESHOLDS };
  if (!overrides || typeof overrides !== 'object') return out;
  for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
    const value = overrides[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function readImage(image) {
  if (!image || typeof image !== 'object') return null;
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < 1 || height < 1) return null;
  if (!data || typeof data.length !== 'number') return null;
  if (data.length < width * height * 4) return null;
  return { width, height, data };
}

function lumaOf(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function clampScore(value) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function emptyMetric(id, code, reason, extra = {}) {
  return {
    id,
    status: 'unknown',
    score: null,
    countsTowardScore: false,
    code,
    reason,
    metrics: {},
    ...extra,
  };
}

function tooSmallMetric(id) {
  return emptyMetric(
    id,
    'too-small',
    'The image is below the minimum edge. Nothing is inferred.',
    id === 'directionalMotion' ? { warning: null } : {},
  );
}

function notImageMetric(id) {
  return emptyMetric(
    id,
    'not-image',
    'Pixels must be an RGBA image with integer width and height.',
    id === 'directionalMotion' ? { warning: null } : {},
  );
}

/** Box-downsample luminance so clipping is not measured on this grid. */
function luminanceGrid(img, maxEdge) {
  const { width, height, data } = img;
  const long = Math.max(width, height);
  const factor = long > maxEdge ? Math.ceil(long / maxEdge) : 1;
  const w = Math.floor(width / factor);
  const h = Math.floor(height / factor);
  if (w < 1 || h < 1) return null;
  const grid = new Float64Array(w * h);
  let withinVariance = 0;
  if (factor === 1) {
    for (let i = 0; i < w * h; i += 1) {
      const o = i * 4;
      grid[i] = lumaOf(data[o], data[o + 1], data[o + 2]);
    }
  } else {
    const area = factor * factor;
    let withinSum = 0;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let sum = 0;
        let sum2 = 0;
        const y0 = y * factor;
        const x0 = x * factor;
        for (let dy = 0; dy < factor; dy += 1) {
          let o = ((y0 + dy) * width + x0) * 4;
          for (let dx = 0; dx < factor; dx += 1) {
            const L = lumaOf(data[o], data[o + 1], data[o + 2]);
            sum += L;
            sum2 += L * L;
            o += 4;
          }
        }
        const mean = sum / area;
        withinSum += sum2 / area - mean * mean;
        grid[y * w + x] = mean;
      }
    }
    withinVariance = withinSum / (w * h);
  }
  return { width: w, height: h, data: grid, factor, withinVariance };
}

function histPercentile(hist, total, p) {
  if (!(total > 0)) return 0;
  const target = Math.floor(p * (total - 1));
  let seen = 0;
  for (let i = 0; i < hist.length; i += 1) {
    seen += hist[i];
    if (seen > target) return i;
  }
  return hist.length - 1;
}

function lumaAt(data, width, x, y) {
  const o = (y * width + x) * 4;
  return lumaOf(data[o], data[o + 1], data[o + 2]);
}

/**
 * Full-resolution edge steepness on interior pixels. A clamped border is not
 * contrast. Acutance is the 99th-percentile central difference divided by
 * robust contrast. A step edge is near 1. A ramp is lower. Contrast below a
 * floor makes the ratio meaningless, so callers must check it.
 */
function measureAcutance(img) {
  const { width, height, data } = img;
  const lumaHist = new Uint32Array(256);
  const hx = new Uint32Array(511);
  const hy = new Uint32Array(511);
  const hBoth = new Uint32Array(511);
  let nLuma = 0;
  let n = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) continue;
      const L = lumaAt(data, width, x, y);
      const bin = L <= 0 ? 0 : L >= 255 ? 255 : Math.round(L);
      lumaHist[bin] += 1;
      nLuma += 1;
      const dx = Math.abs(
        lumaAt(data, width, x + 1, y) - lumaAt(data, width, x - 1, y),
      );
      const dy = Math.abs(
        lumaAt(data, width, x, y + 1) - lumaAt(data, width, x, y - 1),
      );
      const ix = dx >= 510 ? 510 : Math.round(dx);
      const iy = dy >= 510 ? 510 : Math.round(dy);
      hx[ix] += 1;
      hy[iy] += 1;
      hBoth[Math.max(ix, iy)] += 1;
      n += 1;
    }
  }
  const contrast =
    histPercentile(lumaHist, nLuma, 0.99) -
    histPercentile(lumaHist, nLuma, 0.01);
  const axis = (hist) =>
    contrast > 0 && n > 0 ? histPercentile(hist, n, 0.99) / contrast : null;
  return {
    contrast,
    samples: n,
    x: axis(hx),
    y: axis(hy),
    combined: axis(hBoth),
  };
}

function spatialEnergies(grid) {
  if (!grid || grid.width < 3 || grid.height < 3) return null;
  const { width: w, height: h, data } = grid;
  let n = 0;
  let sum = 0;
  let sum2 = 0;
  let xx = 0;
  let yy = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const c = data[i];
      const lxx = data[i - 1] - 2 * c + data[i + 1];
      const lyy = data[i - w] - 2 * c + data[i + w];
      const lap = lxx + lyy;
      sum += lap;
      sum2 += lap * lap;
      xx += lxx * lxx;
      yy += lyy * lyy;
      n += 1;
    }
  }
  if (!n) return null;
  const mean = sum / n;
  return {
    laplacianVariance: sum2 / n - mean * mean,
    horizontalEnergy: xx / n,
    verticalEnergy: yy / n,
  };
}

function observationOf(horizontalEnergy, verticalEnergy, t) {
  const strong = Math.max(horizontalEnergy, verticalEnergy);
  if (!(strong >= t.motionMinEnergy)) return 'unmeasurable';
  if (
    horizontalEnergy < verticalEnergy * t.motionWeakRatio &&
    verticalEnergy >= t.motionMinEnergy
  ) {
    return 'horizontal-detail-weaker';
  }
  if (
    verticalEnergy < horizontalEnergy * t.motionWeakRatio &&
    horizontalEnergy >= t.motionMinEnergy
  ) {
    return 'vertical-detail-weaker';
  }
  return 'balanced';
}

function scanPixels(img, t) {
  const { width, height, data } = img;
  const nPix = width * height;
  const stride =
    nPix <= t.maxFullScanPixels
      ? 1
      : Math.ceil(Math.sqrt(nPix / t.maxFullScanPixels));
  let sampleCount = 0;
  let highlightCount = 0;
  let shadowClipCount = 0;
  let darkCount = 0;
  let glareCount = 0;
  let restN = 0;
  let restSum = 0;
  let restSum2 = 0;
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const o = (y * width + x) * 4;
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      const luma = lumaOf(r, g, b);
      const max = r > g ? (r > b ? r : b) : g > b ? g : b;
      const min = r < g ? (r < b ? r : b) : g < b ? g : b;
      sampleCount += 1;
      if (
        r >= t.clipNearWhite ||
        g >= t.clipNearWhite ||
        b >= t.clipNearWhite
      ) {
        highlightCount += 1;
      }
      const shadowClipped =
        r <= t.clipNearBlack && g <= t.clipNearBlack && b <= t.clipNearBlack;
      if (shadowClipped) shadowClipCount += 1;
      else if (luma < t.shadowLuma) darkCount += 1;
      const sat = max === 0 ? 0 : (max - min) / max;
      const glare = luma >= t.glareLumaMin && sat <= t.glareSaturationMax;
      if (glare) glareCount += 1;
      else {
        restN += 1;
        restSum += luma;
        restSum2 += luma * luma;
      }
    }
  }
  const restMean = restN ? restSum / restN : 0;
  return {
    sampleCount,
    stride,
    highlightCount,
    shadowClipCount,
    darkCount,
    glareCount,
    highlightFraction: sampleCount ? highlightCount / sampleCount : 0,
    shadowClipFraction: sampleCount ? shadowClipCount / sampleCount : 0,
    darkFraction: sampleCount ? darkCount / sampleCount : 0,
    glareFraction: sampleCount ? glareCount / sampleCount : 0,
    restStd: restN
      ? Math.sqrt(Math.max(0, restSum2 / restN - restMean * restMean))
      : 0,
    restCount: restN,
  };
}

function darkContrast(grid, t) {
  if (!grid) return { darkLocalContrast: null };
  const { width: w, height: h, data } = grid;
  let n = 0;
  let sum = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const L = data[y * w + x];
      if (!(L > t.clipNearBlack && L < t.shadowLuma)) continue;
      if (x + 1 < w) {
        sum += Math.abs(data[y * w + x + 1] - L);
        n += 1;
      }
      if (y + 1 < h) {
        sum += Math.abs(data[(y + 1) * w + x] - L);
        n += 1;
      }
    }
  }
  return { darkLocalContrast: n ? sum / n : 0 };
}

function blockNoise(grid, t) {
  if (!grid) return { flatBlocks: 0, noiseStd: null };
  const { width: w, height: h, data } = grid;
  const block = t.noiseBlock;
  if (!(block >= 2) || w < block || h < block) {
    return { flatBlocks: 0, noiseStd: null };
  }
  const stds = [];
  for (let y0 = 0; y0 + block <= h; y0 += block) {
    for (let x0 = 0; x0 + block <= w; x0 += block) {
      let n = 0;
      let sum = 0;
      let sum2 = 0;
      let g = 0;
      let gn = 0;
      for (let y = y0; y < y0 + block; y += 1) {
        for (let x = x0; x < x0 + block; x += 1) {
          const L = data[y * w + x];
          sum += L;
          sum2 += L * L;
          n += 1;
          if (x + 1 < x0 + block) {
            g += Math.abs(data[y * w + x + 1] - L);
            gn += 1;
          }
          if (y + 1 < y0 + block) {
            g += Math.abs(data[(y + 1) * w + x] - L);
            gn += 1;
          }
        }
      }
      if (!gn || g / gn >= t.noiseFlatGradMax) continue;
      const mean = sum / n;
      stds.push(Math.sqrt(Math.max(0, sum2 / n - mean * mean)));
    }
  }
  if (stds.length < t.noiseMinFlatBlocks) {
    return { flatBlocks: stds.length, noiseStd: null };
  }
  stds.sort((a, b) => a - b);
  return { flatBlocks: stds.length, noiseStd: stds[stds.length >> 1] };
}

function prepare(img, thresholds) {
  const tooSmall =
    img.width < thresholds.minEdge || img.height < thresholds.minEdge;
  return {
    img,
    thresholds,
    tooSmall,
    grid: tooSmall ? null : luminanceGrid(img, thresholds.maxSampleEdge),
    scan: tooSmall ? null : scanPixels(img, thresholds),
    acutance: tooSmall ? null : measureAcutance(img),
  };
}

function sampleFields(grid) {
  if (!grid)
    return { sampledWidth: null, sampledHeight: null, sampleFactor: null };
  return {
    sampledWidth: grid.width,
    sampledHeight: grid.height,
    sampleFactor: grid.factor,
  };
}

function blurFrom(bundle) {
  if (bundle.tooSmall) return tooSmallMetric('blur');
  const energies = spatialEnergies(bundle.grid);
  const variance = energies ? energies.laplacianVariance : null;
  const within = bundle.grid ? bundle.grid.withinVariance : 0;
  const detail = Math.max(variance ?? 0, within ?? 0);
  const ac = bundle.acutance;
  const t = bundle.thresholds;
  const base = {
    ...sampleFields(bundle.grid),
    laplacianVariance: variance,
    withinVariance: within,
    acutance: ac ? ac.combined : null,
    contrast: ac ? ac.contrast : null,
  };
  const spread =
    ac &&
    ac.contrast >= t.blurContrastFloor &&
    ac.combined != null &&
    ac.combined < t.blurAcutanceSoft;
  if (spread) {
    return {
      id: 'blur',
      status: 'soft',
      score: Math.min(99, clampScore(100 * ac.combined)),
      countsTowardScore: true,
      code: 'soft-detail',
      reason:
        'Edges are spread relative to the contrast in the frame. That is a softness reading, not a focus grade.',
      metrics: base,
    };
  }
  if (detail >= t.blurSharpMin) {
    const fromWorkingSample = variance != null && variance >= t.blurSharpMin;
    return {
      id: 'blur',
      status: 'sharp',
      score: fromWorkingSample
        ? clampScore((100 * variance) / t.blurScoreFull)
        : 100,
      countsTowardScore: true,
      code: 'sharp-edges',
      reason: fromWorkingSample
        ? 'Edge energy is high enough to call the working sample sharp. This is not a focus measurement.'
        : 'Fine detail is sharp at full resolution. The working sample averages it away. This is not a focus measurement.',
      metrics: base,
    };
  }
  return {
    id: 'blur',
    status: 'unknown',
    score: null,
    countsTowardScore: false,
    code: 'low-edge-energy',
    reason:
      'Edge energy is low. That fits blur and it also fits a low-texture or flat scene, so blur is not inferred.',
    metrics: base,
  };
}

function motionFrom(bundle) {
  if (bundle.tooSmall) return tooSmallMetric('directionalMotion');
  const energies = spatialEnergies(bundle.grid);
  const horizontalEnergy = energies ? energies.horizontalEnergy : 0;
  const verticalEnergy = energies ? energies.verticalEnergy : 0;
  const observation = energies
    ? observationOf(horizontalEnergy, verticalEnergy, bundle.thresholds)
    : 'unmeasurable';
  const ac = bundle.acutance;
  const t = bundle.thresholds;
  const metrics = {
    ...sampleFields(bundle.grid),
    observation,
    horizontalEnergy,
    verticalEnergy,
    acutanceX: ac ? ac.x : null,
    acutanceY: ac ? ac.y : null,
  };
  const ax = ac && ac.x != null ? ac.x : 0;
  const ay = ac && ac.y != null ? ac.y : 0;
  const bothAxes =
    ac &&
    ac.contrast >= t.blurContrastFloor &&
    ax >= t.motionAcutanceMin &&
    ay >= t.motionAcutanceMin;
  if (bothAxes) {
    const ratio = Math.min(ax, ay) / Math.max(ax, ay);
    if (ratio < t.motionPeakRatio) {
      return {
        id: 'directionalMotion',
        status: 'possible',
        warning: null,
        score: clampScore(100 * ratio),
        countsTowardScore: true,
        code: 'directional-softness',
        reason:
          'One axis is softer than the other. That fits directional smear and it can also fit the scene, so no directional motion warning is issued.',
        metrics,
      };
    }
  }
  return {
    id: 'directionalMotion',
    status: 'unknown',
    warning: null,
    score: null,
    countsTowardScore: false,
    code: 'not-inferable',
    reason:
      'No directional motion warning is issued. A single frame cannot separate directional smear from scene edges.',
    metrics,
  };
}

function clippingFrom(bundle) {
  if (bundle.tooSmall) return tooSmallMetric('clipping');
  const scan = bundle.scan;
  const t = bundle.thresholds;
  const fraction = Math.max(scan.highlightFraction, scan.shadowClipFraction);
  const clipped =
    scan.highlightFraction >= t.clipFractionWarn ||
    scan.shadowClipFraction >= t.clipFractionWarn;
  const score =
    t.clipScoreZero > 0
      ? clampScore(100 * (1 - fraction / t.clipScoreZero))
      : clipped
        ? 0
        : 100;
  return {
    id: 'clipping',
    status: clipped ? 'clipped' : 'ok',
    score,
    countsTowardScore: clipped,
    code: clipped ? 'end-of-range' : 'within-threshold',
    reason: clipped
      ? 'Samples sit at the end of the 8-bit range. This does not say whether the camera or a later step clipped them.'
      : 'Clipped-pixel share is under the threshold.',
    metrics: {
      highlightCount: scan.highlightCount,
      shadowClipCount: scan.shadowClipCount,
      highlightFraction: scan.highlightFraction,
      shadowClipFraction: scan.shadowClipFraction,
      sampleCount: scan.sampleCount,
      stride: scan.stride,
    },
  };
}

function shadowsFrom(bundle) {
  if (bundle.tooSmall) return tooSmallMetric('shadows');
  const scan = bundle.scan;
  const contrast = darkContrast(bundle.grid, bundle.thresholds);
  const t = bundle.thresholds;
  const metrics = {
    darkFraction: scan.darkFraction,
    darkCount: scan.darkCount,
    darkLocalContrast: contrast.darkLocalContrast,
    sampleCount: scan.sampleCount,
  };
  if (scan.darkFraction < t.shadowFractionMin) {
    return {
      id: 'shadows',
      status: 'ok',
      score: null,
      countsTowardScore: false,
      code: 'few-dark-pixels',
      reason:
        'Dark pixels are a small share of the frame. This is not an exposure grade.',
      metrics,
    };
  }
  if (
    contrast.darkLocalContrast != null &&
    contrast.darkLocalContrast >= t.shadowLocalMin
  ) {
    return {
      id: 'shadows',
      status: 'ok',
      score: null,
      countsTowardScore: false,
      code: 'dark-areas-have-contrast',
      reason: 'Dark areas keep local contrast. This is not an exposure grade.',
      metrics,
    };
  }
  return {
    id: 'shadows',
    status: 'unknown',
    score: null,
    countsTowardScore: false,
    code: 'dark-contrast-unknown',
    reason:
      'A large dark area has almost no local contrast. Crushed shadows and a flat dark scene look the same here, so neither is inferred.',
    metrics,
  };
}

function noiseFrom(bundle) {
  if (bundle.tooSmall) return tooSmallMetric('noise');
  const found = blockNoise(bundle.grid, bundle.thresholds);
  const metrics = {
    ...sampleFields(bundle.grid),
    flatBlocks: found.flatBlocks,
    noiseStd: found.noiseStd,
  };
  if (found.noiseStd == null) {
    return {
      id: 'noise',
      status: 'unknown',
      score: null,
      countsTowardScore: false,
      code: 'no-flat-blocks',
      reason:
        'Not enough flat blocks to estimate noise. A busy scene is not called noisy.',
      metrics,
    };
  }
  const t = bundle.thresholds;
  let status = 'low';
  let score = 100;
  let countsTowardScore = false;
  let code = 'flat-blocks-quiet';
  let reason =
    'Quiet flat blocks vary little. Textured areas were not graded, and JPEG artifacts can still hide elsewhere.';
  if (found.noiseStd >= t.noiseElevated) {
    status = 'elevated';
    score = t.noiseScoreElevated;
    countsTowardScore = true;
    code = 'flat-blocks-noisy';
    reason =
      'Quiet flat blocks still vary a lot. Sensor noise, JPEG artifacts, and fine texture are not separated.';
  } else if (found.noiseStd >= t.noiseModerate) {
    status = 'moderate';
    score = t.noiseScoreModerate;
    countsTowardScore = true;
    code = 'flat-blocks-moderate';
    reason =
      'Quiet flat blocks show some variation. Sensor noise, JPEG artifacts, and fine texture are not separated.';
  }
  return {
    id: 'noise',
    status,
    score: clampScore(score),
    countsTowardScore,
    code,
    reason,
    metrics,
  };
}

function glareFrom(bundle) {
  if (bundle.tooSmall) return tooSmallMetric('glare');
  const scan = bundle.scan;
  const t = bundle.thresholds;
  const metrics = {
    glareCount: scan.glareCount,
    glareFraction: scan.glareFraction,
    restStd: scan.restStd,
    restCount: scan.restCount,
    sampleCount: scan.sampleCount,
  };
  const inBand =
    scan.glareFraction >= t.glareFractionMin &&
    scan.glareFraction <= t.glareFractionMax;
  const hasContext = scan.restCount > 0 && scan.restStd >= t.glareRestStdMin;
  if (inBand && hasContext) {
    return {
      id: 'glare',
      status: 'possible',
      score: clampScore(100 * (1 - scan.glareFraction)),
      countsTowardScore: true,
      code: 'bright-desaturated-region',
      reason:
        'A bright desaturated region stands out from the rest of the frame. This is a glare heuristic, not a detection.',
      metrics,
    };
  }
  if (scan.glareFraction < t.glareFractionMin) {
    return {
      id: 'glare',
      status: 'none',
      score: null,
      countsTowardScore: false,
      code: 'cue-absent',
      reason: 'No sizable bright desaturated region. Glare is not ruled out.',
      metrics,
    };
  }
  return {
    id: 'glare',
    status: 'unknown',
    score: null,
    countsTowardScore: false,
    code: 'not-inferable',
    reason:
      'Most of the frame is bright and desaturated, or the rest has no contrast. Glare is not inferred.',
    metrics,
  };
}

function withImage(image, thresholds, id, from) {
  const img = readImage(image);
  const resolved = normalizeThresholds(thresholds);
  if (!img) return notImageMetric(id);
  return from(prepare(img, resolved));
}

/** @param {object} image `{ width, height, data }` RGBA. @param {object} [thresholds] */
export function analyzeBlur(image, thresholds) {
  return withImage(image, thresholds, 'blur', blurFrom);
}

/** Directional-softness heuristic. `warning` is always null. */
export function analyzeDirectionalMotion(image, thresholds) {
  return withImage(image, thresholds, 'directionalMotion', motionFrom);
}

/** @param {object} image @param {object} [thresholds] */
export function analyzeClipping(image, thresholds) {
  return withImage(image, thresholds, 'clipping', clippingFrom);
}

/** @param {object} image @param {object} [thresholds] */
export function analyzeShadows(image, thresholds) {
  return withImage(image, thresholds, 'shadows', shadowsFrom);
}

/** @param {object} image @param {object} [thresholds] */
export function analyzeNoise(image, thresholds) {
  return withImage(image, thresholds, 'noise', noiseFrom);
}

/** Heuristic. `possible` is not a detection. */
export function analyzeGlare(image, thresholds) {
  return withImage(image, thresholds, 'glare', glareFrom);
}

function compositeScore(metrics) {
  const parts = [];
  for (const id of METRIC_IDS) {
    const metric = metrics[id];
    if (metric.countsTowardScore && typeof metric.score === 'number') {
      parts.push(metric.score);
    }
  }
  if (!parts.length) return null;
  const mean = clampScore(
    parts.reduce((sum, score) => sum + score, 0) / parts.length,
  );
  const blur = metrics.blur;
  return blur.status === 'soft' && typeof blur.score === 'number'
    ? Math.min(mean, blur.score)
    : mean;
}

/**
 * Run every metric. `score` is null when nothing earned a score: unknowns and
 * absent cues are excluded, not treated as passes.
 * @param {object} image `{ width, height, data }` RGBA
 * @param {{ thresholds?: object }} [options]
 */
export function analyzePhotoQuality(image, options = {}) {
  const thresholds = normalizeThresholds(options?.thresholds);
  const img = readImage(image);
  if (!img) {
    return {
      ok: false,
      code: 'not-image',
      reason:
        'Pixels must be an RGBA image: integer width and height, and data.length at least width*height*4.',
      width: null,
      height: null,
      thresholds,
      metrics: null,
      unknown: [],
      findings: [],
      score: null,
      scoreNote: SCORE_NOTE,
    };
  }
  const bundle = prepare(img, thresholds);
  const metrics = {
    blur: blurFrom(bundle),
    directionalMotion: motionFrom(bundle),
    clipping: clippingFrom(bundle),
    shadows: shadowsFrom(bundle),
    noise: noiseFrom(bundle),
    glare: glareFrom(bundle),
  };
  const unknown = METRIC_IDS.filter((id) => metrics[id].status === 'unknown');
  const findings = METRIC_IDS.filter((id) => {
    const status = metrics[id].status;
    return (
      status === 'clipped' ||
      status === 'moderate' ||
      status === 'elevated' ||
      status === 'possible' ||
      status === 'soft'
    );
  });
  return {
    ok: true,
    code: bundle.tooSmall ? 'too-small' : 'measured',
    reason: bundle.tooSmall
      ? 'The image is below the minimum edge. Nothing is inferred.'
      : 'Metrics that cannot be inferred are unknown. They are not passes.',
    width: img.width,
    height: img.height,
    thresholds,
    metrics,
    unknown,
    findings,
    score: bundle.tooSmall ? null : compositeScore(metrics),
    scoreNote: SCORE_NOTE,
  };
}

#!/usr/bin/env node
/**
 * Regression tests that run the REAL minichart.js in a real browser.
 *
 * The unit tests in test/run.js deliberately re-implement the pure algorithms
 * so they can run without a DOM. That has a hard limit: it cannot catch a bug
 * in how those algorithms are *composed*. It missed exactly that — decimation
 * and gap-splitting were each correct in isolation, but running them in the
 * wrong order shredded every dense series into single-point runs and drew a
 * completely blank chart, while the mirrored tests reported 10/10 passing.
 *
 * So these tests load minichart.js itself, render into a real canvas, and
 * assert on pixels and on live DOM geometry.
 *
 * Run with: `npm run test:visual` (or `npm test`, which runs both suites).
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, '..', 'minichart.js'), 'utf8');

let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { passed++; results.push('  ✓ ' + name); }
  else { failed++; results.push('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('console', m => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

await page.setContent(`<!doctype html><html><body style="margin:0;background:#0d1117">
  <div id="host" style="width:800px;height:220px"></div>
  <div id="host2" style="width:800px;height:220px"></div>
</body></html>`);
await page.addScriptTag({ content: SRC });

// Helpers installed in page scope: build a chart and measure rendered pixels.
await page.evaluate(() => {
  window.mkCanvas = (hostId) => {
    const host = document.getElementById(hostId);
    host.innerHTML = '';
    const cv = document.createElement('canvas');
    cv.style.cssText = 'width:800px;height:200px;display:block';
    host.appendChild(cv);
    return cv;
  };
  // Fraction of plot-area pixel columns that contain the series colour.
  window.lineCoverage = (chart, rgb) => {
    const cv = chart.canvas;
    const ctx = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const { data, width: W, height: H } = ctx.getImageData(0, 0, cv.width, cv.height);
    const padL = Math.round(chart.opts.padding.left * dpr);
    const padR = Math.round(chart.opts.padding.right * dpr);
    const cols = [];
    for (let x = padL; x < W - padR; x++) {
      let hit = false;
      for (let y = 0; y < H; y++) {
        const o = (y * W + x) * 4;
        if (Math.abs(data[o] - rgb[0]) < 60 && Math.abs(data[o + 1] - rgb[1]) < 60 &&
            Math.abs(data[o + 2] - rgb[2]) < 60 && data[o + 3] > 200) { hit = true; break; }
      }
      cols.push(hit);
    }
    return cols;
  };
  window.series = (n, { noisy = true, gapFrom = -1, gapTo = -1 } = {}) => {
    const now = 1700000000, labels = [], data = [];
    for (let i = 0; i < n; i++) {
      labels.push(now - n + i);
      if (i >= gapFrom && i < gapTo) { data.push(null); continue; }
      data.push(50 + Math.sin(i / 500) * 40 + (noisy ? Math.sin(i / 7) * 3 : 0));
    }
    return { labels, data };
  };
});

// ── 1. Dense series actually render ──────────────────────────────────────────
// The blocker: decimation ran before gap-splitting, so every kept sample looked
// like the start of a new gap and no segment was ever emitted.
for (const [name, noisy] of [['noisy', true], ['smooth', false]]) {
  const cov = await page.evaluate(({ noisy }) => {
    const d = window.series(50000, { noisy });
    const ch = new MiniChart(window.mkCanvas('host'), {
      series: [{ label: 's', data: d.data, color: '#3fb950' }],
      labels: d.labels, rangeSec: 50000, yUnit: '%', legend: false,
    });
    const cols = window.lineCoverage(ch, [63, 185, 80]);
    ch.destroy();
    return cols.filter(Boolean).length / cols.length;
  }, { noisy });
  check(`50k ${name}: line covers the plot (${(cov * 100).toFixed(1)}%)`,
        cov > 0.95, `expected > 95%, got ${(cov * 100).toFixed(1)}%`);
}

// ── 2. Gaps stay gaps after decimation ───────────────────────────────────────
{
  const r = await page.evaluate(() => {
    const d = window.series(20000, { noisy: true, gapFrom: 8000, gapTo: 12000 });
    const ch = new MiniChart(window.mkCanvas('host'), {
      series: [{ label: 's', data: d.data, color: '#3fb950' }],
      labels: d.labels, rangeSec: 20000, yUnit: '%', legend: false,
    });
    const cols = window.lineCoverage(ch, [63, 185, 80]);
    // Any painted (non-transparent) pixel inside the hole. The gradient fill is
    // far dimmer than the stroke, so it slips past lineCoverage entirely — this
    // is what catches a phantom area wedge spanning the gap.
    const cvEl = ch.canvas, cx = cvEl.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const img = cx.getImageData(0, 0, cvEl.width, cvEl.height);
    const W = img.width, H = img.height, px = img.data;
    const padL = Math.round(ch.opts.padding.left * dpr);
    const padR = Math.round(ch.opts.padding.right * dpr);
    const top = Math.round(ch.opts.padding.top * dpr);
    const bot = H - Math.round(ch.opts.padding.bottom * dpr);
    const plotCols = (W - padR) - padL;
    let gapPainted = 0, gapCols = 0;
    for (let x = padL + Math.round(plotCols * 0.42); x < padL + Math.round(plotCols * 0.58); x++) {
      gapCols++;
      for (let y = top; y < bot; y++) {
        // Grid lines are drawn at alpha ~0.06; require something clearly denser.
        if (px[(y * W + x) * 4 + 3] > 40) { gapPainted++; break; }
      }
    }
    ch.destroy();
    const n = cols.length;
    // The hole spans samples 8000..12000 of 20000 → middle fifth of the width.
    const inGap = cols.slice(Math.round(n * 0.42), Math.round(n * 0.58));
    const outside = cols.slice(0, Math.round(n * 0.35));
    return {
      gapFill: inGap.filter(Boolean).length / inGap.length,
      outsideFill: outside.filter(Boolean).length / outside.length,
      gapPaint: gapPainted / gapCols,
    };
  });
  check(`null run renders as a gap (${(r.gapFill * 100).toFixed(0)}% filled inside)`,
        r.gapFill < 0.05, `expected < 5% inside the hole, got ${(r.gapFill * 100).toFixed(0)}%`);
  check(`data outside the gap still renders (${(r.outsideFill * 100).toFixed(0)}%)`,
        r.outsideFill > 0.95, `expected > 95%, got ${(r.outsideFill * 100).toFixed(0)}%`);
  check(`area fill leaves the gap empty (${(r.gapPaint * 100).toFixed(0)}% painted)`,
        r.gapPaint < 0.05,
        `the fill used to close from the last subpath back to the first, painting a ` +
        `phantom wedge across missing data; got ${(r.gapPaint * 100).toFixed(0)}%`);
}

// ── 2b. Several gaps, including at the edges ─────────────────────────────────
// Gap detection now rides along with the projection in _recalc rather than
// being a separate scan over the source indices, so the invariant is no longer
// unit-testable in isolation. This covers it end to end: three interior holes
// plus leading and trailing nulls must produce empty columns exactly where the
// data is missing, and painted columns everywhere else.
{
  const r = await page.evaluate(() => {
    const N = 30000;
    // Fractions of the series that are missing. Leading and trailing nulls
    // exercise the run-start and run-end bookkeeping.
    const holes = [[0, 0.05], [0.2, 0.28], [0.45, 0.5], [0.7, 0.78], [0.95, 1]];
    const inHole = f => holes.some(([a, b]) => f >= a && f < b);
    const data = [], labels = [];
    for (let i = 0; i < N; i++) {
      labels.push(1700000000 + i);
      data.push(inHole(i / N) ? null : 50 + 40 * Math.sin(i / 300));
    }
    const ch = new MiniChart(window.mkCanvas('host'), {
      series: [{ label: 's', data, color: '#3fb950' }],
      labels, rangeSec: N, legend: false,
    });
    const cols = window.lineCoverage(ch, [63, 185, 80]);
    const n = cols.length;
    // Sample the middle of each hole and the middle of each stretch between
    // them, staying clear of the boundaries where a column is legitimately
    // half-painted by the segment entering or leaving.
    const frac = (a, b) => {
      const lo = Math.round(n * (a + (b - a) * 0.3));
      const hi = Math.round(n * (a + (b - a) * 0.7));
      const seg = cols.slice(lo, Math.max(lo + 1, hi));
      return seg.filter(Boolean).length / seg.length;
    };
    const out = {
      holes: holes.map(([a, b]) => +frac(a, b).toFixed(2)),
      data: [[0.05, 0.2], [0.28, 0.45], [0.5, 0.7], [0.78, 0.95]].map(([a, b]) => +frac(a, b).toFixed(2)),
    };
    ch.destroy();
    return out;
  });
  check(`all five holes render empty (${r.holes.join(', ')})`,
        r.holes.every(f => f < 0.05), JSON.stringify(r.holes));
  check(`all four data stretches render filled (${r.data.join(', ')})`,
        r.data.every(f => f > 0.95), JSON.stringify(r.data));
}

// ── 3. Overlay is aligned with the canvas, not the parent ────────────────────
// The legend is inserted into the same parent above the canvas, so an overlay
// sized to the parent sat ~21px too high and stretched over a taller box.
{
  const r = await page.evaluate(() => {
    const d = window.series(200, { noisy: false });
    const ch = new MiniChart(window.mkCanvas('host'), {
      series: [{ label: 'with-legend', data: d.data, color: '#3fb950' }],
      labels: d.labels, rangeSec: 200, legend: true,
    });
    const cv = ch.canvas.getBoundingClientRect();
    const ov = ch._overlay.getBoundingClientRect();
    const legendH = ch._legendEl.getBoundingClientRect().height;
    const out = { dx: Math.abs(cv.x - ov.x), dy: Math.abs(cv.y - ov.y),
                  dw: Math.abs(cv.width - ov.width), dh: Math.abs(cv.height - ov.height),
                  legendH };
    ch.destroy();
    return out;
  });
  check(`overlay aligns with canvas (legend ${r.legendH.toFixed(0)}px above)`,
        r.dx < 1 && r.dy < 1 && r.dw < 1 && r.dh < 1,
        `offset dx=${r.dx.toFixed(1)} dy=${r.dy.toFixed(1)} dw=${r.dw.toFixed(1)} dh=${r.dh.toFixed(1)}`);
}

// ── 4. Hover works on both index-based and time-based charts ─────────────────
// The branch was chosen by `plotR > plotL` (always true) instead of "is there a
// time domain", so charts without `labels` fell into the timestamp path where
// the nearest-label search can only return -1.
for (const withLabels of [false, true]) {
  const r = await page.evaluate(async ({ withLabels }) => {
    const d = window.series(120, { noisy: false });
    const opts = { series: [{ label: 's', data: d.data, color: '#3fb950' }], legend: false };
    if (withLabels) { opts.labels = d.labels; opts.rangeSec = 120; }
    const ch = new MiniChart(window.mkCanvas('host'), opts);
    const rect = ch.canvas.getBoundingClientRect();
    ch.canvas.dispatchEvent(new MouseEvent('pointermove', {
      clientX: rect.left + 400, clientY: rect.top + 100, bubbles: true }));
    const out = { idx: ch._hoverIdx, tip: ch._tooltip.style.opacity };
    ch.destroy();
    return out;
  }, { withLabels });
  check(`hover resolves a point (${withLabels ? 'time axis' : 'index axis'}, idx=${r.idx})`,
        r.idx >= 0 && r.tip === '1', `hoverIdx=${r.idx}, tooltip opacity=${r.tip}`);
}

// ── 5. Adaptive Y gutter keeps adapting after update() ───────────────────────
// The constructor used to route its own options back through update(), which
// looked like the caller pinning padding.left and froze the gutter forever.
{
  const r = await page.evaluate(() => {
    const small = Array.from({ length: 50 }, (_, i) => 5 + (i % 3));
    const big = Array.from({ length: 50 }, (_, i) => 120000 + i * 1000);
    const ch = new MiniChart(window.mkCanvas('host'), {
      series: [{ label: 's', data: small, color: '#3fb950' }], legend: false,
    });
    const before = ch.opts.padding.left;
    ch.update({ series: [{ label: 's', data: big, color: '#3fb950' }] });
    const after = ch.opts.padding.left;
    const pinned = new MiniChart(window.mkCanvas('host2'), {
      series: [{ label: 's', data: small, color: '#3fb950' }],
      padding: { top: 12, right: 10, bottom: 22, left: 55 }, legend: false,
    });
    const pinnedLeft = pinned.opts.padding.left;
    ch.destroy(); pinned.destroy();
    return { before, after, pinnedLeft };
  });
  check(`Y gutter widens for wider labels (${r.before} → ${r.after})`,
        r.after > r.before, `padding.left stayed at ${r.after}`);
  check(`explicit padding.left is still honoured (${r.pinnedLeft})`,
        r.pinnedLeft === 55, `expected 55, got ${r.pinnedLeft}`);
}

// ── 5b. Streaming Y gutter adapts too (push() bypasses _recalc) ─────────────
// push() never calls _recalc — the only place padding.left is auto-sized — so a
// chart streamed from empty froze the gutter at its floor and the Y labels
// spilled off the left edge as a cumulative counter's reading widened. The
// streaming rebuild must re-measure and grow the gutter on demand, like _recalc.
{
  const r = await page.evaluate(() => {
    const ch = new MiniChart(window.mkCanvas('host'), {
      series: [{ label: 'count', color: '#3fb950', data: [] }],
      labels: [], rangeSec: 60, maxSamples: 600, legend: false,
    });
    const before = ch.opts.padding.left;
    // Stream a monotonically growing counter (1 → 1e8) so _fmtY widens through
    // "10.0" → "100.0k" → "1000.0k" → "100000.0k".
    let t = 1700000000;
    for (let k = 1; k <= 8; k++) ch.push(Math.pow(10, k), t++);
    const after = ch.opts.padding.left;
    ch.destroy();
    return { before, after };
  });
  check(`streaming Y gutter widens for wider labels (${r.before} → ${r.after})`,
        r.after > r.before, `padding.left stayed at ${r.after}`);
}

// ── 5c. fill:'flat' paints the area without the gradient ───────────────────
// 'flat' fills with one solid alpha instead of a per-pixel gradient — cheaper
// to rasterize, which matters where _draw runs every frame. It must still paint
// the area (many more pixels than a line-only fill:false), not silently nothing.
{
  const r = await page.evaluate(() => {
    const d = window.series(400, { noisy: false });
    const mk = (fill) => {
      const ch = new MiniChart(window.mkCanvas('host'), {
        series: [{ label: 's', data: d.data, color: '#3fb950' }],
        labels: d.labels, rangeSec: 400, legend: false, fill,
      });
      const cv = ch.canvas, px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let drawn = 0; for (let i = 3; i < px.length; i += 4) if (px[i] > 20) drawn++;
      ch.destroy(); return drawn;
    };
    return { flat: mk('flat'), none: mk(false) };
  });
  check(`fill:'flat' paints the area (flat=${r.flat} px vs no-fill=${r.none} px)`,
        r.flat > r.none * 3, `flat=${r.flat} none=${r.none}`);
}

// ── 6. Host-controlled strings cannot inject markup ──────────────────────────
{
  const r = await page.evaluate(() => {
    const d = window.series(50, { noisy: false });
    const ch = new MiniChart(window.mkCanvas('host'), {
      series: [{ label: '<img src=x onerror=window.__pwned=1>', data: d.data, color: '#3fb950' }],
      labels: d.labels, rangeSec: 50, legend: true,
    });
    const rect = ch.canvas.getBoundingClientRect();
    ch.canvas.dispatchEvent(new MouseEvent('pointermove', {
      clientX: rect.left + 400, clientY: rect.top + 100, bubbles: true }));
    const out = {
      legendImg: !!ch._legendEl.querySelector('img'),
      tipImg: !!ch._tooltip.querySelector('img'),
      pwned: !!window.__pwned,
    };
    ch.destroy();
    return out;
  });
  check('label markup is escaped in legend and tooltip',
        !r.legendImg && !r.tipImg && !r.pwned, JSON.stringify(r));
}

// ── 7. Hidden series must not stretch the Y axis ─────────────────────────────
{
  const r = await page.evaluate(() => {
    const quiet = Array.from({ length: 60 }, () => 10);
    const noisyBig = Array.from({ length: 60 }, (_, i) => 900 + i);
    const ch = new MiniChart(window.mkCanvas('host'), {
      series: [{ label: 'q', data: quiet, color: '#3fb950' },
               { label: 'n', data: noisyBig, color: '#f85149' }],
      legend: true,
    });
    const withBoth = ch.yRange.max;
    ch.setVisibleSeries([0]);
    const quietOnly = ch.yRange.max;
    ch.destroy();
    return { withBoth, quietOnly };
  });
  check(`hiding a series rescales Y (${r.withBoth.toFixed(0)} → ${r.quietOnly.toFixed(0)})`,
        r.quietOnly < r.withBoth / 10, JSON.stringify(r));
}

// ── 7b. A pinned yMin must never be pushed below itself ──────────────────────
// Monitoring series that sit at zero most of the time (idle counters, error
// rates, OOM kills) were getting a negative axis: the 10% headroom was applied
// whenever the data minimum *coincided* with the pinned end, and an all-zero
// series was expanded symmetrically into [-1, 1].
{
  const cases = [
    { name: 'all zeros', data: Array(60).fill(0) },
    { name: 'mostly zero, one spike', data: Array.from({ length: 60 }, (_, i) => (i === 30 ? 5 : 0)) },
    { name: 'zero-touching ramp', data: Array.from({ length: 60 }, (_, i) => i % 12) },
  ];
  for (const c of cases) {
    const r = await page.evaluate(({ data }) => {
      const ch = new MiniChart(window.mkCanvas('host'), {
        series: [{ label: 's', data, color: '#3fb950' }], legend: false,
      });
      const out = { min: ch.yRange.min, max: ch.yRange.max };
      ch.destroy();
      return out;
    }, { data: c.data });
    check(`default yMin:0 stays at 0 — ${c.name} (range ${r.min} … ${r.max.toFixed(1)})`,
          r.min === 0 && r.max > 0, `got min=${r.min}, max=${r.max}`);
  }
}

// ── 7c. …but auto and relaxed ends still work ────────────────────────────────
{
  const r = await page.evaluate(() => {
    const neg = Array.from({ length: 40 }, (_, i) => Math.sin(i / 6) * 8);
    const allNeg = Array.from({ length: 40 }, (_, i) => -10 - (i % 5));
    const mk = (opts) => {
      const ch = new MiniChart(window.mkCanvas('host'), Object.assign({ legend: false }, opts));
      const out = { min: ch.yRange.min, max: ch.yRange.max };
      ch.destroy();
      return out;
    };
    return {
      autoMin: mk({ series: [{ label: 's', data: neg, color: '#3fb950' }], yMin: null }),
      relaxed: mk({ series: [{ label: 's', data: allNeg, color: '#3fb950' }] }),
      flatAuto: mk({ series: [{ label: 's', data: Array(30).fill(7), color: '#3fb950' }], yMin: null }),
    };
  });
  check(`yMin:null still auto-scales below zero (${r.autoMin.min.toFixed(1)})`,
        r.autoMin.min < 0, JSON.stringify(r.autoMin));
  check(`pinned yMin:0 relaxes for all-negative data (${r.relaxed.min.toFixed(1)} … ${r.relaxed.max.toFixed(1)})`,
        r.relaxed.min < 0 && r.relaxed.max > r.relaxed.min, JSON.stringify(r.relaxed));
  check(`flat series with both ends auto is centred (${r.flatAuto.min} … ${r.flatAuto.max})`,
        r.flatAuto.min < 7 && r.flatAuto.max > 7, JSON.stringify(r.flatAuto));
}

// ── 7d. Headroom must not invent a sign the data never had ───────────────────
// The 10% padding on a derived end used to push the axis across zero: a series
// of 2.5…97.5 padded to a minimum of -7, so a chart of strictly non-negative
// values drew negative gridlines. Zero is the floor for such a series, and the
// mirror case holds for all-negative data.
{
  const r = await page.evaluate(() => {
    const mk = (data, opts) => {
      const ch = new MiniChart(window.mkCanvas('host'), Object.assign(
        { legend: false, yMin: null, yMax: null, series: [{ label: 's', data, color: '#3fb950' }] }, opts));
      const out = { min: ch.yRange.min, max: ch.yRange.max };
      ch.destroy();
      return out;
    };
    const span = (n, lo, hi) => Array.from({ length: n }, (_, i) => lo + (hi - lo) * (i / (n - 1)));
    return {
      // What the benchmark actually feeds it.
      benchLike: mk(span(200, 2.5, 97.5)),
      touchesZero: mk(span(200, 0, 100)),
      // Far from zero: headroom must still apply, not collapse the axis to 0.
      farAboveZero: mk(span(200, 1000, 1010)),
      allNegative: mk(span(200, -100, -1)),
    };
  });
  check(`non-negative data gets a non-negative axis (${r.benchLike.min} … ${r.benchLike.max.toFixed(1)})`,
        r.benchLike.min >= 0 && r.benchLike.max > 97.5, JSON.stringify(r.benchLike));
  check(`a series touching zero keeps zero as the floor (${r.touchesZero.min})`,
        r.touchesZero.min === 0, JSON.stringify(r.touchesZero));
  check(`data far above zero keeps its headroom (${r.farAboveZero.min.toFixed(1)} … ${r.farAboveZero.max.toFixed(1)})`,
        r.farAboveZero.min > 900 && r.farAboveZero.min < 1000, JSON.stringify(r.farAboveZero));
  check(`all-negative data gets a non-positive axis (${r.allNegative.min.toFixed(1)} … ${r.allNegative.max})`,
        r.allNegative.max <= 0 && r.allNegative.min < -100, JSON.stringify(r.allNegative));
}

// ── 8. Partial theme update keeps the other tokens ───────────────────────────
{
  const r = await page.evaluate(() => {
    const d = window.series(50, { noisy: false });
    const ch = new MiniChart(window.mkCanvas('host'), {
      series: [{ label: 's', data: d.data, color: '#3fb950' }], legend: false,
    });
    ch.update({ theme: { grid: '#333333' } });
    const t = ch.opts.theme;
    const out = { grid: t.grid, axisLabel: t.axisLabel, crosshair: t.crosshair };
    ch.destroy();
    return out;
  });
  check('partial theme update preserves untouched tokens',
        r.grid === '#333333' && !!r.axisLabel && !!r.crosshair, JSON.stringify(r));
}

// ── 9. destroy() leaves no DOM behind and restores the parent ────────────────
{
  const r = await page.evaluate(() => {
    const host = document.getElementById('host');
    host.style.position = '';
    const d = window.series(50, { noisy: false });
    const ch = new MiniChart(window.mkCanvas('host'), {
      series: [{ label: 's', data: d.data, color: '#3fb950' }],
      labels: d.labels, rangeSec: 50, legend: true,
    });
    // The live region is created lazily — absent until the keyboard drives the chart.
    const liveBeforeNav = host.querySelectorAll('[aria-live]').length;
    ch.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const liveAfterNav = host.querySelectorAll('[aria-live]').length;
    const posWhileAlive = host.style.position;
    ch.destroy();
    ch.destroy(); // idempotent
    return {
      posWhileAlive,
      posAfter: host.style.position,
      overlays: host.querySelectorAll('canvas.mc-overlay').length,
      legends: host.querySelectorAll('.mc-legend').length,
      live: host.querySelectorAll('[aria-live]').length,
      tooltips: document.querySelectorAll('.mc-tooltip').length,
      liveBeforeNav, liveAfterNav,
    };
  });
  check('the live region is created lazily on first keyboard nav',
        r.liveBeforeNav === 0 && r.liveAfterNav === 1,
        `before=${r.liveBeforeNav} after=${r.liveAfterNav}`);
  check('destroy() removes overlay, legend, live region and tooltip',
        r.overlays === 0 && r.legends === 0 && r.live === 0 && r.tooltips === 0,
        JSON.stringify(r));
  check('destroy() restores the parent position it patched',
        r.posWhileAlive === 'relative' && r.posAfter === '', JSON.stringify(r));
}

// ── 10. Construction runs _recalc exactly once ───────────────────────────────
// applyDPR() (called synchronously by _setupCanvas during construction) used to
// end in _recalc() + _draw(), and _refresh(true) then ran both again on identical
// state. The first pass was pure waste — at a million points an entire ~11 ms
// recalc spent only to be overwritten. A guard (_initSkipRecalc) now suppresses
// the applyDLR pass during construction; this asserts exactly one _recalc fires
// for a freshly built chart, so removing the guard regresses this test.
// (Also fixes the applyDPR naming — it was applyDPR, not applyDLR.)
{
  const r = await page.evaluate(() => {
    const proto = MiniChart.prototype;
    const orig = proto._recalc;
    let calls = 0;
    proto._recalc = function () { calls++; return orig.call(this); };
    let threw = null;
    try {
      const d = window.series(2000, { noisy: false });
      const ch = new MiniChart(window.mkCanvas('host'), {
        series: [{ label: 's', data: d.data, color: '#3fb950' }],
        labels: d.labels, rangeSec: 2000, legend: false,
      });
      ch.destroy();
    } catch (e) { threw = e.message; }
    proto._recalc = orig;
    return { calls, threw };
  });
  check('construction calls _recalc exactly once', r.calls === 1,
        `_recalc called ${r.calls}× (expected 1)${r.threw ? '; threw: ' + r.threw : ''}`);
}

// ── 11. setXRange zoom renders the viewport (off-screen collapse) ────────────
// Decimation now rides the projection loop, and samples outside a narrow
// viewport must collapse to the nearest edge sample so a zoomed view still
// renders and costs ~2/px of the VIEW, not of the whole domain. A regression
// here (e.g. bucketing across a gap, or the off-screen tail exploding the count)
// drops coverage or blanks the chart.
{
  const cov = await page.evaluate(() => {
    const d = window.series(50000, { noisy: true });
    const ch = new MiniChart(window.mkCanvas('host'), {
      series: [{ label: 's', data: d.data, color: '#3fb950' }],
      labels: d.labels, rangeSec: 50000, yUnit: '%', legend: false,
    });
    const dom = ch.getXRange().domain;
    const span = dom.max - dom.min;
    ch.setXRange(dom.min + span * 0.4, dom.min + span * 0.6); // middle 20%
    const cols = window.lineCoverage(ch, [63, 185, 80]);
    ch.destroy();
    return cols.filter(Boolean).length / cols.length;
  });
  check(`zoomed view still renders (${(cov * 100).toFixed(1)}% coverage)`,
        cov > 0.6, `expected > 60%, got ${(cov * 100).toFixed(1)}%`);
}

// ── 12. A single-sample spike survives decimation ───────────────────────────
// Decimation keeps each pixel column's min and max; a lone spike must not be
// averaged into the noise. Verified by checking the tallest painted point.
{
  const r = await page.evaluate(() => {
    const n = 50000, now = 1700000000;
    const labels = [], data = [];
    for (let i = 0; i < n; i++) { labels.push(now - n + i); data.push(50); } // flat baseline
    data[Math.floor(n * 0.5)] = 100; // a single spike to the top
    const ch = new MiniChart(window.mkCanvas('host'), {
      series: [{ label: 's', data, color: '#3fb950' }],
      labels, rangeSec: n, yUnit: '%', legend: false,
    });
    const cv = ch.canvas, cx = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const img = cx.getImageData(0, 0, cv.width, cv.height);
    const W = img.width, H = img.height, px = img.data;
    const padT = Math.round(ch.opts.padding.top * dpr);
    // Tallest row (smallest y) carrying the series green anywhere in the plot.
    let topGreen = H;
    for (let y = padT; y < H; y++) for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      if (Math.abs(px[o]-63)<60 && Math.abs(px[o+1]-185)<60 && Math.abs(px[o+2]-80)<60 && px[o+3]>200) { topGreen = y; break; }
      if (topGreen < H) break;
    }
    ch.destroy();
    return { topGreen, padT, plotTopPixels: (H - padT) };
  });
  // The spike reaches near the top of the plot; an averaged-away spike would sit
  // around the baseline (mid-plot). topGreen close to padT means it reached high.
  check('single-sample spike is drawn near the top of the plot',
        r.topGreen - r.padT < r.plotTopPixels * 0.25,
        `spike top at y=${r.topGreen}, plot top=${r.padT}, plot height=${r.plotTopPixels}`);
}

// ── 13. push() streaming: multi-series render + on-demand hover ──────────────
// The streaming fast path keeps no per-sample pixel coords (the scale drifts per
// push), so hover must project on demand. Assert two pushed series both paint,
// and that a pointer move resolves to a real sample with a finite coordinate.
{
  const r = await page.evaluate(() => {
    const N = 20000, now = 1700000000;
    const labels = [], a = [], b = [];
    for (let i = 0; i < N; i++) { labels.push(now - N + i); a.push(50 + 40*Math.sin(i/50)); b.push(30 + 30*Math.cos(i/80)); }
    const ch = new MiniChart(window.mkCanvas('host'), {
      labels, rangeSec: N, yMin: null, yMax: null, tension: 0, legend: false, maxSamples: N + 1000,
      series: [{ label: 'a', color: '#58a6ff', data: a }, { label: 'b', color: '#f778ba', data: b }],
    });
    let lbl = labels[labels.length - 1] + 1, i = N;
    for (let k = 0; k < 400; k++) { ch.push(50 + 40*Math.sin(i/50), lbl, 0); ch.push(30 + 30*Math.cos(i/80), lbl, 1); lbl++; i++; }
    // bounded memory: keep pushing past the cap, then check length stayed bounded
    for (let k = 0; k < 3000; k++) { ch.push(50 + 40*Math.sin(i/50), lbl, 0); lbl++; i++; }
    const labelsLen = ch.opts.labels.length;
    const covA = window.lineCoverage(ch, [88, 166, 255]).filter(Boolean).length;
    const cv = ch.canvas, cx = cv.getContext('2d'), dpr = window.devicePixelRatio || 1;
    const img = cx.getImageData(0, 0, cv.width, cv.height), W = img.width, px = img.data;
    const padL = Math.round(ch.opts.padding.left * dpr), padR = Math.round(ch.opts.padding.right * dpr);
    let hasPink = false;
    for (let x = padL; x < W - padR && !hasPink; x++) for (let y = 0; y < img.height; y++) {
      const o = (y * W + x) * 4;
      if (Math.abs(px[o]-247)<50 && Math.abs(px[o+1]-120)<50 && Math.abs(px[o+2]-186)<50 && px[o+3]>120) { hasPink = true; break; }
    }
    // hover: dispatch a move at the centre, then read the resolved coordinate.
    ch._hoverIdx = -1;
    const rect = ch.canvas.getBoundingClientRect();
    ch.canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + rect.width/2, clientY: rect.top + rect.height/2, bubbles: true }));
    const idx = ch._hoverIdx;
    const coord = idx >= 0 ? ch._coordForIndex(0, idx) : null;
    ch.destroy();
    return { covA: covA / (W - padL - padR), hasPink, hover: idx >= 0, coordFinite: coord && Number.isFinite(coord.x) && Number.isFinite(coord.y), labelsLen, cap: N + 1000 };
  });
  check('push() renders the first streaming series', r.covA > 0.6, `coverage ${(r.covA*100).toFixed(1)}%`);
  check('push() renders a second streaming series', r.hasPink, 'pink series missing');
  check('push() hover resolves a sample with a finite coordinate', r.hover && r.coordFinite, `hover=${r.hover} coord=${JSON.stringify(r.coordFinite)}`);
  check('push() bounds memory past the cap', r.labelsLen <= r.cap + 1, `labelsLen=${r.labelsLen}, cap=${r.cap}`);
}

// ── 14. push() on a bar chart ────────────────────────────────────────────────
// A per-pixel-column min/max bucket carries two extremes, not the ten bars that
// fell in the column, so bars cannot ride the streaming path. They did anyway,
// and the rebuild left `_coordsX` pointing at the bucket COUNTS — which _draw
// then read as pixel X, collapsing every bar onto x≈0. push() now falls back to
// a full recalculate for them.
{
  const r = await page.evaluate(() => {
    const now = 1700000000, labels = [], data = [];
    for (let i = 0; i < 40; i++) { labels.push(now + i); data.push(20 + 30 * Math.abs(Math.sin(i / 5))); }
    const ch = new MiniChart(window.mkCanvas('host'), {
      type: 'bar', labels, rangeSec: 80, legend: false, yMin: 0, yMax: 60,
      series: [{ label: 'a', color: '#3fb950', data }],
    });
    let t = now + 40;
    for (let k = 0; k < 40; k++) ch.push(20 + 30 * Math.abs(Math.sin((40 + k) / 5)), t++);
    const cols = window.lineCoverage(ch, [63, 185, 80]);
    // Where the painted columns actually sit: bars collapsed at the origin show
    // up as a single cluster hard against the left edge of the plot.
    const hits = cols.map((h, i) => h ? i : -1).filter(i => i >= 0);
    // Bars are the one renderer that still keeps a pixel per sample, so this
    // reads _coordsX. Defensively: on the regression it guards, _coordsX[0] is
    // absent, and dereferencing it would abort the suite rather than fail here.
    const xs = ch._coordsX[0];
    return {
      streaming: ch._streaming,
      coordsAreFloats: xs instanceof Float64Array,
      slots: xs ? xs.length : 0,
      firstCol: hits[0], lastCol: hits[hits.length - 1], width: cols.length,
      painted: hits.length,
    };
  });
  check('push() keeps a bar chart off the streaming path', r.streaming === false,
        `_streaming=${r.streaming}`);
  check('push() leaves bar coordinates as real pixel positions',
        r.coordsAreFloats && r.slots === 80, `Float64=${r.coordsAreFloats} slots=${r.slots}`);
  check('pushed bars spread across the plot instead of collapsing at the origin',
        r.lastCol > r.width * 0.9 && r.painted > r.width * 0.4,
        `painted ${r.painted}/${r.width} cols, span ${r.firstCol}…${r.lastCol}`);
}

// ── 15. push() on an index-based chart (no labels at construction) ────────────
// Without labels _recalc leaves _useTime false, which routed hit-testing to
// _nearestCoordByX — a binary search over the coordinate arrays stream mode does
// not maintain. It returned an undefined source index, which became _hoverIdx
// and produced an empty tooltip positioned at NaN.
{
  const r = await page.evaluate(() => {
    const cv = window.mkCanvas('host');
    // No `labels`, so _recalc leaves _useTime false — the configuration that
    // broke. `rangeSec` sizes the streaming window in index units; without it
    // the window freezes at the seed length and only the last few samples show.
    const ch = new MiniChart(cv, { legend: false, rangeSec: 1000,
      series: [{ label: 'a', color: '#58a6ff', data: [1, 2, 3, 4, 5] }] });
    for (let i = 0; i < 1000; i++) ch.push(50 + 40 * Math.sin(i / 60));
    const cov = window.lineCoverage(ch, [88, 166, 255]).filter(Boolean).length;
    const rect = cv.getBoundingClientRect();
    cv.dispatchEvent(new PointerEvent('pointermove', {
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true }));
    const idx = ch._hoverIdx;
    const c = Number.isInteger(idx) && idx >= 0 ? ch._coordForIndex(0, idx) : null;
    const left = parseFloat(ch._tooltip.style.left);
    // The hover dot is painted on the overlay, and the repaint is deferred to a
    // frame — drive it directly rather than waiting. Keying the dot loop off
    // `_coordsX`, which stream mode leaves empty, silently painted no dots at
    // all while the crosshair and tooltip still worked.
    ch._drawHover();
    const ov = ch._overlay, octx = ov.getContext('2d');
    const oimg = octx.getImageData(0, 0, ov.width, ov.height).data;
    let dotPx = 0;
    for (let o = 0; o < oimg.length; o += 4) {
      if (Math.abs(oimg[o] - 88) < 40 && Math.abs(oimg[o+1] - 166) < 40 &&
          Math.abs(oimg[o+2] - 255) < 40 && oimg[o+3] > 200) dotPx++;
    }
    const out = {
      dotPx,
      cov: cov / window.lineCoverage(ch, [88, 166, 255]).length,
      idxIsInteger: Number.isInteger(idx) && idx >= 0,
      coordFinite: !!(c && Number.isFinite(c.x) && Number.isFinite(c.y)),
      tooltipHasValue: /font-weight:600/.test(ch._tooltip.innerHTML),
      tooltipPlaced: Number.isFinite(left),
      // The crosshair takes _xPixelForIndex; the dot takes _coordForIndex. They
      // are two projections of the same sample and must not disagree.
      crosshairMatchesDot: !!(c && Math.abs(ch._xPixelForIndex(idx) - c.x) < 1),
    };
    ch.destroy();
    return out;
  });
  check('push() renders an index-based streaming chart', r.cov > 0.6, `coverage ${(r.cov*100).toFixed(1)}%`);
  check('push() hover resolves a real index without labels', r.idxIsInteger && r.coordFinite,
        `integer=${r.idxIsInteger} coord=${r.coordFinite}`);
  check('push() tooltip carries a value and a finite position',
        r.tooltipHasValue && r.tooltipPlaced, `value=${r.tooltipHasValue} placed=${r.tooltipPlaced}`);
  check('push() crosshair and hover dot agree on the same sample', r.crosshairMatchesDot);
  // A low bar on purpose: the dot is r=3.5 with a 2px outline painted over it,
  // leaving only an r≈2.5 core in the series colour. The regression this guards
  // paints nothing at all, so anything against zero is the signal.
  check('push() paints the hover dot on the overlay', r.dotPx > 5, `${r.dotPx} dot pixels`);
}

// ── 16. push() from an empty series ──────────────────────────────────────────
// _len is only maintained by _recalc, which bails at len < 2 — so a chart
// streamed from nothing stayed under onMove's `if (!this._len) return` guard and
// could never be hovered.
{
  const r = await page.evaluate(() => {
    const cv = window.mkCanvas('host');
    const ch = new MiniChart(cv, { legend: false, rangeSec: 1000, series: [{ label: 'a', color: '#f778ba', data: [] }] });
    const now = 1700000000;
    for (let i = 0; i < 1000; i++) ch.push(50 + 40 * Math.sin(i / 60), now + i);
    const cov = window.lineCoverage(ch, [247, 120, 186]);
    const rect = cv.getBoundingClientRect();
    cv.dispatchEvent(new PointerEvent('pointermove', {
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true }));
    const out = { len: ch._len, retained: ch.opts.labels.length, cap: ch._stream.cap,
                  cov: cov.filter(Boolean).length / cov.length, hovered: ch._hoverIdx >= 0 };
    ch.destroy();
    return out;
  });
  check('push() onto an empty series renders', r.cov > 0.9, `coverage ${(r.cov*100).toFixed(1)}%`);
  check('push() keeps _len in step so hover works from empty', r.len === 1000 && r.hovered,
        `_len=${r.len} hovered=${r.hovered}`);
  // The derived cap came from the seeded data — one sample on an empty start —
  // so 1000 pushes retained two of them and the rest were evicted unseen.
  check('a stream from empty derives a cap the window can actually fill',
        r.cap > 1000 && r.retained === 1000, `cap=${r.cap} retained=${r.retained}`);
}

// ── 17. push() eviction keeps the hover anchored to its sample ───────────────
// Eviction splices the oldest samples off the front of every array, so every
// surviving sample shifts left. _hoverIdx is one of those positions: leaving it
// alone repointed the crosshair and the tooltip at a different sample without
// the pointer having moved.
{
  const r = await page.evaluate(() => {
    const mkChart = () => {
      const now = 1700000000, labels = [], data = [];
      for (let i = 0; i < 100; i++) { labels.push(now + i); data.push(i); }   // value === index
      return new MiniChart(window.mkCanvas('host'), {
        labels, rangeSec: 100, maxSamples: 120, legend: false, yMin: null, yMax: null,
        series: [{ label: 'a', color: '#3fb950', data }],
      });
    };
    // (a) hovered sample survives eviction → index shifts, value stays
    const c1 = mkChart();
    let t = 1700000100;
    c1.push(100, t++);                       // enter stream mode
    c1._hoverIdx = 60;
    const before = c1.opts.series[0].data[60];
    for (let k = 0; k < 20; k++) c1.push(100 + k, t++);   // crosses the cap once
    const a = { idx: c1._hoverIdx, sameSample: c1.opts.series[0].data[c1._hoverIdx] === before, before };
    c1.destroy();

    // (b) hovered sample falls out of the window → hover clears, tooltip hides
    const c2 = mkChart();
    let t2 = 1700000100;
    c2.push(100, t2++);
    c2._hoverIdx = 3;
    c2._tooltip.style.opacity = '1';
    for (let k = 0; k < 20; k++) c2.push(100 + k, t2++);
    const b = { idx: c2._hoverIdx, opacity: c2._tooltip.style.opacity };
    c2.destroy();
    return { a, b };
  });
  check('eviction shifts _hoverIdx so it still points at its own sample',
        r.a.idx !== 60 && r.a.idx >= 0 && r.a.sameSample,
        `idx ${r.a.idx}, value ${r.a.before}, still same sample: ${r.a.sameSample}`);
  check('eviction clears hover when the hovered sample leaves the window',
        r.b.idx === -1 && r.b.opacity === '0', `idx=${r.b.idx} opacity=${r.b.opacity}`);
}

// ── 18. push() leaves no stale geometry behind ───────────────────────────────
// Entering stream mode used to keep the coordinate arrays the last _recalc
// built. They describe data that has since been appended to, and nothing
// rebuilds them from there on, so hit-testing binary-searched pixel positions
// that no longer corresponded to any sample.
{
  const r = await page.evaluate(() => {
    const now = 1700000000, labels = [], data = [];
    for (let i = 0; i < 500; i++) { labels.push(now + i); data.push(50 + 40 * Math.sin(i / 30)); }
    const ch = new MiniChart(window.mkCanvas('host'), {
      labels, rangeSec: 500, legend: false, series: [{ label: 'a', color: '#3fb950', data }] });
    const cntBefore = ch._cnt[0];
    let t = now + 500;
    for (let k = 0; k < 50; k++) ch.push(50 + 40 * Math.sin((500 + k) / 30), t++);
    const out = {
      cntBefore,
      coordsCleared: ch._coordsX.length === 0 && ch._coordsY.length === 0 && ch._coordsI.length === 0,
      // _refSeriesIndex reads _cnt outside stream mode; it must still find the
      // series in stream mode, or the tooltip loses its vertical anchor.
      ref: ch._refSeriesIndex(),
      // A full recalculate (what a resize does) must take the chart back out of
      // stream mode with a real sample count again.
      afterRecalc: (() => { ch._recalc(); return { streaming: ch._streaming, cnt: ch._cnt[0] }; })(),
    };
    ch.destroy();
    return out;
  });
  check('push() drops the coordinate arrays the last recalculate built',
        r.cntBefore === 500 && r.coordsCleared,
        `before=${r.cntBefore} cleared=${r.coordsCleared}`);
  check('the reference series is still resolvable in stream mode', r.ref === 0, `ref=${r.ref}`);
  check('a recalculate takes the chart back out of stream mode',
        r.afterRecalc.streaming === false && r.afterRecalc.cnt === 550,
        JSON.stringify(r.afterRecalc));
}

// ── 19. Lone samples actually paint ──────────────────────────────────────────
// A run of one sample emitted only a moveTo, and a moveTo strokes nothing. The
// single-reading chart never even got that far — _recalc bailed below two
// samples — so both rendered as an empty plot, which on a monitoring chart is
// indistinguishable from "no data at all".
{
  const r = await page.evaluate(() => {
    // Count pixels of the series colour anywhere on the canvas, and where they sit.
    const paint = (ch) => {
      const cv = ch.canvas, d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let n = 0, minX = Infinity, maxX = -1;
      for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
        const o = (y * cv.width + x) * 4;
        if (d[o] < 120 && d[o + 1] > 140 && d[o + 2] < 130 && d[o + 3] > 150) {
          n++; if (x < minX) minX = x; if (x > maxX) maxX = x;
        }
      }
      return { n, minX, maxX };
    };
    const dpr = window.devicePixelRatio || 1;
    const opts = { legend: false, yMin: 0, yMax: 100, series: [{ label: 'a', color: '#3fb950', data: [42] }] };

    // (a) one sample, index axis — centred in the PLOT area, not the canvas
    const c1 = new MiniChart(window.mkCanvas('host'), JSON.parse(JSON.stringify(opts)));
    const p1 = paint(c1);
    const plotMid = (c1.opts.padding.left + (c1.width - c1.opts.padding.right)) / 2 * dpr;
    const a = { n: p1.n, offCentre: Math.abs((p1.minX + p1.maxX) / 2 - plotMid) };
    c1.destroy();

    // (b) one sample in a rangeSec window — pinned to the right edge, where a
    // live chart's newest reading belongs
    const c2 = new MiniChart(window.mkCanvas('host'), Object.assign(
      JSON.parse(JSON.stringify(opts)), { labels: [1700000000], rangeSec: 3600 }));
    const p2 = paint(c2);
    const plotR = (c2.width - c2.opts.padding.right) * dpr;
    const b = { n: p2.n, useTime: c2._useTime, distToRight: Math.abs(p2.maxX - plotR) };
    c2.destroy();

    // (c) an intermittent collector: every third tick reports, the rest are holes
    const data = [], labels = [];
    for (let i = 0; i < 9; i++) { labels.push(1700000000 + i * 60); data.push(i % 3 === 0 ? 20 + i * 5 : null); }
    const c3 = new MiniChart(window.mkCanvas('host'), {
      legend: false, yMin: 0, yMax: 100, labels, series: [{ label: 'a', color: '#3fb950', data }] });
    const p3 = paint(c3);
    const c = { n: p3.n, runs: c3._runs[0].length, spread: p3.maxX - p3.minX };
    c3.destroy();

    // (d) hover still resolves the lone sample, and the crosshair lands on it
    const c4 = new MiniChart(window.mkCanvas('host'), Object.assign(
      JSON.parse(JSON.stringify(opts)), { labels: [1700000000] }));
    const rect = c4.canvas.getBoundingClientRect();
    c4.canvas.dispatchEvent(new PointerEvent('pointermove', {
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true }));
    const coord = c4._hoverIdx >= 0 ? c4._coordForIndex(0, c4._hoverIdx) : null;
    // The X tick is drawn below the plot, in the only band that holds nothing
    // else, so its ink locates the label. _draw used to reimplement the
    // projection instead of going through _xPixelForIndex; on a degenerate
    // viewport the two disagreed and the tick landed at the left edge while its
    // own sample sat in the middle.
    const cv4 = c4.canvas, d4 = cv4.getContext('2d').getImageData(0, 0, cv4.width, cv4.height).data;
    const bandTop = Math.round((c4.height - c4.opts.padding.bottom + 6) * dpr);
    let tMin = Infinity, tMax = -1;
    for (let y = bandTop; y < cv4.height; y++) for (let x = 0; x < cv4.width; x++) {
      if (d4[(y * cv4.width + x) * 4 + 3] > 80) { if (x < tMin) tMin = x; if (x > tMax) tMax = x; }
    }
    const c4Mid = (c4.opts.padding.left + (c4.width - c4.opts.padding.right)) / 2 * dpr;
    const d = { idx: c4._hoverIdx,
                agree: !!(coord && Math.abs(c4._xPixelForIndex(0) - coord.x) < 0.5),
                tickInk: tMax >= 0, tickOffCentre: Math.abs((tMin + tMax) / 2 - c4Mid) };
    c4.destroy();
    return { a, b, c, d };
  });
  check('a single-sample series paints a mark', r.a.n > 0, `${r.a.n} pixels`);
  check('a lone sample is centred in the plot area', r.a.offCentre < 3,
        `${r.a.offCentre.toFixed(1)}px off the plot centre`);
  check('a single sample in a rangeSec window sits at the window edge',
        r.b.n > 0 && r.b.useTime && r.b.distToRight < 4,
        `n=${r.b.n} useTime=${r.b.useTime} ${r.b.distToRight}px from the right edge`);
  check('isolated samples between gaps each paint', r.c.n > 0 && r.c.runs === 3,
        `${r.c.n} pixels across ${r.c.runs} runs`);
  check('isolated samples are spread across the plot, not stacked', r.c.spread > 100,
        `spread ${r.c.spread}px`);
  check('hover resolves a lone sample and the crosshair lands on it',
        r.d.idx === 0 && r.d.agree, `idx=${r.d.idx} agree=${r.d.agree}`);
  check('the X tick is drawn under its own sample, not at the plot edge',
        r.d.tickInk && r.d.tickOffCentre < 20,
        `tick ${r.d.tickOffCentre.toFixed(0)}px off the plot centre (ink=${r.d.tickInk})`);
}

// ── 20. A hidden chart does not spin a frame chain ───────────────────────────
// The 0×0 layout wait was an unbounded requestAnimationFrame chain: a chart
// inside a collapsed panel polled at 60 fps for the life of the page, forcing a
// layout through getBoundingClientRect every frame, and only destroy() stopped
// it. ResizeObserver already fires on reveal, so there is nothing to poll for.
{
  const r = await page.evaluate(async () => {
    const host = document.getElementById('host');
    host.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.display = 'none';
    const cv = document.createElement('canvas');
    cv.style.cssText = 'width:800px;height:200px;display:block';
    wrap.appendChild(cv); host.appendChild(wrap);

    let frames = 0;
    const realRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (fn) => { frames++; return realRaf(fn); };
    const ch = new MiniChart(cv, { legend: false, yMin: 0, yMax: 100,
      series: [{ label: 'a', color: '#3fb950', data: [10, 90, 30, 70, 50] }] });
    await new Promise(res => setTimeout(res, 500));   // ~30 frames of opportunity
    const whileHidden = frames;
    window.requestAnimationFrame = realRaf;

    // Revealing it must still bring the chart up — that is what the poll was for.
    wrap.style.display = '';
    await new Promise(res => setTimeout(res, 300));
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let painted = 0;
    for (let o = 0; o < d.length; o += 4) {
      if (d[o] < 120 && d[o + 1] > 140 && d[o + 2] < 130 && d[o + 3] > 150) painted++;
    }
    const out = { whileHidden, ready: ch._ctxReady, painted, w: ch.width };
    ch.destroy();
    return out;
  });
  check('a hidden chart does not poll every frame', r.whileHidden <= 3,
        `${r.whileHidden} frames requested over ~500ms while hidden`);
  check('a revealed chart sizes and renders itself', r.ready && r.w === 800 && r.painted > 100,
        `ready=${r.ready} w=${r.w} painted=${r.painted}`);
}

// ── 21. Without ResizeObserver the layout wait still terminates ──────────────
// RO is what makes polling unnecessary; without it a bounded poll is the only
// way back, and the bound is the whole point. Asserted as "does it stop" rather
// than "how many frames", so the check does not depend on the frame rate: count
// requests across two consecutive windows and read the second one.
{
  const r = await page.evaluate(async () => {
    const host = document.getElementById('host');
    host.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.display = 'none';
    const cv = document.createElement('canvas');
    cv.style.cssText = 'width:800px;height:200px;display:block';
    wrap.appendChild(cv); host.appendChild(wrap);

    const RealRO = window.ResizeObserver;
    const realRaf = window.requestAnimationFrame;
    let frames = 0;
    delete window.ResizeObserver;
    window.requestAnimationFrame = (fn) => { frames++; return realRaf(fn); };
    let ch;
    try {
      ch = new MiniChart(cv, { legend: false, yMin: 0, yMax: 100,
        series: [{ label: 'a', color: '#3fb950', data: [10, 90, 30, 70, 50] }] });
      await new Promise(res => setTimeout(res, 1600));   // outlast the 60-frame budget
      const atFirst = frames;
      await new Promise(res => setTimeout(res, 800));    // ~48 more frames of opportunity
      var settled = frames - atFirst;
      var total = frames;
    } finally {
      window.requestAnimationFrame = realRaf;
      window.ResizeObserver = RealRO;
    }

    // The documented escape hatch: repaint() sizes a chart that was hidden when
    // it was built. Without it, bounding the poll would strand this chart.
    wrap.style.display = '';
    ch.repaint();
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let painted = 0;
    for (let o = 0; o < d.length; o += 4) {
      if (d[o] < 120 && d[o + 1] > 140 && d[o + 2] < 130 && d[o + 3] > 150) painted++;
    }
    // The budget covers one layout wait, not the instance: a dashboard that
    // hides a tab and comes back to it must get a fresh one. Hide it again and
    // drive the sizing callback the way a window resize would.
    wrap.style.display = 'none';
    let reFrames = 0;
    window.requestAnimationFrame = (fn) => { reFrames++; return realRaf(fn); };
    ch._applyDPR();
    window.requestAnimationFrame = realRaf;

    const out = { settled, total, ready: ch._ctxReady, w: ch.width, painted, reFrames };
    ch.destroy();
    return out;
  });
  check('the layout-wait budget resets once the chart has been laid out',
        r.reFrames > 0, 'hiding the chart again left no polling budget');
  check('the no-ResizeObserver poll gives up instead of running forever',
        r.settled === 0, `${r.settled} further frames requested after the budget (total ${r.total})`);
  check('repaint() recovers a chart that was hidden when it was built',
        r.ready && r.w === 800 && r.painted > 100,
        `ready=${r.ready} w=${r.w} painted=${r.painted}`);
}

// ── 22. The Y bounds cache must never go stale ──────────────────────────────
// Per-series extremes are cached so a resize, a zoom or a legend toggle does
// not rescan the samples. The failure mode of a cache that misses a data change
// is the worst kind: the axis silently disagrees with the line drawn against
// it, and nothing looks broken. update() and push() invalidate it explicitly —
// an in-place edit leaves the array's identity and length untouched, so nothing
// else can notice.
{
  const r = await page.evaluate(() => {
    const now = 1700000000;
    const mk = (data) => new MiniChart(window.mkCanvas('host'), {
      legend: false, yMin: null, yMax: null, rangeSec: data.length,
      labels: data.map((_, i) => now + i),
      series: [{ label: 'a', color: '#3fb950', data }] });

    // (a) same array, same length, one sample edited in place
    const c1 = mk([10, 20, 30, 20, 10]);
    const before = c1.yRange.max;
    c1.opts.series[0].data[2] = 5000;
    c1.update({ series: c1.opts.series });
    const a = { before, after: c1.yRange.max };
    c1.destroy();

    // (b) a pushed sample beyond the current range, then a recalculate — what a
    // resize does — must see it
    const c2 = mk([10, 20, 30, 20, 10]);
    c2.push(9000, now + 5);
    c2._recalc();
    const b = { max: c2.yRange.max };
    c2.destroy();

    // (c) the cache must still do its job: a zoom leaves it intact
    const data = [];
    for (let i = 0; i < 2000; i++) data.push(50 + 40 * Math.sin(i / 50));
    const c3 = mk(data);
    const dirtyAfterRecalc = c3._boundsDirty;
    const refs = c3._sbMin;
    c3.setXRange(now + 100, now + 900);
    const c = { dirtyAfterRecalc, reused: c3._sbMin === refs, dirty: c3._boundsDirty };
    c3.destroy();
    return { a, b, c };
  });
  check('an in-place edit plus update() rescales the axis',
        r.a.after >= 5000 && r.a.before < 100,
        `max ${r.a.before} → ${r.a.after}, expected ≥5000`);
  check('a pushed sample beyond the range survives a later recalculate',
        r.b.max >= 9000, `max=${r.b.max}, expected ≥9000`);
  check('a zoom reuses the cached extremes instead of rescanning',
        r.c.dirtyAfterRecalc === false && r.c.reused && r.c.dirty === false,
        `dirty=${r.c.dirty} reused=${r.c.reused}`);
}

// ── on.* callbacks fire, and update() merges them rather than replacing ──────
// Four documented events (ready/hover/click/seriesToggle) had zero coverage, and
// update({on}) used to replace the whole map — silently dropping earlier handlers.
{
  const r = await page.evaluate(() => {
    const d = window.series(2000, { noisy: false });
    const got = { ready: 0, hover: 0, click: 0 };
    const ch = new MiniChart(window.mkCanvas('host'), {
      series: [{ label: 's', data: d.data, color: '#3fb950' }],
      labels: d.labels, rangeSec: 2000, legend: false,
      on: { ready: () => got.ready++, hover: () => got.hover++, click: () => got.click++ },
    });
    const rect = ch.canvas.getBoundingClientRect();
    const mid = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true };
    ch.canvas.dispatchEvent(new PointerEvent('pointermove', mid));
    ch.canvas.dispatchEvent(new MouseEvent('click', mid));
    // Add a second handler through update — the existing hover/click must survive.
    ch.update({ on: { ready: () => {} } });
    const merged = Object.keys(ch.opts.on).sort().join(',');
    ch.destroy();
    return { got, merged };
  });
  check('on.ready fires once at construction', r.got.ready === 1, `ready=${r.got.ready}`);
  check('on.hover fires on a pointer move', r.got.hover >= 1, `hover=${r.got.hover}`);
  check('on.click fires on a click', r.got.click >= 1, `click=${r.got.click}`);
  check('update({on}) merges handlers (old set survives)', r.merged === 'click,hover,ready',
    `merged keys=${r.merged}`);
}

// ── partial padding merges instead of blanking the chart ─────────────────────
// A partial { top } used to overwrite right/bottom/left → a NaN plot width → a
// blank chart, on input that the .d.ts types call valid.
{
  const r = await page.evaluate(() => {
    const d = window.series(2000, { noisy: false });
    const covOf = (ch) => {
      const cols = window.lineCoverage(ch, [63, 185, 80]);
      return cols.filter(Boolean).length / (cols.length || 1);
    };
    const ch = new MiniChart(window.mkCanvas('host'), {
      series: [{ label: 's', data: d.data, color: '#3fb950' }],
      labels: d.labels, rangeSec: 2000, legend: false, padding: { top: 20 },
    });
    const ctor = { bottom: ch.opts.padding.bottom, right: ch.opts.padding.right, left: ch.opts.padding.left, cov: covOf(ch) };
    ch.destroy();
    const ch2 = new MiniChart(window.mkCanvas('host'), {
      series: [{ label: 's', data: d.data, color: '#3fb950' }],
      labels: d.labels, rangeSec: 2000, legend: false,
    });
    ch2.update({ padding: { top: 20 } });
    const upd = { bottom: ch2.opts.padding.bottom, right: ch2.opts.padding.right, cov: covOf(ch2) };
    ch2.destroy();
    return { ctor, upd };
  });
  check('constructor: partial padding keeps bottom/right/left',
    r.ctor.bottom > 0 && r.ctor.right > 0 && r.ctor.left > 0,
    `bottom=${r.ctor.bottom} right=${r.ctor.right} left=${r.ctor.left}`);
  check('constructor: partial padding renders (>90% coverage)',
    r.ctor.cov > 0.9, `coverage=${(r.ctor.cov * 100).toFixed(1)}%`);
  check('update(): partial padding keeps bottom/right',
    r.upd.bottom > 0 && r.upd.right > 0, `bottom=${r.upd.bottom} right=${r.upd.right}`);
  check('update(): partial padding renders (>90% coverage)',
    r.upd.cov > 0.9, `coverage=${(r.upd.cov * 100).toFixed(1)}%`);
}

// ── destroy() releases the data-holding fields ───────────────────────────────
// destroy() documented "drop every data array" but leaked the bounds cache
// (_sbRef holds each series' data array), the streaming rings and the runs.
{
  const r = await page.evaluate(() => {
    const d = window.series(10000, { noisy: false });
    const ch = new MiniChart(window.mkCanvas('host'), {
      series: [{ label: 's', data: d.data, color: '#3fb950' }],
      labels: d.labels, rangeSec: 10000, legend: false,
    });
    // _sbRef + _runs come from the construction-time _recalc; _streams from a push.
    const hadSbRef = !!ch._sbRef, hadRuns = !!ch._runs;
    ch.push(75, d.labels[d.labels.length - 1] + 1);   // enters streaming, populates _streams
    const hadStreams = !!ch._streams && ch._streams.length > 0;
    ch.destroy();
    return {
      hadSbRef, hadRuns, hadStreams,
      sbRefNull: ch._sbRef === null,
      streamsNull: ch._streams === null,
      runsNull: ch._runs === null,
    };
  });
  check('before destroy the data fields are populated',
    r.hadSbRef && r.hadRuns && r.hadStreams,
    `sbRef=${r.hadSbRef} runs=${r.hadRuns} streams=${r.hadStreams}`);
  check('destroy() releases the bounds cache (_sbRef)', r.sbRefNull, '_sbRef not nulled');
  check('destroy() releases the streaming rings (_streams)', r.streamsNull, '_streams not nulled');
  check('destroy() releases the decimated runs (_runs)', r.runsNull, '_runs not nulled');
}

await browser.close();

console.log('\nBrowser regression tests (real minichart.js):');
console.log(results.join('\n'));
if (pageErrors.length) {
  console.log('\nPage errors:\n  ' + pageErrors.join('\n  '));
  failed += pageErrors.length;
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

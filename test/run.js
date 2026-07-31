#!/usr/bin/env node
/**
 * Headless unit tests for the algorithmic invariants of MiniChart.
 *
 * These tests call the REAL methods on MiniChart.prototype. They used to mirror
 * copies of each algorithm here "for DOM-free testing", which quietly defeated
 * the point: the copies stayed correct while the shipped composition of the
 * same algorithms broke, and the suite reported 10/10 green against a chart
 * that rendered nothing at all. A test that cannot fail when the product breaks
 * is not a test.
 *
 * The geometry helpers do not touch the DOM, so they can be invoked against a
 * minimal stand-in `this` via .call(). Anything that needs a real canvas —
 * rendering, hover, overlay geometry, resize — is covered by test/visual.mjs.
 *
 * Run with: `npm run test:unit` (or `npm test`, which runs both suites).
 */
'use strict';
const assert = require('assert');
// Node has no Path2D; _recalc builds one Path2D per series. These tests assert
// only on _runs / _coordsX, so a no-op stand-in is enough.
if (typeof Path2D === 'undefined') {
  global.Path2D = class {
    constructor() {} moveTo() {} lineTo() {} bezierCurveTo() {} closePath() {}
    arc() {}   // a lone sample is emitted as a dot
  };
}
const MiniChart = require('../minichart.js');

const P = MiniChart.prototype;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

/** Minimal stand-in for a chart instance, enough for the geometry helpers. */
function stub({ plotLeft = 0, plotRight = 800, width = 810, yUnit = '', ranges = null } = {}) {
  // Inherit from the prototype so helpers that call sibling methods
  // (_buildRuns → _decimateRun/_slotsOf, _hexA → _parseColor) resolve them normally.
  return Object.assign(Object.create(P), {
    width: width,
    yRange: ranges,
    opts: { padding: { left: plotLeft, right: width - plotRight }, yUnit, yFormat: null },
  });
}

/**
 * A headless chart stand-in rich enough to run the REAL _recalc without a canvas.
 * Decimation is fused into _recalc's projection loop, so the tests drive _recalc
 * and assert on `s._runs` (the decimated slot lists) and `s._coordsX/_coordsI`.
 *
 * `_userPadLeft` is set so _recalc skips its measureText Y-gutter (which needs a
 * 2d context); padding.left is then exactly `plotLeft`, so plotL/plotR are fixed.
 * yMin/yMax are pinned to skip autoscale and make the value→pixel map explicit.
 */
const PAD_T = 12, PAD_B = 22, H = 300;
function recalcStub({ data, series = null, labels = null, plotLeft = 0, width = 810, plotRight = 800,
                      yMin = 0, yMax = 100, tension = 0, viewMin = null, viewMax = null,
                      rangeSec = undefined } = {}) {
  const locked = viewMin != null && viewMax != null;
  const s = Object.assign(Object.create(P), {
    width: width, height: H,
    _bufX: [], _bufY: [], _bufI: [],
    _boundsDirty: true,              // no cached Y extremes yet, same as a fresh chart
    _visibleSeries: null,
    _userPadLeft: plotLeft,          // pin padding.left, skip measureText
    _viewXLocked: locked,
    _viewXMin: locked ? viewMin : 0,
    _viewXMax: locked ? viewMax : 1,
    _dataXMin: 0, _dataXMax: 1,
    opts: {
      type: 'line', tension, fill: false, yTicks: 4, yMin, yMax, rangeSec: rangeSec,
      yUnit: '', yFormat: null, xFormat: 'number', legend: false, theme: {},
      labels,
      series: series || [{ label: 's', color: '#3fb950', data }],
      padding: { top: PAD_T, right: width - plotRight, bottom: PAD_B, left: plotLeft },
    },
  });
  s._recalc();
  return s;
}

// ── Decimation (now fused into _recalc's projection loop) ────────────────────
// Decimation is no longer a standalone method; it rides the projection loop in
// _recalc, bucketing min/max per pixel column as each sample is projected. These
// tests drive the REAL _recalc headless and assert on `s._runs` (decimated slot
// lists) and `s._coordsX/_coordsI`. This is the composition that once broke here
// (decimation before gap-split → blank chart, green suite); the rendered-pixel
// tests in test/visual.mjs are the other half of the guard.

console.log('\nDecimation (fused into _recalc):');
test('reduces a dense series to ~2 samples per pixel column', () => {
  const n = 5000;
  const data = Array.from({ length: n }, (_, k) => 50 + 40 * Math.sin(k / 7));
  const run = recalcStub({ data })._runs[0][0];   // plotW=800, threshold=1600, n>threshold
  assert.ok(run.length < n, 'not reduced: ' + run.length);
  assert.ok(run.length <= 800 * 2 + 8, 'too many survived: ' + run.length);
});
test('preserves single-sample spikes (peak and trough)', () => {
  // yMin=0/yMax=100 pinned: v=100 → top (smallest screen y, the peak),
  // v=0 → bottom (largest screen y, the trough). Each bucket keeps both extremes.
  const n = 5000;
  const data = Array.from({ length: n }, () => 50);
  data[1000] = 100;   // peak
  data[3000] = 0;     // trough
  const run = recalcStub({ data })._runs[0][0];
  assert.ok(run.includes(1000), 'peak at slot 1000 averaged away');
  assert.ok(run.includes(3000), 'trough at slot 3000 averaged away');
});
test('emits surviving slots in ascending source order', () => {
  const n = 5000;
  const data = Array.from({ length: n }, (_, k) => 50 + 40 * Math.sin(k / 3));
  const run = recalcStub({ data })._runs[0][0];
  for (let k = 1; k < run.length; k++) {
    assert.ok(run[k] > run[k - 1], `slot went backwards at ${k}: ${run[k - 1]} → ${run[k]}`);
  }
});
test('gaps survive as separate runs, never decimated across the hole', () => {
  // labels 0..4999 with samples 2000..2999 null → a gap in the middle.
  const n = 5000;
  const labels = Array.from({ length: n }, (_, k) => k);
  const data = Array.from({ length: n }, (_, k) => 50 + 40 * Math.sin(k / 9));
  for (let k = 2000; k < 3000; k++) data[k] = null;
  const s = recalcStub({ data, labels });
  const runs = s._runs[0];
  assert.strictEqual(runs.length, 2, 'expected 2 runs around the gap, got ' + runs.length);
  assert.ok(runs.every(r => r.length >= 2), 'a run collapsed to a single point');
  // Runs carry source indices directly; run 0's must sit before the gap and
  // run 1's after it — decimating across the gap would mix them.
  assert.ok(runs[0].every(i => i < 2000), 'first run leaked past the gap');
  assert.ok(runs[1].every(i => i >= 3000), 'second run leaked before the gap');
});
test('sparse series passes every slot through unchanged', () => {
  // 100 samples on an 800px plot: well under the 2/px threshold → no decimation.
  const data = Array.from({ length: 100 }, (_, k) => k);
  const runs = recalcStub({ data })._runs[0];
  assert.strictEqual(runs.length, 1);
  assert.deepStrictEqual(runs[0], Array.from({ length: 100 }, (_, k) => k));
});
test('off-screen tails collapse to the nearest edge sample', () => {
  // Zoom the viewport to the middle 1000 of a 0..4999 domain: samples outside
  // [1000, 3000] are off-screen and must collapse to one sample per side, so the
  // decimated count stays ~2/px of the VIEW, not of the whole domain.
  const n = 5000;
  const labels = Array.from({ length: n }, (_, k) => k);
  const data = Array.from({ length: n }, (_, k) => 50 + 40 * Math.sin(k / 11));
  const run = recalcStub({ data, labels, viewMin: 1000, viewMax: 3000 })._runs[0][0];
  assert.ok(run.length > 0, 'zoomed view drew nothing');
  assert.ok(run.length <= 800 * 2 + 8, 'off-screen tail was not collapsed: ' + run.length);
});
test('empty or all-missing series produces no runs', () => {
  // Empty data early-returns in _recalc (so _runs has no per-series entry →
  // undefined); all-missing data runs the projection but retains nothing (→ []).
  assert.deepStrictEqual(recalcStub({ data: [] })._runs[0] || [], []);
  assert.deepStrictEqual(recalcStub({ data: [null, NaN, null] })._runs[0] || [], []);
});

// ── Index → coordinate lookup ────────────────────────────────────────────────
// _coordForIndex projects on demand instead of reading a stored pixel per
// sample — 16 bytes each that existed to answer one query per pointer move. A
// sample was retained exactly when it was finite, so the presence test has to
// stay exact: samples dropped as non-finite leave holes in the source indices,
// and a nearest-hit lookup would snap the tooltip onto a neighbouring sample
// across a gap.

console.log('\nIndex lookup (_coordForIndex):');
/**
 * Chart stand-in whose series holds a finite value at exactly `indices` and a
 * hole everywhere else. The value stored at each is that index's position in
 * the list, so the resolved y identifies WHICH sample came back.
 */
function coordStub(indices) {
  const max = indices.length ? indices[indices.length - 1] : -1;
  const data = new Array(max + 1);
  // Every documented form of "missing" — the class doc counts null, NaN and
  // ±Infinity alike — rotated through the holes so none of them is untested.
  const HOLES = [null, undefined, NaN, Infinity, -Infinity];
  for (let i = 0; i <= max; i++) data[i] = HOLES[i % HOLES.length];
  indices.forEach((i, k) => { data[i] = k; });
  return Object.assign(Object.create(P), {
    width: 810, height: 300, _len: max + 1, _useTime: false,
    _coordsI: [Int32Array.from(indices)],
    yRange: { min: 0, max: 1000 },
    opts: {
      labels: null,
      series: [{ label: 's', color: '#3fb950', data }],
      padding: { top: 12, right: 10, bottom: 22, left: 10 },
    },
  });
}
test('resolves every present index to its own sample', () => {
  const idx = [0, 3, 4, 9, 10, 40, 41, 99];
  const self = coordStub(idx);
  let lastX = -Infinity;
  idx.forEach((i, k) => {
    const c = P._coordForIndex.call(self, 0, i);
    assert.ok(c, 'no coordinate for present index ' + i);
    // data[i] === k, so y is what proves the right sample was resolved.
    assert.strictEqual(c.y, P._projectY.call(self, k), 'index ' + i + ' resolved to another sample');
    // x must separate the indices and keep their order.
    assert.ok(c.x > lastX, 'x did not increase at index ' + i);
    lastX = c.x;
  });
});
test('missing index → null, never the neighbour', () => {
  // 5..9 are holes, so 4 and 10 are adjacent retained samples.
  const self = coordStub([0, 1, 2, 3, 4, 10, 11, 12]);
  for (const gap of [5, 6, 7, 8, 9]) {
    assert.strictEqual(P._coordForIndex.call(self, 0, gap), null,
      'index ' + gap + ' inside a gap resolved to a neighbouring sample');
  }
  assert.strictEqual(P._coordForIndex.call(self, 0, 4).y, P._projectY.call(self, 4),
    'left edge of the gap lost');
  assert.strictEqual(P._coordForIndex.call(self, 0, 10).y, P._projectY.call(self, 5),
    'right edge of the gap lost');
});
test('out-of-range index → null', () => {
  const self = coordStub([10, 11, 12]);
  assert.strictEqual(P._coordForIndex.call(self, 0, 9), null, 'a hole below the first sample');
  assert.strictEqual(P._coordForIndex.call(self, 0, 13), null, 'past the end of the data');
  assert.strictEqual(P._coordForIndex.call(self, 0, -1), null, 'negative index');
});
test('empty or absent series → null, never a throw', () => {
  assert.strictEqual(P._coordForIndex.call(coordStub([]), 0, 0), null);
  const self = coordStub([1, 2, 3]);
  assert.strictEqual(P._coordForIndex.call(self, 7, 1), null, 'out-of-range series index');
  assert.strictEqual(P._coordForIndex.call(Object.create(P), 0, 1), null, 'destroyed instance');
});
test('agrees with a linear scan over a sparse series', () => {
  // Every third index retained, so most lookups must miss.
  const indices = Array.from({ length: 300 }, (_, k) => k * 3);
  const self = coordStub(indices);
  const present = new Set(indices);
  for (let i = -2; i < 910; i++) {
    const got = P._coordForIndex.call(self, 0, i);
    if (present.has(i)) {
      assert.ok(got, 'missed present index ' + i);
      assert.strictEqual(got.y, P._projectY.call(self, i / 3), 'wrong sample at index ' + i);
    } else {
      assert.strictEqual(got, null, 'phantom hit at absent index ' + i);
    }
  }
});

// ── Colour parsing ───────────────────────────────────────────────────────────

console.log('\nColour parsing (_parseColor / _hexA):');
test('#rrggbb and #rgb', () => {
  assert.deepStrictEqual(P._parseColor.call({}, '#3fb950'), [63, 185, 80]);
  assert.deepStrictEqual(P._parseColor.call({}, '#3f9'), [51, 255, 153]);
});
test('rgb() and rgba()', () => {
  assert.deepStrictEqual(P._parseColor.call({}, 'rgb(255, 0, 0)'), [255, 0, 0]);
  assert.deepStrictEqual(P._parseColor.call({}, 'rgba(1,2,3,0.5)'), [1, 2, 3]);
});
test('invalid input → null, never a throw', () => {
  // No document in node, so the canvas-probe fallback is unavailable; the
  // method must degrade rather than blow up.
  for (const bad of [undefined, null, '', 42, {}, 'not-a-color']) {
    assert.strictEqual(P._parseColor.call({}, bad), null, 'accepted ' + JSON.stringify(bad));
  }
});
test('_hexA degrades to neutral grey instead of NaN', () => {
  const self = stub();
  assert.strictEqual(self._hexA('not-a-color', 0.35), 'rgba(128,128,128,0.35)');
  assert.ok(!/NaN/.test(self._hexA('#3f9', 1)), 'NaN leaked into rgba()');
});

// ── Formatting ───────────────────────────────────────────────────────────────

console.log('\nFormatting (_fmtY):');
test('compact notation rounds sensibly', () => {
  const self = stub();
  assert.strictEqual(P._fmtY.call(self, 1500), '1.5k');
  assert.strictEqual(P._fmtY.call(self, 999), '999');
  assert.strictEqual(P._fmtY.call(self, 99), '99');
  assert.strictEqual(P._fmtY.call(self, 2.34), '2.3');
  assert.strictEqual(P._fmtY.call(self, -1500), '-1.5k');
});
test('null → em dash', () => {
  assert.strictEqual(P._fmtY.call(stub(), null), '—');
});
test('yFormat callback wins, and a throwing one falls back', () => {
  const self = stub();
  self.opts.yFormat = (v) => v + ' units';
  assert.strictEqual(P._fmtY.call(self, 5), '5 units');
  self.opts.yFormat = () => { throw new Error('boom'); };
  assert.strictEqual(P._fmtY.call(self, 1500), '1.5k');
});

// ── Y bounds cache (_ensureSeriesBounds) ─────────────────────────────────────
// The autoscale reads cached per-series extremes so a resize, a zoom or a
// legend toggle does not rescan the samples. A cache that misses a data change
// is far worse than the scan it replaces: the axis would silently disagree with
// the line drawn against it.

console.log('\nY bounds cache (_ensureSeriesBounds):');
test('caches per-series extremes and reuses them', () => {
  const s = recalcStub({ data: [10, 50, 30], yMin: null, yMax: null });
  assert.deepStrictEqual([s._sbMin[0], s._sbMax[0]], [10, 50]);
  assert.strictEqual(s._boundsDirty, false, 'cache should be marked clean');
  // A second recalculate with nothing changed must not rebuild it.
  const ref = s._sbMin;
  s._recalc();
  assert.strictEqual(s._sbMin, ref, 'cache was rebuilt despite unchanged data');
});
test('a swapped or resized data array invalidates the cache', () => {
  const s = recalcStub({ data: [10, 50, 30], yMin: null, yMax: null });
  s.opts.series[0].data = [100, 200, 300];        // new array, same length
  s._recalc();
  assert.deepStrictEqual([s._sbMin[0], s._sbMax[0]], [100, 300], 'array swap missed');
  s.opts.series[0].data.push(1000);               // same array, new length
  s._recalc();
  assert.strictEqual(s._sbMax[0], 1000, 'length change missed');
});
test('a series added or removed invalidates the cache', () => {
  const s = recalcStub({ data: [10, 50, 30], yMin: null, yMax: null });
  s.opts.series.push({ label: 'b', color: '#58a6ff', data: [500] });
  s._recalc();
  assert.strictEqual(s._sbMax[1], 500, 'new series never scanned');
  assert.strictEqual(s.yRange.max >= 500, true, 'axis ignored the new series');
});
test('hidden series are cached but excluded from the axis', () => {
  const s = recalcStub({
    yMin: null, yMax: null,
    series: [{ label: 'a', color: '#3fb950', data: [1, 2, 3] },
             { label: 'b', color: '#58a6ff', data: [900] }],
  });
  assert.strictEqual(s._sbMax[1], 900, 'hidden-capable series should still be cached');
  s._visibleSeries = [0];
  s._recalc();
  assert.ok(s.yRange.max < 100, `hidden series still drove the axis: ${s.yRange.max}`);
  s._visibleSeries = [0, 1];
  s._recalc();
  assert.ok(s.yRange.max >= 900, 'unhiding did not bring the series back');
});

// ── X domain from sorted labels ──────────────────────────────────────────────
// The domain is read off the first and last finite labels rather than scanned
// for, which is only sound because `labels` is contractually ascending. Both
// ends have to skip non-finite entries, and a violated contract must degrade
// visibly rather than into NaN.

console.log('\nX domain from sorted labels:');
test('a non-finite label at either end is skipped', () => {
  // NaN passes `typeof === "number"`, so it reaches the domain scan where a
  // null would have been rejected earlier.
  const data = [1, 2, 3, 4];
  const s = recalcStub({ data, labels: [NaN, 1700000001, 1700000002, NaN] });
  assert.strictEqual(s._useTime, true, 'should still be a time domain');
  assert.strictEqual(s._dataXMin, 1700000001, 'leading NaN became the domain start');
  assert.strictEqual(s._dataXMax, 1700000002, 'trailing NaN became the domain end');
});
test('a plot narrower than its own padding still projects forwards', () => {
  // A collapsing sidebar can leave the canvas narrower than its gutters, making
  // `width - left - right` negative. _recalc clamps the plot width to 1 there;
  // _projectX has to apply the same clamp, or the coordinate it recomputes runs
  // backwards while the drawn path does not — the crosshair would cross the
  // plot in the opposite direction to the line.
  const s = recalcStub({
    data: [1, 2, 3, 4], labels: [10, 20, 30, 40],
    width: 10, plotLeft: 8, plotRight: 5,     // padding.right = 5 → width 10-8-5 = -3
  });
  const xs = [0, 1, 2, 3].map(i => s._coordForIndex(0, i).x);
  for (let k = 1; k < xs.length; k++) {
    assert.ok(xs[k] >= xs[k - 1], `projection ran backwards: ${xs.join(', ')}`);
  }
  assert.ok(xs[xs.length - 1] - xs[0] <= 1 + 1e-9,
    `clamped plot should span at most 1px, got ${xs[xs.length - 1] - xs[0]}`);
});
test('descending labels degrade visibly, not into a collapsed axis', () => {
  // Ascending order is the documented contract and the chart will read wrong
  // either way — but an inverted domain would put a negative span into the
  // projection, and every sample would land on one pixel.
  const s = recalcStub({ data: [1, 2, 3, 4], labels: [400, 300, 200, 100] });
  const xs = [0, 1, 2, 3].map((i) => s._coordForIndex(0, i).x);
  assert.ok(xs.every(Number.isFinite), 'non-finite coordinate: ' + xs.join(','));
  assert.ok(new Set(xs).size > 1, 'every sample collapsed onto one x: ' + xs.join(','));
});

// ── Coordinate buffer store ──────────────────────────────────────────────────
// The backing typed arrays are reused across recalculates to keep a live chart
// from churning ~20 bytes per sample every frame. Reuse that never releases is
// a leak in the other direction, and it is keyed by series index, so buffers
// outlive the series they belonged to.

console.log('\nCoordinate buffer store:');
test('a buffer is reused while it is merely big enough', () => {
  const s = recalcStub({ data: new Array(4000).fill(5) });
  const buf = s._bufI[0];
  s.opts.series[0].data = new Array(3000).fill(5);   // smaller, but within a factor of 4
  s._recalc();
  assert.strictEqual(s._bufI[0], buf, 'buffer was needlessly reallocated');
  assert.strictEqual(s._coordsI[0].length, 3000, 'view should track the new length');
});
test('a buffer is released once the data no longer justifies it', () => {
  const s = recalcStub({ data: new Array(40000).fill(5) });
  assert.strictEqual(s._bufI[0].length, 40000);
  s.opts.series[0].data = new Array(100).fill(5);
  s._recalc();
  assert.strictEqual(s._bufI[0].length, 100, 'a 40k buffer was held for 100 samples');
});
test('buffers for removed series are dropped', () => {
  const s = recalcStub({
    series: [{ label: 'a', color: '#3fb950', data: new Array(500).fill(1) },
             { label: 'b', color: '#58a6ff', data: new Array(500).fill(2) },
             { label: 'c', color: '#f778ba', data: new Array(500).fill(3) }],
  });
  assert.strictEqual(s._bufI.length, 3);
  s.opts.series.length = 1;
  s._recalc();
  assert.strictEqual(s._bufI.length, 1, 'buffers outlived their series');
  assert.ok(s._bufX.length <= 1 && s._bufY.length <= 1, 'pixel buffers outlived their series');
});
test('a line chart stores no pixel per sample; a bar chart does', () => {
  // The line path rebuilds the ~2-per-column vertices its Path2D needs, and
  // resolves hover by projecting on demand, so the two Float64Arrays that used
  // to hold a pixel for every sample — 16 of the 20 bytes each one cost — are
  // never allocated. Bars draw one rect per sample and still need them.
  const data = Array.from({ length: 5000 }, (_, k) => 50 + 40 * Math.sin(k / 7));
  const line = recalcStub({ data });
  assert.strictEqual(line._bufX[0], undefined, 'a line chart allocated an X pixel buffer');
  assert.strictEqual(line._bufY[0], undefined, 'a line chart allocated a Y pixel buffer');
  assert.strictEqual(line._coordsI[0].length, 5000, 'source indices should still be kept');

  line.opts.type = 'bar';
  line._recalc();
  assert.strictEqual(line._bufX[0].length, 5000, 'a bar chart needs a pixel per sample');
  assert.strictEqual(line._coordsX[0].length, 5000);

  // …and switching back releases them again.
  line.opts.type = 'line';
  line._recalc();
  assert.strictEqual(line._bufX[0], null, 'pixel buffers survived the switch back to a line');
  assert.strictEqual(line._coordsX[0], null);
});
test('a time-axis line drops the per-sample index buffer', () => {
  // Time-axis hover resolves through `labels` and the path is built from source
  // indices carried in the runs, so the ~4 MB/series Int32 index buffer that was
  // retained for the chart's life is dropped. Only `_cnt` (the finite count)
  // stays, so the sample-count checks in _draw/_refSeriesIndex keep working.
  const data = Array.from({ length: 5000 }, (_, k) => 50 + 40 * Math.sin(k / 7));
  const labels = Array.from({ length: 5000 }, (_, k) => 1700000000 + k);
  const s = recalcStub({ data, labels });
  assert.strictEqual(s._useTime, true, 'labels should make this a time domain');
  assert.strictEqual(s._coordsI[0], null, 'a time-axis line retained _coordsI');
  assert.strictEqual(s._bufI[0], null, 'a time-axis line retained the index buffer');
  assert.strictEqual(s._cnt[0], 5000, '_cnt did not track the finite count');
  assert.ok(s._runs[0].length > 0, 'no runs were built without _coordsI');
});
test('an index-axis line keeps the index buffer (hover binary-searches it)', () => {
  // No labels → index axis → _nearestCoordByX needs the finite source indices,
  // so _coordsI is retained here even though a line keeps no pixel per sample.
  const data = Array.from({ length: 5000 }, (_, k) => 50 + 40 * Math.sin(k / 7));
  const s = recalcStub({ data });
  assert.strictEqual(s._useTime, false, 'no labels should be an index domain');
  assert.ok(s._coordsI[0] instanceof Int32Array, 'an index-axis line dropped _coordsI');
  assert.strictEqual(s._coordsI[0].length, 5000);
  assert.strictEqual(s._cnt[0], 5000);
});
test('a hidden series is not projected (only visible series pay for it)', () => {
  // With most series turned off on a multi-series dashboard, projecting a hidden
  // series' million points only to skip them at draw is pure waste. Hidden series
  // get placeholders (aligned si-indexing, empty runs, released buffers); visible
  // ones project normally. No-op when _visibleSeries is null (everything visible).
  const a = Array.from({ length: 5000 }, (_, k) => 50 + 40 * Math.sin(k / 7));
  const b = Array.from({ length: 5000 }, (_, k) => 10 + 5 * Math.sin(k / 3));
  const s = recalcStub({
    series: [{ label: 'a', color: '#3fb950', data: a },
             { label: 'b', color: '#58a6ff', data: b }],
  });
  s._visibleSeries = [0];   // hide series 1
  s._recalc();
  assert.ok(s._runs[0].length > 0, 'the visible series was not projected');
  assert.deepStrictEqual(s._runs[1] || [], [], 'the hidden series was projected');
  assert.strictEqual(s._coordsI[1], null, 'the hidden series retained coordinates');
  assert.strictEqual(s._bufI[1], null, 'the hidden series retained its buffer');
  assert.strictEqual(s._cnt[1], 0, 'the hidden series has a finite count');
  // Toggling it back visible (full _recalc) rebuilds it.
  s._visibleSeries = null;
  s._recalc();
  assert.ok(s._runs[1].length > 0, 'a re-shown series was not re-projected');
});

// ── Lone samples ─────────────────────────────────────────────────────────────
// A run of one sample emitted only a moveTo, which paints nothing. That blanked
// two different charts: a series of a single reading, and — more commonly — an
// intermittent metric whose surviving readings each sit alone between gaps.
// _recalc bailed outright below two samples, so the single-reading case never
// even reached the path builder.

console.log('\nLone samples:');
test('a single sample produces a coordinate and a run', () => {
  const s = recalcStub({ data: [42] });
  assert.strictEqual(s._len, 1);
  assert.strictEqual(s._coordsI[0].length, 1, 'no sample was retained');
  assert.strictEqual(s._runs[0].length, 1, 'expected one run');
  assert.deepStrictEqual(Array.from(s._runs[0][0]), [0], 'run should hold the lone slot');
  const c = s._coordForIndex(0, 0);
  assert.ok(c && Number.isFinite(c.x) && Number.isFinite(c.y),
    `non-finite coordinate: ${JSON.stringify(c)}`);
});
test('a sample with no span to place it in is centred in the plot', () => {
  // plotLeft=0, plotRight=800 → the middle of the plot area is 400.
  assert.strictEqual(recalcStub({ data: [42] })._coordForIndex(0, 0).x, 400, 'index axis');
  assert.strictEqual(recalcStub({ data: [42], labels: [1700000000] })._coordForIndex(0, 0).x, 400,
    'one timestamp, no rangeSec');
  // Several samples all stamped at the same instant collapse the span too.
  const same = recalcStub({ data: [1, 2, 3], labels: [5, 5, 5] });
  assert.ok([0, 1, 2].every(i => same._coordForIndex(0, i).x === 400), 'identical labels');
});
test('a single sample inside a rangeSec window sits at the window edge', () => {
  // The live-chart case: one reading in an hour-wide window belongs at "now",
  // not in the middle of a window it has not filled yet.
  const s = recalcStub({ data: [42], labels: [1700000000], rangeSec: 3600 });
  assert.strictEqual(s._useTime, true, 'one timestamp should still be a time domain');
  assert.strictEqual(s._coordForIndex(0, 0).x, 800, 'expected the right edge of the plot');
});
test('the crosshair projection agrees with the centred sample', () => {
  // _recalc centres it and _xPixelForIndex projects it; a disagreement puts the
  // crosshair and the tooltip beside the dot rather than on it.
  const s = recalcStub({ data: [42], labels: [1700000000] });
  assert.strictEqual(s._xPixelForIndex(0), s._coordForIndex(0, 0).x);
});
test('isolated samples between gaps each survive as their own run', () => {
  // An intermittent collector: every third tick reports, the rest are holes.
  const data = Array.from({ length: 9 }, (_, k) => (k % 3 === 0 ? 20 + k : null));
  const s = recalcStub({ data, labels: Array.from({ length: 9 }, (_, k) => k) });
  assert.strictEqual(s._runs[0].length, 3, 'expected one run per surviving sample');
  assert.ok(s._runs[0].every(r => r.length === 1), 'runs should each hold one slot');
  assert.strictEqual(s._cnt[0], 3, 'expected three retained samples');
});

// ── Malformed series (_dataOf) ───────────────────────────────────────────────
// `data` is the one field every render path dereferences, and a series built
// from a failed fetch arrives without it. Reading `.length` off that threw out
// of the constructor and took the whole chart down — including the well-formed
// series beside it.

console.log('\nMalformed series (_dataOf):');
test('a series with no data renders as nothing, never a throw', () => {
  const good = Array.from({ length: 200 }, (_, k) => 10 + k % 50);
  const s = recalcStub({
    yMin: null, yMax: null,          // exercise the autoscale pass, which also reads .data
    series: [
      { label: 'ok', color: '#3fb950', data: good },
      { label: 'no-data', color: '#f778ba' },
      { label: 'null-data', color: '#58a6ff', data: null },
    ],
  });
  assert.strictEqual(s._coordsI[1].length, 0, 'malformed series produced coordinates');
  assert.strictEqual(s._coordsI[2].length, 0, 'null data produced coordinates');
  assert.ok(s._coordsI[0].length > 0, 'the well-formed series was dropped too');
  // Autoscale must have seen only the good series' values, not NaN from the others.
  assert.ok(Number.isFinite(s.yRange.min) && Number.isFinite(s.yRange.max),
    `Y bounds went non-finite: ${JSON.stringify(s.yRange)}`);
});
test('a chart of nothing but malformed series still resolves bounds', () => {
  const s = recalcStub({ yMin: null, yMax: null, series: [{ label: 'x', color: '#fff' }] });
  assert.strictEqual(s._len, 0);
  assert.ok(Number.isFinite(s.yRange.min) && Number.isFinite(s.yRange.max));
});
test('_dataOf hands back the same empty array, not a fresh one per call', () => {
  // It is read on the render path once per series per recalc; allocating there
  // would be churn for the most common malformed case.
  assert.strictEqual(MiniChart._dataOf({}), MiniChart._dataOf(undefined));
  assert.strictEqual(MiniChart._dataOf({ data: 'nope' }).length, 0, 'a string is not samples');
  const real = [1, 2, 3];
  assert.strictEqual(MiniChart._dataOf({ data: real }), real);
  // Typed arrays are a legitimate carrier and must pass through untouched.
  const typed = Float64Array.of(1, 2, 3);
  assert.strictEqual(MiniChart._dataOf({ data: typed }), typed);
});

// ── X projection (_xPixelForIndex) ───────────────────────────────────────────
// The viewport is in label units only when _recalc accepted `labels` as a time
// domain. It rejects labels shorter than the longest series and falls back to
// sample index, leaving the viewport at 0…1 — projecting an epoch timestamp
// through that put the crosshair six orders of magnitude off the plot while the
// hover dots, which come from _coordForIndex, stayed correct.

console.log('\nX projection (_xPixelForIndex):');
test('labels shorter than the data are not a time domain', () => {
  const s = recalcStub({
    data: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    labels: [1700000000, 1700000001, 1700000002, 1700000003, 1700000004],
  });
  assert.strictEqual(s._useTime, false, 'short labels were accepted as a time domain');
  assert.strictEqual(s._xPixelForIndex(3), null,
    'projected a timestamp through an index-based viewport');
  // The fallback the callers use must still land inside the plot.
  const c = s._coordForIndex(0, 3);
  assert.ok(c.x >= 0 && c.x <= 810, 'fallback coordinate off-canvas: ' + c.x);
});
test('a full label array does project, and agrees with the cached coordinate', () => {
  const n = 500;
  const labels = Array.from({ length: n }, (_, k) => 1700000000 + k);
  const data = Array.from({ length: n }, (_, k) => 50 + 40 * Math.sin(k / 30));
  const s = recalcStub({ data, labels });
  assert.strictEqual(s._useTime, true);
  const px = s._xPixelForIndex(250);
  assert.ok(px != null && Math.abs(px - s._coordForIndex(0, 250).x) < 0.5,
    `crosshair ${px} drifted from the dot ${s._coordForIndex(0, 250).x}`);
});

// ── Escaping ─────────────────────────────────────────────────────────────────

console.log('\nHTML escaping (_esc):');
test('escapes every metacharacter', () => {
  assert.strictEqual(MiniChart._esc('<img src=x onerror="a">'),
    '&lt;img src=x onerror=&quot;a&quot;&gt;');
  assert.strictEqual(MiniChart._esc("it's & so"), 'it&#39;s &amp; so');
  assert.strictEqual(MiniChart._esc(null), '');
});

// ── Lifecycle: post-destroy guards & streaming×zoom ──────────────────────────
// After destroy(), every public mutator is a no-op and getXRange() returns null
// rather than throwing or returning stale NaN — a SPA that unmounts mid-flight
// must not crash on a queued call. These run against a bare stub: the _destroyed
// / _streaming guards return before any canvas work, so no DOM is needed.

console.log('\nLifecycle (post-destroy & streaming guards):');
test('update() is a no-op after destroy', () => {
  const s = Object.assign(Object.create(P), { _destroyed: true, opts: { series: [] } });
  s.update({ series: [{ label: 's', data: [1, 2, 3] }] });
  assert.deepStrictEqual(s.opts.series, [], 'destroyed update() mutated opts');
});
test('setXRange() is a no-op after destroy', () => {
  const s = Object.assign(Object.create(P), { _destroyed: true, _viewXMin: 5, _viewXMax: 9 });
  s.setXRange(0, 100);
  assert.strictEqual(s._viewXMin, 5, 'destroyed setXRange() moved the viewport');
});
test('setVisibleSeries() is a no-op after destroy', () => {
  const s = Object.assign(Object.create(P), {
    _destroyed: true, _visibleSeries: [0],
    opts: { series: [{ data: [1] }, { data: [2] }] },
  });
  s.setVisibleSeries([1]);
  assert.deepStrictEqual(s._visibleSeries, [0], 'destroyed setVisibleSeries() changed visibility');
});
test('getXRange() returns null after destroy', () => {
  const s = Object.assign(Object.create(P), { _destroyed: true });
  assert.strictEqual(s.getXRange(), null, 'destroyed getXRange() did not return null');
});
test('setXRange() is a no-op while streaming (zoom cannot fight the window)', () => {
  const s = Object.assign(Object.create(P), {
    _streaming: true, _viewXMin: 5, _viewXMax: 9,
    _dataXMin: 0, _dataXMax: 10,
  });
  const orig = console.warn; console.warn = () => {};   // expect a warning
  s.setXRange(0, 100); console.warn = orig;
  assert.strictEqual(s._viewXMin, 5, 'setXRange() moved the viewport during streaming');
});
test('_draw() returns without throwing after destroy (null ctx/opts)', () => {
  // destroy() nulls ctx and opts. A post-destroy _draw would otherwise
  // dereference null opts (and, via the axis labels, _fmtX/_fmtY). The !ctx
  // guard bails first — covering an internal callback or a wrapper-driven call.
  const s = Object.assign(Object.create(P), { ctx: null, width: 800, height: 200, opts: null });
  P._draw.call(s);
  assert.ok(true, '_draw() threw on a destroyed instance');
});
test('_scheduleHover() does not arm a frame after destroy', () => {
  // A wrapper-driven call after teardown would arm an rAF that destroy() (which
  // already ran) cannot cancel. The _destroyed guard must bail before scheduling.
  const s = Object.assign(Object.create(P), { _destroyed: true, _hoverRaf: 0 });
  let scheduled = false;
  const orig = global.requestAnimationFrame;
  global.requestAnimationFrame = () => { scheduled = true; return 1; };
  try { P._scheduleHover.call(s); } finally { global.requestAnimationFrame = orig; }
  assert.strictEqual(scheduled, false, 'destroyed _scheduleHover() armed a never-cancelled frame');
  assert.strictEqual(s._hoverRaf, 0, 'destroyed _scheduleHover() set _hoverRaf');
});

// ── Streaming Y-range: opts.yMin/yMax honoured on the push() path ──────────
// _streamRebuild used to derive Y bounds purely from the per-column buckets and
// ignore caller-pinned yMin/yMax, so a streaming chart always autoscaled even
// when the caller fixed the axis. These drive the REAL _streamRebuild headless
// against a hand-seeded bucket ring; _draw() is stubbed (it needs a canvas) and
// _userPadLeft is pinned (skips the measureText gutter block) — yRange is set
// before either is reached, so the assertions see the real computed bounds.

/** Headless stand-in carrying just enough bucket state for _streamRebuild. */
function streamStub({ yMin = 0, yMax = null, cols = 4, series = 1 } = {}) {
  const streams = [];
  for (let i = 0; i < series; i++) {
    streams.push({
      vMin: new Float64Array(cols).fill(Infinity),
      vMax: new Float64Array(cols).fill(-Infinity),
      cnt: new Int32Array(cols),
    });
  }
  return Object.assign(Object.create(P), {
    width: 810, height: 300,
    _stream: { cols, head: 0 },
    _streams: streams,
    _activeSet: null,
    _userPadLeft: 38,          // pin gutter → skip the ctx.measureText branch
    _draw: () => {},           // headless: yRange is assigned before _draw() runs
    opts: {
      yMin, yMax, padding: { top: 12, right: 10, bottom: 22, left: 38 },
      series: Array.from({ length: series }, () => ({})),
    },
  });
}
/** Drop one value into series `si`, column `col`, mirroring _streamSample. */
function put(s, si, col, v) {
  const bk = s._streams[si];
  if (bk.cnt[col] === 0) { bk.vMin[col] = v; bk.vMax[col] = v; }
  else { if (v < bk.vMin[col]) bk.vMin[col] = v; if (v > bk.vMax[col]) bk.vMax[col] = v; }
  bk.cnt[col]++;
}

console.log('\nStreaming Y-range (pinned yMin/yMax):');
test('streaming honours both pinned ends (the bug)', () => {
  const s = streamStub({ yMin: 0, yMax: 100 });
  put(s, 0, 0, 60);                      // single reading at 60
  s._streamRebuild();
  assert.strictEqual(s.yRange.min, 0, `pinned yMin:0 lost -> ${s.yRange.min}`);
  assert.strictEqual(s.yRange.max, 100, `pinned yMax:100 lost -> ${s.yRange.max}`);
});
test('streaming honours a single pinned end (yMin:0, auto max)', () => {
  const s = streamStub({ yMin: 0, yMax: null });
  put(s, 0, 0, 10); put(s, 0, 1, 60);    // data 10..60
  s._streamRebuild();
  assert.strictEqual(s.yRange.min, 0, `pinned yMin:0 lost -> ${s.yRange.min}`);
  assert.ok(s.yRange.max > 60 && s.yRange.max < 100,
    `auto max should pad above 60, got ${s.yRange.max}`);   // 60 + span*0.1 = 65
});
test('streaming autoscale (both null) is unchanged: 10..60 -> ~5..65', () => {
  const s = streamStub({ yMin: null, yMax: null });
  put(s, 0, 0, 10); put(s, 0, 1, 60);
  s._streamRebuild();
  assert.strictEqual(s.yRange.min, 5, `auto min regressed -> ${s.yRange.min}`);
  assert.strictEqual(s.yRange.max, 65, `auto max regressed -> ${s.yRange.max}`);
});
test('streaming relaxes a pinned end the data outgrows (no axis inversion)', () => {
  const s = streamStub({ yMin: 200, yMax: null });   // pinned min above all data
  put(s, 0, 0, 10); put(s, 0, 1, 60);
  s._streamRebuild();
  assert.ok(s.yRange.min < s.yRange.max, `inverted/flat range: ${JSON.stringify(s.yRange)}`);
  assert.ok(s.yRange.min <= 10, `un-relaxed pinned min: ${s.yRange.min}`);
});

// ── Streaming gaps advance the window (a null tick still scrolls time) ─────
// _streamSample used to guard `if (!Number.isFinite(v)) return;` BEFORE the
// window-advance block, so a null tick (a real moment with no reading) left the
// viewport pinned to the last finite sample while labels kept flowing — a
// sustained dropout froze the chart and desynced the bucket ring from the source
// arrays. The fix advances on the timestamp first; these drive the REAL
// _streamSample headless against a hand-seeded window + bucket ring.

/** Window + bucket ring exactly as _streamEnsure/_seedSeries produce, no canvas. */
function winStub(cols = 10, winStart = 0, winSpan = 100) {
  const winEnd = winStart + winSpan;
  const w = { cols, head: 0, winStart, winEnd, winSpan, colDt: winSpan / cols, cap: 1000 };
  const bk = {
    vMin: new Float64Array(cols).fill(Infinity),
    vMax: new Float64Array(cols).fill(-Infinity),
    cnt: new Int32Array(cols),
  };
  return Object.assign(Object.create(P), {
    _stream: w, _streams: [bk],
    _viewXMin: winStart, _viewXMax: winEnd, _tMin: winStart, _tMax: winEnd,
    opts: { series: [{}] },
  });
}

console.log('\nStreaming gaps advance the window:');
test('gap tick scrolls the window (full-reset branch, large jump)', () => {
  const s = winStub();                       // window [0,100), colDt 10
  const w = s._stream, bk = s._streams[0];
  P._streamSample.call(s, 0, 50, 5);         // prime a finite sample mid-window
  const winEndBefore = w.winEnd;
  P._streamSample.call(s, 0, 200, null);     // a gap a full window later
  assert.ok(w.winEnd > winEndBefore, 'gap did not scroll: winEnd stayed ' + w.winEnd);
  assert.ok(w.winEnd >= 200, 'window did not reach the gap timestamp (winEnd=' + w.winEnd + ')');
  assert.strictEqual(s._viewXMax, w.winEnd, '_viewXMax not synced with the window');
  let populated = 0; for (let i = 0; i < w.cols; i++) if (bk.cnt[i]) populated++;
  assert.strictEqual(populated, 0, 'stale buckets survived the gap scroll');
});
test('gap tick scrolls one column (small-advance branch) and leaves the gap column empty', () => {
  const s = winStub();
  const w = s._stream, bk = s._streams[0];
  P._streamSample.call(s, 0, 95, 7);         // finite sample near the right edge
  P._streamSample.call(s, 0, 105, null);     // gap one column past winEnd
  assert.ok(w.winEnd > 100, 'small gap did not scroll (winEnd=' + w.winEnd + ')');
  const c = Math.floor((105 - w.winStart) / w.colDt);
  const idx = (w.head + c) % w.cols;
  assert.strictEqual(bk.cnt[idx], 0, 'the gap column got populated');
});
test('a run of gap ticks keeps scrolling instead of freezing', () => {
  const s = winStub();
  const w = s._stream;
  P._streamSample.call(s, 0, 50, 5);
  for (let t = 110; t <= 200; t += 10) P._streamSample.call(s, 0, t, null);
  assert.ok(w.winEnd >= 200, 'sustained gaps froze the window at winEnd=' + w.winEnd);
});
test('a non-finite timestamp never corrupts the window', () => {
  const s = winStub();
  const w = s._stream;
  const before = w.winEnd;
  P._streamSample.call(s, 0, NaN, null);
  P._streamSample.call(s, 0, Infinity, 9);
  assert.strictEqual(w.winEnd, before, 'NaN/Infinity timestamp moved the window');
  assert.ok(Number.isFinite(w.winStart), 'winStart became non-finite');
});

// ── _streamEvict window-aware trimming (no ghost buckets) ──────────────────
// _streamEvict used to splice a fixed ~10% prefix of labels/data once
// labels.length > cap. But the bucket ring forgets by TIME (a column resets
// only when _streamSample scrolls the window), while cap is a SAMPLE-COUNT
// budget. In a dense stream (>=2 samples/column — exactly the case the streaming
// path exists for) the spliced prefix was still on-screen, so its min/max lived
// on in the buckets as a band the source arrays no longer held: the envelope,
// the autoscale and hover desynced from the data, and a resize re-seed collapsed
// the plot's left. The fix trims only rows the window already scrolled past
// (labels[i] < winStart); bars/batch (no _streams) keep the unconditional trim.

/** Streaming stub with real labels + per-series data, ready for _streamEvict. */
function evictStub({ cols = 10, winStart = 0, winSpan = 100, cap = 5,
                     labels = [0, 1, 2, 3, 4, 5], series = [{ data: [0, 1, 2, 3, 4, 5] }] } = {}) {
  const winEnd = winStart + winSpan;
  const streams = series.map(() => ({
    vMin: new Float64Array(cols).fill(Infinity),
    vMax: new Float64Array(cols).fill(-Infinity),
    cnt: new Int32Array(cols),
  }));
  return Object.assign(Object.create(P), {
    _stream: { cols, head: 0, winStart, winEnd, winSpan, colDt: winSpan / cols, cap },
    _streams: streams, _viewXMin: winStart, _viewXMax: winEnd, _tMin: winStart, _tMax: winEnd,
    _hoverIdx: -1, _tooltip: null,
    opts: {
      labels: labels.slice(),
      series: series.map(s => {
        const out = { data: s.data.slice() };
        if (s.notes) out.notes = s.notes.slice();
        return out;
      }),
    },
  });
}

console.log('\n_streamEvict window-aware trimming:');
test('dense in-window samples are NOT evicted (no ghost bucket)', () => {
  // 6 samples all in window [0,100]; cap=5 arms eviction, but nothing is
  // off-window yet, so trimming would leave bucket col0 (cnt=6) describing a
  // sample absent from data. Skip instead — buckets and source stay consistent.
  const s = evictStub({ cap: 5 });
  const bk = s._streams[0];
  for (let t = 0; t <= 5; t++) P._streamSample.call(s, 0, t, t);   // all land in column 0
  assert.strictEqual(bk.cnt[0], 6, 'precondition: 6 samples bucketed in col 0');
  P._streamEvict.call(s, 5);
  assert.strictEqual(s.opts.labels.length, 6, 'in-window samples were evicted (would ghost the buckets)');
  assert.strictEqual(s.opts.series[0].data.length, 6, 'data was trimmed while still on-screen');
  assert.strictEqual(bk.cnt[0], s.opts.series[0].data.length,
    'bucket cnt disagrees with surviving data — a ghost band');
});
test('only off-window rows are evicted once the window scrolls', () => {
  const s = evictStub({ cap: 5, labels: [0, 1, 2, 3, 4, 5, 105], series: [{ data: [0, 1, 2, 3, 4, 5, 105] }] });
  for (const t of [0, 1, 2, 3, 4, 5]) P._streamSample.call(s, 0, t, t);
  P._streamSample.call(s, 0, 105, 105);   // scrolls the window: winStart 0 -> 10
  assert.ok(s.opts.labels[0] < s._stream.winStart, 'precondition: the oldest sample scrolled off-window');
  P._streamEvict.call(s, 5);              // drop=1; offWin=1 -> trim only t=0
  assert.deepStrictEqual(s.opts.labels, [1, 2, 3, 4, 5, 105], 'an in-window row was trimmed');
  assert.deepStrictEqual(s.opts.series[0].data, [1, 2, 3, 4, 5, 105], 'data lost row alignment with labels');
});
test('_hoverIdx shifts by the number of off-window rows evicted', () => {
  const s = evictStub({ cap: 50, labels: [0, 1, 2, 3, 4, 5, 105], series: [{ data: [0, 1, 2, 3, 4, 5, 105] }] });
  for (const t of [0, 1, 2, 3, 4, 5]) P._streamSample.call(s, 0, t, t);
  P._streamSample.call(s, 0, 105, 105);   // winStart -> 10
  s._hoverIdx = 5;                         // hovering labels[5] = 5
  P._streamEvict.call(s, 50);             // drop=5; offWin=min(5,6)=5 -> trim t=0..4
  assert.deepStrictEqual(s.opts.labels, [5, 105], '5 off-window rows should have been trimmed');
  assert.strictEqual(s._hoverIdx, 0, 'hover did not shift left by the 5 evicted rows (now labels[0]=5)');
});
// The bucket ring caches the cap it was seeded with and is only re-seeded on a
// resize or a viewport move, so `update({ maxSamples })` used to be accepted
// into opts and then silently ignored for the life of the stream. The streaming
// dashboard worked around it by writing chart._stream.cap directly — a private
// field the minified build mangles, so the control did nothing in production.
test('update({ maxSamples }) retargets the live ring and evicts at once', () => {
  const s = evictStub({ cap: 5000, labels: [0, 1, 2, 3, 4, 5, 105], series: [{ data: [0, 1, 2, 3, 4, 5, 105] }] });
  for (const t of [0, 1, 2, 3, 4, 5]) P._streamSample.call(s, 0, t, t);
  P._streamSample.call(s, 0, 105, 105);   // winStart 0 -> 10; t=0..5 are now off-window
  s._boundsDirty = false; s._visibleSeries = null; s._legendEl = null;
  s._refresh = () => {};                  // isolate: no canvas behind this stub
  s._syncLegend = () => {};
  P.update.call(s, { maxSamples: 2 });
  assert.strictEqual(s._stream.cap, 2, 'the live ring kept the cap it was seeded with');
  assert.ok(s.opts.labels.length < 7, 'lowering the cap did not free the off-window rows');
});
test('update({ maxSamples }) leaves in-window rows alone', () => {
  // Same window-awareness as _streamEvict itself: a cap below what the window
  // holds must not trim on-screen rows, or the buckets ghost a band the source
  // arrays no longer have.
  const s = evictStub({ cap: 5000 });
  for (let t = 0; t <= 5; t++) P._streamSample.call(s, 0, t, t);   // all in window
  s._boundsDirty = false; s._visibleSeries = null; s._legendEl = null;
  s._refresh = () => {};
  s._syncLegend = () => {};
  P.update.call(s, { maxSamples: 2 });
  assert.strictEqual(s.opts.labels.length, 6, 'in-window rows were evicted by a cap change');
});
test('bar/batch path (no _streams) keeps the unconditional front-trim', () => {
  const s = Object.assign(Object.create(P), {
    _stream: null, _streams: null, _hoverIdx: -1, _tooltip: null,
    opts: { labels: [0, 1, 2, 3, 4, 5], series: [{ data: [10, 11, 12, 13, 14, 15] }] },
  });
  P._streamEvict.call(s, 5);              // drop=1, no window guard applies
  assert.deepStrictEqual(s.opts.labels, [1, 2, 3, 4, 5], 'bar path did not front-trim labels');
  assert.deepStrictEqual(s.opts.series[0].data, [11, 12, 13, 14, 15], 'bar path did not front-trim data');
});
test('eviction keeps series.notes aligned with data (the bug)', () => {
  // notes is index-aligned with data (the tooltip reads notes[idx] for data
  // idx). Eviction used to trim data but not notes, so afterwards notes[idx]
  // described the sample drop positions to the right — the tooltip pinned the
  // annotation to the wrong point.
  const s = evictStub({
    cap: 50,
    labels: [0, 1, 2, 3, 4, 5, 105],
    series: [{ data: [0, 1, 2, 3, 4, 5, 105], notes: ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n105'] }],
  });
  for (const t of [0, 1, 2, 3, 4, 5]) P._streamSample.call(s, 0, t, t);
  P._streamSample.call(s, 0, 105, 105);   // winStart -> 10
  P._streamEvict.call(s, 50);             // drop=5; offWin=5 -> trim t=0..4
  assert.deepStrictEqual(s.opts.series[0].data, [5, 105], 'precondition: data trimmed by 5');
  assert.deepStrictEqual(s.opts.series[0].notes, ['n5', 'n105'],
    'notes were not trimmed with data — tooltip annotation is now misaligned');
});

// ── push() index alignment (labels[i] ≡ every series' data[i]) ─────────────
// push() used to append to one series' data while adding a label only on a new
// timestamp, so a series pushed at a different cadence desynced from its peers
// and its value attached to the wrong timestamp. The fix resolves the target row
// and pads the other series with gaps. These drive the REAL push() headless: the
// canvas-needing streaming internals (_streamEnsure/_streamSample/_streamRebuild)
// are stubbed so only the placement preamble runs.

console.log('\npush() index alignment:');
test('async multi-series push keeps labels[i] ≡ data[i] (the bug)', () => {
  const s = Object.assign(Object.create(P), {
    ctx: {}, _destroyed: false, _streaming: false, _stream: { cap: 0 },
    opts: {
      series: [
        { label: 'A', color: '#f00', data: [] },
        { label: 'B', color: '#0f0', data: [] },
      ],
      labels: [],
    },
    _streamEnsure() {}, _streamSample() {}, _streamRebuild() {},
  });
  P.push.call(s, 10, 100, 0);   // A@100
  P.push.call(s, 20, 101, 0);   // A@101
  P.push.call(s, 99, 101, 1);   // B@101 — B skipped 100
  assert.deepStrictEqual(s.opts.labels, [100, 101], 'labels');
  assert.deepStrictEqual(s.opts.series[0].data, [10, 20], 'A stayed aligned');
  assert.deepStrictEqual(s.opts.series[1].data, [null, 99],
    'B padded with a gap at 100 and placed at 101 (was [99] under label 100)');
  for (const ser of s.opts.series)
    assert.strictEqual(ser.data.length, s.opts.labels.length, 'a series is not row-aligned with labels');
});
test('single-series sequential pushes are unchanged (no spurious padding)', () => {
  const s = Object.assign(Object.create(P), {
    ctx: {}, _destroyed: false, _streaming: false, _stream: { cap: 0 },
    opts: { series: [{ label: 'A', color: '#f00', data: [] }], labels: [] },
    _streamEnsure() {}, _streamSample() {}, _streamRebuild() {},
  });
  P.push.call(s, 5, 0); P.push.call(s, 6, 1); P.push.call(s, 7, 2);
  assert.deepStrictEqual(s.opts.labels, [0, 1, 2], 'labels');
  assert.deepStrictEqual(s.opts.series[0].data, [5, 6, 7], 'data — no gap padding on a lone series');
});
test('a same-tick second series overwrites the gap row, not a new row', () => {
  const s = Object.assign(Object.create(P), {
    ctx: {}, _destroyed: false, _streaming: false, _stream: { cap: 0 },
    opts: {
      series: [{ label: 'A', color: '#f00', data: [] }, { label: 'B', color: '#0f0', data: [] }],
      labels: [],
    },
    _streamEnsure() {}, _streamSample() {}, _streamRebuild() {},
  });
  P.push.call(s, 1, 7, 0);   // A@7 → labels [7], A [1], B padded [null]
  P.push.call(s, 2, 7, 1);   // B@7 → same tick: overwrite B[0]
  assert.deepStrictEqual(s.opts.labels, [7], 'a duplicate label was added for the same tick');
  assert.deepStrictEqual(s.opts.series[0].data, [1], 'A');
  assert.deepStrictEqual(s.opts.series[1].data, [2], 'B did not overwrite its gap row with the real value');
});
test('an array push is one frame → one rebuild (not one per series)', () => {
  let rebuilds = 0;
  const s = Object.assign(Object.create(P), {
    ctx: {}, _destroyed: false, _streaming: false, _stream: { cap: 0 },
    opts: {
      series: [
        { label: 'A', color: '#f00', data: [] },
        { label: 'B', color: '#0f0', data: [] },
        { label: 'C', color: '#00f', data: [] },
      ],
      labels: [],
    },
    _streamEnsure() {}, _streamSample() {},
    _streamRebuild() { rebuilds++; },   // headless: count instead of painting
  });
  P.push.call(s, [10, 20, 30], 100);   // one frame, three series
  assert.strictEqual(rebuilds, 1, 'a frame rebuilt ' + rebuilds + ' times (expected 1)');
  assert.deepStrictEqual(s.opts.labels, [100], 'one label for the whole frame');
  assert.deepStrictEqual(s.opts.series[0].data, [10], 'A');
  assert.deepStrictEqual(s.opts.series[1].data, [20], 'B');
  assert.deepStrictEqual(s.opts.series[2].data, [30], 'C');
  for (const ser of s.opts.series)
    assert.strictEqual(ser.data.length, 1, 'a series did not get exactly one row');
});
test('a frame shorter than the series list gaps the missing series', () => {
  const s = Object.assign(Object.create(P), {
    ctx: {}, _destroyed: false, _streaming: false, _stream: { cap: 0 },
    opts: {
      series: [
        { label: 'A', color: '#f00', data: [] },
        { label: 'B', color: '#0f0', data: [] },
      ],
      labels: [],
    },
    _streamEnsure() {}, _streamSample() {}, _streamRebuild() {},
  });
  P.push.call(s, [10], 100);           // only A has a value; B is missing this tick
  assert.deepStrictEqual(s.opts.series[0].data, [10], 'A');
  assert.deepStrictEqual(s.opts.series[1].data, [null], 'B should get a gap row');
});

// ── Legend reconcile after update() (_syncLegend) ───────────────────────────
// update() used to ignore `legend` and `theme.legendText`: toggling the legend
// off left a stale element, toggling it on never created one, and a theme change
// left the container colour baked into cssText at build time. _syncLegend is the
// reconciler. These drive the REAL _setupLegend/_syncLegend headless against a
// minimal DOM stub (the file already stubs global.Path2D; document is stubbed
// here for this section only, since no other test touches the DOM).

function fakeEl() {
  return {
    removed: false, style: {}, className: '', innerHTML: '', dataset: {},
    querySelectorAll() { return []; }, remove() { this.removed = true; },
  };
}
global.document = global.document || { createElement: () => fakeEl() };

function legendStub({ legend = true, legendText = '#8b949e' } = {}) {
  const parent = { inserted: [], insertBefore(el) { this.inserted.push(el); } };
  return Object.assign(Object.create(P), {
    canvas: { parentElement: parent },
    _legendEl: null,
    opts: {
      legend,
      series: [{ label: 'A', color: '#ff0000', data: [1] }],
      theme: { legendText },
    },
    _hexA: (h) => h,   // _updateLegend calls _hexA(color,1); pass-through is enough
  });
}

console.log('\nLegend reconcile after update():');
test('update({legend:false}) removes an already-built legend', () => {
  const s = legendStub({ legend: true });
  P._setupLegend.call(s);
  assert.ok(s._legendEl, 'legend should be created at build');
  s.opts.legend = false;            // simulate update()'s opts merge
  P._syncLegend.call(s);
  assert.strictEqual(s._legendEl, null, 'legend element not nulled');
});
test('update({legend:true}) creates a legend after build', () => {
  const s = legendStub({ legend: false });
  P._setupLegend.call(s);
  assert.strictEqual(s._legendEl, null, 'a legend was built despite legend:false');
  s.opts.legend = true;
  P._syncLegend.call(s);
  assert.ok(s._legendEl, 'legend not created on toggle-on');
});
test('update({theme:{legendText}}) recolours the existing legend', () => {
  const s = legendStub({ legend: true, legendText: '#8b949e' });
  P._setupLegend.call(s);
  assert.ok(/#8b949e/.test(s._legendEl.style.cssText), 'initial colour not baked into cssText');
  s.opts.theme.legendText = '#00ff00';
  P._syncLegend.call(s);
  assert.strictEqual(s._legendEl.style.color, '#00ff00', 'container colour not updated');
});
test('legend off-then-on recreates a fresh element', () => {
  const s = legendStub({ legend: true });
  P._setupLegend.call(s);
  const first = s._legendEl;
  s.opts.legend = false; P._syncLegend.call(s);
  assert.strictEqual(s._legendEl, null);
  s.opts.legend = true;  P._syncLegend.call(s);
  assert.ok(s._legendEl && s._legendEl !== first, 'off-then-on did not recreate the element');
});
test('_syncLegend is a no-op when legend stays true and theme is unchanged', () => {
  const s = legendStub({ legend: true, legendText: '#8b949e' });
  P._setupLegend.call(s);
  const el = s._legendEl;
  P._syncLegend.call(s);
  assert.strictEqual(s._legendEl, el, 'a no-op syncLegend replaced the element');
  assert.strictEqual(el.removed, false, 'a no-op syncLegend removed the element');
});

// ── push() frame & re-push edge cases (review findings) ────────────────────
// Two review findings the green suite missed — every push/frame unit test stubbed
// the streaming internals and pre-seeded _stream, so the real null-path and the
// bucket-accumulate path were never exercised. Driven here against the real code.

console.log('\npush() frame & re-push edge cases:');
test('push([...]) is a safe no-op on a chart with no data-bearing series', () => {
  const noSeries = Object.assign(Object.create(P), {
    ctx: {}, _destroyed: false, _streaming: false, _streamRebuild() {},
    opts: { series: [], labels: [] },
  });
  P.push.call(noSeries, [5], 100);                 // no series → no crash, no dangling label
  assert.deepStrictEqual(noSeries.opts.labels, [], 'a label was left with no data behind it');
  const dataLess = Object.assign(Object.create(P), {
    ctx: {}, _destroyed: false, _streaming: false, _streamRebuild() {},
    opts: { series: [{ label: 'A' }, { label: 'B' }], labels: [] },  // neither has a data array
  });
  P.push.call(dataLess, [1, 2], 100);
  assert.deepStrictEqual(dataLess.opts.labels, [], 'a label was left when no series can receive a row');
});
test('_streamSample replaces (not accumulates) on a same-tick re-push', () => {
  const s = winStub();                              // window [0,100), colDt 10
  const w = s._stream, bk = s._streams[0];
  P._streamSample.call(s, 0, 50, 10, false);        // first reading at t=50
  P._streamSample.call(s, 0, 50, 20, true);         // corrected reading, same tick → reset
  const c = Math.floor((50 - w.winStart) / w.colDt);
  const idx = (w.head + c) % w.cols;
  assert.strictEqual(bk.cnt[idx], 1, 'the column accumulated instead of resetting');
  assert.strictEqual(bk.vMin[idx], 20, 'the superseded min survived the correction');
  assert.strictEqual(bk.vMax[idx], 20, 'the superseded max survived the correction');
});
test('_streamSample clears the column on a same-tick re-push of a gap', () => {
  const s = winStub();
  const w = s._stream, bk = s._streams[0];
  P._streamSample.call(s, 0, 50, 10, false);    // a finite reading
  P._streamSample.call(s, 0, 50, null, true);   // same tick, now a gap → erase it
  const c = Math.floor((50 - w.winStart) / w.colDt);
  const idx = (w.head + c) % w.cols;
  assert.strictEqual(bk.cnt[idx], 0, 'the superseded finite value survived a gap re-push');
});
test('push() signals the same-tick reset to _streamSample', () => {
  let resetSeen;
  const s = Object.assign(Object.create(P), {
    ctx: {}, _destroyed: false, _streaming: true, _stream: { cap: 0 },
    opts: { series: [{ label: 'A', color: '#f00', data: [10] }], labels: [100] },
    _streamEnsure() {},
    _streamSample(si, t, v, reset) { resetSeen = reset; },
    _streamRebuild() {},
  });
  P.push.call(s, 20, 100, 0);                      // 100 === labels[last] → same tick
  assert.strictEqual(resetSeen, true, 'a same-tick re-push did not signal reset');
  P.push.call(s, 30, 101, 0);                      // new tick
  assert.strictEqual(resetSeen, false, 'a new-tick push signalled reset');
});

// ── Labels contract validation (opt-in opts.validate) ─────────────────────
// The labels/data contract (ascending, finite, index-aligned) used to fail
// silently as a wrong-shaped chart. opts.validate turns it into an early throw
// in dev. _validateLabels is the full O(n) check (_refresh / update); push() has
// an O(1) tail that checks only the incoming label. These drive both headless.

function validateStub({ labels = null, seriesData = [[1, 2, 3]] } = {}) {
  return Object.assign(Object.create(P), {
    opts: { labels, series: seriesData.map(d => ({ label: 's', data: d })) },
  });
}

console.log('\nLabels contract validation (opts.validate):');
test('_validateLabels is a no-op on an index axis (no labels)', () => {
  P._validateLabels.call(validateStub({ labels: null }));   // must not throw
});
test('_validateLabels passes sorted, finite, aligned labels', () => {
  P._validateLabels.call(validateStub({ labels: [10, 20, 30], seriesData: [[1, 2, 3], [4, 5, 6]] }));
});
test('_validateLabels tolerates equal consecutive labels', () => {
  P._validateLabels.call(validateStub({ labels: [10, 10, 20], seriesData: [[1, 2, 3]] }));
});
test('_validateLabels skips an empty series (no false positive)', () => {
  P._validateLabels.call(validateStub({ labels: [10, 20], seriesData: [[1, 2], []] }));
});
test('_validateLabels throws on descending labels', () => {
  const s = validateStub({ labels: [10, 5, 20], seriesData: [[1, 2, 3]] });
  assert.throws(() => P._validateLabels.call(s), /ascending/);
});
test('_validateLabels throws on a non-finite label', () => {
  const s = validateStub({ labels: [10, NaN, 20], seriesData: [[1, 2, 3]] });
  assert.throws(() => P._validateLabels.call(s), /finite/);
});
test('_validateLabels throws on a mis-aligned series', () => {
  const s = validateStub({ labels: [10, 20, 30], seriesData: [[1, 2]] });
  assert.throws(() => P._validateLabels.call(s), /samples/);
});
test('push() with validate throws on a backwards label before mutating anything', () => {
  const s = Object.assign(Object.create(P), {
    ctx: {}, _destroyed: false, _streaming: false, _stream: { cap: 0 },
    opts: { validate: true, series: [{ label: 'A', color: '#f00', data: [5] }], labels: [100] },
    _streamEnsure() {}, _streamSample() {}, _streamRebuild() {},
  });
  assert.throws(() => P.push.call(s, 9, 50, 0), /predates|ascending/);
  assert.deepStrictEqual(s.opts.labels, [100], 'labels were mutated before validation threw');
  assert.deepStrictEqual(s.opts.series[0].data, [5], 'data were mutated before validation threw');
});
test('push() with validate throws on a non-finite label', () => {
  const s = Object.assign(Object.create(P), {
    ctx: {}, _destroyed: false, _streaming: false, _stream: { cap: 0 },
    opts: { validate: true, series: [{ label: 'A', color: '#f00', data: [5] }], labels: [100] },
    _streamEnsure() {}, _streamSample() {}, _streamRebuild() {},
  });
  assert.throws(() => P.push.call(s, 9, Infinity, 0), /finite/);
});
test('push() without validate accepts the same bad input silently', () => {
  const s = Object.assign(Object.create(P), {
    ctx: {}, _destroyed: false, _streaming: false, _stream: { cap: 0 },
    opts: { series: [{ label: 'A', color: '#f00', data: [5] }], labels: [100] },
    _streamEnsure() {}, _streamSample() {}, _streamRebuild() {},
  });
  P.push.call(s, 9, 50, 0);   // backwards label, no validate → no throw
  assert.deepStrictEqual(s.opts.labels, [100, 50], 'the bad label was not placed at all');
});

// ── Tooltip skips non-finite samples like the renderer ──────────────────────
// _showTooltip/_announcePoint used to guard only `v == null`, so a NaN/Infinity
// sample (a gap the renderer does not draw) still reached _fmtY and leaked into
// the tooltip HTML and the a11y announcement. The guard now matches the
// renderer's gap predicate. _showTooltip's positioning math is stubbed away; the
// assertion is on the built innerHTML, set before any of it runs.

console.log('\nTooltip skips non-finite samples:');
test('_showTooltip omits NaN/Infinity samples but keeps finite ones', () => {
  global.window = global.window || {};
  global.window.innerWidth = 1000;
  const self = Object.assign(Object.create(P), {
    opts: {
      series: [
        { label: 'A', color: '#f00', data: [NaN] },
        { label: 'B', color: '#0f0', data: [Infinity] },
        { label: 'C', color: '#00f', data: [42] },
      ],
      yUnit: '', theme: { axisLabel: '#888' },
    },
    _visibleSeries: null,
    _fmtX: () => 'T',
    _hexA: (h) => h,
    _xPixelForIndex: () => null,
    _refSeriesIndex: () => -1,
    _coordForIndex: () => null,
    _tooltip: { innerHTML: '', style: {}, offsetWidth: 40, offsetHeight: 20 },
  });
  P._showTooltip.call(self, 0, { left: 100, top: 100 });
  const html = self._tooltip.innerHTML;
  assert.ok(!/NaN|Infinity/.test(html), 'a non-finite value leaked into the tooltip: ' + html);
  assert.ok(/42/.test(html), 'the finite value is missing from the tooltip: ' + html);
});

// ── Tooltip hideZero + 'outside' positioning ────────────────────────────────
// On a dashboard of many containers most series read 0 at any instant, so the
// tooltip buried the one active reading under noise (Bug 1), and a tall tooltip
// rendered over the plot it was inspecting (Bug 2). opts.tooltip.hideZero drops
// the zero rows; opts.tooltip.position 'outside' places the box off the plot
// rectangle (Grafana-style) instead of anchoring on the sample.

console.log('\nTooltip hideZero + positioning:');
test('_showTooltip hides zero-value series when tooltip.hideZero is on (Bug 1)', () => {
  global.window = global.window || {};
  global.window.innerWidth = 1000; global.window.innerHeight = 800;
  const mk = (tooltip) => Object.assign(Object.create(P), {
    opts: {
      series: [
        { label: 'filebrowser', color: '#f00', data: [0] },
        { label: 'transmission', color: '#0f0', data: [137] },
        { label: 'home-ui', color: '#00f', data: [0] },
      ],
      yUnit: '', theme: { axisLabel: '#888' }, tooltip,
    },
    _visibleSeries: null,
    _fmtX: () => 'T', _fmtY: (v) => String(v), _hexA: (h) => h,
    _xPixelForIndex: () => null, _refSeriesIndex: () => -1, _coordForIndex: () => null,
    width: 400, height: 200,
    _tooltip: { innerHTML: '', style: {}, offsetWidth: 40, offsetHeight: 20 },
  });
  const on = mk({ hideZero: true, position: 'auto' });
  P._showTooltip.call(on, 0, { left: 100, top: 100 });
  assert.ok(/transmission/.test(on._tooltip.innerHTML), 'the active series is missing');
  assert.ok(!/filebrowser/.test(on._tooltip.innerHTML),
    'a zero-value series appeared with hideZero on: ' + on._tooltip.innerHTML);
  const off = mk({ hideZero: false, position: 'auto' });
  P._showTooltip.call(off, 0, { left: 100, top: 100 });
  assert.ok(/filebrowser/.test(off._tooltip.innerHTML),
    'a zero-value series was hidden with hideZero off: ' + off._tooltip.innerHTML);
});
test("_showTooltip 'outside' places the tooltip off the plot rectangle (Bug 2)", () => {
  global.window = global.window || {};
  global.window.innerWidth = 1200; global.window.innerHeight = 800;
  // Canvas rect at (50,50), 600 wide; plot right edge = 50 + (600 - 10) = 640.
  // tooltip width 80 fits to the right (640 + 8 + 80 = 728 <= 1200).
  const s = Object.assign(Object.create(P), {
    opts: {
      series: [{ label: 'A', color: '#f00', data: [5] }],
      yUnit: '', theme: { axisLabel: '#888' },
      padding: { top: 12, right: 10, bottom: 22, left: 38 },
      tooltip: { hideZero: false, position: 'outside' },
    },
    _visibleSeries: null,
    _fmtX: () => 'T', _fmtY: (v) => String(v), _hexA: (h) => h,
    _xPixelForIndex: () => 300, _refSeriesIndex: () => 0, _coordForIndex: () => ({ x: 300, y: 100 }),
    width: 600, height: 200,
    _tooltip: { innerHTML: '', style: {}, offsetWidth: 80, offsetHeight: 60 },
  });
  P._showTooltip.call(s, 0, { left: 50, top: 50 });
  const plotR = 50 + (600 - 10);   // 640
  const outsideLeft = parseInt(s._tooltip.style.left, 10);
  assert.ok(outsideLeft >= plotR,
    "'outside' placed the tooltip over the plot (left=" + outsideLeft + ' < plotR=' + plotR + ')');
  // 'auto' on the same setup centers near the sample (hx = 50 + 300 = 350) — well left of plotR.
  s.opts.tooltip.position = 'auto';
  P._showTooltip.call(s, 0, { left: 50, top: 50 });
  const autoLeft = parseInt(s._tooltip.style.left, 10);
  assert.ok(autoLeft < plotR, "'auto' did not anchor near the sample (left=" + autoLeft + ')');
});
test("_showTooltip 'outside' falls back to 'auto' when no side of the plot fits", () => {
  global.window = global.window || {};
  // Tiny viewport with a chart that fills it: right/left/above/below of the plot
  // all fail, so 'outside' must degrade to the 'auto' anchor (the riskiest branch).
  global.window.innerWidth = 300; global.window.innerHeight = 300;
  const s = Object.assign(Object.create(P), {
    opts: {
      series: [{ label: 'A', color: '#f00', data: [5] }],
      yUnit: '', theme: { axisLabel: '#888' },
      padding: { top: 12, right: 5, bottom: 12, left: 5 },
      tooltip: { hideZero: false, position: 'outside' },
    },
    _visibleSeries: null,
    _fmtX: () => 'T', _fmtY: (v) => String(v), _hexA: (h) => h,
    _xPixelForIndex: () => 140, _refSeriesIndex: () => 0, _coordForIndex: () => ({ x: 140, y: 150 }),
    width: 290, height: 290,
    _tooltip: { innerHTML: '', style: {}, offsetWidth: 200, offsetHeight: 200 },
  });
  P._showTooltip.call(s, 0, { left: 0, top: 0 });
  const left = parseInt(s._tooltip.style.left, 10);
  const top = parseInt(s._tooltip.style.top, 10);
  assert.ok(left >= 0 && left <= 300 - 200, "'outside' fallback left escaped the viewport: " + left);
  assert.ok(top >= 0 && top < 300, "'outside' fallback top escaped the viewport: " + top);
  // Anchored near the hovered sample (hx = 0 + 140 = 140) — not parked off the plot's right edge.
  assert.ok(left < 140 + 100, "'outside' fallback did not anchor near the sample (left=" + left + ')');
});
test('_showTooltip with hideZero renders a header-only tooltip when every series is 0', () => {
  global.window = global.window || {};
  global.window.innerWidth = 1000; global.window.innerHeight = 800;
  // The reference series (0) is itself zero -> hidden as a row, but its coord still
  // anchors the crosshair; the tooltip must show only the timestamp, with no crash.
  const s = Object.assign(Object.create(P), {
    opts: {
      series: [{ label: 'a', color: '#f00', data: [0] }, { label: 'b', color: '#0f0', data: [0] }],
      yUnit: '', theme: { axisLabel: '#888' },
      tooltip: { hideZero: true, position: 'auto' },
    },
    _visibleSeries: null,
    _fmtX: () => 'T', _fmtY: (v) => String(v), _hexA: (h) => h,
    _xPixelForIndex: () => 200, _refSeriesIndex: () => 0, _coordForIndex: () => ({ x: 200, y: 100 }),
    width: 400, height: 200,
    _tooltip: { innerHTML: '', style: {}, offsetWidth: 40, offsetHeight: 20 },
  });
  P._showTooltip.call(s, 0, { left: 50, top: 50 });
  assert.ok(!/font-weight:600/.test(s._tooltip.innerHTML),
    'a zero-value row rendered despite hideZero: ' + s._tooltip.innerHTML);
  assert.ok(parseInt(s._tooltip.style.left, 10) >= 0, 'header-only tooltip was not positioned');
});

// ── Overlay ref-count (a shared container outlives each chart's destroy) ────
// Two charts in one container used to fight over the parent's `position`: the
// first flipped `static` → `relative` and recorded itself as the owner; the
// second saw `relative` and did not; the first's destroy() then reset the parent
// to `static`, dropping the containing block out from under the survivor's
// overlay. The fix ref-counts dependents on MiniChart._parentRel. These drive the
// REAL _ensureOverlay/destroy against a minimal DOM stub (destroy references
// `window`, so it is stubbed here for this section).

function overlayEl() {
  return { className: '', style: { cssText: '' }, remove() {}, getContext: () => ({}) };
}
global.getComputedStyle = (el) => ({ position: (el.style && el.style.position) || 'static' });
global.window = { removeEventListener() {} };
global.document = { createElement: () => overlayEl() };

function overlayChart(parent) {
  const canvas = {
    parentElement: parent, offsetLeft: 0, offsetTop: 0,
    addEventListener() {}, removeEventListener() {},
  };
  return Object.assign(Object.create(P), {
    canvas, width: 100, height: 50, _destroyed: false, _overlay: null,
  });
}

console.log('\nOverlay ref-count (shared container):');
test('a shared container stays relative after one of two charts is destroyed', () => {
  const parent = { style: {}, appendChild() {} };
  const A = overlayChart(parent), B = overlayChart(parent);
  P._ensureOverlay.call(A);
  P._ensureOverlay.call(B);
  assert.strictEqual(parent.style.position, 'relative', 'the static parent was not promoted');
  assert.strictEqual(MiniChart._parentRel.get(parent).count, 2, 'expected two dependents');
  P.destroy.call(A);                       // destroy the chart that flipped it to relative
  assert.strictEqual(parent.style.position, 'relative',
    'destroying one of two dropped the containing block (the bug)');
  assert.strictEqual(MiniChart._parentRel.get(parent).count, 1, 'one dependent should remain');
  P.destroy.call(B);                       // destroy the survivor
  assert.strictEqual(parent.style.position, '', 'the last destroy did not restore the original position');
  assert.strictEqual(MiniChart._parentRel.get(parent), undefined, 'the parent record was not released');
});
test('a single chart restores the parent exactly as it found it', () => {
  const parent = { style: {}, appendChild() {} };
  const A = overlayChart(parent);
  P._ensureOverlay.call(A);
  assert.strictEqual(parent.style.position, 'relative');
  P.destroy.call(A);
  assert.strictEqual(parent.style.position, '', 'a lone chart did not undo its own flip');
});
test('a parent the page already positioned is never clobbered', () => {
  const parent = { style: { position: 'absolute' }, appendChild() {} };
  const A = overlayChart(parent);
  P._ensureOverlay.call(A);
  assert.strictEqual(parent.style.position, 'absolute', 'a page-owned position was overwritten');
  P.destroy.call(A);
  assert.strictEqual(parent.style.position, 'absolute', 'destroy changed a position it never set');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

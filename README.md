# MiniChart

Fast, dependency-free time-series charting on pure Canvas 2D — designed for modern dashboards, with a clean, monitoring-native aesthetic.

**[Docs](https://minichart.org)** · **[GitHub](https://github.com/ruhex/minichart)** · **[npm](https://www.npmjs.com/package/minichart)**

- **Zero dependencies.** Under 15 KB gzipped.
- **Honest time axis.** Points are placed by real epoch time, not array index.
- **Honest missing data.** `null` / `NaN` / `±Infinity` render as a gap, not a connector, and stay out of auto-scaling. A reading isolated by gaps — or a single-sample series — is drawn as a dot, not dropped.
- **Monotone cubic interpolation** (Fritsch–Carlson): smooth curves that never overshoot the data.
- **Scales to millions of points.** Pixel-bucket decimation keeps a cached `Path2D`: a full update of a million points — rescan, re-project, re-decimate, repaint — measures ~15 ms on a current laptop; a `repaint()` from the cached path ~0.3 ms, a hover overlay ~0.1 ms.
- **Lean memory.** A line chart keeps one 4-byte source index per sample, not a pixel pair — x and y are recomputed on demand, so large datasets stay light.
- **Streaming fast-path.** `push()` appends a sample in O(1) (~0.1 ms, flat in n) — a dashboard of many live charts holds 60 fps where `update()` drops frames.
- **Overlay canvas** for the hover layer — mouse moves repaint only the crosshair, not the whole chart.
- **Zoom, pan, themes, formatters, events, keyboard a11y, Pointer Events.** See the options below.

## Install

```bash
npm install minichart     # or: pnpm add / yarn add / bun add minichart
```

TypeScript declarations ship inside the package — nothing to configure. `MiniChart` works as both a value and a type, so `useRef<MiniChart | null>(null)` compiles.

```js
import MiniChart from 'minichart';        // ES modules (Vite, webpack, Rollup)
const MiniChart = require('minichart');   // CommonJS — the module is the class
```

Or without a build step — this defines the `MiniChart` global:

```html
<script src="https://unpkg.com/minichart@0.1.0/dist/minichart.min.js"></script>
```

Pin the full version (as above). MiniChart is `0.x`: each minor bump (`0.1.x` → `0.2.x`) may contain breaking changes, so pinning only `@0` is not enough. A bare `https://unpkg.com/minichart` serves the newest release and would ship those breaking changes to production unannounced.

### What ships

| File | Format | Resolved by |
| --- | --- | --- |
| `minichart.js` | CommonJS, unminified | `require()` |
| `dist/minichart.mjs` | ES module | `import`, bundlers |
| `dist/minichart.min.js` | script / CommonJS, minified | `<script>`, CDN |
| `minichart.d.ts` | TypeScript declarations | picked up automatically |

`dist/minichart.min.js` carries a version banner. `dist/minichart.mjs` ships *unminified* on purpose: it exists for bundlers, and a bundler wants readable source to tree-shake and map — it minifies the result itself. There is deliberately no minified `.mjs`; from a CDN without a build step, use the `<script>` tag above.

## Use

```js
const chart = new MiniChart(canvas, {
  type: 'line',                     // 'line' | 'bar'
  series: [{ label, data, color, notes? }],
  labels: [1640000000, ...],        // epoch seconds for the X axis
  rangeSec: 3600,                   // minimum X-axis span in seconds
  yMin: 0,                          // null = auto from data
  yMax: null,                       // null = auto from data
  yUnit: '',                        // 'MB' | 'MB/s' scale the axis (not a suffix — use yFormat)
  yTicks: 4,                        // Y-axis tick intervals (draws yTicks + 1 grid lines)
  tension: 0.5,                     // 0 = straight lines, 1 = full monotone cubic
  fill: true,                       // true = gradient | 'flat' = solid alpha (cheaper) | false
  padding: { top, right, bottom, left },   // left auto-sizes to the widest Y label
  legend: true,                     // clickable HTML legend
  tooltip: { hideZero: true, position: 'outside' },  // hide 0-value series; place off the plot
  xFormat: 'time',                  // 'time' | 'number' | (value, i, chart) => string
  yFormat: null,                    // (value, chart) => string — overrides yUnit
  theme: { grid, axisLabel, crosshair, dotStroke, tooltipBg, tooltipText, tooltipBorder, legendText },
  on: { ready, hover, click, seriesToggle },
});

chart.update({ series, yMax });          // hot-swap data/options
chart.push(value, label?, seriesIdx?);   // append one sample — O(1) streaming
chart.repaint();                         // redraw from cached geometry, no re-project
chart.setVisibleSeries([0, 2]);          // programmatic series toggle
chart.setXRange(min, max);               // zoom (nulls reset)
chart.getXRange();                       // { view: {min,max}, domain: {min,max} }
chart.destroy();                         // detach listeners + DOM nodes
```

React/Vue wrappers, SSR and sizing notes: [docs.html](https://minichart.org/docs.html).

## Streaming

For a live feed — a metric scraped every second, a multi-chart dashboard updating each frame — call `push()` instead of `update()`:

```js
chart.push(value, label?, seriesIdx?);
```

`update()` re-runs the full O(n) recalculation on every call, which is what drops a dashboard of many charts below 60 fps. `push()` instead keeps, per series, a ring of per-pixel-column min/max buckets over a sliding window: each sample updates one bucket (O(1)) and the repaint rebuilds only the ~plotW-vertex paths (O(plotW·series)). **The cost is flat in n** — 10k, 100k and 1M points all measure ~0.10 ms per sample. On a 32-chart dashboard at 100k points each, `push` holds 60 fps where `update` drops to 27 fps.

- **Bounded memory.** A streaming chart is bounded even if you set nothing: the cap defaults to the larger of the initial sample count and ~2× the plot width. `maxSamples` raises or lowers it. Eviction is window-aware — once the retained rows pass the cap, only rows that have already scrolled off the left edge are dropped, so a cap below what the window itself holds trims nothing rather than erasing what is on screen. `update({ maxSamples })` retargets a running chart.
- **Multi-series, fill, hover.** Each series gets its own bucket ring over the shared window; area fill and the hover crosshair work as usual (hover binary-searches `labels` and projects the sample on demand, since the scale drifts every push). When every series advances together, pass one array — `push([cpu, mem], t)` — which places the whole frame and repaints once, instead of once per series.
- **Honest axis.** The window scrolls when a sample newer than its right edge arrives, and the X axis follows. Pass `label` as epoch seconds for a time axis; omit it for index-based streaming.
- **Lines only.** A bar is drawn per sample, and a bucket holds two extremes rather than the bars in the column, so there is nothing to stream — `push()` appends and takes the full O(n) recalc for bars.

```js
const chart = new MiniChart(canvas, {
  series: [
    { label: 'CPU', color: '#2f81f7', data: [] },
    { label: 'Mem', color: '#a371f7', data: [] },
  ],
  labels: [],
  rangeSec: 60,         // window span — how much history is visible
  maxSamples: 60_000,   // retained-sample cap; arms eviction (see above)
});

setInterval(() => {
  chart.push([cpu(), mem()], Date.now() / 1000);   // one frame, one repaint
}, 1000);
```

Stay on `update()` for batch swaps — it pays the O(n) recalc once. A `null`/`NaN` value is a gap: that tick's bucket gets no sample, so the pen lifts. Pick one path per chart — after `push()`, streaming owns the geometry, and the next `update()` rebuilds the batch geometry from scratch.

## Develop

```bash
npm run build         # write dist/, refresh docs/, print sizes
npm run build:check   # fail if dist/ is stale relative to minichart.js
npm test              # unit + types + browser rendering + packaging tests
```

`npm test` covers geometry invariants (calling the real methods), TypeScript declarations, headless-Chromium pixel rendering, and loading every entry point the package advertises. `prepublishOnly` runs the build and the full suite, so a release can't ship a `dist/` that disagrees with its source.

## License

MIT.

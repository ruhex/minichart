// Type definitions for MiniChart v1
// Fast, dependency-free time-series charting on pure Canvas 2D.
//
// These definitions also drive editor IntelliSense: every exported symbol
// carries a JSDoc comment that surfaces in hover/autocomplete.

/**
 * Render mode for the chart.
 *
 * - `'line'` — smooth area + line series with monotone cubic interpolation.
 * - `'bar'`  — discrete bars growing from the zero baseline (for cumulative
 *   counters like OOM-kill count or process count).
 */
export type ChartType = 'line' | 'bar';

/**
 * One data series.
 */
export interface MiniChartSeries {
  /** Display label, shown in the legend and the tooltip header. */
  label: string;
  /**
   * CSS color for the series. Accepts `#rgb`, `#rrggbb`, `rgb()`, `rgba()`,
   * and named colors (`'mediumseagreen'`, …). Invalid values degrade to a
   * neutral grey instead of crashing the renderer.
   */
  color: string;
  /**
   * Y values, parallel to the chart's `labels` array. Entries may be `null`,
   * `NaN`, or `±Infinity` — such values create a **gap** in the line (the pen
   * lifts) rather than a misleading straight connector.
   */
  data: Array<number | null>;
  /**
   * Optional per-point annotation, parallel to `data`. Each non-null note is
   * rendered under the value in the tooltip. Useful for showing derived
   * context, e.g. `'"/" 79% → "2.3 GB of 3 GB, 482 MB free"'`.
   */
  notes?: Array<string | null>;
}

/**
 * Plot-area insets in CSS pixels. Any subset may be omitted to keep the
 * default. `left` is auto-sized to fit the widest Y-axis label unless you
 * set it explicitly.
 */
export interface MiniChartPadding {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

/**
 * Theme tokens. Override any subset via `opts.theme` to adapt the chart to a
 * light dashboard or a custom palette. Defaults match the original dark look.
 */
export interface MiniChartTheme {
  /** Horizontal grid line color. */
  grid?: string;
  /** Y/X axis tick label color. */
  axisLabel?: string;
  /** Hover crosshair color. */
  crosshair?: string;
  /** Outline color of hover dots. */
  dotStroke?: string;
  /** Tooltip background. */
  tooltipBg?: string;
  /** Tooltip text color. */
  tooltipText?: string;
  /** Tooltip border color. */
  tooltipBorder?: string;
  /** Legend text color. */
  legendText?: string;
}

/**
 * X-axis formatter.
 *
 * - `'time'` (default) — adaptive precision based on `rangeSec`:
 *   `≤30min` → HH:MM:SS, `≤24h` → HH:MM, `≤30d` → DD.MM HH:MM, else DD.MM.YY.
 * - `'number'` — raw numeric label, no time parsing.
 * - function — custom `(value, index, chart) => string`.
 */
export type XFormat = 'time' | 'number' | ((value: number, index: number, chart: MiniChart) => string);

/**
 * Y-axis formatter override. When provided, the built-in compact notation
 * (driven by `yUnit`) is bypassed entirely. Returns the formatted label.
 */
export type YFormat = ((value: number, chart: MiniChart) => string) | null;

/** Payload of the {@link MiniChartHandlers.ready} event. */
export interface ReadyPayload {
  /** Final canvas CSS width. `undefined` when the canvas had no layout yet at construction. */
  width: number | undefined;
  /** Final canvas CSS height. `undefined` when the canvas had no layout yet at construction. */
  height: number | undefined;
}

/** Payload of the {@link MiniChartHandlers.hover} / `click` events. */
export interface PointEventPayload {
  /** Hovered/clicked data index, or `-1` if the pointer left the chart. */
  index: number;
  /** The originating DOM event, if any (absent for keyboard-triggered clicks). */
  event?: Event;
}

/** Payload of the {@link MiniChartHandlers.seriesToggle} event. */
export interface SeriesTogglePayload {
  /** Index of the series whose visibility changed. */
  index: number;
  /** New visibility state (after the toggle). */
  visible: boolean;
}

/**
 * Lifecycle and interaction handlers. Pass any subset via `opts.on`. Errors
 * thrown inside a handler are caught and reported via `console.error` so a
 * bad callback never breaks drawing.
 */
export interface MiniChartHandlers {
  /** Fires once after construction, when the first frame is on screen. */
  ready?: (payload: ReadyPayload, chart: MiniChart) => void;
  /**
   * Fires when the hovered data index changes (pointer or keyboard).
   * `payload.index === -1` when the pointer leaves the chart.
   */
  hover?: (payload: PointEventPayload, chart: MiniChart) => void;
  /** Fires on canvas click and on Enter/Space during keyboard navigation. */
  click?: (payload: PointEventPayload, chart: MiniChart) => void;
  /** Fires after a legend item is clicked and visibility has been applied. */
  seriesToggle?: (payload: SeriesTogglePayload, chart: MiniChart) => void;
}

/**
 * Constructor options. All fields are optional. Any option can be hot-swapped
 * later via {@link MiniChart.update}.
 */
export interface MiniChartOptions {
  /** Render mode. Default `'line'`. */
  type?: ChartType;
  /** The data series. Default `[]`. */
  series?: MiniChartSeries[];
  /** X-axis timestamps in epoch seconds. Must be sorted ascending. */
  labels?: number[];
  /**
   * Total X-axis span in seconds. Defaults to the span of `labels`. When the
   * data covers less time than the dashboard window, the line is honestly
   * positioned on the left rather than stretched to fill the width.
   */
  rangeSec?: number;
  /**
   * Upper bound on the number of samples held in a streaming chart's sliding
   * window. Once exceeded the oldest ~10% are evicted, so {@link MiniChart.push}
   * can run indefinitely without growing memory. Defaults to whatever the
   * window can distinguish (~2 samples per pixel column) or the initial sample
   * count, whichever is larger — a chart streamed from an empty series has no
   * initial count to derive one from. Only consulted by `push()`; ignored by
   * `update()`.
   */
  maxSamples?: number;
  /**
   * Dev-mode contract check. When set, construction, `update()` and `push()`
   * throw on a malformed `labels` / `series[].data` contract (labels not finite
   * or not ascending, or a series' data not the same length as `labels`) instead
   * of failing silently as a wrong-shaped chart. Off by default — the library
   * trades the check for speed in production.
   */
  validate?: boolean;
  /** Fixed Y max. `null` (default) = auto from data with 10% headroom. */
  yMax?: number | null;
  /**
   * Fixed Y min. Default `0`; `null` = auto from data. Auto-min is relaxed
   * past a pinned value when the data does not fit (e.g. all-negative series
   * with the default `0`).
   */
  yMin?: number | null;
  /** Suffix hint for the built-in Y formatter (`'%'`, `'MB'`, `'MB/s'`, …). */
  yUnit?: string;
  /** Number of horizontal grid lines. Default `4`. */
  yTicks?: number;
  /**
   * Curve smoothing. `0` = straight segments, `1` = full Fritsch–Carlson
   * monotone cubic. Monotonicity is preserved at every value. Default `0.5`.
   */
  tension?: number;
  /**
   * Area fill under each line series.
   *
   * - `true` (default) — vertical gradient (solid at the line, fading down).
   * - `'flat'` — single solid alpha. Visually close to the gradient but far
   *   cheaper to rasterize (no per-pixel gradient sampling), so preferable for
   *   streaming or repaint-heavy charts.
   * - `false` — no fill.
   */
  fill?: boolean | 'flat';
  /** Plot-area insets in CSS pixels. */
  padding?: MiniChartPadding;
  /** X-axis formatter. Default `'time'`. */
  xFormat?: XFormat;
  /** Y-axis formatter override. Default `null` (use built-in). */
  yFormat?: YFormat;
  /** Show a clickable HTML legend above the canvas. Default `true`. */
  legend?: boolean;
  /** Theme tokens (merged over the dark defaults). */
  theme?: Partial<MiniChartTheme>;
  /** Lifecycle and interaction handlers. */
  on?: MiniChartHandlers;
  /** Tooltip behaviour (merged over the defaults). */
  tooltip?: MiniChartTooltipOptions;
}

/** Tooltip behaviour. Override any subset via `opts.tooltip`. */
export interface MiniChartTooltipOptions {
  /**
   * Hide a series' tooltip row when its value at the hovered timestamp is
   * exactly `0` (`=== 0`, which includes `-0`; `0.001` is still shown). On a
   * dashboard of many containers most read 0 at any instant, so this keeps the
   * tooltip on the active series instead of a wall of zeros. `null` / `NaN` /
   * `±Infinity` are always excluded — they are gaps. Default `true`; set `false`
   * when 0 is itself a meaningful reading.
   */
  hideZero?: boolean;
  /**
   * Placement of the hover tooltip.
   * - `'outside'` (default) — placed beside / above / below the plot rectangle
   *   so it never covers the plotted data (Grafana-style); falls back to the
   *   `'auto'` anchor when no room outside the plot fits.
   * - `'auto'` — anchored to the hovered sample, above it when it fits, else below.
   */
  position?: 'auto' | 'outside';
}

/** A `{min, max}` range pair. */
export interface MiniChartRange {
  min: number;
  max: number;
}

/** Result of {@link MiniChart.getXRange}. */
export interface MiniChartXRange {
  /** Currently visible window. */
  view: MiniChartRange;
  /** Full data span (the zoom reset target). */
  domain: MiniChartRange;
}

/**
 * MiniChart — fast, dependency-free time-series charting on pure Canvas 2D.
 *
 * Designed for modern dashboards — fast, high-throughput rendering with a clean, monitoring-native aesthetic.
 *
 * @example
 * const chart = new MiniChart(canvas, {
 *   series: [{ label: 'CPU', color: '#58a6ff', data: [10, 20, 30] }],
 *   labels: [1640000000, 1640000060, 1640000120],
 *   rangeSec: 120,
 *   yMin: 0, yMax: 100, yUnit: '%',
 * });
 * chart.update({ series: newSeries });
 * chart.destroy();
 */
export class MiniChart {
  /**
   * Create a chart bound to a `<canvas>` element.
   *
   * @param canvas Target canvas. May report a zero CSS size at construction — the
   *                library polls via requestAnimationFrame and renders once laid out.
   * @param opts   Configuration (all fields optional).
   * @throws {Error} if `canvas` is null/absent, lacks `getContext`, or its 2d context is null.
   */
  constructor(canvas: HTMLCanvasElement, opts?: MiniChartOptions);

  /**
   * Hot-swap any subset of options without recreating the instance.
   *
   * Resets hover state, recomputes geometry for options that affect it
   * (`series`, `labels`, `yMin/Max`, `tension`, `padding`, `type`, …), and
   * repaints. Safe to call from a 60fps live-data loop. Changing `labels` or
   * `series` resets any active zoom.
   *
   * @example
   * chart.update({ yMax: 200, tension: 1 });
   */
  update(newOpts: Partial<MiniChartOptions>): void;

  /**
   * Append one sample to a series and re-render incrementally — the streaming
   * fast path.
   *
   * `update()` re-runs the full O(n) recalculation on every call (the same shape
   * as a full data reset), which on a live dashboard of many charts per
   * frame is what drops them below 60 fps. `push()` instead keeps, per series, a
   * ring of per-pixel-column min/max buckets over a sliding window: each sample
   * updates exactly one bucket (O(1)) and the repaint rebuilds only the
   * ~plotW-vertex paths from those buckets (O(plotW·series)). The cost is
   * **flat in n** — independent of how many samples have arrived — a different
   * scaling curve than an O(n)-per-tick full recalc. Measured ~0.10 ms per
   * sample at 10k / 100k / 1M points alike.
   *
   * Streaming keeps a sliding window of bounded length (the chart never holds
   * more than ~`opts.maxSamples` samples), so it can run indefinitely without
   * growing memory. Multiple series, area fill, and hover are supported — hover
   * binary-searches `labels` and projects the resolved sample on demand, since
   * the scale drifts every push. The window scrolls (ring-eviction) when a
   * sample newer than the right edge arrives, and the X axis follows it.
   *
   * Prefer `update()` for a whole-dataset batch swap; switching back from
   * `push()` to `update()` triggers one full O(n) recalc to re-seed the buckets.
   *
   * `type: 'bar'` is the exception to all of the above: a bar is drawn per
   * sample, and a per-column bucket holds two extremes rather than the samples
   * that fell in the column, so there is nothing to stream. `push()` appends and
   * takes the full O(n) recalculation for bar charts.
   *
   * Multiple series for one tick can be pushed one at a time (`push(v, t, 0)`,
   * then `push(v, t, 1)`) or as a single atomic **frame**: pass an array of
   * values, one per series in `series` order, and the chart repaints once instead
   * of once per series. A frame keeps `labels` index-aligned without padding and
   * is the efficient path when every series updates together; a scalar push stays
   * the single-series O(1) hot path.
   *
   * @param value     The new sample's value, or an array of one value per series
   *                  (a frame). `null` / `NaN` / `undefined` = gap (the pen lifts).
   * @param label     Its timestamp in epoch seconds; omit for index-based
   *                  streaming (auto-incremented from the last label).
   * @param seriesIdx Which series to append to (scalar form). Default `0`;
   *                  ignored when `value` is an array.
   * @example
   * chart.push(cpu, Date.now() / 1000, 0);
   * chart.push([cpu, mem, net], Date.now() / 1000);   // one frame, one repaint
   */
  push(value: number, label?: number, seriesIdx?: number): void;
  /** Overload: an array is a multi-series frame (one value per series, one repaint). */
  push(value: number[], label?: number): void;

  /**
   * Repaint from cached geometry without rebuilding it.
   *
   * For redraws that do not change the data or the size: recovering a canvas
   * that was cleared by something else, or painting a chart whose container
   * was hidden at construction time. Flat in the number of samples (~0.3 ms at
   * 1M points), because nothing is re-projected. Use `update()` for new data.
   *
   * The hidden-container case is the exception: a chart that never got a size
   * is sized here, which does rebuild geometry. Normally a `ResizeObserver`
   * handles that on its own and calling this is unnecessary.
   *
   * @example
   * chart.repaint();
   */
  repaint(): void;

  /**
   * Programmatically set which series indices are visible. The empty array
   * is treated as "show all" (a guard that mirrors the legend's own
   * behavior, so the chart is never rendered empty).
   *
   * Recomputes the Y range from the newly visible set and updates the legend.
   *
   * @example
   * chart.setVisibleSeries([0, 2]);  // show only series 0 and 2
   */
  setVisibleSeries(indices: number[]): void;

  /**
   * Narrow the visible X window (zoom). Both bounds are clamped into the data
   * domain and reordered if swapped. `NaN`/`±Infinity`/`null` bounds reset
   * the zoom. This is the foundation for interactive zoom/pan and for
   * cross-chart cursor synchronization.
   *
   * @param min viewport left edge (epoch seconds), or `null` to reset.
   * @param max viewport right edge (epoch seconds), or `null` to reset.
   */
  setXRange(min: number | null, max: number | null): void;

  /**
   * Read the current X viewport and the full data domain.
   *
   * @example
   * const { view, domain } = chart.getXRange();
   */
  getXRange(): MiniChartXRange;

  /**
   * Pixel X of a data index on the canvas (CSS pixels), or `null` when the index
   * has no projectable position. The public projection hook for custom tooltips,
   * cursors and markers.
   *
   * @example
   * const x = chart.xPixelForIndex(index);   // null on an index-axis chart
   * @param idx - data index
   */
  xPixelForIndex(idx: number): number | null;

  /**
   * The 2D context of the transparent overlay canvas (already DPR-scaled — draw
   * in CSS pixels), or `null` when the chart has no overlay. Custom overlays
   * (threshold lines, annotations, a synced cursor) draw here. It is cleared on
   * every hover and repaint, so a persistent overlay must be redrawn per paint.
   */
  getOverlayContext(): CanvasRenderingContext2D | null;

  /**
   * Detach all listeners, cancel pending `requestAnimationFrame`s, remove the
   * overlay canvas / tooltip / legend from the DOM, and null out instance
   * fields. **Idempotent** — safe to call twice. Call when the chart is no
   * longer needed (SPA route change, component unmount) to prevent leaks.
   */
  destroy(): void;

  /**
   * The active, merged options. Mutable, but prefer {@link update} to change
   * them so geometry/legend stay consistent.
   */
  opts: MiniChartOptions;

  /** Canvas CSS width (post-DPR, in CSS pixels). */
  readonly width: number;
  /** Canvas CSS height. */
  readonly height: number;
  /** Computed Y-axis range (after auto-scaling + headroom). */
  readonly yRange: MiniChartRange;
}

export default MiniChart;

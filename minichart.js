/**
 * MiniChart — time-series charting on plain Canvas 2D.
 *
 * Zero dependencies. Built for monitoring dashboards: dense series, frequent
 * live updates, and honest rendering of missing data. Full option/method
 * reference lives in `minichart.d.ts`; the *why* behind non-obvious guards
 * lives in `ARCHITECTURE.md`. Code comments here stay terse on purpose.
 *
 * ## Rendering model
 *
 * Geometry is computed once per data/size change (`_recalc`) and cached as
 * Path2D; painting (`_draw`) only strokes the cached paths. Hover indicators go
 * on a separate overlay canvas, so moving the pointer repaints a crosshair, not
 * every Bezier. Series denser than ~2 samples/pixel-column are decimated,
 * keeping each column's local min/max so spikes survive. Only the source index
 * of each retained sample is stored (4 bytes, not 20) — x/y are recomputed on
 * demand; bars are the exception (one rect/sample needs the coords).
 *
 * ## Data contract
 *
 * `series[].data` and `labels` are index-aligned: `labels[i]` is the timestamp
 * of every series' `data[i]`, in epoch **seconds**, sorted ascending (axis
 * ticks and hit-testing binary-search it; unsorted yields wrong results, not an
 * error). Values `null` / `NaN` / `±Infinity` are missing: a gap in the line,
 * not a straight connector, and excluded from auto-scaling. With no `labels`
 * the X axis falls back to sample index.
 */
class MiniChart {
  /**
   * Create a chart bound to a <canvas> element.
   * @param {HTMLCanvasElement} canvas - target canvas
   * @param {Object} [opts] - configuration (see class doc)
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    // getContext is null on a lost context, too many live contexts, or a stub canvas — fail here, not mid-paint.
    this.ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
    if (!this.ctx) {
      throw new Error('MiniChart: 2D canvas context unavailable');
    }
    this.opts = Object.assign({
      type: 'line',
      series: [],
      yMax: null,
      yMin: 0,
      yUnit: '',
      tension: 0.5,
      fill: true,
      padding: { top: 12, right: 10, bottom: 22, left: 38 },
      yTicks: 4,
      xFormat: 'time',
      yFormat: null,
      legend: true,
      // Handlers: ready, hover, click, seriesToggle — each (payload, chart).
      on: null,
    }, opts);
    // Nested opts (theme/padding/tooltip/on) are merged over defaults, never replaced.
    this.opts.theme = Object.assign({
      grid: 'rgba(255,255,255,0.06)',
      axisLabel: '#8b949e',
      crosshair: 'rgba(255,255,255,0.2)',
      dotStroke: '#0f1419',
      tooltipBg: 'rgba(15,20,25,.95)',
      tooltipText: '#e1e4e8',
      tooltipBorder: 'rgba(255,255,255,.1)',
      legendText: '#8b949e',
    }, opts.theme || {});
    // Clone+merge: _recalc writes the gutter back into padding, so it's per-instance.
    this.opts.padding = Object.assign(
      { top: 12, right: 10, bottom: 22, left: 38 }, this.opts.padding);
    // A caller-supplied padding.left disables auto-sizing for that edge.
    if (opts && opts.padding && opts.padding.left != null) {
      this._userPadLeft = opts.padding.left;
    }
    // tooltip defaults; merged (see _showTooltip).
    this.opts.tooltip = Object.assign(
      { hideZero: true, position: 'outside' }, this.opts.tooltip);

    this._paths = [];           // stroke Path2D per series
    this._fillPaths = [];       // area Path2D per series
    // Decimation retains the source index only; x/y are recomputed on demand. Bars keep pixel coords.
    this._coordsX = [];         // Float64Array | null — pixel X, bars only
    this._coordsY = [];         // Float64Array | null — pixel Y, bars only
    this._coordsI = [];         // Int32Array | null — source index, index-axis/bars only
    this._cnt = [];             // finite sample count per series
    // Capacity-grow backing stores (subarray views).
    this._bufX = [];
    this._bufY = [];
    this._bufI = [];
    this.yRange = { min: 0, max: 1 };   // resolved Y axis bounds
    // Cached per-series extremes (Y autoscale skips a rescan).
    this._sbMin = [];
    this._sbMax = [];
    this._sbRef = [];   // the data array each extreme was computed from
    this._sbLen = [];   // and its length at that moment
    this._boundsDirty = true;
    this._hoverIdx = -1;        // hovered source data index, -1 when none
    this._hoverRaf = 0;
    this._layoutPollRaf = 0;
    this._layoutPolls = 0;      // frames spent waiting for a first layout
    this._ro = null;
    this._dprMql = null;
    this._onDpr = null;
    this._dpr = 1;
    this._ctxReady = false;
    this._tooltip = null;
    this._legendEl = null;
    this._visibleSeries = null; // visible series indices; null means all

    // Two-level X scale: domain = full data span, viewport = the projected slice (equal until setXRange narrows).
    this._dataXMin = 0;
    this._dataXMax = 1;
    this._viewXMin = 0;
    this._viewXMax = 1;
    this._viewXLocked = false;  // true once setXRange pinned the viewport

    // Suppress applyDPR's recalc here — _refresh(true) below does the single real paint.
    this._initSkipRecalc = true;
    this._setupCanvas();
    this._setupInteraction();
    this._setupLegend();
    this._setupA11y();
    this._initSkipRecalc = false;
    // Not update(this.opts): it'd treat our padding as a caller override and pin the gutter.
    this._refresh(true);
    this._emit('ready', { width: this.width, height: this.height });
  }

  /**
   * Repaint everything derived from the current options, optionally rebuilding
   * geometry first. Shared by the constructor and update() so both stay in step.
   * @param {boolean} needsRecalc - true when options changed chart geometry
   * @private
   */
  _refresh(needsRecalc) {
    if (needsRecalc) {
      if (this.opts.validate) this._validateLabels();   // dev: fail fast on a bad contract
      this._recalc();
    }
    // Legend first: it sits above the canvas inside the same parent, so its
    // height determines the canvas offset that _draw pins the overlay to.
    this._updateLegend();
    this._draw();
    this._updateA11yLabel();
  }

  // ────────────────────────────────────────────────────────────────────
  // Canvas setup: HiDPI scaling + ResizeObserver
  // ────────────────────────────────────────────────────────────────────

  /**
   * Size the canvas for the current devicePixelRatio and keep it in sync with
   * layout and display changes.
   * @private
   */
  _setupCanvas() {
    this._ensureOverlay();
    const applyDPR = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = this.canvas.getBoundingClientRect();
      // 0×0 box (not laid out / display:none): rendering would lock a 1×1 backing store — wait for layout (ResizeObserver).
      if (rect.width === 0 || rect.height === 0) {
        if (this._ro || this._layoutPollRaf) return;
        // No RO: bounded poll covers construction-ahead-of-layout; repaint() re-sizes past the budget.
        if (this._layoutPolls >= 60) return;
        this._layoutPolls++;
        this._layoutPollRaf = requestAnimationFrame(() => {
          this._layoutPollRaf = 0;
          applyDPR();
        });
        return;
      }
      // Laid out. Anything that hides the canvas again gets a fresh budget.
      this._layoutPolls = 0;
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height || 160));
      // Skip unchanged: RO fires on observe + constructor calls this; re-assigning width clears context state.
      if (this.width === w && this.height === h && this._dpr === dpr && this._ctxReady) {
        return;
      }
      this.width = w;
      this.height = h;
      this._dpr = dpr;
      // Same reason: assigning width/height clears the context, so only do it
      // when the value actually differs.
      if (this.canvas.width !== w * dpr)  this.canvas.width  = w * dpr;
      if (this.canvas.height !== h * dpr) this.canvas.height = h * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (this._overlay) {
        if (this._overlay.width !== w * dpr)  this._overlay.width  = w * dpr;
        if (this._overlay.height !== h * dpr) this._overlay.height = h * dpr;
        this._octx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this._syncOverlayGeometry();
      }
      this._ctxReady = true;
      // Suppressed only during construction (every other caller wants the fresh geometry).
      if (!this._initSkipRecalc) {
        this._recalc();
        this._draw();
      }
    };
    this._applyDPR = applyDPR;
    if (window.ResizeObserver) {
      // Coalesce drag-resize bursts into one frame; id tracked so destroy() cancels a pending one.
      this._roRaf = 0;
      this._ro = new ResizeObserver(() => {
        if (this._roRaf) return;
        this._roRaf = requestAnimationFrame(() => {
          this._roRaf = 0;
          applyDPR();
        });
      });
      this._ro.observe(this.canvas);
    } else {
      window.addEventListener('resize', applyDPR);
    }
    // A DPI change (drag to another display) doesn't touch the CSS box, so RO misses it — watch the ratio.
    if (window.matchMedia) {
      // Arm against the CURRENT ratio so a 1x→2x→3x drag catches each jump (re-armed on every change).
      const armDpr = () => {
        const mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
        if (mql.addEventListener) mql.addEventListener('change', this._onDpr);
        else if (mql.addListener) mql.addListener(this._onDpr);
        return mql;
      };
      const onDpr = () => {
        applyDPR();
        if (this._dprMql) {
          if (this._dprMql.removeEventListener) this._dprMql.removeEventListener('change', this._onDpr);
          else if (this._dprMql.removeListener) this._dprMql.removeListener(this._onDpr);
        }
        try { this._dprMql = armDpr(); } catch (_) { /* matchMedia unsupported */ }
      };
      this._onDpr = onDpr;
      try { this._dprMql = armDpr(); } catch (_) { /* matchMedia not supported — degrade gracefully */ }
    }
    applyDPR();
  }

  /**
   * Create the transparent overlay canvas stacked over the data canvas.
   *
   * Hover indicators are painted there instead of on the data canvas, so a
   * pointer move repaints a crosshair and a few dots rather than clearing and
   * re-rendering the grid, axis labels, every Bezier and every gradient. On
   * large series this is the difference between a smooth cursor and a visibly
   * lagging one.
   *
   * A canvas with no parent element gets no overlay; hover then falls back to
   * painting on the data canvas (see _paintHover).
   * @private
   */
  _ensureOverlay() {
    if (this._overlay) return;
    const parent = this.canvas.parentElement;
    if (!parent) return;
    // Overlay is absolute → parent must be a containing block. Shared parents are ref-counted
    // (WeakMap): only the last dependent, and only if we flipped it, restores `position`.
    let rec = MiniChart._parentRel.get(parent);
    if (!rec) { rec = { count: 0, set: false }; MiniChart._parentRel.set(parent, rec); }
    rec.count++;
    this._parentRef = parent;
    if (getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
      rec.set = true;
    }
    const overlay = document.createElement('canvas');
    overlay.className = 'mc-overlay';
    // Transparent bg is load-bearing (a page `canvas { background }` rule would hide the data canvas).
    // Geometry is set by _syncOverlayGeometry, not 100% — the legend shares this parent.
    overlay.style.cssText = 'position:absolute;pointer-events:none;background:transparent;';
    // Appended after the canvas, so it paints on top.
    parent.appendChild(overlay);
    this._overlay = overlay;
    this._octx = overlay.getContext('2d');
    this._syncOverlayGeometry();
  }

  /**
   * Align the overlay with the data canvas.
   *
   * The offset has to track `canvas.offsetLeft/offsetTop`, which move whenever
   * the legend above the canvas changes height — a change no ResizeObserver on
   * the canvas reports, since the canvas itself is not resized. Values are
   * cached so the usual no-op path costs four property reads and no layout
   * writes.
   * @private
   */
  _syncOverlayGeometry() {
    const ov = this._overlay;
    if (!ov || !this.canvas) return;
    const left = this.canvas.offsetLeft;
    const top = this.canvas.offsetTop;
    const w = this.width, h = this.height;
    if (this._ovL === left && this._ovT === top && this._ovW === w && this._ovH === h) return;
    this._ovL = left; this._ovT = top; this._ovW = w; this._ovH = h;
    ov.style.left = left + 'px';
    ov.style.top = top + 'px';
    if (w) ov.style.width = w + 'px';
    if (h) ov.style.height = h + 'px';
  }

  // ────────────────────────────────────────────────────────────────────
  // Coordinate recalculation (O(n), once per update / resize)
  // ────────────────────────────────────────────────────────────────────

  /**
   * Refresh the per-series min/max cache the Y autoscale reads, so a resize,
   * zoom or legend toggle — which can't change what the data contains — skips
   * the O(n) rescan.
   *
   * Invalidated by the dirty flag (`update()`) or when a series' data array
   * identity/length changes (covers `push()`). An in-place sample edit bypasses
   * both, which is why new data must go through `update({series})`.
   * @param {Array} series - the current series array
   * @private
   */
  _ensureSeriesBounds(series) {
    // Identity+length test also covers add (new series → undefined _sbRef) and
    // remove (stale entry past series.length is never read).
    let valid = !this._boundsDirty;
    if (valid) {
      for (let si = 0; si < series.length; si++) {
        const d = MiniChart._dataOf(series[si]);
        if (this._sbRef[si] !== d || this._sbLen[si] !== d.length) { valid = false; break; }
      }
    }
    if (valid) return;
    this._sbMin = new Array(series.length);
    this._sbMax = new Array(series.length);
    this._sbRef = new Array(series.length);
    this._sbLen = new Array(series.length);
    for (let si = 0; si < series.length; si++) {
      const data = MiniChart._dataOf(series[si]);
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        // Missing samples must not reach the scale — one NaN would blank the chart.
        if (!Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      this._sbMin[si] = lo; this._sbMax[si] = hi;
      this._sbRef[si] = data; this._sbLen[si] = data.length;
    }
    this._boundsDirty = false;
  }

  /**
   * Opt-in (`opts.validate`) sanity check of the `labels` / `series[].data`
   * contract the chart's hit-testing, decimation and tooltip all assume: `labels`
   * is finite and ascending, and every non-empty series' `data` is the same length
   * as `labels` (index-aligned). A violation otherwise fails silently as a
   * wrong-shaped chart; in dev mode this throws on the first offender instead.
   * Runs from `_refresh`, so both construction and `update()` are covered. O(n).
   * @private
   */
  _validateLabels() {
    const labels = this.opts.labels;
    if (!labels || !labels.length) return;          // index axis: no time contract to check
    let prev;
    for (let i = 0; i < labels.length; i++) {
      const t = labels[i];
      if (typeof t !== 'number' || !Number.isFinite(t))
        throw new Error('MiniChart: labels[' + i + '] is not a finite number');
      if (i && t < prev)
        throw new Error('MiniChart: labels must be ascending (labels[' + i + '] = ' + t + ' < ' + prev + ')');
      prev = t;
    }
    const n = labels.length;
    for (let si = 0; si < this.opts.series.length; si++) {
      const d = MiniChart._dataOf(this.opts.series[si]);
      if (d === MiniChart._EMPTY || !d.length) continue;   // empty / data-less series is not a violation
      if (d.length !== n)
        throw new Error('MiniChart: series ' + si + ' has ' + d.length + ' samples; labels has ' + n);
    }
  }

  /**
   * The O(1) streaming tail of {@link _validateLabels}: check only the label a
   * `push()` is about to place, before it mutates anything. Index alignment is
   * enforced by `push()` itself, so only finiteness and ascending order are
   * re-checked here. Runs only when `opts.validate` is set.
   * @private
   */
  _validatePushLabel(t, labels) {
    if (typeof t !== 'number' || !Number.isFinite(t))
      throw new Error('MiniChart: push() label must be a finite number');
    if (labels.length && t < labels[labels.length - 1])
      throw new Error('MiniChart: push() label ' + t + ' predates the last tick (labels must be ascending)');
  }

  /**
   * Rebuild everything geometric: Y bounds, the X scale, per-series pixel
   * coordinates, and the cached stroke and fill paths.
   *
   * This is the expensive half of rendering and runs only when data, options or
   * canvas size change. `_draw` then just paints the caches this leaves behind.
   * @private
   */
  _recalc() {
    const { series, padding, yMax, yMin, tension, fill } = this.opts;

    // Reset up front: resize calls _recalc directly, so stale coords would accumulate (and early returns would leave them for hit-testing).
    this._coordsX = [];
    this._coordsY = [];
    this._coordsI = [];
    this._paths = [];
    this._fillPaths = [];
    this._runs = [];
    this._cnt = [];
    // Set before early returns — _useTime/yRange must be sane (hit-testing + axis labels).
    this._useTime = false;
    this.yRange = { min: yMin != null ? yMin : 0, max: yMax != null ? yMax : 1 };
    // A full _recalc leaves batch mode (stream state dropped; next push re-seeds).
    this._streaming = false;
    this._stream = null;
    this._streams = null;
    if (!series.length || !this.width) {
      this._len = 0;
      return;
    }

    const plotH = Math.max(1, this.height - padding.top - padding.bottom);

    // ── Y axis bounds ──
    // Derived from visible series only (hiding a noisy one rescales for the rest).
    const visibleIdx = this._visibleSeries;
    let yMinVal = yMin;
    let yMaxVal = yMax;
    // Mutable — an end that has to be relaxed below stops counting as pinned.
    let autoMax = yMaxVal === null;
    let autoMin = yMinVal === null;
    if (autoMax || autoMin) {
      this._ensureSeriesBounds(series);
      let lo = Infinity, hi = -Infinity;
      for (let si = 0; si < series.length; si++) {
        if (visibleIdx && !visibleIdx.includes(si)) continue;
        // Infinity / -Infinity for an all-missing series, which then correctly
        // contributes nothing.
        if (this._sbMin[si] < lo) lo = this._sbMin[si];
        if (this._sbMax[si] > hi) hi = this._sbMax[si];
      }
      if (hi === -Infinity) hi = 1; // no finite data — neutral default
      if (lo === Infinity)  lo = 0;
      if (autoMax) yMaxVal = hi;
      if (autoMin) yMinVal = lo;

      // A pinned end the data has outgrown would invert the axis — relax it to
      // the data; that side is auto (earns headroom) from here on.
      if (!autoMin && yMinVal > hi) { yMinVal = lo; autoMin = true; }
      if (!autoMax && yMaxVal < lo) { yMaxVal = hi; autoMax = true; }

      if (yMaxVal === yMinVal) {
        // Flat series: widen off the edge, toward whichever side is free.
        const span = Math.max(1, Math.abs(yMinVal) * 0.5);
        if (autoMin && autoMax) {
          yMaxVal = yMinVal + span;   // both free — centre the line
          yMinVal = yMinVal - span;
        } else if (autoMin) {
          yMinVal = yMaxVal - span;   // max pinned — grow downward only
        } else {
          yMaxVal = yMinVal + span;   // min pinned — grow upward only
        }
      } else {
        // Headroom only on derived ends; a pinned end stays where the caller put it.
        const span = yMaxVal - yMinVal;
        if (autoMax) yMaxVal += span * 0.1;
        if (autoMin) yMinVal -= span * 0.1;
        // Don't invent a sign the data lacks: padding must not push non-negative
        // data below zero (or non-positive above it).
        if (autoMin && lo >= 0 && yMinVal < 0) yMinVal = 0;
        if (autoMax && hi <= 0 && yMaxVal > 0) yMaxVal = 0;
        if (yMaxVal <= yMinVal) yMaxVal = yMinVal + (span || 1);   // guard: max > min
      }
    }
    this.yRange = { min: yMinVal, max: yMaxVal };

    // ── Left gutter, sized to the widest Y label ──
    // Skipped entirely when the caller pinned padding.left. Measuring uses the
    // same font the labels are drawn with, so the two cannot drift apart.
    const ctx = this.ctx;
    const yTicks = this.opts.yTicks || 4;
    if (this._userPadLeft == null) {
      ctx.font = '10px -apple-system, system-ui, sans-serif';
      let maxLabelW = 0;
      for (let i = 0; i <= yTicks; i++) {
        const yVal = yMinVal + (yMaxVal - yMinVal) * (i / yTicks);
        const label = this._fmtY(yVal);
        maxLabelW = Math.max(maxLabelW, ctx.measureText(label).width);
      }
      padding.left = Math.max(28, Math.ceil(maxLabelW) + 10);
    }
    const plotW = Math.max(1, this.width - padding.left - padding.right);

    // Determine length from the longest series (guard against empty arrays).
    let len = 0;
    for (const s of series) {
      const n = MiniChart._dataOf(s).length;
      if (n > len) len = n;
    }
    this._len = len;
    // A single sample is still data — bail only on len<1 (else hover runs against empty arrays).
    if (len < 1) return;

    // ── X scale ──
    // rangeSec may exceed the data span (data sits honestly on the left, not stretched).
    // Domain (all labels) and viewport (projected now) are separate — that split enables zoom/pan/sync.
    const labels = this.opts.labels || [];
    let tMin = 0, tMax = 1, useTime = false;
    if (labels.length >= len && typeof labels[0] === 'number') {
      // labels sorted → domain is first/last finite entries (O(1) walk from each end).
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < labels.length; i++) {
        const t = labels[i];
        if (typeof t === 'number' && Number.isFinite(t)) { lo = t; break; }
      }
      for (let i = labels.length - 1; i >= 0; i--) {
        const t = labels[i];
        if (typeof t === 'number' && Number.isFinite(t)) { hi = t; break; }
      }
      // Guard inverted input (negative span → NaN coords).
      if (hi < lo) { const t = lo; lo = hi; hi = t; }
      // One timestamp establishes a time domain: with rangeSec it spans a real window (a live chart at first reading); without it the span collapses and the sample is centred.
      if (lo !== Infinity) {
        tMin = lo;
        tMax = hi;
        const rangeSec = this.opts.rangeSec || (tMax - tMin);
        const tEnd = tMax;
        const tStart = tEnd - rangeSec;
        tMin = Math.min(tMin, tStart);
        tMax = tEnd;
        useTime = true;
      }
    }
    // Re-clamp an existing zoom into the new domain so a viewport set before a
    // data swap cannot point past the end of the data.
    this._dataXMin = tMin;
    this._dataXMax = tMax;
    if (!this._viewXLocked) {
      this._viewXMin = tMin;
      this._viewXMax = tMax;
    } else {
      this._viewXMin = Math.max(tMin, Math.min(this._viewXMin, tMax));
      this._viewXMax = Math.max(this._viewXMin, Math.min(this._viewXMax, tMax));
    }
    // Everything below projects through the viewport.
    tMin = this._viewXMin;
    tMax = this._viewXMax;
    this._tMin = tMin;
    this._tMax = tMax;
    this._useTime = useTime;

    // ── Pixel coordinates ──
    // A position is a "slot": dense, ascending in source index; `_coordsI[slot]` makes gaps
    // detectable and hit-testing a binary search. (Why typed arrays / value not retained: ARCHITECTURE.md)
    const yRange0 = yMaxVal - yMinVal || 1;
    const xSpan = tMax - tMin || 1;
    const xFactor = plotW / xSpan;            // pixel per unit time
    const yFactor = plotH / yRange0;          // pixel per unit value
    const yBase = padding.top + plotH;        // added to every y in the loop
    // No width to place in (one timestamp / all-equal labels / lone index sample) → centre the sample.
    const hasXSpan = tMax > tMin;
    const idxDen = len - 1;
    const iFactor = idxDen > 0 ? plotW / idxDen : 0;  // index axis: pixel per index
    const loneX = padding.left + plotW / 2;
    // Order is load-bearing: a gap must flush the bucket before the next sample is bucketed, or a bucket spans the gap.
    const plotL = padding.left;
    const plotR = this.width - padding.right;
    const decThreshold = Math.max(2, Math.floor(plotW * 2));
    const isBar = this.opts.type === 'bar';
    const active = this._visibleSeries ? new Set(this._visibleSeries) : null;
    this._activeSet = active;
    const runsPerSeries = [];
    this._paths = series.map((s, si) => {
      // Hidden series: no path/coords (placeholders keep si-indexing aligned); buffers released.
      if (active && !active.has(si)) {
        this._bufI[si] = null; this._bufX[si] = null; this._bufY[si] = null;
        this._coordsX.push(null); this._coordsY.push(null); this._coordsI.push(null);
        this._cnt[si] = 0;
        runsPerSeries.push([]);
        return new Path2D();
      }
      const data = MiniChart._dataOf(s);
      const cap = data.length;
      // Backing typed arrays reused across recalcs (subarray views); source-index
      // buffer kept only where a slot→index lookup happens (bars / INDEX-axis).
      const needIdx = !useTime || isBar;
      let stale = true;
      if (needIdx) {
        const held = this._bufI[si] ? this._bufI[si].length : -1;
        stale = held < cap || held > cap * 4;
        if (stale) this._bufI[si] = new Int32Array(cap);
      } else {
        this._bufI[si] = null;   // time-axis line: no per-sample index retained
      }
      if (isBar) {
        if (stale || !this._bufX[si]) {
          this._bufX[si] = new Float64Array(cap);
          this._bufY[si] = new Float64Array(cap);
        }
      } else if (this._bufX[si]) {
        this._bufX[si] = null;   // switched away from bars — release the pixels
        this._bufY[si] = null;
      }
      const xsFull = this._bufX[si], ysFull = this._bufY[si], isFull = this._bufI[si];

      const runRanges = [];  // [firstI, lastI] source ranges — the sparse path uses them
      const runs = [];       // decimated SOURCE-index lists, one per contiguous run
      // Per-run bucket state tracks SOURCE indices directly (-1 sentinels — index 0 is real).
      let cur = null, bucketX = -1, minI = -1, maxI = -1;
      let minY = 0, maxY = 0, lastLeftI = -1, firstRightI = -1, lastLeftX = 0, firstRightX = 0;
      const flushBucket = () => {
        if (minI < 0) return;
        // Emit the column's extreme samples in source order — left to right.
        // minI tracks the peak (smallest screen y), maxI the trough.
        const a = minI <= maxI ? minI : maxI;
        const b = a === minI ? maxI : minI;
        cur.push(a);
        if (b !== a) cur.push(b);
        minI = -1; maxI = -1;
      };
      const endRun = () => {
        flushBucket();
        if (cur !== null) {
          if (lastLeftI >= 0) cur.unshift(lastLeftI);
          if (firstRightI >= 0) cur.push(firstRightI);
          runs.push(cur);
        }
        cur = null; bucketX = -1; minI = -1; maxI = -1;
        lastLeftI = -1; firstRightI = -1;
      };

      let n = 0, runFirstI = 0, prevI = -2;
      for (let i = 0; i < cap; i++) {
        const v = data[i];
        // Missing sample → pen lifts (a gap, not a misleading connector across dead collection).
        if (!Number.isFinite(v)) continue;
        // A gap ends the run: flush the bucket first so it never spans the hole.
        if (n > 0 && i !== prevI + 1) { endRun(); runRanges.push([runFirstI, prevI]); }
        if (cur === null) { cur = []; runFirstI = i; }
        const x = (useTime && labels[i] != null)
          ? (hasXSpan ? plotL + (labels[i] - tMin) * xFactor : loneX)
          : (idxDen > 0 ? plotL + i * iFactor : loneX);
        const y = yBase - (v - yMinVal) * yFactor;
        if (isFull) isFull[n] = i;        // retained only for index-axis hover / bars
        if (isBar) { xsFull[n] = x; ysFull[n] = y; }
        // Decimation: min/max per pixel column (bars skip — drawn per-sample).
        if (!isBar) {
          if (x < plotL) {
            // Off-screen left: keep the nearest sample to preserve the entering slope.
            if (lastLeftI < 0 || x > lastLeftX) { lastLeftI = i; lastLeftX = x; }
          } else if (x > plotR) {
            if (firstRightI < 0 || x < firstRightX) { firstRightI = i; firstRightX = x; }
          } else {
            // x ≥ 0 here: x|0 = Math.floor, faster.
            const bx = x | 0;
            if (bucketX < 0) bucketX = bx;
            else if (bx !== bucketX) { flushBucket(); bucketX = bx; }
            if (minI < 0) { minI = i; maxI = i; minY = y; maxY = y; }
            else {
              if (y < minY) { minI = i; minY = y; }
              if (y > maxY) { maxI = i; maxY = y; }
            }
          }
        }
        prevI = i;
        n++;
      }
      endRun();
      if (n > 0) runRanges.push([runFirstI, prevI]);
      this._cnt[si] = n;

      // Sparse (≤ ~2/column): enumerate the finite range directly (pixel-identical), skip the bucketing.
      runsPerSeries.push(n > 0 && n <= decThreshold
        ? runRanges.map(([a, b]) => { const r = []; for (let j = a; j <= b; j++) r.push(j); return r; })
        : runs);

      // Bars keep a pixel per sample; a line keeps none (rebuilt from source indices in the path builder).
      this._coordsX.push(isBar ? xsFull.subarray(0, n) : null);
      this._coordsY.push(isBar ? ysFull.subarray(0, n) : null);
      this._coordsI.push(isFull ? isFull.subarray(0, n) : null);
      return new Path2D();
    });
    // Exposed for the headless tests/bench (assert on the decimated runs).
    this._runs = runsPerSeries;
    // Drop backing stores for removed series (keyed off _bufI — the one store every type fills).
    if (this._bufI.length > series.length) {
      this._bufI.length = series.length;
      if (this._bufX.length > series.length) this._bufX.length = series.length;
      if (this._bufY.length > series.length) this._bufY.length = series.length;
    }

    // Bars are drawn per-sample from coords — no curve construction.
    if (isBar) return;

    // ── Stroke and fill paths ──
    // Monotone cubic (Fritsch–Carlson) — no overshoot (α/β clamp); fill emitted
    // in the same pass, one closed area per run (gaps need a separate fill).
    const yRangeR = yMaxVal - yMinVal || 1;
    const yZeroR = padding.top + plotH - ((0 - yMinVal) / yRangeR) * plotH;
    const baseY = (yMinVal <= 0 && yMaxVal >= 0) ? yZeroR
                : (yMinVal > 0 ? (padding.top + plotH) : padding.top);
    this._fillPaths = [];
    // Scratch vertex buffers — pixels rebuilt here from source indices (bit-identical to the projection loop).
    let sx = new Float64Array(64), sy = new Float64Array(64);
    this._paths.forEach((path, si) => {
      const runs = runsPerSeries[si];
      const fillPath = new Path2D();
      this._fillPaths[si] = fillPath;
      if (!runs || !runs.length) return;
      const data = MiniChart._dataOf(series[si]);

      for (const seg of runs) {
        if (seg.length === 0) continue;
        const mlen = seg.length;
        if (sx.length < mlen) { sx = new Float64Array(mlen); sy = new Float64Array(mlen); }
        for (let k = 0; k < mlen; k++) {
          const i = seg[k];
          sx[k] = (useTime && labels[i] != null)
            ? (hasXSpan ? plotL + ((labels[i] - tMin) / xSpan) * plotW : loneX)
            : (idxDen > 0 ? plotL + (i / idxDen) * plotW : loneX);
          sy[k] = padding.top + plotH - ((data[i] - yMinVal) / yRange0) * plotH;
        }
        // A lone sample (no segment to stroke) renders as a dot — radius half the stroke width.
        if (seg.length < 2) {
          const lx = sx[0], ly = sy[0];
          path.moveTo(lx + 0.9, ly);          // arc() would line in from the previous subpath
          path.arc(lx, ly, 0.9, 0, Math.PI * 2);
          continue;
        }
        path.moveTo(sx[0], sy[0]);
        // The area traces the same curve but starts and ends on the baseline.
        fillPath.moveTo(sx[0], baseY);
        fillPath.lineTo(sx[0], sy[0]);

        if (tension > 0 && seg.length > 2) {
          const n = seg.length;
          const dx = new Array(n - 1), dy = new Array(n - 1), m = new Array(n - 1);
          for (let i = 0; i < n - 1; i++) {
            dx[i] = sx[i + 1] - sx[i];
            dy[i] = sy[i + 1] - sy[i];
            m[i] = dx[i] !== 0 ? dy[i] / dx[i] : 0;
          }
          const t = new Array(n);
          t[0] = m[0];
          t[n - 1] = m[n - 2];
          for (let i = 1; i < n - 1; i++) {
            if (m[i - 1] * m[i] > 0) {
              let alpha = Math.sqrt(dx[i - 1] * dx[i - 1] + dx[i] * dx[i - 1]);
              let beta  = Math.sqrt(dx[i] * dx[i]       + dx[i] * dx[i - 1]);
              // The clamp is what makes the curve monotone; without it the
              // spline overshoots between closely spaced samples.
              const alphaCap = 3 * dx[i - 1];
              const betaCap  = 3 * dx[i];
              if (alpha > alphaCap) alpha = alphaCap;
              if (beta  > betaCap)  beta  = betaCap;
              t[i] = (alpha * m[i - 1] + beta * m[i]) / (alpha + beta);
            } else {
              t[i] = 0;   // local extremum: flatten so the curve does not bulge
            }
          }
          // Hermite → Bezier, control points at one third of each interval.
          for (let i = 0; i < n - 1; i++) {
            const h = dx[i];
            const nx = sx[i + 1], ny = sy[i + 1];
            // Two samples on the same pixel column: a Bezier would be
            // degenerate, so connect them straight.
            if (Math.abs(h) < 1e-9) {
              path.lineTo(nx, ny);
              fillPath.lineTo(nx, ny);
              continue;
            }
            const c1x = sx[i] + h / 3;
            const c1y = sy[i] + tension * t[i]     * h / 3;
            const c2x = nx         - h / 3;
            const c2y = ny         - tension * t[i + 1] * h / 3;
            path.bezierCurveTo(c1x, c1y, c2x, c2y, nx, ny);
            fillPath.bezierCurveTo(c1x, c1y, c2x, c2y, nx, ny);
          }
        } else {
          // tension 0, or too few samples for a spline.
          for (let i = 1; i < mlen; i++) {
            path.lineTo(sx[i], sy[i]);
            fillPath.lineTo(sx[i], sy[i]);
          }
        }
        // Close this run's area against the baseline.
        fillPath.lineTo(sx[mlen - 1], baseY);
        fillPath.closePath();
      }
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // Main render
  // ────────────────────────────────────────────────────────────────────

  /**
   * Paint the chart from the caches built by _recalc: grid, axis labels, series
   * and the hover layer. Cheap by design — no geometry is computed here.
   * @private
   */
  _draw() {
    const { ctx, width: w, height: h, opts } = this;
    // ctx/opts are null after destroy() — bail so a post-destroy callback doesn't dereference them.
    if (!ctx || !w) return;
    // The legend can change height on any data update, moving the canvas
    // without resizing it, so no resize callback would realign the overlay.
    this._syncOverlayGeometry();
    const { padding, fill, series } = opts;
    const theme = opts.theme;
    const plotW = w - padding.left - padding.right;
    const plotH = h - padding.top - padding.bottom;
    const { min: yMinV, max: yMaxV } = this.yRange;

    ctx.clearRect(0, 0, w, h);

    // ── Horizontal grid lines + Y-axis labels ──
    const yTicks = opts.yTicks || 4;
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = theme.axisLabel;
    ctx.font = '10px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= yTicks; i++) {
      const yVal = yMinV + (yMaxV - yMinV) * (i / yTicks);
      const y = padding.top + plotH - (i / yTicks) * plotH;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(w - padding.right, y);
      ctx.stroke();
      ctx.fillText(this._fmtY(yVal), padding.left - 6, y);
    }

    // ── X axis labels ──
    // Positions come from the viewport, not from any particular series, so the
    // axis stays correct when the first series is hidden, empty, or absent.
    const labels = this.opts.labels || [];
    const hasXData = labels.length > 0 || (this._coordsI.some(a => a && a.length));
    if (hasXData) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.font = '10px -apple-system, system-ui, sans-serif';
      const vMin = this._viewXMin, vMax = this._viewXMax;
      const vSpan = (vMax - vMin) || 1;
      const plotL = padding.left;
      const plotR = w - padding.right;
      const plotXW = plotR - plotL;
      if (plotXW < 2) {
        const idx = this._nearestLabelIndex((vMin + vMax) / 2);
        if (idx >= 0) ctx.fillText(this._fmtX(idx), plotL, h - padding.bottom + 6);
      } else {
        // Roughly one label per 60px, capped at five.
        const targetCount = Math.max(2, Math.min(5, Math.floor(plotXW / 60)));
        // Labels are nudged inside the plot edges and skipped when they would
        // collide with the previous one, so ticks never overlap.
        let lastDrawnX = -Infinity;
        for (let i = 0; i < targetCount; i++) {
          const targetT = vMin + (vSpan * i / (targetCount - 1));
          const idx = this._nearestLabelIndex(targetT);
          if (idx < 0) continue;
          // Through the shared projection so a tick sits under its sample (a local formula diverged on degenerate viewports).
          const px = this._xPixelForIndex(idx);
          let drawX = px != null ? px : plotL + ((targetT - vMin) / vSpan) * plotXW;
          const label = this._fmtX(idx);
          const labelW = ctx.measureText(label).width;
          if (drawX - labelW/2 < plotL) drawX = plotL + labelW/2;
          if (drawX + labelW/2 > plotR) drawX = plotR - labelW/2;
          if (drawX - labelW/2 < lastDrawnX + 4) continue;
          ctx.fillText(label, drawX, h - padding.bottom + 6);
          lastDrawnX = drawX + labelW/2;
        }
      }
    }

    // ── Series ──
    // Always full opacity — an entrance animation leaves a blank chart (indistinguishable from "no data" on monitoring).
    ctx.save();
    // Clip to the plot area so nothing bleeds into the axis label gutters.
    ctx.beginPath();
    ctx.rect(padding.left, padding.top,
             w - padding.left - padding.right, plotH);
    ctx.clip();

    // null means every series is visible.
    const active = this._activeSet;

    // Bars/areas anchor to zero (the baseline), not the plot floor.
    const ySpan = yMaxV - yMinV || 1;
    const yZero = padding.top + plotH - ((0 - yMinV) / ySpan) * plotH;

    this._paths.forEach((path, si) => {
      if (active && !active.has(si)) return;
      const s = series[si];
      if (!s || !path) return;
      // Stream mode: push() rebuilt the paths from the bucket ring — the cached-geometry emptiness test doesn't apply.
      const streaming = this._streaming;
      // _cnt = finite samples; pixel arrays exist only for bars (per-sample coords).
      const xs = this._coordsX[si], ys = this._coordsY[si];
      const n = streaming ? 0 : (this._cnt[si] || 0);
      if (!streaming && n < 1) return;

      if (!streaming && this.opts.type === 'bar' && xs && ys) {
        ctx.fillStyle = this._hexA(s.color, 1);
        const barW = Math.max(2, (plotW / Math.max(1, n)) * 0.65);
        for (let bi = 0; bi < n; bi++) {
          const cx = xs[bi], cy = ys[bi];
          // Width capped by the gap to the next bar (uneven spacing).
          const nextX = bi + 1 < n ? xs[bi + 1] : cx + barW * 1.6;
          const bw = Math.min(barW, (nextX - cx) * 0.8);
          const top = Math.min(cy, yZero);
          const bottom = Math.max(cy, yZero);
          ctx.fillRect(cx - bw / 2, top, bw, bottom - top);
        }
      } else {
        const fillPath = this._fillPaths && this._fillPaths[si];
        if (fill && fillPath && (streaming || n > 1)) {
          if (fill === 'flat') {
            // 'flat' = one solid alpha instead of a per-pixel gradient (far cheaper per-frame paint).
            ctx.fillStyle = this._hexA(s.color, 0.35);
          } else {
            const grad = ctx.createLinearGradient(0, padding.top, 0, padding.top + plotH);
            grad.addColorStop(0, this._hexA(s.color, 0.35));
            grad.addColorStop(1, this._hexA(s.color, 0));
            ctx.fillStyle = grad;
          }
          ctx.fill(fillPath);
        }
        ctx.strokeStyle = this._hexA(s.color, 1);
        ctx.lineWidth = 1.8;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke(path);
      }
    });
    ctx.restore();

    // Hover normally lives on the overlay; without one it has to be painted
    // here, since this is the only pass that touches the data canvas.
    if (this._octx) {
      this._octx.clearRect(0, 0, w, h);
      this._paintHover(this._octx);
    } else {
      this._paintHover(ctx);
    }
  }

  /**
   * Repaint the hover layer alone. This is the pointer-move path: it touches
   * only the overlay, leaving the cached series paths and gradients alone.
   * @private
   */
  _drawHover() {
    if (!this._octx) {
      // No overlay (canvas without a parent) — the hover layer only exists as
      // part of a full repaint.
      this._draw();
      return;
    }
    const octx = this._octx;
    octx.clearRect(0, 0, this.width, this.height);
    this._paintHover(octx);
  }

  /**
   * Paint crosshair and per-series dots into a context. Shared by the overlay
   * path and the no-overlay fallback.
   * @param {CanvasRenderingContext2D} octx - target context
   * @private
   */
  _paintHover(octx) {
    const w = this.width, h = this.height;
    const padding = this.opts.padding;
    const plotH = h - padding.top - padding.bottom;
    if (this._hoverIdx < 0) return;

    // Mirrors the clip in _draw: hovering the first or last point would
    // otherwise push the dot and crosshair into the axis label gutters.
    octx.save();
    octx.beginPath();
    octx.rect(padding.left, padding.top,
              w - padding.left - padding.right, plotH);
    octx.clip();

    const series = this.opts.series;
    const active = this._activeSet;
    // Prefer the X domain; fall back to the reference series for index-based
    // charts, which have no timestamp to project.
    let hx = this._xPixelForIndex(this._hoverIdx);
    if (hx == null) {
      const ref = this._refSeriesIndex();
      const hc = ref >= 0 ? this._coordForIndex(ref, this._hoverIdx) : null;
      hx = hc ? hc.x : null;
    }
    if (hx != null) {
      octx.strokeStyle = this.opts.theme.crosshair;
      octx.lineWidth = 1;
      octx.setLineDash([3, 3]);
      octx.beginPath();
      octx.moveTo(hx, padding.top);
      octx.lineTo(hx, padding.top + plotH);
      octx.stroke();
      octx.setLineDash([]);
    }
    // Over the series, not `_coordsX` (stream mode leaves that empty — resolves on demand).
    for (let si = 0; si < series.length; si++) {
      if (active && !active.has(si)) continue;
      const c = this._coordForIndex(si, this._hoverIdx);
      if (!c) continue;
      this._drawHoverDot(octx, c.x, c.y, series[si].color);
    }
    octx.restore();
  }

  /**
   * Resolve a source data index to its {x, y} on one series, projected on demand
   * (x/y are pure functions of the index — cheaper to recompute than store per
   * sample). Must stay an EXACT finite match: a nearest hit would snap the
   * tooltip across a gap to a neighbouring sample.
   * @param {number} si - series index
   * @param {number} idx - source data index
   * @returns {{x: number, y: number}|null} null when this series has no finite sample at `idx`
   * @private
   */
  _coordForIndex(si, idx) {
    // opts is null after destroy(); a wrapper-driven call still reaches here, so guard.
    const series = this.opts && this.opts.series;
    const v = MiniChart._dataOf(series && series[si])[idx];
    // Out-of-range reads undefined (not finite) — no separate bounds test needed.
    if (!Number.isFinite(v)) return null;
    return { x: this._projectX(idx), y: this._projectY(v) };
  }

  /** Filled circle with a background-coloured outline. @private */
  _drawHoverDot(octx, x, y, color) {
    octx.fillStyle = this._hexA(color, 1);
    octx.beginPath();
    octx.arc(x, y, 3.5, 0, Math.PI * 2);
    octx.fill();
    octx.strokeStyle = this.opts.theme.dotStroke;
    octx.lineWidth = 2;
    octx.stroke();
  }

  /**
   * Project a data index to a pixel X through the current viewport.
   *
   * Single source of truth for the X projection, so axis ticks, crosshair and
   * tooltip cannot drift apart. Returns null when the index has no timestamp,
   * which is the signal to fall back to coordinate lookup.
   * @param {number} idx - data index
   * @returns {number|null} pixel X
   * @private
   */
  _xPixelForIndex(idx) {
    // Viewport is in label units only when _recalc accepted labels as a time domain — else the
    // viewport is 0…1 (index) and an epoch timestamp projects six orders of magnitude off the plot.
    if (!this._useTime) return null;
    const t = (this.opts.labels || [])[idx];
    if (typeof t !== 'number') return null;
    return this._projectX(idx);
  }

  /**
   * Pixel X of a data index — the whole projection, time domain or sample index.
   *
   * This is the expression `_recalc` projects its samples with, factored out so
   * that recomputing a coordinate later cannot drift from the one the path was
   * drawn at. Nothing here is cached: x is a pure function of the index, the
   * viewport and the padding, so it is cheaper to recompute than to store a
   * pixel per sample and keep it alive for the life of the chart.
   * @param {number} idx - data index
   * @returns {number} pixel X
   * @private
   */
  _projectX(idx) {
    const padding = this.opts.padding;
    const plotL = padding.left;
    // Matches _recalc's plotW, clamp included, so the two agree even on a canvas
    // narrower than its own padding.
    const plotW = Math.max(1, this.width - plotL - padding.right);
    if (this._useTime) {
      // `!= null` mirrors the projection loop: a non-number label yields NaN, and the crosshair sits where the line was drawn.
      const t = (this.opts.labels || [])[idx];
      if (t != null) {
        const vMin = this._viewXMin, vMax = this._viewXMax;
        // No-width viewport (one sample / equal labels) → centre the sample.
        return vMax > vMin ? plotL + ((t - vMin) / (vMax - vMin)) * plotW
                           : plotL + plotW / 2;
      }
    }
    const den = this._len - 1;
    return den > 0 ? plotL + (idx / den) * plotW : plotL + plotW / 2;
  }

  /**
   * Pixel Y of a value, against the resolved axis bounds.
   * @param {number} v - sample value
   * @returns {number} pixel Y
   * @private
   */
  _projectY(v) {
    const padding = this.opts.padding;
    const plotH = Math.max(1, this.height - padding.top - padding.bottom);
    const { min: y0, max: y1 } = this.yRange;
    return padding.top + plotH - ((v - y0) / ((y1 - y0) || 1)) * plotH;
  }

  /**
   * The series hit-testing and the tooltip anchor to: the first visible one
   * that has points. Deliberately not series 0, which may be hidden by the
   * legend or empty.
   * @returns {number} series index, or -1 when nothing is drawable
   * @private
   */
  _refSeriesIndex() {
    const active = this._activeSet;
    // Stream mode keeps no coordinate arrays to consult — _coordForIndex
    // projects on demand — so "has points" is a question about the source data.
    if (this._streaming) {
      const series = this.opts.series;
      for (let si = 0; si < series.length; si++) {
        if (active && !active.has(si)) continue;
        if (MiniChart._dataOf(series[si]).length) return si;
      }
      return -1;
    }
    for (let si = 0; si < this._cnt.length; si++) {
      if (active && !active.has(si)) continue;
      if (this._cnt[si] > 0) return si;
    }
    return -1;
  }

  /**
   * Nearest sample to a pixel X on the reference series, by binary search over
   * the retained source indices. Used for index-based charts, which have no
   * timestamps to search instead.
   *
   * The search reads x through `_projectX` rather than from a stored pixel
   * array: the projection is monotonic in the source index, which is what makes
   * the search valid, and recomputing it for the ~20 probes a binary search
   * takes is cheaper than keeping a pixel per sample to read them from.
   * @param {number} px - pixel X in canvas CSS space
   * @returns {{i:number, dist:number}|null} source data index + pixel distance
   * @private
   */
  _nearestCoordByX(px) {
    const si = this._refSeriesIndex();
    if (si < 0) return null;
    const is = this._coordsI[si];
    if (!is || !is.length) return null;
    const at = (k) => this._projectX(is[k]);
    let lo = 0, hi = is.length - 1;
    const x0 = at(0), xN = at(hi);
    if (px <= x0) return { i: is[0], dist: Math.abs(x0 - px) };
    if (px >= xN) return { i: is[hi], dist: Math.abs(xN - px) };
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (at(mid) < px) lo = mid + 1; else hi = mid;
    }
    const prev = lo > 0 ? lo - 1 : 0;
    const dPrev = Math.abs(at(prev) - px), dLo = Math.abs(at(lo) - px);
    return dPrev < dLo ? { i: is[prev], dist: dPrev } : { i: is[lo], dist: dLo };
  }

  /**
   * Index of the label nearest a timestamp. Runs on every pointer move and per
   * axis tick, hence the binary search — which is also why `labels` must be
   * sorted ascending, as documented on the class.
   * @param {number} t - target timestamp
   * @returns {number} nearest label index, or -1 when there are no labels
   * @private
   */
  _nearestLabelIndex(t) {
    const labels = this.opts.labels || [];
    if (!labels.length) return -1;
    let lo = 0, hi = labels.length - 1;
    if (t <= labels[0]) return 0;
    if (t >= labels[hi]) return hi;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (labels[mid] < t) lo = mid + 1; else hi = mid;
    }
    // lo is the first index at or past t; its predecessor may be closer.
    if (lo > 0 && Math.abs(labels[lo - 1] - t) < Math.abs(labels[lo] - t)) return lo - 1;
    return lo;
  }

  // ────────────────────────────────────────────────────────────────────
  // Hover / tooltip interaction
  // ────────────────────────────────────────────────────────────────────

  /**
   * Wire pointer input and create the tooltip element.
   *
   * The tooltip lives on document.body, not inside the chart's container, so it
   * is never clipped by an ancestor's overflow and does not participate in the
   * container's stacking context.
   * @private
   */
  _setupInteraction() {
    const onMove = (e) => {
      // canvas is null after destroy() (which unregisters this); a wrapper-driven last event would otherwise throw.
      if (!this._len || !this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      // Scale the pointer offset from the transformed box (getBoundingClientRect) back into the
      // layout box (ResizeObserver) — a `transform: scale()` ancestor makes them differ.
      const scaleX = rect.width > 0 ? this.width / rect.width : 1;
      const x = (e.clientX - rect.left) * scaleX;
      const padding = this.opts.padding;
      const plotL = padding.left;
      const plotR = this.width - padding.right;
      const vMin = this._viewXMin, vMax = this._viewXMax;
      const span = (vMax - vMin) || 1;
      let bestIdx = -1, bestDist = Infinity;
      // Time-axis charts search timestamps; index-axis search pixel positions (test for a time domain, not plot width).
      if (this._useTime && plotR > plotL) {
        const t = vMin + ((x - plotL) / (plotR - plotL)) * span;
        bestIdx = this._nearestLabelIndex(t);
        if (bestIdx >= 0) {
          const px = this._xPixelForIndex(bestIdx);
          if (px != null) bestDist = Math.abs(px - x);
        }
      } else {
        const hit = this._nearestCoordByX(x);
        if (hit) { bestIdx = hit.i; bestDist = hit.dist; }
      }
      // How far the pointer may sit from a sample and still select it. Scaled
      // to chart width so narrow charts, typically touch, snap tighter.
      const threshold = Math.min(92, Math.max(28, (this.width || 400) / 11));
      if (bestIdx === -1 || bestDist > threshold) {
        if (this._hoverIdx !== -1) this._clearHover();
        return;
      }
      if (bestIdx !== this._hoverIdx) {
        this._hoverIdx = bestIdx;
        // Canvas work is deferred to a frame; the tooltip is plain HTML and
        // cheap enough to update inline.
        this._scheduleHover();
        this._showTooltip(bestIdx, rect);
        this._emit('hover', { index: bestIdx, event: e });
      }
    };
    const onLeave = () => {
      if (this._hoverIdx !== -1) {
        this._emit('hover', { index: -1 });
      }
      this._clearHover();
    };
    // Pointer Events cover touch and stylus as well as mouse, so dragging a
    // finger across the chart scrubs it. Mouse events are the fallback.
    const supportsPointer = (window.PointerEvent !== undefined);
    if (supportsPointer) {
      this.canvas.addEventListener('pointermove', onMove);
      this.canvas.addEventListener('pointerleave', onLeave);
      this._onMove = onMove;
      this._onLeave = onLeave;
      this._pointerEvt = 'pointer';
    } else {
      this.canvas.addEventListener('mousemove', onMove);
      this.canvas.addEventListener('mouseleave', onLeave);
      this._onMove = onMove;
      this._onLeave = onLeave;
      this._pointerEvt = 'mouse';
    }
    // A click carries clientX/clientY like a move, so the same handler can
    // resolve which sample is under it.
    const onClick = (e) => {
      onMove(e);
      this._emit('click', { index: this._hoverIdx, event: e });
    };
    this.canvas.addEventListener('click', onClick);
    this._onClick = onClick;

    this._tooltip = document.createElement('div');
    this._tooltip.className = 'mc-tooltip';
    this._applyTooltipTheme();
    document.body.appendChild(this._tooltip);
  }

  /**
   * Apply theme colours to the tooltip. Separate from creation so a theme
   * change through update() restyles the existing element.
   * @private
   */
  _applyTooltipTheme() {
    if (!this._tooltip) return;
    const t = this.opts.theme;
    this._tooltip.style.cssText =
      'position:fixed;pointer-events:none;' +
      `background:${t.tooltipBg};color:${t.tooltipText};` +
      'padding:8px 10px;border-radius:8px;font-size:11px;line-height:1.5;' +
      `border:1px solid ${t.tooltipBorder};box-shadow:0 4px 12px rgba(0,0,0,.4);` +
      'z-index:100;opacity:0;transition:opacity .12s;backdrop-filter:blur(8px);max-width:240px;' +
      'max-height:calc(100vh - 16px);overflow:hidden';
  }

  /**
   * Render and position the tooltip for one data index.
   *
   * Every interpolated value is escaped: labels and notes routinely carry
   * host-controlled text — interface names, mount points, process names — and
   * this is assembled as an HTML string.
   * @param {number} idx - data index
   * @param {DOMRect} rect - canvas rect, for viewport-space positioning
   * @private
   */
  _showTooltip(idx, rect) {
    const { series } = this.opts;
    const esc = MiniChart._esc;
    const tt = this.opts.tooltip;
    const hideZero = !tt || tt.hideZero !== false;   // default true
    // Hidden series stay out of the tooltip, so it never reports values the
    // chart is not showing.
    const visibleIdx = this._visibleSeries;
    const isShown = (si) => !visibleIdx || visibleIdx.includes(si);
    const muted = esc(this.opts.theme.axisLabel);
    let html = `<div style="color:${muted};margin-bottom:4px;font-size:10px">${esc(this._fmtX(idx))}</div>`;
    series.forEach((s, si) => {
      if (!isShown(si)) return;
      const v = MiniChart._dataOf(s)[idx];
      if (v == null || !Number.isFinite(v)) return;   // a gap to the renderer is a gap here too
      // hideZero: most series read 0 at any instant — drop them so the active one isn't buried.
      if (hideZero && v === 0) return;
      const val = esc(this._fmtY(v));
      // Normalised through the colour parser, so an arbitrary string cannot
      // reach the style attribute.
      const color = esc(this._hexA(s.color, 1));
      html += `<div style="display:flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block"></span><span style="flex:1">${esc(s.label)}</span><span style="font-weight:600">${val}</span></div>`;
      // Optional per-sample annotation, index-aligned with `data`.
      if (s.notes && s.notes[idx]) {
        html += `<div style="margin:-2px 0 4px 14px;color:${muted};font-size:10px">${esc(s.notes[idx])}</div>`;
      }
    });
    this._tooltip.innerHTML = html;
    this._tooltip.style.opacity = '1';
    // Anchored to the sample's real position, not to the pointer, so the
    // tooltip stays put while the cursor moves within one sample's catchment.
    const pxLocal = this._xPixelForIndex(idx);
    const ref = this._refSeriesIndex();
    const hc = ref >= 0 ? this._coordForIndex(ref, idx) : null;
    const localX = pxLocal != null ? pxLocal : (hc ? hc.x : 0);
    const hx = rect.left + localX;
    const pointY = hc ? hc.y : 0;
    const tw = this._tooltip.offsetWidth;
    const th = this._tooltip.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight, gap = 8;
    // 'outside' needs the plot rectangle; a raw stub (or any path that lacks the
    // constructor's padding/dimensions) falls back to the 'auto' anchor.
    const pad = this.opts.padding;
    const outside = (!tt || tt.position !== 'auto')
      && pad && Number.isFinite(this.width) && Number.isFinite(this.height);
    let left, top;
    if (outside) {
      // 'outside': keep the tooltip OFF the plot rectangle (Grafana-style); prefer beside, then above/below, else fall back to 'auto'.
      const plotL = rect.left + pad.left, plotR = rect.left + (this.width - pad.right);
      const plotT = rect.top + pad.top, canvasB = rect.top + this.height;
      if (plotR + gap + tw <= vw) {                     // right of the plot
        left = plotR + gap; top = Math.max(gap, Math.min(plotT, vh - th - gap));
      } else if (plotL - gap - tw >= 0) {               // left of the plot
        left = plotL - tw - gap; top = Math.max(gap, Math.min(plotT, vh - th - gap));
      } else if (plotT - gap - th >= 0) {               // above the plot band
        left = Math.min(Math.max(gap, hx - tw / 2), vw - tw - gap); top = plotT - th - gap;
      } else if (canvasB + gap + th <= vh) {            // below the canvas
        left = Math.min(Math.max(gap, hx - tw / 2), vw - tw - gap); top = canvasB + gap;
      } else {                                          // no room outside — anchor like 'auto'
        left = Math.min(Math.max(gap, hx - tw / 2), vw - tw - gap);
        const abovePoint = (rect.top + pointY) - th - gap;
        top = abovePoint >= gap ? abovePoint : Math.min((rect.top + pointY) + 16, vh - th - gap);
      }
    } else {
      // 'auto': centered on the sample, above it when it fits, else below.
      left = Math.min(Math.max(gap, hx - tw / 2), vw - tw - gap);
      const abovePoint = (rect.top + pointY) - th - gap;
      top = abovePoint >= gap ? abovePoint : Math.min((rect.top + pointY) + 16, vh - th - gap);
    }
    this._tooltip.style.left = left + 'px';
    this._tooltip.style.top = top + 'px';
  }

  /**
   * Invoke a caller-supplied handler, if one is registered.
   *
   * Handler exceptions are logged rather than propagated: these fire from
   * pointer handlers and the render path, where a throwing callback would
   * otherwise leave the chart mid-repaint.
   * @param {string} name - event name
   * @param {*} [payload] - event-specific payload
   * @private
   */
  _emit(name, payload) {
    const fn = this.opts.on && this.opts.on[name];
    if (typeof fn !== 'function') return;
    try { fn(payload, this); } catch (e) { if (console) console.error('MiniChart on' + name, e); }
  }

  /**
   * Queue an overlay repaint for the next frame, coalescing the several pointer
   * events a browser can deliver within one.
   * @private
   */
  _scheduleHover() {
    // destroy() cancels the live rAF + detaches the listeners; a wrapper-driven call after teardown would arm an un-cancelled frame — bail.
    if (this._destroyed) return;
    if (this._hoverRaf) return;
    this._hoverRaf = requestAnimationFrame(() => {
      this._hoverRaf = 0;
      this._drawHover();
    });
  }

  /**
   * Clear hover state: reset index, hide tooltip, repaint overlay.
   * @private
   */
  _clearHover() {
    if (this._hoverIdx !== -1) {
      this._hoverIdx = -1;
      // Drop a queued repaint: it would paint the stale index.
      if (this._hoverRaf) { cancelAnimationFrame(this._hoverRaf); this._hoverRaf = 0; }
      this._drawHover();
    }
    if (this._tooltip) this._tooltip.style.opacity = '0';
  }

  // ────────────────────────────────────────────────────────────────────
  // Accessibility
  // ────────────────────────────────────────────────────────────────────

  /**
   * Make the chart reachable and readable without a mouse: arrow keys walk the
   * samples, Enter activates, Esc clears.
   * @private
   */
  _setupA11y() {
    const c = this.canvas;
    if (!c) return;
    c.setAttribute('role', 'img');
    c.setAttribute('tabindex', '0');
    // Live region created lazily on first keyboard nav (a non-keyboard chart never pays for the node).
    this._updateA11yLabel();
    const onKey = (e) => {
      if (!this._len) return;
      let idx = this._hoverIdx;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        idx = idx <= 0 ? 0 : idx - 1;
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        idx = idx >= this._len - 1 ? this._len - 1 : idx + 1;
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this._emit('click', { index: this._hoverIdx, event: e });
        return;
      } else if (e.key === 'Escape') {
        this._clearHover();
        return;
      } else {
        return;
      }
      e.preventDefault();
      this._hoverIdx = idx;
      const rect = c.getBoundingClientRect();
      this._scheduleHover();
      this._showTooltip(idx, rect);
      this._announcePoint(idx);
      this._emit('hover', { index: idx, event: e });
    };
    c.addEventListener('keydown', onKey);
    this._onKey = onKey;
  }

  /**
   * Create the screen-reader live region on first use. A canvas is an image to
   * assistive tech, and its aria-label is announced on focus rather than on
   * every change — so arrow-key navigation alone would move the crosshair
   * silently. The live region carries the per-sample announcements instead, and
   * it is built only when the keyboard is first used to drive the chart.
   * @returns {HTMLElement|null} the live region, or null when there is no canvas
   * @private
   */
  _ensureLive() {
    if (this._liveEl) return this._liveEl;
    const c = this.canvas;
    if (!c) return null;
    const live = document.createElement('div');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('role', 'status');
    live.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;' +
      'overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0';
    (c.parentElement || document.body).appendChild(live);
    this._liveEl = live;
    return live;
  }

  /**
   * Announce the values at one data index through the live region.
   * @param {number} idx - data index
   * @private
   */
  _announcePoint(idx) {
    const live = this._ensureLive();
    if (!live) return;
    const { series } = this.opts;
    const tt = this.opts.tooltip;
    const hideZero = !tt || tt.hideZero !== false;   // match the tooltip: spare the reader the zero rows
    const visibleIdx = this._visibleSeries;
    const parts = [];
    series.forEach((s, si) => {
      if (visibleIdx && !visibleIdx.includes(si)) return;
      const v = MiniChart._dataOf(s)[idx];
      if (v == null || !Number.isFinite(v)) return;   // a gap to the renderer is a gap here too
      if (hideZero && v === 0) return;                // ...and so is an idle container when hideZero is on
      parts.push(`${s.label}: ${this._fmtY(v)}${this.opts.yUnit || ''}`);
    });
    const when = this._fmtX(idx);
    live.textContent = (when ? when + '. ' : '') + parts.join(', ');
  }

  /**
   * Refresh the canvas aria-label. Called after every data change so the
   * description a screen reader reads on focus stays accurate.
   * @private
   */
  _updateA11yLabel() {
    if (!this.canvas) return;
    const n = this.opts.series.length;
    const span = this.opts.rangeSec || 0;
    this.canvas.setAttribute(
      'aria-label',
      `Chart with ${n} series${span ? `, spanning ${span} seconds` : ''}. ` +
      `Use arrow keys to move between points; Enter to activate.`
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // Legend (clickable HTML dots for series toggle)
  // ────────────────────────────────────────────────────────────────────

  /**
   * Create this instance's legend element above the canvas.
   *
   * Always a fresh element, never a reused `.mc-legend` found in the parent:
   * two charts sharing a container would otherwise write into the same node and
   * either one's destroy() would remove the legend for both.
   * @private
   */
  _setupLegend() {
    if (!this.opts.legend) return;
    const container = this.canvas.parentElement;
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'mc-legend';
    el.style.cssText = `display:flex;flex-wrap:wrap;gap:8px 14px;margin-bottom:8px;font-size:11px;color:${this.opts.theme.legendText}`;
    container.insertBefore(el, this.canvas);
    this._legendEl = el;
  }

  /**
   * Render legend items and wire click-to-toggle. Hiding the last visible
   * series restores all of them rather than leaving an empty chart.
   * @private
   */
  _updateLegend() {
    if (!this._legendEl) return;
    const { series } = this.opts;
    const esc = MiniChart._esc;
    const active = this._visibleSeries || series.map((_, i) => i);
    this._legendEl.innerHTML = series.map((s, i) => {
      const isActive = active.includes(i);
      const color = esc(this._hexA(s.color, 1));
      return `<span data-idx="${i}" style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;user-select:none;opacity:${isActive ? 1 : 0.35}"><span style="width:8px;height:8px;border-radius:50%;background:${color}"></span>${esc(s.label)}</span>`;
    }).join('');
    this._legendEl.querySelectorAll('span[data-idx]').forEach(span => {
      span.onclick = (e) => {
        e.stopPropagation();
        const idx = parseInt(span.dataset.idx);
        if (!this._visibleSeries) this._visibleSeries = series.map((_, i) => i);
        const wasVisible = this._visibleSeries.includes(idx);
        if (wasVisible) {
          this._visibleSeries = this._visibleSeries.filter(x => x !== idx);
        } else {
          this._visibleSeries.push(idx);
        }
        if (this._visibleSeries.length === 0) this._visibleSeries = series.map((_, i) => i);
        this._activeSet = new Set(this._visibleSeries);
        // Full recalculate, not just a repaint: the Y axis is derived from the
        // visible series, so toggling one rescales it.
        this._recalc();
        this._draw();
        this._updateLegend();
        this._emit('seriesToggle', { index: idx, visible: !wasVisible });
      };
    });
  }

  /**
   * Reconcile the legend element with the current `opts.legend` and
   * `theme.legendText`. `_setupLegend` runs once at construction, so without
   * this a later `update()` that toggles `legend` or recolours `legendText` is a
   * silent no-op: the element would stay put (or never appear), and its colour —
   * baked into `cssText` at creation — would stay stale. Mirrors
   * `_applyTooltipTheme`, the existing restyle-after-update precedent.
   * @private
   */
  _syncLegend() {
    // Off → remove; the `!this._legendEl` guard in _updateLegend then no-ops.
    if (!this.opts.legend) {
      if (this._legendEl) { this._legendEl.remove(); this._legendEl = null; }
      return;
    }
    // On without an element → create it (constructor path for the initial
    // value; update() path when a caller turns the legend on after build).
    if (!this._legendEl) this._setupLegend();
    // Recolour the container — _updateLegend rewrites only child innerHTML, so a theme change would miss it.
    if (this._legendEl) this._legendEl.style.color = this.opts.theme.legendText;
  }

  // ────────────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────────────

  /**
   * Hot-swap a partial set of options without recreating the instance. Safe to
   * call from a live-data loop. Geometry-affecting keys (`series`, `labels`,
   * `rangeSec`, `type`, `yMin`/`yMax`, `yTicks`, `tension`, `padding`, `yUnit`,
   * `yFormat`, `xFormat`) trigger a full recalculate; the rest only repaint.
   * New `series`/`labels` also reset an active zoom. `theme`/`padding`/`tooltip`/
   * `on` are merged, so a partial override keeps the rest.
   * @param {Object} [newOpts] - options to merge over the current ones
   */
  update(newOpts = {}) {
    if (this._destroyed) return;
    const RECALC_KEYS = new Set([
      'series', 'labels', 'rangeSec', 'type', 'yMax', 'yMin', 'yTicks',
      'tension', 'padding', 'yUnit', 'yFormat', 'xFormat',
    ]);
    let needsRecalc = false;
    for (const key of Object.keys(newOpts)) {
      if (newOpts[key] === undefined) continue;
      // Cloned like the constructor (padding.left here pins it; omitting hands the gutter back).
      if (key === 'padding') {
        // Merged, never replaced — replacing would blank unset edges (NaN plot width).
        this.opts.padding = Object.assign({}, this.opts.padding, newOpts.padding || {});
        this._userPadLeft = (newOpts.padding && newOpts.padding.left != null)
          ? newOpts.padding.left : undefined;
      } else if (key === 'theme') {
        // Merged — replacing would set tokens undefined (silent colour bleed between draws).
        this.opts.theme = Object.assign({}, this.opts.theme, newOpts.theme || {});
        this._applyTooltipTheme();
      } else if (key === 'on') {
        // Merged like theme: adding a hover handler must not drop the ready
        // handler an earlier call set. Pass on: null to clear explicitly.
        this.opts.on = Object.assign({}, this.opts.on, newOpts.on || {});
      } else if (key === 'tooltip') {
        // Merged like padding/theme: a partial { hideZero:false } keeps position.
        this.opts.tooltip = Object.assign({}, this.opts.tooltip, newOpts.tooltip || {});
      } else {
        this.opts[key] = newOpts[key];
      }
      if (RECALC_KEYS.has(key)) needsRecalc = true;
    }
    // The live bucket ring caches the cap it was seeded with, and it is only
    // re-seeded on a resize or a viewport move — so without this, changing
    // maxSamples on a running stream would be accepted into opts and silently
    // never take effect. Apply it to the ring too, and evict at once if the
    // new cap is already exceeded (a lowered cap must free memory now, not on
    // the next push).
    if (newOpts.maxSamples !== undefined && this._stream) {
      const cap = newOpts.maxSamples > 0 ? newOpts.maxSamples : this._stream.cols * 2;
      this._stream.cap = cap;
      const labels = this.opts.labels;
      if (labels && labels.length > cap) this._streamEvict(cap);
    }
    // New data resets an active zoom (stale timestamps) + marks bounds dirty (in-place edits leave identity/length).
    if (newOpts.labels !== undefined || newOpts.series !== undefined) {
      this._viewXLocked = false;
      this._boundsDirty = true;
    }
    // A count-changing series swap leaves _visibleSeries/rings sized to the old count — fix here (_recalc doesn't own that state).
    if (newOpts.series !== undefined) {
      const n = Array.isArray(newOpts.series) ? newOpts.series.length : 0;
      if (this._visibleSeries) {
        this._visibleSeries = this._visibleSeries.filter(i => i >= 0 && i < n);
        this._activeSet = new Set(this._visibleSeries);
      }
      if (this._streams && this._streams.length > n) this._streams.length = n;
    }
    this._hoverIdx = -1;
    if (this._tooltip) this._tooltip.style.opacity = '0';
    // legend/theme.legendText aren't in RECALC_KEYS; reconcile the legend element here (gated to avoid per-update writes).
    if (newOpts.legend !== undefined || newOpts.theme !== undefined) this._syncLegend();
    this._refresh(needsRecalc);
  }

  /**
   * Append one sample to a series and re-render incrementally — the streaming
   * fast path. O(1) per push (flat in n), unlike `update()`'s full O(n) recalc.
   * Maintains per-series per-pixel-column min/max buckets over a sliding window,
   * so the repaint rebuilds only ~plotW vertices regardless of sample count.
   *
   * `type: 'bar'` can't stream (a bucket holds two extremes, not the bars in the
   * column), so it takes the full recalculate.
   *
   * @param {number} value - the new sample (null/NaN = gap); an array is a full frame (one value per series)
   * @param {number} [label] - timestamp in epoch seconds; omit for index-based
   * @param {number} [seriesIdx=0] - which series to append to (ignored for a frame)
   */
  push(value, label, seriesIdx = 0) {
    if (!this.ctx || this._destroyed) return;
    // An array is a full data frame (one value per series, one repaint) — see _pushFrame.
    if (Array.isArray(value)) return this._pushFrame(value, label);
    const s = this.opts.series[seriesIdx];
    const data = s && s.data;
    if (!data) return;
    const labels = this.opts.labels || (this.opts.labels = []);
    const t = (typeof label === 'number') ? label : (labels.length ? labels[labels.length - 1] + 1 : 0);
    if (this.opts.validate) this._validatePushLabel(t, labels);   // dev: O(1), before any mutation
    // Index-aligned (labels[i] ≡ data[i]); pad peers to grow in lockstep. sameTick reuses the last
    // row and tells _streamSample to replace (not accumulate) the bucket.
    const sameTick = labels.length > 0 && t === labels[labels.length - 1];
    const idx = sameTick ? labels.length - 1 : labels.length;
    if (!sameTick) labels.push(t);
    for (let s2 = 0; s2 < this.opts.series.length; s2++) {
      if (s2 === seriesIdx) continue;
      const d2 = MiniChart._dataOf(this.opts.series[s2]);
      if (d2 === MiniChart._EMPTY) continue;     // never mutate the shared singleton
      while (d2.length < labels.length) d2.push(null);   // gap row for the new timestamp
    }
    while (data.length < idx) data.push(null);   // this series may lag if it was added late
    if (idx < data.length) data[idx] = value;
    else data.push(value);
    // Growth changes data.length, which _ensureSeriesBounds compares against — no explicit invalidation needed.

    // Bars: one rect per sample — a min/max bucket can't carry that, so take the full recalc (not the streaming path).
    if (this.opts.type === 'bar') {
      const barCap = this.opts.maxSamples;
      if (barCap > 0 && labels.length > barCap) this._streamEvict(barCap);
      this._recalc();      // also clears _streaming, so hit-testing stays on the cached coords
      this._draw();
      return;
    }

    if (!this._streaming) this._streamEnter();
    this._streamEnsure(seriesIdx);             // (re)seed the bucket rings on first push / resize
    this._streamSample(seriesIdx, t, value, sameTick);   // O(1): one bucket update, ring-evict on scroll
    if (this._stream.cap && labels.length > this._stream.cap) this._streamEvict(this._stream.cap);
    // _len bounds hit-testing/a11y (only _recalc otherwise sets it) — keep a streamed chart hoverable.
    this._len = labels.length;
    this._streamRebuild();                      // O(plotW·series): autoscale + paths + draw
  }

  /**
   * Push one value per series for a single timestamp — an atomic data frame —
   * and repaint once. Reached from {@link MiniChart#push} when its first argument
   * is an array; a scalar `push()` stays the single-series hot path. Every series'
   * value shares one timestamp, so `labels` stays index-aligned without any peer
   * padding, and the single `_streamRebuild` at the end is what makes a frame one
   * repaint rather than one per series.
   * @param {number[]} values - one value per series, in `series` order; a missing,
   *   `undefined`, `null` or non-finite entry is a gap
   * @param {number} [label] - the shared timestamp (epoch seconds); omit for index
   * @private
   */
  _pushFrame(values, label) {
    const labels = this.opts.labels || (this.opts.labels = []);
    const t = (typeof label === 'number') ? label : (labels.length ? labels[labels.length - 1] + 1 : 0);
    if (this.opts.validate) this._validatePushLabel(t, labels);   // dev: O(1), before any mutation
    const series = this.opts.series;
    // Mirror push()'s `if (!data) return`: bail before labels.push — avoids a dangling label row / crash on the uncreated _stream.
    let placeable = false;
    for (let s0 = 0; s0 < series.length; s0++)
      if (MiniChart._dataOf(series[s0]) !== MiniChart._EMPTY) { placeable = true; break; }
    if (!placeable) return;
    // One row per series for timestamp t (same-tick overwrites; sameTick → _streamSample replaces).
    const sameTick = labels.length > 0 && t === labels[labels.length - 1];
    const idx = sameTick ? labels.length - 1 : labels.length;
    if (!sameTick) labels.push(t);
    for (let si = 0; si < series.length; si++) {
      const d = MiniChart._dataOf(series[si]);
      if (d === MiniChart._EMPTY) continue;          // a data-less series stays a gap
      while (d.length < idx) d.push(null);
      const v = (si < values.length && values[si] !== undefined) ? values[si] : null;
      if (idx < d.length) d[idx] = v;
      else d.push(v);
    }
    // Bars can't stream (a bucket holds two extremes, not the bars) → full recalc.
    if (this.opts.type === 'bar') {
      const barCap = this.opts.maxSamples;
      if (barCap > 0 && labels.length > barCap) this._streamEvict(barCap);
      this._recalc();
      this._draw();
      return;
    }
    if (!this._streaming) this._streamEnter();
    for (let si = 0; si < series.length; si++) {
      if (MiniChart._dataOf(series[si]) === MiniChart._EMPTY) continue;   // data-less: no bucket
      this._streamEnsure(si);                        // first call seeds every series' ring
      const v = (si < values.length && values[si] !== undefined) ? values[si] : null;
      this._streamSample(si, t, v, sameTick);        // null/non-finite → a gap column
    }
    if (this._stream.cap && labels.length > this._stream.cap) this._streamEvict(this._stream.cap);
    this._len = labels.length;
    this._streamRebuild();                           // ONE rebuild for the whole frame
  }

  /**
   * Enter streaming mode on the first push past the last full `_recalc`. Clears
   * the stale batch coords (nothing rebuilds them in stream mode) and routes
   * hit-testing through `labels`/time, since the index fallback searches coords
   * stream mode no longer maintains.
   * @private
   */
  _streamEnter() {
    this._coordsX = [];
    this._coordsY = [];
    this._coordsI = [];
    this._useTime = true;
    this._streaming = true;
  }

  /**
   * Lazily create (or re-seed after a resize / viewport change) the streaming
   * state: one shared sliding window plus a per-series bucket ring, seeded from
   * the current data. Seeding is O(n·series) but runs only outside the per-push
   * hot path — which is what keeps push() flat in n.
   * @private
   */
  _streamEnsure(si) {
    const padding = this.opts.padding;
    const cols = Math.max(2, Math.floor(this.width - padding.left - padding.right));
    const data0 = MiniChart._dataOf(this.opts.series[si]);
    if (!data0.length) return;
    const labels = this.opts.labels || [];
    let winStart = this._viewXMin, winEnd = this._viewXMax;
    let winSpan = winEnd - winStart;
    // Empty-start chart has a degenerate viewport (~1) — size the window from rangeSec, else the sample count.
    if (!(winSpan > 1)) {
      const span = (this.opts.rangeSec && this.opts.rangeSec > 0) ? this.opts.rangeSec : Math.max(1, data0.length);
      const lastT = labels.length ? labels[labels.length - 1] : 0;
      winStart = lastT - span; winEnd = lastT; winSpan = span;
    }
    const w = this._stream;
    // (Re)seed when the canvas resized or the viewport (setXRange) moved.
    if (!w || w.cols !== cols || w.winSpan !== winSpan) {
      // Cap floored at cols*2 (≈2/column): an empty-start seeds one sample, so data-length alone would evict before drawing.
      const cap = Math.max(
        data0.length,
        this.opts.maxSamples > 0 ? this.opts.maxSamples : cols * 2);
      this._stream = { cols, head: 0, winStart, winEnd, winSpan, colDt: winSpan / cols, cap };
      this._streams = [];
      for (let s2 = 0; s2 < this.opts.series.length; s2++) this._seedSeries(s2);
    }
  }

  /** Seed one series' bucket ring from its current data. O(n). @private */
  _seedSeries(si) {
    const w = this._stream, cols = w.cols, colDt = w.colDt, winStart = w.winStart;
    const data = MiniChart._dataOf(this.opts.series[si]);
    const labels = this.opts.labels || [];
    const bk = { vMin: new Float64Array(cols), vMax: new Float64Array(cols), cnt: new Int32Array(cols) };
    for (let i = 0; i < cols; i++) { bk.vMin[i] = Infinity; bk.vMax[i] = -Infinity; }
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (!Number.isFinite(v)) continue;
      const tt = (i < labels.length && typeof labels[i] === 'number') ? labels[i]
        : winStart + (i / (data.length - 1 || 1)) * w.winSpan;
      let c = Math.floor((tt - winStart) / colDt);
      if (c < 0) c = 0; else if (c >= cols) c = cols - 1;
      if (bk.cnt[c] === 0) { bk.vMin[c] = v; bk.vMax[c] = v; }
      else { if (v < bk.vMin[c]) bk.vMin[c] = v; if (v > bk.vMax[c]) bk.vMax[c] = v; }
      bk.cnt[c]++;
    }
    this._streams[si] = bk;
  }

  /**
   * Drop one sample into its pixel-column bucket, scrolling the shared window
   * (ring) when the sample is newer than the current right edge. Every series'
   * bucket at a column that left the window is reset. O(1) amortized.
   * @private
   */
  _streamSample(si, t, v, reset = false) {
    const w = this._stream;
    // A gap still advances the window: a null tick is a real moment with no
    // reading, so time moves and the dropout scrolls in as a blank column.
    if (!Number.isFinite(t)) return;     // a non-timestamp can't place a column
    if (t >= w.winEnd) {
      let adv = Math.floor((t - w.winEnd) / w.colDt) + 1;
      if (adv >= w.cols) {
        // Whole-window jump: reset all buckets, snap to the sample. Never loop `adv` (O(t/colDt)).
        for (let s2 = 0; s2 < this._streams.length; s2++) {
          const bk = this._streams[s2]; if (!bk) continue;
          for (let i = 0; i < w.cols; i++) { bk.vMin[i] = Infinity; bk.vMax[i] = -Infinity; bk.cnt[i] = 0; }
        }
        w.head = 0;
        w.winStart = t - w.winSpan + w.colDt;
      } else {
        for (let i = 0; i < adv; i++) {
          const e = w.head;
          for (let s2 = 0; s2 < this._streams.length; s2++) {
            const bk = this._streams[s2];
            if (bk) { bk.vMin[e] = Infinity; bk.vMax[e] = -Infinity; bk.cnt[e] = 0; }
          }
          w.head = (w.head + 1) % w.cols;
        }
        w.winStart += adv * w.colDt;
      }
      w.winEnd = w.winStart + w.winSpan;
      this._viewXMin = w.winStart; this._viewXMax = w.winEnd;
      this._tMin = w.winStart; this._tMax = w.winEnd;
    }
    let c = Math.floor((t - w.winStart) / w.colDt);
    if (c < 0) c = 0; else if (c >= w.cols) c = w.cols - 1;
    const idx = (w.head + c) % w.cols;
    const bk = this._streams[si];
    // sameTick re-push → bucket must replace, not accumulate (else the superseded value paints a stale band).
    // Reset before the gap guard so a re-pushed gap also erases; the accumulate below refills a finite value.
    if (reset) { bk.cnt[idx] = 0; bk.vMin[idx] = Infinity; bk.vMax[idx] = -Infinity; }
    if (!Number.isFinite(v)) return;     // a gap: the column scrolled, but gets no sample this tick
    if (bk.cnt[idx] === 0) { bk.vMin[idx] = v; bk.vMax[idx] = v; }
    else { if (v < bk.vMin[idx]) bk.vMin[idx] = v; if (v > bk.vMax[idx]) bk.vMax[idx] = v; }
    bk.cnt[idx]++;
  }

  /**
   * Drop the oldest samples from `labels`/`data` once the cap is exceeded,
   * bounding memory for an indefinitely-running stream. Amortized O(1)/push.
   *
   * Buckets forget by TIME (a column resets when the ring scrolls in
   * `_streamSample`), so eviction — armed by sample COUNT — must trim only rows
   * already left of the window (`labels[i] < winStart`); trimming on-screen rows
   * would leave ghost min/max in the buckets that the source arrays no longer
   * hold. Bars/batch have no buckets (`_recalc` nulls `_stream`), so they keep
   * the unconditional front-trim.
   * @param {number} cap - sample-count threshold that arms the check
   * @private
   */
  _streamEvict(cap) {
    let drop = Math.max(1, Math.floor(cap * 0.1));
    const w = this._stream;
    if (w && this._streams) {                 // streaming (bucket) mode; bars/batch have no _streams
      const labels = this.opts.labels, winStart = w.winStart;
      let offWin = 0;
      while (offWin < drop && offWin < labels.length && labels[offWin] < winStart) offWin++;
      if (offWin === 0) return;               // nothing scrolled off yet: evicting on-screen rows would ghost the buckets
      drop = offWin;
    }
    this.opts.labels.splice(0, drop);
    for (const s of this.opts.series) {
      if (s && s.data && s.data.splice) s.data.splice(0, drop);
      // notes is index-aligned with data — shift it too, or the annotation pins to the wrong sample.
      if (s && s.notes && s.notes.splice) s.notes.splice(0, drop);
    }
    // Every survivor moved `drop` left — shift _hoverIdx to keep pointing at the same sample.
    if (this._hoverIdx >= 0) {
      this._hoverIdx -= drop;
      // Hovered sample fell out of the window — clear (caller repaints anyway).
      if (this._hoverIdx < 0) {
        this._hoverIdx = -1;
        if (this._tooltip) this._tooltip.style.opacity = '0';
      }
    }
  }

  /**
   * Recompute the Y bounds from every visible series' buckets, rebuild each
   * series' stroke and area-fill Path2D from its buckets, then paint.
   * O(plotW·series): the cost tracks canvas width and series count, not how many
   * samples arrived — which is what keeps a streaming chart in budget at any n.
   * @private
   */
  _streamRebuild() {
    const w = this._stream, cols = w.cols;
    const padding = this.opts.padding;
    const active = this._activeSet;
    // ── Y axis bounds ──
    // opts.yMin/yMax pin an end exactly (same as _recalc); null = data-driven + 10% headroom.
    const { yMin, yMax } = this.opts;
    let autoMin = yMin == null, autoMax = yMax == null;
    let lo = Infinity, hi = -Infinity;
    for (let si = 0; si < this._streams.length; si++) {
      if (active && !active.has(si)) continue;
      const bk = this._streams[si];
      if (!bk) continue;
      for (let i = 0; i < cols; i++) if (bk.cnt[i]) { if (bk.vMin[i] < lo) lo = bk.vMin[i]; if (bk.vMax[i] > hi) hi = bk.vMax[i]; }
    }
    if (lo === Infinity) { lo = 0; hi = 1; }
    let yMinVal = autoMin ? lo : yMin;
    let yMaxVal = autoMax ? hi : yMax;
    // A pinned end the data has outgrown would invert the axis; relax it to the
    // data and treat that side as auto from here (mirrors _recalc).
    if (!autoMin && yMinVal > hi) { yMinVal = lo; autoMin = true; }
    if (!autoMax && yMaxVal < lo) { yMaxVal = hi; autoMax = true; }
    const span = (hi - lo) || 1;
    if (autoMax) yMaxVal += span * 0.1;            // headroom only on derived ends
    if (autoMin) yMinVal -= span * 0.1;
    if (autoMin && lo >= 0 && yMinVal < 0) yMinVal = 0;   // don't invent negatives for non-negative data
    if (yMaxVal <= yMinVal) yMaxVal = yMinVal + (span || 1);   // guard the projection invariant max > min
    this.yRange = { min: yMinVal, max: yMaxVal };
    // Streaming bypasses _recalc, so re-measure the gutter here; grow-only (a change re-seeds the ring).
    if (this._userPadLeft == null) {
      const ctx = this.ctx;
      ctx.font = '10px -apple-system, system-ui, sans-serif';
      const want = Math.max(28, Math.ceil(Math.max(
        ctx.measureText(this._fmtY(yMaxVal)).width,
        ctx.measureText(this._fmtY(yMinVal)).width,
      )) + 10);
      if (want > padding.left) padding.left = want;
    }
    const plotW = Math.max(1, this.width - padding.left - padding.right);
    const plotH = Math.max(1, this.height - padding.top - padding.bottom);
    const colW = plotW / cols;
    const ySpan = (yMaxVal - yMinVal) || 1;
    const baseY = (yMinVal <= 0 && yMaxVal >= 0)
      ? padding.top + plotH - ((0 - yMinVal) / ySpan) * plotH
      : (yMinVal > 0 ? padding.top + plotH : padding.top);
    this._paths = []; this._fillPaths = [];
    for (let si = 0; si < this.opts.series.length; si++) {
      const bk = this._streams[si];
      const path = new Path2D(), fill = new Path2D();
      this._paths[si] = path; this._fillPaths[si] = fill;
      if (!bk) continue;
      // Envelope drawn straight (ignoring tension) — a vMax/vMin band breaks the batch spline. Use update() to smooth.
      let started = false, firstX = 0, lastX = 0;
      for (let c = 0; c < cols; c++) {
        const idx = (w.head + c) % cols;
        if (!bk.cnt[idx]) { started = false; continue; }   // empty column → pen lifts
        const x = padding.left + (c + 0.5) * colW;
        const yTop = padding.top + plotH - ((bk.vMax[idx] - yMinVal) / ySpan) * plotH;
        const yBot = padding.top + plotH - ((bk.vMin[idx] - yMinVal) / ySpan) * plotH;
        if (!started) { path.moveTo(x, yTop); fill.moveTo(x, baseY); fill.lineTo(x, yTop); firstX = x; started = true; }
        else { path.lineTo(x, yTop); fill.lineTo(x, yTop); }
        path.lineTo(x, yBot); fill.lineTo(x, yBot);
        lastX = x;
      }
      // The area closes the traced line back to the baseline; the stroke stays open.
      if (started) { fill.lineTo(lastX, baseY); fill.lineTo(firstX, baseY); fill.closePath(); }
    }
    this._draw();
  }

  /**
   * Repaint from the cached geometry, without rebuilding it — cheap (flat in n).
   * Use for changes that alter appearance but not point positions: a container
   * that was hidden at build (this sizes it, the one case that rebuilds), a
   * canvas cleared externally, or a manual redraw. Data/size changes must go
   * through `update()` or the resize path — this deliberately re-projects nothing.
   */
  repaint() {
    if (!this.ctx) return;   // destroyed
    // Never-sized build (no RO, layout wait gave up): size now — the case this method exists for (_draw bails without a width).
    if (!this._ctxReady && this._applyDPR) { this._applyDPR(); return; }
    this._refresh(false);
  }

  /**
   * Set which series are visible. An empty or omitted list shows all of them,
   * matching what the legend does when the last visible series is switched off.
   * @param {number[]} indices - series indices to show
   */
  setVisibleSeries(indices) {
    if (this._destroyed) return;
    const all = this.opts.series.map((_, i) => i);
    this._visibleSeries = (!indices || indices.length === 0) ? all : indices.slice();
    this._activeSet = new Set(this._visibleSeries);
    // Recalculate rather than repaint: the Y axis follows the visible set.
    this._recalc();
    this._draw();
    this._updateLegend();
  }

  /**
   * Narrow the visible X window. Bounds are clamped into the data domain and
   * swapped if given in the wrong order; null, or any non-finite value, resets
   * to the full domain.
   *
   * Pair with getXRange() to drive a minimap or keep several charts on the same
   * window.
   * @param {number|null} min - left edge, same units as `labels`
   * @param {number|null} max - right edge
   */
  setXRange(min, max) {
    if (this._destroyed) return;
    // Streaming owns the viewport (the window advances every push) — warn + ignore, don't silently unwind.
    if (this._streaming) {
      console.warn('MiniChart: setXRange() is ignored while streaming (push() follows the data). Call update() to return to a manual range.');
      return;
    }
    // NaN/±Infinity reset (applying would NaN every projection downstream).
    if (min == null || max == null || !Number.isFinite(min) || !Number.isFinite(max)) {
      this._viewXLocked = false;
    } else {
      let lo = Math.min(min, max), hi = Math.max(min, max);
      lo = Math.max(this._dataXMin, Math.min(lo, this._dataXMax));
      hi = Math.max(lo, Math.min(hi, this._dataXMax));
      // A zero-width window would divide by zero in the projection; widen it
      // to a small slice around the requested point instead.
      if (hi - lo < 1e-9) {
        const c = (lo + hi) / 2;
        lo = Math.max(this._dataXMin, c - (this._dataXMax - this._dataXMin) * 0.01);
        hi = Math.min(this._dataXMax, c + (this._dataXMax - this._dataXMin) * 0.01);
      }
      this._viewXMin = lo;
      this._viewXMax = hi;
      this._viewXLocked = true;
    }
    this._hoverIdx = -1;
    if (this._tooltip) this._tooltip.style.opacity = '0';
    this._recalc();
    this._draw();
  }

  /**
   * Current viewport and the full data domain.
   * @returns {{view:{min:number,max:number}, domain:{min:number,max:number}}}
   */
  getXRange() {
    if (this._destroyed) return null;
    return {
      view: { min: this._viewXMin, max: this._viewXMax },
      domain: { min: this._dataXMin, max: this._dataXMax },
    };
  }

  /**
   * Pixel X of a data index on the canvas, in CSS pixels, or `null` when the
   * index has no projectable position (an index-axis chart, or a label the
   * projection rejects). The public projection hook for custom tooltips,
   * cursors and markers — prefer it over the `_`-prefixed internals, which are
   * renamed in the minified build.
   * @param {number} idx - data index
   * @returns {number|null}
   */
  xPixelForIndex(idx) {
    return this._xPixelForIndex(idx);
  }

  /**
   * The 2D context of the transparent overlay canvas stacked above the data
   * canvas (already DPR-scaled, so draw in CSS pixels), or `null` when the chart
   * has no overlay — a canvas with no parent element. Custom overlays (threshold
   * lines, annotations, a cross-chart synced cursor) draw here so they sit above
   * the series without re-rendering them. It is cleared on every hover and
   * repaint, so a persistent overlay must be redrawn after each paint.
   * @returns {CanvasRenderingContext2D|null}
   */
  getOverlayContext() {
    return this._octx;
  }

  /**
   * Release everything the chart holds: frames, observers, listeners and DOM
   * nodes. Idempotent — a second call is a no-op.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    // Cancel every pending frame first: each closes over the instance, so an uncancelled callback paints a detached canvas and pins the data.
    if (this._layoutPollRaf) { cancelAnimationFrame(this._layoutPollRaf); this._layoutPollRaf = 0; }
    if (this._hoverRaf) { cancelAnimationFrame(this._hoverRaf); this._hoverRaf = 0; }
    if (this._roRaf) { cancelAnimationFrame(this._roRaf); this._roRaf = 0; }
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    else window.removeEventListener('resize', this._applyDPR);
    if (this._dprMql) {
      if (this._dprMql.removeEventListener) this._dprMql.removeEventListener('change', this._onDpr);
      else if (this._dprMql.removeListener) this._dprMql.removeListener(this._onDpr);
      this._dprMql = null;
    }
    const moveType = this._pointerEvt === 'pointer' ? 'pointermove' : 'mousemove';
    const leaveType = this._pointerEvt === 'pointer' ? 'pointerleave' : 'mouseleave';
    this.canvas.removeEventListener(moveType, this._onMove);
    this.canvas.removeEventListener(leaveType, this._onLeave);
    this.canvas.removeEventListener('click', this._onClick);
    if (this._onKey) this.canvas.removeEventListener('keydown', this._onKey);
    if (this._overlay) { this._overlay.remove(); this._overlay = null; this._octx = null; }
    // Ref-counted undo: only the last overlay sharing this parent, and only if this class flipped it to `relative`, restores `position`.
    if (this._parentRef) {
      const rec = MiniChart._parentRel.get(this._parentRef);
      if (rec && --rec.count <= 0) {
        if (rec.set) this._parentRef.style.position = '';
        MiniChart._parentRel.delete(this._parentRef);
      }
      this._parentRef = null;
    }
    if (this._tooltip) { this._tooltip.remove(); this._tooltip = null; }
    if (this._legendEl) { this._legendEl.remove(); this._legendEl = null; }
    if (this._liveEl) { this._liveEl.remove(); this._liveEl = null; }
    // Drop every remaining reference so a caller holding the instance can't keep the data arrays alive.
    this.canvas = null;
    this.ctx = null;
    this.opts = null;
    this._paths = null;
    this._fillPaths = null;
    this._coordsX = null;
    this._coordsY = null;
    this._coordsI = null;
    this._cnt = null;
    this._bufX = null;
    this._bufY = null;
    this._bufI = null;
    this._activeSet = null;
    this._onMove = null;
    this._onLeave = null;
    this._onClick = null;
    this._onKey = null;
    this._onDpr = null;
    this._applyDPR = null;
    this._colorProbe = null;
    // These also retain live data arrays (_sbRef, the bucket rings, the runs) — nulling them is what actually frees the heap.
    this._sbRef = null;
    this._sbMin = null;
    this._sbMax = null;
    this._sbLen = null;
    this._stream = null;
    this._streams = null;
    this._runs = null;
    this._visibleSeries = null;
  }

  // ────────────────────────────────────────────────────────────────────
  // Formatting helpers
  // ────────────────────────────────────────────────────────────────────

  /**
   * Format a Y value for axis labels and the tooltip.
   *
   * `yFormat` is the extension point; the built-in `yUnit` cases below are
   * legacy conveniences kept for existing callers. New code should pass a
   * formatter rather than teach this method another unit.
   * @param {number|null} v - value to format
   * @returns {string} formatted label
   * @private
   */
  _fmtY(v) {
    if (v == null) return '—';
    const fmt = this.opts.yFormat;
    if (typeof fmt === 'function') {
      // A throwing formatter falls back to the default rather than taking the
      // whole render down with it — this runs inside the draw path.
      try { return fmt(v, this); } catch (_) { /* fall through to default */ }
    }
    const u = this.opts.yUnit || '';
    // Switches the whole axis to GB together, so labels stay comparable
    // instead of mixing units between ticks.
    if (u === 'MB') {
      if (this.yRange && this.yRange.max > 1024) return (v / 1024).toFixed(1);
      return Math.round(v).toString();
    }
    if (u === 'MB/s') {
      if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
      if (v >= 100) return Math.round(v).toString();
      return (Math.round(v * 10) / 10).toString();
    }
    if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + 'k';
    if (Math.abs(v) >= 100) return Math.round(v).toString();
    return (Math.round(v * 10) / 10).toString();
  }

  /**
   * Format an X label. Precision follows the visible span, so a one-minute
   * window shows seconds and a one-year window shows dates:
   *   ≤ 30 min  → HH:MM:SS
   *   ≤ 24 h    → HH:MM
   *   ≤ 4 weeks → DD.MM HH:MM
   *   beyond    → DD.MM.YY
   *
   * `xFormat` overrides this: a function for full control, or 'number' to treat
   * labels as plain numbers rather than timestamps.
   * @param {number} i - data index
   * @returns {string} formatted label, empty when the index has no label
   * @private
   */
  _fmtX(i) {
    const labels = this.opts.labels;
    const xFormat = this.opts.xFormat;
    if (typeof xFormat === 'function' && labels && labels[i] != null) {
      return xFormat(labels[i], i, this);
    }
    // `!= null` rather than a truthiness test: epoch 0 is a valid timestamp.
    if (labels && labels[i] != null) {
      const ts = labels[i];
      if (xFormat === 'number') return String(ts);
      // Labels are epoch seconds; Date takes milliseconds.
      const d = new Date(ts * 1000);
      const range = this.opts.rangeSec || 3600;
      if (range <= 86400) {
        return range <= 1800
          ? d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          : d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
      } else if (range <= 604800 * 4) {
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const time = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
        return `${dd}.${mm} ${time}`;
      } else {
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const yy = String(d.getFullYear()).slice(2);
        return `${dd}.${mm}.${yy}`;
      }
    }
    return '';
  }

  /**
   * Convert a CSS colour to rgba() at the given alpha.
   *
   * Unparseable input degrades to neutral grey. It must not throw: the result
   * feeds addColorStop, which rejects malformed colours with an exception that
   * would abort the entire repaint over one bad series colour.
   * @param {string} color - #rgb, #rrggbb, rgb(), rgba(), or a named colour
   * @param {number} alpha - opacity 0..1
   * @returns {string} rgba(r, g, b, alpha)
   * @private
   */
  _hexA(color, alpha) {
    const rgb = this._parseColor(color);
    if (!rgb) return `rgba(128,128,128,${alpha})`;
    return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
  }

  /**
   * Parse a CSS colour into [r, g, b], or null if it cannot be understood.
   * @param {*} color - candidate colour value
   * @returns {[number, number, number]|null}
   * @private
   */
  _parseColor(color) {
    if (typeof color !== 'string') return null;
    const c = color.trim();
    if (!c) return null;
    let m;
    if ((m = c.match(/^#([0-9a-f]{3})$/i))) {
      return [
        parseInt(m[1][0] + m[1][0], 16),
        parseInt(m[1][1] + m[1][1], 16),
        parseInt(m[1][2] + m[1][2], 16),
      ];
    }
    if ((m = c.match(/^#([0-9a-f]{6})$/i))) {
      return [
        parseInt(m[1].slice(0, 2), 16),
        parseInt(m[1].slice(2, 4), 16),
        parseInt(m[1].slice(4, 6), 16),
      ];
    }
    if ((m = c.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i))) {
      return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
    }
    // Named colours / hsl() etc. go through the browser's CSS parser (probe canvas cached per instance).
    try {
      if (!this._colorProbe) {
        const probe = document.createElement('canvas');
        probe.width = probe.height = 1;
        this._colorProbe = probe.getContext('2d');
      }
      const ctx = this._colorProbe;
      ctx.fillStyle = '#000';
      ctx.fillStyle = c;
      const out = ctx.fillStyle;
      if (/^#([0-9a-f]{6})$/i.test(out)) {
        return [
          parseInt(out.slice(1, 3), 16),
          parseInt(out.slice(3, 5), 16),
          parseInt(out.slice(5, 7), 16),
        ];
      }
    } catch (_) { /* fall through */ }
    return null;
  }

  /**
   * A series' samples, or a shared empty array when it has none.
   *
   * `data` is the one field every render path dereferences, and a series
   * assembled from a failed fetch or a partly-filled template routinely arrives
   * without it. Reading `.length` off that directly threw a TypeError out of the
   * constructor, taking down the whole chart — including the series alongside it
   * that were perfectly well-formed. One malformed entry should render as
   * nothing, not as a blank page.
   * @param {*} s - series object
   * @returns {Array|TypedArray} samples, possibly empty
   * @private
   */
  static _dataOf(s) {
    const d = s && s.data;
    // Array-like (typed array / any indexed collection) passes through; `object` excludes strings
    // (walked char-by-char otherwise).
    return (d && typeof d === 'object' && typeof d.length === 'number')
      ? d : MiniChart._EMPTY;
  }

  /**
   * Escape a string for interpolation into the tooltip and legend markup.
   *
   * Series labels and notes carry host-controlled text — interface names, mount
   * points, process names — so anything reaching innerHTML goes through here.
   * @param {*} s - value to escape
   * @returns {string} HTML-safe string
   * @private
   */
  static _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}

// Shared stand-in for a series with no data. Class-attached (a module-level const would clash in a plain <script>).
MiniChart._EMPTY = [];

// Ref-counts, per parent, the charts sharing it as a containing block — `position` restored only when the
// last overlay leaves (keyed by element → a detached parent is GC'd, not leaked).
MiniChart._parentRel = new WeakMap();

// ─────────────────────────────────────────────────────────────────────────────
// Module footer — everything below the marker is replaced in the ESM build.
//
// This file is the <script>/CommonJS entry: it publishes a global and assigns
// module.exports, each guarded so loading it either way is safe. A real
// `export` statement cannot live here, because `export` is static syntax and
// its mere presence would make the file unloadable as a plain <script>.
// build/minify.js generates dist/minichart.mjs by swapping this block for an
// `export default`, so bundlers get genuine ESM instead of a file that silently
// exports nothing.
// @module-footer
if (typeof window !== 'undefined') window.MiniChart = MiniChart;
if (typeof module !== 'undefined' && module.exports) module.exports = MiniChart;

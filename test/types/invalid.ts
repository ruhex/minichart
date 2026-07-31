/**
 * Every line here must FAIL to compile. Without this half, the valid fixture
 * would still pass if the declarations collapsed to `any` — a type test that
 * cannot fail proves nothing.
 *
 * The runner matches each `@expect-error` against the line tsc reports.
 */
import MiniChart from '../../minichart.js';

declare const canvas: HTMLCanvasElement;

// @expect-error TS2322 — data holds numbers, not strings
new MiniChart(canvas, { series: [{ label: 'x', color: '#fff', data: ['nope'] }] });

// @expect-error TS2322 — yTicks is a number
new MiniChart(canvas, { series: [], yTicks: 'four' });

// @expect-error TS2561 — misspelled option name
new MiniChart(canvas, { series: [], yTikcs: 4 });

// @expect-error TS2345 — setXRange takes numbers or null
new MiniChart(canvas).setXRange('a', 'b');

// @expect-error TS2339 — no such method
new MiniChart(canvas).noSuchMethod();

// @expect-error TS2339 — _scales was removed from the implementation
new MiniChart(canvas)._scales;

// @expect-error TS2322 — theme tokens are strings
new MiniChart(canvas, { series: [], theme: { grid: 42 } });

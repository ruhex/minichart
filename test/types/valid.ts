/**
 * Everything here must compile under `strict`. If a declaration drifts away
 * from the implementation, this is where it shows up.
 */
import MiniChart, {
  MiniChartOptions, MiniChartSeries, MiniChartTheme, MiniChartXRange,
} from '../../minichart.js';

declare const canvas: HTMLCanvasElement;

// `MiniChart` must work as a *type*, not only as a value: framework code stores
// the instance in a typed ref, e.g. `useRef<MiniChart | null>(null)`.
let instance: MiniChart | null = null;

const series: MiniChartSeries[] = [
  { label: 'cpu', color: '#3fb950', data: [1, 2, null, 4] },
  { label: 'io', color: 'rgba(88,166,255,1)', data: [0.5], notes: ['idle', null] },
];

const theme: Partial<MiniChartTheme> = { grid: '#333', axisLabel: '#888' };

const opts: MiniChartOptions = {
  type: 'line',
  series,
  labels: [1, 2, 3, 4],
  rangeSec: 120,
  yMin: 0,
  yMax: null,
  yUnit: '%',
  yTicks: 4,
  tension: 0.5,
  fill: true,
  padding: { top: 12, left: 40 },
  legend: true,
  theme,
  xFormat: (t: number, i: number) => `${t}/${i}`,
  yFormat: (v: number) => v.toFixed(1),
  on: {
    ready: () => {},
    hover: ({ index }) => { const n: number = index; void n; },
    click: ({ index }) => { void index; },
    seriesToggle: ({ index, visible }) => { void index; const b: boolean = visible; void b; },
  },
};

instance = new MiniChart(canvas, opts);

// Optional options object.
const bare = new MiniChart(canvas);

instance.update({ series, yMax: 100 });
instance.setVisibleSeries([0, 2]);
instance.setXRange(1, 4);
instance.setXRange(null, null);

const range: MiniChartXRange = instance.getXRange();
const viewMin: number = range.view.min;
const domainMax: number = range.domain.max;
void viewMin; void domainMax;

const w: number = instance.width;
const yMax: number = instance.yRange.max;
void w; void yMax;

instance.destroy();
bare.destroy();
instance = null;

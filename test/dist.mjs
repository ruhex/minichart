#!/usr/bin/env node
/**
 * Verify the published artefacts, not the source.
 *
 * Every other suite exercises minichart.js directly, so all of them passed
 * while `import MiniChart from 'minichart'` resolved to nothing: the package
 * pointed bundlers at a file with no `export` statement, and an ESM import of
 * it fails outright. Packaging is its own failure surface and needs its own
 * tests — these load each entry point the way its consumer will.
 *
 * Run with: `npm run test:dist` (implied by `npm test`).
 */
import { chromium } from 'playwright';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync } from 'fs';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

console.log('\nPackage entry points:');

// Every path package.json advertises must exist, or installs break in ways
// that only surface in the consumer's build.
// Read from package.json rather than a hand-kept list, so dropping or adding a
// resolution field can never leave this test asserting against a field that is
// gone (it used to name PKG.module/browser/unpkg directly and crashed on
// undefined the moment those were removed).
const advertised = [
  PKG.main, PKG.module, PKG.browser, PKG.unpkg, PKG.jsdelivr, PKG.types,
  ...Object.values(PKG.exports['.']),
  ...Object.values(PKG.exports).filter((v) => typeof v === 'string'),
].filter(Boolean);
for (const rel of [...new Set(advertised)]) {
  check(`${rel} exists`, existsSync(join(ROOT, rel)), 'declared in package.json but missing');
}

// ── CommonJS ─────────────────────────────────────────────────────────────────
{
  const CJS = require(join(ROOT, PKG.main));
  check('require() returns the class',
        typeof CJS === 'function' && CJS.name === 'MiniChart',
        `got ${typeof CJS}`);
}

// ── ESM (what Vite / webpack / Rollup resolve) ───────────────────────────────
{
  let mod = null, err = null;
  // exports['.'].import is what a bundler actually resolves; the legacy
  // `module` field is optional and may not be declared at all.
  try { mod = await import(pathToFileURL(join(ROOT, PKG.exports['.'].import)).href); }
  catch (e) { err = e; }
  check('ESM build has a default export',
        !!mod && typeof mod.default === 'function' && mod.default.name === 'MiniChart',
        err ? err.message : `default is ${mod && typeof mod.default}`);
  check('ESM build has a named export',
        !!mod && typeof mod.MiniChart === 'function',
        err ? err.message : 'MiniChart missing from the module namespace');
}

// ── Minified bundles ─────────────────────────────────────────────────────────
console.log('\nMinified bundles:');
for (const rel of ['dist/minichart.min.js']) {
  const code = readFileSync(join(ROOT, rel), 'utf8');
  check(`${rel} carries the version banner`,
        code.startsWith(`/*! MiniChart v${PKG.version}`),
        'first bytes: ' + JSON.stringify(code.slice(0, 60)));
  check(`${rel} is actually minified`,
        code.length < readFileSync(join(ROOT, 'minichart.js'), 'utf8').length / 2,
        `${code.length} bytes`);
}

// ── The minified script build in a real browser ──────────────────────────────
console.log('\nBrowser (dist/minichart.min.js via <script>):');
{
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 400 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.setContent(`<!doctype html><body style="margin:0">
    <div id="host" style="width:800px;height:200px">
      <canvas id="c" style="width:800px;height:200px;display:block"></canvas>
    </div></body>`);
  await page.addScriptTag({ path: join(ROOT, 'dist/minichart.min.js') });

  const r = await page.evaluate(() => {
    if (typeof window.MiniChart !== 'function') return { global: false };
    const n = 500, now = 1700000000, labels = [], data = [];
    for (let i = 0; i < n; i++) { labels.push(now - n + i); data.push(50 + Math.sin(i / 20) * 40); }
    const ch = new window.MiniChart(document.getElementById('c'), {
      series: [{ label: 'cpu', data, color: '#3fb950' }],
      labels, rangeSec: n, yUnit: '%',
    });
    // The bundle must render, not merely construct: a mangling mistake shows up
    // as an empty canvas rather than as an exception.
    const cv = ch.canvas, ctx = cv.getContext('2d');
    const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let painted = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 40) { if (++painted > 500) break; }
    const api = ['update', 'setVisibleSeries', 'setXRange', 'getXRange', 'destroy',
                 'xPixelForIndex', 'getOverlayContext']
      .every((m) => typeof ch[m] === 'function');
    // The two extension hooks must work, not just exist — a time-axis chart
    // projects index 0 to a finite pixel, and a canvas with a parent has an overlay.
    const xPix = ch.xPixelForIndex(0);
    const hasOverlay = !!ch.getOverlayContext();
    ch.destroy();
    return { global: true, painted, api, xPix, hasOverlay };
  });

  check('sets window.MiniChart', r.global === true);
  check('renders from the minified bundle', r.painted > 500, `painted ${r.painted} pixels`);
  check('public API survives mangling', r.api === true);
  check('xPixelForIndex projects a point (survives mangling)', Number.isFinite(r.xPix), `xPix=${r.xPix}`);
  check('getOverlayContext returns a context (survives mangling)', r.hasOverlay === true);
  check('no console or page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

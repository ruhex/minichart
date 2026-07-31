#!/usr/bin/env node
/**
 * Type-check minichart.d.ts against real usage.
 *
 * The declarations are shipped to every TypeScript consumer, so a field that
 * exists only in the .d.ts is a lie the compiler will happily propagate: the
 * code compiles, and the value is `undefined` at runtime. That is exactly what
 * happened to `_scales`, which outlived its implementation.
 *
 * Two fixtures, because one alone proves little:
 *   valid.ts    must compile clean under `strict`
 *   invalid.ts  every `@expect-error` line must actually be rejected — this is
 *               what fails if the declarations degrade to `any`
 *
 * Run with: `npm run test:types` (implied by `npm test`).
 */
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FIXTURES = join(__dirname, 'types');
const TSC = join(ROOT, 'node_modules', '.bin', 'tsc');

let passed = 0, failed = 0;
const say = (ok, name, detail) => {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
};

/** Run tsc over one fixture, return its diagnostics as {line, code} records. */
function typeCheck(file) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-types-'));
  const cfg = join(dir, 'tsconfig.json');
  writeFileSync(cfg, JSON.stringify({
    compilerOptions: {
      target: 'ES2020', module: 'ESNext', moduleResolution: 'bundler',
      strict: true, noEmit: true, skipLibCheck: true,
      lib: ['ES2020', 'DOM'], types: [],
    },
    files: [join(FIXTURES, file)],
  }));
  let out = '';
  try {
    execFileSync(process.execPath, [TSC, '-p', cfg], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return out.split('\n')
    .map((l) => l.match(/\((\d+),\d+\): error (TS\d+)/))
    .filter(Boolean)
    .map((m) => ({ line: +m[1], code: m[2] }));
}

console.log('\nTypeScript declarations:');

// ── valid.ts ─────────────────────────────────────────────────────────────────
{
  const errors = typeCheck('valid.ts');
  say(errors.length === 0, 'documented usage compiles under strict',
      errors.map((e) => `line ${e.line}: ${e.code}`).join(', '));
}

// ── invalid.ts ───────────────────────────────────────────────────────────────
{
  const src = readFileSync(join(FIXTURES, 'invalid.ts'), 'utf8').split('\n');
  // Each marker expects an error on the following line.
  const expected = [];
  src.forEach((text, i) => {
    const m = text.match(/@expect-error\s+(TS\d+)/);
    if (m) expected.push({ line: i + 2, code: m[1], note: text.split('—')[1]?.trim() || '' });
  });
  const errors = typeCheck('invalid.ts');
  const byLine = new Map(errors.map((e) => [e.line, e.code]));

  say(expected.length > 0, `invalid.ts declares ${expected.length} expectations`);
  for (const exp of expected) {
    const got = byLine.get(exp.line);
    say(got === exp.code, `rejects: ${exp.note || 'line ' + exp.line}`,
        got ? `expected ${exp.code}, got ${got}` : `no error reported on line ${exp.line}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

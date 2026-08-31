// test/backtest.test.mjs — the accuracy report card must keep holding.
// Runs the walk-forward backtest (reduced range for speed) and asserts the
// shipped model's skill. If these fail after a data refresh, the model
// configuration needs re-evaluation — do not loosen bounds to get green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));

test('walk-forward backtest: shipped model beats the flat baseline where it claims to', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'bt-')), 'r.json');
  execFileSync(process.execPath, [join(here, '..', 'backtest', 'backtest.mjs'), '--from', '2012-01', '--to', '2024-01', '--json', out], { stdio: 'pipe' });
  const r = JSON.parse(readFileSync(out, 'utf8')).results;
  const d100 = r['deaths≥100 global'];
  assert.ok(d100.n > 100, `n=${d100.n}`);
  // seasonality must add skill, and the adopted trend model must beat both
  assert.ok(d100.M1.bss > 0.01, `M1 BSS=${d100.M1.bss}`);
  assert.ok(d100.M2.brier <= d100.M1.brier + 1e-9, `M2 ${d100.M2.brier} vs M1 ${d100.M1.brier}`);
  // nothing may be catastrophically worse than baseline anywhere
  for (const [name, t] of Object.entries(r)) {
    for (const k of ['M1', 'M2']) assert.ok(t[k].bss > -0.08, `${name} ${k} BSS=${t[k].bss}`);
  }
});

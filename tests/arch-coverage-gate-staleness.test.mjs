/**
 * arch:coverage-gate staleness bound (gate-census F2). Under enforcement a coverage measurement older than
 * COVERAGE_MAX_AGE_DAYS, or with no usable `measuredAt`, never passes; with enforce off it is reported, never silent.
 * The CLI cases run the real script against a throwaway repo, with a fresh-and-verified control so a harness
 * fault cannot read as a working negative.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { COVERAGE_MAX_AGE_DAYS, assessMeasurementAge } from '../scripts/lib/symbol-index/graph-verdict.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'scripts', 'arch-coverage-gate.mjs');
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

describe('assessMeasurementAge (pure)', () => {
  it('fresh at the bound, stale one minute past it', () => {
    assert.equal(assessMeasurementAge({ measuredAt: iso(COVERAGE_MAX_AGE_DAYS * DAY), now: NOW }).state, 'fresh');
    assert.equal(assessMeasurementAge({ measuredAt: iso(COVERAGE_MAX_AGE_DAYS * DAY + 60_000), now: NOW }).state, 'stale');
  });
  it('a missing, malformed, non-string or future-dated stamp is unmeasured, never fresh', () => {
    for (const bad of [undefined, null, '', 'yesterday', 12345, {}, iso(-3600_000)]) {
      assert.equal(assessMeasurementAge({ measuredAt: bad, now: NOW }).state, 'unmeasured', String(bad));
    }
  });
  it('a stamp within the clock-skew allowance is fresh, not unmeasured', () => {
    assert.equal(assessMeasurementAge({ measuredAt: iso(-60_000), now: NOW }).state, 'fresh');
  });
  it('reproduces the incident: a 63-day-old verdict is stale', () => {
    const r = assessMeasurementAge({ measuredAt: '2026-09-20T12:23:38.063Z', now: NOW });
    assert.equal(r.state, 'stale');
    assert.ok(r.ageDays > 62 && r.ageDays < 64);
  });
});

function makeRepo({ enforce, measuredAt }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-cov-stale-'));
  fs.mkdirSync(path.join(dir, '.audit-loop'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.audit-loop', 'domain-map.json'), JSON.stringify({ rules: [], coverage: { enforce } }));
  const coverage = {
    schemaVersion: 1,
    verdict: { status: 'verified', reason: null },
    measuredAt,
    refreshId: 'r1',
    stale: false,
    extraction: { outcome: 'ok', eligible: 10, cruised: 10, ratio: 1, elapsedMs: 100, edges: { external: 0, selfEdge: 0, escaping: 0, persisted: 5 }, samples: { uncruised: [] } },
    attribution: null,
  };
  fs.writeFileSync(path.join(dir, '.audit-loop', 'domain-deps-observed.json'), JSON.stringify({
    version: 1, refreshId: 'r1', domainMapDigest: 'a'.repeat(64), generatedAt: new Date().toISOString(), deps: {}, coverage,
  }));
  return dir;
}

function runGate(dir) {
  const r = spawnSync(process.execPath, [GATE], { cwd: dir, encoding: 'utf8', env: { ...process.env, ARCH_COVERAGE_REQUIRE_ENVELOPE: '1' } });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('arch-coverage-gate CLI staleness', () => {
  const fresh = new Date().toISOString();
  const old = new Date(Date.now() - (COVERAGE_MAX_AGE_DAYS + 30) * DAY).toISOString();
  const made = [];
  const repo = (o) => { const d = makeRepo(o); made.push(d); return d; };

  it('CONTROL: enforce on + fresh + verified passes', () => {
    const r = runGate(repo({ enforce: true, measuredAt: fresh }));
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /VERIFIED/);
  });
  it('enforce on + stale measurement FAILS with a STALE message', () => {
    const r = runGate(repo({ enforce: true, measuredAt: old }));
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /STALE/);
  });
  it('enforce on + future-dated measurement FAILS as UNMEASURED', () => {
    const r = runGate(repo({ enforce: true, measuredAt: new Date(Date.now() + 30 * DAY).toISOString() }));
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /UNMEASURED/);
  });
  it('enforce off + stale: exits 0 but says so (never silent)', () => {
    const r = runGate(repo({ enforce: false, measuredAt: old }));
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /stale measurement .*would FAIL under enforcement/);
  });
  it('cleanup', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
});

/**
 * @fileoverview The CI oracle for the cross-process coverage seam.
 *
 * Coverage is measured in one process (extract.mjs), persisted by a second
 * (refresh.mjs), and consumed by a third (render-mermaid.mjs → dashboard /
 * gate). Every unit test in this feature passes with that seam severed — the
 * plan's first draft measured coverage and then dropped it on the floor, and
 * no pure test would have noticed. This file exists to notice.
 *
 * Deliberately NOT the spike: a real-repo spike cannot be a stable oracle.
 * Everything here is a deterministic fixture.
 *
 * The DB-touching block is env-gated on AUDIT_DB_TEST_URL and asserts the URL
 * is disposable first — the July 2026 wipe came from a suite run against a
 * prod-aliased DSN, and this feature's tests must never be able to repeat it.
 *
 * Plan: docs/plans/observed-graph-coverage-honesty.md §9
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { graphVerdict, COVERAGE_DEFAULTS } from '../scripts/lib/symbol-index/graph-verdict.mjs';
import { readDomainDeps } from '../scripts/lib/dashboard/collect-reference.mjs';
import { computeDomainMapDigest } from '../scripts/lib/observed-deps.mjs';
import sectionArchitecture from '../scripts/lib/dashboard/sections/architecture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const GATE = path.join(REPO, 'scripts', 'arch-coverage-gate.mjs');
const REFRESH_ID = '11111111-1111-1111-1111-111111111111';
const MEASURED_ID = '22222222-2222-2222-2222-222222222222';

/** A throwaway repo root with just the two files the seam reads. */
function fixtureRepo({ coverage, enforce }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-lineage-'));
  fs.mkdirSync(path.join(dir, '.audit-loop'), { recursive: true });
  const envelope = {
    version: 1,
    refreshId: REFRESH_ID,
    // Must be the REAL digest of the fixture's rules — the dashboard reader
    // rejects an envelope as `stale-rules` when it disagrees, which would make
    // this fixture measure the staleness guard instead of the coverage path.
    domainMapDigest: computeDomainMapDigest([]),
    generatedAt: '2026-07-18T12:00:00.000Z',
    deps: { 'domain-a': ['domain-b'] },
  };
  if (coverage !== undefined) envelope.coverage = coverage;
  fs.writeFileSync(path.join(dir, '.audit-loop', 'domain-deps-observed.json'),
    JSON.stringify(envelope, null, 2));
  fs.writeFileSync(path.join(dir, '.audit-loop', 'domain-map.json'),
    JSON.stringify({ rules: [], coverage: enforce === undefined ? {} : { enforce } }, null, 2));
  return dir;
}

const coverageBlock = (over = {}) => ({
  schemaVersion: 1,
  verdict: { status: 'verified', reason: null },
  measuredAt: '2026-07-18T12:00:00.000Z',
  refreshId: REFRESH_ID,
  stale: false,
  extraction: {
    outcome: 'ok', eligible: 100, cruised: 98, ratio: 0.98, elapsedMs: 1000,
    edges: { external: 5, selfEdge: 0, escaping: 0, persisted: 50 },
    samples: { uncruised: [] },
  },
  attribution: {
    candidates: 50, attributed: 48, attributable: 48, ratio: 1,
    edges: { malformed: 0, untaggedFrom: 0, untaggedTo: 0, untaggedBoth: 0, sameDomain: 2, attributed: 48 },
    samples: { untagged: [] },
  },
  ...over,
});

function runGate(cwd) {
  const r = spawnSync(process.execPath, [GATE], { cwd, encoding: 'utf-8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

describe('lineage — envelope → gate exit codes (§2.1.6)', () => {
  it('verified passes under enforcement', () => {
    const { code } = runGate(fixtureRepo({ coverage: coverageBlock(), enforce: true }));
    assert.equal(code, 0);
  });

  it('degraded FAILS with exit 2 under enforcement', () => {
    const cov = coverageBlock({ verdict: { status: 'degraded', reason: 'below_floor' } });
    const { code, out } = runGate(fixtureRepo({ coverage: cov, enforce: true }));
    assert.equal(code, 2, 'a degraded graph must not pass an enforcing gate');
    assert.match(out, /below_floor/);
  });

  it('degraded is report-only when enforce=false, but SAYS it would fail', () => {
    const cov = coverageBlock({ verdict: { status: 'degraded', reason: 'below_floor' } });
    const { code, out } = runGate(fixtureRepo({ coverage: cov, enforce: false }));
    assert.equal(code, 0);
    // Silence during the rollout cycle would waste the cycle.
    assert.match(out, /would FAIL under enforcement/);
  });

  it('unverified FAILS with exit 2 under enforcement', () => {
    const cov = coverageBlock({ verdict: { status: 'unverified', reason: 'zero_attributed' } });
    const { code } = runGate(fixtureRepo({ coverage: cov, enforce: true }));
    assert.equal(code, 2);
  });

  it('a LEGACY envelope reads unknown — never verified, and never a failure', () => {
    // Back-compat: a repo that rendered before this feature has no coverage
    // block. It must not be punished, and must not be called clean.
    const { code, out } = runGate(fixtureRepo({ coverage: undefined, enforce: true }));
    assert.equal(code, 0, 'cannot fault a repo for a measurement that did not exist');
    assert.match(out, /UNKNOWN \(not_measured\)/);
    assert.doesNotMatch(out, /VERIFIED/);
  });

  it('refuses to run on a config it could not parse (§2.1.4 binding)', () => {
    // The typo hole: `enforce: "true"` parses as invalid, would fall back to
    // enforce:false, and hand back a gate enforcing nothing. Green without
    // having checked anything, one keystroke away.
    const dir = fixtureRepo({ coverage: coverageBlock(), enforce: 'true' });
    const { code, out } = runGate(dir);
    assert.equal(code, 2);
    assert.match(out, /did not parse cleanly/);
  });
});

describe('lineage — envelope → dashboard string (never renders green)', () => {
  const ui = {
    escapeHtml: (s) => String(s).replace(/[&<>"]/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    NON_OK: new Set(['error', 'missing']),
    warningPanel: () => '<warning/>',
    emptyPanel: () => '<empty/>',
  };
  const render = (coverage) => sectionArchitecture({
    src: { status: 'ok' },
    architecture: {
      domains: [{ name: 'domain-a', symbolCount: 10, summary: 's' }],
      deps: {}, mergedDeps: {}, mapPath: 'docs/architecture-map.md',
      depsSource: {
        observedAvailable: true, observedRejectedReason: null,
        observedRefreshId: REFRESH_ID, observedGeneratedAt: '2026-07-18T12:00:00.000Z',
        manualKeyCount: 0, edgeCounts: { observed: 1, manual: 0, both: 0 },
        coverage,
      },
    },
  }, ui);

  it('renders 🟡 and the reason for a degraded graph', () => {
    const html = render(coverageBlock({ verdict: { status: 'degraded', reason: 'below_floor' } }));
    assert.match(html, /🟡/);
    assert.match(html, /below_floor/);
    assert.doesNotMatch(html, /🟢/);
  });

  it('renders 🟡 for unverified and says the graph is not an authority', () => {
    const html = render(coverageBlock({ verdict: { status: 'unverified', reason: 'zero_cruised' } }));
    assert.match(html, /🟡/);
    assert.match(html, /not an authority/);
    assert.doesNotMatch(html, /🟢/);
  });

  it('renders ⚪ for unknown — NOT green, and not the degraded icon either', () => {
    const html = render({ verdict: { status: 'unknown', reason: 'not_measured' } });
    assert.match(html, /⚪/);
    assert.match(html, /not measured/);
    assert.doesNotMatch(html, /🟢/);
  });

  it('says so explicitly when a non-verified graph has no counts', () => {
    // A missing count must not read as a zero-drop clean run.
    const html = render({ verdict: { status: 'unverified', reason: 'extraction_failed' } });
    assert.match(html, /no extraction measurement/);
  });

  it('surfaces a copied-forward measurement as such', () => {
    const html = render(coverageBlock({
      stale: true, verdict: { status: 'unknown', reason: 'stale_measurement' },
    }));
    assert.match(html, /copied forward/);
    assert.doesNotMatch(html, /🟢/);
  });

  it('only a genuinely verified graph gets 🟢', () => {
    const html = render(coverageBlock());
    assert.match(html, /🟢/);
    assert.match(html, /98\/100/);
  });
});

describe('lineage — reader defaults absence to unknown, never verified', () => {
  it('an envelope without a coverage block reads unknown', () => {
    const dir = fixtureRepo({ coverage: undefined });
    const { depsSource } = readDomainDeps(dir);
    assert.equal(depsSource.coverage.verdict.status, 'unknown');
    assert.equal(depsSource.coverage.verdict.reason, 'not_measured');
  });

  it('coverage is null when there is no observed envelope at all', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-lineage-empty-'));
    fs.mkdirSync(path.join(dir, '.audit-loop'), { recursive: true });
    const { depsSource } = readDomainDeps(dir);
    assert.equal(depsSource.coverage, null);
  });
});

describe('lineage — snapshot identity survives a copy-forward', () => {
  it('a stale record keeps the ORIGINATING measurement provenance', () => {
    // The point of copying forward rather than re-stamping: the dashboard must
    // be able to say "measured 3 refreshes ago" instead of implying it was
    // measured now.
    const prior = coverageBlock({ refreshId: MEASURED_ID, measuredAt: '2026-07-01T00:00:00.000Z' });
    const carried = {
      ...prior,
      stale: true,
      verdict: { status: 'unknown', reason: 'stale_measurement' },
    };
    assert.equal(carried.refreshId, MEASURED_ID, 'provenance must not be re-stamped');
    assert.equal(carried.measuredAt, '2026-07-01T00:00:00.000Z');
    // And the verdict oracle must refuse to inherit trust regardless of ratios.
    const v = graphVerdict({
      extraction: carried.extraction, attribution: carried.attribution,
      stale: true, config: COVERAGE_DEFAULTS,
    });
    assert.equal(v.status, 'unknown');
    assert.equal(v.reason, 'stale_measurement');
  });
});

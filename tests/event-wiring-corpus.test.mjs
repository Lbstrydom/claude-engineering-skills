/**
 * @fileoverview Tests for Cluster B's event-wiring-symmetry additions:
 * D10 advisory/gating enforcement, D12 lifecycle transitions, the
 * `event-wiring-symmetry` / `event-wiring-orphaned-pragma` fingerprint
 * intercepts, and `buildCorpus`'s git-backed corpus/orphaned-pragma wiring.
 *
 * Written in response to a Cluster-B code-audit R1/M22 finding: these
 * additions had no permanent test coverage — only ad-hoc verification
 * during implementation. `tests/event-wiring.test.mjs` covers the PURE
 * `event-wiring.mjs` module (Cluster A); this file covers the orchestration
 * seam Cluster B built on top of it.
 *
 * Design: docs/plans/event-wiring-symmetry.md §2 (D10, D12).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildCorpus, buildEventWiringDiffScope, detectEventWiringAsymmetry } from '../scripts/lib/audit/event-wiring-corpus.mjs';
import {
  readLifecycle, listOpenLifecycle, upsertLifecycle, reconcileLifecycle,
} from '../scripts/lib/ledger.mjs';
import { findingFingerprint, computeAuditVerdict } from '../scripts/lib/audit/findings-pipeline.mjs';
import { countsTowardVerdict } from '../scripts/lib/audit/finding-verification.mjs';
import { gitFixtureEnv } from './helpers/fixtures.mjs';

// Same isolation discipline as tests/diff-scope-resolver.test.mjs — a scratch
// git repo spawned without an explicit sanitized env risks a leaked GIT_DIR
// redirecting `git init`/`git commit` onto the REAL repo (six live
// incidents, 2026-07-23; see scripts/lib/git-env-sanitize.mjs).
function sh(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], env: gitFixtureEnv() });
}

function writeFile(repo, rel, content) {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function newRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'event-wiring-corpus-test-'));
  sh(repo, 'init', '-q');
  sh(repo, 'config', 'user.email', 'test@example.com');
  sh(repo, 'config', 'user.name', 'Test');
  sh(repo, 'config', 'commit.gpgsign', 'false');
  writeFile(repo, 'package.json', JSON.stringify({ name: 'fixture', type: 'module' }));
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

function commit(repo, msg) {
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', msg);
}

// ---------------------------------------------------------------------------
// buildCorpus — orphaned-pragma wiring (R1/M22 gap: schema+fingerprint+
// converter existed with no producer anywhere in the pipeline)
// ---------------------------------------------------------------------------
describe('buildCorpus — orphaned-pragma wiring', () => {
  it('surfaces an orphaned pragma from a committed file, with locus.path set', () => {
    const repo = newRepo();
    try {
      writeFile(repo, 'a.js', `function f() {\n  // @event-consumer-external: consumed by the mobile app\n  const x = 1;\n}\n`);
      commit(repo, 'add orphaned pragma');
      const { orphanedPragmas } = buildCorpus({ repoPath: repo, ref: 'HEAD', env: gitFixtureEnv() });
      assert.equal(orphanedPragmas.length, 1);
      assert.equal(orphanedPragmas[0].locus.path, 'a.js');
      assert.match(orphanedPragmas[0].pragmaText, /event-consumer-external/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a pragma bound to a real dispatch is NOT reported as orphaned', () => {
    const repo = newRepo();
    try {
      writeFile(repo, 'a.js', `function f() {\n  // @event-consumer-external: consumed elsewhere\n  el.dispatchEvent(new CustomEvent('a:b'));\n}\n`);
      commit(repo, 'add bound pragma');
      const { orphanedPragmas } = buildCorpus({ repoPath: repo, ref: 'HEAD', env: gitFixtureEnv() });
      assert.equal(orphanedPragmas.length, 0);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('respects totalByteBudgetMb — a tiny budget skips large files instead of reading them unconditionally (R1/M6+M11)', () => {
    const repo = newRepo();
    try {
      // ~2MB file, comfortably over a 1-byte-equivalent budget expressed in MB.
      writeFile(repo, 'big.js', 'x'.repeat(2 * 1024 * 1024));
      writeFile(repo, 'small.js', `el.dispatchEvent(new CustomEvent('small:evt'));`);
      commit(repo, 'add big + small');
      const { sites, counters } = buildCorpus({
        repoPath: repo, ref: 'HEAD', totalByteBudgetMb: 1, env: gitFixtureEnv(),
      });
      assert.ok(counters.skippedFiles >= 1, 'the oversized file must be counted as skipped');
      // The budget must not have prevented the small, in-budget file from
      // still being analysed — proves the fetch set is trimmed, not emptied.
      assert.equal(sites.dispatches.length, 1);
      assert.equal(sites.dispatches[0].eventName, 'small:evt');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

// ---------------------------------------------------------------------------
// detectEventWiringAsymmetry — ancestry must cover TERMINAL records too
// (R2/H1 fix: computeAncestryDecisions was called with openRecords only, so
// a coverage-derived observation targeting an already-CLOSED record found no
// ancestry entry for its lastObservedRef and was dropped — a real reopen
// silently never applied).
// ---------------------------------------------------------------------------
describe('detectEventWiringAsymmetry — ancestry covers terminal records (R2/H1)', () => {
  it('reopens a TERMINAL ledger record when a NEW dispatch site for its event lands in the diff', async () => {
    // resolveSymmetry's `coverage` (and therefore `observations`) is
    // diff-scoped, built from addedDispatches/removedListeners — a
    // TERMINAL record only ever receives a fresh observation when its
    // event reappears in THIS run's diff (e.g. a genuinely new dispatch
    // site), not from mere corpus presence. That's the scenario this test
    // constructs: shaA has no 'cart:updated' dispatch anywhere; the ledger
    // is seeded as if a prior run had already closed it 'fixed' and
    // observed it at shaA (artificial — isolates the ancestry gap without a
    // real fix-then-regress history); shaB adds the FIRST dispatch site,
    // which diffSites reports as added, landing the terminal record's
    // eventName in `coverage`.
    const repo = newRepo();
    try {
      const shaA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, env: gitFixtureEnv() }).toString('utf8').trim();

      const ledgerPath = path.join(repo, '.audit', 'event-wiring-ledger.json');
      upsertLifecycle(ledgerPath, {
        kind: 'event-wiring-symmetry', fingerprint: 'event-wiring-symmetry|cart:updated', eventName: 'cart:updated',
        triggers: ['added-dispatch'], firstSeen: 1000, lastSeen: 1000, occurrences: 1,
        disposition: 'fixed', dispositionAt: 1500, resolvedObservedAt: 1500, deletionObservedAt: null,
        reopenHistory: [], lastObservedRef: shaA,
      });

      writeFile(repo, 'a.js', `function f() { el.dispatchEvent(new CustomEvent('cart:updated')); }`);
      commit(repo, 'add a new dispatch for cart:updated, no listener');
      const shaB = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, env: gitFixtureEnv() }).toString('utf8').trim();

      const diffScope = buildEventWiringDiffScope({ repoPath: repo, baseRef: shaA, headRef: shaB, env: gitFixtureEnv() });
      await detectEventWiringAsymmetry({
        diffScope, repoPath: repo, wrappers: [], ledgerPath, env: gitFixtureEnv(),
      });

      const rec = readLifecycle(ledgerPath, 'event-wiring-symmetry|cart:updated');
      assert.equal(rec.disposition, null, 'must reopen — the new dispatch site has no listener');
      assert.equal(rec.reopenHistory.length, 1);
      assert.equal(rec.reopenHistory[0].from, 'fixed');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

// ---------------------------------------------------------------------------
// findingFingerprint — event-wiring intercepts
// ---------------------------------------------------------------------------
describe('findingFingerprint — event-wiring-symmetry and event-wiring-orphaned-pragma', () => {
  it('event-wiring-symmetry keys on eventName alone — file path and triggers do not affect identity', () => {
    const a = { kind: 'event-wiring-symmetry', eventName: 'cart:updated', triggers: ['added-dispatch'], locus: { path: 'a.js' } };
    const b = { kind: 'event-wiring-symmetry', eventName: 'cart:updated', triggers: ['removed-listener'], locus: { path: 'b.js' } };
    assert.equal(findingFingerprint(a), findingFingerprint(b));
  });

  it('event-wiring-symmetry — a different eventName produces a different fingerprint', () => {
    const a = { kind: 'event-wiring-symmetry', eventName: 'cart:updated', triggers: ['added-dispatch'] };
    const b = { kind: 'event-wiring-symmetry', eventName: 'cart:removed', triggers: ['added-dispatch'] };
    assert.notEqual(findingFingerprint(a), findingFingerprint(b));
  });

  it('event-wiring-orphaned-pragma — dedupeOrdinal disambiguates two identical-text pragmas in the same file (R1/L2)', () => {
    const first = { kind: 'event-wiring-orphaned-pragma', locus: { path: 'a.js' }, pragmaText: '// @event-consumer-external: x', dedupeOrdinal: 0 };
    const second = { kind: 'event-wiring-orphaned-pragma', locus: { path: 'a.js' }, pragmaText: '// @event-consumer-external: x', dedupeOrdinal: 1 };
    assert.notEqual(findingFingerprint(first), findingFingerprint(second));
  });

  it('event-wiring-orphaned-pragma — same path, same text, same ordinal is stable across two calls', () => {
    const f = { kind: 'event-wiring-orphaned-pragma', locus: { path: 'a.js' }, pragmaText: '// @event-consumer-external: x', dedupeOrdinal: 0 };
    assert.equal(findingFingerprint(f), findingFingerprint({ ...f }));
  });

  it('event-wiring-orphaned-pragma — a different file with the same pragma text is a different fingerprint', () => {
    const a = { kind: 'event-wiring-orphaned-pragma', locus: { path: 'a.js' }, pragmaText: '// @event-consumer-external: x', dedupeOrdinal: 0 };
    const b = { kind: 'event-wiring-orphaned-pragma', locus: { path: 'b.js' }, pragmaText: '// @event-consumer-external: x', dedupeOrdinal: 0 };
    assert.notEqual(findingFingerprint(a), findingFingerprint(b));
  });
});

// ---------------------------------------------------------------------------
// D10 — advisory/gating enforcement
// ---------------------------------------------------------------------------
describe('D10 — advisory findings never gate', () => {
  it('countsTowardVerdict excludes an advisory finding', () => {
    assert.equal(countsTowardVerdict({ severity: 'HIGH', enforcement: 'advisory' }), false);
  });

  it('countsTowardVerdict counts a gating finding (enforcement absent — fail-closed)', () => {
    assert.equal(countsTowardVerdict({ severity: 'HIGH' }), true);
  });

  it('countsTowardVerdict counts a finding with an unrecognised enforcement value (fail-closed, not opt-out)', () => {
    assert.equal(countsTowardVerdict({ severity: 'HIGH', enforcement: 'bogus' }), true);
  });

  it('computeAuditVerdict: an advisory HIGH finding alone still yields PASS', () => {
    const verdict = computeAuditVerdict([{ severity: 'HIGH', enforcement: 'advisory' }]);
    assert.equal(verdict, 'PASS');
  });

  it('computeAuditVerdict: a gating HIGH finding alongside an advisory one yields SIGNIFICANT_ISSUES', () => {
    const verdict = computeAuditVerdict([
      { severity: 'HIGH', enforcement: 'advisory' },
      { severity: 'HIGH' },
    ]);
    assert.equal(verdict, 'SIGNIFICANT_ISSUES');
  });
});

// ---------------------------------------------------------------------------
// D12 — lifecycle transition table (scratch ledger file, no git required)
// ---------------------------------------------------------------------------
describe('D12 — lifecycle transitions (reconcileLifecycle)', () => {
  function scratchLedgerPath() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-wiring-lifecycle-'));
    return path.join(dir, 'ledger.json');
  }

  it('a diff-scoped observation opens a new record', () => {
    const ledgerPath = scratchLedgerPath();
    try {
      reconcileLifecycle(ledgerPath, {
        kind: 'event-wiring-symmetry',
        observations: [{ eventName: 'cart:updated', ref: 'sha1', coverage: { totalDispatchSites: 1, pragmaSuppressedSites: 0 } }],
        now: 1000,
        ancestryDecisions: new Map(),
      });
      const rec = readLifecycle(ledgerPath, 'event-wiring-symmetry|cart:updated');
      assert.ok(rec, 'record must exist');
      assert.equal(rec.disposition, null);
      assert.equal(rec.occurrences, 1);
    } finally {
      fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a status observation with hasProductionListener closes the record as fixed', () => {
    const ledgerPath = scratchLedgerPath();
    try {
      upsertLifecycle(ledgerPath, {
        kind: 'event-wiring-symmetry', fingerprint: 'event-wiring-symmetry|cart:updated', eventName: 'cart:updated',
        triggers: [], firstSeen: 1000, lastSeen: 1000, occurrences: 1,
        disposition: null, dispositionAt: null, resolvedObservedAt: null, deletionObservedAt: null,
        reopenHistory: [], lastObservedRef: 'sha1',
      });
      reconcileLifecycle(ledgerPath, {
        kind: 'event-wiring-symmetry',
        observations: [{ eventName: 'cart:updated', ref: 'sha1', status: { hasProductionListener: true, hasAnyDispatch: true, totalDispatchSites: 1, pragmaSuppressedSites: 0 } }],
        now: 2000,
        ancestryDecisions: new Map(),
      });
      const rec = readLifecycle(ledgerPath, 'event-wiring-symmetry|cart:updated');
      assert.equal(rec.disposition, 'fixed');
      assert.equal(rec.resolvedObservedAt, 2000);
    } finally {
      fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a status observation with the dispatch GONE but a listener still present closes as deleted, not fixed (R2/M2 fix)', () => {
    // The listener could be stale (pre-dated the removed dispatch) rather
    // than newly wired — §6's stopping rule credits 'fixed' unconditionally
    // but 'deleted' only within a 14-day window, so conflating the two would
    // let a coincidental leftover listener claim unconditional credit for a
    // deletion that isn't a wiring fix at all.
    const ledgerPath = scratchLedgerPath();
    try {
      upsertLifecycle(ledgerPath, {
        kind: 'event-wiring-symmetry', fingerprint: 'event-wiring-symmetry|cart:updated', eventName: 'cart:updated',
        triggers: [], firstSeen: 1000, lastSeen: 1000, occurrences: 1,
        disposition: null, dispositionAt: null, resolvedObservedAt: null, deletionObservedAt: null,
        reopenHistory: [], lastObservedRef: 'sha1',
      });
      reconcileLifecycle(ledgerPath, {
        kind: 'event-wiring-symmetry',
        observations: [{ eventName: 'cart:updated', ref: 'sha1', status: { hasProductionListener: true, hasAnyDispatch: false, totalDispatchSites: 0, pragmaSuppressedSites: 0 } }],
        now: 2000,
        ancestryDecisions: new Map(),
      });
      const rec = readLifecycle(ledgerPath, 'event-wiring-symmetry|cart:updated');
      assert.equal(rec.disposition, 'deleted');
      assert.equal(rec.deletionObservedAt, 2000);
      assert.equal(rec.resolvedObservedAt, null, 'must not also be marked as a wiring fix');
    } finally {
      fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a status observation with no dispatch and no listener closes the record as deleted', () => {
    const ledgerPath = scratchLedgerPath();
    try {
      upsertLifecycle(ledgerPath, {
        kind: 'event-wiring-symmetry', fingerprint: 'event-wiring-symmetry|cart:updated', eventName: 'cart:updated',
        triggers: [], firstSeen: 1000, lastSeen: 1000, occurrences: 1,
        disposition: null, dispositionAt: null, resolvedObservedAt: null, deletionObservedAt: null,
        reopenHistory: [], lastObservedRef: 'sha1',
      });
      reconcileLifecycle(ledgerPath, {
        kind: 'event-wiring-symmetry',
        observations: [{ eventName: 'cart:updated', ref: 'sha1', status: { hasProductionListener: false, hasAnyDispatch: false, totalDispatchSites: 0, pragmaSuppressedSites: 0 } }],
        now: 2000,
        ancestryDecisions: new Map(),
      });
      const rec = readLifecycle(ledgerPath, 'event-wiring-symmetry|cart:updated');
      assert.equal(rec.disposition, 'deleted');
      assert.equal(rec.deletionObservedAt, 2000);
    } finally {
      fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a diff-scoped observation REOPENS a previously-closed record (same fingerprint, new episode)', () => {
    const ledgerPath = scratchLedgerPath();
    try {
      upsertLifecycle(ledgerPath, {
        kind: 'event-wiring-symmetry', fingerprint: 'event-wiring-symmetry|cart:updated', eventName: 'cart:updated',
        triggers: [], firstSeen: 1000, lastSeen: 1000, occurrences: 1,
        disposition: 'fixed', dispositionAt: 1500, resolvedObservedAt: 1500, deletionObservedAt: null,
        reopenHistory: [], lastObservedRef: 'sha1',
      });
      reconcileLifecycle(ledgerPath, {
        kind: 'event-wiring-symmetry',
        observations: [{ eventName: 'cart:updated', ref: 'sha2', coverage: { totalDispatchSites: 1, pragmaSuppressedSites: 0 } }],
        now: 3000,
        ancestryDecisions: new Map([['sha1', true]]),
      });
      const rec = readLifecycle(ledgerPath, 'event-wiring-symmetry|cart:updated');
      assert.equal(rec.disposition, null, 'reopened — no longer terminal');
      assert.equal(rec.reopenHistory.length, 1);
      assert.equal(rec.reopenHistory[0].from, 'fixed');
    } finally {
      fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a stale observation (non-ancestor ref) is dropped, fail-closed — the existing record is untouched', () => {
    const ledgerPath = scratchLedgerPath();
    try {
      upsertLifecycle(ledgerPath, {
        kind: 'event-wiring-symmetry', fingerprint: 'event-wiring-symmetry|cart:updated', eventName: 'cart:updated',
        triggers: [], firstSeen: 1000, lastSeen: 1000, occurrences: 1,
        disposition: null, dispositionAt: null, resolvedObservedAt: null, deletionObservedAt: null,
        reopenHistory: [], lastObservedRef: 'sha1',
      });
      reconcileLifecycle(ledgerPath, {
        kind: 'event-wiring-symmetry',
        // ancestryDecisions has NO entry for 'sha1' — must be treated as false, not true.
        observations: [{ eventName: 'cart:updated', ref: 'sha-unrelated', status: { hasProductionListener: true, hasAnyDispatch: true, totalDispatchSites: 1, pragmaSuppressedSites: 0 } }],
        now: 5000,
        ancestryDecisions: new Map(),
      });
      const rec = readLifecycle(ledgerPath, 'event-wiring-symmetry|cart:updated');
      assert.equal(rec.disposition, null, 'must remain open — the observation was dropped as stale');
      assert.equal(rec.lastObservedRef, 'sha1', 'must not have been overwritten by the stale observation');
    } finally {
      fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('listOpenLifecycle filters on the STORED kind field, never a fingerprint-string parse', () => {
    const ledgerPath = scratchLedgerPath();
    try {
      upsertLifecycle(ledgerPath, {
        kind: 'event-wiring-symmetry', fingerprint: 'event-wiring-symmetry|a', eventName: 'a',
        triggers: [], firstSeen: 1, lastSeen: 1, occurrences: 1,
        disposition: null, dispositionAt: null, resolvedObservedAt: null, deletionObservedAt: null,
        reopenHistory: [], lastObservedRef: 's1',
      });
      upsertLifecycle(ledgerPath, {
        kind: 'other-kind', fingerprint: 'other-kind|a', eventName: 'a',
        triggers: [], firstSeen: 1, lastSeen: 1, occurrences: 1,
        disposition: null, dispositionAt: null, resolvedObservedAt: null, deletionObservedAt: null,
        reopenHistory: [], lastObservedRef: 's1',
      });
      const open = listOpenLifecycle(ledgerPath, { kind: 'event-wiring-symmetry' });
      assert.equal(open.length, 1);
      assert.equal(open[0].eventName, 'a');
    } finally {
      fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

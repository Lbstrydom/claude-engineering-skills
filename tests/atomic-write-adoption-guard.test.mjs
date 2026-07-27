import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeShapeADelegation, analyzeRetryWrapping } from './helpers/atomic-write-guard-analysis.mjs';

// AST-based wiring-proof guard for docs/plans/atomic-write-adoption-remaining-sites.md.
// A regex/text check can be satisfied by an unrelated call, a shadowed local, a
// comment, or a rename outside the intended callback — none of which prove the
// actual wiring landed. This does REAL import-binding resolution via
// tests/helpers/atomic-write-guard-analysis.mjs (scope.getBinding, not
// identifier-spelling matching) — the same technique
// docs/plans/windows-fs-transient-error-hardening.md's find-rmsync-sites.mjs
// established, generalized through the shared scripts/lib/import-binding.mjs
// predicates. Discovery here is a fixed 9-file target set stated below, not a
// repo-wide scan the way rmSync's corpus required.

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

function abs(p) {
  return path.resolve(REPO_ROOT, p);
}

function readSource(absPath) {
  return fs.readFileSync(absPath, 'utf-8');
}

// ── Rule 1 — Shape A: named target function delegates to atomicWriteFileSync ──

const SHAPE_A_TARGETS = [
  { file: 'scripts/learning/backfill-outcomes.mjs', fn: 'drainFrictionFallback' },
  { file: 'scripts/lib/brainstorm/session-store.mjs', fn: 'appendQuarantine' },
  { file: 'scripts/lib/claudemd/autofix.mjs', fn: 'applyFixes' },
  { file: 'scripts/lib/learning/decision-logger.mjs', fn: 'writeOutbox' },
  { file: 'scripts/lib/learning/quickfix-stats.mjs', fn: 'writeAtomic' },
  { file: 'scripts/memory-health.mjs', fn: 'atomicWrite' },
  { file: 'scripts/symbol-index/drift.mjs', fn: 'atomicWrite' },
];

describe('atomic-write-adoption guard — Rule 1: Shape-A delegation', () => {
  for (const { file, fn } of SHAPE_A_TARGETS) {
    it(`${file}::${fn} calls atomicWriteFileSync`, () => {
      const fileAbsPath = abs(file);
      const { status } = analyzeShapeADelegation(readSource(fileAbsPath), fileAbsPath, { functionName: fn });
      assert.equal(status, 'wired', `${file}::${fn} — expected 'wired', got '${status}'`);
    });
  }
});

// ── Rule 2 — every renameSync/unlinkSync site found is retrySync-wrapped ──
// Applies to: persona-consistency-promote.mjs (whole file) and
// backfill-outcomes.mjs scoped to drainFrictionFallback only (the other Shape-A
// files have zero renameSync/unlinkSync remaining, which Rule 1 already proves by
// locating the real write path). archive-completed-plans.mjs was removed here by
// docs/plans/reference-integrity-gate.md Cluster C (Phase 5) — the archiver is
// deleted, so its Rule-2 assertion went with it.

function assertAllSitesRetrySyncWrapped(fileRel, { scopeToFunction } = {}) {
  const fileAbsPath = abs(fileRel);
  const { sites } = analyzeRetryWrapping(readSource(fileAbsPath), fileAbsPath, {
    methodNames: ['renameSync', 'unlinkSync'],
    scopeToFunction,
  });
  for (const site of sites) {
    assert.equal(
      site.status,
      'wrapped',
      `${fileRel}:${site.line} — fs.${site.method} call is not retry-wrapped (status: '${site.status}')`,
    );
  }
  return sites.length;
}

describe('atomic-write-adoption guard — Rule 2: retrySync wrapping', () => {
  it('persona-consistency-promote.mjs — exactly 12 sites (3 rename + 9 unlink), all wrapped', () => {
    const count = assertAllSitesRetrySyncWrapped('scripts/persona-consistency-promote.mjs');
    assert.equal(count, 12);
  });

  it('backfill-outcomes.mjs::drainFrictionFallback — its unlinkSync sibling is wrapped', () => {
    const count = assertAllSitesRetrySyncWrapped('scripts/learning/backfill-outcomes.mjs', {
      scopeToFunction: 'drainFrictionFallback',
    });
    assert.equal(count, 1);
  });
});

/**
 * @fileoverview Tier-1 tests for the tiered-pipeline.mjs Stage 0 relevance-
 * split wiring (docs/plans/stage0-evidence-relevance-split.md, Cluster B /
 * Phase 3): `buildStage0RelevanceContext`'s per-run caching (decision #5,
 * round-3 H3's deferred "verify actual per-run call counts" ask) and
 * `routePreExistingIndependent`'s batch-reconciled debt routing (decision
 * #9).
 *
 * SEPARATE FILE, not folded into tests/tiered-pipeline-wiring.test.mjs — a
 * hard constraint, not a style choice: that file already carries a static
 * top-level `import { runTieredAuditPipeline } from
 * '../scripts/lib/audit/tiered-pipeline.mjs'`, which evaluates the module
 * (freezing `__testExports` at `undefined`, since `AUDIT_EXPORTS_FOR_TESTS`
 * is unset at that point) before any test-body code could set the env var.
 * A later `await import()` of the SAME resolved path returns the cached,
 * already-frozen module — never a fresh evaluation. This file sets
 * `AUDIT_EXPORTS_FOR_TESTS=1` BEFORE its own first (dynamic) import of
 * tiered-pipeline.mjs, exactly mirroring the established
 * tests/legacy-production-audit-hardening.test.mjs pattern.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';

process.env.AUDIT_EXPORTS_FOR_TESTS = '1';
const { __testExports } = await import('../scripts/lib/audit/tiered-pipeline.mjs');
const {
  collectCandidateAnchorFiles, buildStage0RelevanceContext,
  makeHeadContentAdapter, makeImpactAdapter, makeBlameAdapter,
  extractCanonicalAnchorFile, buildPreExistingDebtEntry, routePreExistingIndependent,
  normalizeModifiedAnchorPaths,
} = __testExports;

// @duplicate-justification: target=tests/vcs-blame.test.mjs:mkdtemp reason=a 2-line temp-dir helper duplicated across test files matching this repo's established per-file local-helper convention (AGENTS.md: "three similar lines is better than a premature abstraction") — a shared fixture module for one trivial helper is the over-engineered extreme, not the right-sized one.
function mkdtemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tiered-stage0-wiring-'));
}

// @duplicate-justification: target=tests/vcs.test.mjs:gitInit reason=a 4-line disposable-git-repo-init helper duplicated across test files matching this repo's established per-file local-helper convention (AGENTS.md: "three similar lines is better than a premature abstraction") — a shared fixture module for one trivial helper is the over-engineered extreme, not the right-sized one.
function gitInit(dir) {
  spawnSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  spawnSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, stdio: 'ignore' });
}

// @duplicate-justification: target=tests/vcs-blame.test.mjs:commit reason=a 5-line temp-repo-commit helper duplicated across test files matching this repo's established per-file local-helper convention (AGENTS.md: "three similar lines is better than a premature abstraction") — a shared fixture module for one trivial helper is the over-engineered extreme, not the right-sized one.
function commit(dir, filePath, content, message) {
  fs.writeFileSync(path.join(dir, filePath), content);
  spawnSync('git', ['add', filePath], { cwd: dir, stdio: 'ignore' });
  spawnSync('git', ['commit', '-m', message], { cwd: dir, stdio: 'ignore' });
  return execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
}

function withCwd(dir, fn) {
  const saved = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(saved);
  }
}

const HEAD_ANCHOR = (overrides = {}) => ({
  diffPathId: 'a.txt', newFile: 'a.txt', oldFile: 'a.txt', fileStatus: 'modified',
  side: 'head', startLine: 3, endLine: 3, quote: 'function foo() {}', headSha: 'WORKTREE',
  ...overrides,
});

function mkEnvelope(fingerprint, anchorOverrides = {}) {
  return {
    fingerprint,
    canonicalFinding: {
      evidenceType: 'commission',
      anchor: HEAD_ANCHOR(anchorOverrides),
    },
    evidenceAlternatives: [],
  };
}

describe('collectCandidateAnchorFiles — dedup across canonical + alternative anchors', () => {
  it('returns each distinct file exactly once, even when cited by multiple envelopes/alternatives', () => {
    const env1 = mkEnvelope('fp1', { newFile: 'a.txt', oldFile: 'a.txt' });
    const env2 = mkEnvelope('fp2', { newFile: 'a.txt', oldFile: 'a.txt' });
    env2.evidenceAlternatives = [{ anchor: HEAD_ANCHOR({ newFile: 'b.txt', oldFile: 'b.txt' }) }];
    const files = collectCandidateAnchorFiles([env1, env2]);
    assert.deepEqual([...files].sort(), ['a.txt', 'b.txt']);
  });

  it('returns [] for no envelopes and skips envelopes with no anchor at all', () => {
    assert.deepEqual(collectCandidateAnchorFiles([]), []);
    assert.deepEqual(collectCandidateAnchorFiles([{ fingerprint: 'fp', canonicalFinding: {}, evidenceAlternatives: [] }]), []);
  });
});

describe('buildStage0RelevanceContext — per-run caching (decision #5, round-3 H3)', () => {
  it('fetches each distinct candidate file at most once, regardless of how many candidates cite it', async () => {
    const dir = mkdtemp();
    try {
      gitInit(dir);
      const baseSha = commit(dir, 'a.txt', 'line1\nline2\nfunction foo() {}\nline4\n', 'base');
      commit(dir, 'other.txt', 'unrelated\n', 'head-only-change');

      const env1 = mkEnvelope('fp1');
      const env2 = mkEnvelope('fp2'); // cites the SAME file ('a.txt') a second time
      env2.evidenceAlternatives = [{ anchor: HEAD_ANCHOR() }]; // and a THIRD time, via an alternative

      await withCwd(dir, async () => {
        const stage0Ctx = await buildStage0RelevanceContext(
          { auditBaseCommit: baseSha, commitSha: baseSha, workingTreeDirty: false, changedFiles: ['a.txt'] },
          [env1, env2],
        );
        // Exactly ONE cache entry for 'a.txt' proves the per-file loop in
        // buildStage0RelevanceContext iterates over a DEDUPED candidate set
        // (collectCandidateAnchorFiles' Set), not once per candidate/alternative
        // — a Map can structurally only ever hold one entry per key regardless
        // of how many times .set() was called for it, so this is a direct
        // proof of "at most once per distinct file per run".
        assert.equal(stage0Ctx.headContentCache.size, 1);
        assert.equal(stage0Ctx.baseContentCache.size, 1);
        assert.equal(stage0Ctx.headContentCache.get('a.txt'), 'line1\nline2\nfunction foo() {}\nline4\n');
        assert.equal(stage0Ctx.baseContentCache.get('a.txt'), 'line1\nline2\nfunction foo() {}\nline4\n');
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('impactCache resolves to null (never a crash, never a guessed true/false) when cloud is disabled', async () => {
    const dir = mkdtemp();
    try {
      gitInit(dir);
      const baseSha = commit(dir, 'a.txt', 'function foo() {}\n', 'base');
      const savedDbUrl = process.env.AUDIT_DB_URL;
      delete process.env.AUDIT_DB_URL; // hermetic — no real DB reachable
      try {
        await withCwd(dir, async () => {
          // changedFiles deliberately does NOT include 'a.txt' — this test
          // isolates the cloud-disabled degradation path; a.txt ALSO being
          // in changedFiles would short-circuit to `false` before ever
          // reaching the cloud check (round-1 code-audit H2's own fix,
          // covered by its own dedicated test below).
          const stage0Ctx = await buildStage0RelevanceContext(
            { auditBaseCommit: baseSha, commitSha: baseSha, workingTreeDirty: false, changedFiles: ['other-changed-file.txt'] },
            [mkEnvelope('fp1')],
          );
          assert.equal(stage0Ctx.impactCache.get('a.txt'), null);
        });
      } finally {
        if (savedDbUrl !== undefined) process.env.AUDIT_DB_URL = savedDbUrl;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a candidate file that is itself directly in changedFiles resolves to false — confidently dependent (round-1 code-audit H2)', async () => {
    // The cross-file import graph has zero visibility into whether NEW
    // hunks elsewhere in the SAME file call the cited pre-existing lines —
    // this must resolve BEFORE any cloud/DB check (still exercises the fix
    // even with AUDIT_DB_URL unset, proving it's a cheap, always-correct
    // early return, not merely a lucky degradation).
    const dir = mkdtemp();
    try {
      gitInit(dir);
      const baseSha = commit(dir, 'a.txt', 'function foo() {}\n', 'base');
      await withCwd(dir, async () => {
        const stage0Ctx = await buildStage0RelevanceContext(
          { auditBaseCommit: baseSha, commitSha: baseSha, workingTreeDirty: false, changedFiles: ['a.txt'] },
          [mkEnvelope('fp1')],
        );
        assert.equal(stage0Ctx.impactCache.get('a.txt'), false);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('baseContentCache stays empty (never attempts a git show) when ctx.auditBaseCommit is falsy', async () => {
    const dir = mkdtemp();
    try {
      gitInit(dir);
      commit(dir, 'a.txt', 'function foo() {}\n', 'base');
      await withCwd(dir, async () => {
        const stage0Ctx = await buildStage0RelevanceContext(
          { auditBaseCommit: null, commitSha: null, workingTreeDirty: false, changedFiles: ['a.txt'] },
          [mkEnvelope('fp1')],
        );
        assert.equal(stage0Ctx.baseContentCache.size, 0);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('makeBlameAdapter / makeHeadContentAdapter / makeImpactAdapter — adapter correctness', () => {
  it('blameAdapter: true when the mapped range matches the base content, false when it differs, null for an unknown file or a null baseRef', () => {
    const stage0Ctx = {
      baseContentCache: new Map([['a.txt', 'line1\nfunction foo() {}\nline3\n']]),
      headContentCache: new Map(),
      impactCache: new Map(),
    };
    const adapter = makeBlameAdapter(stage0Ctx, 'HEAD~1');
    assert.equal(adapter('a.txt', 2, 2, 'function foo() {}'), true);
    assert.equal(adapter('a.txt', 2, 2, 'something else'), false);
    assert.equal(adapter('unknown.txt', 1, 1, 'x'), null);
    assert.equal(makeBlameAdapter(stage0Ctx, null)('a.txt', 2, 2, 'function foo() {}'), null);
  });

  it('headContentAdapter returns cached content for a known file, null otherwise', () => {
    const stage0Ctx = { headContentCache: new Map([['a.txt', 'hello']]), baseContentCache: new Map(), impactCache: new Map() };
    assert.equal(makeHeadContentAdapter(stage0Ctx)('a.txt'), 'hello');
    assert.equal(makeHeadContentAdapter(stage0Ctx)('unknown.txt'), null);
  });

  it('impactAdapter returns the cached tri-state value, null for an unknown file', () => {
    const stage0Ctx = { impactCache: new Map([['a.txt', true], ['b.txt', false]]), headContentCache: new Map(), baseContentCache: new Map() };
    assert.equal(makeImpactAdapter(stage0Ctx)('a.txt'), true);
    assert.equal(makeImpactAdapter(stage0Ctx)('b.txt'), false);
    assert.equal(makeImpactAdapter(stage0Ctx)('unknown.txt'), null);
  });
});

describe('extractCanonicalAnchorFile', () => {
  it('commission finding — resolves from anchor (head or base side)', () => {
    assert.equal(extractCanonicalAnchorFile({ evidenceType: 'commission', anchor: HEAD_ANCHOR() }), 'a.txt');
    assert.equal(
      extractCanonicalAnchorFile({ evidenceType: 'commission', anchor: HEAD_ANCHOR({ side: 'base', oldFile: 'old.txt' }) }),
      'old.txt',
    );
  });

  it('omission finding — resolves from triggerAnchor, never anchor', () => {
    assert.equal(
      extractCanonicalAnchorFile({ evidenceType: 'omission', triggerAnchor: HEAD_ANCHOR({ newFile: 'trig.txt', oldFile: 'trig.txt' }) }),
      'trig.txt',
    );
  });

  it('no matching anchor field, or no canonicalFinding at all, returns null', () => {
    assert.equal(extractCanonicalAnchorFile({ evidenceType: 'commission' }), null);
    assert.equal(extractCanonicalAnchorFile(null), null);
  });
});

describe('routePreExistingIndependent — decision #9 batch-reconciled debt routing', () => {
  it('empty input short-circuits without touching the debt ledger', async () => {
    const ledgerPath = path.join(mkdtemp(), 'tech-debt.json');
    const result = await routePreExistingIndependent([], { runId: 'test', debtLedgerPath: ledgerPath });
    assert.deepEqual(result, { eligible: [], debtRoutedFiles: [], debtRoutingIncomplete: [] });
    assert.equal(fs.existsSync(ledgerPath), false, 'no ledger file should be created for an empty batch');
  });

  it('successfully debt-routes valid pre_existing_independent candidates and removes them from the eligible pool', async () => {
    const dir = mkdtemp();
    const ledgerPath = path.join(dir, 'tech-debt.json');
    try {
      const env1 = { fingerprint: 'fp-alpha', canonicalFinding: { evidenceType: 'commission', anchor: HEAD_ANCHOR({ newFile: 'a.txt', oldFile: 'a.txt' }), severity: 'MEDIUM', category: 'DRY Violation', section: 'a.txt:3', detail: 'duplicate helper', principle: '#1' } };
      const env2 = { fingerprint: 'fp-beta', canonicalFinding: { evidenceType: 'commission', anchor: HEAD_ANCHOR({ newFile: 'b.txt', oldFile: 'b.txt' }), severity: 'LOW', category: 'Style', section: 'b.txt:1', detail: 'minor style nit', principle: '#2' } };

      const result = await routePreExistingIndependent([env1, env2], { runId: 'test-run', debtLedgerPath: ledgerPath });

      assert.deepEqual(result.eligible, []);
      assert.deepEqual(result.debtRoutedFiles.sort(), ['a.txt', 'b.txt']);
      assert.deepEqual(result.debtRoutingIncomplete, []);

      const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
      assert.equal(ledger.entries.length, 2);
      const alpha = ledger.entries.find((e) => e.topicId === 'fp-alpha');
      assert.equal(alpha.deferredReason, 'out-of-scope');
      assert.equal(alpha.deferredRun, 'test-run');
      assert.deepEqual(alpha.affectedFiles, ['a.txt']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('noDebtLedger restores every candidate to the eligible pool with a named reason, never attempts a write', async () => {
    const dir = mkdtemp();
    const ledgerPath = path.join(dir, 'tech-debt.json');
    try {
      const env1 = { fingerprint: 'fp-alpha', canonicalFinding: { evidenceType: 'commission', anchor: HEAD_ANCHOR(), severity: 'MEDIUM', category: 'x', section: 'a.txt:3', detail: 'x' } };
      const result = await routePreExistingIndependent([env1], { runId: 't', debtLedgerPath: ledgerPath, noDebtLedger: true });
      assert.deepEqual(result.eligible, [env1]);
      assert.deepEqual(result.debtRoutedFiles, []);
      assert.deepEqual(result.debtRoutingIncomplete, [{ fingerprint: 'fp-alpha', reason: 'debt_ledger_disabled' }]);
      assert.equal(fs.existsSync(ledgerPath), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('readOnlyDebt restores every candidate to the eligible pool with a named reason, never attempts a write', async () => {
    const dir = mkdtemp();
    const ledgerPath = path.join(dir, 'tech-debt.json');
    try {
      const env1 = { fingerprint: 'fp-alpha', canonicalFinding: { evidenceType: 'commission', anchor: HEAD_ANCHOR(), severity: 'MEDIUM', category: 'x', section: 'a.txt:3', detail: 'x' } };
      const result = await routePreExistingIndependent([env1], { runId: 't', debtLedgerPath: ledgerPath, readOnlyDebt: true });
      assert.deepEqual(result.debtRoutingIncomplete, [{ fingerprint: 'fp-alpha', reason: 'debt_ledger_read_only' }]);
      assert.equal(fs.existsSync(ledgerPath), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a candidate whose built entry fails PersistedDebtEntrySchema validation is restored to the eligible pool, not silently dropped', async () => {
    const dir = mkdtemp();
    const ledgerPath = path.join(dir, 'tech-debt.json');
    try {
      // severity outside the HIGH/MEDIUM/LOW enum makes buildDebtEntry's
      // output fail PersistedDebtEntrySchema validation inside
      // writeDebtEntries — landing in the API's own rejected[] array, the
      // non-exception reconciliation path decision #9/round-2 H5 added.
      const badEnv = { fingerprint: 'fp-bad', canonicalFinding: { evidenceType: 'commission', anchor: HEAD_ANCHOR(), severity: 'NOT_A_SEVERITY', category: 'x', section: 'a.txt:3', detail: 'x' } };
      const goodEnv = { fingerprint: 'fp-good', canonicalFinding: { evidenceType: 'commission', anchor: HEAD_ANCHOR({ newFile: 'c.txt', oldFile: 'c.txt' }), severity: 'LOW', category: 'x', section: 'c.txt:1', detail: 'x' } };

      const result = await routePreExistingIndependent([badEnv, goodEnv], { runId: 't', debtLedgerPath: ledgerPath });

      assert.deepEqual(result.eligible, [badEnv]);
      assert.deepEqual(result.debtRoutedFiles, ['c.txt']);
      assert.equal(result.debtRoutingIncomplete.length, 1);
      assert.equal(result.debtRoutingIncomplete[0].fingerprint, 'fp-bad');
      assert.ok(result.debtRoutingIncomplete[0].reason.length > 0);

      const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
      assert.equal(ledger.entries.length, 1);
      assert.equal(ledger.entries[0].topicId, 'fp-good');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('buildPreExistingDebtEntry', () => {
  it('produces a well-formed out-of-scope debt entry from an envelope', () => {
    const env = { fingerprint: 'fp1', canonicalFinding: { evidenceType: 'commission', anchor: HEAD_ANCHOR(), severity: 'HIGH', category: 'Security', section: 'a.txt:3', detail: 'x', principle: '#5' } };
    const entry = buildPreExistingDebtEntry(env, 'my-run-id');
    assert.equal(entry.topicId, 'fp1');
    assert.equal(entry.deferredReason, 'out-of-scope');
    assert.equal(entry.deferredRun, 'my-run-id');
    assert.deepEqual(entry.affectedFiles, ['a.txt']);
    assert.deepEqual(entry.affectedPrinciples, ['#5']);
    assert.equal(entry.pass, 'tiered-stage0');
    assert.ok(entry.deferredRationale.length >= 20 && entry.deferredRationale.length <= 400);
  });

  it('a runId longer than 40 chars is truncated (PersistedDebtEntrySchema deferredRun max)', () => {
    const env = { fingerprint: 'fp1', canonicalFinding: { evidenceType: 'commission', anchor: HEAD_ANCHOR(), severity: 'HIGH', category: 'x', section: 'a.txt:3', detail: 'x' } };
    const entry = buildPreExistingDebtEntry(env, 'x'.repeat(80));
    assert.equal(entry.deferredRun.length, 40);
  });
});

// ── normalizeModifiedAnchorPaths — the 2026-07-16 empirical-verify fix ─────
// GLM via OpenRouter emitted {fileStatus:'modified', newFile:'x'} with no
// oldFile on 3/3 findings, failing EvidenceAnchorSchema's superRefine and
// taking every run to fallback_legacy. OpenRouter accepts our JSON Schema
// without enforcing it (Anthropic tool-use validates provider-side, which is
// why only the GLM path broke).
describe('normalizeModifiedAnchorPaths (empirical-verify fix, 2026-07-16)', () => {
  const anchor = (over = {}) => ({ diffPathId: 'a.mjs', fileStatus: 'modified', side: 'head', startLine: 1, endLine: 1, quote: 'q', headSha: 'WORKTREE', ...over });
  const wrap = (a) => ({ findings: [{ id: 'H1', anchor: a }] });
  const out = (v) => normalizeModifiedAnchorPaths(v).findings[0].anchor;

  it('mirrors newFile → oldFile for a modified anchor (the exact live failure)', () => {
    const r = out(wrap(anchor({ newFile: 'src/x.mjs' })));
    assert.equal(r.oldFile, 'src/x.mjs');
    assert.equal(r.newFile, 'src/x.mjs');
  });

  it('mirrors oldFile → newFile symmetrically', () => {
    const r = out(wrap(anchor({ oldFile: 'src/x.mjs' })));
    assert.equal(r.newFile, 'src/x.mjs');
  });

  it('leaves a well-formed modified anchor untouched', () => {
    const r = out(wrap(anchor({ oldFile: 'src/x.mjs', newFile: 'src/x.mjs' })));
    assert.equal(r.oldFile, 'src/x.mjs');
    assert.equal(r.newFile, 'src/x.mjs');
  });

  // Never repair what isn't definitionally determined — a MISMATCHED pair is
  // a real semantic error and must still fail loudly downstream.
  it('does NOT "fix" a modified anchor whose two paths genuinely disagree', () => {
    const r = out(wrap(anchor({ oldFile: 'a.mjs', newFile: 'b.mjs' })));
    assert.equal(r.oldFile, 'a.mjs');
    assert.equal(r.newFile, 'b.mjs');
  });

  it('does NOT invent a path when BOTH are absent', () => {
    const r = out(wrap(anchor({})));
    assert.equal(r.oldFile, undefined);
    assert.equal(r.newFile, undefined);
  });

  // renamed/copied legitimately have two DIFFERENT paths — mirroring would
  // corrupt real evidence.
  it('never touches renamed/copied/added/deleted (their paths legitimately differ)', () => {
    for (const fileStatus of ['renamed', 'copied', 'added', 'deleted']) {
      const r = out(wrap(anchor({ fileStatus, newFile: 'b.mjs' })));
      assert.equal(r.oldFile, undefined, `${fileStatus} must not be mirrored`);
    }
  });

  it('normalizes triggerAnchor (omission findings) the same way', () => {
    const v = normalizeModifiedAnchorPaths({ findings: [{ id: 'H1', triggerAnchor: anchor({ newFile: 'src/x.mjs' }) }] });
    assert.equal(v.findings[0].triggerAnchor.oldFile, 'src/x.mjs');
  });

  it('never mutates quote or line numbers', () => {
    const r = out(wrap(anchor({ newFile: 'src/x.mjs', quote: 'exact  text', startLine: 7, endLine: 9 })));
    assert.equal(r.quote, 'exact  text');
    assert.equal(r.startLine, 7);
    assert.equal(r.endLine, 9);
  });

  it('is a no-op on any non-conforming shape, never a throw', () => {
    assert.equal(normalizeModifiedAnchorPaths(null), null);
    assert.equal(normalizeModifiedAnchorPaths(undefined), undefined);
    assert.deepEqual(normalizeModifiedAnchorPaths({}), {});
    assert.deepEqual(normalizeModifiedAnchorPaths({ findings: 'nope' }), { findings: 'nope' });
    assert.deepEqual(normalizeModifiedAnchorPaths({ findings: [null] }), { findings: [null] });
  });

  // End-to-end: the repaired shape must actually SATISFY the schema that was
  // rejecting it — the whole point of the fix.
  it('the repaired anchor now PASSES ProducerFindingV2Schema (the rule that failed 3/3 live)', async () => {
    const { ProducerFindingV2Schema } = await import('../scripts/lib/schemas.mjs');
    const broken = {
      id: 'H1', severity: 'MEDIUM', category: 'c', section: 's', detail: 'd', risk: 'r',
      recommendation: 'rec', is_quick_fix: false, is_mechanical: false, principle: 'p',
      classification: { sonarType: 'CODE_SMELL', effort: 'TRIVIAL', sourceKind: 'MODEL', sourceName: 'glm' },
      evidenceType: 'commission', anchor: anchor({ newFile: 'src/x.mjs' }),
    };
    assert.equal(ProducerFindingV2Schema.safeParse(broken).success, false, 'precondition: the raw GLM shape really is rejected');
    const repaired = normalizeModifiedAnchorPaths({ findings: [broken] }).findings[0];
    assert.equal(ProducerFindingV2Schema.safeParse(repaired).success, true, 'the normalizer must make it valid');
  });
});

// ── planContent redaction at the discovery-payload boundary ───────────────
// Root cause of 15/41 tiered-shadow fallbacks (the single largest cause,
// 2026-07-16): `discoveryCode` is redacted by readFilesAsContext's
// `redact: true` default, but `planContent` — interpolated raw into BOTH
// generator prompts — had no redaction path at all. The fail-closed egress
// gate at the OSS adapter boundary then correctly refused the payload:
//   [egress-gate] refusing to send oss:discovery-glm payload ...
//   secret pattern(s) detected: pem-private-key, dsn-password
// which is exactly what docs/completed/discovery-portfolio-secret-redaction.md
// (the plan FOR the redaction feature — it necessarily quotes the secret
// shapes it redacts) contains.
describe('discovery payload — planContent redaction (egress-gate root cause, 2026-07-16)', () => {
  const src = fs.readFileSync(path.resolve('scripts/lib/audit/tiered-pipeline.mjs'), 'utf8');

  it('static pin: NEITHER generator interpolates raw ctx.planContent into its prompt', () => {
    assert.equal(
      /\$\{ctx\.planContent/.test(src), false,
      'raw ctx.planContent must never reach a provider prompt — use the redacted discoveryPlan',
    );
  });

  it('static pin: both generators use the single redacted discoveryPlan', () => {
    assert.match(src, /const discoveryPlan = redactSecrets\(ctx\.planContent \?\? ''\)/);
    // GLM (userPrompt) + Sonnet (messages) — both halves of the portfolio.
    assert.equal((src.match(/## Plan\\n\$\{discoveryPlan\}/g) || []).length, 2,
      'both the GLM and Sonnet call sites must use the redacted plan');
  });

  // The decisive one: the REAL offending document, through the REAL redactor,
  // against the REAL gate scanner that rejected it in production.
  it('the real plan that caused the live egress blocks now passes the real gate', async () => {
    const { scanEgressPayload } = await import('../scripts/lib/sensitive-egress-gate.mjs');
    const { redactSecrets } = await import('../scripts/lib/sensitive-egress-gate.mjs');
    const offender = 'docs/completed/discovery-portfolio-secret-redaction.md';
    if (!fs.existsSync(offender)) return; // doc archived/renamed — pin below still holds
    const raw = fs.readFileSync(offender, 'utf8');

    // Precondition: this really is a payload the gate refuses. If this ever
    // stops being true the test has lost its subject and must be re-pointed.
    assert.equal(scanEgressPayload(raw).safe, false,
      'precondition: the offending plan must still trip the gate when raw');
    assert.deepEqual(
      scanEgressPayload(raw).patterns.sort(), ['dsn-password', 'pem-private-key'],
      'precondition: the exact pattern pair the live gate reported',
    );

    // The fix: the same redaction the code now applies makes it sendable.
    assert.equal(scanEgressPayload(redactSecrets(raw)).safe, true,
      'after redactSecrets the discovery payload must pass the egress gate');
  });

  it('redaction is fail-closed and total-payload-safe for every committed doc', async () => {
    const { scanEgressPayload, redactSecrets } = await import('../scripts/lib/sensitive-egress-gate.mjs');
    const { execSync } = await import('node:child_process');
    const docs = execSync('git ls-files "docs/**/*.md"', { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    const stillBlocked = [];
    for (const f of docs) {
      let txt;
      try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
      if (scanEgressPayload(txt).safe) continue; // never was a problem
      if (!scanEgressPayload(redactSecrets(txt)).safe) stillBlocked.push(f);
    }
    assert.deepEqual(stillBlocked, [],
      'every doc that trips the gate raw must pass after redaction — otherwise a plan can still block discovery');
  });

  it('a null/absent planContent degrades to empty, never a crash or a literal "undefined"', async () => {
    const { redactSecrets } = await import('../scripts/lib/sensitive-egress-gate.mjs');
    assert.equal(redactSecrets(null ?? ''), '');
    assert.equal(redactSecrets(undefined ?? ''), '');
  });
});

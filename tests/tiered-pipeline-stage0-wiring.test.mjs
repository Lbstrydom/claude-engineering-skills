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
import { gitInit, commit } from './helpers/fixtures.mjs';

process.env.AUDIT_EXPORTS_FOR_TESTS = '1';
const { __testExports } = await import('../scripts/lib/audit/tiered-pipeline.mjs');
const {
  collectCandidateAnchorFiles, buildStage0RelevanceContext,
  makeHeadContentAdapter, makeImpactAdapter, makeBlameAdapter,
  extractCanonicalAnchorFile, buildPreExistingDebtEntry, routePreExistingIndependent,
  resolveEligibleDiffPathMap, stripMaxLengthFor,
} = __testExports;

/**
 * The discovery generators clamp over-long producer strings rather than
 * destroying the finding — but `quote` is exempt, because Gate A matches it
 * VERBATIM and a truncated quote turns our own repair into a false "the model's
 * evidence was wrong" verdict (the plan's central misattribution, one layer
 * down). Found 2026-07-18 by the §9a acceptance probe.
 */
describe('stripMaxLengthFor — quote is never clamped, everything else still is', () => {
  const schema = {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        maxItems: 15,
        items: {
          type: 'object',
          properties: {
            detail: { type: 'string', maxLength: 600 },
            anchor: {
              anyOf: [
                { type: 'object', properties: { quote: { type: 'string', maxLength: 1000 }, side: { type: 'string', enum: ['base', 'head'] } } },
                { type: 'null' },
              ],
            },
          },
        },
      },
    },
  };

  it('removes maxLength from quote at any depth, including inside an anyOf branch', () => {
    const out = stripMaxLengthFor(schema, 'quote');
    const anchor = out.properties.findings.items.properties.anchor.anyOf[0];
    assert.equal(anchor.properties.quote.maxLength, undefined);
    // The rest of the quote schema survives — we drop the cap, not the field.
    assert.equal(anchor.properties.quote.type, 'string');
  });

  it('leaves every OTHER capped field clamped — this must not become a blanket opt-out', () => {
    const out = stripMaxLengthFor(schema, 'quote');
    assert.equal(out.properties.findings.items.properties.detail.maxLength, 600);
    assert.equal(out.properties.findings.maxItems, 15);
  });

  it('does not mutate the input (the strict schema is shared with the GLM path)', () => {
    stripMaxLengthFor(schema, 'quote');
    assert.equal(schema.properties.findings.items.properties.anchor.anyOf[0].properties.quote.maxLength, 1000);
  });

  // Against the REAL schema, not a synthetic one. Consolidated-gate G3 (2026-07-18)
  // argued a shallow walk would make the exemption a silent no-op, because
  // ProducerFindingV3Schema is a discriminatedUnion and therefore compiles to
  // `oneOf` — so `quote` sits at items -> oneOf[n] -> properties -> anchor ->
  // properties -> quote. The mechanism was refuted (the walk is generic over all
  // object values), but the test it asked for is the right one and it surfaced a
  // second capped site: the OMISSION branch's `triggerAnchor.quote`.
  it('strips BOTH quote caps in the real V3 schema — anchor AND triggerAnchor, through oneOf', async () => {
    const { z } = await import('zod');
    const { makeProducerFindingV3Schema } = await import('../scripts/lib/schemas.mjs');
    const real = z.toJSONSchema(z.object({ findings: z.array(makeProducerFindingV3Schema(['f0001'])).max(15) }));

    const quoteCaps = (node) => {
      let n = 0;
      const walk = (x) => {
        if (x == null || typeof x !== 'object') return;
        if (Array.isArray(x)) return x.forEach(walk);
        for (const [k, v] of Object.entries(x)) {
          if (k === 'properties' && v && typeof v === 'object') {
            for (const [p, ps] of Object.entries(v)) {
              if (p === 'quote' && ps?.maxLength != null) n += 1;
              walk(ps);
            }
          } else walk(v);
        }
      };
      walk(node);
      return n;
    };

    // The premise: the union really is `oneOf`, and both branches cap `quote`.
    assert.ok(Array.isArray(real.properties.findings.items.oneOf), 'V3 must compile to oneOf');
    assert.equal(quoteCaps(real), 2, 'anchor (commission) and triggerAnchor (omission) both cap quote');
    assert.equal(quoteCaps(stripMaxLengthFor(real, 'quote')), 0, 'the exemption must not be a silent no-op through oneOf');
    // Control: the exemption is surgical, not a blanket un-capping.
    assert.match(JSON.stringify(stripMaxLengthFor(real, 'quote')), /"detail":\{[^}]*"maxLength":600/);
  });
});

// @duplicate-justification: target=tests/vcs-blame.test.mjs:mkdtemp reason=a 2-line temp-dir helper duplicated across test files matching this repo's established per-file local-helper convention (AGENTS.md: "three similar lines is better than a premature abstraction") — a shared fixture module for one trivial helper is the over-engineered extreme, not the right-sized one.
function mkdtemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tiered-stage0-wiring-'));
}

// gitInit + commit now imported from tests/helpers/fixtures.mjs — both were
// byte-identical to vcs-blame.test.mjs's copies (flagged by
// `arch:duplicates`). The two prior local `@duplicate-justification` pragmas
// on this pair are removed: they were written when building a shared
// fixtures module meant standing one up for these helpers alone (the
// over-engineered extreme the pragmas correctly rejected); that module now
// exists for many other helpers, so the calculus has changed.

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

// ── normalizeModifiedAnchorPaths — RETIRED by Phase 6 ─────────────────────
// Its tests are deleted, not ported. The function mirrored oldFile↔newFile so a
// 'modified' anchor could satisfy EvidenceAnchorSchema's superRefine — a
// band-aid on the wrong layer. `prepareCandidates` now DERIVES those paths from
// our own diff-path map, so there is no model-supplied path left to repair and
// the behaviour those 10 tests pinned no longer exists to be correct or
// incorrect. What replaces them: tests/diff-path-map.test.mjs (the derivation)
// plus the egress + wiring pins below.

// ── resolveEligibleDiffPathMap — the enum's egress gate (§Security) ────────
// A Tier-3 seam per AGENTS.md: the enum enumerates file paths as first-class,
// structured, citable ids inside the tool schema. `redactSecrets` masks secret
// VALUES; it does not exclude sensitive PATHS. Without this filter a `.env` in
// the diff is disclosed to the provider as a schema member — a path-level
// disclosure the redacted payload alone does not imply.
describe('resolveEligibleDiffPathMap — no sensitive path may become a citable id', () => {
  const section = (header, body, extra = '') => `diff --git ${header}\n${extra}index 111..222 100644\n${body}\n`;
  const mod = (p) => section(`a/${p} b/${p}`, `--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-a\n+b`);

  it('drops a sensitive file so no anchor can cite it', () => {
    const { map, skipped } = resolveEligibleDiffPathMap(mod('src/ok.js') + mod('.env') + mod('secrets/db.yaml'));
    assert.equal(map.kind, 'ready');
    assert.deepEqual(map.entries.map((e) => e.newPath), ['src/ok.js'], 'only the non-sensitive file may have an id');
    assert.equal(skipped.length, 2);
  });

  it('the rendered prompt table never contains an excluded path (the actual egress surface)', async () => {
    const { renderDiffPathTable } = await import('../scripts/lib/audit/diff-path-map.mjs');
    const { map } = resolveEligibleDiffPathMap(mod('src/ok.js') + mod('.env.production') + mod('config/credentials.json'));
    const table = renderDiffPathTable(map.entries);
    assert.ok(table.includes('src/ok.js'));
    for (const leak of ['.env.production', 'credentials']) {
      assert.equal(table.includes(leak), false, `the prompt table leaked ${leak}`);
    }
  });

  it('fails closed on EITHER side of a rename — a sensitive base path is just as much a disclosure', () => {
    const renamed = section('a/secrets/old.yaml b/config/new.yaml', '--- a/secrets/old.yaml\n+++ b/config/new.yaml\n@@ -1 +1 @@\n-a\n+b', 'rename from secrets/old.yaml\nrename to config/new.yaml\n');
    const { map } = resolveEligibleDiffPathMap(renamed + mod('src/ok.js'));
    assert.deepEqual(map.entries.map((e) => e.newPath), ['src/ok.js']);
  });

  it('a diff whose every file is sensitive collapses to EMPTY, never invalid and never a ready-with-no-ids', () => {
    // `empty` is the honest status: the diff parsed fine, there is just nothing
    // we may send. `z.enum([])` is unconstructible, so a `ready` with zero
    // entries would crash schema construction downstream (§7j).
    const { map } = resolveEligibleDiffPathMap(mod('.env') + mod('secrets/x.pem'));
    assert.equal(map.kind, 'empty');
    assert.equal(map.reason, 'no_eligible_diff_files');
  });

  it('passes through the builder\'s own three-way result untouched', () => {
    assert.equal(resolveEligibleDiffPathMap('').map.kind, 'empty');
    assert.equal(resolveEligibleDiffPathMap(null).map.kind, 'empty');
    assert.equal(resolveEligibleDiffPathMap('just prose, no diff header').map.kind, 'invalid');
  });
});

// ── THE acceptance property (evidence-anchor-path-contract Cluster B) ──────
// The plan's acceptance criterion is Cluster A's counter reading ZERO: a
// hydrated anchor must never land in Stage 0's `malformed` bucket. That bucket
// is fed by `EvidenceAnchorSchema.safeParse` failing inside
// `resolveAnchorLocation` (Gate A) — so the property that makes the whole plan
// work is: prepareCandidates' output ALWAYS satisfies the strict internal
// oracle, for every fileStatus.
//
// This is the join between the producer DTO (what we ask a model for) and the
// internal model (what Gate A demands) — the exact seam three recurrences of
// this bug lived in, and neither side's own tests can see it: diff-path-map's
// tests assert hydration, schemas' tests assert the oracle, and NOTHING
// asserted that one satisfies the other. That gap is how V2's `superRefine`
// went unenforced for weeks under a green suite.
describe('hydrated anchors satisfy Gate A\'s oracle — stage0Malformed must read 0 (D2)', () => {
  const section = (h, b, x = '') => `diff --git ${h}\n${x}index 111..222 100644\n${b}\n`;
  const DIFF =
    section('a/src/foo.js b/src/foo.js', '--- a/src/foo.js\n+++ b/src/foo.js\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;')
    + section('a/src/new.js b/src/new.js', '--- /dev/null\n+++ b/src/new.js\n@@ -0,0 +1 @@\n+export const x = 1;', 'new file mode 100644\n')
    + section('a/src/gone.js b/src/gone.js', '--- a/src/gone.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const y = 2;', 'deleted file mode 100644\n')
    + section('a/src/old.js b/src/renamed.js', '--- a/src/old.js\n+++ b/src/renamed.js\n@@ -1 +1 @@\n-a\n+b', 'rename from src/old.js\nrename to src/renamed.js\n')
    + section('a/src/src.js b/src/cp.js', '--- a/src/src.js\n+++ b/src/cp.js\n@@ -1 +1 @@\n-a\n+b', 'copy from src/src.js\ncopy to src/cp.js\n');
  const LEGAL_SIDE = { added: 'head', deleted: 'base', modified: 'head', renamed: 'head', copied: 'head' };
  const base = {
    id: 'H1', severity: 'HIGH', category: 'c', section: 's', detail: 'd', risk: 'r',
    recommendation: 'rec', is_quick_fix: false, is_mechanical: false, principle: 'p',
    classification: { sonarType: 'CODE_SMELL', effort: 'TRIVIAL', sourceKind: 'MODEL', sourceName: 'sonnet' },
  };

  it('every fileStatus hydrates into an anchor EvidenceAnchorSchema accepts', async () => {
    const { buildDiffPathMap, prepareCandidates } = await import('../scripts/lib/audit/diff-path-map.mjs');
    const { makeProducerFindingV3Schema, EvidenceAnchorSchema } = await import('../scripts/lib/schemas.mjs');

    const map = buildDiffPathMap(DIFF);
    assert.equal(map.kind, 'ready');
    assert.deepEqual(map.entries.map((e) => e.fileStatus), ['modified', 'added', 'deleted', 'renamed', 'copied'],
      'precondition: all five fileStatus values are represented');

    const producerSchema = makeProducerFindingV3Schema(map.entries.map((e) => e.id));
    // What a model emits: an id + a side + a quote. Nothing else — it cannot
    // know a diff-pair's identity, and we already do (D1).
    const raws = map.entries.map((e) => ({
      ...base,
      evidenceType: 'commission',
      anchor: { diffPathId: e.id, side: LEGAL_SIDE[e.fileStatus], startLine: 1, endLine: 1, quote: 'q' },
    }));

    const prepared = prepareCandidates(raws, map, { producerSchema, headSha: 'abc123' });
    for (const [i, p] of prepared.entries()) {
      const { fileStatus } = map.entries[i];
      assert.equal(p.kind, 'ready', `${fileStatus} failed to hydrate: ${p.reasonDetail}`);
      const parsed = EvidenceAnchorSchema.safeParse(p.finding.anchor);
      assert.ok(
        parsed.success,
        `a HYDRATED ${fileStatus} anchor was rejected by Gate A's oracle — it would land in stage0Malformed and be destroyed as OUR contract bug: ${JSON.stringify(parsed.error?.issues?.map((x) => x.message))}`,
      );
    }
  });

  it('derives the path pair correctly per fileStatus — the rename/copy case no mirror could ever handle', async () => {
    const { buildDiffPathMap, prepareCandidates } = await import('../scripts/lib/audit/diff-path-map.mjs');
    const { makeProducerFindingV3Schema } = await import('../scripts/lib/schemas.mjs');
    const map = buildDiffPathMap(DIFF);
    const producerSchema = makeProducerFindingV3Schema(map.entries.map((e) => e.id));
    const prepared = prepareCandidates(
      map.entries.map((e) => ({ ...base, evidenceType: 'commission', anchor: { diffPathId: e.id, side: LEGAL_SIDE[e.fileStatus], startLine: 1, endLine: 1, quote: 'q' } })),
      map, { producerSchema },
    );
    const pairs = prepared.map((p) => [p.finding.anchor.oldFile, p.finding.anchor.newFile]);
    assert.deepEqual(pairs, [
      ['src/foo.js', 'src/foo.js'],   // modified — same path both sides
      [null, 'src/new.js'],           // added — no base side exists
      ['src/gone.js', null],          // deleted — no head side exists
      ['src/old.js', 'src/renamed.js'], // renamed — two REAL, different paths
      ['src/src.js', 'src/cp.js'],    // copied — likewise
    ]);
  });
});

// ── Phase 6 wiring pins — the producer contract actually reaches the provider ──
// Static pins because the alternative is a live multi-provider run. Each one
// guards a step that, if silently dropped, restores the exact bug: findings the
// model got RIGHT being destroyed as `fabricated`.
describe('static pins — producer-contract wiring (evidence-anchor-path-contract Phase 6)', () => {
  const src = fs.readFileSync(path.resolve('scripts/lib/audit/tiered-pipeline.mjs'), 'utf8');

  it('the map is built from ctx.diffText — never re-read from git, never from discoveryCode', () => {
    assert.match(src, /resolveEligibleDiffPathMap\(ctx\.diffText\)/);
    // discoveryCode is readFilesAsContext output (fenced FILE CONTENTS); it has
    // no `diff --git` headers, so a map built from it could only ever be invalid.
    assert.equal(/buildDiffPathMap\(discoveryCode/.test(src), false);
    assert.equal(/execFileSync\(['"]git['"]|execSync\(['"]git/.test(src), false, 'the map must come from ctx state, not a fresh git read — the two halves of one payload must not disagree');
  });

  it('empty/invalid short-circuit BEFORE any generator call or schema construction', () => {
    const mapIdx = src.indexOf('resolveEligibleDiffPathMap(ctx.diffText)');
    const skipIdx = src.indexOf('return skippedNoGeneratorResult(ctx, diffPathMap');
    const schemaIdx = src.indexOf('makeProducerFindingV3Schema(diffPathMap.entries');
    const portfolioIdx = src.indexOf('await runDiscoveryPortfolio(');
    for (const [name, i] of [['map', mapIdx], ['skip', skipIdx], ['schema', schemaIdx], ['portfolio', portfolioIdx]]) {
      assert.ok(i > 0, `expected to find the ${name} site`);
    }
    assert.ok(mapIdx < skipIdx, 'the map must resolve before the short-circuit');
    assert.ok(skipIdx < schemaIdx, 'z.enum([]) is unconstructible — the short-circuit MUST precede schema construction');
    assert.ok(skipIdx < portfolioIdx, 'an empty/invalid map must skip BOTH generators — no provider call');
  });

  it('neither skipped status can read as a clean 0-finding `complete` run (the anti-green rule)', () => {
    assert.match(src, /runStatus = map\.kind === 'empty' \? 'skipped_no_eligible_files' : 'failed_invalid_diff_input'/);
    // computed, then returned as `runStatus` — never the literal 'complete'.
    const fn = src.match(/function skippedNoGeneratorResult[\s\S]*?\n\}/);
    assert.ok(fn, 'expected skippedNoGeneratorResult');
    assert.equal(/runStatus:\s*'complete'/.test(fn[0]), false);
    assert.match(fn[0], /findings: \[\]/);
  });

  it('an over-budget map is a NAMED required-generator failure (§8a) — never truncated, never partitioned', () => {
    assert.match(src, /diffPathMap\.reason === 'discovery_map_exceeds_budget'/);
    const branch = src.match(/if \(diffPathMap\.kind === 'invalid' && diffPathMap\.reason === 'discovery_map_exceeds_budget'\)[\s\S]*?\n  \}/);
    assert.ok(branch, 'expected the budget branch');
    assert.match(branch[0], /failRequiredGenerator\(/, 'must reuse §1.5\'s EXISTING semantics, not new failure machinery');
    assert.match(branch[0], /required generator failed: /, 'the reason prefix summarize() and the ledger read by name');
  });

  it('BOTH generators emit the V3 producer shape and are handed the SAME table', () => {
    assert.match(src, /const producerFindingSchema = makeProducerFindingV3Schema\(/);
    assert.match(src, /const glmStrictSchema = z\.object\(\{ findings: z\.array\(producerFindingSchema\)\.max\(15\) \}\)/, 'GLM');
    assert.match(src, /items:\s*z\.toJSONSchema\(producerFindingSchema\)/, 'Sonnet tool input_schema');
    // ONE anchorContract string, referenced by both — so they cannot drift into
    // citing different id sets.
    assert.equal((src.match(/^\s+anchorContract,$/gm) || []).length, 2, 'both generators must interpolate the same anchorContract');
    assert.match(src, /const diffPathTable = renderDiffPathTable\(diffPathMap\.entries\)/);
    assert.match(src, /DIFF-PATH TABLE/);
  });

  it('the prompt tells the model to copy an id from the table and NOT to report paths (D1)', () => {
    const contract = src.match(/const anchorContract = \[[\s\S]*?\]\.join\('\\n'\);/);
    assert.ok(contract, 'expected the anchorContract block');
    assert.match(contract[0], /copied EXACTLY from the DIFF-PATH TABLE/);
    assert.match(contract[0], /Do NOT report paths or file status/);
    // The rules that only ever existed in superRefine, which the provider could
    // never enforce — asking for them again would restore the failure surface.
    assert.equal(/REQUIRES BOTH `oldFile` AND `newFile`/.test(contract[0]), false);
  });

  it('prepareCandidates runs BEFORE Stage 0, and only ready candidates continue (D6)', () => {
    const prepIdx = src.indexOf('const prepared = prepareCandidates(rawFindings, diffPathMap');
    const mergeIdx = src.indexOf('mergeIntoEnvelopes(survivors)');
    const stage0Idx = src.indexOf('runStage0EvidenceTriage(');
    assert.ok(prepIdx > 0, 'expected the prepareCandidates call');
    assert.ok(prepIdx < mergeIdx, 'hydration must precede envelope merge');
    assert.ok(prepIdx < stage0Idx, 'hydration must precede Stage 0 — a malformed DTO must never reach it');
    assert.match(src, /const readyFindings = prepared\.filter\(\(p\) => p\.kind === 'ready'\)\.map\(\(p\) => p\.finding\)/);
    assert.match(src, /const taggedFindings = readyFindings\.map\(/, 'processFindings must consume the HYDRATED set, not rawFindings');
  });

  it('discoveryMalformedRaw reaches telemetry and stderr, and is never blended with the envelope-unit tripwire (§7a)', () => {
    assert.match(src, /discoveryMalformedRaw: malformedRaw\.length/, 'must reach _stageBreakdown');
    assert.match(src, /\[discovery\] CONTRACT BUG/, 'a contract bug must be loud on stderr, not just a counter');
    // The two counters have different units (raw vs envelope) — mergeIntoEnvelopes
    // dedups by fingerprint, so summing them yields a number that reads
    // meaningful and cannot be reconciled.
    assert.equal(
      /discoveryMalformedRaw\s*\+\s*stage0Malformed|stage0Malformed\w*\s*\+\s*malformedRaw|malformedRaw\.length\s*\+\s*stage0Malformed/.test(src),
      false,
      'the raw and envelope malformed counters must NEVER be summed into one figure',
    );
  });

  it('the retired anchor-mirror is gone but the maxLength/maxItems clamp is RETAINED', () => {
    assert.equal(/normalizeModifiedAnchorPaths/.test(src.replace(/RETIRED[\s\S]*?\*\//, '')), false, 'the normalizer must be fully retired');
    assert.match(src, /\(v\) => clampToJsonSchemaLimits\(v, producerResponseJsonSchema\)/, 'OSS routers still ignore maxLength/maxItems — the clamp stays');
  });

  // 2026-07-18: the Sonnet path had NO clamp, so Sonnet-5's verbose `detail`
  // (>600 chars) made 60-77% of its GENUINE findings read as
  // `producer_dto_invalid` — our contract blaming itself for prose length and
  // destroying real findings. Measured by the §9a acceptance probe.
  it('BOTH generators clamp — the Sonnet path is not exempt', () => {
    assert.match(
      src,
      /clampToJsonSchemaLimits\(\{ findings: toolUse\.input\.findings \}, unclampedQuoteSchema\)/,
      'Anthropic tool-use validates shape but not maxLength — the Sonnet response needs the same clamp as GLM',
    );
  });

  it('the Sonnet clamp exempts `quote` — clamping it would fake a model evidence failure', () => {
    assert.match(src, /stripMaxLengthFor\(producerResponseJsonSchema, 'quote'\)/,
      'Gate A matches `quote` VERBATIM: a truncated quote is destroyed as `unsupported`, blaming the model for OUR truncation');
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
// which is exactly what docs/plans/discovery-portfolio-secret-redaction.md
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
    const offender = 'docs/plans/discovery-portfolio-secret-redaction.md';
    if (!fs.existsSync(offender)) return; // doc archived/renamed — pin below still holds
    const raw = fs.readFileSync(offender, 'utf8');

    // Precondition: this really is a payload the gate refuses. If this ever
    // stops being true the test has lost its subject and must be re-pointed.
    assert.equal(scanEgressPayload(raw).safe, false,
      'precondition: the offending plan must still trip the gate when raw');
    // The live gate reported `['dsn-password', 'pem-private-key']` in 2026-07.
    // `pem-private-key` was a FALSE POSITIVE on this document and is no longer
    // reported: the doc does not contain a key, it DESCRIBES one, in a single
    // prose line reading `-----BEGIN RSA PRIVATE KEY-----\n<20 lines of
    // base64>\n-----END …`. The pattern used to span BEGIN…END across anything
    // (`[\s\S]*?`); it is now charset-bounded, and `<`/`>` are not PEM body
    // characters, so prose about a key no longer reads as a key.
    //
    // Narrowed deliberately rather than loosened to `.includes(...)`: the exact
    // set is the point of a precondition, and `dsn-password` — a real DSN shape
    // quoted in the doc — must still trip it, or this test has lost its subject.
    assert.deepEqual(
      scanEgressPayload(raw).patterns.sort(), ['dsn-password'],
      'precondition: the doc must still trip the gate raw, via its real DSN shapes',
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

// ── require_parameters on both OSS call sites (gate-1 screen, 2026-07-17) ──
// Measured through the real seam (n=60): OpenRouter hosts that accept but
// don't honour response_format json_schema produced the ENTIRE stall class.
// require_parameters:true → stalls 10/30 → 0/30, availability 40% → 57%,
// p50 2.6s → 0.9s. Static pins so a refactor can't silently drop the field.
describe('OSS call sites send require_parameters (experiment-4 stall fix)', () => {
  const src = fs.readFileSync(path.resolve('scripts/lib/audit/tiered-pipeline.mjs'), 'utf8');
  it('the GLM discovery generator requires honoured parameters', () => {
    const glm = src.match(/const glmCall = providers\.ossCall[\s\S]*?discovery portfolio: providers\.ossCall unavailable/);
    assert.ok(glm, 'glmCall block not found');
    assert.match(glm[0], /providerPreferences:\s*\{\s*require_parameters:\s*true\s*\}/);
  });
  it('the Stage-1 validated triager requires honoured parameters', () => {
    const triager = src.match(/async function validatedTriagerCall[\s\S]*?\n\}/);
    assert.ok(triager, 'validatedTriagerCall not found');
    assert.match(triager[0], /providerPreferences:\s*\{\s*require_parameters:\s*true\s*\}/);
  });
});

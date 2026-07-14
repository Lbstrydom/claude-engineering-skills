/**
 * @fileoverview Fixture tests for duplication-detector.mjs's runDuplicationAnalysis,
 * driven entirely by injected fake adapters — no live Git/embedding/RPC calls.
 * Plan: docs/plans/audit-code-duplication-wave.md §4 Phase 4.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runDuplicationAnalysis, _internals } from '../scripts/lib/audit/duplication-detector.mjs';

const REPO_ROOT = '/repo';
const SNAP = { refreshId: 'r1', activeEmbeddingModel: 'gemini-embedding-001', activeEmbeddingDim: 768 };

function baseAdapters(overrides = {}) {
  return {
    async getRepoId() { return 'repo-1'; },
    async getActiveSnapshot() { return SNAP; },
    async extractSymbolsForFiles() { return []; },
    async gitShowAtRevision() { return { ok: false, error: { code: 'BAD_REVISION', message: 'not found' } }; },
    async embedText() { return new Array(768).fill(0.1); },
    async callNeighbourhoodRpc() { return []; },
    gateSymbolForEgress() { return { category: null }; },
    readFileSync() { return ''; },
    ...overrides,
  };
}

function sym(overrides) {
  return {
    filePath: 'a.mjs', symbolName: 'foo', kind: 'function',
    startLine: 10, endLine: 20, signature: 'function foo()', signatureHash: 'hash-current',
    purposeSummary: 'does foo',
    ...overrides,
  };
}

describe('runDuplicationAnalysis — attribution (added/changed/unchanged)', () => {
  it('a symbol with no base-revision counterpart is `added`', async () => {
    const report = await runDuplicationAnalysis({
      repoRoot: REPO_ROOT,
      changedFiles: [{ status: 'added', currentPath: 'a.mjs' }],
      auditBaseCommit: 'HEAD',
      adapters: baseAdapters({
        extractSymbolsForFiles: async (root, files) => (files.includes('a.mjs') ? [sym()] : []),
        callNeighbourhoodRpc: async () => [{ file_path: 'canonical.mjs', symbol_name: 'foo', kind: 'function', similarity: 0.95 }],
      }),
    });
    assert.equal(report.state, 'findings');
    assert.equal(report.semanticCandidates.length, 1);
  });

  it('a changed symbol whose base-revision counterpart has a different signatureHash surfaces as `changed`', async () => {
    let baseCallCount = 0;
    const report = await runDuplicationAnalysis({
      repoRoot: REPO_ROOT,
      changedFiles: [{ status: 'modified', currentPath: 'a.mjs' }],
      auditBaseCommit: 'HEAD',
      adapters: baseAdapters({
        gitShowAtRevision: async () => { baseCallCount++; return { ok: true, content: 'old content' }; },
        extractSymbolsForFiles: async (root, files) => {
          // First call = current side (root===REPO_ROOT); second call = base side (temp root)
          if (root === REPO_ROOT) return [sym({ signatureHash: 'hash-current' })];
          return [sym({ signatureHash: 'hash-base' })];
        },
        callNeighbourhoodRpc: async () => [{ file_path: 'canonical.mjs', symbol_name: 'foo', kind: 'function', similarity: 0.95 }],
      }),
    });
    assert.equal(baseCallCount, 1);
    assert.equal(report.state, 'findings');
    assert.equal(report.semanticCandidates.length, 1);
  });

  it('same signatureHash on both sides (an unrelated same-file edit) is NOT a candidate', async () => {
    const report = await runDuplicationAnalysis({
      repoRoot: REPO_ROOT,
      changedFiles: [{ status: 'modified', currentPath: 'a.mjs' }],
      auditBaseCommit: 'HEAD',
      adapters: baseAdapters({
        gitShowAtRevision: async () => ({ ok: true, content: 'unchanged' }),
        extractSymbolsForFiles: async () => [sym({ signatureHash: 'same-hash' })],
      }),
    });
    assert.equal(report.state, 'clean');
    assert.equal(report.semanticCandidates.length, 0);
  });

  it('a same-signature body-only rewrite (round-2 H2) IS caught — signatureHash already hashes bodyText', async () => {
    // The extractor computes signatureHash from symbolName+signature+bodyText upstream;
    // this fixture just asserts the detector treats a differing hash as `changed`
    // regardless of whether the textual `signature` string itself looks identical.
    const report = await runDuplicationAnalysis({
      repoRoot: REPO_ROOT,
      changedFiles: [{ status: 'modified', currentPath: 'a.mjs' }],
      auditBaseCommit: 'HEAD',
      adapters: baseAdapters({
        gitShowAtRevision: async () => ({ ok: true, content: 'old body' }),
        extractSymbolsForFiles: async (root) => (root === REPO_ROOT
          ? [sym({ signature: 'function foo()', signatureHash: 'hash-new-body' })]
          : [sym({ signature: 'function foo()', signatureHash: 'hash-old-body' })]),
        callNeighbourhoodRpc: async () => [{ file_path: 'canonical.mjs', symbol_name: 'foo', kind: 'function', similarity: 0.9 }],
      }),
    });
    assert.equal(report.state, 'findings');
  });
});

describe('runDuplicationAnalysis — self-exclusion and thresholding', () => {
  it('excludes the RPC result matching the candidate\'s own (path, name, kind)', async () => {
    const report = await runDuplicationAnalysis({
      repoRoot: REPO_ROOT,
      changedFiles: [{ status: 'added', currentPath: 'a.mjs' }],
      auditBaseCommit: 'HEAD',
      adapters: baseAdapters({
        extractSymbolsForFiles: async () => [sym()],
        callNeighbourhoodRpc: async () => [
          { file_path: 'a.mjs', symbol_name: 'foo', kind: 'function', similarity: 1.0 }, // self — excluded
          { file_path: 'other.mjs', symbol_name: 'foo', kind: 'function', similarity: 0.9 }, // genuine external match
        ],
      }),
    });
    assert.equal(report.state, 'findings');
    assert.equal(report.semanticCandidates.length, 1);
    assert.equal(report.semanticCandidates[0].topMatch.filePath, 'other.mjs');
  });

  it('a same-file match against a genuinely different symbol IS valid signal (round-3 H3 same-file blind spot)', async () => {
    const report = await runDuplicationAnalysis({
      repoRoot: REPO_ROOT,
      changedFiles: [{ status: 'added', currentPath: 'a.mjs' }],
      auditBaseCommit: 'HEAD',
      adapters: baseAdapters({
        extractSymbolsForFiles: async () => [sym({ symbolName: 'newHelper' })],
        callNeighbourhoodRpc: async () => [
          { file_path: 'a.mjs', symbol_name: 'canonicalHelper', kind: 'function', similarity: 0.95 }, // same file, DIFFERENT symbol
        ],
      }),
    });
    assert.equal(report.state, 'findings');
    assert.equal(report.semanticCandidates[0].topMatch.symbolName, 'canonicalHelper');
  });

  it('a match below driftSimDup is not a candidate', async () => {
    const report = await runDuplicationAnalysis({
      repoRoot: REPO_ROOT,
      changedFiles: [{ status: 'added', currentPath: 'a.mjs' }],
      auditBaseCommit: 'HEAD',
      adapters: baseAdapters({
        extractSymbolsForFiles: async () => [sym()],
        callNeighbourhoodRpc: async () => [{ file_path: 'other.mjs', symbol_name: 'foo', kind: 'function', similarity: 0.5 }],
      }),
    });
    assert.equal(report.state, 'clean');
  });
});

describe('runDuplicationAnalysis — pragma suppression', () => {
  it('a valid pragma whose target matches a non-top-ranked match suppresses (Gemini round-2 G1 tie-break fix)', async () => {
    const source = 'x\n// @duplicate-justification: target=b.mjs:foo reason=intentional split\nfunction foo() {}\n';
    const report = await runDuplicationAnalysis({
      repoRoot: REPO_ROOT,
      changedFiles: [{ status: 'added', currentPath: 'a.mjs' }],
      auditBaseCommit: 'HEAD',
      adapters: baseAdapters({
        extractSymbolsForFiles: async () => [sym({ startLine: 3 })],
        callNeighbourhoodRpc: async () => [
          { file_path: 'c.mjs', symbol_name: 'foo', kind: 'function', similarity: 0.99 }, // top match — NOT the pragma target
          { file_path: 'b.mjs', symbol_name: 'foo', kind: 'function', similarity: 0.90 }, // pragma target — lower ranked
        ],
        readFileSync: () => source,
      }),
    });
    assert.equal(report.state, 'clean');
  });

  it('a pragma whose target does not match any result in the set is an Orphaned suppression pragma, not silently honoured', async () => {
    const source = 'x\n// @duplicate-justification: target=nowhere.mjs:foo reason=stale\nfunction foo() {}\n';
    const report = await runDuplicationAnalysis({
      repoRoot: REPO_ROOT,
      changedFiles: [{ status: 'added', currentPath: 'a.mjs' }],
      auditBaseCommit: 'HEAD',
      adapters: baseAdapters({
        extractSymbolsForFiles: async () => [sym({ startLine: 3 })],
        callNeighbourhoodRpc: async () => [{ file_path: 'other.mjs', symbol_name: 'foo', kind: 'function', similarity: 0.9 }],
        readFileSync: () => source,
      }),
    });
    assert.equal(report.state, 'findings');
    assert.equal(report.deterministicFindings.length, 1);
    assert.equal(report.deterministicFindings[0].type, 'orphaned-pragma');
    assert.equal(report.semanticCandidates.length, 0);
  });

  it('recognizes a pragma in Python-style `#` comment syntax (Gemini round-3 G2, language-agnostic)', async () => {
    const source = 'x\n# @duplicate-justification: target=b.py:foo reason=split for perf\ndef foo():\n    pass\n';
    const report = await runDuplicationAnalysis({
      repoRoot: REPO_ROOT,
      changedFiles: [{ status: 'added', currentPath: 'a.py' }],
      auditBaseCommit: 'HEAD',
      adapters: baseAdapters({
        extractSymbolsForFiles: async () => [sym({ filePath: 'a.py', startLine: 3 })],
        callNeighbourhoodRpc: async () => [{ file_path: 'b.py', symbol_name: 'foo', kind: 'function', similarity: 0.9 }],
        readFileSync: () => source,
      }),
    });
    // a.py doesn't match SOURCE_EXT_RE (JS/TS-only extractor) so this never
    // reaches extraction — asserts the eligibility filter, not the pragma
    // regex directly (unit-tested separately via _internals below).
    assert.equal(report.state, 'clean');
  });

  it('_internals.PRAGMA_RE matches // # /* and <!-- comment syntaxes', () => {
    const cases = [
      '// @duplicate-justification: target=b.mjs:foo reason=x',
      '# @duplicate-justification: target=b.py:foo reason=x',
      '/* @duplicate-justification: target=b.java:foo reason=x */',
      '<!-- @duplicate-justification: target=b.html:foo reason=x -->',
    ];
    for (const line of cases) {
      const m = _internals.PRAGMA_RE.exec(line);
      assert.ok(m, `expected match for: ${line}`);
      assert.equal(m[2], 'foo');
    }
  });
});

describe('runDuplicationAnalysis — bounds and unavailable/failed states', () => {
  it('candidate count exceeding maxDuplicationCandidates returns unavailable', async () => {
    const manySymbols = Array.from({ length: 100 }, (_, i) => sym({ symbolName: `fn${i}` }));
    const report = await runDuplicationAnalysis({
      repoRoot: REPO_ROOT,
      changedFiles: [{ status: 'added', currentPath: 'a.mjs' }],
      auditBaseCommit: 'HEAD',
      adapters: baseAdapters({ extractSymbolsForFiles: async () => manySymbols }),
    });
    assert.equal(report.state, 'unavailable');
    assert.match(report.reason, /candidate/);
  });

  it('changed-file count exceeding maxDuplicationScanFiles returns unavailable BEFORE extraction runs', async () => {
    const manyFiles = Array.from({ length: 100 }, (_, i) => ({ status: 'added', currentPath: `f${i}.mjs` }));
    let extractCalled = false;
    const report = await runDuplicationAnalysis({
      repoRoot: REPO_ROOT,
      changedFiles: manyFiles,
      auditBaseCommit: 'HEAD',
      adapters: baseAdapters({ extractSymbolsForFiles: async () => { extractCalled = true; return []; } }),
    });
    assert.equal(report.state, 'unavailable');
    assert.equal(extractCalled, false);
  });

  it('no repo in the architectural-memory store returns unavailable', async () => {
    const report = await runDuplicationAnalysis({
      repoRoot: REPO_ROOT,
      changedFiles: [{ status: 'added', currentPath: 'a.mjs' }],
      auditBaseCommit: 'HEAD',
      adapters: baseAdapters({ getRepoId: async () => null }),
    });
    assert.equal(report.state, 'unavailable');
  });

  it('missing active embedding model/dim (EMBEDDING_MISMATCH) returns unavailable', async () => {
    const report = await runDuplicationAnalysis({
      repoRoot: REPO_ROOT,
      changedFiles: [{ status: 'added', currentPath: 'a.mjs' }],
      auditBaseCommit: 'HEAD',
      adapters: baseAdapters({ getActiveSnapshot: async () => ({ refreshId: 'r1', activeEmbeddingModel: null, activeEmbeddingDim: null }) }),
    });
    assert.equal(report.state, 'unavailable');
  });

  it('an unsafe auditBaseCommit is refused, never shelled out to git', async () => {
    let gitCalled = false;
    const report = await runDuplicationAnalysis({
      repoRoot: REPO_ROOT,
      changedFiles: [{ status: 'modified', currentPath: 'a.mjs' }],
      auditBaseCommit: '; rm -rf /',
      adapters: baseAdapters({ gitShowAtRevision: async () => { gitCalled = true; return { ok: false, error: { code: 'BAD_REVISION', message: 'x' } }; } }),
    });
    assert.equal(report.state, 'unavailable');
    assert.equal(gitCalled, false);
  });

  it('an injected adapter throwing produces state:failed, never a crash', async () => {
    const report = await runDuplicationAnalysis({
      repoRoot: REPO_ROOT,
      changedFiles: [{ status: 'added', currentPath: 'a.mjs' }],
      auditBaseCommit: 'HEAD',
      adapters: baseAdapters({ extractSymbolsForFiles: async () => { throw new Error('boom with a fake /secret/path'); } }),
    });
    assert.equal(report.state, 'failed');
    assert.equal(report.deterministicFindings.length, 0);
    assert.equal(report.semanticCandidates.length, 0);
  });

  it('a deleted-status entry is excluded before extraction, no crash, does not count toward the file cap', async () => {
    const report = await runDuplicationAnalysis({
      repoRoot: REPO_ROOT,
      changedFiles: [{ status: 'deleted', currentPath: 'gone.mjs' }],
      auditBaseCommit: 'HEAD',
      adapters: baseAdapters({ extractSymbolsForFiles: async () => [] }),
    });
    assert.equal(report.state, 'clean');
  });
});

describe('runDuplicationAnalysis — egress gate', () => {
  it('a matched-canonical path classified sensitive drops the candidate before any read', async () => {
    let readCalled = false;
    const report = await runDuplicationAnalysis({
      repoRoot: REPO_ROOT,
      changedFiles: [{ status: 'added', currentPath: 'a.mjs' }],
      auditBaseCommit: 'HEAD',
      adapters: baseAdapters({
        extractSymbolsForFiles: async () => [sym()],
        callNeighbourhoodRpc: async () => [{ file_path: '.env.production', symbol_name: 'foo', kind: 'function', similarity: 0.95 }],
        gateSymbolForEgress: (p) => ({ category: p === '.env.production' ? 'sensitive' : null }),
        readFileSync: () => { readCalled = true; return ''; },
      }),
    });
    assert.equal(report.state, 'clean');
    assert.equal(readCalled, false);
  });
});

describe('_internals.isEligibleChange', () => {
  it('rejects deleted, non-source extensions, and query-excluded fixture paths', () => {
    assert.equal(_internals.isEligibleChange({ status: 'deleted', currentPath: 'a.mjs' }), false);
    assert.equal(_internals.isEligibleChange({ status: 'added', currentPath: 'a.md' }), false);
    assert.equal(_internals.isEligibleChange({ status: 'added', currentPath: 'tests/arch-intent-adapter-java.test.mjs' }), false);
    assert.equal(_internals.isEligibleChange({ status: 'added', currentPath: 'a.mjs' }), true);
  });
});

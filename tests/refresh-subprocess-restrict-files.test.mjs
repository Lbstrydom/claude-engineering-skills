/**
 * @fileoverview Regression test for `runExtractSummariseEmbed`'s tri-state
 * `restrictFiles` contract (symbol-index-pipeline-reliability-hardening plan,
 * Theme 4, round-1 H4) — the identical `restrictFiles && restrictFiles.length
 * > 0` conflation `extract.mjs:560`'s `enumerateFiles` independently had.
 *
 * A genuinely EMPTY array must short-circuit BEFORE any subprocess spawns,
 * returning `{..., skipped: true}` — the OLD code fell through to the full
 * extract/summarise/embed pipeline with no `--files-from` flag set, silently
 * promoting "nothing to extract" into "extract everything".
 *
 * This is testable with NO subprocess mocking at all: the early-return path
 * this fix adds is pure (no I/O), so `restrictFiles: []` never reaches the
 * `node extract.mjs` spawn — if it did, this test would hang/fail rather than
 * resolve immediately.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runExtractSummariseEmbed } from '../scripts/symbol-index/refresh-subprocess.mjs';

describe('runExtractSummariseEmbed — restrictFiles tri-state contract', () => {
  it('a genuinely EMPTY restrictFiles array short-circuits with skipped:true, no subprocess spawned', async () => {
    const logs = [];
    const result = await runExtractSummariseEmbed({
      repoRoot: '/does/not/matter',
      repoId: 'repo-x',
      mode: 'incremental',
      restrictFiles: [],
      includeDelegates: false,
      coverageConfig: { hardTimeoutMs: 1000 },
      concreteEmbedModel: 'unused',
      logOk: (s) => logs.push(s),
    });

    assert.deepEqual(result, {
      finalSymbols: [], violations: [], importEdges: [], coverageLine: null,
      extractionTimedOut: false, timeoutRecovery: null, recoveredTouchedSet: null,
      skipped: true,
    });
    assert.ok(logs.some((l) => l.includes('nothing to extract')), 'should log why the pipeline was skipped');
  });
});

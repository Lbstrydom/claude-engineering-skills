/**
 * @fileoverview Tier 2 harness for `gemini-review.mjs`'s `runFinalReview` +
 * Phase 12's `runAdjudicatorOnlyReview` sibling wrapper (tiered-recall audit
 * pipeline Phase 12). Calls `runFinalReview`/`runAdjudicatorOnlyReview`
 * DIRECTLY with a stubbed provider client — no live model calls, no network.
 *
 * Per Phase 12's own header note: `runFinalReview` already takes its
 * provider `client` as an injected parameter and already RETURNS a real
 * value (`{result, usage, latencyMs}`), so no return-statement addition was
 * needed to make it testable this way (unlike `runMultiPassCodeAudit`'s gap,
 * Phase 10).
 *
 * Does NOT cover the subprocess boundary (cwd/path resolution, CLI arg
 * parsing, exit codes, `--out` file I/O) — see
 * tests/final-adjudication-subprocess-adapter.test.mjs for that.
 *
 * Plan: docs/plans/tiered-recall-audit-pipeline.md Phase 12.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runFinalReview,
  runAdjudicatorOnlyReview,
  runReviewWithRetry,
  applyScopeFilter,
  recordNewFindings,
} from '../scripts/gemini-review.mjs';
import { FalsePositiveTracker } from '../scripts/lib/findings.mjs';

/**
 * Stub `client.messages.create()` — `callClaudeOpus`'s call shape.
 * `streamAnthropicMessage` treats a returned object with no
 * `Symbol.asyncIterator` as an already-final message, so a plain object
 * (no real streaming emulation needed) exercises the full parse path.
 *
 * Returns a `tool_use` block, not a `text` block (2026-07-26): the anthropic
 * transport now forces tool-use so the provider enforces finding shape, after a
 * text-mode response with a null `category` aborted a persistence transaction
 * and silently discarded the primary reviewer's findings. A stub still emitting
 * `type:'text'` would be testing a contract the transport no longer has.
 */
const REVIEW_TOOL_NAME = 'submit_review';

function mkStubClient(cannedResult, captured) {
  return {
    messages: {
      create: async (params) => {
        if (captured) captured.push(params);
        return {
          content: [{ type: 'tool_use', name: REVIEW_TOOL_NAME, input: cannedResult }],
          usage: { input_tokens: 10, output_tokens: 20 },
          stop_reason: 'tool_use',
        };
      },
    },
  };
}

const BASE_FIXTURE = {
  deliberation_quality: { claude_bias_detected: false, gpt_false_positive_count: 0, deliberation_was_fair: true, quality_summary: 'fine' },
  new_findings: [],
  wrongly_dismissed: [],
  over_engineering_flags: [],
  architectural_coherence: 'Strong',
  overall_reasoning: 'looks good',
};

const APPROVE_FIXTURE = { ...BASE_FIXTURE, verdict: 'APPROVE' };

const CONCERNS_FIXTURE = {
  ...BASE_FIXTURE,
  verdict: 'CONCERNS',
  new_findings: [{
    id: 'G1', severity: 'MEDIUM', category: 'X', section: 'src/a.mjs', detail: 'issue',
    risk: 'risk', recommendation: 'fix', is_quick_fix: false, is_mechanical: false, principle: 'p',
    classification: { sonarType: 'CODE_SMELL', effort: 'EASY', sourceKind: 'REVIEWER', sourceName: 'test' },
  }],
};

const REJECT_FIXTURE = {
  ...BASE_FIXTURE,
  verdict: 'REJECT',
  wrongly_dismissed: [{ original_finding_id: 'H1', reason_claude_was_wrong: 'bad', recommended_severity: 'HIGH' }],
};

const TRANSCRIPT = JSON.stringify({
  audit_mode: 'code',
  changed_files: ['src/a.mjs'],
  code_files: ['src/a.mjs'],
  summary: 'test transcript',
  rounds: [{ round: 1, findings: [] }],
  claude_resolutions: [],
});

describe('runFinalReview — {result,usage,latencyMs} shape + verdict routing', () => {
  for (const [name, fixture] of Object.entries({ APPROVE: APPROVE_FIXTURE, CONCERNS: CONCERNS_FIXTURE, REJECT: REJECT_FIXTURE })) {
    it(`returns a well-formed result for a canned ${name} verdict`, async () => {
      const client = mkStubClient(fixture);
      const { result, usage, latencyMs } = await runFinalReview('claude-opus', client, '# plan', TRANSCRIPT, 'ctx', 'code');
      assert.equal(result.verdict, fixture.verdict);
      assert.ok(Array.isArray(result.new_findings));
      assert.ok(Array.isArray(result.wrongly_dismissed));
      assert.equal(typeof usage.input_tokens, 'number');
      assert.equal(typeof latencyMs, 'number');
    });
  }

  it('passes new_findings through unchanged', async () => {
    const client = mkStubClient(CONCERNS_FIXTURE);
    const { result } = await runFinalReview('claude-opus', client, '# plan', TRANSCRIPT, 'ctx', 'code');
    assert.equal(result.new_findings.length, 1);
    assert.equal(result.new_findings[0].section, 'src/a.mjs');
  });

  it('passes wrongly_dismissed through unchanged', async () => {
    const client = mkStubClient(REJECT_FIXTURE);
    const { result } = await runFinalReview('claude-opus', client, '# plan', TRANSCRIPT, 'ctx', 'code');
    assert.equal(result.wrongly_dismissed.length, 1);
    assert.equal(result.wrongly_dismissed[0].original_finding_id, 'H1');
  });
});

describe('runAdjudicatorOnlyReview — injects the role addendum from OUTSIDE runFinalReview', () => {
  it('the system prompt sent to the client includes the ADJUDICATOR-ONLY MODE addendum', async () => {
    const captured = [];
    const client = mkStubClient(APPROVE_FIXTURE, captured);
    await runAdjudicatorOnlyReview('claude-opus', client, '# plan', TRANSCRIPT, 'ctx', 'code');
    assert.match(captured[0].system, /ADJUDICATOR-ONLY MODE/);
  });

  it('default (runReviewWithRetry, no role) does NOT include the addendum — byte-identical to today', async () => {
    const captured = [];
    const client = mkStubClient(APPROVE_FIXTURE, captured);
    await runReviewWithRetry('claude-opus', client, '# plan', TRANSCRIPT, 'ctx', 'code');
    assert.doesNotMatch(captured[0].system, /ADJUDICATOR-ONLY MODE/);
  });

  it('the addendum toggle resets after the call — a subsequent default call has no addendum', async () => {
    const captured = [];
    const client = mkStubClient(APPROVE_FIXTURE, captured);
    await runAdjudicatorOnlyReview('claude-opus', client, '# plan', TRANSCRIPT, 'ctx', 'code');
    await runReviewWithRetry('claude-opus', client, '# plan', TRANSCRIPT, 'ctx', 'code');
    assert.match(captured[0].system, /ADJUDICATOR-ONLY MODE/);
    assert.doesNotMatch(captured[1].system, /ADJUDICATOR-ONLY MODE/);
  });

  it('the addendum resets even when the underlying call throws (finally semantics)', async () => {
    const throwingClient = { messages: { create: async () => { throw new Error('boom'); } } };
    await assert.rejects(() => runAdjudicatorOnlyReview('claude-opus', throwingClient, '# plan', TRANSCRIPT, 'ctx', 'code'));
    const captured = [];
    const client = mkStubClient(APPROVE_FIXTURE, captured);
    await runReviewWithRetry('claude-opus', client, '# plan', TRANSCRIPT, 'ctx', 'code');
    assert.doesNotMatch(captured[0].system, /ADJUDICATOR-ONLY MODE/);
  });

  it('the returned {result,usage,latencyMs} shape matches runFinalReview\'s own contract', async () => {
    const client = mkStubClient(CONCERNS_FIXTURE);
    const r = await runAdjudicatorOnlyReview('claude-opus', client, '# plan', TRANSCRIPT, 'ctx', 'code');
    assert.equal(r.result.verdict, 'CONCERNS');
    assert.equal(typeof r.usage, 'object');
    assert.equal(typeof r.latencyMs, 'number');
  });
});

describe('applyScopeFilter/recordNewFindings — called by main(), not runFinalReview itself — work regardless of which role wrapper produced result', () => {
  // applyScopeFilter reads f.file/f.location (NOT f.section) — those aren't
  // ProducerFindingSchema fields, so a schema-validated LLM response never
  // carries them; set directly on the returned result to drive the filter's
  // OWN match/no-match branches deterministically, independent of that
  // pre-existing (out-of-scope-for-Phase-12) schema gap.
  it('applyScopeFilter drops out-of-scope new_findings on a result produced via runFinalReview directly', async () => {
    const client = mkStubClient(CONCERNS_FIXTURE);
    const { result, transcriptContent } = await (async () => {
      const r = await runFinalReview('claude-opus', client, '# plan', TRANSCRIPT, 'ctx', 'code');
      return { ...r, transcriptContent: TRANSCRIPT };
    })();
    result.new_findings[0].file = 'src/OTHER.mjs';
    await applyScopeFilter(result, transcriptContent);
    assert.equal(result.new_findings.length, 0);
    assert.equal(result._scopeFilteredCount, 1);
  });

  it('applyScopeFilter drops out-of-scope new_findings on a result produced via runAdjudicatorOnlyReview', async () => {
    const client = mkStubClient(CONCERNS_FIXTURE);
    const { result, transcriptContent } = await runAdjudicatorOnlyReview('claude-opus', client, '# plan', TRANSCRIPT, 'ctx', 'code');
    result.new_findings[0].file = 'src/OTHER.mjs';
    await applyScopeFilter(result, transcriptContent);
    assert.equal(result.new_findings.length, 0);
    assert.equal(result._scopeFilteredCount, 1);
  });

  it('applyScopeFilter KEEPS an in-scope new_findings entry regardless of which wrapper produced result', async () => {
    const client = mkStubClient(CONCERNS_FIXTURE);
    const { result, transcriptContent } = await runAdjudicatorOnlyReview('claude-opus', client, '# plan', TRANSCRIPT, 'ctx', 'code');
    result.new_findings[0].file = 'src/a.mjs'; // matches TRANSCRIPT.changed_files
    await applyScopeFilter(result, transcriptContent);
    assert.equal(result.new_findings.length, 1);
    assert.equal(result._scopeFilteredCount, undefined);
  });

  it('recordNewFindings does not throw for a result produced by either wrapper (in-memory FP-tracker store — no real disk state)', async () => {
    const fakeStore = { load: () => ({}), save: () => {} };
    const tracker = new FalsePositiveTracker('.audit/fp-tracker-test-harness.json', { store: fakeStore });

    const clientA = mkStubClient(CONCERNS_FIXTURE);
    const { result: resultA } = await runFinalReview('claude-opus', clientA, '# plan', TRANSCRIPT, 'ctx', 'code');
    assert.doesNotThrow(() => recordNewFindings(resultA, tracker, null, 'rev-test'));

    const clientB = mkStubClient(CONCERNS_FIXTURE);
    const { result: resultB } = await runAdjudicatorOnlyReview('claude-opus', clientB, '# plan', TRANSCRIPT, 'ctx', 'code');
    assert.doesNotThrow(() => recordNewFindings(resultB, tracker, null, 'rev-test'));
  });
});

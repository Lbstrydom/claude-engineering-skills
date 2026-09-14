/**
 * @fileoverview Producer→store contract for `recordFinalReviewFindings`'s
 * `shadowRan` flag (docs/plans/final-review-credit-projection.md Seam 3 /
 * audit-plan R1 M3). The store treats an absent/false `shadowRan` as "leave
 * prior shadow rows untouched" and `true` as "this snapshot is authoritative,
 * prune what it dropped" — so the producer forwarding the WRONG value silently
 * either erases shadow history that should have survived, or fails to prune
 * rows a genuinely-empty shadow round should have cleared.
 *
 * `runShadowAndPersist` is exercised through its real production path via a
 * `persistFn` test seam (mirrors the existing `modelEvalOverride` seam — see
 * gemini-review.mjs) so this is the real function, not a copy of it. The
 * "shadow did not run" case is driven fully functionally with NO network call
 * (`FORCED_SKIP`, the pattern the file's other describe block already uses).
 * The "shadow ran" cases (non-empty / empty) cannot be reached the same way —
 * `shadow.state === 'ready'` always makes a real provider call inside
 * `runShadowReview`, and this repo's testing doctrine forbids a whole-provider
 * mock (AGENTS.md §Testing doctrine, Tier 2) — so those two are pinned as a
 * call-shape assertion on the source, the same instrument this repo already
 * uses for this exact defect class (tests/audit-detector.test.mjs's
 * "production verdict site" guard).
 *
 * @module tests/gemini-review-shadow-persist
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _internals } from '../scripts/gemini-review.mjs';

const { runShadowAndPersist } = _internals;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Same FORCED_SKIP fixture tests/gemini-review-shadow.test.mjs already uses to
// force a deterministic non-'ready' shadow state without touching ambient env.
const FORCED_SKIP = { repoId: null, modelEvalRunId: null, shadow: { state: 'skipped-unset', provider: null, model: null } };
const ctx = { planContent: 'plan', transcriptContent: '{}', projectContext: '', auditMode: 'code' };

function fakePersist() {
  const calls = [];
  const persistFn = async (runId, payload) => { calls.push({ runId, payload }); };
  return { persistFn, calls };
}

describe('runShadowAndPersist → recordFinalReviewFindings — the shadowRan contract', () => {
  it('a shadow that did NOT run: shadowRan:false, shadow:[], every primary _bucket null', async () => {
    const { persistFn, calls } = fakePersist();
    const result = {
      new_findings: [
        { id: 'P1', severity: 'HIGH', category: 'Test', section: 'a.mjs:1', detail: 'd', risk: 'r', recommendation: 'x', is_quick_fix: false, is_mechanical: false, principle: 'p', _hash: 'aaaa1111' },
      ],
      verdict: 'PASS',
    };
    await runShadowAndPersist(result, 'gpt-5.6', 'run-1', ctx, { modelEvalOverride: FORCED_SKIP, persistFn });

    assert.equal(calls.length, 1, 'the primary must still persist even when the shadow did not run');
    const { runId, payload } = calls[0];
    assert.equal(runId, 'run-1');
    assert.equal(payload.shadowRan, false, 'a shadow that did not run must forward shadowRan:false, never omit it as a permissive default');
    assert.deepEqual(payload.shadow, []);
    assert.ok(payload.primary.length > 0, 'the primary findings must still be persisted');
    for (const f of payload.primary) {
      assert.equal(f._bucket, null, 'bucket is only meaningful when both reviewers ran — must be null, not left unset');
    }
  });

  it('an empty new_findings result with the shadow not run still calls persistFn once (no shadow write attempted)', async () => {
    const { persistFn, calls } = fakePersist();
    const result = { new_findings: [], verdict: 'PASS' };
    await runShadowAndPersist(result, 'gpt-5.6', 'run-2', ctx, { modelEvalOverride: FORCED_SKIP, persistFn });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.shadowRan, false);
    assert.deepEqual(calls[0].payload.shadow, []);
  });

  it('persistFn is NOT called when runId is absent (unchanged contract — no run to attach to)', async () => {
    const { persistFn, calls } = fakePersist();
    const result = { new_findings: [], verdict: 'PASS' };
    await runShadowAndPersist(result, 'gpt-5.6', null, ctx, { modelEvalOverride: FORCED_SKIP, persistFn });
    assert.equal(calls.length, 0);
  });
});

describe('runShadowAndPersist — the "shadow ran" cases (call-shape, source-pinned)', () => {
  // Cannot be driven functionally through `runShadowAndPersist` without a real
  // provider call (see file header) — pinned as a call-shape assertion instead,
  // falsifiable the same way tests/audit-detector.test.mjs's verdict-site guard
  // is: delete either line below and this fails.
  const SRC = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'gemini-review.mjs'), 'utf8');

  it('`ran` is derived from result._shadow.state === "ran" BEFORE the persistence call, and forwarded as shadowRan', () => {
    const ranDeclIdx = SRC.indexOf("const ran = result._shadow.state === 'ran';");
    assert.notEqual(ranDeclIdx, -1, 'could not find the `ran` derivation — was it renamed or moved?');
    const persistCallIdx = SRC.indexOf('await persistFn(runId, {', ranDeclIdx);
    assert.notEqual(persistCallIdx, -1, 'the persistence call must come AFTER `ran` is derived');
    const callBody = SRC.slice(persistCallIdx, persistCallIdx + 900);
    assert.match(callBody, /shadowRan:\s*ran,/, 'the persistence payload must forward shadowRan: ran verbatim — not re-derived, not hardcoded');
  });

  it('shadow findings passed to persistence are `ran ? diff.shadow : []` — an executed-empty shadow still sends shadowRan:true with shadow:[]', () => {
    const shadowFindingsIdx = SRC.indexOf('const shadowFindings = ran ? diff.shadow : [];');
    assert.notEqual(shadowFindingsIdx, -1, 'shadowFindings must be gated on `ran`, both for the executed-nonempty and executed-empty cases');
    const persistCallIdx = SRC.indexOf('await persistFn(runId, {', shadowFindingsIdx);
    assert.notEqual(persistCallIdx, -1);
    const callBody = SRC.slice(persistCallIdx, persistCallIdx + 900);
    assert.match(callBody, /shadow:\s*shadowFindings,/, 'the payload must forward the ran-gated shadowFindings, not diff.shadow directly');
  });
});

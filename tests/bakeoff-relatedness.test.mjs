/**
 * @fileoverview `planLooksRelated` — §7 Phase 4 of
 * docs/plans/campaign-arm-state-and-identity-integrity.md.
 *
 * Fixtures under `tests/fixtures/bakeoff-relatedness/` are modelled on the
 * real 3 mis-paired snapshots documented in
 * `docs/research/campaign-2026q3-mispaired-snapshots.md` §Method — a
 * transcript citing `accepted-debt-*` files incorrectly paired with a plan
 * about the scoped second reviewer (zero overlap, the real quarantined
 * shape), and a transcript citing `gemini-review`/`model-pricing`/
 * `bakeoff-collect` correctly paired with that same plan (real overlap).
 *
 * @module tests/bakeoff-relatedness
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { planLooksRelated } from '../scripts/lib/bakeoff/relatedness.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'bakeoff-relatedness');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf-8'));
const readText = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf-8');

describe('planLooksRelated — collection-time relatedness heuristic', () => {
  it('ZERO overlap → related:false (mirrors all 3 real mis-paired incidents)', () => {
    const r = planLooksRelated(readJson('mismatched-transcript.json'), readText('second-reviewer-plan.md'));
    assert.equal(r.related, false);
    assert.deepEqual(r.overlap, []);
  });

  it('non-zero overlap → related:true (the genuinely correct pairing)', () => {
    const r = planLooksRelated(readJson('matched-transcript.json'), readText('second-reviewer-plan.md'));
    assert.equal(r.related, true);
    assert.ok(r.overlap.includes('gemini-review.mjs'));
    assert.ok(r.overlap.includes('model-pricing.mjs'));
    assert.ok(r.overlap.includes('bakeoff-collect.mjs'));
  });

  it('a valid, EMPTY findings:[] array → related:true, reason:"no-findings-to-compare" — NOT related:false (Gemini gate round 1, G2)', () => {
    const r = planLooksRelated({ mode: 'plan', findings: [] }, readText('second-reviewer-plan.md'));
    assert.equal(r.related, true);
    assert.equal(r.reason, 'no-findings-to-compare');
    assert.deepEqual(r.overlap, []);
  });

  it('a missing/malformed findings field → related:false with NO reason (genuinely un-parseable, distinct from the valid-but-empty case)', () => {
    assert.deepEqual(planLooksRelated({ mode: 'plan' }, 'plan text'), { overlap: [], related: false });
    assert.deepEqual(planLooksRelated({ findings: 'not-an-array' }, 'plan text'), { overlap: [], related: false });
    assert.deepEqual(planLooksRelated(null, 'plan text'), { overlap: [], related: false });
  });

  // ── the REAL transcript shape ─────────────────────────────────────────────
  //
  // Fixed 2026-08-23, before this heuristic had ever gated a live collection.
  // It read `transcriptJson.findings[]` — a shape `build-audit-transcript.mjs`
  // does not produce. Every one of the 86 archived transcripts nests findings
  // under `rounds[].findings[]` and names the file in `_primaryFile` /
  // `affectedFiles`, never `.file`. So against real input the citation set was
  // always empty and EVERY pairing returned related:false — measured on 3
  // known-correct pairings plus a deliberately-wrong control, all four
  // indistinguishable.
  //
  // Worse than no check: a guard that fires on everything teaches the operator
  // to pass `--confirm-mismatch` reflexively, which is the same failure the
  // G2 clean-audit fix above exists to prevent, reintroduced through the input
  // SHAPE rather than the threshold. The fixture below therefore mirrors the
  // real producer's layout exactly rather than the one the function wished for.
  it('reads the REAL producer shape: rounds[].findings with _primaryFile/affectedFiles', () => {
    const transcript = {
      audit_mode: 'code',
      rounds: [
        { findings: [{ section: 'scripts/memory-health.mjs — RPC window', _primaryFile: 'scripts/memory-health.mjs' }] },
        { findings: [{ section: 'a prose section naming no path', affectedFiles: ['scripts/lib/linter.mjs'] }] },
      ],
    };
    const r = planLooksRelated(transcript, 'the plan touches memory-health.mjs and linter.mjs');
    assert.equal(r.related, true);
    assert.deepEqual(r.overlap, ['linter.mjs', 'memory-health.mjs']);
  });

  it('NEGATIVE CONTROL for the shape fix: rounds[] present but citing an unrelated plan still reads false', () => {
    // The discrimination the broken version could not do: same shape, wrong
    // plan. Without this, a fix that merely returned `true` more often would
    // pass the case above and still be useless.
    const transcript = { rounds: [{ findings: [{ _primaryFile: 'scripts/memory-health.mjs' }] }] };
    assert.equal(planLooksRelated(transcript, 'a plan about runner-inventory.mjs only').related, false);
  });

  it('a rounds[] array carrying no findings at all is EMPTY, not unreadable', () => {
    // `rounds` present but every round findings-free is the clean-audit case
    // in the real shape — it must take G2's related:true path, not the
    // malformed related:false one.
    const r = planLooksRelated({ rounds: [{ findings: [] }, { verdict: 'APPROVE' }] }, 'plan text');
    assert.equal(r.related, true);
    assert.equal(r.reason, 'no-findings-to-compare');
  });

  it('round 6 (Gemini gate MEDIUM correction): a FULL relative path in the transcript matches a BARE basename in the plan\'s prose', () => {
    const transcript = { findings: [{ section: 'scripts/bakeoff-collect.mjs — retry scoping' }] };
    const planProse = 'This plan modifies bakeoff-collect.mjs to consult the store before retrying.';
    const r = planLooksRelated(transcript, planProse);
    assert.equal(r.related, true, 'a basename match must be found even though the transcript cites the FULL path and the plan cites the bare filename');
    assert.deepEqual(r.overlap, ['bakeoff-collect.mjs']);
  });

  it('NEGATIVE CONTROL for the basename fix: a full-path-vs-full-path comparison against a DIFFERENT directory still only matches on basename, not full path', () => {
    // Proves the fix is basename normalisation, not merely "strip a leading
    // ./" — a full path in the transcript under one directory and a full
    // path in the plan under a DIFFERENT directory for the SAME basename
    // must still match.
    const transcript = { findings: [{ section: 'lib/store/campaign.mjs' }] };
    const planProse = 'See scripts/lib/store/campaign.mjs for the write seam.';
    const r = planLooksRelated(transcript, planProse);
    assert.equal(r.related, true);
    assert.deepEqual(r.overlap, ['campaign.mjs']);
  });
});

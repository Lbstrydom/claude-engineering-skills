/**
 * @fileoverview Defensive-guard tests for buildRulingsBlock (adjudication ledger).
 * A malformed/partial ledger entry (missing topicId, rationale, or affectedFiles)
 * must degrade gracefully — skip-and-warn or render with fallbacks — never throw
 * and take down an entire plan-audit R2 round. Mirrors the function's own
 * file-level graceful-degradation (missing file / parse error → '').
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { buildRulingsBlock } from '../scripts/lib/ledger.mjs';

let tmpDir;
let ledgerPath;

function writeLedger(entries) {
  fs.writeFileSync(ledgerPath, JSON.stringify({ entries }), 'utf-8');
}

function wellFormed(overrides = {}) {
  return {
    topicId: 'abcdef123456',
    pass: 'plan',
    adjudicationOutcome: 'dismissed',
    remediationState: 'pending',
    category: 'SOLID-SRP',
    rulingRationale: 'acceptable given the 2 consumers',
    affectedFiles: ['scripts/foo.mjs'],
    resolvedRound: 1,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rulings-guard-'));
  ledgerPath = path.join(tmpDir, 'ledger.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('buildRulingsBlock — malformed-entry defensive guards', () => {
  test('happy path still renders a well-formed dismissed entry', () => {
    writeLedger([wellFormed()]);
    const block = buildRulingsBlock(ledgerPath, 'plan');
    assert.match(block, /DISMISSED/);
    assert.match(block, /\[abcdef\]/); // topicId.slice(0,6)
    assert.match(block, /scripts\/foo\.mjs/);
  });

  test('an entry missing topicId is skipped, not thrown, and valid siblings survive', () => {
    writeLedger([
      wellFormed({ topicId: undefined, category: 'orphan' }), // the sharp edge
      wellFormed({ topicId: 'ffffff000000', category: 'kept' }),
    ]);
    let block;
    assert.doesNotThrow(() => { block = buildRulingsBlock(ledgerPath, 'plan'); });
    assert.match(block, /\[ffffff\]/);        // valid sibling rendered
    assert.doesNotMatch(block, /orphan/);     // malformed entry dropped
  });

  test('all entries malformed (no topicId) → empty string, no throw', () => {
    writeLedger([wellFormed({ topicId: undefined }), wellFormed({ topicId: '' })]);
    let block;
    assert.doesNotThrow(() => { block = buildRulingsBlock(ledgerPath, 'plan'); });
    assert.equal(block, '');
  });

  test('valid topicId but missing rulingRationale/affectedFiles renders without throwing', () => {
    writeLedger([wellFormed({ rulingRationale: undefined, affectedFiles: undefined })]);
    let block;
    assert.doesNotThrow(() => { block = buildRulingsBlock(ledgerPath, 'plan'); });
    assert.match(block, /\[abcdef\]/);
    assert.match(block, /Scope: /); // empty scope, but the line rendered
  });

  test('severity_adjusted + fixed entries with missing scope also survive', () => {
    writeLedger([
      wellFormed({ topicId: 'aaaaaa111111', adjudicationOutcome: 'severity_adjusted', originalSeverity: 'HIGH', severity: 'MEDIUM', affectedFiles: undefined }),
      wellFormed({ topicId: 'bbbbbb222222', adjudicationOutcome: 'accepted', remediationState: 'fixed', affectedFiles: null }),
    ]);
    let block;
    assert.doesNotThrow(() => { block = buildRulingsBlock(ledgerPath, 'plan'); });
    assert.match(block, /SEVERITY ADJUSTED/);
    assert.match(block, /FIXED/);
    assert.match(block, /HIGH→MEDIUM/); // adjusted line rendered
  });

  test('a non-object entry in the array does not throw', () => {
    writeLedger([null, wellFormed({ topicId: 'cccccc333333' })]);
    let block;
    assert.doesNotThrow(() => { block = buildRulingsBlock(ledgerPath, 'plan'); });
    assert.match(block, /\[cccccc\]/);
  });
});

// ── Phase 1: dismissed-FP reopen policy (docs/plans/dismissed-fp-reopen-policy.md) ──
//
// Field record (2026-07-16): a GPT false positive re-raised 3 consecutive rounds
// despite being dismissed each round with deterministic disproof. Root cause in
// THIS function: DISMISSED/ADJUSTED/FIXED rendered under one header saying "Do
// NOT re-raise them unless the code they affect has materially changed" — in a
// fix loop that condition is ALWAYS true, so for a dismissal it is an explicit
// licence to re-raise, and it contradicts R2_ROUND_MODIFIER ("Paraphrase a
// dismissed finding as 'new' — that contradicts your own judgment") which is
// concatenated immediately above it. The model took the permissive branch.

/** The section of `block` from `heading` up to the next `### ` heading (or end). */
function section(block, heading) {
  const start = block.indexOf(`### ${heading}`);
  if (start === -1) return '';
  const rest = block.slice(start + 4);
  const next = rest.indexOf('\n### ');
  return next === -1 ? rest : rest.slice(0, next);
}

describe('buildRulingsBlock — per-group headers (the re-raise licence)', () => {
  test('THE FIELD REGRESSION: the DISMISSED section carries no unconditional "materially changed" escape clause', () => {
    writeLedger([wellFormed()]);
    const dismissed = section(buildRulingsBlock(ledgerPath, 'plan'), 'DISMISSED');
    assert.ok(dismissed.length > 0, 'DISMISSED section must render');
    assert.doesNotMatch(dismissed, /materially changed/i,
      'the escape clause is what the auditor took every round — it must not attach to a dismissal');
    assert.doesNotMatch(dismissed, /unless/i,
      'no unconditional "do not re-raise UNLESS ..." licence in the dismissed group');
  });

  test('the DISMISSED section demands a cited changed line for any re-raise', () => {
    writeLedger([wellFormed()]);
    const dismissed = section(buildRulingsBlock(ledgerPath, 'plan'), 'DISMISSED');
    assert.match(dismissed, /cite/i, 'a re-raise must require citing the invalidating line');
  });

  test('the FIXED section KEEPS the reopen-on-material-change clause (regression detection is correct there)', () => {
    writeLedger([wellFormed({ topicId: 'bbbbbb222222', adjudicationOutcome: 'accepted', remediationState: 'fixed' })]);
    const fixed = section(buildRulingsBlock(ledgerPath, 'plan'), 'FIXED');
    assert.ok(fixed.length > 0, 'FIXED section must render');
    assert.match(fixed, /materially changed/i,
      'a fix CAN be undone by a later change — this clause is load-bearing for FIXED');
  });

  test('the shared preamble no longer carries the clause (it moved into FIXED only)', () => {
    writeLedger([wellFormed()]);
    const block = buildRulingsBlock(ledgerPath, 'plan');
    const preamble = block.slice(0, block.indexOf('### '));
    assert.doesNotMatch(preamble, /materially changed/i);
  });
});

describe('buildRulingsBlock — dismissal rationale is the payload', () => {
  const R300 = `The claim is disproven: the Zod schema at src/schemas/wine.ts:42 accepts style null via nullable, verified by a direct parse in a unit test plus a real Postgres integration test at tests/db/wine.test.mjs:88 which passes against the live schema and asserts the row round trips with a null style column intact today`;

  test('a 300-char dismissed rationale survives untruncated (the disproof is the point)', () => {
    assert.ok(R300.length >= 300 && R300.length <= 320, `fixture must sit at the boundary (was ${R300.length})`);
    writeLedger([wellFormed({ rulingRationale: R300 })]);
    const block = buildRulingsBlock(ledgerPath, 'plan');
    // The old 100-char slice cut mid-sentence and lost the evidence entirely.
    assert.match(block, /tests\/db\/wine\.test\.mjs:88/,
      'evidence near the end of a 300-char rationale must reach the model');
  });

  test('an over-budget rationale truncates at a WORD boundary, never mid-token', () => {
    const long = `${R300} and then some additional trailing explanation about supersecretidentifier999 that overflows`;
    writeLedger([wellFormed({ rulingRationale: long })]);
    const block = buildRulingsBlock(ledgerPath, 'plan');
    assert.doesNotMatch(block, /supersecretidentifier999/, 'tail beyond the budget is dropped');
    // A mid-token cut yields a fragment that is not a real symbol — the failure
    // mode that makes a truncated rationale actively misleading.
    const line = block.split('\n').find((l) => l.includes('[abcdef]'));
    assert.ok(/(\.\.\.|…)/.test(line), 'truncation is marked');
    assert.doesNotMatch(line, /\w(\.\.\.|…)/, 'the cut lands after a word, not inside one');
  });

  // NB: the plan specified "100-char rationale budget for other groups", but the
  // SEVERITY ADJUSTED / FIXED renderers carry no rationale at all — only
  // DISMISSED emits a `Reason:`. Implementing a budget for a field that is never
  // rendered would be a constant no requirement needs, so the honest assertion
  // is that the expanded payload is DISMISSED-only.
  test('SEVERITY ADJUSTED renders no rationale — the expanded budget is DISMISSED-only', () => {
    writeLedger([wellFormed({ topicId: 'aaaaaa111111', adjudicationOutcome: 'severity_adjusted', originalSeverity: 'HIGH', severity: 'MEDIUM', rulingRationale: R300 })]);
    const block = buildRulingsBlock(ledgerPath, 'plan');
    assert.match(block, /SEVERITY ADJUSTED/);
    assert.doesNotMatch(block, /tests\/db\/wine\.test\.mjs:88/,
      'only DISMISSED gets the expanded budget — the disproof is only load-bearing there');
  });
});

describe('buildRulingsBlock — deterministic budget + bounded omission marker', () => {
  const manyDismissed = (n, idLen = 12) =>
    Array.from({ length: n }, (_, i) => wellFormed({
      topicId: String(i).padStart(idLen, 'z'),
      resolvedRound: (i % 3) + 1,
      rulingRationale: `rationale number ${i}`,
    }));

  test('the 8-entry hard slice is GONE — the budget decides, not an arbitrary count', () => {
    writeLedger(manyDismissed(12));
    const block = buildRulingsBlock(ledgerPath, 'plan');
    const rendered = (block.match(/— YOU ruled DISMISSED/g) || []).length;
    assert.ok(rendered > 8, `budget-driven rendering should exceed the old cap of 8 (rendered ${rendered})`);
  });

  test('block never exceeds the 2500 cap — 500 entries with 64-char topicIds', () => {
    writeLedger(manyDismissed(500, 64));
    const block = buildRulingsBlock(ledgerPath, 'plan');
    assert.ok(block.length <= 2500, `cap breached: ${block.length} > 2500`);
  });

  test('the omission marker is BOUNDED (≤5 ids + a count), so the reservation is honest', () => {
    writeLedger(manyDismissed(500, 64));
    const block = buildRulingsBlock(ledgerPath, 'plan');
    const marker = block.split('\n').find((l) => /more dismissed items/.test(l));
    assert.ok(marker, 'an omission marker must render when entries are dropped');
    // Only the parenthesised id list — a bare /\b[a-z0-9]{6}\b/ over the whole
    // marker would also match prose words like "ledger".
    const inner = marker.slice(marker.indexOf('(') + 1, marker.lastIndexOf(')'));
    const ids = inner.split(',').map((s) => s.trim()).filter((s) => /^[a-z0-9]{1,6}$/.test(s));
    assert.ok(ids.length <= 5, `marker names at most 5 ids (found ${ids.length})`);
    // Ids are sliced to 6 at the RENDER point — the schema does not bound topicId.
    assert.doesNotMatch(marker, /z{7,}/, 'no full-width 64-char topicId leaks into the marker');
  });

  test('selection is deterministic and priority-ordered (resolvedRound desc, topicId asc)', () => {
    const entries = manyDismissed(40);
    writeLedger(entries);
    const first = buildRulingsBlock(ledgerPath, 'plan');
    writeLedger([...entries].reverse()); // same set, different input order
    const second = buildRulingsBlock(ledgerPath, 'plan');
    assert.equal(first, second, 'input order must not change the rendered block');
    // Round 3 (highest resolvedRound) must be selected ahead of round 1.
    const idx3 = first.indexOf('DISMISSED R3');
    const idx1 = first.indexOf('DISMISSED R1');
    assert.ok(idx3 !== -1 && (idx1 === -1 || idx3 < idx1), 'most-recently-adjudicated first');
  });

  test('DISMISSED survives the cap even when FIXED/ADJUSTED would overflow it', () => {
    writeLedger([
      wellFormed({ topicId: 'dddddd444444', rulingRationale: 'the disproof that must survive' }),
      ...Array.from({ length: 50 }, (_, i) => wellFormed({
        topicId: `f${String(i).padStart(11, '0')}`,
        adjudicationOutcome: 'accepted', remediationState: 'fixed',
        rulingRationale: 'x'.repeat(200),
      })),
    ]);
    const block = buildRulingsBlock(ledgerPath, 'plan');
    assert.ok(block.length <= 2500, `cap breached: ${block.length}`);
    assert.match(block, /\[dddddd\]/, 'the dismissed entry must not be starved by the fixed group');
  });
});

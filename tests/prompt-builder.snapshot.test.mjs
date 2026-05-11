/**
 * Snapshot test for buildAuditPassPrompt — defends against accidental
 * prompt-shape changes that would invalidate OpenAI's prefix cache.
 *
 * The fixture at tests/fixtures/prompt-builder.snapshot.txt records the
 * expected byte output for four representative cases (R1 minimal, R2
 * with rulings, R1 map-reduce, R2 map-reduce).  If any production-code
 * change to prompt-builder.mjs produces a different output, this test
 * fails — and the operator must either:
 *   (a) revert the change if unintended, OR
 *   (b) bump PROMPT_BUILDER_VERSION + run `UPDATE_SNAPSHOTS=1 node --test`
 *       to refresh the baseline.
 *
 * Why this matters: prompt-builder is THE chokepoint for cache stability.
 * A subtle change (whitespace, ordering, header wording) breaks the
 * byte-identical-prefix contract that OpenAI auto-caching depends on,
 * silently destroying the savings we just shipped.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildAuditPassPrompt } from '../scripts/lib/audit/prompt-builder.mjs';

const FIXTURE_PATH = path.resolve(import.meta.dirname, 'fixtures/prompt-builder.snapshot.txt');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

// Deterministic inputs — matched to the structure pass shape from
// scripts/openai-audit.mjs.  Same input across calls → same output.
const FIXTURE_INPUTS = Object.freeze({
  systemRubric: 'PASS_STRUCTURE_SYSTEM: Audit file-level structure against the plan.\nFOCUS: priority rules for backend stack.',
  brief: 'Project: claude-engineering-skills. Stack: js-ts (Node ESM).\n\n### Pass-Specific Context (structure)\nMap planned files to actual files.  Flag missing/extra/misplaced.',
  planSlice: '## File-Level Plan\n- scripts/foo.mjs — new module with bar() and baz()\n- tests/foo.test.mjs — unit tests for foo.mjs',
  fileListContext: '## Files\n- /scripts/foo.mjs\n- /tests/foo.test.mjs',
  code: '// scripts/foo.mjs\nexport function bar() { return 1; }\nexport function baz(x) { return x * 2; }',
  codeHeader: '## File Signatures',
  rulingsText: 'DISMISSED: [abc123] "Missing test file" — Resolved R1.  Reason: file exists at planned path.  Scope: tests/foo.test.mjs',
  roundModifier: 'ROUND 2+ MODE — verify fixes, do not re-raise dismissed findings.',
  unitLabel: 'Audit Unit 2/5 (3 files)',
});

function renderSnapshot() {
  const lines = [];

  // R1 minimal
  const r1 = buildAuditPassPrompt({
    systemRubric: FIXTURE_INPUTS.systemRubric,
    brief: FIXTURE_INPUTS.brief,
    planSlice: FIXTURE_INPUTS.planSlice,
    fileListContext: FIXTURE_INPUTS.fileListContext,
    code: FIXTURE_INPUTS.code,
    codeHeader: FIXTURE_INPUTS.codeHeader,
  });

  // R2 with rulings + roundModifier
  const r2 = buildAuditPassPrompt({
    systemRubric: FIXTURE_INPUTS.systemRubric,
    brief: FIXTURE_INPUTS.brief,
    planSlice: FIXTURE_INPUTS.planSlice,
    fileListContext: FIXTURE_INPUTS.fileListContext,
    code: FIXTURE_INPUTS.code,
    codeHeader: FIXTURE_INPUTS.codeHeader,
    history: FIXTURE_INPUTS.rulingsText,
    roundModifier: FIXTURE_INPUTS.roundModifier,
  });

  // R2 + unitLabel (map-reduce sub-pass)
  const r2map = buildAuditPassPrompt({
    systemRubric: FIXTURE_INPUTS.systemRubric,
    brief: FIXTURE_INPUTS.brief,
    planSlice: FIXTURE_INPUTS.planSlice,
    fileListContext: FIXTURE_INPUTS.fileListContext,
    code: FIXTURE_INPUTS.code,
    codeHeader: FIXTURE_INPUTS.codeHeader,
    history: FIXTURE_INPUTS.rulingsText,
    roundModifier: FIXTURE_INPUTS.roundModifier,
    unitLabel: FIXTURE_INPUTS.unitLabel,
  });

  lines.push('=== SYSTEM ===');
  lines.push(r1.system);

  lines.push('=== MSG_1 ===');
  lines.push(r1.messages[0].content);

  // R1 has only 2 messages (no msg_2)
  lines.push('=== MSG_2 (R1) ===');
  lines.push(r1.messages.length === 3 ? r1.messages[1].content : '(absent)');

  lines.push('=== MSG_2 (R2 with rulings + roundModifier) ===');
  lines.push(r2.messages[1].content);

  lines.push('=== MSG_3 (R1) ===');
  lines.push(r1.messages[r1.messages.length - 1].content);

  lines.push('=== MSG_3 (R2 with unitLabel) ===');
  lines.push(r2map.messages[r2map.messages.length - 1].content);

  return lines.join('\n');
}

describe('buildAuditPassPrompt — snapshot regression', () => {
  it('produces the byte-identical baseline shape (cache-stability contract)', () => {
    const rendered = renderSnapshot();

    if (UPDATE) {
      fs.writeFileSync(FIXTURE_PATH, rendered + '\n');
      console.log(`[snapshot] Updated ${FIXTURE_PATH}`);
      return;
    }

    const expected = fs.readFileSync(FIXTURE_PATH, 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
    const actual = rendered.replace(/\r\n/g, '\n');

    if (actual !== expected) {
      // Surface a small diff hint without dumping the full snapshot
      const expLines = expected.split('\n');
      const actLines = actual.split('\n');
      const firstDiff = expLines.findIndex((l, i) => l !== actLines[i]);
      const hint = firstDiff === -1
        ? `(length mismatch: expected ${expLines.length} lines, got ${actLines.length})`
        : `first diverging line ${firstDiff + 1}:\n  expected: ${JSON.stringify(expLines[firstDiff])}\n    actual: ${JSON.stringify(actLines[firstDiff])}`;
      assert.fail(
        `Snapshot mismatch — buildAuditPassPrompt output changed.\n` +
        `If this change is intentional, bump PROMPT_BUILDER_VERSION and re-run:\n` +
        `  UPDATE_SNAPSHOTS=1 node --test tests/prompt-builder.snapshot.test.mjs\n\n` +
        hint
      );
    }
  });

  it('msg #1 is byte-identical between R1 and R2 (cache invariant)', () => {
    // Cross-check the central cache-stability claim: msg #1 must NOT vary
    // by round.  If this fails, the snapshot pollution above is masking a
    // real cache-stability regression.
    const baseOpts = {
      systemRubric: FIXTURE_INPUTS.systemRubric,
      brief: FIXTURE_INPUTS.brief,
      planSlice: FIXTURE_INPUTS.planSlice,
      fileListContext: FIXTURE_INPUTS.fileListContext,
      code: FIXTURE_INPUTS.code,
      codeHeader: FIXTURE_INPUTS.codeHeader,
    };
    const r1 = buildAuditPassPrompt(baseOpts);
    const r2 = buildAuditPassPrompt({ ...baseOpts, history: FIXTURE_INPUTS.rulingsText, roundModifier: FIXTURE_INPUTS.roundModifier });
    const r3 = buildAuditPassPrompt({ ...baseOpts, history: 'different rulings text', roundModifier: 'ROUND 3+ MODE' });

    assert.equal(r1.system, r2.system);
    assert.equal(r1.system, r3.system);
    assert.equal(r1.messages[0].content, r2.messages[0].content);
    assert.equal(r1.messages[0].content, r3.messages[0].content);
  });
});

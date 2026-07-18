/**
 * @fileoverview Phase D.7 — audit-summary parser tests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSummaryContent,
  extractPhaseTag,
} from '../scripts/lib/backfill-parser.mjs';

// ── extractPhaseTag ─────────────────────────────────────────────────────────

describe('extractPhaseTag', () => {
  test('extracts phase-a/b/c from filename', () => {
    assert.equal(extractPhaseTag('phase-a-language-aware-analysis-audit-summary.md'), 'phase-a');
    assert.equal(extractPhaseTag('phase-b-sonarqube-classification-audit-summary.md'), 'phase-b');
    assert.equal(extractPhaseTag('docs/plans/phase-c-linter-pre-pass-audit-summary.md'), 'phase-c');
  });

  test('falls back to basename-minus-suffix for non-phase files', () => {
    assert.equal(extractPhaseTag('learning-system-v2-audit-summary.md'), 'learning-system-v2');
    assert.equal(extractPhaseTag('random-file-audit-summary.md'), 'random-file');
  });
});

// ── parseSummaryContent: bullet format ──────────────────────────────────────

describe('parseSummaryContent — bullet format', () => {
  const content = `# Phase B Audit Summary

## Outcome
narrative text

## Deferred (pre-existing debt)

- God module in scripts/openai-audit.mjs — H1
- Ledger fail-open recovery — H2
- Hardcoded \`thinkingBudget: 16384\` — M4
- Dead \`_userId\` — L1

## Notes
unrelated notes
`;

  test('extracts 4 entries from deferred section', () => {
    const { records } = parseSummaryContent(content, { sourceFile: 'phase-b-x-audit-summary.md' });
    assert.equal(records.length, 4);
  });

  test('preserves findingId verbatim', () => {
    const { records } = parseSummaryContent(content, { sourceFile: 'phase-b-x-audit-summary.md' });
    const ids = records.map(r => r.findingId).sort();
    assert.deepEqual(ids, ['H1', 'H2', 'L1', 'M4']);
  });

  test('infers severity from findingId prefix', () => {
    const { records } = parseSummaryContent(content, { sourceFile: 'phase-b-x-audit-summary.md' });
    const byId = Object.fromEntries(records.map(r => [r.findingId, r.severity]));
    assert.equal(byId.H1, 'HIGH');
    assert.equal(byId.M4, 'MEDIUM');
    assert.equal(byId.L1, 'LOW');
  });

  test('tags records with phase', () => {
    const { records } = parseSummaryContent(content, { sourceFile: 'phase-b-x-audit-summary.md' });
    for (const r of records) assert.equal(r.phaseTag, 'phase-b');
  });

  test('skips entries outside deferred section', () => {
    const outside = `# Summary

## Outcome
- This is a bullet in Outcome — H99
- Should be ignored — H98

## Notes
- Also ignored — H97
`;
    const { records } = parseSummaryContent(outside);
    assert.equal(records.length, 0);
  });

  test('suggestedTopicId is deterministic 12-char hex', () => {
    const { records: r1 } = parseSummaryContent(content, { sourceFile: 'phase-b-x-audit-summary.md' });
    const { records: r2 } = parseSummaryContent(content, { sourceFile: 'phase-b-x-audit-summary.md' });
    assert.equal(r1[0].suggestedTopicId, r2[0].suggestedTopicId);
    assert.match(r1[0].suggestedTopicId, /^[0-9a-f]{12}$/);
  });

  test('parseConfidence markers present on all fields', () => {
    const { records } = parseSummaryContent(content, { sourceFile: 'phase-b-x-audit-summary.md' });
    const pc = records[0].parseConfidence;
    assert.equal(pc.description, 'high');
    assert.equal(pc.findingId, 'high');
    assert.equal(pc.severity, 'medium');
    assert.equal(pc.suggestedTopicId, 'low');
  });

  test('extracts inferred files from backticked paths', () => {
    const withFile = `## Deferred
- God module in \`scripts/openai-audit.mjs\` at line 42 — H1
`;
    const { records } = parseSummaryContent(withFile);
    assert.deepEqual(records[0].inferredFiles, ['scripts/openai-audit.mjs']);
    assert.equal(records[0].parseConfidence.inferredFiles, 'medium');
  });

  test('skips identifier-only backticks without slashes', () => {
    const noPath = `## Deferred
- Dead \`_userId\` variable — L1
`;
    const { records } = parseSummaryContent(noPath);
    assert.deepEqual(records[0].inferredFiles, []);
  });
});

// ── parseSummaryContent: table format ───────────────────────────────────────

describe('parseSummaryContent — table format', () => {
  const content = `# Phase C Audit Summary

## Deferred (pre-existing)

| ID | Finding | Note |
|---|---|---|
| H1 | God module in openai-audit | 82KB file |
| H2 | Mixed concerns in \`scripts/lib/findings.mjs\` | Known debt |
| M3 | Hardcoded values | Refactor candidate |
`;

  test('extracts 3 entries from table', () => {
    const { records } = parseSummaryContent(content);
    assert.equal(records.length, 3);
  });

  test('captures description + note separately', () => {
    const { records } = parseSummaryContent(content);
    assert.equal(records[0].description, 'God module in openai-audit');
    assert.equal(records[0].note, '82KB file');
  });

  test('skips header separator row', () => {
    const { records } = parseSummaryContent(content);
    // 3 entries, not 4 (the | --- | --- | separator skipped)
    assert.equal(records.length, 3);
  });

  test('extracts files from table description', () => {
    const { records } = parseSummaryContent(content);
    const byId = Object.fromEntries(records.map(r => [r.findingId, r]));
    assert.deepEqual(byId.H2.inferredFiles, ['scripts/lib/findings.mjs']);
  });
});

// ── Mixed / edge cases ──────────────────────────────────────────────────────

describe('parseSummaryContent — edge cases', () => {
  test('no headings → diagnostic', () => {
    const r = parseSummaryContent('just some prose\nwith no structure\n');
    assert.equal(r.records.length, 0);
    assert.ok(r.diagnostics.some(d => /no markdown headings/.test(d)));
  });

  test('headings but no deferred section → diagnostic', () => {
    const r = parseSummaryContent('## Intro\n- Thing one — H1\n## Outcome\n- Thing two — H2\n');
    assert.equal(r.records.length, 0);
    assert.ok(r.diagnostics.some(d => /no deferred-section entries/.test(d)));
  });

  test('handles ## Known Limitations as deferred section', () => {
    const r = parseSummaryContent('## Known Limitations\n- Identity drift — H1\n');
    assert.equal(r.records.length, 1);
  });

  test('handles ## Out of Scope as deferred section', () => {
    const r = parseSummaryContent('## Out of Scope\n- Future work — M1\n');
    assert.equal(r.records.length, 1);
  });

  test('tool findings (T-prefix) default to LOW severity', () => {
    const r = parseSummaryContent('## Deferred\n- Tool finding — T5\n');
    assert.equal(r.records[0].severity, 'LOW');
  });
});

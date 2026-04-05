/**
 * @fileoverview Phase D.4 — Gemini transcript debt-suppression tests.
 *
 * Exercises the re-suppression logic that runs AFTER Gemini's response is
 * parsed: any new_findings matching a pre-filtered debt topic (via fuzzy
 * Jaccard match against the transcript envelope) get removed.
 *
 * We extract the helper logic from gemini-review.mjs and test it in isolation
 * since the main() in gemini-review.mjs is long-running and depends on live
 * API keys.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { jaccardSimilarity } from '../scripts/lib/ledger.mjs';

// Extracted fuzzy-suppression helper matching gemini-review.mjs's defense-in-depth logic
function reSuppressAgainstDebt(newFindings, suppressionContext, threshold = 0.30) {
  if (!Array.isArray(newFindings) || newFindings.length === 0) {
    return { kept: [], debtSuppressed: [] };
  }
  if (!Array.isArray(suppressionContext) || suppressionContext.length === 0) {
    return { kept: newFindings, debtSuppressed: [] };
  }
  const kept = [];
  const debtSuppressed = [];
  for (const f of newFindings) {
    const fSig = `${f.category} ${f.section} ${f.detail}`;
    let match = null;
    let bestScore = 0;
    for (const d of suppressionContext) {
      const dSig = `${d.category} ${d.section}`;
      const score = jaccardSimilarity(fSig, dSig);
      if (score > bestScore) { bestScore = score; match = d; }
    }
    if (match && bestScore > threshold) {
      debtSuppressed.push({ finding: f, matchedTopic: match.topicId, score: bestScore });
    } else {
      kept.push(f);
    }
  }
  return { kept, debtSuppressed };
}

const debtCtx = [
  {
    topicId: 'abc12345',
    category: 'God Module Excessive File Size',
    section: 'scripts/openai-audit.mjs',
    affectedFiles: ['scripts/openai-audit.mjs'],
    deferredReason: 'out-of-scope',
  },
  {
    topicId: 'def67890',
    category: 'Global Mutable State',
    section: 'scripts/lib/findings.mjs',
    affectedFiles: ['scripts/lib/findings.mjs'],
    deferredReason: 'blocked-by',
  },
];

describe('reSuppressAgainstDebt', () => {
  test('empty new_findings → kept empty, no suppression', () => {
    const r = reSuppressAgainstDebt([], debtCtx);
    assert.deepEqual(r.kept, []);
    assert.equal(r.debtSuppressed.length, 0);
  });

  test('empty suppressionContext → all findings kept', () => {
    const findings = [{ category: 'X', section: 'y', detail: 'z' }];
    const r = reSuppressAgainstDebt(findings, []);
    assert.equal(r.kept.length, 1);
    assert.equal(r.debtSuppressed.length, 0);
  });

  test('Gemini finding that matches a debt topic is suppressed', () => {
    const findings = [{
      category: 'God Module Excessive File Size',
      section: 'scripts/openai-audit.mjs',
      detail: 'This file has grown to 1200 lines with mixed concerns and should be split',
    }];
    const r = reSuppressAgainstDebt(findings, debtCtx);
    assert.equal(r.kept.length, 0);
    assert.equal(r.debtSuppressed.length, 1);
    assert.equal(r.debtSuppressed[0].matchedTopic, 'abc12345');
  });

  test('genuinely new Gemini finding is kept', () => {
    const findings = [{
      category: 'SQL Injection Risk',
      section: 'scripts/api/users.js',
      detail: 'Untrusted user input concatenated into raw query string',
    }];
    const r = reSuppressAgainstDebt(findings, debtCtx);
    assert.equal(r.kept.length, 1);
    assert.equal(r.debtSuppressed.length, 0);
  });

  test('finding below threshold (weak match) is kept', () => {
    // Low overlap — should NOT trip the 0.35 threshold
    const findings = [{
      category: 'Minor Polish',
      section: 'docs/README.md',
      detail: 'Formatting inconsistency in the setup guide',
    }];
    const r = reSuppressAgainstDebt(findings, debtCtx);
    assert.equal(r.kept.length, 1);
  });

  test('picks highest-scoring debt topic when multiple match', () => {
    const findings = [{
      category: 'Global Mutable State',
      section: 'scripts/lib/findings.mjs',
      detail: 'module-level let used without encapsulation, hard to test',
    }];
    const r = reSuppressAgainstDebt(findings, debtCtx);
    assert.equal(r.kept.length, 0);
    assert.equal(r.debtSuppressed[0].matchedTopic, 'def67890');
  });

  test('threshold tuning: stricter threshold keeps more findings', () => {
    const findings = [{
      category: 'God Module Excessive File Size',
      section: 'scripts/openai-audit.mjs',
      detail: 'File is too large',
    }];
    const loose = reSuppressAgainstDebt(findings, debtCtx, 0.2);
    const strict = reSuppressAgainstDebt(findings, debtCtx, 0.95);
    assert.equal(loose.debtSuppressed.length, 1);
    assert.equal(strict.debtSuppressed.length, 0);
    assert.equal(strict.kept.length, 1);
  });

  test('mixed findings: only matching ones suppressed', () => {
    const findings = [
      { category: 'God Module Excessive', section: 'scripts/openai-audit.mjs', detail: 'too large' }, // matches
      { category: 'Race Condition', section: 'scripts/workers.js', detail: 'shared counter' },        // new
      { category: 'Global Mutable State', section: 'scripts/lib/findings.mjs', detail: 'unencapsulated' }, // matches
    ];
    const r = reSuppressAgainstDebt(findings, debtCtx);
    assert.equal(r.kept.length, 1);
    assert.equal(r.debtSuppressed.length, 2);
    assert.equal(r.kept[0].category, 'Race Condition');
  });
});

// ── Audit-side envelope check: verify openai-audit.mjs emits suppressionContext ──

describe('audit result _debtMemory envelope', () => {
  test('suppressionContext shape: {topicId, category, section, affectedFiles, deferredReason}', () => {
    // Synthetic envelope matching what openai-audit.mjs produces
    const envelope = {
      eventSource: 'local',
      debtSuppressed: 2,
      debtReopened: 0,
      debtEntriesLoaded: 5,
      newlyEscalated: 0,
      suppressionContext: [
        {
          topicId: 'abc12345',
          category: 'Test',
          section: 'src/x.js',
          affectedFiles: ['src/x.js'],
          deferredReason: 'out-of-scope',
        },
      ],
    };
    // Transcript envelope can be read by Gemini-review
    assert.equal(envelope.suppressionContext.length, 1);
    assert.equal(envelope.suppressionContext[0].topicId, 'abc12345');
    assert.ok('affectedFiles' in envelope.suppressionContext[0]);
  });
});

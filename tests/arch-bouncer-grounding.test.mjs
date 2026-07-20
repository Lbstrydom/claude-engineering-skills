/**
 * @fileoverview The arch bouncer only judges what it's handed.
 *
 * Origin (2026-07-20): the bouncer is handed the full architecture-intent
 * mermaid diagram plus the mechanical violations, and the LLM reasons from the
 * diagram to "notice" edges the mechanical layer already checked against
 * allowedDeps and cleared. A run whose only mechanical violation was
 * `stores -> plan` emitted 16 findings claiming `brainstorm -> requirements`
 * violates a boundary — an edge EXPLICITLY in allowedDeps. `groundArchFindings-
 * ToReport` drops any finding whose file the mechanical layer never flagged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { groundArchFindingsToReport } from '../scripts/lib/audit/legacy-production-audit.mjs';

// The exact reproduction: the mechanical report flagged ONLY stores->plan.
const REPORT = {
  violations: [
    { fromFile: 'scripts/lib/store/plans-ship.mjs', toFile: 'scripts/lib/plan-status.mjs',
      fromDomain: 'stores', toDomain: 'plan', ruleViolated: 'not-in-allowedDeps' },
  ],
  unmappedFiles: ['scripts/lib/orphan-thing.mjs'],
  deadIntent: [],
};

test('drops the hallucinated brainstorm->requirements finding', () => {
  const findings = [
    { severity: 'MEDIUM', category: 'Layer Boundary Erosion',
      section: 'scripts/lib/brainstorm/policy-context.mjs',
      detail: 'brainstorm depends on requirements context' },
  ];
  const { kept, dropped } = groundArchFindingsToReport(findings, REPORT);
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1, 'policy-context.mjs is not in the mechanical report');
});

test('keeps a finding about the file the mechanical layer actually flagged', () => {
  const findings = [
    { severity: 'MEDIUM', category: 'Forbidden cross-domain edge',
      section: 'scripts/lib/store/plans-ship.mjs',
      detail: 'stores imports plan' },
  ];
  const { kept, dropped } = groundArchFindingsToReport(findings, REPORT);
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 0);
});

test('keeps a finding about the toFile of a violation (both ends are flagged)', () => {
  const findings = [{ section: 'scripts/lib/plan-status.mjs', category: 'x', detail: 'y' }];
  assert.equal(groundArchFindingsToReport(findings, REPORT).kept.length, 1);
});

test('keeps a finding about an unmapped file', () => {
  const findings = [{ section: 'scripts/lib/orphan-thing.mjs', category: 'x', detail: 'y' }];
  assert.equal(groundArchFindingsToReport(findings, REPORT).kept.length, 1);
});

test('a section with file:symbol form still resolves to the file', () => {
  const findings = [{ section: 'scripts/lib/store/plans-ship.mjs:upsertPlan', category: 'x', detail: 'y' }];
  assert.equal(groundArchFindingsToReport(findings, REPORT).kept.length, 1, 'strip :symbol before matching');
});

test('a domain-level finding with no file-like section is KEPT (conservative)', () => {
  // dead-intent findings legitimately name a domain, not a file — do not drop
  // what we cannot disprove.
  const findings = [{ section: 'the requirements domain', category: 'Dead declared domain', detail: 'z' }];
  assert.equal(groundArchFindingsToReport(findings, REPORT).kept.length, 1);
});

test('_primaryFile takes precedence over section when present', () => {
  const findings = [{ _primaryFile: 'scripts/lib/store/plans-ship.mjs', section: 'unrelated prose', category: 'x', detail: 'y' }];
  assert.equal(groundArchFindingsToReport(findings, REPORT).kept.length, 1);
});

test('empty / missing inputs are safe no-ops', () => {
  assert.deepEqual(groundArchFindingsToReport([], REPORT), { kept: [], dropped: [] });
  assert.equal(groundArchFindingsToReport(null, REPORT).kept.length, 0);
  // a report with no violations flags nothing → every file-like finding drops
  const only = [{ section: 'a/b.mjs', category: 'x', detail: 'y' }];
  assert.equal(groundArchFindingsToReport(only, { violations: [], unmappedFiles: [] }).dropped.length, 1);
});

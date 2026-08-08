import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAcceptanceCriteria,
  locateAcceptanceSection,
  criterionHash,
  summariseCriteria,
} from '../scripts/lib/plan-criteria-parser.mjs';

const WELL_FORMED_PLAN = `# Plan: Cellar Grid Redesign

## Phase 5

### 1. Current UI Audit
Prose.

### 9. Acceptance Criteria (Playwright-verifiable)

- [P0] [visibility] Cellar grid is visible after login
  - Setup: login → navigate to /cellar
  - Assert: getByRole('grid', { name: /cellar/i }) is visible
- [P0] [interaction] Wine card opens detail modal on click
  - Setup: login → navigate to /cellar
  - Assert: click getByRole('article').first() → getByRole('dialog') is visible
- [P1] [a11y] No WCAG AA violations on grid
  - Setup: login → navigate to /cellar
  - Assert: axe-core violations on [role="grid"] == 0

## Phase 6 — Persist the Plan

More prose.
`;

describe('locateAcceptanceSection', () => {
  it('finds the section by heading', () => {
    const result = locateAcceptanceSection(WELL_FORMED_PLAN);
    assert.ok(result);
    assert.ok(result.lines.length > 0);
  });

  it('returns null when no heading matches', () => {
    const result = locateAcceptanceSection('# Just a Title\n\nNo criteria here.');
    assert.equal(result, null);
  });

  it('respects heading level — stops at next heading of equal or higher level', () => {
    const result = locateAcceptanceSection(WELL_FORMED_PLAN);
    // Should not include "Phase 6" content
    const joined = result.lines.join('\n');
    assert.ok(!joined.includes('Persist the Plan'));
    assert.ok(joined.includes('[P0] [visibility]'));
  });

  it('tolerates unnumbered headings', () => {
    const md = `## Acceptance Criteria\n\n- [P0] [visibility] X\n  - Assert: y`;
    const result = locateAcceptanceSection(md);
    assert.ok(result);
  });
});

describe('parseAcceptanceCriteria', () => {
  it('parses a well-formed plan into 3 criteria', () => {
    const { criteria, errors, found } = parseAcceptanceCriteria(WELL_FORMED_PLAN);
    assert.equal(found, true);
    assert.equal(errors.length, 0);
    assert.equal(criteria.length, 3);
  });

  it('populates severity, category, description, setup, assertion', () => {
    const { criteria } = parseAcceptanceCriteria(WELL_FORMED_PLAN);
    const first = criteria[0];
    assert.equal(first.severity, 'P0');
    assert.equal(first.category, 'visibility');
    assert.equal(first.description, 'Cellar grid is visible after login');
    assert.ok(first.setup.includes('login'));
    assert.ok(first.assertion.includes('getByRole'));
    assert.ok(first.hash.length === 16);
  });

  it('returns stable hashes — same input, same hash', () => {
    const { criteria: a } = parseAcceptanceCriteria(WELL_FORMED_PLAN);
    const { criteria: b } = parseAcceptanceCriteria(WELL_FORMED_PLAN);
    assert.equal(a[0].hash, b[0].hash);
  });

  it('flags invalid severity', () => {
    const md = `## Acceptance Criteria\n- [P9] [visibility] Bad severity\n  - Assert: x`;
    const { criteria, errors } = parseAcceptanceCriteria(md);
    assert.equal(criteria.length, 0);
    assert.ok(errors.some(e => /severity/i.test(e)));
  });

  it('flags invalid category', () => {
    const md = `## Acceptance Criteria\n- [P0] [wibble] Invalid category\n  - Assert: x`;
    const { criteria, errors } = parseAcceptanceCriteria(md);
    assert.equal(criteria.length, 0);
    assert.ok(errors.some(e => /category/i.test(e)));
  });

  it('returns found:false when section is missing', () => {
    const { criteria, errors, found } = parseAcceptanceCriteria('# Just a title');
    assert.equal(found, false);
    assert.equal(criteria.length, 0);
    assert.equal(errors.length, 1);
  });

  it('handles criterion without setup/assert sub-bullets', () => {
    const md = `## Acceptance Criteria\n- [P0] [visibility] Logo is visible\n- [P1] [a11y] No violations`;
    const { criteria, errors } = parseAcceptanceCriteria(md);
    assert.equal(criteria.length, 2);
    assert.equal(errors.length, 0);
    assert.equal(criteria[0].setup, null);
    assert.equal(criteria[0].assertion, null);
  });

  it('tolerates prose between criteria', () => {
    const md = `## Acceptance Criteria

Some intro prose.

- [P0] [visibility] A visible thing
  - Assert: foo

Notes between criteria.

- [P1] [a11y] Another thing
  - Assert: bar`;
    const { criteria } = parseAcceptanceCriteria(md);
    assert.equal(criteria.length, 2);
  });

  it('accepts unicode → arrow in Setup/Assert text', () => {
    const md = `## Acceptance Criteria\n- [P0] [interaction] X\n  - Setup: click → navigate\n  - Assert: result → visible`;
    const { criteria } = parseAcceptanceCriteria(md);
    assert.equal(criteria.length, 1);
    assert.ok(criteria[0].setup.includes('->'));
    assert.ok(criteria[0].assertion.includes('->'));
  });

  it('assigns contiguous indices starting from 0', () => {
    const { criteria } = parseAcceptanceCriteria(WELL_FORMED_PLAN);
    criteria.forEach((c, i) => assert.equal(c.index, i));
  });
});

describe('criterionHash', () => {
  it('is stable for same inputs', () => {
    const a = criterionHash({ severity: 'P0', category: 'visibility', description: 'x' });
    const b = criterionHash({ severity: 'P0', category: 'visibility', description: 'x' });
    assert.equal(a, b);
  });

  it('differs for different inputs', () => {
    const a = criterionHash({ severity: 'P0', category: 'visibility', description: 'x' });
    const b = criterionHash({ severity: 'P1', category: 'visibility', description: 'x' });
    assert.notEqual(a, b);
  });

  it('normalises severity case', () => {
    const upper = criterionHash({ severity: 'P0', category: 'a11y', description: 'x' });
    const lower = criterionHash({ severity: 'p0', category: 'a11y', description: 'x' });
    assert.equal(upper, lower);
  });
});

describe('summariseCriteria', () => {
  it('counts by severity and category', () => {
    const { criteria } = parseAcceptanceCriteria(WELL_FORMED_PLAN);
    const s = summariseCriteria(criteria);
    assert.equal(s.total, 3);
    assert.equal(s.bySeverity.P0, 2);
    assert.equal(s.bySeverity.P1, 1);
    assert.equal(s.byCategory.visibility, 1);
    assert.equal(s.byCategory.interaction, 1);
    assert.equal(s.byCategory.a11y, 1);
  });
});

describe('a criterion the parser cannot read must never be silent', () => {
  // Round-1 audit findings M2/M4/M6/M12, all reproduced before fixing. The
  // shared consequence: /ux-lock verify grades a plan against a live app from
  // these criteria, so a dropped one is never checked while the run still
  // reports on the ones that parsed — green having checked less than it says.

  it('does not promote an indented bullet to a standalone criterion', () => {
    const md = [
      '## 10. Acceptance Criteria',
      '- [P0] [visibility] the real criterion',
      '  - Setup: log in',
      '  - [P1] [a11y] nested, must NOT become its own criterion',
    ].join('\n');
    const r = parseAcceptanceCriteria(md);
    assert.deepEqual(r.criteria.map(c => c.severity), ['P0']);
    // …and it is REPORTED, not swallowed: an indented criterion is ambiguous
    // (CommonMark allows <=3 spaces on a top-level item), so the parser refuses
    // to guess in either direction and tells the author to fix the indentation.
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /Indented criterion-shaped bullet/);
  });

  it('terminates the section at a level-1 heading', () => {
    const md = [
      '## 10. Acceptance Criteria',
      '- [P0] [visibility] in scope',
      '# A new top-level document section',
      '- [P1] [a11y] NOT an acceptance criterion',
    ].join('\n');
    const r = parseAcceptanceCriteria(md);
    assert.deepEqual(r.criteria.map(c => c.severity), ['P0']);
  });

  it('reports a criterion-shaped bullet that does not parse, rather than dropping it', () => {
    const md = [
      '## 10. Acceptance Criteria',
      '- [P0] [visibility] fine',
      '- [P2] missing the category tag',
    ].join('\n');
    const r = parseAcceptanceCriteria(md);
    assert.equal(r.criteria.length, 1);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /Malformed criterion/);
  });

  it('still ignores ordinary prose bullets — the guard must not cry wolf', () => {
    // Vacuous-pass guard: a rule that flags everything would pass the test
    // above while making the parser unusable on a real plan.
    const md = [
      '## 10. Acceptance Criteria',
      '- [P0] [visibility] fine',
      'Some prose:',
      '- an ordinary bullet, not a criterion',
    ].join('\n');
    const r = parseAcceptanceCriteria(md);
    assert.deepEqual(r.errors, []);
    assert.equal(r.criteria.length, 1);
  });
});

describe('a malformed criterion cannot steal the previous one\'s Setup/Assert', () => {
  // Caught by the Gemini final gate 2026-08-08, in a fix from this same audit:
  // the malformed branch reported the error and skipped the line WITHOUT
  // clearing `current`, so the malformed criterion's own nested bullets matched
  // NESTED_RE and attached to the previous VALID criterion. Silent corruption —
  // the criterion still parses, it just carries someone else's assertion.
  it('leaves the valid criterion with its own setup and no foreign assertion', () => {
    const md = [
      '## 10. Acceptance Criteria',
      '- [P0] [visibility] the valid one',
      '  - Setup: belongs to P0',
      '- [P2] malformed no category',
      '  - Setup: belongs to the MALFORMED one',
      '  - Assert: also the malformed one',
    ].join('\n');
    const r = parseAcceptanceCriteria(md);
    assert.equal(r.criteria.length, 1);
    assert.equal(r.criteria[0].severity, 'P0');
    assert.equal(r.criteria[0].setup, 'belongs to P0');
    assert.equal(r.criteria[0].assertion, null, 'P0 declared no assertion and must not inherit one');
    assert.equal(r.errors.length, 1);
  });

  it('a VALID criterion still collects its own nested bullets', () => {
    // Vacuous-pass guard: clearing `current` too eagerly would drop every
    // Setup/Assert in the document and still satisfy the test above.
    const md = [
      '## 10. Acceptance Criteria',
      '- [P0] [visibility] first',
      '  - Setup: log in',
      '  - Assert: grid visible',
      '- [P1] [a11y] second',
      '  - Assert: no violations',
    ].join('\n');
    const r = parseAcceptanceCriteria(md);
    assert.deepEqual(r.criteria.map(c => [c.setup, c.assertion]), [
      ['log in', 'grid visible'],
      [null, 'no violations'],
    ]);
    assert.deepEqual(r.errors, []);
  });
});

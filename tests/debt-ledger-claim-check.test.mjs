import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  findClaimLines,
  extractCitedIds,
  checkDocument,
  executeCheck,
} from '../scripts/lib/debt-ledger-claim-check.mjs';

// Design: this check exists because docs/plans/cross-skill-command-registry.md
// (and, before it, cross-skill-cli-integrity.md) claimed "captured to the debt
// ledger" for items the ledger never held. Fixtures below are drawn from the
// real prose shapes both incidents produced, not invented for coverage.

describe('findClaimLines — positive-claim detection', () => {
  it('matches "named in the debt ledger" (the actual false-claim wording)', () => {
    const text = 'etc.) — each named in the debt ledger, none blocks this work.';
    const claims = findClaimLines(text);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].line, 1);
  });

  it('matches "captured to `.audit/tech-debt.json`" (the true-claim wording)', () => {
    const text = '- **`b093444897a3`** (new — captured to `.audit/tech-debt.json` during this';
    assert.equal(findClaimLines(text).length, 1);
  });

  it('matches "captured to the debt ledger ... see §7" (pointer form)', () => {
    const text = 'captured to the debt ledger rather than implemented here — see §7.';
    assert.equal(findClaimLines(text).length, 1);
  });

  it('does NOT match a quoted mention discussing the false phrase', () => {
    const text = '> the four entries below closed with *"Captured to the debt ledger."* **They were';
    assert.equal(findClaimLines(text).length, 0);
  });

  it('does NOT match a table cell quoting the phrase', () => {
    const text = '| §Deferred\'s *"captured to the debt ledger"* | **false claim, corrected in place** | this closure |';
    assert.equal(findClaimLines(text).length, 0);
  });

  it('does NOT match "filed" as a substring of an unrelated identifier (word-boundary regression)', () => {
    const text = "      return fileDebtLedger.batchWriteLedger('.audit/tech-debt.json', entries);";
    assert.equal(findClaimLines(text).length, 0);
  });

  it('does NOT match unrelated "captured" language with no ledger reference', () => {
    const text = 'Malformed Mermaid → captured in `_warnings: [...]`, no throw';
    assert.equal(findClaimLines(text).length, 0);
  });

  it('does NOT match generic debt-ledger-entry prose with no capture verb', () => {
    const text = 'This makes each debt-ledger entry "closable" on paper — a diagnostic message technically changed';
    assert.equal(findClaimLines(text).length, 0);
  });
});

describe('extractCitedIds', () => {
  it('extracts 8-hex and 12-hex backtick-quoted tokens, lower-cased and deduped', () => {
    const text = 'See `78e4d7aa` and `B093444897A3` and again `78e4d7aa`.';
    assert.deepEqual(extractCitedIds(text).sort(), ['78e4d7aa', 'b093444897a3'].sort());
  });

  it('ignores non-hex or wrong-length backtick tokens', () => {
    const text = '`isCloudEnabled` and `not-hex-zzzz` and `deadbeef1` (9 chars, invalid length)';
    assert.deepEqual(extractCitedIds(text), []);
  });
});

describe('checkDocument', () => {
  const validIds = new Set(['78e4d7aa', 'b093444897a3']);

  it('a document with no claim is resolvable by construction', () => {
    const r = checkDocument({ relPath: 'x.md', text: 'nothing relevant here' }, validIds);
    assert.equal(r.resolvable, true);
    assert.equal(r.claims.length, 0);
  });

  it('a claim backed by a valid topicId anywhere in the document resolves', () => {
    const text = [
      'captured to the debt ledger rather than implemented here — see §7.',
      '...',
      '- **`b093444897a3`** (new — captured to `.audit/tech-debt.json` during this plan\'s own round 1',
    ].join('\n');
    const r = checkDocument({ relPath: 'refactor-vcs-protocol.md', text }, validIds);
    assert.equal(r.resolvable, true);
    assert.deepEqual(r.citedValidIds, ['b093444897a3']);
  });

  it('a claim with no valid topicId anywhere in the document is unresolved — the actual regression', () => {
    const text = 'etc.) — each named in the debt ledger, none blocks this work.';
    const r = checkDocument({ relPath: 'cross-skill-command-registry.md', text }, validIds);
    assert.equal(r.resolvable, false);
    assert.equal(r.claims.length, 1);
  });

  it('a claim near an unrelated commit-sha-shaped backtick token that happens not to be a valid topicId stays unresolved', () => {
    const text = [
      'etc.) — each named in the debt ledger, none blocks this work.',
      'shipped across six clusters (`67189e99` A · `87c1a19c` B).',
    ].join('\n');
    const r = checkDocument({ relPath: 'x.md', text }, validIds);
    assert.equal(r.resolvable, false);
  });
});

describe('executeCheck', () => {
  const validIds = new Set(['78e4d7aa', 'b093444897a3']);

  it('ledger unavailable: ok=true but distinctly flagged, never silently "clean"', () => {
    const docs = [{ relPath: 'a.md', text: 'each named in the debt ledger.' }];
    const r = executeCheck({ docs, ledgerAvailable: false, validTopicIds: new Set() });
    assert.equal(r.ok, true);
    assert.equal(r.ledgerAvailable, false);
    assert.equal(r.claimingDocs, 1);
    assert.equal(r.violations.length, 0);
  });

  it('ledger available, no violations: ok=true', () => {
    const docs = [
      { relPath: 'refactor-vcs-protocol.md', text: 'captured to `.audit/tech-debt.json` — `b093444897a3`.' },
      { relPath: 'unrelated.md', text: 'no claim here at all.' },
    ];
    const r = executeCheck({ docs, ledgerAvailable: true, validTopicIds: validIds });
    assert.equal(r.ok, true);
    assert.equal(r.violations.length, 0);
    assert.equal(r.claimingDocs, 1);
  });

  it('ledger available, an unresolvable claim: ok=false and the violating doc is named', () => {
    const docs = [
      { relPath: 'cross-skill-command-registry.md', text: 'each named in the debt ledger, none blocks this work.' },
      { relPath: 'refactor-vcs-protocol.md', text: 'captured to `.audit/tech-debt.json` — `b093444897a3`.' },
    ];
    const r = executeCheck({ docs, ledgerAvailable: true, validTopicIds: validIds });
    assert.equal(r.ok, false);
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].relPath, 'cross-skill-command-registry.md');
  });

  it('negative claims ("NOT in the debt ledger") are deliberately out of scope — never flagged', () => {
    const docs = [{ relPath: 'refactor-evidence-integrity.md', text: 'an unquoted header — not in the debt ledger at all.' }];
    const r = executeCheck({ docs, ledgerAvailable: true, validTopicIds: new Set() });
    assert.equal(r.ok, true);
    assert.equal(r.claimingDocs, 0);
  });
});

describe('regression: the exact registry-plan bullet before and after correction', () => {
  const validIds = new Set(['e2415fc5d226', '6a50a99f321f', '01c442ec', 'fa6e120c']); // real "layering" hits, none matching

  it('RED — the original false bullet is unresolved against a realistic ledger snapshot', () => {
    const before = [
      '- **Deferred, deliberately**: the 183-export `learning-store.mjs` barrel',
      '  (frozen surface, wrong time), the repo-wide `isCloudEnabled` call sites',
      '  outside this CLI, mechanical-wave layering findings (model-ab→audit-arms',
      '  etc.) — each named in the debt ledger, none blocks this work.',
    ].join('\n');
    const r = checkDocument({ relPath: 'cross-skill-command-registry.md', text: before }, validIds);
    assert.equal(r.resolvable, false);
  });

  it('GREEN — the corrected bullet (claim removed, correction block cites real commits/counts, no ledger claim) is not flagged', () => {
    const after = [
      '- **Deferred, deliberately**: the `learning-store.mjs` barrel (frozen',
      '  surface, wrong time), the repo-wide `isCloudEnabled` call sites outside',
      '  this CLI, mechanical-wave layering findings (model-ab→audit-arms etc.) —',
      '  none blocks this work.',
      '',
      '  > **Correction (2026-08-18).** This bullet originally closed with',
      '  > *"each named in the debt ledger."* **They were not.**',
    ].join('\n');
    const claims = findClaimLines(after);
    assert.equal(claims.length, 0, 'the corrected text must not re-trip the trigger — the false phrase now only appears quoted');
  });
});

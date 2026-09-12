import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  findClaimLines,
  extractCitedIds,
  checkDocument,
  executeCheck,
  mergeTopicIdEvidence,
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

// Regression: a claim citing a topicId that exists ONLY in the cloud store
// (never mirrored to this machine's local .audit/tech-debt.json) used to read
// as unresolvable — a false positive in the exact direction this check must
// not produce, since "unresolvable" is read as "the author overclaimed."
// Fixtures below are drawn from the real 2026-09-12 incident: three real
// topicIds (`vcs-parsing-and-rmsync-scope-hardening-audit-summary.md`) that
// existed in the cloud store but not on the machine running the check.
describe('mergeTopicIdEvidence', () => {
  it('unions local and cloud ids when both sources are available', () => {
    const r = mergeTopicIdEvidence({
      localAvailable: true, localIds: new Set(['aaaa1111']),
      cloudAvailable: true, cloudIds: new Set(['bbbb2222']),
    });
    assert.deepEqual([...r.validTopicIds].sort(), ['aaaa1111', 'bbbb2222']);
    assert.equal(r.evidenceAvailable, true);
    assert.deepEqual(r.sources, { local: true, cloud: true });
  });

  it('a cloud-only id resolves even when the local ledger is absent', () => {
    const r = mergeTopicIdEvidence({
      localAvailable: false, localIds: new Set(),
      cloudAvailable: true, cloudIds: new Set(['def2b640fe5d']),
    });
    assert.ok(r.validTopicIds.has('def2b640fe5d'));
    assert.equal(r.evidenceAvailable, true);
    assert.deepEqual(r.sources, { local: false, cloud: true });
  });

  it('local-only evidence still works when cloud was not reached', () => {
    const r = mergeTopicIdEvidence({
      localAvailable: true, localIds: new Set(['aaaa1111']),
      cloudAvailable: false, cloudIds: new Set(),
    });
    assert.deepEqual([...r.validTopicIds], ['aaaa1111']);
    assert.equal(r.evidenceAvailable, true);
    assert.deepEqual(r.sources, { local: true, cloud: false });
  });

  it('neither source available: evidenceAvailable is false, never silently "checked"', () => {
    const r = mergeTopicIdEvidence({ localAvailable: false, cloudAvailable: false });
    assert.equal(r.validTopicIds.size, 0);
    assert.equal(r.evidenceAvailable, false);
    assert.deepEqual(r.sources, { local: false, cloud: false });
  });

  it('a cloud store that was reached and returned zero entries still counts as available evidence', () => {
    // Distinguishes "checked, and the store genuinely has nothing" from "never
    // checked" — the same distinction readDebtLedger's `available` flag makes
    // for an empty-but-present local ledger.
    const r = mergeTopicIdEvidence({
      localAvailable: false, cloudAvailable: true, cloudIds: new Set(),
    });
    assert.equal(r.evidenceAvailable, true);
    assert.deepEqual(r.sources, { local: false, cloud: true });
  });
});

// executeCheck itself needs no change to consume the union — it already
// takes a plain Set. This end-to-end case pins that a claim citing a
// cloud-only id (the real failure mode above) resolves through the same
// executeCheck path the CLI calls.
describe('executeCheck — resolves via cloud-sourced evidence', () => {
  it('a claim citing a cloud-only topicId resolves once merged in', () => {
    const { validTopicIds } = mergeTopicIdEvidence({
      localAvailable: true, localIds: new Set(['unrelated0001']),
      cloudAvailable: true, cloudIds: new Set(['def2b640fe5d']),
    });
    const docs = [{
      relPath: 'vcs-parsing-and-rmsync-scope-hardening-audit-summary.md',
      text: '## Debt captured (`.audit/tech-debt.json`)\n\n| `def2b640fe5d` | out-of-scope |',
    }];
    const r = executeCheck({ docs, ledgerAvailable: true, validTopicIds });
    assert.equal(r.ok, true);
    assert.equal(r.violations.length, 0);
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

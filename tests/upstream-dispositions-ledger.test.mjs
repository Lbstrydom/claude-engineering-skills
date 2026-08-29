/**
 * @fileoverview Pure disposition schema/logic (consumer-friction-doctor plan
 * §2.4) — `parseDisposition`, `validateLedgerEntryShape`,
 * `computeDispositionDivergences`. No fs, no git, no DB.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDisposition, formatDisposition, isLegalTestDisposition,
  validateLedgerEntryShape, computeDispositionDivergences, DISPOSITION_KINDS,
  computeLedgerReconciliation, LEGACY_UNTRACKED_TRANSITION,
} from '../scripts/lib/upstream/dispositions.mjs';

describe('parseDisposition', () => {
  it('parses probe:<id>', () => {
    assert.deepEqual(parseDisposition('probe:hydration/tooling-absent'),
      { ok: true, kind: 'probe', value: 'hydration/tooling-absent' });
  });

  it('parses test:<path>', () => {
    assert.deepEqual(parseDisposition('test:tests/foo.test.mjs'),
      { ok: true, kind: 'test', value: 'tests/foo.test.mjs' });
  });

  it('splits on the FIRST colon only — an exempt reason may contain a colon', () => {
    const r = parseDisposition('exempt:reason: this is a legacy quirk');
    assert.equal(r.ok, true);
    assert.equal(r.value, 'reason: this is a legacy quirk');
  });

  it('rejects a value with no colon', () => {
    assert.equal(parseDisposition('bogus').ok, false);
  });

  it('rejects a kind outside the closed set', () => {
    assert.equal(parseDisposition('other:x').ok, false);
  });

  it('rejects an empty value', () => {
    assert.equal(parseDisposition('probe:').ok, false);
  });

  it('round-trips through formatDisposition', () => {
    for (const kind of DISPOSITION_KINDS) {
      const raw = `${kind}:some-value`;
      const parsed = parseDisposition(raw);
      assert.equal(formatDisposition(parsed), raw);
    }
  });
});

describe('isLegalTestDisposition', () => {
  const trackedFiles = new Set(['tests/foo.test.mjs', 'tests/fixtures/bar.test.mjs', 'package.json']);

  it('accepts a tracked path matching the test glob', () => {
    assert.equal(isLegalTestDisposition('tests/foo.test.mjs', { trackedFiles }).ok, true);
  });

  it('rejects an UNTRACKED path (R1-H5\'s "arbitrary existing path" bypass)', () => {
    const r = isLegalTestDisposition('tests/untracked.test.mjs', { trackedFiles });
    assert.equal(r.ok, false);
    assert.match(r.reason, /not a tracked file/);
  });

  it('rejects a tracked file that is NOT under tests/ (e.g. package.json)', () => {
    const r = isLegalTestDisposition('package.json', { trackedFiles });
    assert.equal(r.ok, false);
  });

  it('rejects tests/fixtures/** — an input to a suite, not a suite', () => {
    const r = isLegalTestDisposition('tests/fixtures/bar.test.mjs', { trackedFiles });
    assert.equal(r.ok, false);
    assert.match(r.reason, /fixtures/);
  });
});

describe('validateLedgerEntryShape', () => {
  const valid = () => ({
    schemaVersion: 1, issueId: 'aaaaaaaa-1111-2222-3333-444444444444', state: 'fixed',
    disposition: { kind: 'probe', value: 'x' }, recordedAt: new Date().toISOString(),
  });

  it('accepts a well-formed entry', () => {
    assert.deepEqual(validateLedgerEntryShape(valid()), []);
  });

  it('rejects a non-terminal state', () => {
    const e = valid(); e.state = 'open';
    assert.ok(validateLedgerEntryShape(e).length > 0);
  });

  it('rejects a missing disposition.kind', () => {
    const e = valid(); e.disposition = { value: 'x' };
    assert.ok(validateLedgerEntryShape(e).some((p) => p.includes('disposition.kind')));
  });

  it('rejects an empty disposition.value', () => {
    const e = valid(); e.disposition.value = '  ';
    assert.ok(validateLedgerEntryShape(e).some((p) => p.includes('disposition.value')));
  });

  it('rejects a disposition.value containing a NUL byte (closes round-4 audit M15)', () => {
    const e = valid(); e.disposition.value = 'real reason' + String.fromCharCode(0) + 'with a nul';
    assert.ok(validateLedgerEntryShape(e).some((p) => p.includes('control character')));
  });

  it('rejects a disposition.value containing other C0 control characters', () => {
    const e = valid(); e.disposition.value = 'reasonwith a bell';
    assert.ok(validateLedgerEntryShape(e).some((p) => p.includes('control character')));
  });

  it('accepts a disposition.value containing ordinary whitespace (tab/newline/CR)', () => {
    const e = valid(); e.disposition.value = 'reason\twith\na tab and newline\r';
    assert.deepEqual(validateLedgerEntryShape(e), []);
  });

  it('rejects a non-uuid-shaped issueId', () => {
    const e = valid(); e.issueId = 'not-an-id';
    assert.ok(validateLedgerEntryShape(e).some((p) => p.includes('issueId')));
  });

  it('rejects a malformed-but-right-length id the old loose regex accepted (round-1 audit M15)', () => {
    const e = valid(); e.issueId = 'aaaa----aaaa----aaaa----aaaa'; // 8 groups of 4, wrong shape
    assert.ok(validateLedgerEntryShape(e).some((p) => p.includes('issueId')));
  });

  it('rejects a bare 8-hex prefix (not a full uuid)', () => {
    const e = valid(); e.issueId = '96a829f8';
    assert.ok(validateLedgerEntryShape(e).some((p) => p.includes('issueId')));
  });

  it('rejects an overflowed calendar date Date.parse silently normalises (closes round-5 audit L1)', () => {
    const e = valid(); e.recordedAt = '2026-02-30T00:00:00.000Z'; // Feb has no 30th
    assert.ok(validateLedgerEntryShape(e).some((p) => p.includes('not a real calendar date')));
  });

  it('rejects an out-of-range month', () => {
    const e = valid(); e.recordedAt = '2026-13-01T00:00:00Z';
    assert.ok(validateLedgerEntryShape(e).some((p) => p.includes('not a real calendar date')));
  });

  it('accepts a real timestamp with no fractional-seconds component', () => {
    const e = valid(); e.recordedAt = '2026-01-01T00:00:00Z';
    assert.deepEqual(validateLedgerEntryShape(e), []);
  });
});

describe('computeDispositionDivergences', () => {
  const entry = (issueId, disposition) => ({
    schemaVersion: 1, issueId, state: 'fixed', disposition, recordedAt: new Date().toISOString(),
  });

  it('clean ledger against a matching registry+tracked-tests -> no divergences', () => {
    const { divergences } = computeDispositionDivergences({
      ledgerEntries: [entry('aaaaaaaa-1111-2222-3333-444444444444', { kind: 'probe', value: 'p1' })],
      registryProbeIds: ['p1'],
      trackedTestFiles: new Set(),
    });
    assert.deepEqual(divergences, []);
  });

  it('a probe: reference that does not resolve in the registry is flagged', () => {
    const { divergences } = computeDispositionDivergences({
      ledgerEntries: [entry('aaaaaaaa-1111-2222-3333-444444444444', { kind: 'probe', value: 'nonexistent' })],
      registryProbeIds: ['p1'],
      trackedTestFiles: new Set(),
    });
    assert.equal(divergences.length, 1);
    assert.match(divergences[0], /does not resolve/);
  });

  it('a test: reference to an untracked path is flagged (R1-H5)', () => {
    const { divergences } = computeDispositionDivergences({
      ledgerEntries: [entry('aaaaaaaa-1111-2222-3333-444444444444', { kind: 'test', value: 'tests/x.test.mjs' })],
      registryProbeIds: [],
      trackedTestFiles: new Set(), // NOT tracked
    });
    assert.equal(divergences.length, 1);
  });

  it('a duplicate issueId is flagged — exactly one active disposition per issue', () => {
    const dup = 'aaaaaaaa-1111-2222-3333-444444444444';
    const { divergences } = computeDispositionDivergences({
      ledgerEntries: [
        entry(dup, { kind: 'exempt', value: 'first' }),
        entry(dup, { kind: 'exempt', value: 'second' }),
      ],
      registryProbeIds: [],
      trackedTestFiles: new Set(),
    });
    assert.ok(divergences.some((d) => d.includes('duplicate issueId')));
  });

  it('a shared test: path cited 3+ times is an ADVISORY warning, never a divergence (closes R2-M1)', () => {
    const trackedTestFiles = new Set(['tests/shared.test.mjs']);
    const { divergences, sharedPathWarnings } = computeDispositionDivergences({
      ledgerEntries: [
        entry('aaaaaaaa-0000-0000-0000-000000000001', { kind: 'test', value: 'tests/shared.test.mjs' }),
        entry('aaaaaaaa-0000-0000-0000-000000000002', { kind: 'test', value: 'tests/shared.test.mjs' }),
        entry('aaaaaaaa-0000-0000-0000-000000000003', { kind: 'test', value: 'tests/shared.test.mjs' }),
      ],
      registryProbeIds: [],
      trackedTestFiles,
    });
    assert.deepEqual(divergences, []);
    assert.equal(sharedPathWarnings.length, 1);
  });

  it('an exempt: entry never cross-references anything — a non-empty reason is sufficient', () => {
    const { divergences } = computeDispositionDivergences({
      ledgerEntries: [entry('aaaaaaaa-1111-2222-3333-444444444444', { kind: 'exempt', value: 'a real reason' })],
      registryProbeIds: [],
      trackedTestFiles: new Set(),
    });
    assert.deepEqual(divergences, []);
  });

  it('sandbox-honesty: a shape-invalid entry is reported, not silently skipped', () => {
    const { divergences } = computeDispositionDivergences({
      ledgerEntries: [{ issueId: 'bad' }],
      registryProbeIds: [],
      trackedTestFiles: new Set(),
    });
    assert.equal(divergences.length, 1);
  });
});

describe('computeLedgerReconciliation (round-1 audit H2/M13 — the bidirectional reconciler)', () => {
  const dbRow = (issueId, state, disposition) => ({ issueId, state, disposition });
  const ledgerEntry = (issueId, state) => ({
    schemaVersion: 1, issueId, state, disposition: { kind: 'exempt', value: 'x' },
    recordedAt: new Date().toISOString(),
  });

  it('clean: every terminal db row has a matching ledger entry, states and disposition VALUES agree', () => {
    const id = 'aaaaaaaa-1111-2222-3333-444444444444';
    const r = computeLedgerReconciliation({
      dbRows: [dbRow(id, 'fixed', 'exempt:x')],
      ledgerEntries: [ledgerEntry(id, 'fixed')],
    });
    // Kept as a WHOLE-SHAPE assertion on purpose: it is what catches a new
    // bucket being added without anyone deciding whether the gate should block
    // on it. `otherStore` (2026-08-29, store-scoped reconciliation) is empty
    // here because neither side carries a fingerprint.
    assert.deepEqual(r, {
      missingFromLedger: [], ledgerOnly: [], stateMismatch: [], dispositionMismatch: [], needsReview: [],
      otherStore: [],
    });
  });

  it('a disposition VALUE mismatch is flagged even when state agrees (closes round-2 audit M12)', () => {
    const id = 'aaaaaaaa-1111-2222-3333-444444444444';
    // ledgerEntry() always records disposition {kind:'exempt', value:'x'} -> "exempt:x";
    // the db row here carries a DIFFERENT disposition text for the same issue+state.
    const r = computeLedgerReconciliation({
      dbRows: [dbRow(id, 'fixed', 'exempt:y')],
      ledgerEntries: [ledgerEntry(id, 'fixed')],
    });
    assert.deepEqual(r.stateMismatch, []); // state itself agrees
    assert.equal(r.dispositionMismatch.length, 1);
    assert.match(r.dispositionMismatch[0], /exempt:x.*exempt:y|exempt:y.*exempt:x/);
  });

  it('DIRECTION 1 (the originally-described one): a terminal db row with no ledger entry is flagged', () => {
    const id = 'aaaaaaaa-1111-2222-3333-444444444444';
    const r = computeLedgerReconciliation({ dbRows: [dbRow(id, 'fixed', 'exempt:x')], ledgerEntries: [] });
    assert.deepEqual(r.missingFromLedger, [id]);
  });

  it('DIRECTION 2 (GPT\'s sharper point — the ORIGINAL description missed this): a ledger entry with no matching db row is flagged', () => {
    const id = 'aaaaaaaa-1111-2222-3333-444444444444';
    const r = computeLedgerReconciliation({ dbRows: [], ledgerEntries: [ledgerEntry(id, 'fixed')] });
    assert.deepEqual(r.ledgerOnly, [id]);
  });

  it('a state mismatch between ledger and db is flagged distinctly from a missing entry', () => {
    const id = 'aaaaaaaa-1111-2222-3333-444444444444';
    const r = computeLedgerReconciliation({
      dbRows: [dbRow(id, 'wont_fix', 'exempt:x')],
      ledgerEntries: [ledgerEntry(id, 'fixed')], // ledger recorded a DIFFERENT terminal state
    });
    assert.deepEqual(r.missingFromLedger, []);
    assert.equal(r.stateMismatch.length, 1);
    assert.match(r.stateMismatch[0], /fixed.*wont_fix|wont_fix.*fixed/);
  });

  it('a row carrying the LEGACY_UNTRACKED_TRANSITION sentinel is flagged needsReview (closes M13/H11)', () => {
    const id = 'aaaaaaaa-1111-2222-3333-444444444444';
    const r = computeLedgerReconciliation({
      dbRows: [dbRow(id, 'fixed', LEGACY_UNTRACKED_TRANSITION)],
      ledgerEntries: [ledgerEntry(id, 'fixed')],
    });
    assert.deepEqual(r.needsReview, [id]);
  });

  it('a real exempt: value that merely CONTAINS the word "legacy" is NOT flagged — exact-match only', () => {
    const id = 'aaaaaaaa-1111-2222-3333-444444444444';
    const r = computeLedgerReconciliation({
      dbRows: [dbRow(id, 'fixed', 'exempt:legacy code, no probe applies')],
      ledgerEntries: [ledgerEntry(id, 'fixed')],
    });
    assert.deepEqual(r.needsReview, []);
  });
});

/**
 * Tier-1 tests for the index-side composition template + its content hash.
 * Plan: docs/plans/arch-memory-band-recalibration.md §2.1 C6.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { compose, COMPOSE_VERSION } from '../scripts/lib/symbol-index.mjs';

const SYM = {
  kind: 'function',
  symbolName: 'atomicWriteFileSync',
  filePath: 'scripts/lib/file-io.mjs',
  purposeSummary: 'Wrapper for atomic file write with optional file mode parameter.',
  signature: 'atomicWriteFileSync(filePath, data, mode)',
};

describe('compose / template shape', () => {
  it('emits `<kind> <symbolName>\\n<summary>`', () => {
    assert.equal(
      compose(SYM),
      'function atomicWriteFileSync\nWrapper for atomic file write with optional file mode parameter.',
    );
  });

  it('EXCLUDES the file path — not natural language, dilutes the summary', () => {
    // Measured 2026-07-20: dropping path+signature moved mean intent-query
    // cosine 0.7401 → 0.7944 across four probe symbols.
    assert.equal(compose(SYM).includes('scripts/lib/file-io.mjs'), false);
  });

  it('EXCLUDES the signature', () => {
    assert.equal(compose(SYM).includes('(filePath, data, mode)'), false);
  });

  it('KEEPS the symbol name — name lookup is a real use case', () => {
    // Summary-alone scored +0.0026 on intent queries but lost 0.06-0.08 on
    // name-based lookup. Keeping the name is the deliberate trade.
    assert.ok(compose(SYM).includes('atomicWriteFileSync'));
  });

  it('tolerates a missing summary without emitting `undefined`', () => {
    const out = compose({ kind: 'function', symbolName: 'foo' });
    assert.equal(out, 'function foo\n');
    assert.equal(out.includes('undefined'), false);
  });

  it('is pure — same input, same output', () => {
    assert.equal(compose(SYM), compose(SYM));
  });

  it('ignores extra fields callers still pass (duplication-detector)', () => {
    // duplication-detector.mjs:247 passes filePath + signature. Those are now
    // inert rather than a crash, so the caller needs no coordinated change.
    const withExtras = compose({ ...SYM, somethingElse: 'x' });
    const minimal = compose({ kind: SYM.kind, symbolName: SYM.symbolName, purposeSummary: SYM.purposeSummary });
    assert.equal(withExtras, minimal);
  });
});

describe('compose / COMPOSE_VERSION is a content hash (C6)', () => {
  it('is derived from the function source, not hand-maintained', () => {
    const expected = crypto.createHash('sha256').update(compose.toString()).digest('hex').slice(0, 12);
    assert.equal(COMPOSE_VERSION, expected);
  });

  it('is a stable 12-hex-char id', () => {
    assert.match(COMPOSE_VERSION, /^[0-9a-f]{12}$/);
  });

  it('changes when the template changes — the whole point', () => {
    // Simulate an edit: a different composition must hash differently, which
    // is what invalidates cached vectors and any calibration bound to the old
    // distribution. Two coupled values silently drifting apart is the defect
    // the recalibration plan exists to fix; this is the mechanical binding.
    const altered = (s) => `${s.kind} ${s.symbolName} in ${s.filePath}\n${s.purposeSummary}`;
    const alteredVersion = crypto.createHash('sha256').update(altered.toString()).digest('hex').slice(0, 12);
    assert.notEqual(COMPOSE_VERSION, alteredVersion);
  });
});

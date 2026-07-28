/**
 * @fileoverview Regression guard: a gate contract's `stated` quote must match
 * its prose file regardless of the working copy's line endings.
 *
 * The defect this pins (found 2026-07-28): `fileTextContains` compared raw
 * bytes. A `stated` quote is authored in JSON so its newlines are `\n`, but the
 * prose file is read from the WORKING COPY, which on Windows carries CRLF even
 * though `.gitattributes` pins `eol=lf` — and git reports such a file as clean,
 * so the divergence is invisible. Every multi-line `stated` quote therefore
 * failed on a Windows checkout while passing in CI, reporting "prose/contract
 * have drifted" against text that matched exactly. It blocked
 * `npm run skills:check`, and so blocked skill regeneration.
 *
 * Same class as the `skills.manifest.json` CRLF defect in AGENTS.md: anything
 * comparing or hashing file bytes against a committed artifact must
 * canonicalise CRLF→LF first.
 *
 * @module tests/gate-contract-eol
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateGateContract } from '../scripts/lib/gate-honesty/schema.mjs';

const MULTILINE_STATED = 'counts only rows the collector stamped with the\n  current EPOCH';

/** Build a throwaway repo whose prose file uses the given line ending. */
function makeFixture(eol) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-eol-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });

  const prose = ['# Doc', '', '- **Window honesty**: `comparedRuns`',
    '  counts only rows the collector stamped with the',
    '  current EPOCH. All pre-stamp rows are ineligible.', ''].join(eol);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), prose);
  fs.writeFileSync(path.join(root, 'scripts', 'impl.mjs'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(root, 'tests', 'impl.test.mjs'), '// covers gate id: window-honesty\n');
  return root;
}

const contract = {
  version: 1,
  skill: 'audit-code',
  gates: [{
    id: 'window-honesty',
    kind: 'executable',
    oracle: 'visual-gate-unverified',
    proof: 'unit-seam',
    stated: MULTILINE_STATED,
    statedIn: 'AGENTS.md',
    implementation: 'scripts/impl.mjs',
    tests: ['tests/impl.test.mjs'],
  }],
};

describe('gate-contract stated-quote matching is line-ending agnostic', () => {
  it('matches a multi-line stated quote in an LF prose file', () => {
    const root = makeFixture('\n');
    const res = validateGateContract(contract, root);
    assert.equal(res.ok, true, `LF fixture should validate, got: ${JSON.stringify(res.errors)}`);
  });

  it('matches the SAME quote when the working copy is CRLF (the regression)', () => {
    const root = makeFixture('\r\n');
    const res = validateGateContract(contract, root);
    const drift = (res.errors || []).filter((e) => /drifted/.test(e));
    assert.deepEqual(drift, [], 'CRLF working copy must not report prose/contract drift');
    assert.equal(res.ok, true);
  });

  it('still reports drift when the quote genuinely is absent', () => {
    const root = makeFixture('\r\n');
    const absent = { ...contract, gates: [{ ...contract.gates[0], stated: 'text that is simply not there' }] };
    const res = validateGateContract(absent, root);
    assert.equal(res.ok, false, 'a genuinely-missing quote must still fail');
    assert.ok((res.errors || []).some((e) => /drifted/.test(e)),
      `expected a drift error, got: ${JSON.stringify(res.errors)}`);
  });
});

/**
 * Tests for scripts/lib/audit/finding-verification.mjs — the deterministic
 * finding-verification gate.
 * Plan: docs/plans/adaptive-context-blast-radius.md — Phase 1.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFinding,
  extractCitedEntity,
  verifyExistenceFindings,
  effectiveSeverity,
  countsTowardVerdict,
  isRefuted,
} from '../scripts/lib/audit/finding-verification.mjs';

const REPO = ['scripts/lib/brainstorm/schemas.mjs', 'scripts/lib/secret-patterns.mjs', 'AGENTS.md'];

function finding(over = {}) {
  return {
    id: 'H1', severity: 'HIGH', category: 'Missing Module', section: 'scripts/brainstorm-round.mjs',
    detail: 'x', risk: 'x', recommendation: 'x', is_quick_fix: false, is_mechanical: true,
    principle: 'x', ...over,
  };
}

describe('classifyFinding', () => {
  it('matches an existence claim', () => {
    assert.equal(classifyFinding(finding({ detail: 'The module `schemas.mjs` is missing.' })), true);
    assert.equal(classifyFinding(finding({ category: 'Missing Import', detail: 'no such file' })), true);
  });
  it('does not match an ordinary finding', () => {
    assert.equal(classifyFinding(finding({ category: 'DRY Violation', detail: 'duplicated helper', section: 'x' })), false);
  });
});

describe('extractCitedEntity — anchored, not first-quoted-wins (audit H4/H5)', () => {
  it('pulls the file token adjacent to the missing-claim phrase', () => {
    const e = extractCitedEntity(finding({ detail: 'The module `scripts/lib/brainstorm/schemas.mjs` does not exist.' }));
    assert.equal(e.kind, 'file');
    assert.equal(e.name, 'scripts/lib/brainstorm/schemas.mjs');
  });
  it('picks the MISSING module, not the importer, when both are cited', () => {
    // The importer (scripts/a.mjs) exists; only the second token is the claim.
    const e = extractCitedEntity(finding({
      detail: 'In `scripts/a.mjs`, the import `scripts/lib/ghost.mjs` does not exist.',
    }));
    assert.equal(e.name, 'scripts/lib/ghost.mjs', 'anchored on the claim phrase, not first-quoted');
  });
  it('classifies a symbol token', () => {
    const e = extractCitedEntity(finding({ detail: 'The export `BrainstormEnvelopeWriteSchema` is missing.' }));
    assert.equal(e.kind, 'symbol');
  });
  it('classifies a scoped package as external (audit M7)', () => {
    const e = extractCitedEntity(finding({ category: 'Missing Dependency', detail: 'The dependency `@google/genai` is missing.' }));
    assert.equal(e.kind, 'external');
  });
});

describe('verifyExistenceFindings — the H1/H2/M2 regression', () => {
  it('REFUTES a HIGH "missing module" finding when the file exists', () => {
    const out = verifyExistenceFindings(
      [finding({ detail: 'The module `scripts/lib/brainstorm/schemas.mjs` does not exist.' })],
      { repoFiles: REPO },
    );
    const v = out[0].verification;
    assert.equal(v.verification, 'refuted');
    assert.equal(v.verdictSeverity, 'LOW');
    assert.equal(v.countsTowardVerdict, false);
    assert.equal(out[0].severity, 'HIGH', 'original severity preserved (immutable — audit M2)');
  });

  it('CONFIRMS a missing-file claim when the file genuinely does not exist', () => {
    const out = verifyExistenceFindings(
      [finding({ detail: 'The module `scripts/lib/ghost-module.mjs` does not exist.' })],
      { repoFiles: REPO },
    );
    const v = out[0].verification;
    assert.equal(v.verification, 'confirmed');
    assert.equal(v.verdictSeverity, 'HIGH', 'original severity preserved (G2)');
    assert.equal(v.countsTowardVerdict, true);
  });

  it('a missing-SYMBOL claim is requires_verification, never confirmed (audit G1)', () => {
    const out = verifyExistenceFindings(
      [finding({ category: 'Missing Symbol', detail: 'The export `SomeType` is missing.' })],
      { repoFiles: REPO },
    );
    const v = out[0].verification;
    assert.equal(v.verification, 'requires_verification');
    assert.equal(v.verdictSeverity, 'HIGH', 'severity preserved — gate must not bury a real HIGH (G2)');
    assert.equal(v.countsTowardVerdict, true);
  });

  it('symbol claims are NEVER refuted — the gate does not adjudicate symbols (audit H2)', () => {
    // A name-only "symbol exists" check is not sound proof for an
    // import/export claim, so symbol claims always requires_verification.
    const out = verifyExistenceFindings(
      [finding({ category: 'Missing Symbol', detail: 'The export `KnownSym` is missing.' })],
      { repoFiles: REPO },
    );
    assert.equal(out[0].verification.verification, 'requires_verification');
  });

  it('an external-dependency claim is requires_verification (not confirmed missing — audit M7)', () => {
    const out = verifyExistenceFindings(
      [finding({ category: 'Missing Dependency', detail: 'The dependency `@google/genai` is missing.' })],
      { repoFiles: REPO },
    );
    assert.equal(out[0].verification.verification, 'requires_verification');
    assert.match(out[0].verification.verificationReason, /external dependency/i);
  });

  it('a cited sensitive path is requires_verification and never probed (Gemini-R2-G1)', () => {
    const out = verifyExistenceFindings(
      [finding({ detail: 'The module `secrets/prod.key` does not exist.' })],
      { repoFiles: REPO },
    );
    const v = out[0].verification;
    assert.equal(v.verification, 'requires_verification');
    assert.match(v.verificationReason, /sensitive/i);
  });

  it('a relative specifier escaping the repo root is requires_verification (audit H5/M6)', () => {
    const out = verifyExistenceFindings(
      [finding({ detail: 'The file `../../etc/passwd` does not exist.' })],
      { repoFiles: REPO },
    );
    assert.equal(out[0].verification.verification, 'requires_verification');
  });

  it('does NOT confirm absence when the inventory is incomplete (audit P3-M2)', () => {
    // `confirmed` is a soundness claim — only valid against a complete
    // inventory. A subtree was unreadable → degrade to requires_verification.
    const out = verifyExistenceFindings(
      [finding({ detail: 'The module `scripts/lib/ghost-module.mjs` does not exist.' })],
      { repoFiles: REPO, inventoryComplete: false },
    );
    const v = out[0].verification;
    assert.equal(v.verification, 'requires_verification');
    assert.match(v.verificationReason, /incomplete/i);
    assert.equal(v.verdictSeverity, 'HIGH', 'severity preserved');
  });

  it('leaves a non-existence finding untouched (no verification field)', () => {
    const out = verifyExistenceFindings(
      [finding({ category: 'DRY Violation', detail: 'helper duplicated across two files', section: 'scripts/a.mjs' })],
      { repoFiles: REPO },
    );
    assert.equal(out[0].verification, undefined);
  });

  it('an existence claim with no extractable entity is requires_verification', () => {
    const out = verifyExistenceFindings(
      [finding({ category: 'Missing Module', detail: 'something is missing somewhere in the wiring' })],
      { repoFiles: REPO },
    );
    assert.equal(out[0].verification.verification, 'requires_verification');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Field regressions, wine-cellar-app 2026-08-13. Every `detail` below is the
// VERBATIM prose from a real `.audit/*-r1-result.json` finding that shipped
// as an unrefuted HIGH/MEDIUM against files that all existed. Hand-written
// fixtures encode what the reader expects; these encode what production
// actually emits (AGENTS.md, prose↔code seam).
// ─────────────────────────────────────────────────────────────────────────
describe('field regressions — absence prose the gate used to miss', () => {
  const WINE = [
    'src/services/zone/zoneChat.js', 'src/routes/cellar.js',
    'src/config/grapeColourMap.js', 'src/routes/index.js',
  ];

  it('extracts the cited path, not "from", out of "is missing FROM the inventory"', () => {
    // The predicative use of `missing`: the entity PRECEDES the keyword.
    // CLAIM_AFTER captured `from` and the gate answered
    // '"from" looks like an external dependency' — an extractor failure
    // dressed as an adjudication.
    const f = finding({
      category: '[Structure] Missing module / broken import',
      section: 'src/routes/cellar.js; planned zone/zoneChat.js',
      detail: '`src/routes/cellar.js` imports `reassignWineZone` from '
        + '`../services/zone/zoneChat.js`, but the planned `zone/zoneChat.js` module is '
        + 'missing from the repository inventory.',
    });
    const e = extractCitedEntity(f);
    assert.notEqual(e?.name, 'from', 'captured an English function word as the entity');
    assert.equal(e.kind, 'file');
    const v = verifyExistenceFindings([f], { repoFiles: WINE })[0].verification;
    assert.equal(v.verification, 'refuted');
    assert.equal(v.verdictSeverity, 'LOW');
  });

  it('resolves a cited path SUFFIX to its unique repo path', () => {
    const r = verifyExistenceFindings([finding({
      detail: 'The `zone/zoneChat.js` module is missing.',
    })], { repoFiles: WINE })[0].verification;
    assert.equal(r.verification, 'refuted');
    assert.match(r.verificationReason, /src\/services\/zone\/zoneChat\.js/);
  });

  it('an AMBIGUOUS suffix is never refuted', () => {
    const r = verifyExistenceFindings([finding({
      detail: 'The `index.js` file is missing.',
    })], { repoFiles: ['a/index.js', 'b/index.js'] })[0].verification;
    assert.equal(r.verification, 'requires_verification');
    assert.match(r.verificationReason, /more than one/i);
  });

  it('classifies PLURAL absence prose ("modules … are absent")', () => {
    assert.equal(classifyFinding(finding({
      category: '[Structure] Planned production modules missing',
      detail: 'The production modules planned for the registry-gate cutover are absent: '
        + '`src/config/grapeColourMap.js`, `src/routes/index.js`.',
    })), true);
    assert.equal(classifyFinding(finding({
      category: '[Structure] Missing contract and integration coverage',
      detail: 'None of the three planned verification files exists: '
        + '`tests/unit/contracts/a.test.js`, `tests/unit/contracts/b.test.js`.',
    })), true);
  });

  it('REFUTES a list claim when every cited path exists', () => {
    const v = verifyExistenceFindings([finding({
      severity: 'MEDIUM',
      category: '[Structure] Planned production modules missing',
      detail: 'The production modules planned for the registry-gate cutover are absent: '
        + '`src/config/grapeColourMap.js`, `src/routes/index.js`.',
    })], { repoFiles: WINE })[0].verification;
    assert.equal(v.verification, 'refuted');
    assert.equal(v.verdictSeverity, 'LOW');
    assert.equal(v.countsTowardVerdict, false);
  });

  it('CONFIRMS a list claim when no cited path exists', () => {
    const v = verifyExistenceFindings([finding({
      detail: 'None of the three planned verification files exists: '
        + '`tests/unit/contracts/a.test.js`, `tests/unit/contracts/b.test.js`.',
    })], { repoFiles: WINE })[0].verification;
    assert.equal(v.verification, 'confirmed');
    assert.equal(v.verdictSeverity, 'HIGH', 'a confirmed absence keeps the model severity');
  });

  it('a PARTLY false list claim keeps its severity and says which exist', () => {
    // The failure direction that matters: refuting here would bury the
    // members that really are absent.
    const v = verifyExistenceFindings([finding({
      detail: 'The planned modules are absent: `src/routes/index.js`, `src/nope/gone.js`.',
    })], { repoFiles: WINE })[0].verification;
    assert.equal(v.verification, 'requires_verification');
    assert.equal(v.verdictSeverity, 'HIGH');
    assert.match(v.verificationReason, /1 of 2 cited path\(s\) DO exist/);
    assert.match(v.verificationReason, /src\/routes\/index\.js/);
  });

  it('a list claim does not confirm absence against an INCOMPLETE inventory', () => {
    const v = verifyExistenceFindings([finding({
      detail: 'The planned modules are absent: `x/a.js`, `x/b.js`.',
    })], { repoFiles: WINE, inventoryComplete: false })[0].verification;
    assert.equal(v.verification, 'requires_verification');
  });

  it('a sensitive path inside a LIST is still never probed', () => {
    const v = verifyExistenceFindings([finding({
      detail: 'The planned modules are absent: `src/routes/index.js`, `.env.production`.',
    })], { repoFiles: WINE })[0].verification;
    assert.equal(v.verification, 'requires_verification', 'must not confirm or refute a secret path');
  });

  it('still leaves ordinary findings alone (negative control)', () => {
    const out = verifyExistenceFindings([
      finding({ category: 'Perf', detail: 'The loop is quadratic over `src/routes/index.js`.' }),
      finding({ category: 'Naming', detail: 'These helpers are absent-minded about errors.' }),
    ], { repoFiles: WINE });
    assert.equal(out[0].verification, undefined);
    assert.equal(out[1].verification, undefined);
  });
});

describe('effectiveSeverity / countsTowardVerdict — the single read accessor', () => {
  it('reports the verdict severity for a refuted finding, not the model claim', () => {
    const v = verifyExistenceFindings([finding({
      detail: 'The module `scripts/lib/secret-patterns.mjs` is missing.',
    })], { repoFiles: REPO })[0];
    assert.equal(v.severity, 'HIGH', 'the model claim stays immutable (audit M2)');
    assert.equal(effectiveSeverity(v), 'LOW');
    assert.equal(countsTowardVerdict(v), false);
    assert.equal(isRefuted(v), true);
  });
  it('passes an ungated finding straight through', () => {
    const f = finding({ category: 'DRY', detail: 'duplicated' });
    assert.equal(effectiveSeverity(f), 'HIGH');
    assert.equal(countsTowardVerdict(f), true);
    assert.equal(isRefuted(f), false);
  });
});

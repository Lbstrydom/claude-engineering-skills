/**
 * @fileoverview Grounding check, pinned to the REAL dismissal corpus.
 *
 * Every fixture below is a verbatim `detail_snapshot` from a shadow-only
 * finding this repo actually dismissed on 2026-07-27, with the disposition
 * that was recorded at the time. That matters: a synthetic fixture would let
 * the patterns be tuned to themselves. These are the cases the check exists
 * to catch, and the negative control is a finding that was dismissed for a
 * reason this check must NOT claim to detect.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAbsenceClaims, extractIdentifiers, extractPaths,
  checkFindingGrounding, formatGroundingNote,
} from '../scripts/lib/audit/finding-grounding.mjs';

// ── Verbatim detail_snapshots (Shape A: "X is missing" where X is present) ──
const F_92b2be1e = "The plan's scope-resolution rule accepts a call site ONLY if the object identifier's binding declaration is an ImportDefaultSpecifier/ImportNamespaceSpecifier of 'node:fs'/'fs'. Babel's scope.getBinding() returns undefined for identifiers with NO binding in scope. The plan never states what happens when getBinding() returns undefined or when binding.path is null.";

const F_1cbc4f21 = "The plan specifies `spawnSync('git', ['diff','--name-status','-z', sinceCommit], ...)` but never states that `sinceCommit` must pass isSafeGitRevision() before reaching argv. vcs.mjs already exports isSafeGitRevision precisely for this, yet the plan's rewrite of this call site is silent on validation.";

const F_23779b67 = "The module acquires/releases a lock (acquireLock/releaseLock from file-store.mjs) around recovery and transaction work. The plan does not state whether the new early-return happens before or after lock acquisition, nor that the lock is released on this path.";

// ── Negative control: dismissed, but NOT for a grounding failure ────────────
// dc7b1c0c was a genuine judgement disagreement — a real observation about
// indistinguishable failure modes, judged not actionable. It makes no absence
// claim about the artifact. If this check ever flags it, the patterns have
// drifted into flagging analysis rather than absence assertions.
const F_dc7b1c0c = "The epoch gate makes stale-contract rows ineligible, which correctly fixes the five-false-green series on the READ side. The epoch counter therefore protects against rows that are stale, but not against rows that are MISSING — a cloud insert failure now produces an under-count that is indistinguishable from 'the window is still filling'. Both failure modes end in the same operator action.";

describe('extractAbsenceClaims — detects the assertion, not the analysis', () => {
  it('catches "never states" (92b2be1e)', () => {
    const claims = extractAbsenceClaims(F_92b2be1e);
    assert.ok(claims.length > 0, 'should find an absence claim');
    assert.ok(claims.some((c) => c.subjects.includes('getBinding')), 'should carry getBinding as a subject');
  });

  it('catches "never states" + "is silent on" (1cbc4f21)', () => {
    const claims = extractAbsenceClaims(F_1cbc4f21);
    assert.ok(claims.length > 0);
    assert.ok(claims.some((c) => c.subjects.includes('isSafeGitRevision')));
  });

  it('carries a subject named in the PRECEDING sentence (23779b67)', () => {
    // The symbol is introduced in the setup sentence; the claim is the next
    // one. A sentence-local scope would miss this — several real findings
    // are shaped this way.
    const claims = extractAbsenceClaims(F_23779b67);
    assert.ok(claims.length > 0);
    assert.ok(
      claims.some((c) => c.subjects.includes('releaseLock') || c.subjects.includes('acquireLock')),
      'should pull the lock symbols from the prior sentence'
    );
  });

  it('does NOT flag a judgement disagreement — the negative control (dc7b1c0c)', () => {
    assert.deepEqual(extractAbsenceClaims(F_dc7b1c0c), []);
  });

  it('ignores an absence claim with no code subject — nothing to verify', () => {
    // "The plan does not state the rollout order." names no identifier, so
    // there is no grep to run. Emitting a claim with zero subjects would
    // produce a note that cannot cite evidence.
    assert.deepEqual(extractAbsenceClaims('The plan does not state the rollout order.'), []);
  });
});

describe('extractIdentifiers / extractPaths', () => {
  it('pulls identifiers out of backticked spans and call shapes', () => {
    const ids = extractIdentifiers('the `binding.path` check and getBinding() handling');
    assert.ok(ids.includes('binding.path'));
    assert.ok(ids.includes('getBinding'));
  });

  it('skips sub-4-char noise that would match everything', () => {
    assert.ok(!extractIdentifiers('`fs` and `it`').includes('fs'));
  });

  it('finds the files a finding names', () => {
    const paths = extractPaths('scripts/lib/vcs.mjs — gitDiffWithWorkingTree (§4)');
    assert.deepEqual(paths, ['scripts/lib/vcs.mjs']);
  });
});

describe('checkFindingGrounding — the disconfirming lookup', () => {
  it('contests an absence claim when the named file already has the symbol', () => {
    const res = checkFindingGrounding({
      detail: F_1cbc4f21,
      primaryFile: 'scripts/lib/vcs.mjs — gitDiffWithWorkingTree (§4 File-Level Plan)',
      readFile: (p) => (p === 'scripts/lib/vcs.mjs'
        ? 'export function gitDiffWithWorkingTree(cwd, sinceCommit) {\n  if (!isSafeGitRevision(sinceCommit)) return bad();\n}'
        : null),
    });
    assert.equal(res.contested.length > 0, true);
    const hit = res.contested.find((c) => c.subject === 'isSafeGitRevision');
    assert.ok(hit, 'should cite isSafeGitRevision as already present');
    assert.equal(hit.line, 2);
    assert.match(hit.evidence, /isSafeGitRevision/);
  });

  it('stays silent when the symbol genuinely is absent — the finding may be right', () => {
    // The file must contain NONE of the claim's subjects. An earlier version
    // of this fixture echoed `sinceCommit`/`spawnSync` back from the claim and
    // so could never have failed — the check dutifully found them and the test
    // caught its own dishonesty.
    const res = checkFindingGrounding({
      detail: F_1cbc4f21,
      primaryFile: 'scripts/lib/vcs.mjs',
      readFile: () => 'export function unrelated(a, b) {\n  return a + b;\n}',
    });
    assert.deepEqual(res.contested, []);
    assert.equal(formatGroundingNote(res), '', 'a clean finding gets NO note, not a reassuring one');
  });

  it('requires a whole-identifier match, never a substring', () => {
    // `path` inside `pathname` is not evidence that `binding.path` is handled.
    const res = checkFindingGrounding({
      detail: 'The plan never states what happens when `binding.path` is null.',
      primaryFile: 'x.mjs',
      readFile: () => 'const pathname = req.pathname;',
    });
    assert.deepEqual(res.contested, []);
  });

  it('tolerates an unreadable file rather than throwing mid-review', () => {
    const res = checkFindingGrounding({
      detail: F_92b2be1e,
      primaryFile: 'scripts/lib/find-rmsync-sites.mjs',
      readFile: () => { throw new Error('EACCES'); },
    });
    assert.deepEqual(res.filesSearched, []);
    assert.deepEqual(res.contested, []);
  });

  it('bounds how many files it will read per finding', () => {
    const many = Array.from({ length: 20 }, (_, i) => `a${i}.mjs`).join(' ');
    const seen = [];
    checkFindingGrounding({
      detail: `The plan never states what happens when getBinding() fails. ${many}`,
      primaryFile: '',
      readFile: (p) => { seen.push(p); return 'getBinding'; },
      maxFiles: 3,
    });
    assert.equal(seen.length, 3);
  });
});

describe('formatGroundingNote', () => {
  it('is advisory and says verify — never "dismiss"', () => {
    const note = formatGroundingNote({
      contested: [{ claim: 'x', subject: 'isSafeGitRevision', file: 'scripts/lib/vcs.mjs', line: 2, evidence: 'if (!isSafeGitRevision(x))' }],
    });
    assert.match(note, /scripts\/lib\/vcs\.mjs:2/);
    assert.match(note, /Verify before accepting/);
    assert.doesNotMatch(note, /dismiss|suppress|reject/i);
  });
});

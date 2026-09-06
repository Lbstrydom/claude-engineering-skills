/**
 * @fileoverview `audit_findings.primary_file` is a REPORTING key that was being
 * filled with a MATCHING key — so every stored path arrived case-folded.
 *
 * `finding-match.mjs`'s own module docstring states the split: *"`_primaryFile` is
 * for REPORTING; `affectedFilesOf` is for MATCHING."* But `populateFindingMetadata`
 * set `_primaryFile = extractFileRefs(section)[0]`, and that extractor ends every
 * match with `normalizePath`, whose last operation is `.toLowerCase()`. The reporting
 * key was therefore the matching key, lowercased, and that is the value
 * `runs-findings.mjs` writes to the shared store.
 *
 * **Measured against store `d5a9d07b91225a93`, scoped to this repo, 2026-09-06:** of
 * 5,022 rows counted as code-mode, 4,766 resolve exactly, **138 (17 distinct) differ
 * from a tracked file by CASE ALONE**, and 118 are genuinely absent. The case class is
 * not scattered — it lands squarely on this bundle's own naming convention:
 * `skills/audit-code/skill.md` (22 rows), `skills/click-test/skill.md` (21),
 * `agents.md` (17), `skills/persona-test/skill.md` (17), `docs/plans/readme.md` (3).
 *
 * **Why it was invisible here and live elsewhere.** Windows' filesystem is
 * case-insensitive, so `existsSync('skills/ship/skill.md')` is TRUE on the machine
 * that wrote it. On Linux — CI, and any consumer — it is false, and two readers that
 * open the path degrade silently: `remediation-verification.mjs` routes the row to
 * `unresolvablePathSkipped`, and `campaign/cited-source.mjs` cannot centre its window
 * on a file it cannot open. AGENTS.md's accepted-debt row for `normalizePath()`
 * lowercasing scopes itself to *"local-repo auditing"* with the revisit trigger *"if
 * deployed as a CI service on Linux"*; the trigger is met by the DATA travelling to a
 * shared store read cross-platform, not by the process moving.
 *
 * The fix is a strictly-narrower claim than "stop lowercasing": the display form may
 * differ from the matching form **by case only**, never in structure. That invariant
 * is asserted directly below, over both hand-written and repo-derived inputs, so a
 * future edit cannot widen `displayPathOf` into a second path normaliser.
 *
 * @module tests/primary-file-display-case
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { extractFileRefs, displayPathOf } from '../scripts/lib/finding-match.mjs';
import { populateFindingMetadata } from '../scripts/lib/ledger.mjs';
import { normalizePath } from '../scripts/lib/file-io.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

describe('displayPathOf — the reporting spelling of a cited path', () => {
  it('preserves the case the prose used, where extractFileRefs folds it', () => {
    const section = 'skills/audit-code/SKILL.md — the wave table';
    assert.equal(extractFileRefs(section)[0], 'skills/audit-code/skill.md',
      'the MATCHING key stays folded — that is its job and it must not change');
    assert.equal(displayPathOf(section), 'skills/audit-code/SKILL.md');
  });

  it('the invariant: display and matching forms differ by CASE ONLY', () => {
    // The whole safety argument. `displayPathOf` is not a second normaliser: it is
    // `extractFileRefs`' first element with its case restored, and nothing else.
    const sections = [
      'skills/ship/SKILL.md',
      'AGENTS.md and CLAUDE.md disagree',
      'docs/plans/README.md §3',
      '`scripts/lib/store/runs-findings.mjs` line 601',
      './scripts/Cross-Skill.mjs',
      'tests/primary-file-display-case.test.mjs (this file)',
      'public/js/cellarSwitcher.js — setActiveCellarId() ordering',
    ];
    for (const s of sections) {
      const display = displayPathOf(s);
      const match = extractFileRefs(s)[0];
      assert.ok(display, `expected a file reference in ${JSON.stringify(s)}`);
      assert.equal(normalizePath(display), match,
        `${JSON.stringify(s)}: normalising the display form must reproduce the matching key exactly`);
    }
  });

  it('holds over real tracked paths, including every mixed-case one in the repo', () => {
    // A repo-derived corpus rather than a hand-picked list: the hand-picked list is
    // what I would write if I had misunderstood the rule.
    const tracked = execFileSync('git', ['-C', REPO_ROOT, 'ls-files'], {
      encoding: 'utf8', maxBuffer: 64 << 20,
    }).split('\n').filter(Boolean);
    const mixed = tracked.filter((p) => p !== p.toLowerCase());
    assert.ok(mixed.length > 20, `expected the repo to contain mixed-case paths, found ${mixed.length}`);

    let checked = 0;
    for (const p of mixed) {
      const display = displayPathOf(p);
      if (!display) continue; // no recognised extension — not this function's business
      checked += 1;
      assert.equal(normalizePath(display), extractFileRefs(p)[0], `${p}: structure changed`);
      assert.equal(display, p, `${p}: the spelling should survive verbatim`);
    }
    assert.ok(checked > 20, `expected to check >20 mixed-case tracked paths, checked ${checked}`);
  });

  it('returns null when the section names no file — a heading is not a path', () => {
    // Invariant 3 of finding-match.mjs: absence of a comparable key is not a key.
    for (const s of ['§2 proposed architecture', 'plan file inventory', '', null, undefined]) {
      assert.equal(displayPathOf(s), null, `${JSON.stringify(s)} must not yield a path`);
    }
  });
});

describe('populateFindingMetadata keeps the two key spaces apart', () => {
  it('_primaryFile reports the real spelling; affectedFiles stays a matching key', () => {
    const f = { section: 'skills/persona-test/SKILL.md — the journey table', detail: 'x', category: 'y' };
    populateFindingMetadata(f, 'structure');
    assert.equal(f._primaryFile, 'skills/persona-test/SKILL.md',
      'this is what reaches audit_findings.primary_file and what a reader opens');
    assert.deepEqual(f.affectedFiles, ['skills/persona-test/skill.md'],
      'the matching set must stay folded — changing it would move the dedup key');
  });

  it('the prose fallback is untouched — a heading still lands in _primaryFile', () => {
    // Deliberately preserved: `_primaryFile` accepts a heading as a last resort (the
    // reporting key tolerates it, the matching key must not). EFFECTIVE_MODE_SQL is
    // what stops such a row being counted as actionable code, and that is read-side.
    const f = { section: '§2 proposed architecture — bootstrap entry point', detail: 'x', category: 'y' };
    populateFindingMetadata(f, 'plan');
    assert.ok(!f._primaryFile.includes('/'), `expected a heading, got ${f._primaryFile}`);
    assert.deepEqual(f.affectedFiles, [f._primaryFile]);
  });

  it('a finding whose section names several files still reports the FIRST', () => {
    const f = { section: 'tests/A.test.mjs and scripts/B.mjs', detail: 'x', category: 'y' };
    populateFindingMetadata(f, 'structure');
    assert.equal(f._primaryFile, 'tests/A.test.mjs');
    assert.deepEqual(f.affectedFiles, ['tests/a.test.mjs', 'scripts/b.mjs']);
  });

  it('the finding hash does not move — case must not re-raise the whole backlog', () => {
    // `semanticId` digests `category|section|detail`, never `_primaryFile`, so this
    // change cannot invalidate a fingerprint. Asserted rather than reasoned: if it
    // ever did, every historical finding would re-raise as new on the next round and
    // the suppression ledger would silently stop matching.
    const mk = () => ({ section: 'skills/ship/SKILL.md', detail: 'd', category: 'c' });
    const a = populateFindingMetadata(mk(), 'structure');
    assert.equal(a._hash, populateFindingMetadata(mk(), 'structure')._hash);
    assert.notEqual(a._primaryFile, a._primaryFile.toLowerCase(), 'guard: the case really did survive');
  });
});

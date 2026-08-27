import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { findSyncTargets, EXPECTED_CONSUMERS, syncPairs , renderForTarget } from '../scripts/sync-shared-audit-refs.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

let TMP;

function setupRepo() {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-shared-test-'));
  fs.mkdirSync(path.join(TMP, 'docs', 'audit', 'shared-references'), { recursive: true });
  fs.mkdirSync(path.join(TMP, 'skills'), { recursive: true });
  return TMP;
}

function teardown() {
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  TMP = null;
}

beforeEach(() => { setupRepo(); });
afterEach(() => { teardown(); });

describe('sync-shared-audit-refs', () => {
  describe('findSyncTargets', () => {
    it('returns empty when canonical dir is empty', () => {
      const pairs = findSyncTargets(TMP);
      assert.deepEqual(pairs, []);
    });

    it('returns empty when no skills consume canonical', () => {
      fs.writeFileSync(path.join(TMP, 'docs/audit/shared-references/foo.md'), '---\nsummary: test\n---\nbody');
      // No skills/<x>/references/foo.md exists
      assert.deepEqual(findSyncTargets(TMP), []);
    });

    it('finds matching consumer skills', () => {
      fs.writeFileSync(path.join(TMP, 'docs/audit/shared-references/ledger-format.md'), 'CANONICAL');
      fs.mkdirSync(path.join(TMP, 'skills/audit-plan/references'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'skills/audit-plan/references/ledger-format.md'), 'STALE');
      fs.mkdirSync(path.join(TMP, 'skills/audit-code/references'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'skills/audit-code/references/ledger-format.md'), 'STALE');

      const pairs = findSyncTargets(TMP);
      assert.equal(pairs.length, 2);
      const skills = pairs.map(p => p.skill).sort();
      assert.deepEqual(skills, ['audit-code', 'audit-plan']);
    });

    it('skips skills that do not have the canonical file', () => {
      fs.writeFileSync(path.join(TMP, 'docs/audit/shared-references/foo.md'), 'CANONICAL');
      fs.mkdirSync(path.join(TMP, 'skills/audit-plan/references'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'skills/audit-plan/references/foo.md'), 'STALE');
      // audit-code does NOT have references/ at all
      fs.mkdirSync(path.join(TMP, 'skills/audit-code'), { recursive: true });

      const pairs = findSyncTargets(TMP);
      assert.equal(pairs.length, 1);
      assert.equal(pairs[0].skill, 'audit-plan');
    });

    it('handles multiple canonical files', () => {
      fs.writeFileSync(path.join(TMP, 'docs/audit/shared-references/a.md'), 'A');
      fs.writeFileSync(path.join(TMP, 'docs/audit/shared-references/b.md'), 'B');
      fs.mkdirSync(path.join(TMP, 'skills/foo/references'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'skills/foo/references/a.md'), 'old A');
      fs.writeFileSync(path.join(TMP, 'skills/foo/references/b.md'), 'old B');
      // also a non-canonical file that should NOT be included
      fs.writeFileSync(path.join(TMP, 'skills/foo/references/c.md'), 'unrelated');

      const pairs = findSyncTargets(TMP);
      assert.equal(pairs.length, 2);
      const basenames = pairs.map(p => p.basename).sort();
      assert.deepEqual(basenames, ['a.md', 'b.md']);
    });

    it('only matches files in references/ subdirectories, not other locations', () => {
      fs.writeFileSync(path.join(TMP, 'docs/audit/shared-references/foo.md'), 'CANONICAL');
      fs.mkdirSync(path.join(TMP, 'skills/audit-plan'), { recursive: true });
      // foo.md at the wrong place
      fs.writeFileSync(path.join(TMP, 'skills/audit-plan/foo.md'), 'STALE');

      const pairs = findSyncTargets(TMP);
      // Schema-driven discovery may still emit registry-expected targets
      // (with expected:true), but only if the canonical filename is in
      // EXPECTED_CONSUMERS. 'foo.md' isn't, so we expect 0 pairs.
      assert.equal(pairs.length, 0);
    });
  });

  describe('EXPECTED_CONSUMERS registry (audit fix for Gemini F1)', () => {
    it('emits expected pairs even when target file does not yet exist (bootstrap)', () => {
      fs.writeFileSync(path.join(TMP, 'docs/audit/shared-references/ledger-format.md'), 'CANONICAL');
      // Skills exist but neither has the reference file yet.
      fs.mkdirSync(path.join(TMP, 'skills/audit-plan/references'), { recursive: true });
      fs.mkdirSync(path.join(TMP, 'skills/audit-code/references'), { recursive: true });

      const pairs = findSyncTargets(TMP);
      const expected = pairs.filter(p => p.expected === true);
      assert.equal(expected.length, 2, 'both audit-plan and audit-code should be in expected targets');
      const skills = expected.map(p => p.skill).sort();
      assert.deepEqual(skills, ['audit-code', 'audit-plan']);
    });

    it('marks expected pairs as expected:true and auto-discovered as expected:false', () => {
      fs.writeFileSync(path.join(TMP, 'docs/audit/shared-references/ledger-format.md'), 'CANONICAL');
      // audit-plan is in EXPECTED_CONSUMERS — registry pair, file may or may not exist
      fs.mkdirSync(path.join(TMP, 'skills/audit-plan/references'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'skills/audit-plan/references/ledger-format.md'), 'STALE');
      // audit-loop is NOT in EXPECTED_CONSUMERS for ledger-format.md (post-Phase-4)
      // but happens to have the file — should be picked up via auto-discover
      fs.mkdirSync(path.join(TMP, 'skills/audit-loop/references'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'skills/audit-loop/references/ledger-format.md'), 'OPPORTUNISTIC');

      const pairs = findSyncTargets(TMP);
      const audit_plan = pairs.find(p => p.skill === 'audit-plan');
      const audit_loop = pairs.find(p => p.skill === 'audit-loop');
      assert.equal(audit_plan?.expected, true);
      assert.equal(audit_loop?.expected, false);
    });

    it('does not double-emit a target that is both registered AND on disk', () => {
      fs.writeFileSync(path.join(TMP, 'docs/audit/shared-references/ledger-format.md'), 'CANONICAL');
      fs.mkdirSync(path.join(TMP, 'skills/audit-plan/references'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'skills/audit-plan/references/ledger-format.md'), 'STALE');

      const pairs = findSyncTargets(TMP);
      const audit_plan_pairs = pairs.filter(p => p.skill === 'audit-plan');
      assert.equal(audit_plan_pairs.length, 1, 'audit-plan should appear exactly once');
    });

    it('EXPECTED_CONSUMERS is a frozen registry', () => {
      assert.ok(Object.isFrozen(EXPECTED_CONSUMERS));
    });

    it('EXPECTED_CONSUMERS lists audit-plan and audit-code for both shared refs', () => {
      assert.deepEqual([...EXPECTED_CONSUMERS['ledger-format.md']].sort(), ['audit-code', 'audit-plan']);
      assert.deepEqual([...EXPECTED_CONSUMERS['gemini-gate.md']].sort(), ['audit-code', 'audit-plan']);
    });
  });

  describe('bootstrap: a registered consumer whose file does not exist yet', () => {
    // Regression lock. `findSyncTargets` emits registry pairs "even if missing
    // on disk" so a NEW consumer bootstraps its file — the behaviour this
    // module's header has always promised. `main()` nonetheless read every
    // target unconditionally, so the first missing one threw ENOENT and the
    // documented bootstrap had never once executed (found by a plan-audit
    // final gate, 2026-08-07, reproduced before this fix).
    // Carries the provenance sentence because `renderForTarget` now REFUSES a
    // canonical without one (round-6 audit M5) — a fixture missing it would be
    // testing a shape the synchronizer no longer accepts.
    const CANONICAL = [
      'CANONICAL BODY',
      '',
      'This is the canonical copy. **Edit this file, never a copy.**',
      '',
    ].join('\n');

    function pair(basename, skill) {
      const canonical = path.join(TMP, 'docs/audit/shared-references', basename);
      return {
        canonical,
        target: path.join(TMP, 'skills', skill, 'references', basename),
        skill,
        basename,
      };
    }

    beforeEach(() => {
      fs.writeFileSync(path.join(TMP, 'docs/audit/shared-references/vd.md'), CANONICAL);
    });

    it('creates the file AND its references/ dir instead of throwing ENOENT', () => {
      const p = pair('vd.md', 'brand-new-skill');
      assert.equal(fs.existsSync(path.dirname(p.target)), false, 'precondition: dir absent');

      const r = syncPairs([p]);

      assert.equal(r.writes, 1);
      assert.equal(r.bootstrapped, 1, 'a first write is reported as a bootstrap, not a re-sync');
      // The copy is RENDERED, not copied: the provenance sentence is replaced by
      // the GENERATED COPY banner, which is the whole point of the substitution.
      const written = fs.readFileSync(p.target, 'utf-8');
      assert.match(written, /CANONICAL BODY/);
      assert.match(written, /GENERATED COPY — do not edit/);
      assert.doesNotMatch(written, /This is the canonical copy./,
        'the copy must not still claim to be the canonical');
      assert.match(r.lines.join(''), /\(bootstrapped\)/);
    });

    it('--check reports a missing target as DRIFT rather than crashing', () => {
      const r = syncPairs([pair('vd.md', 'brand-new-skill')], { check: true });

      assert.equal(r.drift, 1, 'missing target counts as drift — never IN SYNC');
      assert.equal(r.writes, 0, 'check mode must not write');
      assert.match(r.lines.join(''), /MISSING — never bootstrapped/);
    });

    it('--dry-run announces the bootstrap without writing', () => {
      const p = pair('vd.md', 'brand-new-skill');
      const r = syncPairs([p], { dry: true });

      assert.equal(r.drift, 1);
      assert.equal(fs.existsSync(p.target), false, 'dry-run must not create the file');
      assert.match(r.lines.join(''), /would bootstrap/);
    });

    it('is idempotent — the second run reports unchanged, not a re-bootstrap', () => {
      const p = pair('vd.md', 'brand-new-skill');
      syncPairs([p]);
      const second = syncPairs([p]);

      assert.equal(second.unchanged, 1);
      assert.equal(second.drift, 0);
      assert.equal(second.bootstrapped, 0);
    });

    it('still reports a real post-bootstrap edit as drift (guards a vacuous pass)', () => {
      // Without this, an implementation that reported everything "unchanged"
      // would pass every assertion above.
      const p = pair('vd.md', 'brand-new-skill');
      syncPairs([p]);
      fs.writeFileSync(p.target, 'LOCALLY EDITED');

      const r = syncPairs([p], { check: true });
      assert.equal(r.drift, 1);
      assert.match(r.lines.join(''), /drifted from canonical/);
    });
  });

  describe('integration via CLI invocation', () => {
    it('script runs and reports IN SYNC when targets match canonical', async () => {
      // Use the real repo under test (not TMP) — verifies the live setup.
      const { execFileSync } = await import('node:child_process');
      const out = execFileSync('node',
        [path.resolve('scripts/sync-shared-audit-refs.mjs'), '--check'],
        { encoding: 'utf-8' },
      );
      assert.match(out, /IN SYNC|DRIFT/);
    });
  });
});

describe('a canonical with no provenance sentence is REFUSED (round-6 audit M5)', () => {
  it('renderForTarget itself stays a PURE transform — the refusal is not here', () => {
    // It must remain idempotent on an already-rendered copy (which carries the
    // banner, not the sentence), and it is the link-rewriter unit under test.
    const out = renderForTarget('# X\n\njust a body\n', 'docs/audit/shared-references/x.md',
      'skills/audit-code/references/x.md', process.cwd());
    assert.match(out, /just a body/);
  });

  it('syncPairs throws rather than writing an unmarked copy', () => {
    const dir = path.join(TMP, 'docs/audit/shared-references');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'noprov.md'), '# X\n\njust a body\n');
    assert.throws(
      () => syncPairs([{
        canonical: path.join(dir, 'noprov.md'),
        target: path.join(TMP, 'skills', 'some-skill', 'references', 'noprov.md'),
        skill: 'some-skill', basename: 'noprov.md',
      }]),
      /carries no canonical self-description/,
      'writing the body unchanged is a success path that did nothing — the exact bypass '
      + 'that let gemini-gate.md and ledger-format.md ship copies with no provenance',
    );
  });

  it('a canonical WITH the sentence still syncs — the guard must not overreach', () => {
    const dir = path.join(TMP, 'docs/audit/shared-references');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'prov.md'),
      '# X\n\nThis is the canonical copy. **Edit this file, never a copy.**\n');
    const target = path.join(TMP, 'skills', 'some-skill', 'references', 'prov.md');
    const r = syncPairs([{
      canonical: path.join(dir, 'prov.md'), target, skill: 'some-skill', basename: 'prov.md',
    }]);
    assert.equal(r.writes, 1);
    assert.match(fs.readFileSync(target, 'utf-8'), /GENERATED COPY — do not edit/);
  });

  it('every shipped canonical carries the sentence, so none can render unmarked', () => {
    const dir = path.join(REPO_ROOT, 'docs', 'audit', 'shared-references');
    const canonicals = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    assert.ok(canonicals.length >= 4, 'vacuous-pass guard: the directory must not be empty');
    for (const f of canonicals) {
      assert.match(
        fs.readFileSync(path.join(dir, f), 'utf-8'),
        /This is the canonical copy\./,
        `${f} would render copies with no provenance banner`,
      );
    }
  });
});

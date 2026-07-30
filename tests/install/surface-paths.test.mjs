import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  resolveSkillTargets, receiptPath,
  globalSurfaceRoot, globalJournalPath, globalQuarantineDir,
} from '../../scripts/lib/install/surface-paths.mjs';

// Every skill-install surface is retired — see
// docs/plans/repo-scoped-skill-surfaces-and-installer.md §2 D2/D3/D3a.
//
// The reason is not that these directories are unwanted, it is that a SKILL.md's
// runner paths are a function of the DEPLOYMENT LAYOUT (`scripts/X.mjs` in the
// source repo, `scripts/.claude-skills/X.mjs` in a consumer), and this module
// copies bytes verbatim. `~/.claude/skills/` is one machine-wide directory shared
// by every repo, so no correct content for it exists at all; `.agents/skills/`
// carries the same unrewritten-path defect AND is a second discovered root
// duplicating the names in `.claude/skills/`.
describe('resolveSkillTargets — every install surface is retired', () => {
  it('throws for the retired copilot surface (docs/plans/refactor-skill-governance.md, round-1 M1)', () => {
    assert.throws(() => resolveSkillTargets('audit-loop', 'copilot', '/repo'), /retired/);
  });

  it('throws for the retired claude surface, naming the replacement', () => {
    assert.throws(
      () => resolveSkillTargets('ship', 'claude', '/repo'),
      (err) => /retired/.test(err.message)
        && /sync-to-repos|npm run sync/.test(err.message)
        && err.code === 'RETIRED_SURFACE',
    );
  });

  it('throws for the retired agents surface, naming the replacement', () => {
    assert.throws(
      () => resolveSkillTargets('ship', 'agents', '/repo'),
      (err) => /retired/.test(err.message)
        && /sync-to-repos|npm run sync/.test(err.message)
        && err.code === 'RETIRED_SURFACE',
    );
  });

  // `both` THROWS rather than returning [] — the same reasoning the copilot
  // branch already documents. A silent empty array is indistinguishable from
  // "this surface legitimately has zero targets", so a future caller would
  // inherit a silent no-op. With both member surfaces retired, `both` is a
  // request for two retired surfaces, not a request that narrows to zero.
  it('throws for both — never a silent empty array', () => {
    assert.throws(
      () => resolveSkillTargets('audit-loop', 'both', '/repo'),
      (err) => /retired/.test(err.message) && err.code === 'RETIRED_SURFACE',
    );
  });

  it('Gemini gate G1 — throws for an entirely unrecognized surface, never a silent empty array', () => {
    // The real bug: a typo like --surface claudd matched none of the
    // existing branches and fell through to []. install-skills.mjs then
    // performs zero writes and exits 0 — a broken install reported as success.
    assert.throws(() => resolveSkillTargets('ship', 'claudd', '/repo'), /unrecognized surface 'claudd'/);
  });

  it('no surface value can produce a write target', () => {
    for (const surface of ['claude', 'agents', 'copilot', 'both', 'cursor', '', undefined]) {
      assert.throws(() => resolveSkillTargets('ship', surface, '/repo'),
        `surface ${JSON.stringify(surface)} must not resolve to a target`);
    }
  });
});

// D6e — the global resolvers take an OPTIONAL explicit homeRoot.
//
// Without this, `install-skills.mjs --uninstall-legacy --home <root>` would parse
// and log an explicit root that the write engine then silently ignored, because
// transaction.mjs resolves containment through these zero-arg functions. The flag
// would be satisfied in syntax and violated in implementation.
describe('global resolvers accept an explicit homeRoot (D6e)', () => {
  // Anchored at the filesystem root, NOT os.tmpdir(): on Windows the temp dir
  // lives inside the home dir (C:\Users\<u>\AppData\Local\Temp), which would make
  // the "never leaks the real home" assertion below unsatisfiable by construction
  // rather than by defect. These are pure path joins — nothing needs to exist.
  const fake = path.join(path.parse(os.homedir()).root, 'ces-fake-home');

  it('globalSurfaceRoot honours an explicit root and defaults to os.homedir()', () => {
    assert.equal(globalSurfaceRoot(fake), path.join(fake, '.claude', 'skills'));
    assert.equal(globalSurfaceRoot(), path.join(os.homedir(), '.claude', 'skills'));
  });

  it('globalJournalPath honours an explicit root and defaults to os.homedir()', () => {
    assert.equal(globalJournalPath(fake), path.join(fake, '.audit-loop-install-txn.json'));
    assert.equal(globalJournalPath(), path.join(os.homedir(), '.audit-loop-install-txn.json'));
  });

  it('globalQuarantineDir honours an explicit root and defaults to os.homedir()', () => {
    assert.equal(globalQuarantineDir(fake), path.join(fake, '.audit-loop-install-quarantine'));
    assert.equal(globalQuarantineDir(), path.join(os.homedir(), '.audit-loop-install-quarantine'));
  });

  // The regression that matters: a resolver that ACCEPTS the argument and then
  // ignores it is exactly the failure D6e closes, and it is invisible unless
  // asserted against a root that is not the real home.
  it('an explicit root never leaks the real home directory', () => {
    for (const fn of [globalSurfaceRoot, globalJournalPath, globalQuarantineDir]) {
      assert.ok(fn(fake).startsWith(fake), `${fn.name} ignored its homeRoot argument`);
      assert.ok(!fn(fake).startsWith(os.homedir()), `${fn.name} leaked the real home`);
    }
  });
});

describe('receiptPath', () => {
  it('returns repo receipt path', () => {
    const p = receiptPath('repo', '/my/repo');
    assert.ok(p.includes('.audit-loop-install-receipt.json'));
    assert.ok(p.includes('repo'));
  });

  it('returns global receipt path in home dir', () => {
    const p = receiptPath('global', '/my/repo');
    assert.ok(p.includes('.audit-loop-install-receipt.json'));
    assert.ok(!p.includes('/my/repo'));
  });
});

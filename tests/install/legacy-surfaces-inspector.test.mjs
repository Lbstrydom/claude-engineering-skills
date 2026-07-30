/**
 * Contract tests for the retired-surface inspector.
 *
 * The two properties worth guarding are both FALSE-CLEAN properties — cases where
 * a naive implementation reports "nothing to do" while a managed tree is sitting
 * on disk:
 *   1. Reading only the global receipt misses a stale `.agents/skills/` tree,
 *      because the two surfaces are recorded at DIFFERENT receipt scopes.
 *   2. An unparseable receipt is `blocked`, never `absent`.
 *
 * Plan: docs/plans/repo-scoped-skill-surfaces-and-installer.md §2 D6c.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { inspectLegacySurfaces, describeLegacySurfaces, CLEANABLE_LEGACY_SURFACES }
  from '../../scripts/lib/install/legacy-surfaces.mjs';

// @duplicate-justification: target=tests/install/lifecycle.test.mjs:sha12 reason=deliberate test-local fixture helper. The production digest is conflict-detector.mjs::computeFileSha, which takes a PATH and returns null on any read error; these suites need the digest of an in-memory STRING before the file exists, so they cannot call it. Extracting a shared test util for a one-line expression would couple two otherwise-independent suites' fixtures — and the value it computes is pinned by the production code both suites assert against, so a drift would fail them, not hide in them.
const sha12 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

let tmp, homeRoot, repoRoot;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-legacy-'));
  homeRoot = path.join(tmp, 'home');
  repoRoot = path.join(tmp, 'repo');
  fs.mkdirSync(homeRoot, { recursive: true });
  fs.mkdirSync(repoRoot, { recursive: true });
});

afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

/** Write a managed file + return the receipt entry describing it. */
function seedGlobal(relUnderSkills, content) {
  const abs = path.join(homeRoot, '.claude', 'skills', relUnderSkills);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return { path: abs, sha: sha12(content), skill: relUnderSkills.split(/[\\/]/)[0], scope: 'global' };
}

function seedAgents(relUnderSkills, content) {
  const rel = path.join('.agents', 'skills', relUnderSkills);
  const abs = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return { path: rel.replaceAll('\\', '/'), sha: sha12(content), skill: relUnderSkills.split(/[\\/]/)[0], scope: 'repo' };
}

function writeReceiptRaw(target, managedFiles) {
  const p = target === 'global'
    ? path.join(homeRoot, '.audit-loop-install-receipt.json')
    : path.join(repoRoot, '.audit-loop-install-receipt.json');
  fs.writeFileSync(p, JSON.stringify({
    receiptVersion: 1, bundleVersion: 'test', sourceUrl: 'test',
    surface: 'claude', installedAt: new Date(0).toISOString(), managedFiles,
  }, null, 2));
  return p;
}

describe('inspectLegacySurfaces — both receipt scopes', () => {
  it('reports absent when nothing was ever installed', () => {
    const r = inspectLegacySurfaces({ homeRoot, repoRoot });
    assert.equal(r.overall, 'absent');
    assert.deepEqual(r.deletable, []);
    assert.deepEqual(describeLegacySurfaces(r), []);
  });

  it('THE false-clean guard: a stale .agents/ tree is found even when the global receipt is clean', () => {
    // Global side deliberately left empty — an inspector that reads only the
    // global receipt returns `absent` here, which is the bug.
    const m = seedAgents('ship/SKILL.md', 'agents copy');
    writeReceiptRaw('repo', [m]);

    const r = inspectLegacySurfaces({ homeRoot, repoRoot });
    assert.equal(r.overall, 'removable', 'agents surface must be inspected via the REPO receipt');
    assert.equal(r.deletable.length, 1);
    assert.ok(r.deletable[0].absPath.includes('.agents'));
  });

  it('finds the global tree via the global receipt', () => {
    const m = seedGlobal('plan/SKILL.md', 'global copy');
    writeReceiptRaw('global', [m]);
    const r = inspectLegacySurfaces({ homeRoot, repoRoot });
    assert.equal(r.overall, 'removable');
    assert.equal(r.deletable.length, 1);
  });

  it('covers both surfaces in one pass', () => {
    writeReceiptRaw('global', [seedGlobal('plan/SKILL.md', 'g')]);
    writeReceiptRaw('repo', [seedAgents('ship/SKILL.md', 'a')]);
    const r = inspectLegacySurfaces({ homeRoot, repoRoot });
    assert.equal(r.deletable.length, 2);
    assert.deepEqual(r.surfaces.map(s => s.surface).sort(), ['agents', 'claude']);
  });
});

describe('inspectLegacySurfaces — member classification fold', () => {
  // `overall` and `deletable` answer DIFFERENT questions and must not be
  // conflated (they were, in an earlier draft of this test):
  //   overall   → may an INSTALL offer to clean up? `blocked` means warn, don't offer.
  //   deletable → what may the EXPLICIT `--uninstall-legacy` command remove?
  // A modified file is never deletable, but its clean siblings still are — that
  // is precisely what makes S3a's `partial` outcome reachable. If a blocked
  // surface contributed nothing, one hand-edited file would permanently strand
  // every other managed file beside it.
  it('a modified member blocks the surface but its clean siblings stay deletable', () => {
    const clean = seedGlobal('plan/SKILL.md', 'original');
    const dirty = seedGlobal('ship/SKILL.md', 'original');
    writeReceiptRaw('global', [clean, dirty]);
    // User edits one of them after install.
    fs.writeFileSync(dirty.path, 'HAND EDITED');

    const r = inspectLegacySurfaces({ homeRoot, repoRoot });
    assert.equal(r.overall, 'blocked', 'an install must not offer to clean this automatically');
    assert.equal(r.deletable.length, 1, 'the explicit command still removes the provably-owned file');
    assert.equal(r.deletable[0].absPath, clean.path);
    assert.ok(!r.deletable.some(d => d.absPath === dirty.path), 'a modified file is never deletable');
    assert.match(describeLegacySurfaces(r).join('\n'), /modified since install/);
  });

  // The gap that made the earlier three-state definition non-exhaustive: a
  // receipt member already deleted by hand matched neither "all present and
  // unmodified" nor "modified/unreadable".
  it('a member already absent from disk is routable, not a hole', () => {
    const present = seedGlobal('plan/SKILL.md', 'here');
    const gone = seedGlobal('ship/SKILL.md', 'gone');
    writeReceiptRaw('global', [present, gone]);
    fs.rmSync(gone.path, { recursive: true, maxRetries: 3, retryDelay: 50 });

    const r = inspectLegacySurfaces({ homeRoot, repoRoot });
    assert.equal(r.overall, 'removable', 'partially-cleaned must classify, not fall through');
    assert.equal(r.deletable.length, 1);
    assert.equal(r.deletable[0].absPath, present.path);
  });

  it('every member absent folds to absent, not removable', () => {
    const gone = seedGlobal('ship/SKILL.md', 'gone');
    writeReceiptRaw('global', [gone]);
    fs.rmSync(gone.path, { recursive: true, maxRetries: 3, retryDelay: 50 });
    const r = inspectLegacySurfaces({ homeRoot, repoRoot });
    assert.equal(r.overall, 'absent');
    assert.deepEqual(r.deletable, []);
  });
});

describe('inspectLegacySurfaces — fails closed', () => {
  it('an unparseable receipt is blocked, never absent', () => {
    seedGlobal('plan/SKILL.md', 'still here');
    fs.writeFileSync(path.join(homeRoot, '.audit-loop-install-receipt.json'), '{ not json');
    const r = inspectLegacySurfaces({ homeRoot, repoRoot });
    const claude = r.surfaces.find(s => s.surface === 'claude');
    assert.equal(claude.state, 'blocked');
    assert.match(claude.blockedReason, /unreadable/);
    assert.equal(r.overall, 'blocked');
    assert.deepEqual(r.deletable, []);
  });

  it("never touches the real $HOME — roots are injected", () => {
    const r = inspectLegacySurfaces({ homeRoot, repoRoot });
    for (const s of r.surfaces) {
      assert.ok(!path.resolve(s.root).startsWith(path.resolve(os.homedir(), '.claude')),
        `surface ${s.surface} resolved into the real home`);
    }
  });

  it('a receipt entry outside the surface root is never in the delete set', () => {
    // An unrelated managed file recorded in the repo receipt (not a skill file).
    const stray = path.join(repoRoot, 'somewhere-else.txt');
    fs.writeFileSync(stray, 'x');
    writeReceiptRaw('repo', [{ path: 'somewhere-else.txt', sha: sha12('x'), scope: 'repo' }]);
    const r = inspectLegacySurfaces({ homeRoot, repoRoot });
    assert.deepEqual(r.deletable, [], 'only files under a retired surface root are deletable');
    assert.equal(r.overall, 'absent');
  });

  it('requires repoRoot rather than defaulting it', () => {
    assert.throws(() => inspectLegacySurfaces({ homeRoot }), /repoRoot is required/);
  });
});

describe('CLEANABLE_LEGACY_SURFACES descriptors', () => {
  it('declares both retired surfaces with their receipt scopes', () => {
    assert.deepEqual(CLEANABLE_LEGACY_SURFACES.map(d => [d.surface, d.scope]).sort(),
      [['agents', 'repo'], ['claude', 'global']]);
  });
});

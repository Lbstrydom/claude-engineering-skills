/**
 * @fileoverview A synced skill upstream renames or removes is RETIRED from the consumer (2026-11-24, `ship` → `ship-checked`).
 *
 * `.claude/skills/**` is TRACKED in a consumer, so before this the gc only advised it ("likely renamed upstream") and the
 * old copy stayed for ever: on Copilot both `/ship` and `/ship-checked` would then load. It now rides the same probe-gated
 * retirement as migrations. Two seams: the plan (unedited → deleted, edited → held, consumer-own → untouched), and the
 * sync's call site actually passing the prefix (a plan nobody calls with the prefix retires nothing).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { planGarbageCollection, executeGarbageCollection } from '../scripts/lib/sync-gc.mjs';
import { LAYOUT_CONSTANTS } from '../scripts/lib/sync-path-map.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const PREFIX = LAYOUT_CONSTANTS.SKILLS_DEST_PREFIX;
const base = `sha256:${'a'.repeat(64)}`;
const edited = `sha256:${'b'.repeat(64)}`;
const OLD = `${PREFIX}ship/SKILL.md`;
const NEW = `${PREFIX}ship-checked/SKILL.md`;

const plan = (disk, extra = {}) => planGarbageCollection({
  priorFiles: { [OLD]: base, [NEW]: base },
  intendedDests: new Set([NEW]),
  toolingDir: LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR,
  exists: () => true,
  probe: () => ({ state: 'present', hash: disk }),
  retirePrefixes: [LAYOUT_CONSTANTS.MIGRATIONS_DEST_PREFIX, PREFIX],
  ...extra,
});

describe('retiring a renamed synced skill', () => {
  it('the skills prefix is the consumer skill root', () => {
    assert.equal(PREFIX, '.claude/skills/');
  });

  it('unedited old copy -> deleted; the new name is still shipped and kept', () => {
    const p = plan(base);
    assert.deepEqual(p.deletions, [OLD]);
    assert.deepEqual(p.orphanedTracked, []);
  });

  it('edited old copy -> held, never deleted', () => {
    const p = plan(edited);
    assert.deepEqual(p.deletions, []);
    assert.deepEqual(p.divergedHeld, [OLD]);
  });

  it('without the skills prefix the old copy is only advised (negative control: the pre-fix behaviour)', () => {
    const p = plan(base, { retirePrefixes: [LAYOUT_CONSTANTS.MIGRATIONS_DEST_PREFIX] });
    assert.deepEqual(p.deletions, []);
    assert.deepEqual(p.orphanedTracked, [OLD]);
  });

  it("a consumer's own skill is never in the manifest, so it is never a candidate", () => {
    const p = planGarbageCollection({
      priorFiles: { [NEW]: base }, intendedDests: new Set([NEW]), toolingDir: LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR,
      exists: () => true, probe: () => ({ state: 'present', hash: base }), retirePrefixes: [PREFIX],
    });
    assert.deepEqual(p.deletions, []);
  });

  it('the sync call site passes the skills prefix to gc, and asks the executor to prune empty folders', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'sync-to-repos.mjs'), 'utf8');
    assert.match(src, /retirePrefixes:\s*\[[^\]]*LAYOUT_CONSTANTS\.SKILLS_DEST_PREFIX[^\]]*\]/);
    assert.match(src, /pruneEmptyDirsUnder:\s*\[LAYOUT_CONSTANTS\.SKILLS_DEST_PREFIX\]/);
  });
});

describe('a retired skill leaves no empty folder behind', () => {
  const mk = (root, rel, body = 'x') => {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  const contain = ({ root, relPath }) => path.join(root, ...relPath.split('/'));

  it('removes the emptied skill folder and its subfolders, never the skills root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-prune-'));
    try {
      const files = [`${PREFIX}ship/SKILL.md`, `${PREFIX}ship/references/a.md`];
      for (const f of files) mk(root, f);
      mk(root, `${PREFIX}ship-checked/SKILL.md`);
      const r = executeGarbageCollection({ root, deletions: files, contain, pruneEmptyDirsUnder: [PREFIX] });
      assert.deepEqual(r.deleted.sort(), files.sort());
      assert.deepEqual(r.prunedDirs, ['.claude/skills/ship', '.claude/skills/ship/references']);
      assert.equal(fs.existsSync(path.join(root, '.claude', 'skills', 'ship')), false);
      assert.equal(fs.existsSync(path.join(root, '.claude', 'skills', 'ship-checked', 'SKILL.md')), true);
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('keeps a folder that still holds a consumer file, and prunes nothing without the option', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-prune-'));
    try {
      mk(root, `${PREFIX}ship/SKILL.md`);
      mk(root, `${PREFIX}ship/local-notes.md`);
      const kept = executeGarbageCollection({ root, deletions: [`${PREFIX}ship/SKILL.md`], contain, pruneEmptyDirsUnder: [PREFIX] });
      assert.deepEqual(kept.prunedDirs, []);
      assert.deepEqual(kept.pruneFailed, [], 'a non-empty folder is the expected stop, not a failure');
      assert.equal(fs.existsSync(path.join(root, '.claude', 'skills', 'ship', 'local-notes.md')), true);

      mk(root, `${PREFIX}gone/SKILL.md`);
      const none = executeGarbageCollection({ root, deletions: [`${PREFIX}gone/SKILL.md`], contain });
      assert.deepEqual(none.prunedDirs, []);
      assert.equal(fs.existsSync(path.join(root, '.claude', 'skills', 'gone')), true);
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('prunes the folder of a file the consumer already removed (absent), not only of files this run deleted', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-prune-'));
    try {
      fs.mkdirSync(path.join(root, '.claude', 'skills', 'ship', 'references'), { recursive: true });
      const r = executeGarbageCollection({ root, deletions: [`${PREFIX}ship/references/a.md`], contain, pruneEmptyDirsUnder: [PREFIX] });
      assert.deepEqual(r.absent, [`${PREFIX}ship/references/a.md`]);
      assert.deepEqual(r.prunedDirs, ['.claude/skills/ship', '.claude/skills/ship/references']);
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('an unexpected rmdir error is reported in pruneFailed, never swallowed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-prune-'));
    try {
      mk(root, `${PREFIX}ship/SKILL.md`);
      const rmdir = () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; };
      const r = executeGarbageCollection({ root, deletions: [`${PREFIX}ship/SKILL.md`], contain, rmdir, pruneEmptyDirsUnder: [PREFIX] });
      assert.deepEqual(r.prunedDirs, []);
      assert.equal(r.pruneFailed.length, 1);
      assert.match(r.pruneFailed[0].reason, /^EACCES/);
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
  it('an already-missing intermediate folder does not stop the walk: the empty skill folder above it is pruned', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-prune-'));
    try {
      fs.mkdirSync(path.join(root, '.claude', 'skills', 'ship'), { recursive: true });
      const r = executeGarbageCollection({ root, deletions: [`${PREFIX}ship/references/deep/a.md`], contain, pruneEmptyDirsUnder: [PREFIX] });
      assert.deepEqual(r.prunedDirs, ['.claude/skills/ship']);
      assert.deepEqual(r.pruneFailed, []);
      assert.equal(fs.existsSync(path.join(root, '.claude', 'skills', 'ship')), false);
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

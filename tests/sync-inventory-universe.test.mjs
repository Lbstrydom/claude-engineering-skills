/**
 * @fileoverview The consumer-sync file universe is the REPO's files, not the disk's (docs/plans/verification-lessons.md 2.1a).
 *
 * `buildFileUniverse` walked the raw disk under `scripts/` and `.claude/`, so it descended into gitignored `.claude/tmp/` (and
 * `.claude/worktrees/`), where a parallel test creates and deletes whole repo copies: `walk` then died with ENOENT on a directory
 * that vanished between its listing and its descent (CI run 44830850360, tests/sync-rewriter.test.mjs), and any such path that
 * survived would have entered a consumer's bundle as if it were source. This is a Tier-3 seam (the consumer sync contract).
 *
 * The race is made deterministic by stubbing `readdirSync`: when the walk lists the planted `probe` directory, `sub` is deleted
 * first, exactly the interleaving the parallel test produces. Before the fix that is an ENOENT and the universe holds the tmp
 * path; after it the ignored directory is never listed at all. ENOENT is never caught: a vanishing OWNED directory must stay loud.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitInit, commitAll, rmrf } from './helpers/fixtures.mjs';
import { _internals } from '../scripts/lib/sync-inventory.mjs';

const { buildFileUniverse } = _internals;

describe('buildFileUniverse enumerates what the repo owns, never gitignored-untracked disk', () => {
  let root;
  const put = (rel, body = 'export {};\n') => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-universe-'));
    gitInit(root);
    put('.gitignore', '.claude/tmp/\n');
    put('scripts/a.mjs');
    put('.claude/skills/s/SKILL.md', '# s\n');
    commitAll(root, 'seed');
    put('.claude/tmp/probe/sub/x.mjs'); // untracked AND ignored
  });
  after(() => rmrf(root));

  /** A readdirSync that removes `sub` the moment `probe` is listed: the parallel test's delete, made deterministic. */
  const racingFs = () => {
    const listed = [];
    return {
      listed,
      existsSync: (p) => fs.existsSync(p),
      readdirSync: (dir, opts) => {
        listed.push(path.relative(root, dir).split(path.sep).join('/'));
        const entries = fs.readdirSync(dir, opts);
        if (path.basename(dir) === 'probe') fs.rmSync(path.join(dir, 'sub'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        return entries;
      },
    };
  };

  it('never lists an ignored-and-untracked directory, so a mid-walk delete cannot ENOENT and its paths are not in the universe', () => {
    const f = racingFs();
    const universe = buildFileUniverse({ root, fsImpl: f });
    assert.ok(universe.has('scripts/a.mjs'), 'positive control: an owned script is in the universe');
    assert.ok(universe.has('.claude/skills/s/SKILL.md'), 'positive control: an owned .claude file is in the universe');
    assert.ok(![...universe].some((p) => p.startsWith('.claude/tmp/')), 'no gitignored path enters the universe');
    assert.ok(!f.listed.some((d) => d.startsWith('.claude/tmp/')), `the ignored directory was never descended into: ${f.listed.join(', ')}`);
  });

  it('does not swallow ENOENT for an OWNED directory that vanishes mid-walk (negative control: the instrument can fail)', () => {
    put('scripts/gone/sub/y.mjs');
    commitAll(root, 'owned subtree');
    const stub = {
      existsSync: (p) => fs.existsSync(p),
      readdirSync: (dir, opts) => {
        const entries = fs.readdirSync(dir, opts);
        if (path.basename(dir) === 'gone') fs.rmSync(path.join(dir, 'sub'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        return entries;
      },
    };
    assert.throws(() => buildFileUniverse({ root, fsImpl: stub }), { code: 'ENOENT' });
  });
});

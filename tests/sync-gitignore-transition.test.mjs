/**
 * @fileoverview a5ce - the sync rewrites the managed `.gitignore` block, and `sync:pr` used to leave that edit dirty in the
 * consumer's main checkout. `classifyGitignoreTransition` decides whether the edit is the block and nothing else (so it may ride
 * in the PR); `gatherGitignoreTransition` asks real git; `planConsumerPr` acts on the answer. Every row of the plan's transition
 * table has a case, plus the directions the gate must NOT fire.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { classifyGitignoreTransition, updateManagedBlock } from '../scripts/lib/sync-gitignore.mjs';
import { planConsumerPr, gatherGitignoreTransition, SKIP_REASON } from '../scripts/lib/sync-pr.mjs';
import { spawnRunner } from '../scripts/lib/sync-base-lag.mjs';
import { RECEIPT_PATH } from '../scripts/lib/sync-receipt.mjs';

const block = (...pats) => updateManagedBlock(null, pats).content;
const insert = (existing, ...pats) => updateManagedBlock(existing, pats).content;

describe('classifyGitignoreTransition - the managed-block transition table', () => {
  it('replacing the block in place is block-only', () => {
    const head = block('.audit/', 'x/');
    assert.equal(classifyGitignoreTransition(head, insert(head, '.audit/*', 'x/')), 'block-only');
  });

  it('inserting the block into a tracked file that had none (first install) is block-only', () => {
    const head = 'node_modules/\ndist/\n';
    assert.equal(classifyGitignoreTransition(head, insert(head, '.audit/')), 'block-only');
  });

  it('a file absent from the base that consists of the block alone is block-only (new file)', () => {
    assert.equal(classifyGitignoreTransition(null, block('.audit/')), 'block-only');
  });

  it('identical texts are unchanged', () => {
    const t = block('a/');
    assert.equal(classifyGitignoreTransition(t, t), 'unchanged');
  });

  it('NEGATIVE CONTROL: a hand edit beside the block is mixed, so it is never swept into the sync PR', () => {
    const head = 'node_modules/\n';
    assert.equal(classifyGitignoreTransition(head, `${insert(head, '.audit/')}secret.env\n`), 'mixed');
    assert.equal(classifyGitignoreTransition(head, `local-only/\n${insert(head, '.audit/')}`), 'mixed');
    const withBlock = insert(head, 'a/');
    assert.equal(classifyGitignoreTransition(withBlock, `${insert(withBlock, 'b/')}tail/\n`), 'mixed');
  });

  it('NEGATIVE CONTROL: a new file with content beside the block is mixed; no block at all is mixed', () => {
    assert.equal(classifyGitignoreTransition(null, `foo/\n${block('a/')}`), 'mixed');
    assert.equal(classifyGitignoreTransition('a/\n', 'a/\nb/\n'), 'mixed');
    assert.equal(classifyGitignoreTransition(block('a/'), 'a/\n'), 'mixed', 'the block vanished');
  });

  it('duplicate, orphan and out-of-order markers on either side are invalid', () => {
    const good = block('a/');
    assert.equal(classifyGitignoreTransition('x/\n', good + good), 'invalid');
    const orphan = good.split('\n').slice(0, 2).join('\n');
    assert.equal(classifyGitignoreTransition('x/\n', orphan), 'invalid');
    assert.equal(classifyGitignoreTransition(good + good, good), 'invalid', 'a malformed HEAD side is invalid too');
  });

  it('CRLF in the working file against an LF base blob (Windows autocrlf) is still block-only', () => {
    const head = 'node_modules/\n';
    assert.equal(classifyGitignoreTransition(head, insert(head, '.audit/').replace(/\n/g, '\r\n')), 'block-only');
  });
});

const SHA = 'cb0903cfaa30eb2d3e87bd42f3f31bb1db850083';
const baseFacts = {
  consumerName: 'wine-cellar-app', manifest: { repo: 'Lbstrydom/claude-engineering-skills', commitSha: SHA },
  baseBranch: 'main', baseSha: '1e538526d0000000000000000000000000000000', currentBranch: 'main', aheadCount: 0, behindCount: 0,
  upstreamChanged: [], branchExists: false, sourceSha: SHA, sourceDirty: false,
};
const classified = (paths) => ({ ok: true, clean: paths.length === 0, syncOwned: paths.map((p) => ({ status: ' M', path: p, origPath: null })), needsReview: [], other: [], degraded: false });

describe('planConsumerPr - the .gitignore block rides only when it is the block alone', () => {
  it('a block-only edit joins the add paths, the pathspecs and the surface', () => {
    const p = planConsumerPr({ ...baseFacts, classified: classified([RECEIPT_PATH, '.claude/skills/plan/SKILL.md']), gitignoreTransition: 'block-only' });
    assert.equal(p.action, 'pr');
    assert.ok(p.addPaths.includes('.gitignore') && p.commitPathspecs.includes('.gitignore') && p.surface.includes('.gitignore'));
  });

  it('a block-only edit alone earns a PR (it was previously reported as "skip clean" with the file left dirty)', () => {
    const p = planConsumerPr({ ...baseFacts, classified: classified([RECEIPT_PATH]), gitignoreTransition: 'block-only' });
    assert.equal(p.action, 'pr');
    assert.deepEqual(p.surface, ['.gitignore']);
    const none = planConsumerPr({ ...baseFacts, classified: classified([RECEIPT_PATH]), gitignoreTransition: 'unchanged' });
    assert.equal(none.reason, SKIP_REASON.RECEIPT_ONLY, 'NEGATIVE CONTROL: an unchanged file earns nothing');
  });

  it('NEGATIVE CONTROL: mixed / invalid / unverified are NOT committed and are named under leftBehind', () => {
    for (const state of ['mixed', 'invalid', 'unverified']) {
      const p = planConsumerPr({ ...baseFacts, classified: classified([RECEIPT_PATH, '.claude/skills/plan/SKILL.md']), gitignoreTransition: state });
      assert.equal(p.action, 'pr');
      assert.ok(!p.addPaths.includes('.gitignore'), state);
      assert.ok(p.leftBehind.some((l) => l.startsWith('.gitignore (')), `${state}: ${p.leftBehind}`);
      assert.match(p.body, /\.gitignore/);
    }
  });
});

describe('gatherGitignoreTransition - on a real repository', () => {
  const git = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const repo = (gitignore) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-trans-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
    if (gitignore !== null) fs.writeFileSync(path.join(dir, '.gitignore'), gitignore);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    return { dir, sha: git(dir, 'rev-parse', 'HEAD') };
  };

  it('block inserted into a tracked file (first install) -> block-only', () => {
    const { dir, sha } = repo('node_modules/\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), insert('node_modules/\n', '.audit/'));
    assert.equal(gatherGitignoreTransition(spawnRunner, dir, sha), 'block-only');
  });

  it('a file ABSENT at the base and created as the block alone -> block-only (git answered "no such path")', () => {
    const { dir, sha } = repo(null);
    fs.writeFileSync(path.join(dir, '.gitignore'), block('.audit/'));
    assert.equal(gatherGitignoreTransition(spawnRunner, dir, sha), 'block-only');
  });

  it('a hand edit beside the block -> mixed; an untouched file -> unchanged', () => {
    const { dir, sha } = repo(block('.audit/'));
    assert.equal(gatherGitignoreTransition(spawnRunner, dir, sha), 'unchanged');
    fs.writeFileSync(path.join(dir, '.gitignore'), `${block('.audit/')}mine/\n`);
    assert.equal(gatherGitignoreTransition(spawnRunner, dir, sha), 'mixed');
  });

  it('git unable to answer (unknown base sha) -> unverified, never "unchanged"/"block-only"', () => {
    const { dir } = repo('a/\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), insert('a/\n', 'b/'));
    assert.equal(gatherGitignoreTransition(spawnRunner, dir, 'f'.repeat(40)), 'unverified');
    assert.equal(gatherGitignoreTransition(spawnRunner, dir, null), 'unverified');
  });
});

describe('a held-back .gitignore is named even when no PR is opened (audit R1 M1/M10)', () => {
  it('a skip (clean / receipt-only / bundle-differs) carries the left-uncommitted note; block-only and unchanged add none', () => {
    const clean = (gi, extra = {}) => planConsumerPr({ ...baseFacts, classified: classified([]), gitignoreTransition: gi, ...extra });
    for (const state of ['mixed', 'invalid', 'unverified']) {
      const p = clean(state);
      assert.equal(p.reason, SKIP_REASON.CLEAN, state);
      assert.match(p.detail, /\.gitignore left uncommitted/, state);
    }
    assert.match(clean('mixed', { sourceSha: 'a'.repeat(40) }).detail, /differs from the source[\s\S]*\.gitignore left uncommitted/);
    assert.match(clean('mixed', { sourceDirty: true }).detail, /could not be verified[\s\S]*\.gitignore left uncommitted/, 'CLEAN_UNVERIFIED carries it too (audit R2 M3)');
    const receiptOnly = planConsumerPr({ ...baseFacts, classified: classified([RECEIPT_PATH]), gitignoreTransition: 'mixed' });
    assert.equal(receiptOnly.reason, SKIP_REASON.RECEIPT_ONLY);
    assert.match(receiptOnly.detail, /\.gitignore left uncommitted/);
    // NEGATIVE CONTROLS: nothing to say, nothing said.
    assert.equal(clean('unchanged').detail, undefined);
    assert.equal(clean(undefined).detail, undefined);
  });
});

describe('EVERY skip rule names a held-back .gitignore (audit R4 M1)', () => {
  const cases = {
    'unclassifiable': { classified: { ok: false, error: 'git status failed' } },
    'no-manifest': { classified: classified([RECEIPT_PATH, 'x']), manifest: null },
    'not-on-base': { classified: classified([RECEIPT_PATH, 'x']), currentBranch: 'feat/x' },
    'local-commits-ahead': { classified: classified([RECEIPT_PATH, 'x']), aheadCount: 2 },
    'branch-exists': { classified: classified([RECEIPT_PATH, 'x']), branchExists: true },
    'receipt-only': { classified: classified([RECEIPT_PATH]) },
  };
  for (const [reason, over] of Object.entries(cases)) {
    it(`${reason}: the note rides on the skip; an unchanged .gitignore adds nothing`, () => {
      const held = planConsumerPr({ ...baseFacts, ...over, gitignoreTransition: 'mixed' });
      assert.equal(held.action, 'skip');
      assert.equal(held.reason, reason);
      assert.match(held.detail, /\.gitignore left uncommitted/);
      const quiet = planConsumerPr({ ...baseFacts, ...over, gitignoreTransition: 'unchanged' });
      assert.doesNotMatch(String(quiet.detail ?? ''), /\.gitignore/);
    });
  }
});

describe('an unchanged managed block is never reported block-only (final review G1)', () => {
  it('a CRLF working file against an LF base blob, block already committed -> unchanged (Windows autocrlf)', () => {
    const head = insert('node_modules/\n', '.audit/');
    assert.equal(classifyGitignoreTransition(head, head.replace(/\n/g, '\r\n')), 'unchanged');
  });

  it('blank lines moved around an UNCHANGED block are a hand edit -> mixed, never block-only', () => {
    const head = insert('node_modules/\n', '.audit/');
    assert.equal(classifyGitignoreTransition(head, `\n\n${head}\n\n`), 'mixed');
  });

  it('POSITIVE CONTROL: a genuinely changed block is still block-only, with or without CRLF', () => {
    const head = insert('node_modules/\n', '.audit/');
    const next = insert(head, '.audit/*', 'x/');
    assert.equal(classifyGitignoreTransition(head, next), 'block-only');
    assert.equal(classifyGitignoreTransition(head, next.replace(/\n/g, '\r\n')), 'block-only');
  });
});

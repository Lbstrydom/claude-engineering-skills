/**
 * @fileoverview Contracts of scripts/lib/sync-gc.mjs — what gc may delete, how
 * each deletion's outcome is recorded, and the citation advisory's tri-state.
 * Post-extraction unit tests (the black-box regressions that were red at
 * be057735 live in tests/sync-failure-accounting-e2e.test.mjs).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  planGarbageCollection, executeGarbageCollection, countCitations, carriedForFailedDeletions, mayStillExist,
} from '../scripts/lib/sync-gc.mjs';

const TOOLING = 'scripts/.claude-skills';

describe('planGarbageCollection', () => {
  const priorFiles = {
    'scripts/.claude-skills/kept.mjs': 'sha256:a',
    'scripts/.claude-skills/retired.mjs': 'sha256:b',
    'scripts/.claude-skills/../../package.json': 'sha256:c',
    'scripts/.claude-skills/./x.mjs': 'sha256:d',
    'scripts\\.claude-skills\\win.mjs': 'sha256:e',
    'docs/old-name.md': 'sha256:f',
    'docs/gone.md': 'sha256:g',
  };
  const intendedDests = new Set(['scripts/.claude-skills/kept.mjs']);
  const existsCalls = [];
  const plan = planGarbageCollection({
    priorFiles, intendedDests, toolingDir: TOOLING,
    exists: (rel) => { existsCalls.push(rel); return rel === 'docs/old-name.md'; },
  });

  it('deletes only plain tooling-dir paths no longer intended', () => {
    assert.deepEqual(plan.deletions, ['scripts/.claude-skills/retired.mjs']);
  });

  it('refuses keys that only LOOK like tooling paths — prefix is not containment', () => {
    // `../../package.json` resolves INSIDE the root, so containment alone would
    // let it delete the consumer's own package.json.
    assert.deepEqual(plan.unsafeKeys.sort(), [
      'scripts/.claude-skills/../../package.json',
      'scripts/.claude-skills/./x.mjs',
      'scripts\\.claude-skills\\win.mjs',
    ].sort());
  });

  it('advises (never deletes) a tracked orphan, and only while it exists', () => {
    assert.deepEqual(plan.orphanedTracked, ['docs/old-name.md']);
  });

  it('never pre-filters deletion candidates by existence', () => {
    assert.ok(!existsCalls.some((r) => r.startsWith(`${TOOLING}/`)),
      `exists() was asked about a deletion candidate: ${existsCalls.join(', ')}`);
  });
});

describe('executeGarbageCollection', () => {
  let tmp;
  before(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ces-gc-'))); });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('deletes, and records deleted / absent / failed per path', () => {
    const root = path.join(tmp, 'outcomes');
    fs.mkdirSync(path.join(root, TOOLING), { recursive: true });
    fs.writeFileSync(path.join(root, TOOLING, 'a.mjs'), 'a');
    fs.mkdirSync(path.join(root, TOOLING, 'dir.mjs'));   // unlink of a directory fails non-ENOENT
    fs.writeFileSync(path.join(root, TOOLING, 'dir.mjs', 'x'), 'x');
    const r = executeGarbageCollection({
      root, deletions: [`${TOOLING}/a.mjs`, `${TOOLING}/missing.mjs`, `${TOOLING}/dir.mjs`],
    });
    assert.deepEqual(r.deleted, [`${TOOLING}/a.mjs`]);
    assert.deepEqual(r.absent, [`${TOOLING}/missing.mjs`]);
    assert.deepEqual(r.failed.map((f) => f.path), [`${TOOLING}/dir.mjs`]);
    assert.equal(fs.existsSync(path.join(root, TOOLING, 'a.mjs')), false);
  });

  it('refuses to delete through a link out of the root, and the outside file survives', () => {
    const root = path.join(tmp, 'linked');
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(path.join(outside, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'lib', 'victim.mjs'), 'not yours');
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, TOOLING), 'junction');
    try {
      const r = executeGarbageCollection({ root, deletions: [`${TOOLING}/lib/victim.mjs`] });
      assert.deepEqual(r.deleted, []);
      assert.equal(r.failed.length, 1);
      assert.match(r.failed[0].reason, /^refused: /);
      assert.ok(fs.existsSync(path.join(outside, 'lib', 'victim.mjs')), 'deleted through the link');
    } finally {
      fs.rmSync(path.join(root, TOOLING), { force: true });
    }
  });

  it('never calls unlink for a refused path (injected seams)', () => {
    const unlinked = [];
    const r = executeGarbageCollection({
      root: '/r', deletions: ['scripts/.claude-skills/x.mjs'],
      contain: () => { throw new Error('nope'); },
      unlink: (p) => unlinked.push(p),
    });
    assert.deepEqual(unlinked, []);
    assert.deepEqual(r.failed, [{ path: 'scripts/.claude-skills/x.mjs', reason: 'refused: nope' }]);
  });
});

describe('mayStillExist', () => {
  const failWith = (code) => () => { throw Object.assign(new Error(code), { code }); };
  it('false only for a confirmed absence', () => {
    assert.equal(mayStillExist('/x', { stat: failWith('ENOENT') }), false);
    assert.equal(mayStillExist('/x', { stat: failWith('ENOTDIR') }), false);
  });
  it('true when inspection FAILS — "could not look" is never "gone"', () => {
    assert.equal(mayStillExist('/x', { stat: failWith('EACCES') }), true);
    assert.equal(mayStillExist('/x', { stat: failWith('EIO') }), true);
  });
  it('true for a real file, false for a dangling link (follows links)', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ces-maystill-')));
    try {
      fs.writeFileSync(path.join(dir, 'f'), 'x');
      assert.equal(mayStillExist(path.join(dir, 'f')), true);
      fs.symlinkSync(path.join(dir, 'gone'), path.join(dir, 'dangling'), 'junction');
      assert.equal(mayStillExist(path.join(dir, 'dangling')), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('carriedForFailedDeletions', () => {
  it('carries the prior entry for each failed path, and nothing it never had', () => {
    assert.deepEqual(
      carriedForFailedDeletions([{ path: 'a' }, { path: 'b' }], { a: 'sha256:1', c: 'sha256:3' }, () => true),
      { a: 'sha256:1' },
    );
  });

  it('never carries a path that no longer resolves — the manifest would claim an undelivered file', () => {
    // A dangling leaf link, or a file missing behind a refused junction:
    // carried, it trips the delivery post-condition on every later run.
    assert.deepEqual(
      carriedForFailedDeletions([{ path: 'a' }, { path: 'b' }], { a: 'sha256:1', b: 'sha256:2' }, (rel) => rel === 'b'),
      { b: 'sha256:2' },
    );
  });
});

describe('countCitations', () => {
  it('maps git grep exit 1 to zero, other failures to null-with-reason, never to zero', () => {
    const exit = (status, stderr = '') => () => { const e = new Error(`exit ${status}`); e.status = status; e.stderr = stderr; throw e; };
    assert.deepEqual(countCitations('/r', 'x.md', { run: exit(1) }), { count: 0 });
    const partial = countCitations('/r', 'x.md', { run: exit(1, 'error: unable to read docs/refs.md\n') });
    assert.equal(partial.count, null, 'a search that skipped a file cannot claim zero citations');
    assert.match(partial.reason, /incomplete search: error: unable to read docs\/refs\.md/);
    assert.deepEqual(countCitations('/r', 'x.md', { run: exit(128) }), { count: null, reason: 'git exited 128' });
    const spawnFail = () => { const e = new Error('spawn git ENOENT'); e.code = 'ENOENT'; throw e; };
    assert.deepEqual(countCitations('/r', 'x.md', { run: spawnFail }), { count: null, reason: 'ENOENT' });
  });

  it('passes the path as an argv pattern via -e — no shell, no option injection', () => {
    let seen;
    countCitations('/r', '-rf.md', { run: (file, args) => { seen = { file, args }; return ''; } });
    assert.equal(seen.file, 'git');
    assert.deepEqual(seen.args, ['grep', '-l', '-z', '-F', '-e', '-rf.md']);
  });

  it('a non-ASCII orphan does not count itself — names are compared unquoted', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ces-cite-utf8-')));
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['config', 'core.quotePath', 'true'], { cwd: root });
      fs.mkdirSync(path.join(root, 'docs'));
      fs.writeFileSync(path.join(root, 'docs', 'café.md'), 'see docs/café.md\n');
      fs.writeFileSync(path.join(root, 'a.md'), 'link: docs/café.md\n');
      execFileSync('git', ['add', '-A'], { cwd: root });
      assert.deepEqual(countCitations(root, 'docs/café.md'), { count: 1 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts real citations in a repo whose path a shell would expand, excluding the orphan itself', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), process.platform === 'win32' ? 'ces-cite-%OS%-' : 'ces-cite-$HOME-')));
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
      fs.mkdirSync(path.join(root, 'docs'));
      fs.writeFileSync(path.join(root, 'docs', 'old.md'), 'see docs/old.md\n');
      fs.writeFileSync(path.join(root, 'a.md'), 'link: docs/old.md\n');
      fs.writeFileSync(path.join(root, 'b.md'), 'unrelated\n');
      execFileSync('git', ['add', '-A'], { cwd: root });
      assert.deepEqual(countCitations(root, 'docs/old.md'), { count: 1 });
      assert.deepEqual(countCitations(root, 'docs/nothing-cites-this.md'), { count: 0 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

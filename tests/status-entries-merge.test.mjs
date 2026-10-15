/**
 * @fileoverview Through real git: why the per-entry log exists, and that it works.
 *
 * Red first. The OLD flow (two ships each insert an entry at the top of one `status.md`) is the
 * negative control — it must conflict. The NEW flow (each ship adds its own file) must merge
 * cleanly, and the merged tree must pass the conservation gate. Then the merge-fixup pin
 * (p-20261015160944-2551b): the verdict is a function of the base tree and the head tree, never of
 * whether a fixup was amended into the merge or committed after it.
 *
 * Plan: docs/plans/fleet-chips-and-merge-friction.md §12.4.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  ENTRIES_DIR, MARKER_REL, isArchivePath, isEntryRecordPath, perEntryMode,
} from '../scripts/lib/status-entry-files.mjs';
import { checkConservation } from '../scripts/lib/status-log-integrity.mjs';

const HEADER = '# Project Status Log\n\n';
const entry = (date, what) => `## ${date} — ${what}\n\nBody of ${what}.\n\n---\n`;
const BASE_LOG = HEADER + entry('2026-10-01', 'base work');

let dir;
const git = (...args) => {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.error) throw r.error;
  return r;
};
const must = (...args) => {
  const r = git(...args);
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}${r.stdout}`);
  return r.stdout.trim();
};
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const commit = (msg) => { must('add', '-A'); must('commit', '-q', '-m', msg); };

/** State at a revision, read the way the gate reads it (git show / ls-tree). */
function stateAt(rev) {
  const paths = must('ls-tree', '-r', '--name-only', rev).split('\n').filter(Boolean);
  const entries = {};
  for (const rel of paths) if (isEntryRecordPath(rel)) entries[rel] = must('show', `${rev}:${rel}`);
  const archives = {};
  for (const rel of paths) if (isArchivePath(rel)) archives[rel] = must('show', `${rev}:${rel}`);
  return { root: must('show', `${rev}:status.md`), archives, manifest: null, marker: perEntryMode(paths), entries };
}

/** State of the working tree, read from disk the way the gate reads it. */
function stateOnDisk() {
  const paths = must('ls-files', '--cached', '--others', '--exclude-standard').split('\n').filter(Boolean);
  const entries = {};
  for (const rel of paths) if (isEntryRecordPath(rel)) entries[rel] = fs.readFileSync(path.join(dir, rel), 'utf8');
  return {
    root: fs.readFileSync(path.join(dir, 'status.md'), 'utf8'), archives: {}, manifest: null,
    marker: perEntryMode(paths), entries,
  };
}

describe('the per-entry log, through git', () => {
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-merge-'));
    must('init', '-q', '-b', 'main');
    must('config', 'user.email', 'test@example.invalid');
    must('config', 'user.name', 'test');
    must('config', 'core.autocrlf', 'false');
    write('status.md', BASE_LOG);
    commit('base (legacy log)');
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  test('NEGATIVE CONTROL: two ships each inserting at the top of status.md conflict', () => {
    for (const [br, what] of [['old-a', 'ship a'], ['old-b', 'ship b']]) {
      must('checkout', '-q', '-b', br, 'main');
      write('status.md', HEADER + entry('2026-10-15', what) + BASE_LOG.slice(HEADER.length));
      commit(what);
    }
    const r = git('merge-tree', '--write-tree', 'old-a', 'old-b');
    assert.equal(r.status, 1, `expected a conflict, got exit ${r.status}: ${r.stdout}`);
    assert.match(r.stdout, /CONFLICT.*status\.md/);
  });

  test('two ships each adding an entry FILE merge cleanly, and the merged tree passes the gate', () => {
    must('checkout', '-q', 'main');
    write(MARKER_REL, '# marker\n');
    commit('cutover: per-entry marker');
    const cutover = must('rev-parse', 'HEAD');

    for (const [br, name, what] of [
      ['new-a', '2026-10-15-100000-ship-a.md', 'ship a'],
      ['new-b', '2026-10-15-100000-ship-b.md', 'ship b'],
    ]) {
      must('checkout', '-q', '-b', br, cutover);
      write(`${ENTRIES_DIR}/${name}`, entry('2026-10-15', what));
      commit(what);
    }
    const r = git('merge-tree', '--write-tree', 'new-a', 'new-b');
    assert.equal(r.status, 0, `the per-entry flow must not conflict: ${r.stdout}`);

    must('checkout', '-q', 'new-a');
    must('merge', '-q', '--no-edit', 'new-b');
    const verdict = checkConservation(stateAt(cutover), stateOnDisk());
    assert.deepEqual(verdict, { ok: true, violations: [] });
    assert.equal(Object.keys(stateOnDisk().entries).length, 2, 'both entries survive the merge');
  });

  test('a branch cut before the cutover that adds a ROOT entry trips Law 6 once merged with the marker', () => {
    // old-a is the pre-cutover shipper: its status.md gained an entry. Merging main (which carries
    // the marker) into it must put the gate on notice, with the recipe in the message.
    must('checkout', '-q', 'old-a');
    must('merge', '-q', '--no-edit', 'main');
    const base = must('rev-parse', 'main');
    const r = checkConservation(stateAt(base), stateOnDisk());
    assert.deepEqual(r.violations.map((v) => v.kind), ['root-entry-added']);
    assert.match(r.violations[0].detail, /new entry files/);
  });

  test('2551b: a merge fixup amended into the merge reads the same as one committed after it', () => {
    const base = must('rev-parse', 'main');
    const fixup = () => write(`${ENTRIES_DIR}/2026-10-15-110000-merge-fix.md`, entry('2026-10-15', 'merge fix'));
    const verdicts = [];
    for (const mode of ['amended', 'separate']) {
      must('checkout', '-q', '-B', `fix-${mode}`, 'new-a^1'); // new-a is already a merge by now: branch from its first parent
      must('merge', '-q', '--no-commit', '--no-ff', 'new-b');
      if (mode === 'amended') { fixup(); commit('merge with fixup'); }
      else { commit('merge'); fixup(); commit('fixup'); }
      verdicts.push(checkConservation(stateAt(base), stateOnDisk()));
    }
    assert.deepEqual(verdicts[0], verdicts[1]);
    assert.equal(verdicts[0].ok, true);
  });
});

describe('archive paths', () => {
  test('month files are archives; the README, entries/ and strays are not', () => {
    assert.equal(isArchivePath('docs/status/2026-08.md'), true);
    assert.equal(isArchivePath('docs/status/README.md'), false);
    assert.equal(isArchivePath(`${ENTRIES_DIR}/2026-10-16-093000-x.md`), false);
    assert.equal(isArchivePath('docs/status/rotation-manifest.json'), false);
    assert.equal(isArchivePath('status.md'), false);
  });
});

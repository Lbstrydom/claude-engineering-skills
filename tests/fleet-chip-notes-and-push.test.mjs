/**
 * @fileoverview Two chip-facing defects from the consumer report of 2026-11-15:
 *  - finding 3: the chip preamble's TURN rule said "push only when it is your turn" while participant rule 2 says "push
 *    early and often". Pushing your own branch never waits; opening a PR and taking the heavy slot do.
 *  - finding 6: a chip's note carried nothing a coordinator could compare after the PR merged. `fleet next` now prints a
 *    `stamp:` line (head commit, merge state, time) the preamble tells the chip to start every note with.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots, addBranch } from './helpers/fleet-repo.mjs';
import { setup } from './helpers/fleet-cli-harness.mjs';
import { noteStamp } from '../scripts/lib/fleet/coordination.mjs';

after(cleanupFleetRoots);

const read = (rel) => fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8');

describe('finding 3: one push rule', () => {
  const preamble = read('skills/fleet/references/chip-preamble.md');
  const rules = read('skills/fleet/references/participant-rules.md');
  it('the preamble no longer gates pushing your own branch on the turn', () => {
    const flat = preamble.replace(/\s+/g, ' ');
    assert.doesNotMatch(flat, /push only when the coordinator/i);
    assert.doesNotMatch(flat, /push the branch and open PRs ONLY when/i);
    assert.match(flat, /Pushing your own branch does NOT wait/);
    assert.match(flat, /Two things wait for the coordinator to say it is your turn: opening a PR, and taking the heavy slot/);
  });
  it('participant rule 2 says the same', () => {
    assert.match(rules.replace(/\s+/g, ' '), /This needs no turn: only opening a PR and taking the heavy slot wait for one/);
  });
});

describe('finding 6: the note stamp', () => {
  const now = new Date('2026-11-15T10:20:30Z');
  it('names head, merge state and time; never says "not merged" without complete evidence', () => {
    assert.equal(noteStamp({ id: 'c', oid: 'a'.repeat(40), state: 'working', merged: { known: true, merged: true, via: 'pr', pr: 12 } }, now),
      'c · head aaaaaaaaaaaa · PR #12 merged · working · seen 2026-11-15T10:20Z');
    assert.match(noteStamp({ id: 'c', oid: 'a'.repeat(40), state: 'working', merged: { known: true, merged: false } }, now), / · not merged · /);
    assert.match(noteStamp({ id: 'c', oid: 'a'.repeat(40), state: 'working', merged: { known: false, merged: false } }, now), / · merge state not measured · /);
    assert.match(noteStamp({ id: 'c', oid: null, state: 'working', merged: null }, now), /head not observed · merge state not measured/);
  });

  it('`fleet next` prints it, and it changes once the work merges', () => {
    const s = setup();
    const oid = addBranch(s.fx.repo, 'feat-a', { 'a/x.txt': 'x\n' });
    git(['checkout', '-q', 'feat-a'], s.fx.repo);
    assert.equal(s.f(['claim', '--id', 'feat-a', '--intent', 'a', '--paths', 'a/**']).status, 0);
    const before = s.f(['next', '--id', 'feat-a']);
    assert.equal(before.status, 0, before.stdout + before.stderr);
    assert.match(before.stdout, new RegExp(`^stamp: feat-a · head ${oid.slice(0, 12)} · merge state not measured · working · seen `, 'm'));
    git(['checkout', '-q', 'main'], s.fx.repo);
    git(['merge', '-q', '--squash', 'feat-a'], s.fx.repo);
    git(['commit', '-q', '-m', 'squash feat-a'], s.fx.repo);
    const afterMerge = s.f(['next', '--id', 'feat-a']);
    assert.match(afterMerge.stdout, /^stamp: feat-a · head [0-9a-f]{12} · squash-merged as [0-9a-f]{12} · /m);
    assert.match(s.f(['next', '--id', 'feat-a', '--json']).stdout, /"stamp":"feat-a · head /);
  });
});

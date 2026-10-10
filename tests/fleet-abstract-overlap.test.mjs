/**
 * @fileoverview /fleet — a claim overlap that exists only on names no tracked file has
 * is disclosed as a WARN, never a block (2026-10-10).
 *
 * Two agents stopped that day on `tests/*upstream*` ~ `tests/*final-review*`: the
 * intersection math is exact (the patterns DO meet, on e.g. `tests/upstream-final-review.test.mjs`),
 * but no such file existed, so neither agent could have edited the other's file. Rule: a
 * wildcard×wildcard pair no tracked file satisfies is ABSTRACT. Every "does not block" case is
 * paired with a control that blocks on the same patterns, so a predicate answering one value
 * for everything fails here.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { decideClaim, isAbstractPair, isBlockingConflict } from '../scripts/lib/fleet/overlap.mjs';
import { renderClaimVerdict } from '../scripts/lib/fleet/render.mjs';
import { cleanupFleetRoots, makeFleetRepo, runFleet, scrubbedEnv } from './helpers/fleet-repo.mjs';

after(cleanupFleetRoots);

const TRACKED = ['tests/upstream-issue-triage.test.mjs', 'tests/final-review-env-alias.test.mjs', 'scripts/lib/fleet/overlap.mjs'];
const other = (paths) => ({ session: { id: 'a', intent: 'feature a', paths, state: 'working', knownOverlaps: [] }, live: true, changedFiles: [] });
const claim = (paths) => ({ id: 'b', intent: 'feature b', paths, knownOverlaps: [] });

describe('isAbstractPair', () => {
  it('wildcard × wildcard that no tracked file satisfies is abstract', () => {
    assert.equal(isAbstractPair('tests/*upstream*', 'tests/*final-review*', TRACKED), true);
  });
  it('control: a tracked file matching BOTH makes it concrete', () => {
    assert.equal(isAbstractPair('tests/*upstream*', 'tests/*final-review*', [...TRACKED, 'tests/upstream-final-review.test.mjs']), false);
  });
  it('a literal on either side is never abstract — it names exact intent, even a file not created yet', () => {
    assert.equal(isAbstractPair('scripts/lib/fleet/**', 'scripts/lib/fleet/new-module.mjs', TRACKED), false);
    assert.equal(isAbstractPair('tests/new-upstream-final-review.test.mjs', 'tests/*final-review*', TRACKED), false);
  });
  it('identical or NESTED wildcards are concrete even with nothing tracked under them — two sessions in the same NEW area', () => {
    assert.equal(isAbstractPair('shared/**', 'shared/**', TRACKED), false, 'identical new-directory claims');
    assert.equal(isAbstractPair('lib/**', 'lib/new/*.mjs', TRACKED), false, 'one contains the other');
    assert.equal(isAbstractPair('src/new/*.mjs', 'src/new/**', TRACKED), false, 'contained either way round');
  });
  it('unknown tracked files (null) fail closed: concrete', () => {
    assert.equal(isAbstractPair('tests/*upstream*', 'tests/*final-review*', null), false);
  });
});

describe('decideClaim with trackedFiles', () => {
  it('an abstract-only overlap is a WARN, disclosed, never blocking', () => {
    const v = decideClaim({ claim: claim(['tests/*upstream*']), mode: 'new', others: [other(['tests/*final-review*'])], complete: true, trackedFiles: TRACKED });
    assert.equal(v.verdict, 'warn');
    const [c] = v.conflicts;
    assert.deepEqual([c.via, c.abstractOnly, c.abstractPaths], [['paths-abstract'], true, [['tests/*upstream*', 'tests/*final-review*']]]);
    assert.equal(isBlockingConflict(c), false);
    assert.match(renderClaimVerdict(v, {}), /\[abstract\] a: paths-abstract — patterns meet only on names no tracked file has/);
  });
  it('control: the same claim without trackedFiles BLOCKS (unchanged legacy behaviour)', () => {
    const v = decideClaim({ claim: claim(['tests/*upstream*']), mode: 'new', others: [other(['tests/*final-review*'])], complete: true });
    assert.equal(v.verdict, 'blocked');
  });
  it('two ADVISORY signals together stay advisory: abstract pair + their uncommitted edit => warn (R1-H1)', () => {
    const o = { ...other(['tests/*final-review*']), uncommittedFiles: ['tests/upstream-notes.md'] };
    const v = decideClaim({ claim: claim(['tests/*upstream*']), mode: 'new', others: [o], complete: true, trackedFiles: TRACKED });
    assert.deepEqual(v.conflicts[0].via, ['paths-abstract', 'uncommitted']);
    assert.equal(isBlockingConflict(v.conflicts[0]), false);
    assert.equal(v.verdict, 'warn');
  });
  it('mixed: one concrete pair alongside an abstract one still blocks', () => {
    const v = decideClaim({
      claim: claim(['tests/*upstream*', 'scripts/lib/fleet/*.mjs']), mode: 'new',
      others: [other(['tests/*final-review*', 'scripts/lib/fleet/**'])], complete: true, trackedFiles: TRACKED,
    });
    assert.equal(v.verdict, 'blocked');
    assert.deepEqual(v.conflicts[0].via, ['paths']);
  });
});

describe('fleet claim (CLI) — the 2026-10-10 shape', () => {
  it('a second session claiming tests/*upstream* beside tests/*final-review* registers with a WARN', () => {
    const fx = makeFleetRepo({ files: { 'tests/upstream-issue-triage.test.mjs': 'x\n', 'tests/final-review-env-alias.test.mjs': 'y\n' } });
    const env = scrubbedEnv({ FLEET_TELEMETRY: 'off' });
    const f = (args) => runFleet(args, { cwd: fx.repo, env });
    assert.equal(f(['claim', '--id', 'gemini', '--intent', 'reviewer default', '--paths', 'tests/*final-review*']).status, 0);
    const r = f(['claim', '--id', 'upstream', '--intent', 'disposition landing', '--paths', 'tests/*upstream*']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /WARN.*advisory/);
    assert.match(r.stdout, /\[abstract\] gemini/);
  });
  it('run from a SUBDIRECTORY, the tracked-file list is still the whole repo, root-relative (R2-H1)', () => {
    const fx = makeFleetRepo({ files: { 'tests/upstream-final-review.test.mjs': 'z\n', 'docs/readme.md': 'd\n' } });
    const env = scrubbedEnv({ FLEET_TELEMETRY: 'off' });
    const sub = path.join(fx.repo, 'docs');
    assert.equal(runFleet(['claim', '--id', 'gemini', '--intent', 'reviewer default', '--paths', 'tests/*final-review*'], { cwd: sub, env }).status, 0);
    const r = runFleet(['claim', '--id', 'upstream', '--intent', 'disposition landing', '--paths', 'tests/*upstream*'], { cwd: sub, env });
    assert.equal(r.status, 3, 'the tracked file matching both is seen from docs/ too, so this is concrete: ' + r.stdout + r.stderr);
  });

  it('control: once a tracked file matches both patterns, the same claim is BLOCKED (exit 3)', () => {
    const fx = makeFleetRepo({ files: { 'tests/upstream-final-review.test.mjs': 'z\n' } });
    const env = scrubbedEnv({ FLEET_TELEMETRY: 'off' });
    const f = (args) => runFleet(args, { cwd: fx.repo, env });
    assert.equal(f(['claim', '--id', 'gemini', '--intent', 'reviewer default', '--paths', 'tests/*final-review*']).status, 0);
    const r = f(['claim', '--id', 'upstream', '--intent', 'disposition landing', '--paths', 'tests/*upstream*']);
    assert.equal(r.status, 3, r.stdout + r.stderr);
  });
});

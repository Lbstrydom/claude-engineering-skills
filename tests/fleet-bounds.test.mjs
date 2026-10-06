/**
 * @fileoverview /fleet — two items the storyline-feedback audit recorded, closed here:
 *   1. claim patterns are size-bounded (the overlap DP recurses per character / segment, so an
 *      unbounded pattern was a stack overflow, not a refusal);
 *   2. `gatherFacts` computes branch evidence from the commit ids it captured, not by re-resolving
 *      the branch NAME, which another session can move (or a same-named tag can shadow).
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { git } from './helpers/git.mjs';
import {
  MAX_PATTERN_SEGMENTS, MAX_SEGMENT_CHARS, patternsIntersect, validateClaimPattern, validateClaimPatterns,
} from '../scripts/lib/fleet/overlap.mjs';
import { gatherFacts } from '../scripts/lib/fleet/facts.mjs';
import { changedFiles } from '../scripts/lib/fleet/git-facts.mjs';
import { makeFleetRepo, commitFile, cleanupFleetRoots } from './helpers/fleet-repo.mjs';

after(cleanupFleetRoots);

describe('claim pattern size bounds', () => {
  const seg = (n, ch = 'a') => ch.repeat(n);
  it('boundary: exactly the limit is accepted, one over is refused with the limit named', () => {
    assert.equal(validateClaimPattern(seg(MAX_SEGMENT_CHARS)).ok, true);
    const longSeg = validateClaimPattern(seg(MAX_SEGMENT_CHARS + 1));
    assert.equal(longSeg.ok, false);
    assert.match(longSeg.reason, new RegExp(`at most ${MAX_SEGMENT_CHARS}`));
    const segs = (n) => Array.from({ length: n }, () => 'a').join('/');
    assert.equal(validateClaimPattern(segs(MAX_PATTERN_SEGMENTS)).ok, true);
    const tooMany = validateClaimPattern(segs(MAX_PATTERN_SEGMENTS + 1));
    assert.equal(tooMany.ok, false);
    assert.match(tooMany.reason, new RegExp(`at most ${MAX_PATTERN_SEGMENTS}`));
  });

  it('segment length counts characters, not UTF-16 units (an astral letter is one)', () => {
    assert.equal(validateClaimPattern('\u{1D7D8}'.repeat(MAX_SEGMENT_CHARS)).ok, true);
    assert.equal(validateClaimPattern('\u{1D7D8}'.repeat(MAX_SEGMENT_CHARS + 1)).ok, false);
  });

  it('an over-limit pattern is "unknown" (treated as overlap) and never throws, even at sizes that overflow the stack', () => {
    const huge = 'a*'.repeat(50_000); // 100k characters: the old unbounded DP recursed this deep
    let r;
    assert.doesNotThrow(() => { r = patternsIntersect(huge, huge); });
    assert.equal(r, 'unknown');
    assert.equal(patternsIntersect(Array.from({ length: 5000 }, () => '**').join('/'), 'a/b'), 'unknown');
  });

  it('worst case AT the limits terminates promptly and gives a definite answer', () => {
    const wild = Array.from({ length: MAX_PATTERN_SEGMENTS }, () => 'a*'.repeat(MAX_SEGMENT_CHARS / 2)).join('/');
    const other = Array.from({ length: MAX_PATTERN_SEGMENTS }, () => '*a'.repeat(MAX_SEGMENT_CHARS / 2)).join('/');
    const t = Date.now();
    const r = patternsIntersect(wild, other);
    assert.ok(['intersect', 'disjoint'].includes(r), r);
    assert.ok(Date.now() - t < 10_000, `took ${Date.now() - t}ms`);
  });

  it('validateClaimPatterns reports each over-limit entry', () => {
    const v = validateClaimPatterns(['ok/**', seg(MAX_SEGMENT_CHARS + 1)]);
    assert.equal(v.ok, false);
    assert.equal(v.errors.length, 1);
  });
});

describe('gatherFacts evidence comes from captured commit ids', () => {
  it('a tag named like the branch cannot substitute its commit for the branch tip', () => {
    const { repo } = makeFleetRepo();
    git(['checkout', '-q', '-b', 'feature'], repo);
    commitFile(repo, 'from-branch.txt', 'b\n');
    git(['checkout', '-q', '-b', 'elsewhere', 'main'], repo);
    commitFile(repo, 'from-tag.txt', 't\n');
    git(['tag', 'feature'], repo); // refs/tags/feature now shadows refs/heads/feature for a NAME lookup
    git(['checkout', '-q', 'main'], repo);

    // The control: resolved by name, git prefers the tag, so the evidence is the WRONG commit's.
    assert.deepEqual(changedFiles(repo, 'main', 'feature').files, ['from-tag.txt'], 'the hazard this guards against is real');

    const facts = gatherFacts({ cwd: repo, config: { baseBranch: 'main' }, now: new Date(), prs: false, worktrees: false });
    assert.deepEqual(facts.changed.feature.files, ['from-branch.txt'], 'evidence must describe the captured branch tip');
    assert.equal(facts.baseOid, git(['rev-parse', 'main'], repo));
  });
});

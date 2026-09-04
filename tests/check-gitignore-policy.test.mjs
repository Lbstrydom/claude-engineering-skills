/**
 * @fileoverview Cluster B / Phase 8 — the gitignore category gate.
 *
 * The rule this enforces exists because ignoring a path is easy and the
 * follow-up question is never asked: *if this is private and not regenerable,
 * where does it durably live?* Measured 2026-09-04, not asking it left 37
 * tech-debt entries on one disk and nowhere else.
 *
 * The grammar cases below are not hypothetical — a `pattern` followed by
 * `!exception` is the shape that made an earlier draft's binding rules
 * self-contradictory, and "P with nothing recoverable" is the contradiction the
 * category exists to surface.
 *
 * Plan: docs/plans/backlog-and-drift-reduction.md §2 gitignore grammar, §9.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseGroups, validateGroup, keyFor, analyse } from '../scripts/check-gitignore-policy.mjs';

describe('parseGroups — comment blocks bind downward', () => {
  test('one comment block covers the contiguous rules beneath it', () => {
    const g = parseGroups('# Category: A\nfoo/\nbar/\n');
    assert.equal(g.length, 1);
    assert.deepEqual(g[0].patterns, ['foo/', 'bar/']);
  });

  test('a blank line ends the group', () => {
    const g = parseGroups('# Category: A\nfoo/\n\n# Category: A\nbar/\n');
    assert.equal(g.length, 2);
    assert.deepEqual(g[0].patterns, ['foo/']);
    assert.deepEqual(g[1].patterns, ['bar/']);
  });

  test('a negation is a MEMBER of its group, not a separate case', () => {
    // The shape that broke the earlier "negations inherit the block above"
    // wording: under downward-only binding it could not be classified at all.
    const g = parseGroups('# Category: A\n.env\n.env.*\n!.env.example\n');
    assert.equal(g.length, 1);
    assert.deepEqual(g[0].patterns, ['.env', '.env.*', '!.env.example']);
    assert.deepEqual(validateGroup(g[0]), [], 'the negation inherits the group category');
  });

  test('a group that STARTS with a negation is an error', () => {
    const g = parseGroups('# Category: A\n!only-a-negation\n');
    const problems = validateGroup(g[0]);
    assert.ok(problems.some((p) => /may not START with a negation/.test(p)));
  });
});

describe('validateGroup — the category contract', () => {
  test('a rule with no Category fails', () => {
    const g = parseGroups('# just a note\nfoo/\n');
    assert.ok(validateGroup(g[0]).some((p) => /no `Category:` declared/.test(p)));
  });

  test('an unknown category fails', () => {
    const g = parseGroups('# Category: Z\nfoo/\n');
    assert.ok(validateGroup(g[0]).some((p) => /unknown category/.test(p)));
  });

  test('Category A needs nothing else', () => {
    assert.deepEqual(validateGroup(parseGroups('# Category: A\nfoo/\n')[0]), []);
  });

  test('Category P WITHOUT a durable home fails — the whole point of the category', () => {
    const g = parseGroups('# Category: P\n# Recoverable: the rows\n# Disposable: none\nfoo/\n');
    assert.ok(validateGroup(g[0]).some((p) => /requires `Durable home:`/.test(p)));
  });

  test('Category P with an EMPTY Recoverable half is a contradiction', () => {
    const g = parseGroups('# Category: P\n# Durable home: somewhere\n# Recoverable: none\n# Disposable: none\nfoo/\n');
    assert.ok(validateGroup(g[0]).some((p) => /contradiction/.test(p)),
      'private-and-load-bearing with nothing recoverable is either Category A, or it has a home');
  });

  test('Category P must state its disposable half explicitly, even when none', () => {
    const g = parseGroups('# Category: P\n# Durable home: the store\n# Recoverable: the rows\nfoo/\n');
    assert.ok(validateGroup(g[0]).some((p) => /requires `Disposable:`/.test(p)));
  });

  test('a fully declared P rule passes', () => {
    const g = parseGroups('# Category: P\n# Durable home: private Postgres\n# Recoverable: debt entries\n# Disposable: transcripts\nfoo/\n');
    assert.deepEqual(validateGroup(g[0]), []);
  });
});

describe('keyFor — reordering is not drift, weakening a claim is', () => {
  test('the key ignores line position', () => {
    const a = parseGroups('# Category: A\nfoo/\n')[0];
    // Same rule, same declaration, pushed further down the file by an unrelated
    // earlier group. A comment block with no rules beneath it yields no group,
    // so `bar/` is the first entry here and `foo/` the second.
    const groups = parseGroups('# Category: A\nbar/\n\n# Category: A\nfoo/\n');
    assert.equal(groups.length, 2);
    const b = groups[1];
    assert.deepEqual(b.patterns, ['foo/']);
    assert.notEqual(a.startLine, b.startLine, 'the two are at different lines');
    assert.equal(keyFor(a), keyFor(b), 'yet they key identically — reordering is not drift');
  });

  test('a comment block with no rules beneath it produces no group', () => {
    // A free-standing note (a file header, a section divider) is not a rule
    // group and must not be demanded to declare a category.
    assert.deepEqual(parseGroups('# just a note, nothing below it\n'), []);
  });

  test('the key CHANGES when a P rule weakens its recoverability claim', () => {
    const strong = parseGroups('# Category: P\n# Durable home: store\n# Recoverable: everything\n# Disposable: none\nfoo/\n')[0];
    const weak = parseGroups('# Category: P\n# Durable home: store\n# Recoverable: some of it\n# Disposable: none\nfoo/\n')[0];
    assert.notEqual(keyFor(strong), keyFor(weak),
      'a silently weakened claim must surface as drift, not slip through on an old baseline entry');
  });
});

describe('analyse — over the real .gitignore', () => {
  test('every Category P rule in this repo declares a durable home', async () => {
    const fs = await import('node:fs');
    const { groups } = analyse(fs.readFileSync('.gitignore', 'utf-8'));
    const pRules = groups.filter((g) => /^Category:\s*P$/m.test(g.comment));
    assert.ok(pRules.length >= 5, `expected the private rules to be declared, found ${pRules.length}`);
    for (const g of pRules) {
      assert.deepEqual(
        validateGroup(g), [],
        `Category P rule ${g.patterns.join(',')} is incomplete — a private path with no durable home is one disk failure from gone`,
      );
    }
  });
});

// Gate contract: scripts/gate-contracts/gitignore-policy-gate.json declares the
// executable gate `gitignore-policy-rejects-undeclared-rules`, whose poison pill
// empties the accepted baseline so every undeclared rule must surface.

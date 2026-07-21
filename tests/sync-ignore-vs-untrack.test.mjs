/**
 * @fileoverview Tier-3 (consumer-sync contract) guard: the managed-ignore list
 * and the untrack allow-list must stay SEPARATE.
 *
 * They used to be one constant, and that coupling made the ignore list
 * un-widenable. `.audit/` is entirely our directory (~30 named writers plus
 * every skill's `--out .audit/<session>-…` artifact), so it must be ignored as
 * a DIRECTORY — a filename enumeration loses the race every time a skill
 * writes a new output, and loses it silently (a consumer just nags forever
 * about whichever file nobody added; `plan-fp-patterns.json` was the one that
 * surfaced it).
 *
 * But the same constant also fed `untrackNewlyIgnored`, which runs
 * `git rm --cached`. A verified consumer TRACKS 8 committed files under
 * `.audit/` (persona session captures, `tech-debt.json`) — deliberately kept
 * records. Widening the shared constant would have silently deleted all 8 from
 * that repo's index on the next sync.
 *
 * The asymmetry is the whole point:
 *   ignore  — no effect on already-tracked files ⇒ safe to broaden.
 *   untrack — acts on exactly those files        ⇒ must stay narrow + explicit.
 *
 * Asserted against the source TEXT because sync-to-repos.mjs is a CLI that
 * executes on import (same approach as tests/anthropic-client-migration.test.mjs).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gitignoreToRegExp } from '../scripts/lib/sync-untrack.mjs';

const SRC = fs.readFileSync(
  path.join(process.cwd(), 'scripts', 'sync-to-repos.mjs'), 'utf-8',
);

/** Extract a top-level `const NAME = [ … ];` array's string literals. */
function arrayLiterals(name) {
  const m = SRC.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`));
  assert.ok(m, `${name} must exist as a top-level array literal`);
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

describe('managed-ignore vs untrack allow-list are separate contracts', () => {
  it('both lists exist and the old shared constant is gone', () => {
    const ignore = arrayLiterals('MANAGED_IGNORE_PATTERNS');
    const untrack = arrayLiterals('UNTRACK_PATTERNS');
    assert.ok(ignore.length > 0 && untrack.length > 0);
    assert.doesNotMatch(
      SRC, /AUDIT_RUNTIME_IGNORES/,
      'the merged constant must not come back — it is what made the ignore list un-widenable',
    );
  });

  it('the ignore list covers ALL of .audit/ as a directory, not by filename', () => {
    const ignore = arrayLiterals('MANAGED_IGNORE_PATTERNS');
    assert.ok(
      ignore.includes('.audit/'),
      'a filename enumeration silently loses to every new `--out .audit/…` artifact',
    );
    const perFile = ignore.filter(p => p.startsWith('.audit/') && p !== '.audit/');
    assert.deepEqual(
      perFile, [],
      `the blanket '.audit/' makes per-file .audit entries dead weight: ${perFile.join(', ')}`,
    );
  });

  it('the UNTRACK list never carries a bare directory pattern', () => {
    // Two independent reasons, either sufficient:
    //  1. destructive — a dir pattern would sweep every committed file beneath it;
    //  2. it would not even work — the matcher is anchored and has no `**`, so
    //     `.audit/` compiles to /^\.audit\/$/ and matches NOTHING. A silently
    //     inert entry in a destructive allow-list is worse than an absent one.
    for (const p of arrayLiterals('UNTRACK_PATTERNS')) {
      assert.ok(!p.endsWith('/'), `untrack pattern must not be a bare directory: ${p}`);
    }
  });

  it('proves the inertness claim rather than asserting it', () => {
    assert.equal(gitignoreToRegExp('.audit/').test('.audit/tech-debt.json'), false);
    assert.equal(gitignoreToRegExp('.audit/').test('.audit/'), true);
  });

  it('every untrack pattern is a strict subset of what the ignore block ignores', () => {
    // Untracking a file the managed block does NOT ignore would remove it from
    // the index and then immediately re-nag it as untracked — churn, not repair.
    const ignore = arrayLiterals('MANAGED_IGNORE_PATTERNS');
    const dirPrefixes = ignore.filter(p => p.endsWith('/'));
    const filePats = ignore.filter(p => !p.endsWith('/')).map(gitignoreToRegExp);

    for (const u of arrayLiterals('UNTRACK_PATTERNS')) {
      const covered =
        dirPrefixes.some(d => u.startsWith(d)) ||
        filePats.some(re => re.source === gitignoreToRegExp(u).source);
      assert.ok(covered, `untrack pattern is not covered by any ignore rule: ${u}`);
    }
  });

  it('the consumer sync-manifest is IGNORED but never auto-UNTRACKED (Feature B, sync-ownership-from-content §B)', () => {
    // Feature B untracked the consumer manifest to kill per-sync churn + the
    // merge-revert footgun (ownership moved to content-derived banners; the
    // isolation verifier reads the manifest from disk, Gates 2A/6 assert nothing
    // about its tracked state). It belongs in the ignore list so a fresh consumer
    // stops committing it — but NOT in the destructive untrack list: a consumer
    // that committed it BY DESIGN must be untracked by an explicit per-repo
    // `git rm --cached`, never silently on sync.
    const ignore = arrayLiterals('MANAGED_IGNORE_PATTERNS');
    const untrack = arrayLiterals('UNTRACK_PATTERNS');
    assert.ok(
      ignore.includes('scripts/.sync-manifest.json'),
      'the consumer manifest must be in the ignore list (Feature B)',
    );
    assert.ok(
      !untrack.includes('scripts/.sync-manifest.json'),
      'the consumer manifest must NOT be auto-untracked on sync — explicit per-repo decision only',
    );
  });

  it('.audit-loop/ stays PRECISE — consumers track migrations there', () => {
    const ignore = arrayLiterals('MANAGED_IGNORE_PATTERNS');
    assert.ok(!ignore.includes('.audit-loop/'), 'a blanket .audit-loop/ would ignore tracked migrations');
    for (const p of ignore.filter(p => p.startsWith('.audit-loop/'))) {
      assert.equal(
        gitignoreToRegExp(p).test('.audit-loop/migrations/0001_init.sql'), false,
        `${p} must never match a tracked consumer migration`,
      );
    }
  });
});

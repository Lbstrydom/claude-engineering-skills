/**
 * @fileoverview The ownership record is a commit point, not bookkeeping.
 *
 * Files are copied to a consumer BEFORE its manifest is written. If that
 * write does not land, the files exist with nobody claiming them — and the
 * next run classifies each as an unowned collision and aborts the WHOLE
 * target, so the consumer silently stops receiving every future update.
 *
 * Two defects made that state permanent and invisible:
 *   1. the manifest-write failure was logged but not counted, so the run
 *      reported success;
 *   2. the in-progress journal — the mechanism that exists to recover from
 *      exactly this — was deleted unconditionally afterwards, destroying the
 *      evidence that would have let the next run self-heal.
 *
 * Field-observed 2026-07-19: two brainstorm modules written to a consumer at
 * 09:27 against a manifest last written 08:55, journal absent, every
 * subsequent sync to that consumer aborting wholesale.
 *
 * These tests pin the invariants, not the implementation: a failed commit
 * point must be an error AND must leave the journal behind.
 *
 * Plan: docs/plans/debt-burndown-workstreams.md (WS-A follow-up).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'sync-to-repos.mjs'), 'utf-8');

/** Source region between two anchors — lets us assert on ORDERING, not just presence. */
function between(startRe, endRe) {
  const s = SRC.search(startRe);
  assert.notEqual(s, -1, `anchor not found: ${startRe}`);
  const e = SRC.slice(s).search(endRe);
  assert.notEqual(e, -1, `end anchor not found: ${endRe}`);
  return SRC.slice(s, s + e);
}

describe('manifest write is a commit point (defect 1)', () => {
  it('a failed manifest write increments the error counters', () => {
    const region = between(/Commit point: write per-consumer manifest/, /Apply managed \.gitattributes/);
    assert.match(region, /manifest write FAILED/, 'the failure must be reported loudly');
    assert.match(region, /repoErrors\+\+;\s*totalErrors\+\+/,
      'a sync whose ownership record did not land has NOT succeeded — it must count as an error');
  });

  it('success is recorded explicitly, not assumed', () => {
    const region = between(/Commit point: write per-consumer manifest/, /Apply managed \.gitattributes/);
    assert.match(region, /manifestWritten = true/,
      'the journal deletion below must key off an explicit success signal');
    // The flag must be initialised false so the failure path cannot read as success.
    assert.match(SRC, /let manifestWritten = false/);
  });

  it('the failure message tells the operator recovery is possible', () => {
    const region = between(/Commit point: write per-consumer manifest/, /Apply managed \.gitattributes/);
    assert.match(region, /journal is\s*\n?.*kept|journal[\s\S]{0,80}kept/i,
      'silence here is what made the original incident invisible');
  });
});

describe('journal deletion is conditional (defect 2)', () => {
  it('the journal is only deleted when the manifest actually wrote', () => {
    const region = between(/Last step: delete the in-progress journal/, /const parts = \[\]/);
    assert.match(region, /if \(!DRY_RUN && manifestWritten\)/,
      'deleting the journal after a failed commit point destroys the only recovery evidence');
    assert.doesNotMatch(region, /if \(!DRY_RUN\) \{\s*\n\s*try \{ fs\.unlinkSync/,
      'the unconditional deletion is the bug — it must not come back');
  });

  it('the journal is still written BEFORE any file copy', () => {
    // Ordering invariant: journal → copies → manifest. If the journal moved
    // after the copies, a crash mid-copy would leave unowned files again.
    const journalWrite = SRC.search(/Pre-flight passed; write the in-progress journal/);
    const firstCopy = SRC.search(/── Per-file writes ─/);
    const manifest = SRC.search(/Commit point: write per-consumer manifest/);
    assert.ok(journalWrite > 0 && firstCopy > journalWrite,
      'the journal must be written before any file is copied');
    assert.ok(manifest > firstCopy, 'the manifest commit point comes after the copies');
  });

  it('an interrupted run is still recognised on the next pass', () => {
    // The recovery half of the contract — without this the journal is inert.
    assert.match(SRC, /ownedByInterruptedRun/,
      'journal destinations must be treated as owned by the next run');
  });
});

describe('--adopt-orphans (recovery for records already lost)', () => {
  it('is opt-in and never defaults on', () => {
    assert.match(SRC, /const ADOPT_ORPHANS = process\.argv\.includes\('--adopt-orphans'\)/);
    // Guard against a default-true regression: the flag must gate the branch.
    assert.match(SRC, /if \(collisions\.length && ADOPT_ORPHANS\)/);
  });

  it('reports ownership EVIDENCE (our banner), not a content diff', () => {
    const region = between(/if \(collisions\.length && ADOPT_ORPHANS\)/, /if \(collisions\.length\) \{/);
    assert.match(region, /BANNER_MARKER/,
      'outbound content is banner-injected, so a raw source diff always reads "differs" — useless');
    assert.match(region, /provably ours/);
    assert.match(region, /NO banner — inspect before adopting/,
      'a file without our banner must be flagged, not silently adopted');
  });

  it('adoption clears the collisions so the normal write path runs', () => {
    const region = between(/if \(collisions\.length && ADOPT_ORPHANS\)/, /if \(collisions\.length\) \{/);
    assert.match(region, /collisions\.length = 0/);
  });

  it('WITHOUT the flag the abort still fires — the guard is not weakened', () => {
    const region = between(/if \(collisions\.length\) \{/, /Pre-flight passed/);
    assert.match(region, /ABORT/);
    assert.match(region, /totalErrors\+\+/);
    assert.match(region, /continue;/, 'an unadopted collision must still skip the whole target');
  });

  it('the abort points the operator at the recovery flag', () => {
    const region = between(/if \(collisions\.length\) \{/, /Pre-flight passed/);
    assert.match(region, /--adopt-orphans/,
      'an operator who hits this must learn the fix from the message, not the source');
  });
});

describe('BANNER_MARKER — the ownership fingerprint must actually match', () => {
  it('is a STRING line, not the raw array (the bug this pins)', async () => {
    const { BANNER_BODY } = await import('../scripts/lib/sync-banner.mjs');
    assert.ok(Array.isArray(BANNER_BODY), 'precondition: BANNER_BODY is a line array');
    // `'...'.includes(arrayOfLines)` coerces to a comma-joined string and never
    // matches, so every synced file falsely reported "NO banner" — a safety
    // signal failing toward "suspicious" is still a lying diagnostic.
    const injected = `// ${BANNER_BODY.join('\n// ')}\nconst x = 1;\n`;
    assert.equal(injected.includes(BANNER_BODY), false, 'the naive form is broken — this is why we normalise');
    assert.ok(injected.includes(BANNER_BODY[0]), 'the normalised marker must match real banner-injected content');
  });

  it('sync-to-repos normalises before using it', () => {
    assert.match(SRC, /const BANNER_MARKER = Array\.isArray\(BANNER_BODY\)/,
      'the marker must be normalised at one place, not at each call site');
    assert.match(SRC, /import \{[^}]*BANNER_BODY[^}]*\} from '\.\/lib\/sync-banner\.mjs'/);
  });

  it('matches a REAL banner-injected file end-to-end', async () => {
    const { injectUpstreamBanner, BANNER_BODY } = await import('../scripts/lib/sync-banner.mjs');
    const marker = Array.isArray(BANNER_BODY) ? BANNER_BODY[0] : String(BANNER_BODY);
    // Drive the real injector rather than hand-rolling the banner shape, so a
    // change to banner rendering fails here instead of silently breaking
    // orphan-adoption's evidence line.
    const out = injectUpstreamBanner('scripts/.claude-skills/lib/x.mjs', 'export const a = 1;\n');
    if (typeof out === 'string' && out.includes('UPSTREAM-OWNED')) {
      assert.ok(out.includes(marker), 'the marker must be found in genuinely injected output');
    }
  });
});

describe('content-derived ownership (the manifest is no longer the only proof)', () => {
  it('classifies an orphan by CONTENT before calling it a collision', () => {
    // The manifest is a TRACKED file a merge can roll backwards while the
    // gitignored files it describes survive, so "absent from the manifest" is
    // not evidence a file is foreign. The bytes are.
    assert.match(SRC, /import \{[^}]*classifyOwnership[^}]*\} from '\.\/lib\/sync-ownership\.mjs'/);
    assert.match(SRC, /classifyOwnership\(\{/);
    assert.match(SRC, /if \(provable\) contentOwned\.push/,
      'a provably-owned orphan must be adopted, not collided');
  });

  it('builds the identity comparand with the REAL write pipeline', () => {
    // Re-deriving "is this file rewritten / banner-injected / EOL-folded?" as
    // a second predicate is the duplicate-definition drift this repo keeps
    // paying for. The comparand must come from the same functions the write
    // path uses — all THREE of them.
    const region = between(/const srcContent = .*readSource\(srcRel\)/, /classifyOwnership\(\{/);
    assert.match(region, /injectUpstreamBanner/);
    assert.match(region, /rewriteCommandSurface/);

    // The outbound EOL fold is the third, added 2026-09-02. Assert BOTH sites
    // rather than just this one: folding here while the write path did not
    // (or vice versa) is not a cosmetic mismatch — it makes a file we
    // ourselves wrote compare unequal whenever the two ran from checkouts
    // that disagree on line endings, demoting a provably-owned orphan to a
    // collision that aborts the consumer's entire bundle.
    assert.match(
      SRC, /const srcContent = canonicaliseOutboundEol\(dstRel, readSource\(srcRel\)\)/,
      'the ownership comparand must be EOL-folded exactly as the write path folds it',
    );
    assert.match(
      SRC, /let outContent = canonicaliseOutboundEol\(dstRel, srcContent\)/,
      'the write path must fold outbound content, or the comparand above folds for nothing',
    );
  });

  it('still collides on anything not provably ours — the guard is not weakened', () => {
    assert.match(SRC, /else collisions\.push\(dstRel\)/,
      'a file failing the content proof must still abort the target');
  });

  it('never adopts silently — an auto-adopt is always reported', () => {
    // This path only runs because the ownership record regressed. Silent
    // auto-adoption would hide a recurring rollback behind a clean sync,
    // trading a loud abort for a quiet pathology.
    assert.match(SRC, /contentOwned\.length\) \{/);
    assert.match(SRC, /proved ours by content/);
  });

  it('reports a would-be abort under --dry-run too', () => {
    // The abort used to be gated on `!DRY_RUN`, so the one command an operator
    // runs to ask "what would this do?" could not see a whole-target refusal.
    assert.match(SRC, /would ABORT/);
    assert.doesNotMatch(SRC, /if \(collisions\.length && !DRY_RUN\)/,
      'the dry-run-suppressed abort must not come back');
  });
});

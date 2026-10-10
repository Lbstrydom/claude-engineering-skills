/**
 * @fileoverview The three consumer reports filed 2026-09-07, each pinned by the
 * direction that had to fire.
 *
 *   ea23dfda — the bundle imports 16 npm packages and declared none of them
 *   5bc7ff30 — skills:hydrate copied the tooling and left the bundle stamp behind
 *   b02d80b3 — /ship Step 6.8 overwrote an unread verification note
 *
 * Each one had the same shape: a check that could report health while never
 * having looked. So every case below asserts BOTH directions — the one that must
 * fire and the one that must not — because a false green is what all three were.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  pendingNoteName, pendingNoteSortKey, pendingNoteDir,
  readPendingNotes, writePendingNote, clearPendingNotes,
  LEGACY_PENDING_NOTE, PENDING_NOTE_PREFIX,
} from '../scripts/lib/worktree-preflight.mjs';
import { classifyCheckout } from '../scripts/lib/checkout-kind.mjs';
import { upstreamReport } from '../scripts/lib/upstream/commands.mjs';
import { buildBundleDeps, serialiseBundleDeps } from '../scripts/generate-bundle-deps.mjs';
import { readBundleDeps } from '../scripts/lib/install/bundle-deps.mjs';
import { IMPORT_PKG_ALLOW } from '../scripts/lib/ux-lock/selector-policy.mjs';

function tempCheckout() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-note-'));
  fs.mkdirSync(path.join(dir, '.claude', 'tmp'), { recursive: true });
  return dir;
}

// ── b02d80b3 ────────────────────────────────────────────────────────────────

describe('ship pending notes — a second ship must not destroy an unread one', () => {
  it('THE DEFECT: two writes for the SAME sha produce two files, not one', () => {
    // The old step wrote `.claude/tmp/ship-verification-pending.md` with no
    // existence check, and the write-to-read gap is unbounded. Hit live
    // 2026-09-06: a verified note sat unread ~10 hours until the next Step 6.8.
    const root = tempCheckout();
    const a = writePendingNote(root, 'abc1234', 'first', { now: new Date('2026-09-06T10:00:00Z') });
    const b = writePendingNote(root, 'abc1234', 'second', { now: new Date('2026-09-06T20:00:00Z') });
    assert.notEqual(a, b, 'a second ship must not land on the first note');
    const res = readPendingNotes(root);
    assert.equal(res.notes.length, 2);
    assert.deepEqual(res.notes.map((n) => n.text.trim()), ['first', 'second'], 'oldest first');
  });

  it('a legacy single-occupancy note is drained, never stranded by the fix', () => {
    // The fix must not orphan the note the old step already wrote.
    const root = tempCheckout();
    fs.writeFileSync(path.join(pendingNoteDir(root), LEGACY_PENDING_NOTE), 'from the old step\n');
    writePendingNote(root, 'def5678', 'newer', { now: new Date('2026-09-07T10:00:00Z') });
    const res = readPendingNotes(root);
    assert.deepEqual(res.notes.map((n) => n.text.trim()), ['from the old step', 'newer'],
      'the legacy note has no timestamp and is by definition the oldest');
  });

  it('clear deletes only the NAMED notes — one that arrived in between survives', () => {
    // A blanket delete would reopen the defect one step later.
    const root = tempCheckout();
    writePendingNote(root, 'aaa', 'read me', { now: new Date('2026-09-07T10:00:00Z') });
    const first = readPendingNotes(root).notes.map((n) => n.name);
    writePendingNote(root, 'bbb', 'arrived after the read', { now: new Date('2026-09-07T11:00:00Z') });
    const cleared = clearPendingNotes(root, first);
    assert.deepEqual(cleared.deleted, first);
    const left = readPendingNotes(root).notes;
    assert.equal(left.length, 1);
    assert.equal(left[0].text.trim(), 'arrived after the read');
  });

  it('clear refuses a name that is not a note — it deletes files', () => {
    const root = tempCheckout();
    fs.writeFileSync(path.join(pendingNoteDir(root), 'commit-message.txt'), 'not a note');
    const r = clearPendingNotes(root, ['commit-message.txt', '../../../etc/passwd']);
    assert.deepEqual(r.deleted, []);
    assert.equal(r.missing.length, 2);
    assert.ok(fs.existsSync(path.join(pendingNoteDir(root), 'commit-message.txt')));
  });

  it('"could not look" is not "nothing pending"', () => {
    // The same distinction the outbox drain had to learn: an unreadable queue
    // reported as empty is a full queue wearing an empty one's clothes.
    const r = readPendingNotes('/whatever', {
      exists: () => true,
      readdir: () => { throw new Error('EACCES'); },
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /EACCES/);
    assert.deepEqual(r.notes, []);
  });

  it('an absent directory IS empty — the normal state between ships', () => {
    const r = readPendingNotes(path.join(os.tmpdir(), 'definitely-not-a-checkout-xyz'));
    assert.equal(r.ok, true);
    assert.deepEqual(r.notes, []);
  });

  it('the filename carries both facts an operator needs', () => {
    const n = pendingNoteName('0cd62d0aad4e833e', new Date('2026-09-07T07:24:13.500Z'));
    assert.equal(n, `${PENDING_NOTE_PREFIX}0cd62d0aad4e-20260907T072413Z.md`);
    assert.equal(pendingNoteSortKey(n), '20260907T072413Z');
    assert.equal(pendingNoteSortKey(LEGACY_PENDING_NOTE), '', 'legacy sorts first');
  });
});

// ── 5bc7ff30 ────────────────────────────────────────────────────────────────

describe('sync-isolation-verify refuses a linked worktree, explicitly', () => {
  it('THE DIRECTION THAT MUST FIRE: a tree that is not the main root is linked', () => {
    const c = classifyCheckout({
      worktreeRoot: '/repo/.claude/worktrees/wt',
      mainRoot: '/repo',
    });
    assert.equal(c.kind, 'linked');
  });

  it('THE DIRECTION THAT MUST NOT FIRE: a main checkout is not refused', () => {
    // A false refusal would break the one place this check is meant to run,
    // and a gate that cried wolf here would simply be skipped.
    assert.equal(classifyCheckout({ worktreeRoot: '/repo', mainRoot: '/repo' }).kind, 'main');
  });

  it('git failing to answer is UNKNOWN, never "main"', () => {
    // Absence of evidence: there is no proof of a linked worktree to act on,
    // and reporting it as a main checkout would be a claim nothing established.
    assert.equal(classifyCheckout({ worktreeRoot: null, mainRoot: '/repo' }).kind, 'unknown');
    assert.equal(classifyCheckout({ worktreeRoot: '/repo', mainRoot: null }).kind, 'unknown');
  });
});

describe('a report filed with no bundle stamp SAYS so at filing time', () => {
  const base = {
    repoUuid: '11111111-1111-4111-8111-111111111111',
    repoId: 7,
    title: 'a title',
    body: 'a body long enough to pass validation',
    severity: 'MEDIUM',
    affectedPath: 'scripts/.claude-skills/skills-hydrate.mjs',
    recordFn: async () => ({ ok: true, cloud: true, id: 'x', created: true }),
  };

  it('THE DIRECTION THAT MUST FIRE: no manifest under repoRoot ⇒ one warning', async () => {
    // ok:true / created:true is what an operator reads; the nulls sat in a JSON
    // blob beside it, so a report filed from an un-hydrated worktree looked
    // exactly like a healthy one (upstream 5bc7ff30).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'no-stamp-'));
    const res = await upstreamReport({ ...base, repoRoot: root });
    assert.equal(res.ok, true);
    assert.equal(res.bundleSha, null);
    assert.equal(res.warnings.length, 1);
    assert.match(res.warnings[0], /no bundle stamp/);
    assert.match(res.warnings[0], /skills:hydrate/, 'a warning must name the remedy');
  });

  it('THE DIRECTION THAT MUST NOT FIRE: a stamped report warns about nothing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stamped-'));
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', '.sync-manifest.json'), JSON.stringify({
      commitSha: '0cd62d0aad4e833e953580692be958c7dedaae6b',
      generatedAt: '2026-09-06T00:00:00Z',
      files: { 'scripts/.claude-skills/skills-hydrate.mjs': 'deadbeef' },
    }));
    const res = await upstreamReport({ ...base, repoRoot: root });
    assert.deepEqual(res.warnings, [], 'a healthy filing must stay quiet');
    assert.equal(res.pathRecognised, true);
  });
});

// ── ea23dfda ────────────────────────────────────────────────────────────────

describe('bundle-deps — the bundle declares what it imports', () => {
  const inventories = new Map([
    ['consumer-a', { external: [
      { from: 'scripts/openai-audit.mjs', pkg: 'zod' },
      { from: 'scripts/lib/db/client.mjs', pkg: 'pg' },
      { from: 'scripts/lib/consistency/runner.mjs', pkg: 'playwright' },
    ] }],
    ['consumer-b', { external: [
      { from: 'scripts/symbol-index/extract.mjs', pkg: 'ts-morph' },
      { from: 'scripts/openai-audit.mjs', pkg: 'zod' },
    ] }],
  ]);

  it('unions every consumer and maps importers to CONSUMER paths', () => {
    // A source-repo path names a file the reader does not have.
    const doc = buildBundleDeps(inventories, ['playwright'], new Set());
    assert.deepEqual(doc.packages.map((p) => p.name), ['pg', 'playwright', 'ts-morph', 'zod']);
    assert.deepEqual(
      doc.packages.find((p) => p.name === 'zod').importers,
      ['scripts/.claude-skills/openai-audit.mjs'],
    );
  });

  it('required-vs-optional comes from the CURATED set, not the graph', () => {
    // "does this package's absence degrade a feature or break an import" is a
    // semantic question no import graph can answer.
    const doc = buildBundleDeps(inventories, ['playwright'], new Set());
    assert.equal(doc.packages.find((p) => p.name === 'playwright').required, false);
    assert.equal(doc.packages.find((p) => p.name === 'pg').required, true);
    assert.equal(doc.installAs, 'devDependencies', 'the dev-vs-runtime intent must travel');
  });

  it('generated-spec packages are a SEPARATE claim, derived from selector-policy', () => {
    // Nothing in the bundle imports axe-core; the specs /ux-lock generates do.
    // Folding them into `packages` would assert something false about the graph.
    const doc = buildBundleDeps(inventories, [], IMPORT_PKG_ALLOW);
    assert.ok(!doc.packages.some((p) => p.name === 'axe-core'));
    assert.ok(doc.generatedSpecPackages.packages.includes('axe-core'));
  });

  // The freshness gate this artifact needs is contracted as
  // `bundle-deps-check-compares-the-derived-set` in
  // scripts/gate-contracts/bundle-deps-check.json, whose poison pill proves
  // `--check` compares the SERIALISED artifact rather than the package names —
  // which is what the determinism assertion below is the unit-level half of.
  it('serialisation is deterministic — the Category B test', () => {
    const a = serialiseBundleDeps(buildBundleDeps(inventories, ['playwright'], new Set()));
    const b = serialiseBundleDeps(buildBundleDeps(inventories, ['playwright'], new Set()));
    assert.equal(a, b);
    assert.ok(a.endsWith('\n'));
    assert.ok(!a.includes('\r'), 'no CRLF, so a checkout cannot read as drift');
  });

  it('THE REAL ARTIFACT is committed, parses, and covers the reported set', () => {
    const doc = readBundleDeps(path.resolve(import.meta.dirname, '..', 'scripts'));
    assert.ok(doc, 'scripts/lib/bundle-deps.json must be committed — regenerate: npm run bundle:deps');
    const names = doc.packages.map((p) => p.name);
    // The 16 the consumer measured by scanning the bundle for bare specifiers.
    for (const pkg of ['@anthropic-ai/sdk', '@babel/parser', '@babel/traverse', '@google/genai',
      'codeowners-utils', 'dependency-cruiser', 'dotenv', 'minimatch', 'openai', 'picomatch',
      'pg', 'playwright', 'proper-lockfile', 'ts-morph', 'yaml', 'zod']) {
      assert.ok(names.includes(pkg), `${pkg} must be declared`);
    }
    assert.ok(doc.packages.every((p) => p.importers.length > 0),
      'every entry names at least one importer, so no entry is a claim a reader cannot check');
  });

  it('an ABSENT declaration reads as null, never as an empty set', () => {
    // An older bundle predates the file. "cannot check" must not become
    // "nothing to check" — that is the defect this whole file is about.
    assert.equal(readBundleDeps(path.join(os.tmpdir(), 'no-bundle-here-xyz')), null);
  });
});

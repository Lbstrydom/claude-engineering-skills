/**
 * @fileoverview The sync's delivery post-condition — the manifest must describe
 * what is ON DISK, not merely what the run intended.
 *
 * ## The incident
 *
 * 2026-08-30: `storyline` ended two consecutive pushes without
 * `.audit-loop/migrations/20260830160000_upstream_issue_annotation_event.sql`
 * while its manifest claimed the file. That consumer had the JS half of a
 * feature and not the schema half, so `upstream annotate` there would have
 * failed with a `23514` check violation — and every source-side signal read
 * `Targets: 3/3 reached`. The only thing that caught it was
 * `sync-isolation-verify` run by hand from inside the consumer, which no
 * source-side workflow invokes.
 *
 * ## What was actually wrong, and what was NOT
 *
 * The first hypothesis — that a divergence REFUSAL aborts the rest of that
 * target's writes — is **false, and was falsified by reproduction** (see the
 * scratch-consumer case below, which is the regression lock for it). A refusal
 * `continue`s; every later file is written and recorded normally.
 *
 * What is real is that the sync only ever checked ONE direction. A file on disk
 * that the manifest has lost is re-adopted by content (`sync-ownership.mjs`,
 * because a tracked manifest can be rolled back by a merge while the files it
 * describes survive). The mirror image — a manifest entry whose file is gone —
 * had no check at all. That is shape (3) of the four AGENTS.md names, in the
 * one place where the unchecked direction under-delivers silently.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findUndeliveredEntries } from '../scripts/lib/sync-manifest.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── findUndeliveredEntries ─────────────────────────────────────────────────

const MAP = {
  '.audit-loop/migrations/a.sql': 'sha256:aaa',
  'scripts/.claude-skills/x.mjs': 'sha256:bbb',
  '.claude/skills/ship/SKILL.md': 'sha256:ccc',
};

test('post-condition: a manifest entry with no file on disk is reported', () => {
  const absent = new Set(['.audit-loop/migrations/a.sql']);
  assert.deepEqual(
    findUndeliveredEntries(MAP, { exists: (rel) => !absent.has(rel) }),
    ['.audit-loop/migrations/a.sql'],
  );
});

test('post-condition: a fully delivered manifest reports NOTHING', () => {
  // The direction that must not fire. A check that flagged a healthy tree would
  // be `--no-verify`d within a week, which is worse than the gap it closes.
  assert.deepEqual(findUndeliveredEntries(MAP, { exists: () => true }), []);
});

test('post-condition: every entry can be reported, and the order is stable', () => {
  const all = findUndeliveredEntries(MAP, { exists: () => false });
  assert.equal(all.length, 3);
  assert.deepEqual(all, [...all].sort(), 'sorted output — an operator diffs these run to run');
});

test('post-condition: an empty or absent map is not an error', () => {
  // A dry run and a first-ever sync both legitimately produce nothing here.
  assert.deepEqual(findUndeliveredEntries({}, { exists: () => false }), []);
  assert.deepEqual(findUndeliveredEntries(undefined, { exists: () => false }), []);
  assert.deepEqual(findUndeliveredEntries(null, { exists: () => false }), []);
});

test('post-condition: it asks about EVERY entry, never a sample', () => {
  // The failure this rules out is a check that stops at the first hit and so
  // reports 1 of 40 — the "shown vs total" defect this repo has fixed twice on
  // other views.
  const asked = [];
  findUndeliveredEntries(MAP, { exists: (rel) => { asked.push(rel); return true; } });
  assert.deepEqual([...asked].sort(), Object.keys(MAP).sort());
});

// ── The call site, asserted on source ──────────────────────────────────────
//
// The post-condition and the carried-base guard both live inline in
// `sync-to-repos.mjs`'s per-target loop, which cannot be imported without
// running a sync. These pin the two properties that make them meaningful; the
// behaviour itself was verified by driving a real sync into a scratch consumer
// (see the fileoverview).

const SYNC_SRC = fs.readFileSync(path.join(REPO_ROOT, 'scripts/sync-to-repos.mjs'), 'utf-8');

test('call site: the post-condition failure is counted as a target ERROR', () => {
  // Reporting without counting would leave `Errors: 0` printable over an
  // incomplete tree, which is the exact false-green being removed. The count is
  // what reaches the exit code and therefore the pre-push hook's verdict.
  const block = /findUndeliveredEntries\([\s\S]{0,1200}?\n {4}\}/.exec(SYNC_SRC);
  assert.ok(block, 'could not locate the post-condition block');
  assert.match(block[0], /repoErrors\s*\+\+/, 'an undelivered file must count as a target error');
  assert.match(block[0], /totalErrors\s*\+\+/, 'and must reach the run-wide total');
});

test('call site: a held path is recorded only while its file is still on disk', () => {
  // `matchOverride` fires before any disk test, so an override on a path the
  // consumer has since deleted would otherwise carry a stale base forward for
  // ever — the manifest asserting delivery of something absent. (A REFUSE
  // cannot reach it: refusal requires a diverged disk hash, hence the file.)
  const block = /if \(notWrittenByUs\.has\(dstRel\)\) \{[\s\S]{0,1400}?\n {10}\}/.exec(SYNC_SRC);
  assert.ok(block, 'could not locate the not-written-by-us branch');
  assert.match(block[0], /existsSync/, 'the carried base must be gated on the file existing');
  assert.match(
    block[0], /if \(carried && \w+\) consumerFileMap\[dstRel\] = carried;/,
    'both conditions must gate the write — carrying on either alone reintroduces the false claim',
  );
});

test('call site: the check runs on a REAL sync only, never on a dry run', () => {
  // A dry run writes nothing, so every entry would read as undelivered and the
  // one command an operator uses to ask "what would this do?" would report a
  // catastrophe. Same reason the collision guard had to be taught about
  // `--dry-run` from the other direction.
  const block = /\n {4}if \(!DRY_RUN && manifestWritten\) \{[\s\S]{0,200}?findUndeliveredEntries/.exec(SYNC_SRC);
  assert.ok(block, 'the post-condition must be guarded on !DRY_RUN && manifestWritten');
});

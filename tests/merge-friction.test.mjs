/**
 * @fileoverview Two concurrent PRs that each add a plan must merge WITHOUT a conflict in `docs/plans/README.md`.
 *
 * Measured 2026-10-15 over PRs #236-#253: 8 of 16 merges of `main` into a PR branch conflicted on that file, and every
 * one of the 8 conflicted hunks was the single summary line `**N active · N terminal · …**` (rows never conflicted).
 * GitHub computes mergeability itself and ignores `.gitattributes` merge drivers, and runs no `pull_request` workflow on
 * a CONFLICTING PR, so such a PR gets no `full-suite` verdict. The fix is to remove the line (docs/plans/
 * fleet-chips-and-merge-friction.md section 2.1): the counts print on stdout instead.
 *
 * The fixture is built to DISCRIMINATE (plan audit M2): one branch adds an ACTIVE plan and the other a TERMINAL one, so
 * the old counts line changes differently on each side, while the two new rows land in different sections separated
 * by unchanged rows, so the rows themselves cannot conflict. The negative control re-injects the old counts line and
 * must conflict, which proves the fixture detects the defect rather than passing for any generator.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { commitAll, gitInit, sh } from './helpers/fixtures.mjs';

const SCRIPT = path.resolve(import.meta.dirname, '../scripts/generate-plans-index.mjs');

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0 && !args.includes('merge-tree')) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r;
};

const plan = (title, status) => `# Plan: ${title}\n- **Status**: ${status}\n\nBody.\n`;

/** Regenerate the index in `repo` with the real generator; optionally re-inject the pre-fix counts line. */
function regenerate(repo, { oldCountsLine = false } = {}) {
  // The generator indexes TRACKED plans only (an untracked draft must not change a committed artifact), so stage first.
  git(repo, 'add', '-A');
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, `generator failed: ${r.stderr}`);
  if (oldCountsLine) {
    const f = path.join(repo, 'docs/plans/README.md');
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const at = lines.indexOf('---');
    const counts = (r.stdout.match(/\(([^)]*active[^)]*)\)/) ?? [])[1];
    assert.ok(counts && at > 0, 'could not locate the counts or the insertion point for the control');
    lines.splice(at, 0, `**${counts}**`, '');
    fs.writeFileSync(f, lines.join('\n'));
  }
}

/** Build the repo and the two diverging branches; returns the two branch tips. */
function build({ oldCountsLine }) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-friction-'));
  gitInit(repo);
  fs.mkdirSync(path.join(repo, 'docs/plans'), { recursive: true });
  // Several plans in BOTH buckets, so each new row has unchanged neighbours on both sides.
  for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(repo, `docs/plans/draft-${n}.md`), plan(`Draft ${n}`, 'Draft'));
  for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(repo, `docs/plans/done-${n}.md`), plan(`Done ${n}`, 'Complete'));
  regenerate(repo, { oldCountsLine });
  commitAll(repo, 'base');
  sh(repo, 'branch', '-M', 'main');

  git(repo, 'checkout', '-q', '-b', 'adds-active');
  fs.writeFileSync(path.join(repo, 'docs/plans/draft-new.md'), plan('Draft new', 'Draft'));
  regenerate(repo, { oldCountsLine });
  commitAll(repo, 'add an active plan');

  git(repo, 'checkout', '-q', 'main');
  git(repo, 'checkout', '-q', '-b', 'adds-terminal');
  fs.writeFileSync(path.join(repo, 'docs/plans/done-new.md'), plan('Done new', 'Complete'));
  regenerate(repo, { oldCountsLine });
  commitAll(repo, 'add a terminal plan');
  return repo;
}

const mergeTree = (repo) => git(repo, 'merge-tree', '--write-tree', '--name-only', 'adds-active', 'adds-terminal');

test('two PRs adding an active and a terminal plan merge with no conflict in the plans index', () => {
  const repo = build({ oldCountsLine: false });
  try {
    const r = mergeTree(repo);
    assert.equal(r.status, 0, `the index must merge cleanly; merge-tree said:\n${r.stdout}`);
    // And the merged result is EXACTLY what the generator renders for the merged tree (still byte-checked, Category B):
    // materialise the merge as a commit, check it out, and run the generator's own --check over it. A clean merge that
    // dropped a row, duplicated a section or reordered would differ from the regeneration and fail here.
    const tree = r.stdout.split('\n')[0];
    const merged = git(repo, 'commit-tree', tree, '-p', 'adds-active', '-p', 'adds-terminal', '-m', 'merge').stdout.trim();
    sh(repo, 'checkout', '-q', '--detach', merged);
    const text = fs.readFileSync(path.join(repo, 'docs/plans/README.md'), 'utf8');
    assert.match(text, /draft-new\.md/);
    assert.match(text, /done-new\.md/);
    const check = spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: repo, encoding: 'utf8' });
    assert.equal(check.status, 0, `the merged index is not what the generator renders for the merged tree:\n${check.stderr}`);
  } finally { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});

test('NEGATIVE CONTROL: with the pre-fix counts line the same two branches DO conflict, on that line only', () => {
  const repo = build({ oldCountsLine: true });
  try {
    const r = mergeTree(repo);
    assert.equal(r.status, 1, 'the fixture must reproduce the conflict, or the test above proves nothing');
    assert.match(r.stdout, /docs\/plans\/README\.md/);
    const tree = r.stdout.split('\n')[0];
    const body = git(repo, 'show', `${tree}:docs/plans/README.md`).stdout;
    const hunks = [...body.matchAll(/<<<<<<<[^\n]*\n([\s\S]*?)>>>>>>>/g)];
    assert.equal(hunks.length, 1, 'exactly one conflicted hunk');
    assert.match(hunks[0][1], /active ·/, 'and it is the counts line');
  } finally { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});

test('the rendered index carries no count of any kind (no "N active", no "Show all N …")', () => {
  const repo = build({ oldCountsLine: false });
  try {
    const text = fs.readFileSync(path.join(repo, 'docs/plans/README.md'), 'utf8');
    assert.doesNotMatch(text, /\d+ (active|terminal|audit summaries|reference docs)/);
    assert.doesNotMatch(text, /Show all \d+/, 'a count inside a <summary> is the same one-line conflict site');
  } finally { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});

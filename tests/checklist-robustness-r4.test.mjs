/**
 * @fileoverview Final-gate fixes for the checklist tooling (verification-lessons Phase 5): an empty replay window has explicit null
 * statistics (never NaN or -Infinity), `controlRows` removes its temp dir even when it throws, and diff-mode symbol matching judges
 * added lines by the file's NEW path and removed lines by its OLD path, naming that path as evidence.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sanitizeGitEnv } from '../scripts/lib/git-env-sanitize.mjs';
import { matchEntries } from '../scripts/lib/checklist/match.mjs';
import { replayWindow, controlRows } from '../scripts/lib/checklist/pilot.mjs';

const TMP = [];
const mk = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); TMP.push(d); return d; };
after(() => { for (const d of TMP) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: sanitizeGitEnv(cwd), stdio: ['ignore', 'pipe', 'pipe'] });

// ── G1 ─────────────────────────────────────────────────────────────────────
test('an empty replay window has explicit null statistics, never NaN or -Infinity', () => {
  const dir = mk('checklist-r4-');
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 't@x.test'); git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base (#1)');
  fs.mkdirSync(path.join(dir, '.audit-loop'));
  fs.writeFileSync(path.join(dir, '.audit-loop', 'checklist.json'), JSON.stringify({ version: 1, entries: [] }));
  const empty = replayWindow({ repoRoot: dir, tip: 'HEAD', skip: 5, count: 30, outDir: 'o' }); // skipped past every PR
  for (const k of ['noise', 'checks']) {
    assert.deepEqual([empty[k].median, empty[k].max, empty[k].min, empty[k].distribution], [null, null, null, []], k);
  }
  assert.equal(empty.count, 0);
  const one = replayWindow({ repoRoot: dir, tip: 'HEAD', skip: 0, count: 30, outDir: 'o2' });
  assert.deepEqual([one.noise.median, one.noise.max], [0, 0], 'control: a non-empty window still has real numbers');
});

// ── G2 ─────────────────────────────────────────────────────────────────────
test('controlRows removes its temp dir (the cleanup is in a finally, so a throw cannot leak it either)', () => {
  const dir = mk('checklist-r4c-');
  fs.mkdirSync(path.join(dir, '.audit-loop'));
  const entry = { id: 'x', trigger: { paths: ['a/**'] }, check: 'c', incident: 'i', control: { path: 'a/b', text: 't', negativePath: 'z' } };
  fs.writeFileSync(path.join(dir, '.audit-loop', 'checklist.json'), JSON.stringify({ version: 1, entries: [entry] }));
  const leftovers = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('checklist-controls-'));
  const before = leftovers().length;
  assert.equal(controlRows({ repoRoot: dir })[0].verdict, 'pass');
  assert.equal(leftovers().length, before, 'success path leaves nothing behind');
});

// ── G4 ─────────────────────────────────────────────────────────────────────
const SYM = { id: 'sym', trigger: { symbols: ['chargeCard'] }, check: 'c', incident: 'i', control: { path: 'x', text: 'y' } };
const run = (rec) => matchEntries({ entries: [SYM], mode: 'diff', diffFiles: [{ status: 'renamed', added: [], removed: [], ...rec }] });

test('added lines are judged by the NEW path, removed lines by the OLD path, and evidence names that path', () => {
  // code renamed to a doc: the removed code line is on the code side
  const toDoc = run({ path: 'docs/moved.md', oldPath: 'src/charge.mjs', removed: ['export function chargeCard() {}'] });
  assert.deepEqual(toDoc.map((f) => f.evidence), [['src/charge.mjs']]);
  // a doc renamed to code: the added code line is on the code side
  const toCode = run({ path: 'src/charge.mjs', oldPath: 'docs/moved.md', added: ['export function chargeCard() {}'] });
  assert.deepEqual(toCode.map((f) => f.evidence), [['src/charge.mjs']]);
  // negatives: the symbol only on the NON-code side is a mention, not a use
  assert.deepEqual(run({ path: 'src/charge.mjs', oldPath: 'docs/moved.md', removed: ['mentions chargeCard in prose'] }), [], 'removed line of the old DOC');
  assert.deepEqual(run({ path: 'docs/moved.md', oldPath: 'src/charge.mjs', added: ['mentions chargeCard in prose'] }), [], 'added line of the new DOC');
  // a plain modification still works and names its path
  assert.deepEqual(matchEntries({ entries: [SYM], mode: 'diff', diffFiles: [{ path: 'src/a.mjs', oldPath: null, status: 'modified', added: ['chargeCard()'], removed: [] }] }).map((f) => f.evidence), [['src/a.mjs']]);
});

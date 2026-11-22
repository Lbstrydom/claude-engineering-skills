/**
 * @fileoverview The checklist is a Category B generated artifact, and the pilot's figures are reproducible code
 * (verification-lessons Phase 5): regeneration is byte-identical, a hand edit or a drifted contract is detected, and the
 * replay / kernel measurements run from a pinned tip.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { sanitizeGitEnv } from '../scripts/lib/git-env-sanitize.mjs';
import { buildChecklistText } from '../scripts/lib/checklist/gen.mjs';
import { replayWindow, kernelEstimate } from '../scripts/lib/checklist/pilot.mjs';

// Every temp dir this file makes is removed when it finishes.
const TMP_DIRS = [];
function mkTmp(prefix) { const d = fs.mkdtempSync(prefix); TMP_DIRS.push(d); return d; }
after(() => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });


const REPO = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

// Gate contract: checklist-gen-check-detects-a-hand-edit (scripts/gate-contracts/checklist-gen-check.json)
test('regeneration is byte-identical to the committed .audit-loop/checklist.json', () => {
  assert.equal(buildChecklistText(REPO), read(path.join(REPO, '.audit-loop', 'checklist.json')));
});

test('the freshness check passes on the repo and the instrument is seen to fail on a drifted contract', () => {
  const ok = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'checklist-gen.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  // Negative control: a contract whose `stated` changed makes the regeneration differ (the entry quotes it), so a stale file is detected.
  const tmp = mkTmp(path.join(os.tmpdir(), 'checklist-gen-'));
  fs.cpSync(path.join(REPO, 'scripts', 'gate-contracts'), path.join(tmp, 'scripts', 'gate-contracts'), { recursive: true });
  fs.cpSync(path.join(REPO, 'skills', 'audit-code', 'gate-contract.json'), path.join(tmp, 'skills', 'audit-code', 'gate-contract.json'));
  const f = path.join(tmp, 'scripts', 'gate-contracts', 'stdout-flush-gate.json');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"stated": "An exit that stdout can reach must drain first"', '"stated": "An exit that stdout can reach must drain first, reworded"'));
  assert.notEqual(buildChecklistText(tmp), read(path.join(REPO, '.audit-loop', 'checklist.json')));
});

test('a prefix that matches no gate is an error, never a silently dropped entry', () => {
  const tmp = mkTmp(path.join(os.tmpdir(), 'checklist-gen-empty-'));
  fs.mkdirSync(path.join(tmp, 'scripts', 'gate-contracts'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'skills'), { recursive: true });
  assert.throws(() => buildChecklistText(tmp), /matches 0 gates/);
});

test('replayWindow takes PR squash commits first-parent from a pinned tip, honours skip, and counts every entry', () => {
  const dir = mkTmp(path.join(os.tmpdir(), 'checklist-replay-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: sanitizeGitEnv(dir) });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@x.test'); git('config', 'user.name', 't'); git('config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(dir, '.audit-loop'));
  const entry = { id: 'sql', trigger: { patterns: ['DROP TABLE'] }, check: 'c', incident: 'i', control: { path: 'a.sql', text: 'DROP TABLE x' } };
  fs.writeFileSync(path.join(dir, '.audit-loop', 'checklist.json'), JSON.stringify({ version: 1, entries: [entry] }));
  fs.writeFileSync(path.join(dir, 'a.sql'), 'SELECT 1;\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base (#1)');
  for (const [n, body] of [[2, 'DROP TABLE a;\n'], [3, 'SELECT 3;\n'], [4, 'SELECT 4;\n']]) {
    fs.appendFileSync(path.join(dir, 'a.sql'), body);
    git('commit', '-q', '-am', `change ${n} (#${n})`);
  }
  const tip = git('rev-parse', 'HEAD').trim();
  const out = path.join(dir, 'out');
  const w = replayWindow({ repoRoot: dir, tip, count: 2, outDir: out });
  assert.deepEqual(w.perPr.map((p) => p.pr), [4, 3]);
  assert.equal(w.noise.max, 0);
  const held = replayWindow({ repoRoot: dir, tip, skip: 2, count: 2, outDir: out });
  assert.deepEqual(held.perPr.map((p) => p.pr), [2, 1]);
  assert.deepEqual([held.perPr[0].firedCount, held.noise.max], [1, 1], 'the held-out window sees the DROP TABLE PR');
  assert.deepEqual(held.perPr.map((p) => p.pr).filter((pr) => w.perPr.some((q) => q.pr === pr)), [], 'the windows are disjoint');
});

test('kernelEstimate anchors every entry in AGENTS.md and the range is ordered', () => {
  const k = kernelEstimate({ repoRoot: REPO });
  assert.deepEqual(k.unanchored, []);
  assert.ok(k.kernelRemainingMin < k.kernelRemainingMax && k.kernelRemainingMax < k.agentsMdChars);
});

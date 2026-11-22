/**
 * @fileoverview Round-2 audit fixes for the checklist tooling (verification-lessons Phase 5): rename paths decode like headers,
 * supplementary Unicode survives, a hunk that disagrees with its counts is refused, `--confirmation` checks the checklist it was
 * GIVEN, `--verify-frozen` fails loudly, the backlink validator has no suffix fallback, replay paths resolve against the repo,
 * `..config.mjs` is in-repo, and the CLI runs from a real consumer bundle layout. Every temp dir is removed.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { sanitizeGitEnv } from '../scripts/lib/git-env-sanitize.mjs';
import { parseUnifiedDiff, unquoteGitPath, matchChecklist, readContained } from '../scripts/lib/checklist/match.mjs';
import { replayWindow } from '../scripts/lib/checklist/pilot.mjs';
import { validateCliGateContract } from '../scripts/lib/gate-honesty/schema.mjs';
import { getSyncClosure } from '../scripts/lib/sync-inventory.mjs';
import { sourceRelToDestRel } from '../scripts/lib/sync-path-map.mjs';
import { findNodeModules } from '../scripts/lib/node-modules-resolver.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const PILOT = path.join(REPO, 'scripts', 'checklist-pilot.mjs');
const TMP = [];
const mk = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); TMP.push(d); return d; };
after(() => { for (const d of TMP) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: sanitizeGitEnv(cwd), stdio: ['ignore', 'pipe', 'pipe'] });
function repo(files = { 'a.mjs': 'x\n' }) {
  const dir = mk('checklist-r2-');
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 't@x.test'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'core.autocrlf', 'false');
  for (const [p, b] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), b); }
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base (#1)');
  return dir;
}
const E = (id, trigger) => ({ id, trigger, check: `check ${id}`, incident: 'i', control: { path: 'x', text: 'y' } });

// ── item 1: rename paths decode like headers; supplementary Unicode ─────────
test('rename from / rename to decode git quoting exactly as the header does', () => {
  const diff = ['diff --git "a/caf\\303\\251.mjs" "b/t\\tab.mjs"', 'similarity index 100%', 'rename from "caf\\303\\251.mjs"', 'rename to "t\\tab.mjs"'].join('\n');
  const [f] = parseUnifiedDiff(diff);
  assert.deepEqual([f.path, f.oldPath, f.status], ['t\tab.mjs', 'café.mjs', 'renamed']);
});

test('a supplementary character (an emoji) survives, escaped as octal bytes or written literally', () => {
  assert.equal(unquoteGitPath('"\\360\\237\\230\\200.mjs"'), '😀.mjs');
  assert.equal(unquoteGitPath('"😀 x.mjs"'), '😀 x.mjs');
  assert.equal(unquoteGitPath('"a\\360\\237\\230\\200b\\tc.mjs"'), 'a😀b\tc.mjs');
  assert.equal(parseUnifiedDiff(['diff --git "a/\\360\\237\\230\\200.mjs" "b/\\360\\237\\230\\200.mjs"', '--- "a/\\360\\237\\230\\200.mjs"', '+++ "b/\\360\\237\\230\\200.mjs"', '@@ -1 +1 @@', '-a', '+b'].join('\n'))[0].path, '😀.mjs');
});

// ── item 3: a hunk that disagrees with its counts ───────────────────────────
test('a truncated patch, a short hunk and an over-long hunk are DIFF_UNPARSEABLE, never fewer lines read as complete', () => {
  const dir = repo();
  const head = ['diff --git a/a.mjs b/a.mjs', '--- a/a.mjs', '+++ b/a.mjs'];
  const cases = {
    truncated: [...head, '@@ -1,3 +1,3 @@', ' keep', '-old'],
    shortHunk: [...head, '@@ -1,2 +1,2 @@', '-old', '+new', 'garbage that is not a diff line'],
    tooLong: [...head, '@@ -1 +1 @@', '-old', '+new', '+an extra added line past the counts'],
  };
  for (const [name, lines] of Object.entries(cases)) {
    fs.writeFileSync(path.join(dir, `${name}.patch`), `${lines.join('\n')}\n`);
    const r = matchChecklist({ entries: [E('p', { paths: ['a.mjs'] })], diffPath: `${name}.patch`, purpose: 'test', cwd: dir, record: false });
    assert.deepEqual([name, r.ok, r.code], [name, false, 'DIFF_UNPARSEABLE'], JSON.stringify(r));
  }
  // control: the same hunk, complete, parses
  fs.writeFileSync(path.join(dir, 'ok.patch'), `${[...head, '@@ -1,2 +1,2 @@', ' keep', '-old', '+new'].join('\n')}\n`);
  assert.equal(matchChecklist({ entries: [E('p', { paths: ['a.mjs'] })], diffPath: 'ok.patch', purpose: 'test', cwd: dir, record: false }).ok, true);
  assert.throws(() => parseUnifiedDiff([...head, '@@ -1,3 +1,3 @@', ' keep'].join('\n')), /truncated/);
});

// ── items 2 and 4: --confirmation and --verify-frozen ──────────────────────
test('--verify-frozen exits non-zero on any mismatch and zero when the instrument is the frozen one', () => {
  const ok = spawnSync(process.execPath, [PILOT, '--verify-frozen', '--json'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout);
  const empty = mk('checklist-nofreeze-');
  const bad = spawnSync(process.execPath, [PILOT, '--verify-frozen', '--json'], { cwd: empty, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).ok, false);
});

test('--confirmation verifies the checklist it was GIVEN: a custom, non-frozen checklist is refused', () => {
  const out = mk('checklist-conf-');
  const custom = path.join(out, 'custom.json');
  fs.writeFileSync(custom, JSON.stringify({ version: 1, entries: [E('x', { paths: ['a'] })] }));
  const r = spawnSync(process.execPath, [PILOT, '--replay', '--confirmation', '--tip', 'HEAD', '--count', '1', '--checklist', custom, '--out-dir', path.join(out, 'o')], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refused: the instrument is not the frozen one \(checklist differ/);
  const ok = spawnSync(process.execPath, [PILOT, '--replay', '--confirmation', '--tip', execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(), '--skip', String(execFileSync('git', ['log', '--first-parent', '--format=%s', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).split('\n').map((l) => /\(#(\d+)\)$/.exec(l)?.[1]).filter(Boolean).map(Number).findIndex((n) => n < 380)), '--count', '1', '--out-dir', path.join(out, 'o2')], { cwd: REPO, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(spawnSync(process.execPath, [PILOT, '--kernel', '--confirmation'], { cwd: REPO, encoding: 'utf8' }).status, 2, '--confirmation only applies to --replay');
});

// ── item 5: no suffix fallback at the validator ─────────────────────────────
test('a checklist-backed gate validated WITHOUT the contract file is refused, never matched by suffix', () => {
  const root = mk('gh-r2-');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'impl.mjs'), '//\n'); fs.writeFileSync(path.join(root, 'tests', 't.test.mjs'), '// gate-x\n');
  fs.mkdirSync(path.join(root, '.audit-loop'));
  fs.writeFileSync(path.join(root, '.audit-loop', 'checklist.json'), JSON.stringify({ version: 1, entries: [{ id: 'e1', trigger: { paths: ['a'] }, check: 'the sentence here', incident: 'i', control: { path: 'a', text: 't' }, gateContract: 'scripts/gate-contracts/mine.json#gate-x', stated: 'the sentence here' }] }));
  const contract = { version: 1, gate: 'demo:gate', guards: 'x', gates: [{ id: 'gate-x', kind: 'executable', statedIn: '.audit-loop/checklist.json#e1', stated: 'the sentence here', implementation: 'scripts/impl.mjs', tests: ['tests/t.test.mjs'], proof: 'process', oracle: 'poison-pill', poisonPill: { isolation: 'tmpdir', argv: ['x.mjs'], mutate: { 'scripts/impl.mjs': { path: 'a', value: 1 } }, expectStderr: 'boom', why: 'demo' } }] };
  const r = validateCliGateContract(contract, root);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /needs the contract's file/);
  assert.equal(validateCliGateContract(contract, root, { file: 'scripts/gate-contracts/mine.json' }).ok, true);
});

// ── item 6: outDir resolves against repoRoot ────────────────────────────────
test('replay resolves a relative outDir against the repo being replayed, not the caller\'s cwd', () => {
  const dir = repo({ 'a.sql': 'DROP TABLE t;\n' });
  fs.mkdirSync(path.join(dir, '.audit-loop'));
  fs.writeFileSync(path.join(dir, '.audit-loop', 'checklist.json'), JSON.stringify({ version: 1, entries: [E('sql', { patterns: ['DROP TABLE'] })] }));
  const stray = path.join(process.cwd(), 'rel-out-r2');
  replayWindow({ repoRoot: dir, tip: 'HEAD', count: 1, outDir: 'rel-out-r2' });
  assert.equal(fs.existsSync(path.join(dir, 'rel-out-r2', 'fires.jsonl')), true);
  assert.equal(fs.existsSync(stray), false, 'nothing was written under the caller\'s cwd');
});

// ── item 7: containment by path segment ─────────────────────────────────────
test('a file named `..config.mjs` is inside the repo; a real escape is not', () => {
  const dir = repo({ '..config.mjs': 'chargeCard\n' });
  assert.equal(readContained(dir, '..config.mjs').body, 'chargeCard\n');
  assert.deepEqual(readContained(dir, '../outside.mjs'), { skip: 'absent' });
});

// ── item 8: the CLI from a real consumer bundle layout ─────────────────────
test('the synced CLI runs from a staged consumer layout (scripts/.claude-skills/), with an absent checklist', (t) => {
  const consumer = mk('checklist-consumer-layout-');
  git(consumer, 'init', '-q');
  const { files } = getSyncClosure();
  // `scripts/.sync-manifest.json` is in the closure but is GENERATED at sync time and gitignored (Category A): it exists on a developer's
  // disk and is absent from a clean CI checkout. Anything else missing is a real defect, so the set is asserted, not skipped silently.
  const GENERATED_AT_SYNC = new Set(['scripts/.sync-manifest.json']);
  const missing = files.filter((src) => !fs.existsSync(path.join(REPO, src)));
  assert.deepEqual(missing.filter((m) => !GENERATED_AT_SYNC.has(m)), [], 'only sync-time generated assets may be absent from the source tree');
  for (const src of files.filter((f) => !missing.includes(f))) {
    const dest = path.join(consumer, sourceRelToDestRel(src));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(REPO, src), dest);
  }
  const link = path.join(consumer, 'node_modules');
  try { fs.symlinkSync(findNodeModules(REPO), link, 'junction'); } catch { t.skip('cannot link node_modules into the staged consumer'); return; }
  const cli = path.join(consumer, 'scripts', '.claude-skills', 'checklist.mjs');
  assert.equal(fs.existsSync(cli), true, 'the CLI landed where a consumer would find it');
  const r = spawnSync(process.execPath, [cli, '--files', 'src/a.mjs', '--json', '--no-record'], { cwd: consumer, encoding: 'utf8', env: sanitizeGitEnv(consumer) });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([JSON.parse(r.stdout).absent, JSON.parse(r.stdout).fired.length], [true, 0]);
  assert.equal(fs.existsSync(path.join(consumer, '.audit-loop', 'checklist.json')), false, 'CES\'s own rules were not staged');
});

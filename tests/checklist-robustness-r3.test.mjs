/**
 * @fileoverview Round-3 audit fixes for the checklist tooling (verification-lessons Phase 5): the matcher's own git diff is pinned to
 * `a/` `b/` headers and any other prefix is refused, a malformed hunk header is refused (counts are never defaulted), a binary record
 * or a NUL-bearing untracked file makes the evaluation INCOMPLETE, loader paths derive from the supplied roots, and a dangling ANCESTOR
 * symlink is not an empty checklist. Every temp dir is removed.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sanitizeGitEnv } from '../scripts/lib/git-env-sanitize.mjs';
import { parseUnifiedDiff, matchChecklist } from '../scripts/lib/checklist/match.mjs';
import { loadChecklist } from '../scripts/lib/checklist/schema.mjs';
import { loadCliGateContracts } from '../scripts/lib/gate-honesty/loader.mjs';

const TMP = [];
const mk = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); TMP.push(d); return d; };
after(() => { for (const d of TMP) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: sanitizeGitEnv(cwd), stdio: ['ignore', 'pipe', 'pipe'] });
function repo(files = { 'a.mjs': 'x\n' }) {
  const dir = mk('checklist-r3-');
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 't@x.test'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'core.autocrlf', 'false');
  for (const [p, b] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), b); }
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base (#1)');
  return dir;
}
const E = (id, trigger) => ({ id, trigger, check: `check ${id}`, incident: 'i', control: { path: 'x', text: 'y' } });
const PATH_E = E('by-path', { paths: ['src/**'] });
const run = (dir, patchName, text, entries = [PATH_E]) => {
  fs.writeFileSync(path.join(dir, patchName), text);
  return matchChecklist({ entries, diffPath: patchName, purpose: 'test', cwd: dir, record: false });
};

// ── H1: prefixes ───────────────────────────────────────────────────────────
test('the matcher\'s own git diff is pinned to a/ b/ headers even when the developer\'s config says otherwise', () => {
  const dir = repo({ 'src/x.mjs': 'a\n' });
  git(dir, 'config', 'diff.mnemonicPrefix', 'true');
  fs.writeFileSync(path.join(dir, 'src/x.mjs'), 'a\nb\n');
  assert.match(git(dir, 'diff', 'HEAD'), /diff --git c\/src\/x\.mjs w\/src\/x\.mjs/, 'precondition: git really wrote mnemonic prefixes');
  const r = matchChecklist({ entries: [PATH_E], base: 'HEAD', purpose: 'test', cwd: dir, record: false });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.fired.map((f) => f.id), ['by-path']);
  git(dir, 'config', 'diff.noprefix', 'true');
  assert.deepEqual(matchChecklist({ entries: [PATH_E], base: 'HEAD', purpose: 'test', cwd: dir, record: false }).fired.map((f) => f.id), ['by-path']);
});

test('a --diff-file written with other prefixes is DIFF_UNPARSEABLE, never silently mis-parsed', () => {
  const dir = repo();
  for (const [name, header] of [['mnemonic', 'diff --git c/src/x.mjs w/src/x.mjs'], ['noprefix', 'diff --git src/x.mjs src/x.mjs']]) {
    const r = run(dir, `${name}.patch`, `${header}\n--- c/src/x.mjs\n+++ w/src/x.mjs\n@@ -1 +1 @@\n-a\n+b\n`);
    assert.deepEqual([name, r.ok, r.code], [name, false, 'DIFF_UNPARSEABLE']);
    assert.match(r.message, /unsupported diff path prefixes/);
  }
  assert.equal(run(dir, 'good.patch', 'diff --git a/src/x.mjs b/src/x.mjs\n--- a/src/x.mjs\n+++ b/src/x.mjs\n@@ -1 +1 @@\n-a\n+b\n').ok, true);
});

// ── H2: hunk headers ───────────────────────────────────────────────────────
test('a malformed hunk header is DIFF_UNPARSEABLE; counts are never defaulted to zero', () => {
  const dir = repo();
  const head = 'diff --git a/src/x.mjs b/src/x.mjs\n--- a/src/x.mjs\n+++ b/src/x.mjs\n';
  for (const [name, hunk] of [['short', '@@ -1 +1\n-a\n+b\n'], ['noEnd', '@@ -1,1 +1,1\n-a\n+b\n'], ['junk', '@@ garbage @@\n-a\n+b\n']]) {
    const r = run(dir, `${name}.patch`, head + hunk);
    assert.deepEqual([name, r.ok, r.code], [name, false, 'DIFF_UNPARSEABLE']);
    assert.match(r.message, /malformed hunk header/);
  }
  assert.throws(() => parseUnifiedDiff('@@ -1 +1 @@\n-a\n+b\n'), /malformed hunk header/, 'a hunk with no file record');
  assert.equal(run(dir, 'fine.patch', `${head}@@ -1 +1 @@\n-a\n+b\n`).ok, true, 'control: the well-formed header parses');
});

// ── H3 / M3: binary ────────────────────────────────────────────────────────
test('a binary diff record, and an untracked file containing NUL, make the evaluation INCOMPLETE and name the file', () => {
  const dir = repo({ 'img.bin': Buffer.from([0, 1, 2, 3]) });
  fs.writeFileSync(path.join(dir, 'img.bin'), Buffer.from([0, 9, 9, 9, 9]));
  const changed = matchChecklist({ entries: [PATH_E], base: 'HEAD', purpose: 'test', cwd: dir, record: false });
  assert.deepEqual([changed.ok, changed.code, changed.incomplete], [false, 'INCOMPLETE', [{ path: 'img.bin', reason: 'binary' }]]);
  git(dir, 'checkout', '--', 'img.bin');
  fs.writeFileSync(path.join(dir, 'src.mjs'), Buffer.concat([Buffer.from('chargeCard\n'), Buffer.from([0]), Buffer.from('DROP TABLE x\n')]));
  const untracked = matchChecklist({ entries: [E('p', { patterns: ['DROP TABLE'] })], base: 'HEAD', purpose: 'test', cwd: dir, record: false });
  assert.deepEqual([untracked.ok, untracked.code, untracked.incomplete.map((i) => i.path)], [false, 'INCOMPLETE', ['src.mjs']]);
  const held = run(dir, 'bin.patch', 'diff --git a/img.bin b/img.bin\nindex 1..2 100644\nBinary files a/img.bin and b/img.bin differ\n');
  assert.deepEqual([held.ok, held.code, held.incomplete], [false, 'INCOMPLETE', [{ path: 'img.bin', reason: 'binary' }]]);
  fs.rmSync(path.join(dir, 'src.mjs'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  assert.equal(matchChecklist({ entries: [PATH_E], base: 'HEAD', purpose: 'test', cwd: dir, record: false }).ok, true, 'control: a clean tree evaluates');
});

// ── M4: paths derive from the supplied roots ───────────────────────────────
test('the contract file named in the backlink is derived from the supplied contractsRoot, not a hard-coded layout', () => {
  const root = mk('gh-r3-');
  fs.mkdirSync(path.join(root, 'custom', 'contracts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'impl.mjs'), '//\n'); fs.writeFileSync(path.join(root, 'tests', 't.test.mjs'), '// gate-x\n');
  const entry = (gc) => ({ id: 'e1', trigger: { paths: ['a'] }, check: 'the sentence here', incident: 'i', control: { path: 'a', text: 't' }, gateContract: gc, stated: 'the sentence here' });
  fs.mkdirSync(path.join(root, '.audit-loop'));
  const contract = { version: 1, gate: 'demo:gate', guards: 'x', gates: [{ id: 'gate-x', kind: 'executable', statedIn: '.audit-loop/checklist.json#e1', stated: 'the sentence here', implementation: 'scripts/impl.mjs', tests: ['tests/t.test.mjs'], proof: 'process', oracle: 'poison-pill', poisonPill: { isolation: 'tmpdir', argv: ['x.mjs'], mutate: { 'scripts/impl.mjs': { path: 'a', value: 1 } }, expectStderr: 'boom', why: 'demo' } }] };
  fs.writeFileSync(path.join(root, 'custom', 'contracts', 'demo-gate.json'), JSON.stringify(contract));
  const load = () => loadCliGateContracts({ contractsRoot: path.join(root, 'custom', 'contracts'), repoRoot: root });
  fs.writeFileSync(path.join(root, '.audit-loop', 'checklist.json'), JSON.stringify({ version: 1, entries: [entry('custom/contracts/demo-gate.json#gate-x')] }));
  assert.deepEqual(load().divergences, []);
  fs.writeFileSync(path.join(root, '.audit-loop', 'checklist.json'), JSON.stringify({ version: 1, entries: [entry('scripts/gate-contracts/demo-gate.json#gate-x')] }));
  assert.match(load().divergences.join(' '), /not bound back to this gate/, 'the hard-coded layout is no longer what satisfies the backlink');
});

// ── M1: dangling ancestor ──────────────────────────────────────────────────
test('ENOENT is empty only when no path component is a broken symlink: a dangling ANCESTOR is an error', (t) => {
  const dir = repo();
  assert.deepEqual(loadChecklist({ repoRoot: dir }), { ok: true, entries: [], absent: true }, 'a missing .audit-loop directory is simply no checklist');
  fs.mkdirSync(path.join(dir, '.audit-loop'));
  assert.equal(loadChecklist({ repoRoot: dir }).absent, true, 'an existing directory with no file is no checklist');
  fs.rmdirSync(path.join(dir, '.audit-loop'));
  try { fs.symlinkSync(path.join(dir, 'nowhere'), path.join(dir, '.audit-loop'), 'junction'); } catch { t.skip('cannot create a directory link here'); return; }
  // A junction to a missing target is a dangling ancestor on every platform that can make one.
  const r = loadChecklist({ repoRoot: dir });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /points nowhere/);
});

// ── replay: an INCOMPLETE PR is said on its row, never aborts the window ────
test('the replay records a PR whose diff has a binary file as incomplete instead of aborting', async () => {
  const { replayWindow } = await import('../scripts/lib/checklist/pilot.mjs');
  const dir = repo({ 'a.mjs': 'x\n' });
  fs.mkdirSync(path.join(dir, '.audit-loop'));
  fs.writeFileSync(path.join(dir, '.audit-loop', 'checklist.json'), JSON.stringify({ version: 1, entries: [E('any', { paths: ['**'] })] }));
  fs.writeFileSync(path.join(dir, 'img.bin'), Buffer.from([0, 1, 2]));
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'add a binary (#2)');
  const w = replayWindow({ repoRoot: dir, tip: 'HEAD', count: 2, outDir: 'out' });
  assert.deepEqual(w.incompletePrs, [2]);
  assert.deepEqual(w.perPr.map((p) => p.pr), [2, 1]);
});

/**
 * @fileoverview Round-1 audit fixes for the checklist tooling (verification-lessons Phase 5) plus the observe-only shipping
 * decision: an incomplete evaluation is never ok, ENOENT is empty only for the default path, git-quoted and plain diffs parse,
 * empty argv values are errors, containment is on the realpath, the audit injects only under AUDIT_CHECKLIST_INJECT=1, and an
 * unmeasured evaluation is said, never silent. Every temp dir is removed.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { sanitizeGitEnv } from '../scripts/lib/git-env-sanitize.mjs';
import { parseUnifiedDiff, unquoteGitPath, matchChecklist, matchEntries, readContained } from '../scripts/lib/checklist/match.mjs';
import { loadChecklist } from '../scripts/lib/checklist/schema.mjs';
import { getChecklistContext, withChecklistBlock, INJECT_ENV } from '../scripts/lib/checklist/context.mjs';
import { replayWindow, sha256File } from '../scripts/lib/checklist/pilot.mjs';
import { validateCliGateContract } from '../scripts/lib/gate-honesty/schema.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const CLI = path.join(REPO, 'scripts', 'checklist.mjs');
const TMP = [];
const mk = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP.push(d); return d; };
after(() => { for (const d of TMP) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: sanitizeGitEnv(cwd), stdio: ['ignore', 'pipe', 'pipe'] });
function repo(files = { 'a.mjs': 'x\n' }) {
  const dir = mk('checklist-rb-');
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 't@x.test'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'core.autocrlf', 'false');
  for (const [p, b] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), b); }
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base (#1)');
  return dir;
}
const E = (id, trigger) => ({ id, trigger, check: `check ${id}`, incident: 'i', control: { path: 'x', text: 'y' } });
const SYM = E('sym', { symbols: ['chargeCard'] });
const writeChecklist = (dir, entries) => { fs.mkdirSync(path.join(dir, '.audit-loop'), { recursive: true }); fs.writeFileSync(path.join(dir, '.audit-loop', 'checklist.json'), JSON.stringify({ version: 1, entries })); };
function trySymlink(target, link) { try { fs.symlinkSync(target, link); return true; } catch { return false; } }
const cli = (cwd, ...a) => { const r = spawnSync(process.execPath, [CLI, ...a], { cwd, encoding: 'utf8', env: sanitizeGitEnv(cwd) }); return { code: r.status, out: r.stdout, err: r.stderr }; };

// ── item 1: an incomplete evaluation is never ok ────────────────────────────
test('an oversized untracked file makes --diff INCOMPLETE, naming it, never ok with empty lines', () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'huge.mjs'), 'x'.repeat(2 * 1024 * 1024 + 10));
  const r = matchChecklist({ entries: [SYM], base: 'HEAD', purpose: 'test', cwd: dir, record: false });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INCOMPLETE');
  assert.deepEqual(r.incomplete, [{ path: 'huge.mjs', reason: 'oversize' }]);
  assert.match(r.message, /huge\.mjs \(oversize\)/);
  const viaCli = cli(dir, '--diff', 'HEAD', '--no-record');
  assert.equal(viaCli.code, 2);
  assert.match(viaCli.err, /INCOMPLETE/);
});

test('--files: an existing code file too large to read for symbols is INCOMPLETE; a file that does not exist yet is not', () => {
  const dir = repo({ 'big.mjs': 'y'.repeat(2 * 1024 * 1024 + 10) });
  const big = matchChecklist({ entries: [SYM], files: ['big.mjs'], purpose: 'test', cwd: dir, record: false });
  assert.deepEqual([big.ok, big.code], [false, 'INCOMPLETE']);
  assert.equal(matchChecklist({ entries: [SYM], files: ['not-yet.mjs'], purpose: 'test', cwd: dir, record: false }).ok, true);
  // No symbol entry: nothing is read, so nothing can be incomplete.
  assert.equal(matchChecklist({ entries: [E('p', { paths: ['big.mjs'] })], files: ['big.mjs'], purpose: 'test', cwd: dir, record: false }).ok, true);
});

test('an incomplete evaluation is still recorded, with the count', () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'huge.mjs'), 'x'.repeat(2 * 1024 * 1024 + 10));
  const log = path.join(dir, 'l.jsonl');
  matchChecklist({ entries: [SYM], base: 'HEAD', purpose: 'test', cwd: dir, logPath: log });
  assert.equal(JSON.parse(fs.readFileSync(log, 'utf8').trim()).incomplete, 1);
});

// ── item 1b / H7: unmeasured is said ───────────────────────────────────────
test('an invalid checklist or unreadable diff is `unmeasured` on the audit context, never a silent skip', () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, '.audit-loop'));
  fs.writeFileSync(path.join(dir, '.audit-loop', 'checklist.json'), '{ nope');
  const ctx = {};
  assert.equal(withChecklistBlock('RUBRIC', { targetPaths: ['a.mjs'], baseDir: dir }, ctx, { [INJECT_ENV]: '1' }), 'RUBRIC');
  assert.equal(ctx.checklist, 'unmeasured');
  writeChecklist(dir, [SYM]);
  const ctx2 = {};
  withChecklistBlock('R', { targetPaths: ['a.mjs'], diffFile: 'missing.patch', baseDir: dir }, ctx2, {});
  assert.equal(ctx2.checklist, 'unmeasured');
  const ctx3 = {};
  withChecklistBlock('R', { targetPaths: ['a.mjs'], baseDir: dir, logPath: path.join(dir, 'l.jsonl') }, ctx3, {});
  assert.equal(ctx3.checklist, 'measured');
  const ctx4 = {};
  withChecklistBlock('R', { targetPaths: ['a.mjs'], baseDir: repo() }, ctx4, {});
  assert.equal(ctx4.checklist, 'absent');
});

// ── A: observe-only by default ─────────────────────────────────────────────
test('the checklist file is present, the flag is unset: the prompt is BYTE-IDENTICAL and the fires are still recorded', () => {
  const dir = repo({ 'src/billing/x.mjs': 'export function chargeCard() {}\n' });
  writeChecklist(dir, [E('by-path', { paths: ['src/billing/**'] })]);
  const log = path.join(dir, 'fires.jsonl');
  const args = { targetPaths: ['src/billing/x.mjs'], baseDir: dir, logPath: log };
  assert.equal(withChecklistBlock('RUBRIC', args, {}, {}), 'RUBRIC', 'unset: byte-identical');
  assert.equal(withChecklistBlock('RUBRIC', args, {}, { [INJECT_ENV]: '0' }), 'RUBRIC', 'only the exact value 1 injects');
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].purpose, rows[0].fired], ['operational', ['by-path']], 'fire-logging stays on');
  const injected = withChecklistBlock('RUBRIC', args, {}, { [INJECT_ENV]: '1' });
  assert.ok(injected.startsWith('RUBRIC\n\n<checklist>') && injected.includes('[by-path]'));
});

// ── item 2: ENOENT ─────────────────────────────────────────────────────────
test('ENOENT is an empty checklist ONLY for the default path with nothing there', () => {
  const dir = repo();
  assert.deepEqual(loadChecklist({ repoRoot: dir }), { ok: true, entries: [], absent: true });
  const explicit = loadChecklist({ repoRoot: dir, file: 'nope.json', explicit: true });
  assert.equal(explicit.ok, false);
  assert.equal(cli(dir, '--files', 'a.mjs', '--checklist', 'nope.json', '--no-record').code, 2);
  fs.mkdirSync(path.join(dir, '.audit-loop'));
  if (trySymlink(path.join(dir, 'gone.json'), path.join(dir, '.audit-loop', 'checklist.json'))) {
    assert.equal(loadChecklist({ repoRoot: dir }).ok, false, 'a dangling symlink is something, and it points nowhere');
  }
});

// ── item 3: diff parsing ───────────────────────────────────────────────────
test('git-quoted paths are decoded: octal bytes as UTF-8, tab, quote, backslash', () => {
  assert.equal(unquoteGitPath('"caf\\303\\251.mjs"'), 'café.mjs');
  assert.equal(unquoteGitPath('"a\\tb.mjs"'), 'a\tb.mjs');
  assert.equal(unquoteGitPath('"say \\"hi\\".mjs"'), 'say "hi".mjs');
  assert.equal(unquoteGitPath('"back\\\\slash.mjs"'), 'back\\slash.mjs');
  const diff = ['diff --git "a/caf\\303\\251 x.mjs" "b/caf\\303\\251 x.mjs"', '--- "a/caf\\303\\251 x.mjs"', '+++ "b/caf\\303\\251 x.mjs"', '@@ -1 +1 @@', '-a', '+b',
    'diff --git "a/t\\tab.mjs" "b/t\\tab.mjs"', 'new file mode 100644', '--- /dev/null', '+++ "b/t\\tab.mjs"', '@@ -0,0 +1 @@', '+c'].join('\n');
  assert.deepEqual(parseUnifiedDiff(diff).map((f) => [f.path, f.status]), [['café x.mjs', 'modified'], ['t\tab.mjs', 'added']]);
  assert.equal(matchEntries({ entries: [E('p', { paths: ['café*'] })], mode: 'diff', diffFiles: parseUnifiedDiff(diff) }).length, 1);
});

test('a real non-ASCII file through git with default quoting matches by its real name', () => {
  const dir = repo({ 'a.mjs': 'x\n' });
  fs.writeFileSync(path.join(dir, 'café.mjs'), 'chargeCard\n');
  git(dir, 'add', 'café.mjs');
  const quoted = git(dir, '-c', 'core.quotepath=true', 'diff', '--cached', '--unified=0');
  assert.match(quoted, /"b\/caf\\303\\251\.mjs"/, 'precondition: git really quoted it');
  assert.equal(parseUnifiedDiff(quoted)[0].path, 'café.mjs');
});

test('a plain unified diff (---/+++ only) parses; non-diff text is refused, never zero records as success', () => {
  const plain = ['--- a/src/x.mjs\t2026-01-01', '+++ b/src/x.mjs\t2026-01-02', '@@ -1 +1 @@', '-old', '+new', '--- a/src/y.mjs', '+++ b/src/y.mjs', '@@ -0,0 +1 @@', '+DROP TABLE y'].join('\n');
  assert.deepEqual(parseUnifiedDiff(plain).map((f) => [f.path, f.added.length]), [['src/x.mjs', 1], ['src/y.mjs', 1]]);
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'p.patch'), plain);
  assert.equal(matchChecklist({ entries: [E('pat', { patterns: ['DROP TABLE'] })], diffPath: 'p.patch', purpose: 'test', cwd: dir, record: false }).fired.length, 1);
  fs.writeFileSync(path.join(dir, 'junk.patch'), 'this is not a diff\njust some prose\n');
  const junk = matchChecklist({ entries: [SYM], diffPath: 'junk.patch', purpose: 'test', cwd: dir, record: false });
  assert.deepEqual([junk.ok, junk.code], [false, 'DIFF_UNPARSEABLE']);
});

test('diff-mode symbols consider BOTH rename endpoints', () => {
  const diffFiles = [{ path: 'docs/moved.md', oldPath: 'src/charge.mjs', status: 'renamed', added: [], removed: ['export function chargeCard() {}'] }];
  assert.equal(matchEntries({ entries: [SYM], mode: 'diff', diffFiles }).length, 1);
});

// ── item 4: empty argv values ──────────────────────────────────────────────
test('an empty --diff= / --diff-file= / --files= value is an argv error (exit 2)', () => {
  const dir = repo();
  for (const a of [['--diff='], ['--diff-file='], ['--files='], ['--diff', ''], ['--files', 'a.mjs', '--checklist=']]) {
    assert.equal(cli(dir, ...a, '--no-record').code, 2, a.join(' '));
  }
});

// ── item 5: realpath containment ───────────────────────────────────────────
test('a symlink resolving outside the repo is excluded and counted, never read', (t) => {
  const dir = repo();
  const outside = mk('checklist-outside-');
  fs.writeFileSync(path.join(outside, 'secret.mjs'), 'chargeCard\n');
  if (!trySymlink(path.join(outside, 'secret.mjs'), path.join(dir, 'link.mjs'))) { t.skip('this platform cannot create a symlink here'); return; }
  assert.deepEqual(readContained(dir, 'link.mjs'), { skip: 'outside-repo' });
  const files = matchChecklist({ entries: [SYM], files: ['link.mjs'], purpose: 'test', cwd: dir, record: false });
  assert.deepEqual([files.ok, files.fired.length, files.excluded], [true, 0, [{ path: 'link.mjs', reason: 'outside-repo' }]], 'the target\'s content was never read');
  const diff = matchChecklist({ entries: [SYM], base: 'HEAD', purpose: 'test', cwd: dir, record: false });
  assert.deepEqual([diff.ok, diff.fired.length, diff.excluded.map((x) => x.path)], [true, 0, ['link.mjs']]);
});

// ── item 6, 8 ──────────────────────────────────────────────────────────────
test('the replay records the sha256 of the checklist it used, and a root commit diffs against the empty tree', () => {
  const dir = repo({ 'a.sql': 'DROP TABLE t;\n' });
  writeChecklist(dir, [E('sql', { patterns: ['DROP TABLE'] })]);
  const w = replayWindow({ repoRoot: dir, tip: 'HEAD', count: 1, outDir: path.join(dir, 'out'), checklistFile: '.audit-loop/checklist.json' });
  assert.equal(w.checklistSha256, sha256File(path.join(dir, '.audit-loop', 'checklist.json')));
  assert.match(w.checklistSha256, /^[0-9a-f]{64}$/);
  assert.equal(w.perPr[0].firedCount, 1, 'the root commit was diffed against the empty tree');
  assert.throws(() => replayWindow({ repoRoot: dir, tip: 'no-such-tip', outDir: path.join(dir, 'o2') }));
});

// ── item 7 ─────────────────────────────────────────────────────────────────
test('the gate backlink is the FULL contract file + gate id, and the whole checklist file must pass the strict schema', () => {
  const root = mk('gh-rb-');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'impl.mjs'), '//\n'); fs.writeFileSync(path.join(root, 'tests', 't.test.mjs'), '// gate-x\n');
  const entry = (over = {}) => ({ id: 'e1', trigger: { paths: ['a'] }, check: 'the sentence here', incident: 'i', control: { path: 'a', text: 't' }, gateContract: 'scripts/gate-contracts/mine.json#gate-x', stated: 'the sentence here', ...over });
  const contract = { version: 1, gate: 'demo:gate', guards: 'x', gates: [{ id: 'gate-x', kind: 'executable', statedIn: '.audit-loop/checklist.json#e1', stated: 'the sentence here', implementation: 'scripts/impl.mjs', tests: ['tests/t.test.mjs'], proof: 'process', oracle: 'poison-pill', poisonPill: { isolation: 'tmpdir', argv: ['x.mjs'], mutate: { 'scripts/impl.mjs': { path: 'a', value: 1 } }, expectStderr: 'boom', why: 'demo' } }] };
  writeChecklist(root, [entry()]);
  assert.equal(validateCliGateContract(contract, root, { file: 'scripts/gate-contracts/mine.json' }).ok, true);
  const other = validateCliGateContract(contract, root, { file: 'scripts/gate-contracts/other.json' });
  assert.equal(other.ok, false, 'another contract with a gate of the same id must not satisfy the backlink');
  assert.match(other.errors.join(' '), /not bound back to this gate/);
  writeChecklist(root, [entry(), { id: 'broken' }]);
  const bad = validateCliGateContract(contract, root, { file: 'scripts/gate-contracts/mine.json' });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /fails the checklist schema/);
});

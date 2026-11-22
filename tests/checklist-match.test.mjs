/**
 * @fileoverview The diff-triggered checklist matcher (verification-lessons plan, section 2.5, Phase 5): both acquisition
 * modes, renames, deletions, untracked files, the zero-match record, an unresolvable base, the CLI's two-step contract, and
 * the audit-side block. Fixtures are throwaway git repos; nothing here touches the real fires log.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { sanitizeGitEnv } from '../scripts/lib/git-env-sanitize.mjs';
import { parseUnifiedDiff, matchEntries, matchChecklist, recordFires, renderChecklistBlock } from '../scripts/lib/checklist/match.mjs';
import { ChecklistFileSchema, loadChecklist } from '../scripts/lib/checklist/schema.mjs';
import { getChecklistContext, withChecklistBlock } from '../scripts/lib/checklist/context.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const CLI = path.join(REPO, 'scripts', 'checklist.mjs');

const entry = (id, trigger) => ({ id, trigger, check: `check ${id}`, incident: 'incident', control: { path: 'x', text: 'y' } });
const E_PATH = entry('by-path', { paths: ['src/billing/**'] });
const E_SYMBOL = entry('by-symbol', { symbols: ['chargeCard'] });
const E_PATTERN = entry('by-pattern', { patterns: ['\\bDROP TABLE\\b'] });
const ALL = [E_PATH, E_SYMBOL, E_PATTERN];

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: sanitizeGitEnv(cwd), stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checklist-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.test');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', 'false');
  for (const [p, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), body);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

const ids = (r) => r.fired.map((f) => f.id).sort();

describe('parseUnifiedDiff', () => {
  test('reads rename endpoints, deletions, new files, and does not mistake hunk content for headers', () => {
    const diff = [
      'diff --git a/old/name.mjs b/new/name.mjs',
      'similarity index 100%',
      'rename from old/name.mjs',
      'rename to new/name.mjs',
      'diff --git a/gone.mjs b/gone.mjs',
      'deleted file mode 100644',
      '--- a/gone.mjs',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-removed line',
      'diff --git a/fresh.mjs b/fresh.mjs',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/fresh.mjs',
      '@@ -0,0 +1,2 @@',
      '+++ not a header, this is content',
      '+second',
    ].join('\n');
    const files = parseUnifiedDiff(diff);
    assert.deepEqual(files.map((f) => [f.path, f.oldPath, f.status]), [
      ['new/name.mjs', 'old/name.mjs', 'renamed'], ['gone.mjs', null, 'deleted'], ['fresh.mjs', null, 'added'],
    ]);
    assert.deepEqual(files[1].removed, ['removed line']);
    assert.deepEqual(files[2].added, ['++ not a header, this is content', 'second']);
  });
});

describe('pre-edit mode (--files)', () => {
  test('matches paths, and symbols against the CURRENT on-disk content', () => {
    const dir = makeRepo({ 'src/billing/charge.mjs': 'export function chargeCard() {}\n', 'src/other.mjs': 'export function chargeCard() {}\n', 'notes.md': 'mentions chargeCard here\n' });
    const r = matchChecklist({ entries: ALL, files: ['src/billing/charge.mjs', 'src/other.mjs', 'notes.md'], purpose: 'test', cwd: dir, record: false });
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'files');
    assert.deepEqual(ids(r), ['by-path', 'by-symbol']);
    const sym = r.fired.find((f) => f.id === 'by-symbol');
    assert.ok(!sym.evidence.some((e) => e.includes('notes.md')), 'a markdown file that merely names a symbol is a mention, not a use');
  });

  test('a file that does not exist yet matches paths only; patterns are never used', () => {
    const dir = makeRepo({ 'a.mjs': 'x\n' });
    const r = matchChecklist({ entries: ALL, files: ['src/billing/new-file.mjs'], purpose: 'test', cwd: dir, record: false });
    assert.deepEqual(ids(r), ['by-path']);
    assert.equal(r.patternsSkipped, true);
    // Even a file that literally contains the pattern cannot fire a pattern-only entry before there is a diff.
    fs.writeFileSync(path.join(dir, 'danger.sql'), 'DROP TABLE users;\n');
    assert.deepEqual(ids(matchChecklist({ entries: [E_PATTERN], files: ['danger.sql'], purpose: 'test', cwd: dir, record: false })), []);
  });

  test('a path outside the repo is not read for symbols', () => {
    const dir = makeRepo({ 'a.mjs': 'x\n' });
    const outside = path.join(os.tmpdir(), `outside-${process.pid}.mjs`);
    fs.writeFileSync(outside, 'chargeCard\n');
    try {
      const r = matchChecklist({ entries: [E_SYMBOL], files: [path.relative(dir, outside)], purpose: 'test', cwd: dir, record: false });
      assert.deepEqual(ids(r), []);
    } finally { fs.rmSync(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

describe('post-edit mode (--diff <base>)', () => {
  test('staged rename: BOTH endpoints match paths; deleted file matches paths and its removed lines match patterns; untracked read whole', () => {
    const dir = makeRepo({
      'src/billing/legacy.mjs': 'export const a = 1;\n',
      'docs/old-name.md': '# doc\n',
      'db/schema.sql': 'DROP TABLE users;\n',
    });
    fs.mkdirSync(path.join(dir, 'lib'));
    git(dir, 'mv', 'src/billing/legacy.mjs', 'lib/renamed.mjs'); // staged rename OUT of the billing path
    git(dir, 'rm', '-q', 'db/schema.sql'); // staged delete: its removed line carries the pattern
    fs.writeFileSync(path.join(dir, 'untracked.mjs'), 'export function chargeCard() {}\n');
    const r = matchChecklist({ entries: ALL, base: 'HEAD', purpose: 'test', cwd: dir, record: false });
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'diff');
    assert.deepEqual(ids(r), ['by-path', 'by-pattern', 'by-symbol']);
    const byPath = r.fired.find((f) => f.id === 'by-path');
    assert.ok(byPath.evidence.includes('src/billing/legacy.mjs'), 'the rename SOURCE endpoint matched: moving a file out of a guarded path still fires');
    assert.ok(r.fired.find((f) => f.id === 'by-pattern').evidence[0].startsWith('db/schema.sql'), 'a removed line in a deleted file matched the pattern');
    assert.ok(r.fired.find((f) => f.id === 'by-symbol').evidence[0].startsWith('untracked.mjs'), 'an untracked file is read whole');
  });

  test('patterns run over added AND removed lines; an unstaged edit counts', () => {
    const dir = makeRepo({ 'a.sql': 'DROP TABLE one;\nSELECT 1;\n', 'b.sql': 'SELECT 2;\n' });
    fs.writeFileSync(path.join(dir, 'a.sql'), 'SELECT 1;\n'); // pattern only in a REMOVED line
    fs.writeFileSync(path.join(dir, 'b.sql'), 'SELECT 2;\nDROP TABLE two;\n'); // pattern in an ADDED line
    const r = matchChecklist({ entries: [E_PATTERN], base: 'HEAD', purpose: 'test', cwd: dir, record: false });
    assert.equal(r.fired[0].evidence.length, 2);
  });

  test('patternPaths scopes where a pattern counts: the same line in a markdown plan is a quotation, not a call', () => {
    const scoped = entry('scoped', { patterns: ['\\bprocess\\.exit\\('], patternPaths: ['scripts/*.mjs'] });
    const mk = (p) => [{ path: p, oldPath: null, status: 'modified', added: ['  process.exit(1);'], removed: [] }];
    assert.equal(matchEntries({ entries: [scoped], mode: 'diff', diffFiles: mk('scripts/cli.mjs') }).length, 1);
    assert.equal(matchEntries({ entries: [scoped], mode: 'diff', diffFiles: mk('docs/plans/x.md') }).length, 0);
    assert.equal(ChecklistFileSchema.safeParse({ version: 1, entries: [{ ...scoped, trigger: { paths: ['a'], patternPaths: ['b'] }, check: 'c', incident: 'i', control: { path: 'a', text: 't' } }] }).success, false, 'patternPaths without patterns is refused');
  });

  test('an unresolvable base is a structured failure, never "no matches", and records nothing', () => {
    const dir = makeRepo({ 'a.mjs': 'x\n' });
    const log = path.join(dir, 'fires.jsonl');
    const r = matchChecklist({ entries: ALL, base: 'no-such-ref', purpose: 'test', cwd: dir, logPath: log });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'UNRESOLVABLE_BASE');
    assert.equal(fs.existsSync(log), false);
  });

  test('--diff <file>: an unreadable unified-diff file is a structured failure', () => {
    const dir = makeRepo({ 'a.mjs': 'x\n' });
    const r = matchChecklist({ entries: ALL, diffPath: 'missing.patch', purpose: 'test', cwd: dir, record: false });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'DIFF_UNREADABLE');
  });

  test('--diff <file> matches what the same change fires through git (one matcher, one input)', () => {
    const dir = makeRepo({ 'src/billing/charge.mjs': 'x\n' });
    fs.writeFileSync(path.join(dir, 'src/billing/charge.mjs'), 'x\nDROP TABLE t;\n');
    const viaGit = matchChecklist({ entries: ALL, base: 'HEAD', purpose: 'test', cwd: dir, record: false });
    fs.writeFileSync(path.join(dir, 'change.patch'), git(dir, 'diff', 'HEAD'));
    const viaFile = matchChecklist({ entries: ALL, diffPath: 'change.patch', purpose: 'test', cwd: dir, record: false });
    assert.deepEqual(ids(viaFile), ids(viaGit));
    assert.deepEqual(ids(viaFile), ['by-path', 'by-pattern']);
  });
});

describe('recordFires', () => {
  test('every evaluation is appended, zero-match ones included, with the contracted row shape', () => {
    const dir = makeRepo({ 'a.mjs': 'x\n' });
    const log = path.join(dir, 'nested', 'fires.jsonl');
    const none = matchChecklist({ entries: ALL, files: ['a.mjs'], purpose: 'replay', cwd: dir, logPath: log, runId: 'run-0' });
    const some = matchChecklist({ entries: ALL, files: ['src/billing/x.mjs'], purpose: 'operational', cwd: dir, logPath: log, runId: 'run-1' });
    assert.equal(none.recorded && some.recorded, true);
    const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].runId, 'run-0');
    assert.deepEqual(rows[0].fired, [], 'the zero-match evaluation is on the record');
    assert.equal(rows[0].entriesEvaluated, 3);
    assert.equal(rows[0].purpose, 'replay');
    assert.match(rows[0].sha, /^[0-9a-f]{40}$/);
    assert.deepEqual(rows[1].fired, ['by-path']);
  });

  test('purpose is closed to operational|control|replay|test', () => {
    for (const purpose of ['operational', 'control', 'replay', 'test']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checklist-log-'));
      assert.equal(recordFires({ logPath: path.join(dir, 'l.jsonl'), runId: 'r', purpose, entriesEvaluated: 1, fired: [] }).recorded, true);
    }
    const bad = recordFires({ logPath: path.join(os.tmpdir(), 'never.jsonl'), runId: 'r', purpose: 'prod', entriesEvaluated: 1, fired: [] });
    assert.equal(bad.recorded, false);
    assert.equal(matchChecklist({ entries: ALL, files: [], purpose: 'prod', cwd: REPO }).ok, false);
  });

  test('a log that cannot be written never throws into the run', () => {
    const dir = makeRepo({ 'a.mjs': 'x\n' });
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'a file where a directory is needed');
    const r = matchChecklist({ entries: ALL, files: ['a.mjs'], purpose: 'test', cwd: dir, logPath: path.join(blocker, 'fires.jsonl') });
    assert.equal(r.ok, true);
    assert.equal(r.recorded, false);
  });
});

describe('CLI: the two-step contract (clean tree, then a planted change)', () => {
  function cli(cwd, ...args) {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: sanitizeGitEnv(cwd) });
    return { code: r.status, out: r.stdout, err: r.stderr };
  }

  test('--files on a clean tree fires the path and symbol entries and CANNOT fire the pattern entry; after a planted change --diff fires it', () => {
    const dir = makeRepo({ 'src/billing/charge.mjs': 'export function chargeCard() {}\n', 'db/migrate.sql': 'SELECT 1;\n' });
    fs.mkdirSync(path.join(dir, '.audit-loop'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.audit-loop', 'checklist.json'), JSON.stringify({ version: 1, entries: ALL }));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'add checklist');

    const pre = cli(dir, '--files', 'src/billing/charge.mjs,db/migrate.sql', '--json', '--purpose', 'test', '--no-record');
    assert.equal(pre.code, 0, pre.err);
    const preJson = JSON.parse(pre.out);
    assert.deepEqual(preJson.fired.map((f) => f.id).sort(), ['by-path', 'by-symbol']);
    assert.equal(preJson.patternsSkipped, true);

    fs.appendFileSync(path.join(dir, 'db', 'migrate.sql'), 'DROP TABLE users;\n'); // the planted change
    const post = cli(dir, '--diff', 'HEAD', '--json', '--purpose', 'test', '--no-record');
    assert.equal(post.code, 0, post.err);
    const postJson = JSON.parse(post.out);
    assert.deepEqual(postJson.fired.map((f) => f.id), ['by-pattern']);
    assert.equal(postJson.fired[0].check, 'check by-pattern');
  });

  test('--diff-file reads a held unified diff (a replayed PR, the audit own --diff) and fires patterns from it', () => {
    const dir = makeRepo({ 'db/migrate.sql': 'SELECT 1;\n' });
    fs.mkdirSync(path.join(dir, '.audit-loop'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.audit-loop', 'checklist.json'), JSON.stringify({ version: 1, entries: ALL }));
    fs.appendFileSync(path.join(dir, 'db', 'migrate.sql'), 'DROP TABLE users;\n');
    fs.writeFileSync(path.join(dir, 'held.patch'), git(dir, 'diff', 'HEAD'));
    git(dir, 'checkout', '--', 'db/migrate.sql'); // the working tree is clean again: only the held file carries the change
    const r = cli(dir, '--diff-file', 'held.patch', '--json', '--purpose', 'replay', '--no-record');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out).fired.map((f) => f.id), ['by-pattern']);
    assert.equal(cli(dir, '--diff-file', 'missing.patch', '--no-record').code, 2);
  });

  test('an unresolvable base exits 2 with the reason, not 0 with an empty result', () => {
    const dir = makeRepo({ 'a.mjs': 'x\n' });
    const r = cli(dir, '--diff', 'no-such-ref', '--no-record');
    assert.equal(r.code, 2);
    assert.match(r.err, /UNRESOLVABLE_BASE/);
  });

  test('usage errors exit 2: neither or both of --files/--diff, an unknown flag, a bad purpose', () => {
    const dir = makeRepo({ 'a.mjs': 'x\n' });
    assert.equal(cli(dir).code, 2);
    assert.equal(cli(dir, '--files', 'a', '--diff', 'HEAD').code, 2);
    assert.equal(cli(dir, '--files', 'a', '--bogus').code, 2);
    assert.equal(cli(dir, '--files', 'a', '--purpose', 'prod').code, 2);
  });

  test('an absent checklist is an empty checklist (the consumer starting state), an invalid one exits 2', () => {
    const dir = makeRepo({ 'a.mjs': 'x\n' });
    const empty = cli(dir, '--files', 'a.mjs', '--json', '--no-record');
    assert.equal(empty.code, 0);
    assert.deepEqual([JSON.parse(empty.out).absent, JSON.parse(empty.out).evaluated], [true, 0]);
    fs.mkdirSync(path.join(dir, '.audit-loop'));
    fs.writeFileSync(path.join(dir, '.audit-loop', 'checklist.json'), '{"version":1,"entries":[{"id":"x"}]}');
    assert.equal(cli(dir, '--files', 'a.mjs', '--no-record').code, 2);
  });

  test('--selfcheck-relocation prints OK and --help is a pure read', () => {
    const dir = makeRepo({ 'a.mjs': 'x\n' });
    assert.equal(cli(dir, '--selfcheck-relocation').out.trim(), 'OK');
    const h = cli(dir, '--help');
    assert.equal(h.code, 0);
    assert.equal(fs.existsSync(path.join(dir, '.audit')), false);
  });
});

describe('/audit-code integration (the <checklist> block)', () => {
  test('an ABSENT checklist leaves the rubric byte-identical and evaluates nothing', () => {
    const dir = makeRepo({ 'src/billing/x.mjs': 'x\n' });
    const log = path.join(dir, 'fires.jsonl');
    const ctx = getChecklistContext({ targetPaths: ['src/billing/x.mjs'], baseDir: dir, logPath: log });
    assert.deepEqual([ctx.block, ctx.absent, ctx.evaluated], ['', true, 0]);
    assert.equal(fs.existsSync(log), false, 'an absent file is unaffected: nothing evaluated, nothing recorded');
    assert.equal(withChecklistBlock('RUBRIC', { targetPaths: ['x'], baseDir: dir }), 'RUBRIC');
  });

  test('a fired entry appends a self-delimiting <checklist> block to the rubric; an invalid file warns and adds nothing', () => {
    const dir = makeRepo({ 'src/billing/x.mjs': 'x\n' });
    fs.mkdirSync(path.join(dir, '.audit-loop'));
    fs.writeFileSync(path.join(dir, '.audit-loop', 'checklist.json'), JSON.stringify({ version: 1, entries: ALL }));
    const out = withChecklistBlock('RUBRIC', { targetPaths: ['src/billing/x.mjs'], baseDir: dir });
    assert.ok(out.startsWith('RUBRIC\n\n<checklist>'));
    assert.match(out, /\[by-path\] check by-path/);
    assert.match(out, /<\/checklist>$/);
    assert.equal(withChecklistBlock('', { targetPaths: ['src/billing/x.mjs'], baseDir: dir }).startsWith('<checklist>'), true);
    // nothing fires: unchanged
    assert.equal(withChecklistBlock('RUBRIC', { targetPaths: ['unrelated.txt'], baseDir: dir }), 'RUBRIC');
    fs.writeFileSync(path.join(dir, '.audit-loop', 'checklist.json'), '{ not json');
    assert.equal(withChecklistBlock('RUBRIC', { targetPaths: ['src/billing/x.mjs'], baseDir: dir }), 'RUBRIC');
    assert.match(getChecklistContext({ targetPaths: ['x'], baseDir: dir }).warning, /not valid JSON/);
  });

  test('the audit uses --diff when it has one: a pattern fires from the audit\'s own diff file', () => {
    const dir = makeRepo({ 'db/m.sql': 'SELECT 1;\n' });
    fs.mkdirSync(path.join(dir, '.audit-loop'));
    fs.writeFileSync(path.join(dir, '.audit-loop', 'checklist.json'), JSON.stringify({ version: 1, entries: [E_PATTERN] }));
    fs.appendFileSync(path.join(dir, 'db/m.sql'), 'DROP TABLE users;\n');
    fs.writeFileSync(path.join(dir, 'audit.patch'), git(dir, 'diff', 'HEAD'));
    assert.equal(getChecklistContext({ targetPaths: ['db/m.sql'], baseDir: dir, logPath: path.join(dir, 'l.jsonl') }).firedCount, 0, 'files only: patterns cannot fire');
    assert.equal(getChecklistContext({ targetPaths: ['db/m.sql'], diffFile: 'audit.patch', baseDir: dir, logPath: path.join(dir, 'l.jsonl') }).firedCount, 1);
  });

  test('renderChecklistBlock is empty when nothing fired', () => {
    assert.equal(renderChecklistBlock([], ALL), '');
  });
});

describe('schema', () => {
  const good = { id: 'a-b', trigger: { paths: ['x/**'] }, check: 'c', incident: 'i', control: { path: 'x/y', text: 't' } };
  const parse = (e) => ChecklistFileSchema.safeParse({ version: 1, entries: [e] });
  test('is strict at every level and refuses an empty trigger, a bad regex, a stated the check does not carry, and duplicate ids', () => {
    assert.equal(parse(good).success, true);
    assert.equal(parse({ ...good, extra: 1 }).success, false);
    assert.equal(parse({ ...good, trigger: {} }).success, false);
    assert.equal(parse({ ...good, trigger: { patterns: ['('] } }).success, false);
    assert.equal(parse({ ...good, trigger: { paths: ['x'], extra: [] } }).success, false);
    assert.equal(parse({ ...good, control: { path: 'p', text: 't', extra: 1 } }).success, false);
    assert.equal(parse({ ...good, stated: 'not in check', gateContract: 'a.json#g' }).success, false);
    assert.equal(parse({ ...good, stated: 'c', gateContract: 'a.json#g' }).success, true);
    assert.equal(parse({ ...good, stated: 'c' }).success, false, 'stated without a gateContract binds nothing');
    assert.equal(ChecklistFileSchema.safeParse({ version: 1, entries: [good, good] }).success, false);
  });

  test('loadChecklist: absent is empty; present-but-broken is an error, never an empty result', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checklist-load-'));
    assert.deepEqual(loadChecklist({ repoRoot: dir }), { ok: true, entries: [], absent: true });
    fs.mkdirSync(path.join(dir, '.audit-loop'));
    fs.writeFileSync(path.join(dir, '.audit-loop', 'checklist.json'), '[]');
    assert.equal(loadChecklist({ repoRoot: dir }).ok, false);
  });
});

test('matchEntries is pure: the same input gives the same output and mutates nothing', () => {
  const diffFiles = [{ path: 'src/billing/a.mjs', oldPath: null, status: 'modified', added: ['DROP TABLE x'], removed: [] }];
  const snapshot = JSON.stringify([ALL, diffFiles]);
  const a = matchEntries({ entries: ALL, mode: 'diff', diffFiles });
  const b = matchEntries({ entries: ALL, mode: 'diff', diffFiles });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify([ALL, diffFiles]), snapshot);
});

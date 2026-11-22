/**
 * @fileoverview The fixes that would have let the FROZEN instrument report a wrong number during the later re-test (verification-lessons
 * Phase 5): an incomplete PR never enters the statistics, a zero-entry checklist still validates its diff and records, a patch cut off
 * after its headers is refused (while mode-only, pure-rename, binary and empty-file records stay valid), `--flag=value` works for every
 * value flag, a custom checklist path is explicit, and `--confirmation` refuses a moving tip and any window overlapping the seen ones.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { sanitizeGitEnv } from '../scripts/lib/git-env-sanitize.mjs';
import { parseUnifiedDiff } from '../scripts/lib/checklist/match.mjs';
import { loadChecklist } from '../scripts/lib/checklist/schema.mjs';
import { getChecklistContext } from '../scripts/lib/checklist/context.mjs';
import { replayWindow, kernelEstimate } from '../scripts/lib/checklist/pilot.mjs';
import { seenPrsIn, SEEN_WINDOWS } from '../scripts/lib/checklist/frozen.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const PILOT = path.join(REPO, 'scripts', 'checklist-pilot.mjs');
const CLI = path.join(REPO, 'scripts', 'checklist.mjs');
const TMP = [];
const mk = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); TMP.push(d); return d; };
after(() => { for (const d of TMP) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: sanitizeGitEnv(cwd), stdio: ['ignore', 'pipe', 'pipe'] });
function repo(files = { 'a.txt': 'x\n' }) {
  const dir = mk('checklist-r5-');
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 't@x.test'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'core.autocrlf', 'false');
  for (const [p, b] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), b); }
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base (#1)');
  return dir;
}
const writeChecklist = (dir, entries) => { fs.mkdirSync(path.join(dir, '.audit-loop'), { recursive: true }); fs.writeFileSync(path.join(dir, '.audit-loop', 'checklist.json'), JSON.stringify({ version: 1, entries })); };
const E = (id, trigger) => ({ id, trigger, check: `check ${id}`, incident: 'i', control: { path: 'x', text: 'y' } });

// ── 1: M1 / M9 ─────────────────────────────────────────────────────────────
test('a PR whose evaluation is INCOMPLETE is excluded from the statistics and from never-fired, and counted separately', () => {
  const dir = repo();
  writeChecklist(dir, [E('any', { paths: ['**'] }), E('imgonly', { paths: ['img.bin'] }), E('txtonly', { paths: ['n.txt'] })]);
  fs.writeFileSync(path.join(dir, 'img.bin'), Buffer.from([0, 1, 2]));
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'binary (#2)');
  fs.writeFileSync(path.join(dir, 'n.txt'), 'hello\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'text (#3)');
  const w = replayWindow({ repoRoot: dir, tip: 'HEAD', count: 3, outDir: 'o' });
  assert.deepEqual(w.incompletePrs, [2]);
  assert.equal(w.count, 3);
  assert.equal(w.scoredCount, 2, 'only the two complete PRs are scored');
  // PR #3 fires `any` + `txtonly`, PR #1 fires `any`; the incomplete PR #2 (which would have fired `any` + `imgonly`) is in neither number.
  assert.deepEqual(w.noise.distribution, [1, 2]);
  assert.ok(w.neverFired.includes('imgonly'), 'an entry that only fired on the incomplete PR is NOT credited with having fired');
  assert.equal(w.entryRows.find((e) => e.id === 'any').firedOnPrs.includes(2), false);
});

// ── 2: M4 / M16 ────────────────────────────────────────────────────────────
test('a checklist with zero entries still validates the supplied diff and still writes the zero-match record', () => {
  const dir = repo();
  writeChecklist(dir, []);
  const unreadable = getChecklistContext({ targetPaths: ['a.txt'], diffFile: 'missing.patch', baseDir: dir });
  assert.equal(unreadable.status, 'unmeasured');
  assert.match(unreadable.warning, /DIFF_UNREADABLE/);
  fs.writeFileSync(path.join(dir, 'ok.patch'), 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+y\n');
  const log = path.join(dir, 'fires.jsonl');
  const ok = getChecklistContext({ targetPaths: ['a.txt'], diffFile: 'ok.patch', baseDir: dir, logPath: log });
  assert.deepEqual([ok.status, ok.evaluated], ['measured', 0]);
  const row = JSON.parse(fs.readFileSync(log, 'utf8').trim());
  assert.deepEqual([row.entriesEvaluated, row.fired, row.purpose], [0, [], 'operational']);
  const cli = spawnSync(process.execPath, [CLI, '--diff-file', 'missing.patch', '--no-record'], { cwd: dir, encoding: 'utf8', env: sanitizeGitEnv(dir) });
  assert.equal(cli.status, 2, 'the CLI refuses an unreadable diff even with an empty checklist');
});

// ── 3: H1 / M14 ────────────────────────────────────────────────────────────
test('a patch cut off after its headers, for a file that changed, is refused; records git writes without hunks stay valid', () => {
  const bad = {
    headersOnly: 'diff --git a/src/x.mjs b/src/x.mjs\nindex 111..222 100644\n--- a/src/x.mjs\n+++ b/src/x.mjs\n',
    indexOnly: 'diff --git a/src/x.mjs b/src/x.mjs\nindex 111..222 100644\n',
    bareHeader: 'diff --git a/src/x.mjs b/src/x.mjs\n',
    newFileCut: 'diff --git a/src/new.mjs b/src/new.mjs\nnew file mode 100644\nindex 0000000..abc1234\n',
    renameWithEdits: 'diff --git a/a.mjs b/b.mjs\nsimilarity index 80%\nrename from a.mjs\nrename to b.mjs\n',
    plainCut: '--- a/src/x.mjs\n+++ b/src/x.mjs\n',
  };
  for (const [name, text] of Object.entries(bad)) assert.throws(() => parseUnifiedDiff(text), /no hunks/, name);
  const good = {
    modeOnly: 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n',
    pureRename: 'diff --git a/a.mjs b/b.mjs\nsimilarity index 100%\nrename from a.mjs\nrename to b.mjs\n',
    binary: 'diff --git a/i.png b/i.png\nindex 111..222 100644\nBinary files a/i.png and b/i.png differ\n',
    emptyNew: 'diff --git a/e.txt b/e.txt\nnew file mode 100644\nindex 0000000..e69de29\n',
    emptyDeleted: 'diff --git a/e.txt b/e.txt\ndeleted file mode 100644\nindex e69de29..0000000\n',
  };
  for (const [name, text] of Object.entries(good)) assert.equal(parseUnifiedDiff(text).length, 1, name);
  assert.equal(parseUnifiedDiff(good.binary)[0].binary, true);
  assert.equal(parseUnifiedDiff(good.pureRename)[0].status, 'renamed');
});

// ── 4: H3 ──────────────────────────────────────────────────────────────────
const fullHead = git(REPO, 'rev-parse', 'HEAD').trim();
const shallow = git(REPO, 'rev-parse', '--is-shallow-repository').trim() === 'true';
// Where the seen PRs (#380-#442) and the first unseen one (< #380) sit in THIS checkout's first-parent PR list, so the test does not
// hard-code a skip that depends on how many PRs main has gained since.
const prNumbers = shallow ? [] : git(REPO, 'log', '--first-parent', '--format=%s', fullHead).split('\n').map((l) => /\(#(\d+)\)$/.exec(l)?.[1]).filter(Boolean).map(Number);
const firstSeen = prNumbers.findIndex((n) => n >= 380 && n <= 442);
const firstUnseenBelow = prNumbers.findIndex((n) => n < 380);
const pilot = (...a) => spawnSync(process.execPath, [PILOT, ...a], { cwd: REPO, encoding: 'utf8' });

test('--flag=value works for every value flag, and an unknown flag spelling is an argv error', (t) => {
  if (shallow) { t.skip('shallow clone: no history to replay'); return; }
  const spaced = pilot('--replay', '--tip', fullHead, '--skip', '60', '--count', '2', '--json');
  const equals = pilot('--replay', `--tip=${fullHead}`, '--skip=60', '--count=2', '--json');
  assert.equal(spaced.status, 0, spaced.stderr);
  assert.equal(equals.status, 0, equals.stderr);
  const [a, b] = [JSON.parse(spaced.stdout), JSON.parse(equals.stdout)];
  assert.deepEqual([b.skip, b.count, b.window], [60, 2, a.window], 'the = spelling was honoured, not ignored');
  assert.equal(pilot('--replay', '--tip', fullHead, '--skp=30').status, 2, 'a misspelled flag is refused');
  assert.equal(pilot('--replay', '--tip', fullHead, '--skip=abc').status, 2);
  assert.equal(pilot('--replay', '--tip', fullHead, '--skip=').status, 2);
});

// ── 5: H2 / M13 ────────────────────────────────────────────────────────────
test('a custom checklist path behaves as explicit: missing is an error; kernelEstimate passes it through', () => {
  const dir = repo();
  assert.equal(loadChecklist({ repoRoot: dir, file: 'missing-custom.json' }).ok, false);
  assert.equal(loadChecklist({ repoRoot: dir }).absent, true, 'control: the default path is still empty-when-absent');
  assert.throws(() => kernelEstimate({ repoRoot: REPO, checklistFile: 'nope-custom.json' }), /does not exist/);
});

// ── 6, 7: M11 / M3 ─────────────────────────────────────────────────────────
test('--confirmation refuses a moving or short tip, and any window overlapping the seen ones; it records the window it used', (t) => {
  if (shallow) { t.skip('shallow clone: no history to replay'); return; }
  const refused = (re, ...a) => { const r = pilot('--replay', '--confirmation', ...a); assert.equal(r.status, 2); assert.match(r.stderr, re); };
  refused(/full 40- or 64-hex/, '--tip', 'HEAD', '--skip', '60', '--count', '1');
  refused(/full 40- or 64-hex/, '--tip', fullHead.slice(0, 12), '--skip', '60', '--count', '1');
  refused(/overlaps PRs already seen/, '--tip', fullHead, '--skip', String(firstSeen), '--count', '1');
  refused(/overlaps PRs already seen/, '--tip', fullHead, '--skip', String(Math.max(0, firstSeen - 1)), '--count', '3'); // straddles the boundary
  const ok = pilot('--replay', '--confirmation', '--tip', fullHead, '--skip', String(firstUnseenBelow), '--count', '2', '--json');
  assert.equal(ok.status, 0, ok.stderr);
  const out = JSON.parse(ok.stdout);
  assert.deepEqual([out.confirmation.tip, out.confirmation.skip, out.confirmation.count], [fullHead, firstUnseenBelow, 2]);
  assert.equal(out.confirmation.prs.length, 2);
  assert.deepEqual(seenPrsIn(out.confirmation.prs), []);
  assert.deepEqual(out.confirmation.window, out.window);
  // control for the window table itself
  assert.deepEqual(seenPrsIn([379, 380, 409, 410, 442, 443]), [380, 409, 410, 442]);
  assert.equal(SEEN_WINDOWS.pilot.newest, 442);
});

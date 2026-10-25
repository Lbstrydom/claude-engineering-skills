/**
 * Cluster A, Phase 4 (fleet 484f a): the operator reading H:28 -> 11 -> 22 cannot tell a re-raise from a new finding. This reports the
 * overlap - and ONLY reports it. A carried ledger suppresses nothing (all 23 entries of the AIO ledger were pending/pending), and the
 * concern index keys on category|file, which consecutive pushes reworded away (0/32 exact overlap), so the comparator is file overlap with
 * a text-similarity tier. docs/plans/prepush-convergence-cluster-a.md ("Recurrence comparator and CLI").
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { summariseRecurrence, formatRecurrenceLine, RECURRENCE_SIMILARITY } from '../scripts/lib/prepush-audit-gate.mjs';
import { findingFiles } from '../scripts/lib/concern-identity.mjs';
import { ledgerFindingSimilarity } from '../scripts/lib/ledger.mjs';
import { recurrenceLine, CAPABILITIES } from '../scripts/prepush-step.mjs';

const deps = { filesOf: findingFiles, similarity: ledgerFindingSimilarity };
const F = (category, file, detail = 'd', section = file) => ({ category, section, detail, _primaryFile: file, affectedFiles: [file] });

describe('summariseRecurrence', () => {
  test('the diagnosed shape: the SAME file comes back under a reworded category - counted as same-file, not lost', () => {
    const previous = [F('[Backend] Persistence recovery', 'src/captureJournal.ts', 'journal replay can drop entries on crash')];
    const current = [F('[Backend] Journal state integrity', 'src/captureJournal.ts', 'a crash may lose journal entries on replay')];
    const s = summariseRecurrence({ previous, current, ...deps });
    assert.equal(s.total, 1);
    assert.equal(s.sameFile, 1);
  });

  test('similarity tier counts only textually close pairs on the same file', () => {
    const previous = [F('[X] Missing guard for empty input', 'src/a.ts', 'the parser does not guard empty input and throws')];
    const same = F('[X] Missing guard for empty input', 'src/a.ts', 'the parser does not guard empty input and throws');
    const other = F('[Y] Unrelated naming', 'src/a.ts', 'variable names are inconsistent across modules entirely different words here');
    const s = summariseRecurrence({ previous, current: [same, other], ...deps });
    assert.equal(s.sameFile, 2);
    assert.equal(s.alsoSimilar, 1);
    assert.ok(ledgerFindingSimilarity(same, previous[0]) > RECURRENCE_SIMILARITY);
  });

  test('NEGATIVE CONTROL: findings on different files never recur', () => {
    const s = summariseRecurrence({ previous: [F('c', 'src/a.ts')], current: [F('c', 'src/b.ts')], ...deps });
    assert.deepEqual(s, { total: 1, sameFile: 0, alsoSimilar: 0 });
  });

  test('empty or non-array inputs are zeros, not throws', () => {
    assert.deepEqual(summariseRecurrence({ previous: null, current: undefined, ...deps }), { total: 0, sameFile: 0, alsoSimilar: 0 });
  });

  test('wording', () => {
    assert.equal(formatRecurrenceLine({ prevTree: 'abcdef0123456789', total: 22, sameFile: 14, alsoSimilar: 5 }),
      'recurrence vs abcdef012345: 14 of 22 finding(s) are on files already flagged in the previous push (5 also textually similar)');
  });
});

// ── The CLI path against a real repository ───────────────────────────────────────────────────────────────────────────────────────────────
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recur-'));
  git(dir, ['init', '-q', '-b', 'main']);
  const commit = (name) => { fs.writeFileSync(path.join(dir, `${name}.txt`), name); git(dir, ['add', '.']); git(dir, ['commit', '-qm', name]); return git(dir, ['rev-parse', 'HEAD']); };
  return { dir, commit };
}
const keep = (dir) => { const k = path.join(dir, '.audit', 'prepush'); fs.mkdirSync(k, { recursive: true }); return k; };
const putReport = (k, tree, findings, ageSec = 0) => {
  const f = path.join(k, `${tree}.report.json`);
  fs.writeFileSync(f, JSON.stringify({ verdict: 'NEEDS_FIXES', findings }));
  if (ageSec) { const t = new Date(Date.now() - ageSec * 1000); fs.utimesSync(f, t, t); }
  return f;
};

describe('recurrenceLine against a real repository', () => {
  test('previous push is an ancestor: the line reports the overlap, and the current head is recorded for the next push', () => {
    const { dir, commit } = repo();
    const h1 = commit('one'); const h2 = commit('two');
    const k = keep(dir);
    putReport(k, 'a'.repeat(40), [F('[B] Persistence recovery', 'src/j.ts'), F('[B] Other', 'src/z.ts')], 60);
    fs.writeFileSync(path.join(k, `${'a'.repeat(40)}.head`), `${h1}\n`);
    const cur = putReport(k, 'b'.repeat(40), [F('[B] Journal integrity', 'src/j.ts'), F('[B] New thing', 'src/new.ts')]);
    const line = recurrenceLine({ reportFile: cur, headArg: h2, cwd: dir, env: {}, deps });
    assert.match(line, /^recurrence vs aaaaaaaaaaaa: 1 of 2 finding\(s\) are on files already flagged/);
    assert.equal(fs.readFileSync(path.join(k, `${'b'.repeat(40)}.head`), 'utf8').trim(), h2);
  });

  test('previous head is NOT an ancestor (rebased / other branch): unavailable, never a made-up baseline', () => {
    const { dir, commit } = repo();
    const h1 = commit('one'); git(dir, ['checkout', '-q', '-b', 'other', 'HEAD~0']); const h2 = commit('two');
    git(dir, ['checkout', '-q', 'main']); const h3 = commit('three');
    const k = keep(dir);
    putReport(k, 'a'.repeat(40), [F('c', 'src/j.ts')], 60);
    fs.writeFileSync(path.join(k, `${'a'.repeat(40)}.head`), `${h2}\n`);
    const cur = putReport(k, 'b'.repeat(40), [F('c', 'src/j.ts')]);
    assert.match(recurrenceLine({ reportFile: cur, headArg: h3, cwd: dir, env: {}, deps }), /^recurrence unavailable: no earlier report on this lineage/);
    assert.ok(h1);
  });

  test('a CORRUPT earlier report WITH a valid recorded ancestor head is `unavailable: ... unreadable` (isolated from the missing-head case)', () => {
    const { dir, commit } = repo();
    const h1 = commit('one'); const h2 = commit('two');
    const k = keep(dir);
    fs.writeFileSync(path.join(k, `${'a'.repeat(40)}.report.json`), '{not json');
    const t = new Date(Date.now() - 60_000); fs.utimesSync(path.join(k, `${'a'.repeat(40)}.report.json`), t, t);
    fs.writeFileSync(path.join(k, `${'a'.repeat(40)}.head`), `${h1}
`);
    const cur = putReport(k, 'b'.repeat(40), [F('c', 'src/j.ts')]);
    assert.match(recurrenceLine({ reportFile: cur, headArg: h2, cwd: dir, env: {}, deps }), /^recurrence unavailable: the earlier report is unreadable/);
  });

  test('a report with no recorded head and a missing current report are `unavailable`', () => {
    const { dir, commit } = repo();
    commit('one'); const h2 = commit('two');
    const k = keep(dir);
    putReport(k, 'a'.repeat(40), [F('c', 'src/j.ts')], 60); // no .head sidecar
    const cur = putReport(k, 'b'.repeat(40), [F('c', 'src/j.ts')]);
    assert.match(recurrenceLine({ reportFile: cur, headArg: h2, cwd: dir, env: {}, deps }), /unavailable: no earlier report/);
    assert.match(recurrenceLine({ reportFile: path.join(k, 'nope.report.json'), headArg: h2, cwd: dir, env: {}, deps }), /unavailable: the current report is unreadable/);
    assert.match(recurrenceLine({ reportFile: null, deps }), /unavailable: no current report/);
  });

  test('sidecars whose report was pruned are removed', () => {
    const { dir, commit } = repo();
    commit('one'); const h2 = commit('two');
    const k = keep(dir);
    fs.writeFileSync(path.join(k, `${'c'.repeat(40)}.head`), `${h2}\n`); // orphan: no c...report.json
    const cur = putReport(k, 'b'.repeat(40), []);
    recurrenceLine({ reportFile: cur, headArg: h2, cwd: dir, env: {}, deps });
    assert.equal(fs.existsSync(path.join(k, `${'c'.repeat(40)}.head`)), false);
    assert.equal(fs.existsSync(path.join(k, `${'b'.repeat(40)}.head`)), true);
  });

  test('cleanup is by OWNERSHIP, not by suffix: foreign `.head` files and a directory named like a sidecar are left alone', () => {
    const { dir, commit } = repo();
    commit('one'); const h2 = commit('two');
    const k = keep(dir);
    fs.writeFileSync(path.join(k, 'notes.head'), 'a user file');
    fs.writeFileSync(path.join(k, 'HEAD.head'), 'also not ours');
    fs.mkdirSync(path.join(k, `${'d'.repeat(40)}.head`));
    fs.writeFileSync(path.join(k, `${'d'.repeat(40)}.head`, 'keep.txt'), 'x');
    fs.writeFileSync(path.join(k, `${'c'.repeat(40)}.head`), `${h2}
`); // ours, orphaned
    const cur = putReport(k, 'b'.repeat(40), []);
    recurrenceLine({ reportFile: cur, headArg: h2, cwd: dir, env: {}, deps });
    assert.equal(fs.existsSync(path.join(k, 'notes.head')), true);
    assert.equal(fs.existsSync(path.join(k, 'HEAD.head')), true);
    assert.equal(fs.existsSync(path.join(k, `${'d'.repeat(40)}.head`, 'keep.txt')), true);
    assert.equal(fs.existsSync(path.join(k, `${'c'.repeat(40)}.head`)), false, 'our orphan is still removed');
  });

  test('the real CLI prints exactly one line and exits 0 even when nothing can be compared', () => {
    const { dir, commit } = repo();
    commit('one'); const h2 = commit('two');
    const cur = putReport(keep(dir), 'b'.repeat(40), [F('c', 'src/j.ts')]);
    const r = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../scripts/prepush-step.mjs'), 'recurrence', '--report', cur, '--head', h2], { cwd: dir, encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AZURE_'))) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim().split('\n').length, 1);
    assert.match(r.stdout, /^recurrence unavailable: no earlier report on this lineage\n$/);
  });

  test('the capability is advertised', () => assert.ok(CAPABILITIES.includes('recurrence')));
});

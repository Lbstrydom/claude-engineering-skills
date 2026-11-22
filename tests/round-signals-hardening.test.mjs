import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unquoteGitPath, parsePostImageHunks, importanceSelector, reopenRate, severityDrift, retired, computeRoundSignals } from '../scripts/lib/audit/round-signals.mjs';

test('M9: git quoted paths are decoded (octal UTF-8, escapes) before the b/ prefix is stripped', () => {
  assert.equal(unquoteGitPath('"b/a\\303\\251.mjs"'), 'b/aé.mjs');
  assert.equal(unquoteGitPath('"b/with\\ttab\\"q\\\\.mjs"'), 'b/with\ttab"q\\.mjs');
  assert.equal(unquoteGitPath('b/plain.mjs'), 'b/plain.mjs');
  const m = parsePostImageHunks(['--- a/x', '+++ "b/caf\\303\\251.mjs"', '@@ -1 +4,2 @@'].join('\n'));
  assert.deepEqual(m.get('café.mjs'), [[4, 5]]);
});

test('M10: importance is chosen per finding; the source says mixed', () => {
  const lists = [[{ importance: 'important', severity: 'LOW' }, { importance: 'nit', severity: 'HIGH' }, { severity: 'MEDIUM' }, { severity: 'LOW' }]];
  const sel = importanceSelector(lists);
  assert.equal(sel.importanceSource, 'mixed');
  assert.deepEqual(sel.select(lists[0]).map((f) => f.severity), ['LOW', 'MEDIUM'], 'tagged important kept, tagged nit dropped, untagged uses the proxy');
});

test('M11: a round with no findings list is unmeasured, never an empty round', () => {
  const select = importanceSelector([[]]).select;
  const rounds = [{ round: 1, auditedSha: 'a'.repeat(40) }, { round: 2, auditedSha: 'b'.repeat(40) }];
  const git = () => ({ status: 0, stdout: '' });
  assert.equal(reopenRate({ round: 2, rounds, select, git }).measured, false);
  assert.equal(severityDrift({ round: 2, rounds, select }).measured, false);
  assert.equal(retired({ round: 2, rounds, select, ledgerEntries: [], topicOf: (f) => f.t, git }).measured, false);
});

test('R2-M4: a "+++ " inside a hunk is an added line, not a file header', () => {
  const diff = ['--- a/x.mjs', '+++ b/x.mjs', '@@ -1,0 +5,2 @@', '+++ not a header', '+second', '--- a/y.mjs', '+++ b/y.mjs', '@@ -1 +1 @@', '-o', '+n'].join('\n');
  const m = parsePostImageHunks(diff);
  assert.deepEqual([...m.keys()], ['x.mjs', 'y.mjs']);
  assert.deepEqual(m.get('x.mjs'), [[5, 6]]);
  assert.deepEqual(m.get('y.mjs'), [[1, 1]]);
});

test('R2-H4/M1: retired is unmeasured unless EVERY previous-round topic has a ruling WITH an adjudicationOutcome', () => {
  const select = importanceSelector([[]]).select;
  const rounds = [
    { round: 1, auditedSha: 'a'.repeat(40), findings: [{ t: 't1', severity: 'HIGH' }, { t: 't2', severity: 'HIGH' }] },
    { round: 2, auditedSha: 'b'.repeat(40), findings: [{ t: 't3', severity: 'HIGH' }] },
    { round: 3, auditedSha: 'c'.repeat(40), findings: [] },
  ];
  const git = () => ({ status: 0, stdout: '' });
  const topicOf = (f) => f.t;
  const ruled = (t) => ({ topicId: t, adjudicationOutcome: 'accepted' });
  assert.equal(retired({ round: 3, select, rounds, topicOf, git, ledgerEntries: [ruled('t1'), ruled('t2'), ruled('t3')] }).measured, true);
  const r = retired({ round: 3, select, rounds, topicOf, git, ledgerEntries: [ruled('t1'), { topicId: 't2' }, ruled('t3')] });
  assert.equal(r.measured, false, 'an entry with no outcome is not a ruling');
  assert.match(r.reason, /no ruling with an adjudicationOutcome/);
  assert.equal(retired({ round: 3, select, rounds, topicOf, git, ledgerEntries: [ruled('t3')] }).measured, false, 'a topic with no entry at all');
});

test('R2-M2: null findings stay null into the signals (unmeasured, never an empty round)', () => {
  const rounds = [{ round: 2, auditedSha: 'a'.repeat(40), findings: null }, { round: 3, auditedSha: 'b'.repeat(40), findings: null }];
  const s = computeRoundSignals({ round: 3, rounds, ledgerEntries: [], git: () => ({ status: 0, stdout: '' }), topicOf: (f) => f.t });
  assert.deepEqual(s.unmeasured.sort(), ['reopenRate', 'retired', 'severityDrift']);
  assert.equal(s.anyFires, false);
});

test('R3-M5: the diff command pins prefixes and ignores user diff config', async () => {
  const { postImageHunks } = await import('../scripts/lib/audit/round-signals.mjs');
  let seen = null;
  const git = (a) => { if (a.includes('diff')) seen = a; return { status: 0, stdout: '' }; };
  postImageHunks({ base: 'a'.repeat(40), head: 'b'.repeat(40) }, git);
  for (const flag of ['--src-prefix=a/', '--dst-prefix=b/', '--no-ext-diff', 'diff.noprefix=false']) assert.ok(seen.includes(flag), flag);
});

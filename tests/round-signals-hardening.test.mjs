import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unquoteGitPath, parsePostImageHunks, importanceSelector, reopenRate, severityDrift, retired } from '../scripts/lib/audit/round-signals.mjs';

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

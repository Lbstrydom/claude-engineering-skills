/**
 * Harness retro — signal extraction (plan docs/plans/harness-retro.md §2 c2, c4).
 * Every kind fires on its input AND stays silent on the look-alike it must not fire on.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyToolResult, createSessionExtractor, isCorrection } from '../scripts/lib/friction/retro/signals.mjs';

const use = (id, name, input = {}) => ({ type: 'assistant', timestamp: '2026-11-16T10:00:00Z', cwd: 'C:\\GIT\\r', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, text, isError = true, extra = {}) => ({ type: 'user', timestamp: '2026-11-16T10:00:01Z', ...extra, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] } });
const human = (text) => ({ type: 'user', origin: { kind: 'human' }, timestamp: '2026-11-16T10:00:02Z', message: { content: text } });

function run(records, { files } = {}) {
  const ex = createSessionExtractor();
  for (const batch of files ?? [records]) { for (const r of batch) ex.push(r); ex.endFile(); }
  return ex.finish();
}
const kinds = (s) => s.occurrences.map((o) => o.kind);

describe('classifyToolResult', () => {
  it('is null for a clean success', () => {
    assert.equal(classifyToolResult({ text: 'all good', isError: false }), null);
  });
  it('a hook rewrite beats a denial', () => {
    assert.equal(classifyToolResult({ text: "classifier gave no verdict: a hook changed this call's input after auto", isError: true }), 'hook_rewrite');
  });
  it('a hook block is enforcement firing, not a generic error', () => {
    assert.equal(classifyToolResult({ text: 'PreToolUse:Bash hook error: Bash leading command is `grep`', isError: true }), 'hook_block');
    assert.equal(classifyToolResult({ text: 'x', isError: true, permissionDecision: { decision: 'reject', source: 'hook' } }), 'hook_block');
  });
  it('a POST-execution hook error is a hook_error, not a refusal (the tool already ran)', () => {
    assert.equal(classifyToolResult({ text: 'PostToolUse:Write hook error: quickfix pattern matched', isError: true }), 'hook_error');
  });
  it('structured denial first, text fallback second', () => {
    assert.equal(classifyToolResult({ text: 'nope', isError: true, permissionDecision: { decision: 'reject', source: 'config' } }), 'denial');
    assert.equal(classifyToolResult({ text: 'Permission for this action was denied by the Claude Code auto mode classifier.', isError: true }), 'denial');
    assert.equal(classifyToolResult({ text: 'ok', isError: false, permissionDecision: { decision: 'accept' } }), null);
  });
  it('refusal phrases count even on a successful result, but only on its first line', () => {
    assert.equal(classifyToolResult({ text: 'ERROR: must be owner of table x', isError: true }), 'refusal');
    assert.equal(classifyToolResult({ text: 'sync refused to overwrite the file', isError: false }), 'refusal');
    assert.equal(classifyToolResult({ text: 'docs/a.md\nThe CLI refuses — writing nothing', isError: false }), null);
    assert.equal(classifyToolResult({ text: 'ces-sync-manifest-refused-writes.md', isError: false }), null);
  });
  it('any other error is tool_error', () => {
    assert.equal(classifyToolResult({ text: 'Error: ENOENT', isError: true }), 'tool_error');
  });
});

describe('isCorrection', () => {
  it('matches what the human typed, after injected blocks are stripped', () => {
    assert.ok(isCorrection('<system-reminder>x</system-reminder>\nno, use the other file'));
    assert.ok(isCorrection("don't push yet"));
  });
  it('does not fire on ordinary requests', () => {
    assert.ok(!isCorrection('nothing more to add, ship it'));
    assert.ok(!isCorrection('please add a test'));
  });
});

describe('createSessionExtractor', () => {
  it('joins a result to its tool_use and records session facts', () => {
    const s = run([use('t1', 'Bash'), result('t1', 'Error: boom')]);
    assert.deepEqual(kinds(s), ['tool_error']);
    assert.equal(s.occurrences[0].tool, 'Bash');
    assert.equal(s.firstCwd, 'C:\\GIT\\r');
    assert.equal(s.unjoined, 0);
    assert.ok(s.conversational >= 2);
  });

  it('a retry fires when the same call is re-issued after it errored, not after a success', () => {
    const s = run([use('a', 'Bash', { c: 1 }), result('a', 'Error: x'), use('b', 'Bash', { c: 1 })]);
    assert.ok(kinds(s).includes('retry'));
    const ok = run([use('a', 'Bash', { c: 1 }), result('a', 'fine', false), use('b', 'Bash', { c: 1 })]);
    assert.ok(!kinds(ok).includes('retry'));
  });

  it('joins are per file: a result in another file is unjoined but still counted', () => {
    const s = run(null, { files: [[use('x', 'Bash')], [result('x', 'Error: y')]] });
    assert.equal(s.unjoined, 1);
    assert.deepEqual(kinds(s), ['tool_error']);
    assert.equal(s.occurrences[0].tool, '');
  });

  it('user_correction keeps the kind and preceding tool, never the text', () => {
    const s = run([use('a', 'Edit'), result('a', 'done', false), human('no, that is the wrong file — secretword')]);
    const c = s.occurrences.find((o) => o.kind === 'user_correction');
    assert.ok(c);
    assert.equal(c.tool, 'Edit');
    assert.ok(!JSON.stringify(s.occurrences).includes('secretword'));
    assert.equal(s.humanTurns, 1);
  });

  it('a meta user turn and a hook_success never fire', () => {
    const s = run([
      { type: 'user', isMeta: true, origin: { kind: 'human' }, message: { content: 'no way' } },
      { type: 'attachment', attachment: { type: 'hook_success', hookName: 'SessionStart' } },
    ]);
    assert.deepEqual(s.occurrences, []);
    assert.equal(s.humanTurns, 0);
  });

  it('a failing hook attachment is hook_error', () => {
    const s = run([{ type: 'attachment', attachment: { type: 'hook_non_blocking_error', hookName: 'UserPromptSubmit', stderr: 'Failed with non-blocking status code: bash: .claude/hooks/a.sh: No such file or directory' } }]);
    assert.deepEqual(kinds(s), ['hook_error']);
    assert.match(s.occurrences[0].label, /No such file/);
  });

  it('a queued human command counts as a human turn', () => {
    const s = run([{ type: 'attachment', attachment: { type: 'queued_command', prompt: 'stop that', origin: { kind: 'human' } } }]);
    assert.equal(s.humanTurns, 1);
    assert.deepEqual(kinds(s), ['user_correction']);
  });
});

describe('runScan — completeness and measurement honesty', async () => {
  const { runScan } = await import('../scripts/lib/friction/retro/scan.mjs');
  const resolver = { resolve: () => ({ repoUuid: 'r', name: 'o/r' }) };
  const recs = [use('t1', 'Bash'), result('t1', 'Error: boom')];
  const listing = (files, extra = {}) => () => ({ projectsDir: '/p', projectsDirExists: true, enumerationErrors: [], files, ...extra });
  const file = (id) => ({ path: `/p/s/${id}.jsonl`, slug: 's', subagent: false, mtimeMs: Date.now() });
  const streamWith = (stats) => async (_p, onRecord) => { for (const r of recs) onRecord(r); return { lines: 3, parsed: 2, unparseable: 0, truncatedTail: false, readError: null, ...stats }; };
  const scan = (list, stream) => runScan({ configDir: '/cfg', sinceMs: 0, resolver, thisRepoUuid: 'r', list, stream });

  it('a truncated LAST line is a write in progress: the session stays complete', async () => {
    const r = await scan(listing([file('a')]), streamWith({ unparseable: 1, truncatedTail: true }));
    assert.equal(r.sessions[0].complete, true);
    assert.equal(r.completed, true);
    assert.equal(r.files.truncatedTails, 1);
  });
  it('a garbled line mid-file makes the session incomplete and the scan not coverage evidence', async () => {
    const r = await scan(listing([file('a')]), streamWith({ unparseable: 1, truncatedTail: false }));
    assert.equal(r.sessions[0].complete, false);
    assert.equal(r.completed, false);
  });
  it('an unreadable projects dir is UNMEASURED, never an empty clean scan', async () => {
    const r = await scan(listing([], { enumerationErrors: [{ path: '/p', code: 'EACCES' }] }), streamWith({}));
    assert.equal(r.measured, false);
    assert.equal(r.reason, 'enumeration-errors');
  });
  it('sessions that all belong elsewhere are UNMEASURED for this repo', async () => {
    const r = await runScan({ configDir: '/cfg', sinceMs: 0, resolver, thisRepoUuid: 'other', list: listing([file('a')]), stream: streamWith({}) });
    assert.equal(r.measured, false);
    assert.equal(r.reason, 'no-in-scope-sessions');
    assert.equal(r.excluded.otherRepo, 1);
  });
});

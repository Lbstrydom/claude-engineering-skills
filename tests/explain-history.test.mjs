/**
 * Tests for scripts/explain-history.mjs.
 *
 * Coverage focus:
 *   1. parseArgs — flag handling, validation, ArgvError shape
 *   2. planSearch — heading capture, match cap, missing dir
 *   3. brainstormSearch — V2 envelope match by topic + provider response
 *   4. buildChronological — date-desc ordering with null-date fallback
 *   5. buildSummary — empty / non-empty rendering
 *
 * git/arch-memory integration paths are exercised manually via:
 *   node scripts/explain-history.mjs --topic "<text>"
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  parseArgs, gitLogSearch, planSearch, brainstormSearch, walkMarkdown,
  buildChronological, buildSummary, planMtimeMap,
} from '../scripts/explain-history.mjs';

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'explain-history-'));
}

describe('parseArgs', () => {
  it('rejects when --topic missing', () => {
    assert.throws(() => parseArgs([]), /--topic is required/);
  });

  it('rejects empty --topic', () => {
    assert.throws(() => parseArgs(['--topic', '   ']), /--topic is required/);
  });

  it('parses --topic', () => {
    const a = parseArgs(['--topic', 'rate limiting']);
    assert.equal(a.topic, 'rate limiting');
    assert.equal(a.limit, 10);
    assert.equal(a.skipArch, false);
  });

  it('parses --since + --paths + --limit + --skip-arch + --out', () => {
    const a = parseArgs([
      '--topic', 'auth',
      '--since', '3 months ago',
      '--paths', 'scripts/,docs/',
      '--limit', '5',
      '--skip-arch',
      '--out', '/tmp/out.json',
    ]);
    assert.equal(a.since, '3 months ago');
    assert.deepEqual(a.paths, ['scripts/', 'docs/']);
    assert.equal(a.limit, 5);
    assert.equal(a.skipArch, true);
    assert.equal(a.out, '/tmp/out.json');
  });

  it('rejects --limit non-integer', () => {
    assert.throws(() => parseArgs(['--topic', 'x', '--limit', 'foo']));
  });

  it('rejects unknown flag', () => {
    assert.throws(() => parseArgs(['--topic', 'x', '--no-such-flag']), /Unknown flag/);
  });

  it('rejects --topic value missing', () => {
    assert.throws(() => parseArgs(['--topic']), /requires a value/);
  });

  it('--help short-circuits', () => {
    const a = parseArgs(['--help']);
    assert.equal(a.help, true);
  });
});

describe('planSearch', () => {
  it('returns [] when docs/plans/ does not exist (graceful)', () => {
    const root = mkTmp();
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const matches = planSearch('anything', { limit: 5 });
      assert.deepEqual(matches, []);
    } finally {
      process.chdir(cwd);
    }
  });

  it('finds substring matches with heading context', () => {
    const root = mkTmp();
    const dir = path.join(root, 'docs', 'plans');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'foo.md'), [
      '# Plan: Foo',
      '## Background',
      'we tried rate-limit handling once before',
      '## Risks',
      'rate limiting may cascade',
      '',
    ].join('\n'));
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const matches = planSearch('rate', { limit: 10 });
      assert.equal(matches.length, 2);
      assert.equal(matches[0].heading, 'Background');
      assert.equal(matches[1].heading, 'Risks');
      assert.match(matches[0].excerpt, /rate-limit handling/);
    } finally {
      process.chdir(cwd);
    }
  });

  it('respects --limit cap', () => {
    const root = mkTmp();
    const dir = path.join(root, 'docs', 'plans');
    fs.mkdirSync(dir, { recursive: true });
    const lines = ['# Plan'];
    for (let i = 0; i < 20; i++) lines.push(`mention of foo ${i}`);
    fs.writeFileSync(path.join(dir, 'a.md'), lines.join('\n'));
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const matches = planSearch('foo', { limit: 3 });
      assert.equal(matches.length, 3);
    } finally {
      process.chdir(cwd);
    }
  });

  it('case-insensitive', () => {
    const root = mkTmp();
    const dir = path.join(root, 'docs', 'plans');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.md'), '# Plan\nA mention of MyTopic here');
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const matches = planSearch('mytopic', { limit: 10 });
      assert.equal(matches.length, 1);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('walkMarkdown', () => {
  it('recurses into subdirectories', () => {
    const root = mkTmp();
    const sub = path.join(root, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(root, 'a.md'), 'hi');
    fs.writeFileSync(path.join(sub, 'b.md'), 'hi');
    fs.writeFileSync(path.join(root, 'not-md.txt'), 'hi');
    const files = walkMarkdown(root);
    assert.equal(files.length, 2);
    assert.ok(files.some(f => f.endsWith('a.md')));
    assert.ok(files.some(f => f.endsWith('b.md')));
  });
});

describe('brainstormSearch', () => {
  it('returns [] when .brainstorm/sessions/ does not exist', () => {
    const root = mkTmp();
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const matches = brainstormSearch('anything', { limit: 5 });
      assert.deepEqual(matches, []);
    } finally {
      process.chdir(cwd);
    }
  });

  it('matches by topic substring', () => {
    const root = mkTmp();
    const dir = path.join(root, '.brainstorm', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const envelope = {
      topic: 'should we add session memory to brainstorms?',
      sid: 'sid-abc', round: 0,
      capturedAt: new Date().toISOString(), schemaVersion: 2,
      providers: [], totalCostUsd: 0, redactionCount: 0, resolvedModels: {},
    };
    fs.writeFileSync(path.join(dir, 'sid-abc.jsonl'), JSON.stringify(envelope) + '\n');
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const matches = brainstormSearch('session memory', { limit: 5 });
      assert.equal(matches.length, 1);
      assert.equal(matches[0].matchedIn, 'topic');
      assert.equal(matches[0].sid, 'sid-abc');
    } finally {
      process.chdir(cwd);
    }
  });

  it('matches by provider-response substring when topic does not contain term', () => {
    const root = mkTmp();
    const dir = path.join(root, '.brainstorm', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const envelope = {
      topic: 'general design discussion',
      sid: 'sid-xyz', round: 1,
      capturedAt: new Date().toISOString(), schemaVersion: 2,
      providers: [
        { provider: 'openai', state: 'success',
          text: 'You should consider using a circuit breaker pattern here.',
          errorMessage: null, httpStatus: null, usage: null, latencyMs: 0, estimatedCostUsd: null },
      ],
      totalCostUsd: 0, redactionCount: 0, resolvedModels: {},
    };
    fs.writeFileSync(path.join(dir, 'sid-xyz.jsonl'), JSON.stringify(envelope) + '\n');
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const matches = brainstormSearch('circuit breaker', { limit: 5 });
      assert.equal(matches.length, 1);
      assert.equal(matches[0].matchedIn, 'provider-response');
      assert.match(matches[0].excerpt, /circuit breaker/);
    } finally {
      process.chdir(cwd);
    }
  });

  it('skips invalid JSON lines without throwing', () => {
    const root = mkTmp();
    const dir = path.join(root, '.brainstorm', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const validEnvelope = {
      topic: 'has feature X', sid: 'sid-v', round: 0,
      capturedAt: new Date().toISOString(), schemaVersion: 2,
      providers: [], totalCostUsd: 0, redactionCount: 0, resolvedModels: {},
    };
    fs.writeFileSync(path.join(dir, 'sid-v.jsonl'),
      '{not-json\n' + JSON.stringify(validEnvelope) + '\n');
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const matches = brainstormSearch('feature X', { limit: 5 });
      assert.equal(matches.length, 1);
    } finally {
      process.chdir(cwd);
    }
  });

  it('respects limit', () => {
    const root = mkTmp();
    const dir = path.join(root, '.brainstorm', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const lines = [];
    for (let i = 0; i < 10; i++) {
      lines.push(JSON.stringify({
        topic: `discussion ${i} about widgets`,
        sid: `sid-${i}`, round: 0,
        capturedAt: new Date().toISOString(), schemaVersion: 2,
        providers: [], totalCostUsd: 0, redactionCount: 0, resolvedModels: {},
      }));
    }
    fs.writeFileSync(path.join(dir, 'session.jsonl'), lines.join('\n') + '\n');
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const matches = brainstormSearch('widgets', { limit: 3 });
      assert.equal(matches.length, 3);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('buildChronological', () => {
  it('sorts dated items most-recent first', () => {
    const items = buildChronological({
      git: [
        { source: 'git-subject', sha: 'aaa', date: '2026-01-01T00:00:00+00:00', author: 'A', subject: 'old' },
        { source: 'git-content', sha: 'bbb', date: '2026-05-01T00:00:00+00:00', author: 'B', subject: 'newer' },
      ],
      plans: [],
      brainstorm: [
        { source: 'brainstorm', sid: 's1', round: 0, capturedAt: '2026-03-01T00:00:00.000Z', topic: 't', matchedIn: 'topic', excerpt: 'e' },
      ],
      planFileMtimes: {},
    });
    assert.equal(items[0].kind, 'git');
    assert.equal(items[0].ref, 'bbb');
    assert.equal(items[1].kind, 'brainstorm');
    assert.equal(items[2].kind, 'git');
    assert.equal(items[2].ref, 'aaa');
  });

  it('null-date items go to the end', () => {
    const items = buildChronological({
      git: [],
      plans: [{ source: 'plan', path: 'docs/plans/x.md', line: 1, heading: 'H', excerpt: 'e' }],
      brainstorm: [
        { source: 'brainstorm', sid: 's1', round: 0, capturedAt: '2026-05-01T00:00:00.000Z', topic: 't', matchedIn: 'topic', excerpt: 'e' },
      ],
      planFileMtimes: { 'docs/plans/x.md': null },
    });
    assert.equal(items[0].kind, 'brainstorm');
    assert.equal(items[1].kind, 'plan');  // null date → end
  });
});

describe('buildSummary', () => {
  it('renders empty-state message', () => {
    const s = buildSummary({ topic: 'foo', git: [], archRecords: [], plans: [], brainstorm: [] });
    assert.match(s, /No prior touches/);
    assert.match(s, /foo/);
  });

  it('renders non-empty count summary', () => {
    const s = buildSummary({
      topic: 'auth', git: [{}, {}], archRecords: [{}], plans: [{}], brainstorm: [],
    });
    assert.match(s, /4 touches/);
    assert.match(s, /2 git commits/);
    assert.match(s, /1 arch-memory matches/);
    assert.match(s, /1 plan-document references/);
    assert.match(s, /0 brainstorm-session entries/);
  });
});

describe('planMtimeMap', () => {
  it('returns ISO string for existing files', () => {
    const root = mkTmp();
    const file = path.join(root, 'a.md');
    fs.writeFileSync(file, 'hi');
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const m = planMtimeMap([{ path: 'a.md' }]);
      assert.match(m['a.md'], /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      process.chdir(cwd);
    }
  });

  it('returns null for missing files', () => {
    const root = mkTmp();
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const m = planMtimeMap([{ path: 'nope.md' }]);
      assert.equal(m['nope.md'], null);
    } finally {
      process.chdir(cwd);
    }
  });
});

// ── gitLogSearch: the pickaxe blind spot ─────────────────────────────────
//
// `git log -S` matches on a change in NET OCCURRENCE COUNT. A commit that
// moves a string — deletes it from one line and re-adds it verbatim on
// another — leaves the count unchanged, so `-S` reports nothing and a caller
// concludes the change never happened. Pass C (`-G`) exists to catch exactly
// that; these tests build the move-commit that defeats `-S` and assert the
// aggregator still surfaces it.
describe('gitLogSearch — -S move blind spot', () => {
  function initRepo() {
    const root = fs.realpathSync(mkTmp());
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    return { root, git };
  }

  it('-G finds a move that -S cannot see, and labels it git-touched', () => {
    const { root, git } = initRepo();
    const cwd = process.cwd();
    // Commit 1: introduce the string on a RUN line.
    fs.writeFileSync(path.join(root, 'Dockerfile'), 'RUN apt-get install python3 make g++\n');
    git('add', '-A');
    git('commit', '-qm', 'initial image');
    // Commit 2: THE MOVE — delete from the RUN line, re-add verbatim in a
    // comment. Net occurrence count is unchanged.
    fs.writeFileSync(
      path.join(root, 'Dockerfile'),
      '# was: python3 make g++\nRUN apt-get install curl\n',
    );
    git('add', '-A');
    git('commit', '-qm', 'slim the builder stage');

    process.chdir(root);
    try {
      // Control: raw -S sees only the introducing commit, not the move.
      const pickaxe = execFileSync(
        'git', ['log', '--all', '-S', 'python3 make g++', '--pretty=format:%H'],
        { cwd: root, encoding: 'utf-8' },
      ).split('\n').filter(Boolean);
      assert.equal(pickaxe.length, 1, '-S must miss the move — that is the bug being guarded');

      const matches = gitLogSearch('python3 make g++', { limit: 10 });
      const touched = matches.filter(m => m.source === 'git-touched');
      assert.ok(touched.length >= 1, 'the -G pass must surface the move commit');
      assert.ok(
        matches.some(m => m.subject === 'slim the builder stage'),
        'the move commit must reach the caller',
      );
    } finally {
      process.chdir(cwd);
    }
  });

  it('escapes regex metacharacters before handing the topic to -G', () => {
    const { root, git } = initRepo();
    const cwd = process.cwd();
    fs.writeFileSync(path.join(root, 'a.txt'), 'value = compute(x)\n');
    git('add', '-A');
    git('commit', '-qm', 'add compute call');
    fs.writeFileSync(path.join(root, 'b.txt'), 'valueXcomputeYx\n');
    git('add', '-A');
    git('commit', '-qm', 'unrelated lookalike');

    process.chdir(root);
    try {
      // Unescaped, `compute(x)` would be a regex with a capture group matching
      // the bare text `computex`; escaped, it matches only the literal.
      const matches = gitLogSearch('compute(x)', { limit: 10 });
      assert.ok(
        !matches.some(m => m.subject === 'unrelated lookalike'),
        'an unescaped -G topic would match the lookalike line',
      );
      assert.ok(matches.some(m => m.subject === 'add compute call'));
    } finally {
      process.chdir(cwd);
    }
  });

  it('round-robins across passes so one pass cannot consume the whole limit', () => {
    const { root, git } = initRepo();
    const cwd = process.cwd();
    // Many -S-visible commits, then one move-only commit. A flat slice would
    // let the -S pass fill the budget and drop the -G result entirely.
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(root, `f${i}.txt`), 'needle-token\n');
      git('add', '-A');
      git('commit', '-qm', `add ${i}`);
    }
    fs.writeFileSync(path.join(root, 'f0.txt'), 'moved: needle-token\n');
    git('add', '-A');
    git('commit', '-qm', 'move only');

    process.chdir(root);
    try {
      const matches = gitLogSearch('needle-token', { limit: 4 });
      assert.equal(matches.length, 4);
      assert.ok(
        matches.some(m => m.source === 'git-touched'),
        'git-touched must survive a tight limit',
      );
    } finally {
      process.chdir(cwd);
    }
  });
});

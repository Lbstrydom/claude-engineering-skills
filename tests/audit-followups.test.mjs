/**
 * Follow-ups deferred from the file-coverage cluster C audit: each pins the direction the defect used to fail in.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { _internals as resolverInternals } from '../scripts/lib/audit/diff-scope-resolver.mjs';
import { loadEventWiringConfig, buildCorpus } from '../scripts/lib/audit/event-wiring-corpus.mjs';
import { hasJavaSources } from '../scripts/lib/repo-stack.mjs';
import { getProfile } from '../scripts/lib/language-profiles.mjs';

const { parseNameStatusZ } = resolverInternals;
const buf = (...t) => Buffer.from(t.join('\0') + '\0');

describe('diff-scope resolver parseNameStatusZ checks NUL framing', () => {
  it('a well-formed stream parses, complete', () => {
    const r = parseNameStatusZ(buf('M', 'a.js', 'R100', 'old.js', 'new.js', 'D', 'b.js'));
    assert.equal(r.partial, false);
    assert.deepEqual(r.records.map((x) => x.status), ['M', 'R', 'D']);
  });
  it('a truncated stream (no terminal NUL) is a PARTIAL parse with no records, never a shorter complete list', () => {
    const r = parseNameStatusZ(Buffer.from('M\0a.js\0M\0b.j'));
    assert.equal(r.partial, true);
    assert.deepEqual(r.records, []);
  });
  it('a record missing its path is partial and keeps the records before it', () => {
    const r = parseNameStatusZ(buf('M', 'a.js', 'R100', 'old.js'));
    assert.equal(r.partial, true);
    assert.deepEqual(r.records.map((x) => x.headCallerPath), ['a.js']);
  });
  it('an EMPTY path field is partial (the old split+filter erased it and mis-aligned every later record)', () => {
    const r = parseNameStatusZ(Buffer.from('M\0\0M\0b.js\0'));
    assert.equal(r.partial, true);
  });
  it('empty input is an empty, complete parse', () => {
    assert.deepEqual(parseNameStatusZ(Buffer.alloc(0)), { records: [], partial: false });
  });
});

describe('event-wiring corpus byte budget is bounded', () => {
  const cfg = (mb) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-cfg-'));
    try {
      fs.mkdirSync(path.join(dir, '.audit-loop'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.audit-loop', 'event-wiring.json'), JSON.stringify({ version: 1, wrappers: [], totalByteBudgetMb: mb }));
      return () => loadEventWiringConfig(dir);
    } finally { /* dir removed by caller via load */ }
  };
  it('a budget above the ceiling is rejected by the schema', () => {
    const load = cfg(1_000_000);
    assert.throws(load, /totalByteBudgetMb|too_big|<=|1024/i);
  });
  it('control: a budget at the ceiling is accepted', () => {
    assert.equal(cfg(1024)().totalByteBudgetMb, 1024);
  });
  it('0 no longer means unbounded: buildCorpus caps it at the ceiling', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-corpus-'));
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: dir });
      const r = buildCorpus({ repoPath: dir, wrappers: [], totalByteBudgetMb: 0 });
      assert.ok(r.counters, 'runs to completion on an empty repo with budget 0');
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

describe('hasJavaSources ignores a tracked file deleted from the working tree', () => {
  it('deleted-only is false; a present file is true (negative control)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'java-del-'));
    const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    try {
      git('init', '--quiet');
      fs.writeFileSync(path.join(dir, 'A.java'), 'class A {}');
      git('add', 'A.java');
      assert.equal(hasJavaSources(dir), true, 'control: present');
      fs.unlinkSync(path.join(dir, 'A.java'));
      assert.equal(hasJavaSources(dir), false, 'ls-files --cached still lists it; the deletion must win');
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

describe('JS/TS tool commands never acquire packages or touch the registry', () => {
  const tools = [...getProfile('js').tools, ...getProfile('ts').tools];
  it('there are eslint and tsc tools to check (vacuous-pass guard)', () => {
    assert.ok(tools.some((t) => t.id === 'eslint') && tools.some((t) => t.id === 'tsc'));
  });
  for (const t of tools) {
    for (const [label, cmd, args] of [['run', t.command, t.args], ['probe', t.availabilityProbe[0], t.availabilityProbe[1]]]) {
      if (cmd !== 'npx') continue;
      it(`${t.id} ${label}: --no-install AND --offline precede the tool name`, () => {
        const toolAt = args.findIndex((a) => !a.startsWith('--'));
        const flags = args.slice(0, toolAt);
        assert.ok(flags.includes('--no-install'), `${t.id} ${label} may install: ${args.join(' ')}`);
        assert.ok(flags.includes('--offline'), `${t.id} ${label} may contact the registry (--no-install alone still fetches metadata on npm 10): ${args.join(' ')}`);
      });
    }
  }
});

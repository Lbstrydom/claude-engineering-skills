/**
 * @fileoverview The shared AGENTS.md size oracle (scripts/lib/claudemd/context-size.mjs):
 * the unit is CHARACTERS of the decoded text, and the cap resolution agrees with the
 * gate (`check-context-drift.mjs`) it was extracted from.
 *
 * Plan: docs/plans/dashboard-home-summary.md §2 (Health strip, AGENTS.md size).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  agentsMdCharCount, resolveMaxAgentsMdChars, DEFAULT_MAX_AGENTS_MD_CHARS,
} from '../scripts/lib/claudemd/context-size.mjs';
import { runDriftCheck } from '../scripts/check-context-drift.mjs';


function withRepo(agents, config, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-size-'));
  try {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), agents);
    if (config !== undefined) fs.writeFileSync(path.join(dir, '.claude-context-allowlist.json'), config);
    return fn(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}

describe('agentsMdCharCount', () => {
  test('counts characters of the decoded text, never bytes', () => {
    const text = 'é'.repeat(100) + '—'.repeat(50); // 150 chars, 100*2 + 50*3 = 350 bytes
    assert.notEqual(Buffer.byteLength(text, 'utf8'), text.length, 'fixture must separate bytes from chars');
    assert.equal(agentsMdCharCount(text), 150);
    assert.equal(agentsMdCharCount('abc'), 3);
    assert.equal(agentsMdCharCount(''), 0);
  });

  test('a file on disk: char count differs from statSync size when non-ASCII', () => {
    withRepo('# Δ\n' + 'é'.repeat(10), undefined, (dir) => {
      const file = path.join(dir, 'AGENTS.md');
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(fs.statSync(file).size > text.length);
      assert.equal(agentsMdCharCount(text), text.length);
    });
  });
});

describe('resolveMaxAgentsMdChars', () => {
  test('default when no config', () => {
    withRepo('x', undefined, (dir) => assert.deepEqual(resolveMaxAgentsMdChars(dir), { cap: DEFAULT_MAX_AGENTS_MD_CHARS, source: 'default', problem: null }));
    assert.equal(DEFAULT_MAX_AGENTS_MD_CHARS, 92000);
  });
  test('a valid config wins', () => {
    withRepo('x', JSON.stringify({ maxAgentsMdChars: 1234 }), (dir) => assert.deepEqual(resolveMaxAgentsMdChars(dir), { cap: 1234, source: 'config', problem: null }));
  });
  test('M14: a config problem is REPORTED with the gate\'s own text, never silently replaced by the default', () => {
    for (const [name, cfg, kind] of [
      ['bad JSON', '{nope', /Failed to parse/],
      ['schema-invalid (unknown key)', JSON.stringify({ maxAgentsMdChars: 100, surprise: 1 }), /Invalid config at/],
      ['non-positive', JSON.stringify({ maxAgentsMdChars: -5 }), /Invalid config at/],
      ['wrong type', JSON.stringify({ maxAgentsMdChars: 'big' }), /Invalid config at/],
      ['retired field', JSON.stringify({ maxAgentsMdLines: 1200 }), /"maxAgentsMdLines" was retired 2026-08-01/],
    ]) {
      withRepo('x', cfg, (dir) => {
        const r = resolveMaxAgentsMdChars(dir);
        assert.equal(r.source, 'default', name);
        assert.match(r.problem, kind, name);
      });
    }
  });
  test('M14: an UNREADABLE config (a directory in its place) is a problem too', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-size-'));
    try {
      fs.mkdirSync(path.join(dir, '.claude-context-allowlist.json'));
      const r = resolveMaxAgentsMdChars(dir);
      assert.match(r.problem, /Failed to parse/);
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
  test('the retired field with a valid cap still reports the problem but keeps the cap (the gate does the same)', () => {
    withRepo('x', JSON.stringify({ maxAgentsMdLines: 1200, maxAgentsMdChars: 5000 }), (dir) => {
      const r = resolveMaxAgentsMdChars(dir);
      assert.equal(r.cap, 5000);
      assert.match(r.problem, /retired/);
    });
  });
  test('a missing root yields the default and no problem', () => {
    assert.deepEqual(resolveMaxAgentsMdChars(path.join(os.tmpdir(), 'definitely-not-here-ctx-size')), { cap: DEFAULT_MAX_AGENTS_MD_CHARS, source: 'default', problem: null });
  });
});

describe('parity with check-context-drift.mjs (one oracle, not a copy)', () => {
  const agents = '# AGENTS.md\n\n' + 'é'.repeat(300) + '\n';
  const cases = [
    ['valid cap below size', JSON.stringify({ maxAgentsMdChars: 100 })],
    ['valid cap above size', JSON.stringify({ maxAgentsMdChars: 100000 })],
    ['absent config', undefined],
    ['unparseable config', '{nope'],
    ['schema-invalid config', JSON.stringify({ maxAgentsMdChars: 100, extra: true })],
  ];
  for (const [name, cfg] of cases) {
    test(name, () => {
      withRepo(agents, cfg, (dir) => {
        const cap = resolveMaxAgentsMdChars(dir).cap;
        const { findings } = runDriftCheck(dir);
        const oversized = findings.filter((f) => f.ruleId === 'ctx/oversized-agents-md');
        const size = agentsMdCharCount(agents);
        assert.equal(oversized.length, size > cap ? 1 : 0, `size ${size} vs cap ${cap}`);
        if (oversized.length) {
          assert.match(oversized[0].message, new RegExp(`is ${size} characters .* the ${cap}-character`));
        }
      });
    });
  }
});

/**
 * Tests for scripts/skills-help.mjs
 *
 * parseSkill + loadAllSkills moved to scripts/lib/skills-index.mjs — their tests
 * live in tests/skills-index.test.mjs. This file covers what the CLI still owns.
 *
 * Coverage:
 *   1. parseArgs — flag handling + skill-name positional + ArgvError shape
 *   2. filterBySearch — name / oneLiner / triggers / usage matching
 *   3. CLI integration — spawn the script and check exit codes + stdout
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { filterBySearch, __test__ } from '../scripts/skills-help.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(TEST_DIR, '..', 'scripts', 'skills-help.mjs');

describe('filterBySearch', () => {
  const sample = [
    { name: 'audit-code', oneLiner: 'Audit code against plan.', triggers: ['audit'], usage: ['/audit-code'] },
    { name: 'brainstorm', oneLiner: 'Multi-LLM concept brainstorming.', triggers: ['/brainstorm'], usage: ['/brainstorm <topic>'] },
    { name: 'plan', oneLiner: 'Architecture planner.', triggers: ['plan this'], usage: ['/plan <task>'] },
  ];

  it('returns all when term is empty', () => {
    assert.equal(filterBySearch(sample, '').length, 3);
  });

  it('matches by name', () => {
    const r = filterBySearch(sample, 'brainstorm');
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'brainstorm');
  });

  it('matches by oneLiner (case-insensitive)', () => {
    const r = filterBySearch(sample, 'PLANNER');
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'plan');
  });

  it('matches by trigger', () => {
    const r = filterBySearch(sample, 'plan this');
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'plan');
  });

  it('matches by usage', () => {
    const r = filterBySearch(sample, '<topic>');
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'brainstorm');
  });
});

describe('parseArgs (internal)', () => {
  const { parseArgs } = __test__;

  it('default: no skill, no search, format=md', () => {
    const a = parseArgs([]);
    assert.equal(a.skill, null);
    assert.equal(a.format, 'md');
  });

  it('positional skill name', () => {
    const a = parseArgs(['explain']);
    assert.equal(a.skill, 'explain');
  });

  it('rejects multiple positional names', () => {
    assert.throws(() => parseArgs(['a', 'b']), /Multiple skill names/);
  });

  it('--search captures value', () => {
    const a = parseArgs(['--search', 'audit']);
    assert.equal(a.search, 'audit');
  });

  it('--json switches format', () => {
    const a = parseArgs(['--json']);
    assert.equal(a.format, 'json');
  });

  it('rejects unknown --flag', () => {
    assert.throws(() => parseArgs(['--no-such']), /Unknown flag/);
  });
});

describe('CLI integration (spawn)', () => {
  function run(argv) {
    return spawnSync('node', [CLI, ...argv], { encoding: 'utf-8', timeout: 8000, cwd: path.resolve(TEST_DIR, '..') });
  }

  it('default invocation lists all skills with markdown table headers', () => {
    const r = run([]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Available skills/);
    assert.match(r.stdout, /\| Skill \| One-liner \|/);
  });

  it('--json emits parseable JSON', () => {
    const r = run(['--json']);
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.ok(Array.isArray(parsed.skills));
    assert.ok(parsed.skills.length > 0);
  });

  it('detail mode renders frontmatter sections', () => {
    const r = run(['explain']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^# \/explain/m);
    assert.match(r.stdout, /\*\*Triggers on:\*\*/);
    assert.match(r.stdout, /\*\*Usage:\*\*/);
  });

  it('unknown skill exits 1 with suggestion', () => {
    const r = run(['expla']);  // partial — should suggest "explain"
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not found/);
    assert.match(r.stderr, /Did you mean.*explain/);
  });

  it('--search filters and announces the filter', () => {
    const r = run(['--search', 'audit']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Filtered by search: "audit"/);
  });

  it('--help exits 0 with usage text', () => {
    const r = run(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /USAGE/);
  });
});

/**
 * Tests for scripts/skills-help.mjs
 *
 * Coverage:
 *   1. parseSkill — frontmatter extraction + edge cases (CRLF, missing fields,
 *      disable-model-invocation buried inside description literal block)
 *   2. parseArgs — flag handling + skill-name positional + ArgvError shape
 *   3. filterBySearch — name / oneLiner / triggers / usage matching
 *   4. loadAllSkills — graceful empty when skills/ missing
 *   5. CLI integration — spawn the script and check exit codes + stdout
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseSkill, loadAllSkills, filterBySearch, __test__,
} from '../scripts/skills-help.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(TEST_DIR, '..', 'scripts', 'skills-help.mjs');

function mkTmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skills-help-'));
}

function writeSkill(repoRoot, name, body) {
  const dir = path.join(repoRoot, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, body);
  return file;
}

describe('parseSkill', () => {
  it('extracts name + oneLiner + triggers + usage from a clean LF file', () => {
    const root = mkTmpRepo();
    const file = writeSkill(root, 'foo', `---
name: foo
description: |
  A short summary sentence.
  More background that should NOT be the one-liner.
  Triggers on: "do foo", "run foo", "/foo"
  Usage:
    /foo arg                 — does the thing
    /foo --flag              — does the thing with a flag
---

# Foo
Body.
`);
    const r = parseSkill(file);
    assert.equal(r.name, 'foo');
    assert.equal(r.oneLiner, 'A short summary sentence.');
    assert.deepEqual(r.triggers, ['do foo', 'run foo', '/foo']);
    assert.equal(r.usage.length, 2);
    assert.match(r.usage[0], /\/foo arg/);
    assert.equal(r.disableModelInvocation, false);
  });

  it('falls back to a `## Usage` body section when the frontmatter has none (Copilot 1024-cap relocation)', () => {
    // Regression: 2026-07-21 six skills relocated Usage out of the ≤1024-char
    // description into a body `## Usage` fence; parseSkill scraped Usage only
    // from the description and silently dropped it (caught by the Gemini gate).
    const root = mkTmpRepo();
    const file = writeSkill(root, 'baz', `---
name: baz
description: |
  A short summary.
  Triggers on: "do baz", "/baz"
  Full command syntax: see the Usage section in this skill.
---

# Baz

## Usage

\`\`\`
Usage: /baz <arg>            — does the thing
Usage: /baz --flag          — with a flag
Triggers on: "do baz", "/baz"
\`\`\`

More body.
`);
    const r = parseSkill(file);
    assert.equal(r.name, 'baz');
    assert.deepEqual(r.triggers, ['do baz', '/baz'], 'triggers still come from the description');
    assert.equal(r.usage.length, 2, 'both Usage lines recovered from the body fence');
    assert.match(r.usage[0], /\/baz <arg>/);
    assert.ok(!r.usage.some((u) => /triggers on:/i.test(u)), 'stray Triggers line in the fence is not treated as usage');
  });

  it('handles CRLF line endings', () => {
    const root = mkTmpRepo();
    const lfBody = `---
name: bar
description: |
  CRLF test.
  Triggers on: "bar"
  Usage:
    /bar
---

Body
`;
    const file = writeSkill(root, 'bar', lfBody.replace(/\n/g, '\r\n'));
    const r = parseSkill(file);
    assert.ok(r, 'should parse despite CRLF');
    assert.equal(r.name, 'bar');
  });

  it('handles disable-model-invocation as a top-level YAML key', () => {
    const root = mkTmpRepo();
    const file = writeSkill(root, 'baz', `---
name: baz
description: |
  Manual-only skill.
  Triggers on: "/baz"
  Usage:
    /baz
disable-model-invocation: true
---
`);
    const r = parseSkill(file);
    assert.equal(r.disableModelInvocation, true);
  });

  it('returns null on missing frontmatter', () => {
    const root = mkTmpRepo();
    const file = writeSkill(root, 'noframe', `# No frontmatter\nJust body.\n`);
    assert.equal(parseSkill(file), null);
  });

  it('returns null on missing name', () => {
    const root = mkTmpRepo();
    const file = writeSkill(root, 'anon', `---
description: |
  Anonymous.
---
`);
    assert.equal(parseSkill(file), null);
  });

  it('returns null on missing description', () => {
    const root = mkTmpRepo();
    const file = writeSkill(root, 'nodesc', `---
name: nodesc
---
`);
    assert.equal(parseSkill(file), null);
  });

  it('returns null on unreadable file', () => {
    const r = parseSkill(path.join(os.tmpdir(), 'definitely-does-not-exist.md'));
    assert.equal(r, null);
  });

  it('extracts first sentence even when no period present', () => {
    const root = mkTmpRepo();
    const file = writeSkill(root, 'noperiod', `---
name: noperiod
description: |
  No period in this summary text
  Triggers on: "x"
  Usage:
    /noperiod
---
`);
    const r = parseSkill(file);
    assert.match(r.oneLiner, /No period in this summary text/);
  });
});

describe('loadAllSkills', () => {
  it('returns [] when skills/ does not exist', () => {
    const root = mkTmpRepo();
    const cwd = process.cwd();
    process.chdir(root);
    try {
      assert.deepEqual(loadAllSkills(), []);
    } finally { process.chdir(cwd); }
  });

  it('returns sorted array when present', () => {
    const root = mkTmpRepo();
    writeSkill(root, 'zebra', `---
name: zebra
description: |
  Z skill.
  Triggers on: "z"
  Usage: /zebra
---
`);
    writeSkill(root, 'alpha', `---
name: alpha
description: |
  A skill.
  Triggers on: "a"
  Usage: /alpha
---
`);
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const skills = loadAllSkills();
      assert.equal(skills.length, 2);
      assert.equal(skills[0].name, 'alpha');
      assert.equal(skills[1].name, 'zebra');
    } finally { process.chdir(cwd); }
  });

  it('skips directories without SKILL.md', () => {
    const root = mkTmpRepo();
    fs.mkdirSync(path.join(root, 'skills', 'no-skill-md'), { recursive: true });
    writeSkill(root, 'has-skill', `---
name: has-skill
description: |
  Real one.
  Triggers on: "x"
  Usage: /has-skill
---
`);
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const skills = loadAllSkills();
      assert.equal(skills.length, 1);
      assert.equal(skills[0].name, 'has-skill');
    } finally { process.chdir(cwd); }
  });
});

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

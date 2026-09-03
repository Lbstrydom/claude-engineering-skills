/**
 * @fileoverview SKILL.md frontmatter LAYOUT lint — a known key indented under a
 * block scalar is description text, not a key, and the declaration is inert.
 *
 * The broken and fixed forms differ only by leading whitespace, so a gate for
 * this defect passes vacuously if its probe is wrong. Every negative control
 * here is therefore adjudicated by the YAML parser, not by the lexer under test:
 * the poison fixture must parse with `disable-model-invocation` ABSENT from the
 * top level and PRESENT as the tail of the description; the dedented form must
 * parse with it present as boolean `true`. If either half stopped holding, the
 * lint could be green for the wrong reason and these tests would say so.
 *
 * Fixture provenance: `tests/fixtures/poison/skill-frontmatter-indented-key.md`
 * is the real frontmatter of a consumer's `.claude/skills/audit/SKILL.md`
 * (wine-cellar-app, installed 2026-03-06, measured inert 2026-09-03) — a row
 * from the store, not a hand-written factory (AGENTS.md prose↔code seam rule).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'yaml';

import {
  KNOWN_TOP_LEVEL_KEYS, BOOLEAN_FLAG_KEYS, FINDING_KINDS,
  extractFrontmatterLines, lintSkillFrontmatterLayout, lintSkillTree,
} from '../scripts/lib/skill-frontmatter-layout.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'check-skill-frontmatter.mjs');
const FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'poison', 'skill-frontmatter-indented-key.md');
const poison = fs.readFileSync(FIXTURE, 'utf-8');

/** The fixture with its one defect repaired — the fix under test, applied to the real bytes. */
const INDENTED_LINE = '  disable-model-invocation: true';
const dedented = poison.replace(/^ {2}disable-model-invocation: true$/m, 'disable-model-invocation: true');

/** Independent oracle: parse the frontmatter with `yaml` directly, no lint code involved. */
function parseFrontmatterDirect(md) {
  const m = md.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  return m ? yaml.parse(m[1]) : null;
}

function skillMd({ name = 'demo', descriptionLines = ['Does a thing.'], top = [] }) {
  return ['---', `name: ${name}`, 'description: |', ...descriptionLines.map((l) => `  ${l}`), ...top, '---', '', '# Body', ''].join('\n');
}

function runCli(args, cwd = REPO_ROOT) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function tempTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-layout-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

describe('the fixture is the real defect (instrument check on the probe itself)', () => {
  it('carries the indented key at file line 12, exactly as measured in the consumer', () => {
    const lines = poison.replace(/\r\n/g, '\n').split('\n');
    assert.equal(lines[11], INDENTED_LINE, 'line 12 must be the two-space-indented declaration');
    assert.equal(lines[12], '---', 'and the frontmatter closes right after it');
  });

  it('the YAML parser (not the lint) confirms the key is description TEXT, absent at top level', () => {
    const fm = parseFrontmatterDirect(poison);
    assert.equal(Object.prototype.hasOwnProperty.call(fm, 'disable-model-invocation'), false);
    assert.match(fm.description, /\ndisable-model-invocation: true\n?$/, 'the literal string trails the description');
  });

  it('the dedented form parses with the key PRESENT as boolean true — the fix works, by the parser', () => {
    assert.notEqual(dedented, poison, 'the replacement must have changed something');
    const fm = parseFrontmatterDirect(dedented);
    assert.equal(fm['disable-model-invocation'], true);
    assert.equal(typeof fm['disable-model-invocation'], 'boolean');
    assert.doesNotMatch(fm.description, /disable-model-invocation/);
  });
});

describe('lintSkillFrontmatterLayout — negative control (must FAIL on the probe)', () => {
  it('fails the real consumer fixture with indented-known-key at line 12', () => {
    const r = lintSkillFrontmatterLayout(poison, { file: 'audit/SKILL.md' });
    assert.equal(r.ok, false);
    assert.equal(r.findings.length, 1);
    const [f] = r.findings;
    assert.equal(f.kind, 'indented-known-key');
    assert.equal(f.key, 'disable-model-invocation');
    assert.equal(f.line, 12);
    assert.equal(f.text, INDENTED_LINE);
    assert.match(f.message, /indented under a block scalar/);
    assert.match(f.message, /audit\/SKILL\.md:12/);
    assert.deepEqual(r.topLevelKnownKeys, [], 'the parser surfaced nothing at the top level');
  });

  it('passes the same bytes once the key is dedented, and reports the key as live', () => {
    const r = lintSkillFrontmatterLayout(dedented, { file: 'audit/SKILL.md' });
    assert.equal(r.ok, true, JSON.stringify(r.findings));
    assert.deepEqual(r.topLevelKnownKeys, ['disable-model-invocation']);
    assert.equal(r.parsed['disable-model-invocation'], true);
  });

  for (const key of KNOWN_TOP_LEVEL_KEYS) {
    const value = BOOLEAN_FLAG_KEYS.includes(key) ? 'true' : (key === 'allowed-tools' ? 'Bash, Read' : 'x');
    it(`${key}: indented → fails; column 0 → passes`, () => {
      const bad = skillMd({ descriptionLines: ['Summary.', `${key}: ${value}`] });
      const rb = lintSkillFrontmatterLayout(bad);
      assert.equal(rb.ok, false);
      assert.deepEqual(rb.findings.map((f) => [f.kind, f.key, f.line]), [['indented-known-key', key, 5]]);

      const good = skillMd({ top: [`${key}: ${value}`] });
      const rg = lintSkillFrontmatterLayout(good);
      assert.equal(rg.ok, true, JSON.stringify(rg.findings));
      assert.deepEqual(rg.topLevelKnownKeys, [key]);
    });
  }

  it('fires inside a folded (>) scalar too — both block-scalar indicators', () => {
    const md = ['---', 'name: demo', 'description: >', '  Summary.', '  model: opus', '---', ''].join('\n');
    const r = lintSkillFrontmatterLayout(md);
    assert.deepEqual(r.findings.map((f) => [f.kind, f.key, f.line]), [['indented-known-key', 'model', 5]]);
  });

  it('fires on a known key nested under another map (also not a top-level key)', () => {
    const md = ['---', 'name: demo', 'description: d', 'metadata:', '  license: MIT', '---', ''].join('\n');
    const r = lintSkillFrontmatterLayout(md);
    assert.deepEqual(r.findings.map((f) => [f.kind, f.key]), [['indented-known-key', 'license']]);
  });

  it('a boolean flag at column 0 with a non-boolean value is inert too (non-boolean-flag)', () => {
    for (const bad of ['"true"', 'yes', '1']) {
      const r = lintSkillFrontmatterLayout(skillMd({ top: [`disable-model-invocation: ${bad}`] }));
      assert.equal(r.ok, false, bad);
      assert.deepEqual(r.findings.map((f) => f.kind), ['non-boolean-flag'], bad);
    }
    const r = lintSkillFrontmatterLayout(skillMd({ top: ['disable-model-invocation: false'] }));
    assert.equal(r.ok, true, 'an explicit false is a valid boolean');
  });

  it('fails closed on no frontmatter and on unparseable YAML — never reports clean unverified', () => {
    const none = lintSkillFrontmatterLayout('# just a body\n');
    assert.equal(none.ok, false);
    assert.deepEqual(none.findings.map((f) => f.kind), ['no-frontmatter']);
    const broken = lintSkillFrontmatterLayout('---\nname: [unclosed\n---\n');
    assert.equal(broken.ok, false);
    assert.deepEqual(broken.findings.map((f) => f.kind), ['unparseable-yaml']);
  });

  it('every finding kind is in the closed FINDING_KINDS set', () => {
    const seen = new Set();
    for (const md of [poison, '# body', '---\nname: [x\n---\n', skillMd({ top: ['user-invocable: "no"'] })]) {
      for (const f of lintSkillFrontmatterLayout(md).findings) seen.add(f.kind);
    }
    for (const k of seen) assert.ok(FINDING_KINDS.includes(k), k);
  });
});

describe('lintSkillFrontmatterLayout — the direction it must NOT fire', () => {
  it('a key name mentioned mid-line in the description is prose, not a declaration', () => {
    const md = skillMd({ descriptionLines: ['Sets disable-model-invocation: true on itself; see allowed-tools: docs.'] });
    const r = lintSkillFrontmatterLayout(md);
    assert.equal(r.ok, true, JSON.stringify(r.findings));
  });

  it('a column-0 list value under allowed-tools is not an indented key', () => {
    const md = skillMd({ top: ['allowed-tools:', '  - Bash', '  - Read'] });
    const r = lintSkillFrontmatterLayout(md);
    assert.equal(r.ok, true, JSON.stringify(r.findings));
    assert.deepEqual(r.parsed['allowed-tools'], ['Bash', 'Read']);
  });

  it('a body line that looks like a key, after the closing ---, is out of scope', () => {
    const md = skillMd({}) + '\n  disable-model-invocation: true\n';
    assert.equal(lintSkillFrontmatterLayout(md).ok, true);
  });

  it('CRLF input lints identically to LF (the consumer file is checked out with autocrlf)', () => {
    const crlf = poison.replace(/\n/g, '\r\n');
    const r = lintSkillFrontmatterLayout(crlf);
    assert.deepEqual(r.findings.map((f) => [f.kind, f.line]), [['indented-known-key', 12]]);
    assert.equal(lintSkillFrontmatterLayout(dedented.replace(/\n/g, '\r\n')).ok, true);
  });

  it('extractFrontmatterLines: no opening fence → null; unclosed fence → null', () => {
    assert.equal(extractFrontmatterLines('name: x\n---\n'), null);
    assert.equal(extractFrontmatterLines('---\nname: x\n'), null);
    assert.deepEqual(extractFrontmatterLines('---\nname: x\n---\nbody'), { lines: ['name: x'], firstLine: 2 });
  });
});

describe('positive control — the real skills/ tree', () => {
  it('every authored skill passes, and the three that declare the flag have it LIVE as boolean true', () => {
    const tree = lintSkillTree(path.join(REPO_ROOT, 'skills'));
    assert.equal(tree.ok, true, JSON.stringify(tree.findings, null, 2));
    assert.ok(tree.skills.length >= 10, `expected the real roster, got ${tree.skills.length}`);
    const live = tree.skills.filter((s) => s.result.parsed['disable-model-invocation'] === true).map((s) => s.name);
    // ship/security-strategy/skills each carry the flag at column 0 and explain
    // why in their body. If this set shrinks, either a skill dropped the flag on
    // purpose (update this) or the flag went inert (the gate above catches it).
    for (const expected of ['ship', 'security-strategy', 'skills']) assert.ok(live.includes(expected), `${expected} flag not live: ${live}`);
  });

  it('the generated .claude/skills/ copy agrees (it is what every host actually reads)', () => {
    const tree = lintSkillTree(path.join(REPO_ROOT, '.claude', 'skills'));
    assert.equal(tree.ok, true, JSON.stringify(tree.findings, null, 2));
  });
});

describe('lintSkillTree', () => {
  it('reports the defect per skill and is not ok on zero skills (checked nothing ≠ clean)', () => {
    const root = tempTree({
      'good/SKILL.md': skillMd({ name: 'good', top: ['disable-model-invocation: true'] }),
      'bad/SKILL.md': poison,
      'not-a-skill/README.md': '# no SKILL.md here\n',
    });
    try {
      const t = lintSkillTree(root);
      assert.equal(t.ok, false);
      assert.deepEqual(t.skills.map((s) => s.name), ['bad', 'good']);
      assert.deepEqual(t.findings.map((f) => [f.name, f.kind, f.line]), [['bad', 'indented-known-key', 12]]);
      assert.equal(lintSkillTree(path.join(root, 'not-a-skill')).reason, 'no-skills');
      assert.equal(lintSkillTree(path.join(root, 'absent')).reason, 'unreadable');
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('check-skill-frontmatter.mjs CLI', () => {
  it('exit 0 on the real tree, naming the skills whose flag is live', () => {
    const r = runCli([]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /skill-frontmatter: OK/);
    assert.match(r.stdout, /ship: disable-model-invocation/);
  });

  it('exit 1 with the gate\'s own message on a tree carrying the fixture (negative control)', () => {
    const root = tempTree({ 'audit/SKILL.md': poison, 'ok/SKILL.md': skillMd({ name: 'ok' }) });
    try {
      const r = runCli(['--root', root]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /skill-frontmatter: FAILED/);
      assert.match(r.stderr, /audit\/SKILL\.md:12/);
      assert.match(r.stderr, /indented under a block scalar/);
      const j = runCli(['--root', root, '--json']);
      assert.equal(j.status, 1);
      const parsed = JSON.parse(j.stdout);
      assert.equal(parsed.ok, false);
      assert.deepEqual(parsed.findings.map((f) => [f.name, f.kind, f.line]), [['audit', 'indented-known-key', 12]]);
      assert.deepEqual(parsed.topLevel.audit, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('exit 0 once the fixture is dedented in place — the fix, end to end', () => {
    const root = tempTree({ 'audit/SKILL.md': dedented });
    try {
      const r = runCli(['--root', root]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /audit: disable-model-invocation/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('exit 2 on an empty or missing root, and on an unknown flag', () => {
    const root = tempTree({ 'empty/.keep': '' });
    try {
      assert.equal(runCli(['--root', root]).status, 2);
      assert.equal(runCli(['--root', path.join(root, 'nope')]).status, 2);
      assert.equal(runCli(['--rooot', root]).status, 2);
      assert.equal(runCli(['--root']).status, 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('is wired into skills:check and declares a poison pill on the fixture', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
    assert.match(pkg.scripts['skills:check'], /node scripts\/check-skill-frontmatter\.mjs/);
    const contract = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'gate-contracts', 'skills-check.json'), 'utf-8'));
    const pill = contract.gates.find((g) => g.implementation === 'scripts/check-skill-frontmatter.mjs');
    assert.ok(pill, 'contract entry missing');
    assert.equal(pill.id, 'skills-check-detects-indented-frontmatter-key');
    assert.equal(pill.poisonPill.overlay['skills/ship/SKILL.md'], 'tests/fixtures/poison/skill-frontmatter-indented-key.md');
    assert.equal(pill.poisonPill.expectStderr, 'indented under a block scalar');
  });
});

/**
 * `allowed-tools` pre-approval contract (docs/plans/skill-best-practice-alignment.md, Track B).
 *
 * Claude Code applies a skill's `allowed-tools` for the invoking turn even in an
 * untrusted folder, so a synced skill pre-approves in every consumer. These tests
 * pin the rule that keeps that grant to exact read-only local commands, in BOTH
 * layouts, and assert on the bytes the real sync rewriter emits rather than on
 * the source we hope it emits.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALLOWED_TOOLS_PREAPPROVABLE,
  lintSkillFrontmatterLayout,
  lintSkillTree,
} from '../scripts/lib/skill-frontmatter-layout.mjs';
import { REGISTRY } from '../scripts/lib/cross-skill/registry.mjs';
import { rewriteCommandSurface, buildOwnedSourceTails } from '../scripts/lib/sync-rewriter.mjs';

/**
 * Second check on the allowlist: every entry must name a cross-skill subcommand the
 * registry declares `kind:'local'` + `cloud:'none'`. Necessary, never sufficient —
 * `arm-eval-toggle` is local/none and still writes — so it never REPLACES the explicit
 * list; it fails the day the registry says an allowlisted command reads or writes the
 * store. Lives in the test, not the install-domain CLI, so that CLI keeps no
 * dependency on the cross-skill bridge (domain map).
 */
function allowlistRegistryProblems(allowlist = ALLOWED_TOOLS_PREAPPROVABLE, registry = REGISTRY) {
  const problems = [];
  for (const command of allowlist) {
    const m = /^node scripts\/cross-skill\.mjs ([a-z0-9-]+)(?:\s|$)/.exec(command);
    if (!m) { problems.push(`not a cross-skill.mjs subcommand: ${command}`); continue; }
    const entry = registry.find((c) => c.name === m[1]);
    if (!entry) problems.push(`not in the registry: ${m[1]}`);
    else if (entry.kind !== 'local' || entry.cloud !== 'none') problems.push(`${m[1]} is kind:${entry.kind}, cloud:${entry.cloud}`);
  }
  return problems;
}

const REPO = path.resolve(import.meta.dirname, '..');
const DETECT = 'node scripts/cross-skill.mjs detect-stack';
const PREVIEW = 'node scripts/cross-skill.mjs preview-gate --format human';

const skill = (fm) => `---\nname: s\ndescription: d\n${fm}\n---\n\n# s\n`;
const kinds = (fm) => lintSkillFrontmatterLayout(skill(fm), { file: 's/SKILL.md' }).findings.map((f) => f.kind);

describe('allowed-tools — accepted forms', () => {
  test('a single allowlisted command passes', () => {
    assert.deepEqual(kinds(`allowed-tools: Bash(${DETECT})`), []);
  });
  test('several allowlisted commands separated by one space pass', () => {
    assert.deepEqual(kinds(`allowed-tools: Bash(${DETECT}) Bash(${PREVIEW})`), []);
  });
  test('a quoted scalar passes', () => {
    assert.deepEqual(kinds(`allowed-tools: "Bash(${DETECT})"`), []);
  });
  test('the consumer layout (as rewritten by the sync) passes', () => {
    assert.deepEqual(kinds('allowed-tools: Bash(node scripts/.claude-skills/cross-skill.mjs detect-stack)'), []);
  });
  test('absent key is fine', () => {
    assert.deepEqual(kinds('model: inherit'), []);
  });
});

describe('allowed-tools — rejected forms', () => {
  const cases = [
    ['a non-allowlisted cross-skill subcommand', 'allowed-tools: Bash(node scripts/cross-skill.mjs get-neighbourhood)', 'allowed-tools-not-preapprovable'],
    ['a spend-bearing script', 'allowed-tools: Bash(node scripts/openai-audit.mjs plan)', 'allowed-tools-not-preapprovable'],
    ['any wildcard', `allowed-tools: Bash(${DETECT} *)`, 'allowed-tools-not-preapprovable'],
    ['a trailing argument such as --out', `allowed-tools: Bash(${DETECT} --out x.json)`, 'allowed-tools-not-preapprovable'],
    ['a non-Bash tool', 'allowed-tools: Edit', 'allowed-tools-malformed'],
    ['a bare Bash', 'allowed-tools: Bash', 'allowed-tools-malformed'],
    ['a valid token mixed with an invalid one', `allowed-tools: Bash(${DETECT}) Bash(node scripts/ship-commit.mjs)`, 'allowed-tools-not-preapprovable'],
    ['double spaces between tokens', `allowed-tools: Bash(${DETECT})  Bash(${PREVIEW})`, 'allowed-tools-malformed'],
    ['trailing text', `allowed-tools: Bash(${DETECT}) Read`, 'allowed-tools-malformed'],
    ['a repeated token', `allowed-tools: Bash(${DETECT}) Bash(${DETECT})`, 'allowed-tools-malformed'],
    ['a YAML list', `allowed-tools:\n  - Bash(${DETECT})`, 'allowed-tools-malformed'],
    ['a block scalar', `allowed-tools: |\n  Bash(${DETECT})`, 'allowed-tools-malformed'],
  ];
  for (const [name, fm, kind] of cases) {
    test(name, () => assert.ok(kinds(fm).includes(kind), `expected ${kind}, got ${JSON.stringify(kinds(fm))}`));
  }
  test('a duplicated key is refused (the parser rejects it before the rule runs)', () => {
    assert.deepEqual(kinds(`allowed-tools: Bash(${DETECT})\nallowed-tools: Bash(${PREVIEW})`), ['unparseable-yaml']);
  });
});

describe('allowlist ↔ registry cross-check', () => {
  test('the real allowlist agrees with the real registry', () => {
    assert.deepEqual(allowlistRegistryProblems(), []);
  });
  test('an allowlisted command the registry declares as a writer fails', () => {
    const fake = [{ name: 'detect-stack', kind: 'write', cloud: 'required' }, { name: 'preview-gate', kind: 'local', cloud: 'none' }];
    const problems = allowlistRegistryProblems(ALLOWED_TOOLS_PREAPPROVABLE, fake);
    assert.ok(problems.length > 0 && problems.every((p) => p.startsWith('detect-stack')), JSON.stringify(problems));
  });
});

describe('the real skills', () => {
  test('every skills/*/SKILL.md passes, and the declared grants are the planned ones', () => {
    const tree = lintSkillTree(path.join(REPO, 'skills'));
    assert.equal(tree.ok, true, JSON.stringify(tree.findings, null, 2));
    const grants = Object.fromEntries(tree.skills
      .filter((s) => s.result.parsed && 'allowed-tools' in s.result.parsed)
      .map((s) => [s.name, s.result.parsed['allowed-tools']]));
    assert.deepEqual(grants, {
      cycle: `Bash(${PREVIEW})`,
      plan: `Bash(${DETECT})`,
      ship: `Bash(${DETECT} --include-env-manager)`,
    });
  });

  test('negative control: injecting a spend-bearing grant into a real skill fails the tree lint', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'allowed-tools-'));
    fs.mkdirSync(path.join(root, 'plan'));
    const real = fs.readFileSync(path.join(REPO, 'skills', 'plan', 'SKILL.md'), 'utf-8');
    const poisoned = real.replace(/^allowed-tools: .*$/m, 'allowed-tools: Bash(node scripts/openai-audit.mjs *)');
    assert.notEqual(poisoned, real, 'the fixture must actually change the grant');
    fs.writeFileSync(path.join(root, 'plan', 'SKILL.md'), poisoned);
    assert.equal(lintSkillTree(root).ok, false);
  });
});

describe('emitted bytes in both layouts', () => {
  const rel = 'skills/plan/SKILL.md';
  const source = fs.readFileSync(path.join(REPO, rel), 'utf-8');

  test('the sync rewriter emits the consumer layout, and that copy still lints clean (doctor gate 9 path)', () => {
    const { rewritten } = rewriteCommandSurface({
      relPath: rel, content: source, config: { ownedSourceTails: buildOwnedSourceTails(['scripts/cross-skill.mjs']) },
    });
    const fmLine = rewritten.split(/\r?\n/).find((l) => l.startsWith('allowed-tools:'));
    assert.equal(fmLine, 'allowed-tools: Bash(node scripts/.claude-skills/cross-skill.mjs detect-stack)');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'allowed-tools-consumer-'));
    fs.mkdirSync(path.join(root, 'plan'));
    fs.writeFileSync(path.join(root, 'plan', 'SKILL.md'), rewritten);
    assert.equal(lintSkillTree(root).ok, true);
  });

  test('the regenerated source-repo copy keeps the source layout', () => {
    const copy = fs.readFileSync(path.join(REPO, '.claude', 'skills', 'plan', 'SKILL.md'), 'utf-8');
    const fmLine = copy.split(/\r?\n/).find((l) => l.startsWith('allowed-tools:'));
    assert.equal(fmLine, `allowed-tools: Bash(${DETECT})`);
  });
});

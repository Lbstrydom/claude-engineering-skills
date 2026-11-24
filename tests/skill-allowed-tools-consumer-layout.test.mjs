/**
 * @fileoverview `allowed-tools` validation must hold in the CONSUMER layout, end to end.
 *
 * Field report 2026-11-21: after a sync, every consumer's `doctor` failed
 * `sync/skill-frontmatter-layout` on cycle/plan/ship with
 * `allowed-tools-not-preapprovable`, though each declaration was correct. The
 * sync rewrites `node scripts/X` to `node scripts/.claude-skills/X` in the
 * SKILL.md AND in the string literals of ALLOWED_TOOLS_PREAPPROVABLE, while the
 * check folded only the SKILL.md side back to the source layout. Source-repo
 * tests never see the rewritten module, so this test applies the REAL rewriter
 * to the REAL module and the REAL skills, imports the result, and lints it.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { rewriteCommandSurface } from '../scripts/lib/sync-rewriter.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const MODULE_REL = 'scripts/lib/skill-frontmatter-layout.mjs';
const SKILLS = ['cycle', 'plan', 'ship-checked'];
const config = { ownedSourceTails: new Set(['cross-skill.mjs']) };
const rewrite = (relPath, content) => rewriteCommandSurface({ relPath, content, config }).rewritten;

// Inside the repo so the rewritten copy resolves `yaml` from this repo's node_modules.
const tmpDir = path.join(REPO_ROOT, '.claude', 'tmp', `allowed-tools-consumer-${process.pid}`);

async function loadModule(source) {
  const file = path.join(tmpDir, `layout-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(file, source);
  return import(pathToFileURL(file).href);
}

// Through the public entry point doctor uses, filtered to the allowed-tools kinds.
function lintSkill(mod, skillSource, name) {
  const { findings } = mod.lintSkillFrontmatterLayout(skillSource, { file: `.claude/skills/${name}/SKILL.md` });
  return findings.filter((f) => f.key === 'allowed-tools');
}

before(() => fs.mkdirSync(tmpDir, { recursive: true }));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

describe('allowed-tools in the consumer layout', () => {
  const moduleSource = fs.readFileSync(path.join(REPO_ROOT, MODULE_REL), 'utf-8');

  it('the rewriter really does rewrite the allowlist literals (the premise of this test)', () => {
    const consumer = rewrite(MODULE_REL, moduleSource);
    assert.match(consumer, /'node scripts\/\.claude-skills\/cross-skill\.mjs preview-gate --format human'/);
  });

  it('the shipped cycle/plan/ship declarations validate after the sync rewrites BOTH sides', async () => {
    const mod = await loadModule(rewrite(MODULE_REL, moduleSource));
    for (const name of SKILLS) {
      const rel = `.claude/skills/${name}/SKILL.md`;
      const consumerSkill = rewrite(rel, fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8'));
      assert.match(consumerSkill, /^allowed-tools: Bash\(node scripts\/\.claude-skills\//m, `${name}: rewrite premise`);
      assert.deepEqual(lintSkill(mod, consumerSkill, name), [], `${name} must not be flagged in the consumer layout`);
    }
  });

  it('still refuses a non-allowlisted command in the consumer layout (no vacuous pass)', async () => {
    const mod = await loadModule(rewrite(MODULE_REL, moduleSource));
    const skill = '---\nname: x\ndescription: d\nallowed-tools: Bash(node scripts/.claude-skills/cross-skill.mjs upstream report)\n---\n';
    const findings = lintSkill(mod, skill, 'x');
    assert.deepEqual(findings.map((f) => f.kind), ['allowed-tools-not-preapprovable']);
  });

  it('NEGATIVE CONTROL: with the list-side fold removed, the consumer layout fails as reported', async () => {
    const unfixed = moduleSource.replace(
      /const PREAPPROVABLE_SOURCE = Object\.freeze\(ALLOWED_TOOLS_PREAPPROVABLE\.map\(toSourceLayout\)\);/,
      'const PREAPPROVABLE_SOURCE = ALLOWED_TOOLS_PREAPPROVABLE;',
    );
    assert.notEqual(unfixed, moduleSource, 'control must actually remove the fold');
    const mod = await loadModule(rewrite(MODULE_REL, unfixed));
    const rel = '.claude/skills/cycle/SKILL.md';
    const consumerSkill = rewrite(rel, fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8'));
    assert.deepEqual(lintSkill(mod, consumerSkill, 'cycle').map((f) => f.kind), ['allowed-tools-not-preapprovable']);
  });
});

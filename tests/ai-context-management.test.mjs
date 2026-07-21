import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

import { runDriftCheck } from '../scripts/check-context-drift.mjs';

const SKILL_DIR = path.resolve('skills/ai-context-management');
const SKILL_MD = path.join(SKILL_DIR, 'SKILL.md');
const REFS_DIR = path.join(SKILL_DIR, 'references');
const EXAMPLES_DIR = path.join(SKILL_DIR, 'examples');

const EXPECTED_REFS = [
  'drift-rules.md',
  'reconcile-playbook.md',
  'canonical-flip.md',
];
const EXPECTED_EXAMPLES = [
  'slim-claude-md.md',
  'well-formed-agents-md.md',
  'monorepo-layout.md',
];

function readSkillContent() {
  return fs.readFileSync(SKILL_MD, 'utf-8');
}

describe('ai-context-management skill', () => {
  describe('skill structure', () => {
    it('SKILL.md exists', () => {
      assert.ok(fs.existsSync(SKILL_MD), `${SKILL_MD} must exist`);
    });

    it('SKILL.md has valid YAML frontmatter with name + description', () => {
      const content = readSkillContent();
      assert.ok(content.startsWith('---'), 'must start with ---');
      const endIdx = content.indexOf('---', 3);
      assert.ok(endIdx > 3, 'must have closing ---');
      const fm = content.slice(3, endIdx);
      assert.match(fm, /^name:\s*ai-context-management/m);
      assert.match(fm, /^description:/m);
    });

    it('SKILL.md is ≤3K tokens (rough char proxy: ≤12K chars)', () => {
      const content = readSkillContent();
      assert.ok(content.length <= 12000,
        `SKILL.md is ${content.length} chars, exceeds 12K target`);
    });

    it('SKILL.md describes all 3 documented modes', () => {
      const content = readSkillContent();
      // generate-prompts mode retired with the .github/prompts shim surface (2026-07-21).
      for (const mode of ['audit', 'reconcile', 'migrate']) {
        assert.match(content, new RegExp(`/ai-context-management ${mode}`),
          `must document mode: ${mode}`);
      }
    });

    it('SKILL.md ends with the standard "## Reference files" section', () => {
      const content = readSkillContent();
      assert.match(content, /## Reference files/);
    });

    it('SKILL.md reference table covers all expected files', () => {
      const content = readSkillContent();
      for (const f of [...EXPECTED_REFS.map(r => `references/${r}`), ...EXPECTED_EXAMPLES.map(e => `examples/${e}`)]) {
        assert.ok(content.includes(`\`${f}\``),
          `reference table must list \`${f}\``);
      }
    });
  });

  describe('reference files', () => {
    for (const ref of EXPECTED_REFS) {
      it(`references/${ref} exists`, () => {
        assert.ok(fs.existsSync(path.join(REFS_DIR, ref)));
      });

      it(`references/${ref} has summary frontmatter`, () => {
        const content = fs.readFileSync(path.join(REFS_DIR, ref), 'utf-8');
        assert.ok(content.startsWith('---'), 'must start with ---');
        assert.match(content, /^summary:/m);
      });
    }
  });

  describe('example files', () => {
    for (const ex of EXPECTED_EXAMPLES) {
      it(`examples/${ex} exists`, () => {
        assert.ok(fs.existsSync(path.join(EXAMPLES_DIR, ex)));
      });

      it(`examples/${ex} has summary frontmatter`, () => {
        const content = fs.readFileSync(path.join(EXAMPLES_DIR, ex), 'utf-8');
        assert.ok(content.startsWith('---'), 'must start with ---');
        assert.match(content, /^summary:/m);
      });
    }
  });

  describe('skill output is integration-tested via underlying CLI tests', () => {
    it('AUDIT mode delegates to scripts/check-context-drift.mjs (validated by tests/check-context-drift.test.mjs)', () => {
      // The skill's AUDIT mode runs `npm run context:check` which invokes
      // runDriftCheck. We exercise that here as a sanity smoke test —
      // detailed coverage lives in tests/check-context-drift.test.mjs.
      const repo = path.resolve('.');
      const report = runDriftCheck(repo);
      assert.ok(Array.isArray(report.findings));
    });
  });

  describe('reference summaries match SKILL.md table (byte-equality enforced by skills:check)', () => {
    it('SKILL.md and each reference summary are consistent', () => {
      // The full byte-match enforcement lives in scripts/check-skill-refs.mjs
      // (run via npm run skills:check). This test ensures the skill is
      // discovered by that script — i.e., that the directory shape is right.
      assert.ok(fs.statSync(SKILL_DIR).isDirectory());
      assert.ok(fs.statSync(REFS_DIR).isDirectory());
      assert.ok(fs.statSync(EXAMPLES_DIR).isDirectory());
    });

    it('every references/ entry in SKILL.md has a corresponding file', () => {
      const content = readSkillContent();
      const refMatches = [...content.matchAll(/`references\/([^`]+)`/g)].map(m => m[1]);
      const uniqueRefs = [...new Set(refMatches)];
      for (const f of uniqueRefs) {
        assert.ok(fs.existsSync(path.join(REFS_DIR, f)), `references/${f} missing on disk`);
      }
    });

    it('every examples/ entry in SKILL.md has a corresponding file', () => {
      const content = readSkillContent();
      const exMatches = [...content.matchAll(/`examples\/([^`]+)`/g)].map(m => m[1]);
      const uniqueExs = [...new Set(exMatches)];
      for (const f of uniqueExs) {
        assert.ok(fs.existsSync(path.join(EXAMPLES_DIR, f)), `examples/${f} missing on disk`);
      }
    });

    it('no orphan reference files (everything in references/ appears in SKILL.md)', () => {
      const content = readSkillContent();
      const refFiles = fs.readdirSync(REFS_DIR);
      for (const f of refFiles) {
        assert.ok(content.includes(`references/${f}`),
          `references/${f} exists on disk but is not listed in SKILL.md`);
      }
    });

    it('no orphan example files (everything in examples/ appears in SKILL.md)', () => {
      const content = readSkillContent();
      const exFiles = fs.readdirSync(EXAMPLES_DIR);
      for (const f of exFiles) {
        assert.ok(content.includes(`examples/${f}`),
          `examples/${f} exists on disk but is not listed in SKILL.md`);
      }
    });
  });
});

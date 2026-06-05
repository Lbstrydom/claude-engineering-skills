import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

import {
  generatePromptFile,
  generateAllPromptFiles,
  parseSkillFrontmatter,
  shaOfManagedBlock,
  SKILL_ENTRY_SCRIPTS,
  START_MARKER,
  END_MARKER,
} from '../scripts/lib/install/copilot-prompts.mjs';

const FIXTURES = path.resolve('tests/copilot-prompts/fixtures');

describe('copilot-prompts', () => {
  describe('parseSkillFrontmatter', () => {
    it('extracts inline description', () => {
      const content = '---\nname: foo\ndescription: One sentence summary.\n---\n\nbody';
      const fm = parseSkillFrontmatter(content);
      assert.equal(fm.name, 'foo');
      assert.equal(fm.description, 'One sentence summary.');
    });

    it('extracts block-scalar description', () => {
      const content = `---
name: foo
description: |
  Multi-line description.
  Continues here.
  Triggers on: ...
---
body`;
      const fm = parseSkillFrontmatter(content);
      assert.equal(fm.name, 'foo');
      assert.match(fm.description, /Multi-line description\./);
      assert.match(fm.description, /Continues here\./);
    });

    it('extracts full block-scalar description from a CRLF checkout', () => {
      // Regression: on Windows (core.autocrlf=true) SKILL.md is checked out
      // with \r\n. The block-scalar regex anchors on \n and `.` won't cross \r,
      // so without normalization this truncated to the first line only.
      const content = [
        '---',
        'name: foo',
        'description: |',
        '  Multi-line description.',
        '  Continues here.',
        '  Triggers on: ...',
        '---',
        'body',
      ].join('\r\n');
      const fm = parseSkillFrontmatter(content);
      assert.equal(fm.name, 'foo');
      assert.match(fm.description, /Multi-line description\./);
      assert.match(fm.description, /Continues here\./);
      assert.match(fm.description, /Triggers on:/);
    });

    it('returns null for missing frontmatter', () => {
      assert.equal(parseSkillFrontmatter('# Heading\n\nNo frontmatter.'), null);
    });

    it('returns null for malformed frontmatter (no closing ---)', () => {
      assert.equal(parseSkillFrontmatter('---\nname: foo\n\n# body'), null);
    });
  });

  describe('generatePromptFile', () => {
    it('generates valid prompt file for each registered skill', () => {
      for (const [skillName, entry] of Object.entries(SKILL_ENTRY_SCRIPTS)) {
        const fm = { name: skillName, description: 'Test description.' };
        const content = generatePromptFile(skillName, fm);
        assert.ok(content, `${skillName} should produce content`);
        assert.match(content, /---\ndescription:/);
        assert.match(content, /mode: agent/);
        assert.match(content, new RegExp(`# /${skillName}`));
        assert.ok(content.includes(entry.cli),
          `prompt for ${skillName} must reference its CLI: ${entry.cli}`);
        assert.ok(content.startsWith(START_MARKER), 'must start with start marker');
        assert.ok(content.trimEnd().endsWith(END_MARKER), 'must end with end marker');
      }
    });

    it('returns null for unregistered skill', () => {
      assert.equal(generatePromptFile('not-a-real-skill', { description: 'x' }), null);
    });

    it('falls back to entry.summary when frontmatter is null', () => {
      const content = generatePromptFile('audit-code', null);
      assert.ok(content);
      assert.match(content, /Multi-pass code audit against a plan/); // from entry.summary
    });

    it('truncates very long descriptions to ~240 chars in YAML frontmatter', () => {
      const longDesc = 'A'.repeat(1000) + '. Second sentence.';
      const fm = { description: longDesc };
      const content = generatePromptFile('audit-loop', fm);
      const yamlDesc = /description:\s*(.+)/.exec(content)[1];
      assert.ok(yamlDesc.length <= 250, `yaml description too long: ${yamlDesc.length}`);
    });
  });

  describe('generateAllPromptFiles — fixture-based', () => {
    it('returns empty array when skills dir does not exist', () => {
      const out = generateAllPromptFiles('/nonexistent/path/foo');
      assert.deepEqual(out, []);
    });

    it('generates prompts only for registered skills', () => {
      // Use the real skills/ dir if it exists, otherwise skip with a soft pass
      const skillsDir = path.resolve('skills');
      if (!fs.existsSync(skillsDir)) {
        return;
      }
      const out = generateAllPromptFiles(skillsDir);
      // Every output must correspond to a registered skill
      for (const entry of out) {
        assert.ok(SKILL_ENTRY_SCRIPTS[entry.skillName],
          `output references unregistered skill ${entry.skillName}`);
        assert.ok(entry.relPath.startsWith('.github/prompts/'));
        assert.ok(entry.relPath.endsWith('.prompt.md'));
      }
    });

    it('skips skills without SKILL.md', () => {
      // Tmp fixture: dir for a registered skill but no SKILL.md inside
      const tmp = path.join(FIXTURES, '_tmp-no-skill-md');
      fs.mkdirSync(path.join(tmp, 'audit-loop'), { recursive: true });
      try {
        const out = generateAllPromptFiles(tmp);
        assert.equal(out.length, 0);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('skips skills that are not in the entry-script registry', () => {
      const tmp = path.join(FIXTURES, '_tmp-unregistered');
      const skillDir = path.join(tmp, 'totally-made-up-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'),
        '---\nname: totally-made-up-skill\ndescription: x\n---\n\nbody');
      try {
        const out = generateAllPromptFiles(tmp);
        assert.equal(out.length, 0);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('handles malformed SKILL.md frontmatter gracefully (uses entry.summary fallback)', () => {
      const tmp = path.join(FIXTURES, '_tmp-malformed');
      const skillDir = path.join(tmp, 'audit-code');
      fs.mkdirSync(skillDir, { recursive: true });
      // No frontmatter at all
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Audit Code\n\nbody only');
      try {
        const out = generateAllPromptFiles(tmp);
        assert.equal(out.length, 1);
        assert.match(out[0].content, /Multi-pass code audit against a plan/); // entry.summary fallback
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('idempotency', () => {
    it('generating the same prompt twice produces byte-equal output', () => {
      const fm = { name: 'audit-loop', description: 'Test description.' };
      const a = generatePromptFile('audit-loop', fm);
      const b = generatePromptFile('audit-loop', fm);
      assert.equal(a, b);
    });

    it('shaOfManagedBlock identifies content changes', () => {
      const fm = { description: 'Original description.' };
      const v1 = generatePromptFile('audit-loop', fm);
      const fm2 = { description: 'Changed description.' };
      const v2 = generatePromptFile('audit-loop', fm2);
      assert.notEqual(shaOfManagedBlock(v1), shaOfManagedBlock(v2));
    });

    it('shaOfManagedBlock returns null for content with no markers', () => {
      assert.equal(shaOfManagedBlock('# Just a heading\n'), null);
    });

    it('shaOfManagedBlock matches across runs', () => {
      const fm = { description: 'Stable.' };
      const a = generatePromptFile('audit-loop', fm);
      const b = generatePromptFile('audit-loop', fm);
      assert.equal(shaOfManagedBlock(a), shaOfManagedBlock(b));
    });

    it('shaOfManagedBlock searches END_MARKER strictly after START_MARKER (audit fix L2)', () => {
      // File with a stray END_MARKER BEFORE the real managed block. Without
      // the strict-after-start search, hash window would start at index 0
      // and end at the stray, producing a wrong hash.
      const stray = '<!-- audit-loop-bundle:prompt:end -->\n\nBefore real block.\n\n' +
        '<!-- audit-loop-bundle:prompt:start -->\nreal content\n<!-- audit-loop-bundle:prompt:end -->';
      const noStray = '<!-- audit-loop-bundle:prompt:start -->\nreal content\n<!-- audit-loop-bundle:prompt:end -->';
      assert.equal(shaOfManagedBlock(stray), shaOfManagedBlock(noStray));
    });
  });

  describe('YAML safety (audit fix H4/H5)', () => {
    it('properly escapes descriptions containing colons', () => {
      const fm = { description: 'Description with: a colon.' };
      const content = generatePromptFile('audit-loop', fm);
      // The description should be wrapped in double quotes
      assert.match(content, /^description:\s*".*"$/m);
    });

    it('escapes descriptions containing double quotes', () => {
      const fm = { description: 'A "quoted" word.' };
      const content = generatePromptFile('audit-loop', fm);
      // Internal double quotes must be backslash-escaped
      assert.match(content, /description:\s*"A \\"quoted\\" word\."/);
    });

    it('escapes descriptions containing # (YAML comment marker)', () => {
      const fm = { description: 'Use # for tags.' };
      const content = generatePromptFile('audit-loop', fm);
      assert.match(content, /description:\s*".*Use # for tags\."/);
    });

    it('escapes backslashes', () => {
      const fm = { description: 'Path\\to\\thing' };
      const content = generatePromptFile('audit-loop', fm);
      // Each \ becomes \\ in YAML
      assert.match(content, /description:\s*"Path\\\\to\\\\thing"/);
    });
  });

  describe('SKILL_ENTRY_SCRIPTS registry shape', () => {
    it('every entry has script, cli, summary fields', () => {
      for (const [name, entry] of Object.entries(SKILL_ENTRY_SCRIPTS)) {
        assert.ok(entry.script, `${name} missing script`);
        assert.ok(entry.cli, `${name} missing cli`);
        assert.ok(entry.summary, `${name} missing summary`);
        // `node scripts/<file>` — flat layout used in both source repo
        // and consumer repos. (The earlier `.audit-loop/scripts/` regex
        // locked in a path that never existed anywhere.)
        assert.match(entry.cli, /\bnode scripts\//, `${name} cli must invoke node scripts/...`);
      }
    });

    it('registry covers all expected skills (post-split)', () => {
      const expected = [
        'audit-plan', 'audit-code', 'audit-loop',
        'plan-backend', 'plan-frontend', 'persona-test',
        'ux-lock', 'ship', 'ai-context-management',
      ];
      for (const name of expected) {
        assert.ok(SKILL_ENTRY_SCRIPTS[name], `expected ${name} in registry`);
      }
    });

    it('registry is frozen (immutable)', () => {
      assert.ok(Object.isFrozen(SKILL_ENTRY_SCRIPTS));
    });
  });
});

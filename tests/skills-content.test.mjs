import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SKILLS_DIR = path.resolve('skills');
const ALL_SKILLS = ['audit-loop', 'plan-backend', 'plan-frontend', 'ship', 'audit'];
const PYTHON_SKILLS = ['plan-backend', 'plan-frontend', 'ship', 'audit'];

describe('skills content', () => {
  for (const skill of ALL_SKILLS) {
    const skillPath = path.join(SKILLS_DIR, skill, 'SKILL.md');

    it(`${skill} exists in skills/`, () => {
      assert.ok(fs.existsSync(skillPath), `${skillPath} must exist`);
    });

    it(`${skill} has valid YAML frontmatter with name + description`, () => {
      const content = fs.readFileSync(skillPath, 'utf-8');
      assert.ok(content.startsWith('---'), 'must start with ---');
      const endIdx = content.indexOf('---', 3);
      assert.ok(endIdx > 3, 'must have closing ---');
      const frontmatter = content.slice(3, endIdx);
      assert.ok(/\bname:/.test(frontmatter), 'frontmatter must have name:');
      assert.ok(/\bdescription:/.test(frontmatter), 'frontmatter must have description:');
    });

    it(`${skill} has at least one ## heading`, () => {
      const content = fs.readFileSync(skillPath, 'utf-8');
      assert.ok(/^## /m.test(content), 'must have at least one ## heading');
    });
  }

  for (const skill of PYTHON_SKILLS) {
    const skillPath = path.join(SKILLS_DIR, skill, 'SKILL.md');

    it(`${skill} has Phase 0 — Repo Stack Detection`, () => {
      const content = fs.readFileSync(skillPath, 'utf-8');
      assert.ok(
        content.includes('Phase 0') && content.includes('Repo Stack Detection'),
        'must contain Phase 0 — Repo Stack Detection heading'
      );
    });

    it(`${skill} has Python-specific content`, () => {
      const content = fs.readFileSync(skillPath, 'utf-8');
      // plan-backend, plan-frontend, audit use framework tags; ship uses Python command discovery
      const hasTags = (content.match(/\[(generic|fastapi|django|flask)[,\]]/g) || []).length >= 5;
      const hasPythonSection = content.includes('Python') && content.includes('pytest');
      assert.ok(
        hasTags || hasPythonSection,
        `must have >= 5 framework tags OR Python-specific sections`
      );
    });
  }
});

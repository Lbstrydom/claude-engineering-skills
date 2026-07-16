import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

import {
  runDriftCheck,
  extractH2Sections,
  bodiesEqual,
  hasAgentsImport,
  findPairs,
} from '../scripts/check-context-drift.mjs';

const FIXTURES = path.resolve('tests/check-context-drift/fixtures');

function fx(name) {
  return path.join(FIXTURES, name);
}

describe('check-context-drift', () => {
  describe('extractH2Sections', () => {
    it('extracts h2 headings with bodies', () => {
      const md = '# Title\n\n## A\n\nbody A\n\n## B\nbody B\n';
      const sections = extractH2Sections(md);
      assert.equal(sections.length, 2);
      assert.equal(sections[0].heading, 'A');
      assert.equal(sections[1].heading, 'B');
    });

    it('records 1-based line numbers', () => {
      const md = '# Title\n\n## First\n\nbody\n';
      const sections = extractH2Sections(md);
      assert.equal(sections[0].line, 3);
    });

    it('does not split on h3 headings', () => {
      const md = '## A\n### subsection\n\nbody\n';
      const sections = extractH2Sections(md);
      assert.equal(sections.length, 1);
      assert.equal(sections[0].heading, 'A');
    });

    it('returns empty array for content with no h2', () => {
      assert.deepEqual(extractH2Sections('# H1 only\n\nplain text'), []);
    });

    it('ignores h2 headings inside fenced code blocks (```)', () => {
      const md = [
        '## Real',
        'body',
        '```',
        '## Fake (in fence)',
        '```',
        '## Real Two',
      ].join('\n');
      const sections = extractH2Sections(md);
      assert.equal(sections.length, 2);
      assert.equal(sections[0].heading, 'Real');
      assert.equal(sections[1].heading, 'Real Two');
    });

    it('ignores h2 headings inside ~~~ fences', () => {
      const md = [
        '## Real',
        '~~~',
        '## Fake',
        '~~~',
        '## Real Two',
      ].join('\n');
      const sections = extractH2Sections(md);
      assert.equal(sections.length, 2);
      assert.equal(sections[1].heading, 'Real Two');
    });

    it('does not close ``` fence with ~~~ and vice versa', () => {
      // Fence opened with ``` should only close with ```
      const md = [
        '```',
        '## Inside ```-fence',
        '~~~ this is not a closing marker',
        '## Still inside fence',
        '```',
        '## After fence',
      ].join('\n');
      const sections = extractH2Sections(md);
      assert.equal(sections.length, 1);
      assert.equal(sections[0].heading, 'After fence');
    });

    it('honours CommonMark fence length: 4-backtick block not closed by 3 backticks', () => {
      // Opening with 4 backticks; the 3-backtick line inside is content.
      const md = [
        '````',
        '## Inside long fence',
        '```',
        '## Still inside (3-tick was just content)',
        '````',
        '## After long fence',
      ].join('\n');
      const sections = extractH2Sections(md);
      assert.equal(sections.length, 1);
      assert.equal(sections[0].heading, 'After long fence');
    });

    it('honours fence length: closing fence may be longer than opening', () => {
      // CommonMark allows closing fence to be >= opening length, so a
      // 3-backtick block CAN be closed by 5 backticks. That means the line
      // after `````` is OUTSIDE the fence.
      const md = [
        '```',
        '## Inside short fence',
        '`````',                  // closes (5 >= 3)
        '## Now outside (real heading)',
      ].join('\n');
      const sections = extractH2Sections(md);
      assert.equal(sections.length, 1);
      assert.equal(sections[0].heading, 'Now outside (real heading)');
    });
  });

  describe('bodiesEqual', () => {
    it('treats whitespace differences as equal', () => {
      assert.equal(bodiesEqual(['  hello  '], ['hello']), true);
    });

    it('treats blank-line differences as equal', () => {
      assert.equal(bodiesEqual(['hello', '', 'world'], ['hello', 'world']), true);
    });

    it('detects content differences', () => {
      assert.equal(bodiesEqual(['hello'], ['goodbye']), false);
    });

    it('returns true for two empty arrays', () => {
      assert.equal(bodiesEqual([], []), true);
    });
  });

  describe('hasAgentsImport', () => {
    it('accepts @./AGENTS.md', () => {
      assert.equal(hasAgentsImport('# Title\n\n@./AGENTS.md\n\nrest'), true);
    });

    it('accepts @AGENTS.md', () => {
      assert.equal(hasAgentsImport('@AGENTS.md\n'), true);
    });

    it('accepts @/AGENTS.md', () => {
      assert.equal(hasAgentsImport('@/AGENTS.md\n'), true);
    });

    it('rejects content without import', () => {
      assert.equal(hasAgentsImport('# Title\n\n## Section\n'), false);
    });

    it('only checks first 30 lines', () => {
      const padding = Array(31).fill('').join('\n');
      assert.equal(hasAgentsImport(padding + '@./AGENTS.md'), false);
    });

    it('does not match in-line text mentioning AGENTS.md', () => {
      assert.equal(hasAgentsImport('See AGENTS.md for details'), false);
    });
  });

  describe('findPairs', () => {
    it('groups files by directory', () => {
      const files = [
        { path: 'AGENTS.md', content: 'a' },
        { path: 'CLAUDE.md', content: 'c' },
        { path: 'packages/foo/AGENTS.md', content: 'a2' },
      ];
      const pairs = findPairs(files);
      assert.equal(pairs.length, 2);
      const root = pairs.find(p => p.dir === '.');
      assert.ok(root);
      assert.ok(root.agents);
      assert.ok(root.claude);
      const sub = pairs.find(p => p.dir === 'packages/foo');
      assert.ok(sub);
      assert.ok(sub.agents);
      assert.equal(sub.claude, null);
    });

    it('ignores non-instruction files', () => {
      const files = [
        { path: '.claude/skills/foo/SKILL.md', content: 's' },
        { path: '.github/copilot-instructions.md', content: 'c' },
      ];
      assert.equal(findPairs(files).length, 0);
    });
  });

  describe('runDriftCheck — fixture scenarios', () => {
    it('aligned: no findings', () => {
      const { findings } = runDriftCheck(fx('aligned'));
      assert.deepEqual(findings, []);
    });

    it('drift-missing-import: HIGH for ctx/missing-import', () => {
      const { findings } = runDriftCheck(fx('drift-missing-import'));
      const missingImport = findings.filter(f => f.ruleId === 'ctx/missing-import');
      assert.equal(missingImport.length, 1, 'expected exactly one missing-import finding');
      assert.equal(missingImport[0].severity, 'error');
    });

    it('drift-shared-section: HIGH for ctx/shared-section-drift', () => {
      const { findings } = runDriftCheck(fx('drift-shared-section'));
      const drift = findings.filter(f => f.ruleId === 'ctx/shared-section-drift');
      assert.equal(drift.length, 1, 'expected exactly one shared-section-drift finding');
      assert.equal(drift[0].severity, 'error');
      assert.match(drift[0].message, /Slash Commands/);
    });

    it('drift-non-allowlist: HIGH for each non-allowlist heading', () => {
      const { findings } = runDriftCheck(fx('drift-non-allowlist'));
      const nonAllow = findings.filter(f => f.ruleId === 'ctx/non-allowlist-heading');
      // "Architecture" + "Some Other Made-Up Heading" = 2
      assert.equal(nonAllow.length, 2, `expected 2 non-allowlist findings, got ${nonAllow.length}`);
      assert.ok(nonAllow.every(f => f.severity === 'error'));
    });

    it('drift-bloated-claude: MEDIUM for ctx/oversized-claude-md', () => {
      const { findings } = runDriftCheck(fx('drift-bloated-claude'));
      const oversized = findings.filter(f => f.ruleId === 'ctx/oversized-claude-md');
      assert.equal(oversized.length, 1, 'expected exactly one oversized finding');
      assert.equal(oversized[0].severity, 'warn');
    });

    it('single-agents-only: no findings (single-file repo)', () => {
      const { findings } = runDriftCheck(fx('single-agents-only'));
      assert.deepEqual(findings, []);
    });

    it('oversized AGENTS.md: MEDIUM for ctx/oversized-agents-md (paired repo)', () => {
      const bigAgents = '# AGENTS.md\n' + 'line\n'.repeat(60);
      const tmpDir = path.join(FIXTURES, '_tmp-bloated-agents');
      fs.mkdirSync(tmpDir, { recursive: true });
      try {
        fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), bigAgents);
        fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# CLAUDE.md\n\n@./AGENTS.md\n');
        fs.writeFileSync(path.join(tmpDir, '.claude-context-allowlist.json'),
          JSON.stringify({ maxAgentsMdLines: 50 }));
        const { findings } = runDriftCheck(tmpDir);
        const oversized = findings.filter(f => f.ruleId === 'ctx/oversized-agents-md');
        assert.equal(oversized.length, 1, `expected exactly one oversized-agents finding, got: ${JSON.stringify(findings)}`);
        assert.equal(oversized[0].severity, 'warn');
        assert.match(oversized[0].message, /progressive-disclosure/);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    });

    it('oversized AGENTS.md fires even WITHOUT a CLAUDE.md pair (single-file repo pays the same cost)', () => {
      const bigAgents = '# AGENTS.md\n' + 'line\n'.repeat(60);
      const tmpDir = path.join(FIXTURES, '_tmp-bloated-agents-solo');
      fs.mkdirSync(tmpDir, { recursive: true });
      try {
        fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), bigAgents);
        fs.writeFileSync(path.join(tmpDir, '.claude-context-allowlist.json'),
          JSON.stringify({ maxAgentsMdLines: 50 }));
        const { findings } = runDriftCheck(tmpDir);
        const oversized = findings.filter(f => f.ruleId === 'ctx/oversized-agents-md');
        assert.equal(oversized.length, 1);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    });

    it('AGENTS.md under the cap: no oversized-agents-md finding', () => {
      const tmpDir = path.join(FIXTURES, '_tmp-slim-agents');
      fs.mkdirSync(tmpDir, { recursive: true });
      try {
        fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# AGENTS.md\n\nshort\n');
        fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# CLAUDE.md\n\n@./AGENTS.md\n');
        const { findings } = runDriftCheck(tmpDir);
        assert.deepEqual(findings.filter(f => f.ruleId === 'ctx/oversized-agents-md'), []);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    });

    it('single-claude-only: no findings (legacy single-file repo)', () => {
      const { findings } = runDriftCheck(fx('single-claude-only'));
      assert.deepEqual(findings, []);
    });

    it('monorepo: root pair checked, subdirectory AGENTS.md does not require sibling', () => {
      const { findings } = runDriftCheck(fx('monorepo'));
      // packages/foo/AGENTS.md has no sibling CLAUDE.md — no findings expected
      // root has aligned AGENTS.md + CLAUDE.md — no findings expected
      assert.deepEqual(findings, [], `unexpected findings: ${JSON.stringify(findings, null, 2)}`);
    });

    it('fenced-headings: example headings in code blocks do not trigger findings', () => {
      const { findings } = runDriftCheck(fx('fenced-headings'));
      // CLAUDE.md has `## Architecture` inside a fenced code block. Without
      // fence-awareness this would trigger non-allowlist + shared-section-drift
      // findings. With fence-awareness, only the real `## Claude Code-only Notes`
      // is detected and the file is clean.
      assert.deepEqual(findings, [], `unexpected findings: ${JSON.stringify(findings, null, 2)}`);
    });
  });

  describe('semanticId stability', () => {
    it('same finding produces same semanticId across runs', () => {
      const r1 = runDriftCheck(fx('drift-missing-import'));
      const r2 = runDriftCheck(fx('drift-missing-import'));
      assert.equal(r1.findings[0].semanticId, r2.findings[0].semanticId);
    });

    it('different rules produce different semanticIds', () => {
      const { findings } = runDriftCheck(fx('drift-non-allowlist'));
      const ids = new Set(findings.map(f => f.semanticId));
      assert.equal(ids.size, findings.length, 'all semanticIds must be unique');
    });
  });

  describe('config loading', () => {
    function withTmpFixture(name, files, fn) {
      const tmpDir = path.join(FIXTURES, name);
      fs.mkdirSync(tmpDir, { recursive: true });
      try {
        for (const [rel, content] of Object.entries(files)) {
          fs.writeFileSync(path.join(tmpDir, rel), content);
        }
        return fn(tmpDir);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    }

    it('respects custom allowlist via .claude-context-allowlist.json', () => {
      withTmpFixture('_tmp-custom-allowlist', {
        'AGENTS.md': '# AGENTS.md\n\n## X\n\nbody\n',
        'CLAUDE.md': '# CLAUDE.md\n\n@./AGENTS.md\n\n## Custom Heading\n\nbody\n',
        '.claude-context-allowlist.json': JSON.stringify({ allowlist: ['Custom Heading'], maxClaudeMdLines: 80 }),
      }, tmpDir => {
        const { findings } = runDriftCheck(tmpDir);
        const nonAllow = findings.filter(f => f.ruleId === 'ctx/non-allowlist-heading');
        assert.equal(nonAllow.length, 0, `Custom Heading should be allowlisted, got: ${JSON.stringify(findings)}`);
      });
    });

    it('strict mode rejects malformed JSON', () => {
      withTmpFixture('_tmp-bad-json', {
        'AGENTS.md': '# AGENTS.md\n',
        'CLAUDE.md': '# CLAUDE.md\n\n@./AGENTS.md\n',
        '.claude-context-allowlist.json': '{ this is not valid json',
      }, tmpDir => {
        assert.throws(
          () => runDriftCheck(tmpDir, { strict: true }),
          /Failed to parse/,
        );
      });
    });

    it('strict mode rejects unknown config fields', () => {
      withTmpFixture('_tmp-unknown-field', {
        'AGENTS.md': '# AGENTS.md\n',
        'CLAUDE.md': '# CLAUDE.md\n\n@./AGENTS.md\n',
        '.claude-context-allowlist.json': JSON.stringify({ unknownField: 'bad' }),
      }, tmpDir => {
        assert.throws(
          () => runDriftCheck(tmpDir, { strict: true }),
          /Invalid config/,
        );
      });
    });

    it('strict mode rejects wrong type for maxClaudeMdLines', () => {
      withTmpFixture('_tmp-bad-type', {
        'AGENTS.md': '# AGENTS.md\n',
        'CLAUDE.md': '# CLAUDE.md\n\n@./AGENTS.md\n',
        '.claude-context-allowlist.json': JSON.stringify({ maxClaudeMdLines: 'not-a-number' }),
      }, tmpDir => {
        assert.throws(
          () => runDriftCheck(tmpDir, { strict: true }),
          /Invalid config/,
        );
      });
    });

    it('non-strict mode falls back to defaults on malformed JSON', () => {
      withTmpFixture('_tmp-bad-json-soft', {
        'AGENTS.md': '# AGENTS.md\n',
        'CLAUDE.md': '# CLAUDE.md\n\n@./AGENTS.md\n',
        '.claude-context-allowlist.json': '{ broken',
      }, tmpDir => {
        // Should not throw; uses default allowlist
        const { findings } = runDriftCheck(tmpDir, { strict: false });
        // No drift expected against defaults
        assert.deepEqual(findings, []);
      });
    });
  });
});

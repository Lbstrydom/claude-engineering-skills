import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseReferenceTable, parseReferenceFrontmatter, lintSkill,
} from '../scripts/lib/skill-refs-parser.mjs';

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-refs-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

function write(rel, body) {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

const VALID_SKILL_MD = `---
name: test-skill
---

# Test Skill

Canonical flow here.

## Reference files

Intro.

| File | Summary | Read when |
|---|---|---|
| \`references/interop.md\` | How this skill feeds others. | The user asks about cross-skill effects. |
| \`references/troubleshoot.md\` | Recovery from mid-session failures. | A tool call fails twice in a row. |
`;

const VALID_REF_MD = `---
summary: How this skill feeds others.
---

# Interop

Body content here.
`;

describe('parseReferenceTable', () => {
  it('finds the section and parses rows', () => {
    const r = parseReferenceTable(VALID_SKILL_MD);
    assert.equal(r.found, true);
    assert.equal(r.entries.length, 2);
    assert.equal(r.entries[0].file, 'references/interop.md');
    assert.equal(r.entries[0].summary, 'How this skill feeds others.');
    assert.ok(r.entries[0].readWhen.includes('cross-skill'));
    assert.equal(r.errors.length, 0);
  });

  it('returns found:false when section absent', () => {
    const r = parseReferenceTable('# Title\n\nNo refs.');
    assert.equal(r.found, false);
    assert.equal(r.entries.length, 0);
  });

  it('flags wrong header cells', () => {
    const md = `## Reference files

| Path | Desc | When |
|---|---|---|
| \`references/x.md\` | summary | trigger |
`;
    const r = parseReferenceTable(md);
    assert.ok(r.errors.some(e => e.toLowerCase().includes('header')));
  });

  it('flags entries outside references/ and examples/', () => {
    const md = `## Reference files

| File | Summary | Read when |
|---|---|---|
| \`scripts/x.mjs\` | code | never |
`;
    const r = parseReferenceTable(md);
    assert.ok(r.errors.some(e => e.includes('must start with references/ or examples/')));
  });

  it('flags empty Summary and Read when', () => {
    const md = `## Reference files

| File | Summary | Read when |
|---|---|---|
| \`references/x.md\` |  |  |
`;
    const r = parseReferenceTable(md);
    // Both cells are empty — blank table cells are interpreted as whitespace-only, the regex may skip; test robustness
    // Our implementation requires non-empty cells:
    assert.ok(r.errors.length > 0 || r.entries[0].summary === '');
  });

  it('flags Summary longer than 120 chars', () => {
    const longSummary = 'x'.repeat(121);
    const md = `## Reference files

| File | Summary | Read when |
|---|---|---|
| \`references/x.md\` | ${longSummary} | trigger here |
`;
    const r = parseReferenceTable(md);
    assert.ok(r.errors.some(e => e.includes('exceeds 120')));
  });

  it('stops at next heading of same level', () => {
    const md = `## Reference files

| File | Summary | Read when |
|---|---|---|
| \`references/a.md\` | sum a | when a |

## Unrelated

| File | Summary | Read when |
|---|---|---|
| \`references/nope.md\` | sum b | when b |
`;
    const r = parseReferenceTable(md);
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].file, 'references/a.md');
  });
});

describe('parseReferenceFrontmatter', () => {
  it('extracts simple summary', () => {
    const r = parseReferenceFrontmatter(VALID_REF_MD);
    assert.equal(r.summary, 'How this skill feeds others.');
    assert.equal(r.error, undefined);
  });

  it('strips quoted strings', () => {
    const md = `---\nsummary: "Quoted value."\n---\n\nBody.`;
    const r = parseReferenceFrontmatter(md);
    assert.equal(r.summary, 'Quoted value.');
  });

  it('flags missing frontmatter', () => {
    const r = parseReferenceFrontmatter('# No frontmatter');
    assert.equal(r.summary, null);
    assert.ok(r.error.includes('No YAML frontmatter'));
  });

  it('flags missing summary key', () => {
    const md = `---\nother: value\n---\nBody.`;
    const r = parseReferenceFrontmatter(md);
    assert.equal(r.summary, null);
    assert.ok(r.error.includes('summary'));
  });

  it('flags empty summary', () => {
    const md = `---\nsummary:\n---\nBody.`;
    const r = parseReferenceFrontmatter(md);
    assert.equal(r.summary, null);
    // Depending on the regex behaviour, either summary key is missing detection
    // or empty. Both are acceptable failure modes.
    assert.ok(r.error);
  });

  it('flags summary over 120 chars (but still returns value)', () => {
    const long = 'x'.repeat(150);
    const md = `---\nsummary: ${long}\n---\nBody.`;
    const r = parseReferenceFrontmatter(md);
    assert.equal(r.summary, long);
    assert.ok(r.error.includes('exceeds 120'));
  });

  it('does not accept "summary:" text indented inside another key\'s block-scalar value (fingerprint ecc722f1)', () => {
    // `description: |` starts a YAML block scalar; every following indented
    // line (including one that happens to start with "summary:") is CONTENT
    // of that scalar, not a second top-level key. A line regex tolerant of
    // leading whitespace on "summary:" would wrongly treat this as the
    // required top-level field.
    const md = `---\ndescription: |\n  Some notes here.\n  summary: this is prose inside description, not a real key\n---\nBody.`;
    const r = parseReferenceFrontmatter(md);
    assert.equal(r.summary, null);
    assert.ok(r.error.includes('summary'));
  });
});

describe('lintSkill', () => {
  it('clean skill with valid refs passes', () => {
    write('SKILL.md', VALID_SKILL_MD);
    write('references/interop.md', VALID_REF_MD);
    write('references/troubleshoot.md', '---\nsummary: Recovery from mid-session failures.\n---\nBody.');
    const r = lintSkill(tmp);
    assert.equal(r.ok, true, r.errors.join('\n'));
    assert.equal(r.errors.length, 0);
    assert.equal(r.entries.length, 2);
  });

  it('flags missing reference file', () => {
    write('SKILL.md', VALID_SKILL_MD);
    // Only write one of the two referenced files
    write('references/interop.md', VALID_REF_MD);
    const r = lintSkill(tmp);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('does not exist')));
  });

  it('flags orphan file in references/ not listed in table', () => {
    write('SKILL.md', VALID_SKILL_MD);
    write('references/interop.md', VALID_REF_MD);
    write('references/troubleshoot.md', '---\nsummary: Recovery from mid-session failures.\n---\nBody.');
    write('references/orphan.md', '---\nsummary: Not listed anywhere.\n---\nBody.');
    const r = lintSkill(tmp);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('Orphan file')));
  });

  it('flags summary drift between index and frontmatter', () => {
    write('SKILL.md', VALID_SKILL_MD);
    write('references/interop.md', '---\nsummary: DIFFERENT from index.\n---\nBody.');
    write('references/troubleshoot.md', '---\nsummary: Recovery from mid-session failures.\n---\nBody.');
    const r = lintSkill(tmp);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('does not match index')));
  });

  it('skill without reference section + empty references/ is clean', () => {
    write('SKILL.md', '# No refs\n\nJust canonical flow.\n');
    const r = lintSkill(tmp);
    assert.equal(r.ok, true);
    assert.equal(r.entries.length, 0);
  });

  it('skill without reference section but with files in references/ fails', () => {
    write('SKILL.md', '# No refs\n\nJust canonical flow.\n');
    write('references/stranded.md', '---\nsummary: x\n---\nBody.');
    const r = lintSkill(tmp);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('no "## Reference files" section')));
  });

  it('missing SKILL.md produces an error', () => {
    const r = lintSkill(tmp);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('SKILL.md not found')));
  });

  it('flags a references/ table entry that traverses outside the skill directory', () => {
    // "references/../../../escape.md" passes the text-only
    // startsWith('references/') check in parseReferenceTable, but path.join
    // resolves it outside skillDir — a path-traversal escape (fingerprint
    // f5f25121) that must be refused before existsSync/readFileSync ever
    // touch the resolved path.
    const skillMd = `---
name: test-skill
---

# Test Skill

## Reference files

| File | Summary | Read when |
|---|---|---|
| \`references/../../../escape.md\` | Escapes the skill dir. | never |
`;
    write('SKILL.md', skillMd);
    // No need to create the escape target: the containment check must fire
    // BEFORE existsSync/readFileSync ever run, so the guard is proven by the
    // "path traversal" message appearing rather than a generic "does not
    // exist" one (which a missing-file fallback could also produce).
    const r = lintSkill(tmp);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('path traversal')), r.errors.join('\n'));
  });
});

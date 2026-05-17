/**
 * Tests for scripts/lib/doc-sections.mjs — shared H2-section extraction.
 * Plan: docs/plans/adaptive-context-blast-radius.md — Phase 3 (audit M4:
 * the section loader moved out of the brainstorm feature namespace).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractSection, loadSection, ARCH_SECTION_HEADING } from '../scripts/lib/doc-sections.mjs';

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doc-sec-'));
}

const DOC = [
  '# Title',
  '',
  '## Architecture',
  'arch body',
  '### Sub',
  'sub body',
  '',
  '## R2+ Audit Mode (Phase 1)',
  'audit body with a regex-metachar heading',
  '',
  '## Next',
  'next body',
].join('\n');

describe('extractSection', () => {
  it('extracts a section including nested ### subsections, stops at next H2', () => {
    const s = extractSection(DOC, '## Architecture');
    assert.ok(s.startsWith('## Architecture'));
    assert.ok(s.includes('### Sub') && s.includes('sub body'));
    assert.ok(!s.includes('## R2+'));
  });
  it('matches a heading containing regex metacharacters literally', () => {
    const s = extractSection(DOC, '## R2+ Audit Mode (Phase 1)');
    assert.ok(s && s.includes('audit body'));
    assert.ok(!s.includes('## Next'));
  });
  it('returns null for an absent heading', () => {
    assert.equal(extractSection(DOC, '## Nope'), null);
  });
});

describe('loadSection', () => {
  it('loads a section from AGENTS.md by heading', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), DOC);
    const r = loadSection({ heading: '## Architecture', baseDir: dir });
    assert.equal(r.state, 'ok');
    assert.equal(r.sourceFile, 'AGENTS.md');
    assert.ok(r.text.includes('arch body'));
  });
  it('defaults to the architecture heading', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), DOC);
    const r = loadSection({ baseDir: dir });
    assert.equal(r.heading, ARCH_SECTION_HEADING);
    assert.equal(r.state, 'ok');
  });
  it('no instruction file → no-file', () => {
    assert.equal(loadSection({ baseDir: mkTmp() }).state, 'no-file');
  });
  it('file present but heading absent → no-section', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Title\n\n## Other\nbody');
    assert.equal(loadSection({ heading: '## Architecture', baseDir: dir }).state, 'no-section');
  });
});

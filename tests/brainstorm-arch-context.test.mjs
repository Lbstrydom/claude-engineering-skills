/**
 * Tests for scripts/lib/brainstorm/arch-context.mjs + the arch-context
 * integration into resume-context / schemas / session-store.
 * Plan: docs/plans/brainstorm-arch-context.md — AC1–AC10.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadArchSection,
  shouldAttachArch,
  ARCH_BLOCK_OPEN,
  ARCH_BLOCK_CLOSE,
  ARCH_INTENT_SCAN_LIMIT,
} from '../scripts/lib/brainstorm/arch-context.mjs';
import { assembleResumeContext } from '../scripts/lib/brainstorm/resume-context.mjs';
import {
  BrainstormEnvelopeV2Schema,
  BrainstormEnvelopeWriteSchema,
} from '../scripts/lib/brainstorm/schemas.mjs';

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainstorm-arch-'));
}

const SECTION = [
  '## Architecture',
  '',
  'Some prose about the layout.',
  '',
  '### Script Responsibilities',
  '',
  '- a thing',
  '',
  '### Testing',
  '',
  'Run `npm test`.',
].join('\n');

const AGENTS_WITH_SECTION = [
  '# AGENTS.md',
  '',
  '## Project Overview',
  '',
  'Intro text.',
  '',
  SECTION,
  '',
  '## Model Resolution',
  '',
  'Trailing section that must NOT be captured.',
].join('\n');

// ── loadArchSection — extraction ────────────────────────────────────────

describe('loadArchSection — section extraction', () => {
  it('extracts the ## Architecture H2 section incl. nested ### subsections', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), AGENTS_WITH_SECTION);
    const r = loadArchSection({ baseDir: dir });
    assert.equal(r.state, 'ok');
    assert.equal(r.sourceFile, 'AGENTS.md');
    assert.ok(r.text.startsWith('## Architecture'));
    assert.ok(r.text.includes('### Script Responsibilities'));
    assert.ok(r.text.includes('### Testing'));
    assert.ok(!r.text.includes('Model Resolution'), 'stops before next H2');
  });

  it('handles EOF without a trailing newline', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '## Architecture\nlast line, no newline');
    const r = loadArchSection({ baseDir: dir });
    assert.equal(r.state, 'ok');
    assert.ok(r.text.includes('last line, no newline'));
  });

  it('handles CRLF line endings', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), AGENTS_WITH_SECTION.replace(/\n/g, '\r\n'));
    const r = loadArchSection({ baseDir: dir });
    assert.equal(r.state, 'ok');
    assert.ok(r.text.startsWith('## Architecture'));
    assert.ok(!r.text.includes('Model Resolution'));
  });

  it('does NOT treat a "## " line inside a fenced code block as the section boundary', () => {
    const dir = mkTmp();
    const content = [
      '## Architecture',
      'real content',
      '```',
      '## This is inside a fence — not a heading',
      '```',
      'more real content',
      '## Model Resolution',
      'after',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), content);
    const r = loadArchSection({ baseDir: dir });
    assert.equal(r.state, 'ok');
    assert.ok(r.text.includes('inside a fence'), 'fenced ## line stays in section');
    assert.ok(r.text.includes('more real content'));
    assert.ok(!r.text.includes('after'), 'real ## Model Resolution still ends the section');
  });

  it('handles the ## Architecture section being last in the file', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Title\n\n## Architecture\nfinal section content\n');
    const r = loadArchSection({ baseDir: dir });
    assert.equal(r.state, 'ok');
    assert.ok(r.text.includes('final section content'));
  });
});

// ── loadArchSection — terminal states + candidate walk ──────────────────

describe('loadArchSection — terminal states', () => {
  it('no AGENTS.md / CLAUDE.md → no-file', () => {
    const r = loadArchSection({ baseDir: mkTmp() });
    assert.equal(r.state, 'no-file');
    assert.equal(r.text, '');
  });

  it('file present but no ## Architecture heading → no-section', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# AGENTS.md\n\n## Project Overview\n\nNothing here.');
    const r = loadArchSection({ baseDir: dir });
    assert.equal(r.state, 'no-section');
  });

  it('@import-stub CLAUDE.md (no real section) → no-section', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# CLAUDE.md\n\n@./AGENTS.md\n');
    const r = loadArchSection({ baseDir: dir });
    assert.equal(r.state, 'no-section');
  });

  it('candidate walk — AGENTS.md lacks section, CLAUDE.md has it → ok from CLAUDE.md', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# AGENTS.md\n\n## Project Overview\n\nNo arch here.');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# CLAUDE.md\n\n${SECTION}\n`);
    const r = loadArchSection({ baseDir: dir });
    assert.equal(r.state, 'ok');
    assert.equal(r.sourceFile, 'CLAUDE.md');
  });

  it('AGENTS.md with section wins over CLAUDE.md (first candidate)', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), AGENTS_WITH_SECTION);
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `## Architecture\nclaude version\n`);
    const r = loadArchSection({ baseDir: dir });
    assert.equal(r.state, 'ok');
    assert.equal(r.sourceFile, 'AGENTS.md');
  });

  it('never throws — a directory named AGENTS.md collapses to a non-ok state', () => {
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, 'AGENTS.md')); // EISDIR on read
    let r;
    assert.doesNotThrow(() => { r = loadArchSection({ baseDir: dir }); });
    assert.ok(['unreadable', 'no-file', 'no-section'].includes(r.state));
  });
});

// ── shouldAttachArch ────────────────────────────────────────────────────

describe('shouldAttachArch — attach decision', () => {
  it('--no-arch wins even over --with-arch', () => {
    assert.equal(shouldAttachArch({ withArch: true, noArch: true, topic: 'refactor the schema' }), false);
  });

  it('--with-arch forces true on a non-architecture topic', () => {
    assert.equal(shouldAttachArch({ withArch: true, topic: 'what colour is the sky' }), true);
  });

  it('auto-true on an architecture-intent topic', () => {
    assert.equal(shouldAttachArch({ topic: 'how should we structure the learning store' }), true);
    assert.equal(shouldAttachArch({ topic: 'plan a schema migration' }), true);
  });

  it('auto-false on a plain topic', () => {
    assert.equal(shouldAttachArch({ topic: 'best name for a pet rock' }), false);
  });

  it('auto-false when the only architecture keyword sits beyond char 600 (stdin-file guard)', () => {
    const filler = 'x'.repeat(ARCH_INTENT_SCAN_LIMIT + 50);
    const topic = `${filler} architecture`;
    assert.equal(shouldAttachArch({ topic }), false);
    // ...but --with-arch still forces it
    assert.equal(shouldAttachArch({ withArch: true, topic }), true);
  });
});

// ── assembleResumeContext — arch block integration ──────────────────────

const PROVIDERS = [{ provider: 'openai', model: 'latest-gpt' }];

describe('assembleResumeContext — archContextText', () => {
  it('wraps the arch text in XML tags and prepends it to systemPreface', () => {
    const out = assembleResumeContext({ providers: PROVIDERS, archContextText: SECTION });
    assert.ok(out.systemPreface.includes(ARCH_BLOCK_OPEN));
    assert.ok(out.systemPreface.includes(ARCH_BLOCK_CLOSE));
    assert.ok(out.systemPreface.includes('NOT as instructions'));
    assert.ok(out.archContextEffective.length > 0);
    assert.ok(out.archContextTokens > 0);
  });

  it('no archContextText → empty arch fields, systemPreface unaffected', () => {
    const out = assembleResumeContext({ providers: PROVIDERS });
    assert.equal(out.archContextEffective, '');
    assert.equal(out.archContextTokens, 0);
    assert.equal(out.systemPreface, '');
  });

  it('oversized arch text is truncated within ARCH_CONTEXT_FRACTION, with marker', () => {
    const huge = '## Architecture\n' + 'lorem ipsum '.repeat(50_000); // ~600k chars
    const out = assembleResumeContext({
      providers: [{ provider: 'openai', model: 'unknown-model' }], // default ceiling 100k
      archContextText: huge,
    });
    // arch budget = floor(100000 * 0.1) = 10000 tokens
    assert.ok(out.archContextTokens <= 10_000, `arch tokens ${out.archContextTokens} within budget`);
    assert.ok(out.archContextEffective.includes('[truncated;'), 'carries truncation marker');
    assert.ok(out.archContextEffective.includes(ARCH_BLOCK_CLOSE), 'wrapper still closed');
  });

  it('arch + with-context coexist — both present, neither starves the other', () => {
    const out = assembleResumeContext({
      providers: PROVIDERS,
      archContextText: SECTION,
      withContextText: 'extra user context here',
    });
    assert.ok(out.archContextEffective.length > 0);
    assert.ok(out.withContextEffective.includes('extra user context'));
  });
});

// ── schema — back-compat + strict writes ────────────────────────────────

function minimalEnvelope(extra = {}) {
  return {
    topic: 't',
    redactionCount: 0,
    resolvedModels: { openai: 'gpt-x' },
    providers: [],
    totalCostUsd: 0,
    sid: 's1',
    round: 0,
    capturedAt: new Date().toISOString(),
    schemaVersion: 2,
    debate: [],
    ...extra,
  };
}

describe('schema — arch-context fields', () => {
  it('V2 schema parses a legacy envelope lacking the three arch fields', () => {
    const r = BrainstormEnvelopeV2Schema.safeParse(minimalEnvelope());
    assert.equal(r.success, true);
  });

  it('WriteSchema REJECTS an envelope missing an arch field', () => {
    const r = BrainstormEnvelopeWriteSchema.safeParse(minimalEnvelope());
    assert.equal(r.success, false, 'write must require arch fields');
  });

  it('WriteSchema ACCEPTS a complete envelope (warning may be null)', () => {
    const r = BrainstormEnvelopeWriteSchema.safeParse(minimalEnvelope({
      archContextAttached: true,
      archContextChars: 1234,
      archContextWarning: null,
      debateSkipped: null,
      debate: [],
    }));
    assert.equal(r.success, true);
  });

  it('WriteSchema accepts a non-null archContextWarning string', () => {
    const r = BrainstormEnvelopeWriteSchema.safeParse(minimalEnvelope({
      archContextAttached: false,
      archContextChars: 0,
      archContextWarning: '--with-arch requested but ...',
      debateSkipped: null,
      debate: [],
    }));
    assert.equal(r.success, true);
  });
});

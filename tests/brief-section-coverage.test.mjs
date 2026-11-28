/**
 * @fileoverview The audit brief condenses the instruction file BY SECTION and
 * says how much it read (upstream report 477617f6).
 *
 * Every reader of AGENTS.md used to take its head — `slice(0, 48000)` for the
 * LLM legs, `slice(0, 1500|2000)` for the fallbacks — silently. CES's own
 * AGENTS.md lost its last 11 sections (Do NOT, Accepted Technical Debt, …) and
 * the brief read exactly like a full read. These tests pin: the LAST section
 * reaches the condensation input; the brief carries a measured coverage line on
 * every path; and a negative control showing the old head slice fails the same
 * check on the same fixture. No network: the LLM leg is injected.
 *
 * Plan: docs/plans/audit-brief-section-coverage.md
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  condenseBySection,
  formatSectionCoverage,
  splitInstructionSections,
} from '../scripts/lib/instruction-sections.mjs';
import { makeFenceTracker } from '../scripts/lib/markdown-fence-tracker.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTEXT_URL = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'lib', 'context.mjs')).href;
const LLM_BUDGET = 48_000;
const SENTINEL = 'LAST-SECTION-SENTINEL: never weaken the egress redactor';
const COVERAGE_RE = /Instruction-file coverage \(AGENTS\.md(?: → LLM brief input)?\): (\d+)\/(\d+) sections represented \(\d+ whole, \d+ condensed(?:, \d+ heading-only)?(?:, \d+ omitted)?\); (\d+) of (\d+) chars read \(\d+%\)/;

/** An AGENTS.md well over the LLM budget whose LAST section holds the sentinel. */
function oversizedFixture({ depTable = false } = {}) {
  // `n` chars of ~90-char bullet items, so a cut has block boundaries to land on.
  const filler = (tag, n) => {
    const items = [];
    for (let k = 0, size = 0; size < n; k++) {
      const item = `- ${tag} rule ${k}: lorem ipsum dolor sit amet, consectetur adipiscing elit sed do.`;
      items.push(item);
      size += item.length + 1;
    }
    return items.join('\n');
  };
  const parts = ['# AGENTS.md — fixture', '', filler('preamble', 6_000), ''];
  if (depTable) {
    parts.push('## Dependencies', '', '| Package | Version | Notes |', '|---|---|---|');
    for (const p of ['zod', 'openai', 'dotenv', 'pg', 'express', 'vitest']) parts.push(`| \`${p}\` | **4.6.7** | pinned major; read the changelog before bumping |`);
    parts.push('');
  }
  for (let i = 1; i <= 14; i++) parts.push(`## Section ${i}`, '', filler(`section-${i}`, 5_000), '');
  parts.push('## Accepted Technical Debt', '', SENTINEL, '', filler('tail', 3_000));
  return parts.join('\n');
}

describe('condenseBySection', () => {
  const fixture = oversizedFixture();

  it('the fixture is genuinely over the LLM budget', () => {
    assert.ok(fixture.length > LLM_BUDGET * 1.4, `fixture ${fixture.length} chars`);
  });

  it('the LAST section reaches the condensation input', () => {
    const { text, coverage } = condenseBySection(fixture, LLM_BUDGET);
    assert.ok(text.includes('## Accepted Technical Debt'), 'last heading present');
    assert.ok(text.includes(SENTINEL), 'last section BODY present, not just its heading');
    assert.equal(coverage.represented, coverage.totalSections);
    assert.equal(coverage.omitted, 0);
    assert.ok(coverage.charsRead <= LLM_BUDGET);
    assert.ok(text.length <= LLM_BUDGET, `output ${text.length} chars, markers included`);
  });

  it('the output — markers and separators included — never exceeds the budget', () => {
    // Many tiny sections: the case where per-section overhead would multiply.
    const many = Array.from({ length: 2_000 }, (_, i) => `## S${i}\n${'w '.repeat(20)}`).join('\n');
    for (const budget of [500, 4_000, 20_000]) {
      const { text, coverage } = condenseBySection(many, budget);
      assert.ok(text.length <= budget, `budget ${budget}: output ${text.length}`);
      assert.equal(coverage.represented + coverage.omitted, coverage.totalSections);
    }
  });

  it('a cut lands on a block boundary — never mid-item, never inside a fence', () => {
    const items = Array.from({ length: 40 }, (_, i) => `- Rule ${i}: delete the directory ONLY in a disposable test workspace, never elsewhere.`);
    const doc = [
      '## Rules', ...items, '',
      '## Example', 'Intro.', '', '```bash', ...Array.from({ length: 80 }, (_, i) => `echo step ${i}`), '```', '', 'After the fence.',
      '## Tail', 'x'.repeat(4_000),
    ].join('\n');
    const { text } = condenseBySection(doc, 3_000);
    const body = (h) => text.split(/\n(?=## )/).find((s) => s.startsWith(h));
    const rules = body('## Rules').replace(/\n…\[cut:[^\]]*\]$/, '');
    for (const line of rules.split('\n').slice(1)) {
      assert.match(line, /never elsewhere\.$/, `rule cut mid-item: ${line}`);
    }
    const example = body('## Example');
    const fences = (example.match(/^```/gm) || []).length;
    assert.equal(fences % 2, 0, 'a cut must not leave a code fence open');
  });

  it('a nested list item is never split from its parent', () => {
    const doc = [
      '## Writes', '- Allow writes only when:', '  - inside a disposable worktree', '  - with the lease held',
      `- Second rule ${'z'.repeat(300)}`, '## Tail', 'y'.repeat(400),
    ].join('\n');
    // Every budget from "headings only" to "whole item": somewhere in this range
    // the parent line alone fits and its conditions do not — the case a
    // per-line split gets wrong.
    for (let budget = 100; budget <= 250; budget += 2) {
      const { text } = condenseBySection(doc, budget);
      if (text.includes('- Allow writes only when:')) {
        assert.ok(text.includes('  - with the lease held'), `budget ${budget}: parent kept without its conditions:\n${text}`);
      }
      assert.ok(!text.includes('Second rule'), 'the second item never fits');
    }
    assert.ok(condenseBySection(doc, 250).text.includes('- Allow writes only when:'), 'not vacuous: the item is kept at 250');
  });

  it('an introduction ending in ":" keeps the unindented list it introduces', () => {
    for (const gap of ['', '\n']) {
      const doc = [
        '## Writes', `Allow writes only when:${gap}`, '- inside a disposable worktree', '- with the lease held',
        `- third ${'z'.repeat(300)}`, '', `Next paragraph ${'q'.repeat(300)}`, '## Tail', 'y'.repeat(400),
      ].join('\n');
      let sawIntro = false;
      for (let budget = 100; budget <= 600; budget += 2) {
        const { text } = condenseBySection(doc, budget);
        if (!text.includes('Allow writes only when:')) continue;
        sawIntro = true;
        assert.ok(text.includes('- with the lease held'), `budget ${budget}: introduction kept without its conditions:\n${text}`);
      }
      assert.ok(sawIntro, 'not vacuous: the introduction is kept at some budget');
    }
  });

  it('a section that fits whole is kept whole, even when its last cut point would not fit', () => {
    // Whole = 30 chars + join; the cut point at the first item needs a ~25-char marker.
    const doc = ['## A', '- one', '- two two two', '## B', 'x'.repeat(5_000)].join('\n');
    const sec = '## A\n- one\n- two two two';
    for (let budget = 60; budget <= 200; budget++) {
      const { text } = condenseBySection(doc, budget);
      assert.ok(text.length <= budget);
      const wholeCost = sec.length + 1;
      const headCost = '## A'.length + 1 + '## B'.length + 1;
      const note = '\n…[2 section(s) heading-only, 2 omitted: budget]'.length;
      if (budget - note - headCost >= wholeCost - ('## A'.length + 1)) {
        assert.ok(text.includes(sec), `budget ${budget}: A fits whole but was not kept whole:\n${text}`);
      }
    }
  });

  it('is linear on a very long list (no rescans)', () => {
    const doc = `## L\nRules:\n${Array.from({ length: 40_000 }, (_, i) => `- item ${i}`).join('\n')}\n## T\nt`;
    const started = Date.now();
    condenseBySection(doc, 48_000);
    assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started}ms`);
  });

  it('a lazy continuation line does not detach the rest of an introduced list', () => {
    const doc = [
      '## Writes', 'Allow writes only when:', '- inside a disposable worktree,', 'which the lease names', '- with the lease held',
      `- third ${'z'.repeat(300)}`, '', `Next ${'q'.repeat(300)}`, '## Tail', 'y'.repeat(400),
    ].join('\n');
    let sawIntro = false;
    for (let budget = 100; budget <= 600; budget += 2) {
      const { text } = condenseBySection(doc, budget);
      if (!text.includes('Allow writes only when:')) continue;
      sawIntro = true;
      assert.ok(text.includes('- with the lease held'), `budget ${budget}: a condition was detached:\n${text}`);
    }
    assert.ok(sawIntro, 'not vacuous');
  });

  it('an h2 indented up to three spaces is a heading; four is not', () => {
    assert.deepEqual(splitInstructionSections('## A\na\n   ## B\nb\n    ## C\nc').map((x) => x.heading), ['A', 'B']);
  });

  it('a closed fence ends its block even without a blank line after it', () => {
    const doc = ['## A', '```', 'code', '```', `after ${'p'.repeat(300)}`, '## B', 'x'.repeat(2_000)].join('\n');
    const { text } = condenseBySection(doc, 120);
    assert.ok(text.includes('```\ncode\n```'), `the fenced block alone should fit:\n${text}`);
    assert.ok(!text.includes('after p'));
  });

  it('a fence inside a blockquote is never cut inside', () => {
    const doc = ['## A', '> Example:', '>', '> ```bash', ...Array.from({ length: 30 }, (_, i) => `> echo ${i}`), '>', '> echo after-blank', '> ```', '', 'Tail paragraph.', '## B', 'x'.repeat(3_000)].join('\n');
    for (let budget = 80; budget <= 700; budget += 5) {
      const kept = condenseBySection(doc, budget).text.split(/\n(?=## )/)[0];
      assert.equal((kept.match(/^> ```/gm) || []).length % 2, 0, `budget ${budget}: quoted fence left open:\n${kept}`);
    }
  });

  it('a `##` inside a multi-line HTML comment is not a heading, and the comment is never cut inside', () => {
    const doc = ['## A', 'intro', '', '<!--', '## Retired rule: never do X', 'old text', '-->', '', `after ${'p'.repeat(200)}`, '## B', 'b'].join('\n');
    assert.deepEqual(splitInstructionSections(doc).map((x) => x.heading), ['A', 'B']);
    for (let budget = 40; budget <= 200; budget += 2) {
      const { text } = condenseBySection(doc, budget);
      if (text.includes('Retired rule')) assert.ok(text.includes('<!--') && text.includes('-->'), `budget ${budget}: comment body shown without its delimiters:\n${text}`);
    }
  });

  it('an introducer wrapped in emphasis keeps its list', () => {
    const doc = [
      '## Deletes', '**Delete files only when ALL conditions hold:**', '- inside a disposable worktree', '- with the lease held',
      `- third ${'z'.repeat(300)}`, '', `Next ${'q'.repeat(300)}`, '## Tail', 'y'.repeat(400),
    ].join('\n');
    let sawIntro = false;
    for (let budget = 100; budget <= 600; budget += 2) {
      const { text } = condenseBySection(doc, budget);
      if (!text.includes('ALL conditions hold')) continue;
      sawIntro = true;
      assert.ok(text.includes('- with the lease held'), `budget ${budget}: introduction kept without its conditions:\n${text}`);
    }
    assert.ok(sawIntro, 'not vacuous');
  });

  it('an indented quote nested in a list item stays with its item', () => {
    const doc = ['## Db', '- You may delete the database', '  > only in a disposable test workspace', `- next ${'n'.repeat(300)}`, '## Tail', 'y'.repeat(400)].join('\n');
    let sawItem = false;
    for (let budget = 60; budget <= 400; budget += 2) {
      const { text } = condenseBySection(doc, budget);
      if (!text.includes('You may delete the database')) continue;
      sawItem = true;
      assert.ok(text.includes('only in a disposable test workspace'), `budget ${budget}: item kept without its qualification:\n${text}`);
    }
    assert.ok(sawItem, 'not vacuous');
  });

  it('budget released by a section completing is offered back to a stalled one', () => {
    // A ends in a 1-char block, so completing it gives back its marker (~20
    // chars). B's next block only fits with that released budget.
    const a = ['## A', 'a'.repeat(40), '', 'z'].join('\n');
    const b = ['## B', 'b'.repeat(30), '', 'c'.repeat(400)].join('\n');
    // A first: pass 1 gives A its cut block and stalls B; pass 2 completes A
    // (a negative step), and only that release lets B in.
    const doc = `${a}\n${b}`;
    let reached = false;
    for (let budget = 80; budget <= 260; budget++) {
      const { text, coverage } = condenseBySection(doc, budget);
      assert.ok(text.length <= budget);
      if (text.includes('z') && text.includes('b'.repeat(30))) reached = true;
      // Never leave usable budget idle: if A is whole and B is heading-only,
      // B's first block must truly not have fitted.
      if (coverage.headingOnly > 0 && text.includes(a)) {
        // B's first block costs 30 + 1 + its marker; one more char of slack is
        // the allocator's deliberate reserve for the first section's join.
        const need = 30 + 1 + `\n…[cut: 35/${b.length} chars]`.length;
        const spare = budget - text.length;
        assert.ok(spare <= need, `budget ${budget}: ${spare} chars idle while B stalled (needs ${need}):\n${text}`);
      }
    }
    assert.ok(reached, 'not vacuous: at some budget both A and the first block of B are kept');
  });

  it('`##` followed by a tab is a heading', () => {
    assert.deepEqual(splitInstructionSections('## A\na\n##\tSafety\ns').map((x) => x.heading), ['A', 'Safety']);
  });

  it('stays linear with many sections and one very long list', () => {
    const doc = [
      ...Array.from({ length: 2_000 }, (_, i) => `## S${i}\nshort body ${i}`),
      '## Long', ...Array.from({ length: 30_000 }, (_, i) => `- item ${i}`),
    ].join('\n');
    const started = Date.now();
    const { text } = condenseBySection(doc, 48_000);
    assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started}ms`);
    assert.ok(text.length <= 48_000);
  });

  it('a fence indented 4+ spaces is indented code, not a fence', () => {
    const s = splitInstructionSections('## A\n    ```\n## B\nb');
    assert.deepEqual(s.map((x) => x.heading), ['A', 'B']);
  });

  it('a headingless preamble that opens a fence is never cut inside it', () => {
    const doc = ['```md', '## not a heading', ...Array.from({ length: 50 }, (_, i) => `line ${i}`), '```', '## Real', 'body'].join('\n');
    const { text, coverage } = condenseBySection(doc, 120);
    assert.equal((text.match(/^```/gm) || []).length % 2, 0, `fence left open:\n${text}`);
    assert.ok(text.includes('## Real'));
    assert.ok(coverage.omitted >= 1, 'an unread preamble is counted as omitted, not represented');
  });

  it('a budget smaller than the note yields empty text, never an overrun', () => {
    for (const budget of [0, 1, 10]) {
      const { text, coverage } = condenseBySection('## A\nbody that is longer than the budget', budget);
      assert.ok(text.length <= budget, `budget ${budget}: ${text.length}`);
      assert.equal(coverage.omitted, coverage.totalSections);
    }
  });

  it('NEGATIVE CONTROL: the old head slice of the same fixture fails the same check', () => {
    // The exact pre-fix expression (`content.slice(0, 48000)`, context.mjs:253
    // at 067057e9). If this ever passes, the fixture no longer tests anything.
    const old = fixture.slice(0, LLM_BUDGET);
    assert.equal(old.includes(SENTINEL), false);
    assert.equal(old.includes('## Accepted Technical Debt'), false);
  });

  it('under budget the input is returned verbatim', () => {
    const small = '# t\n\n## A\nalpha\n\n## B\nbeta\n';
    const { text, coverage } = condenseBySection(small, 10_000);
    assert.equal(text, small);
    assert.deepEqual([coverage.whole, coverage.condensed, coverage.charsRead], [coverage.totalSections, 0, small.length]);
  });

  it('a tiny budget still names every section (headings first) and marks the cuts', () => {
    const { text, coverage } = condenseBySection(fixture, 1_500);
    for (let i = 1; i <= 14; i++) assert.ok(text.includes(`## Section ${i}`), `Section ${i} named`);
    assert.ok(text.includes('## Accepted Technical Debt'));
    assert.equal(coverage.represented, coverage.totalSections);
    assert.ok(coverage.condensed > 0);
    assert.match(text, /…\[cut: \d+\/\d+ chars\]/);
    assert.ok(text.length <= 1_500);
  });

  it('a section whose heading cannot fit is counted as omitted, never hidden', () => {
    const doc = `## ${'h'.repeat(60)}\nbody\n## B\n${'b'.repeat(100)}`;
    const { text, coverage } = condenseBySection(doc, 70);
    assert.equal(coverage.omitted, 1);
    assert.match(text, /, 1 omitted: budget\]$/);
    assert.ok(text.length <= 70);
    assert.match(formatSectionCoverage(coverage, 'AGENTS.md'), /1 omitted/);
  });

  it('is deterministic', () => {
    assert.deepEqual(condenseBySection(fixture, LLM_BUDGET), condenseBySection(fixture, LLM_BUDGET));
  });
});

describe('splitInstructionSections', () => {
  it('is lossless and keeps the preamble as its own section', () => {
    const doc = 'intro line\n\n## A\na\n## B\nb';
    const s = splitInstructionSections(doc);
    assert.deepEqual(s.map((x) => x.heading), [null, 'A', 'B']);
    assert.equal(s.map((x) => x.text).join('\n'), doc);
  });

  it('a `## ` inside a code fence is content, not a heading', () => {
    const doc = '## Real\n```md\n## not a heading\n```\nafter';
    const s = splitInstructionSections(doc);
    assert.deepEqual(s.map((x) => x.heading), ['Real']);
  });

  it('makeFenceTracker().isOpen() reports the state AFTER a closing delimiter', () => {
    const t = makeFenceTracker();
    t('````'); assert.equal(t.isOpen(), true);
    t('```'); assert.equal(t.isOpen(), true, 'a shorter fence does not close a longer one');
    t('````'); assert.equal(t.isOpen(), false);
  });

  it('a fence line carrying an info string does not close the open fence', () => {
    const t = makeFenceTracker();
    t('```markdown'); t('```js'); assert.equal(t.isOpen(), true, '"```js" is content inside the block');
    t('```'); assert.equal(t.isOpen(), false);
    const s = splitInstructionSections('## A\n```markdown\n```js\n## inside\n```\n## B');
    assert.deepEqual(s.map((x) => x.heading), ['A', 'B']);
  });

  it('round-trips this repo\'s own AGENTS.md', () => {
    const real = fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf-8');
    assert.equal(splitInstructionSections(real).map((x) => x.text).join('\n'), real);
  });
});

describe('initAuditBrief end-to-end (LLM leg injected — no spend)', () => {
  const originalCwd = process.cwd();
  const dirs = [];
  after(() => {
    process.chdir(originalCwd);
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  /** Fresh module instance (its caches are module-level) in a temp repo. */
  async function briefFor(content, condense, tag) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-cov-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), content);
    process.chdir(dir);
    try {
      const mod = await import(`${CONTEXT_URL}?case=${tag}`);
      return await mod.initAuditBrief({ condense });
    } finally {
      process.chdir(originalCwd);
    }
  }

  it('the LLM leg receives the last section, and the brief carries the coverage line', async () => {
    let seen = null;
    const brief = await briefFor(oversizedFixture(), async (input) => {
      seen = input;
      return 'x'.repeat(200);
    }, 'llm');
    assert.ok(seen?.includes(SENTINEL), 'the condensation input reached the last section');
    const m = brief.match(COVERAGE_RE);
    assert.ok(m, `coverage line missing from brief:\n${brief.slice(-300)}`);
    assert.equal(m[1], m[2], 'every section represented');
    assert.ok(Number(m[3]) <= LLM_BUDGET && Number(m[4]) > LLM_BUDGET);
  });

  it('regex-only fallback: names the last section and carries the coverage line', async () => {
    const brief = await briefFor(oversizedFixture({ depTable: true }), async () => null, 'regex');
    assert.match(brief, /## Raw Context/, 'took the regex-only path');
    assert.ok(brief.includes('## Accepted Technical Debt'));
    assert.match(brief, COVERAGE_RE);
  });

  it('raw fallback: names the last section and carries the coverage line', async () => {
    const brief = await briefFor(oversizedFixture(), async () => null, 'raw');
    assert.doesNotMatch(brief, /## Raw Context/, 'took the raw path');
    assert.ok(brief.includes('## Accepted Technical Debt'));
    assert.match(brief, COVERAGE_RE);
  });
});

describe('no head slice of the instruction file survives', () => {
  const SRC = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'lib', 'context.mjs'), 'utf-8');
  it('content.slice(0, N) is gone from context.mjs', () => {
    assert.doesNotMatch(SRC, /content\.slice\(0, \d/);
  });
});

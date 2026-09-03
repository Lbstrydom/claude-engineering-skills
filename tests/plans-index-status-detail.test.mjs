import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractStatusDetail } from '../scripts/generate-plans-index.mjs';
import { parsePlanStatus } from '../scripts/lib/plan-status.mjs';

/**
 * `docs/plans/README.md` is a committed, freshness-gated artefact, so a
 * rendering defect here is not cosmetic-and-local: it ships to every clone and
 * regenerates faithfully, which is why the orphan bracket below went unnoticed
 * for as long as the rows existed.
 *
 * Every case runs the REAL pipeline — `parsePlanStatus` produces the `raw` the
 * index actually renders — rather than handing `extractStatusDetail` a value
 * assembled by the test. A test that builds its own input can only confirm the
 * reader against the shape the reader expects.
 */
const plan = (status) => `# Plan: Example\n\n- **Status**: ${status}\n\n## 1. Context\n`;

const detailOf = (status) => {
  const parsed = parsePlanStatus(plan(status));
  assert.equal(parsed.ok, true, `status did not parse: ${status}`);
  return extractStatusDetail(parsed.raw, parsed.token);
};

describe('extractStatusDetail — parenthetical handling', () => {
  it('keeps a parenthetical that closes early intact (orphan `)` regression)', () => {
    const detail = detailOf('Complete (cross-host unverified) — E1–E6 in §9 are NOT yet run');
    assert.equal(detail, '(cross-host unverified) — E1–E6 in §9 are NOT yet run');
    assert.ok(!/^[^(]*\)/.test(detail), `orphan close bracket rendered: ${detail}`);
  });

  it('keeps a trailing parenthetical intact (orphan `(` regression)', () => {
    assert.equal(detailOf('Complete — shipped (partly)'), 'shipped (partly)');
  });

  it('still unwraps a detail that is wholly parenthesised', () => {
    assert.equal(detailOf('Complete (superseded by Y)'), 'superseded by Y');
  });

  it('measures nested pairs by balance, not by the first `)`', () => {
    assert.equal(detailOf('Complete (see (2) below)'), 'see (2) below');
  });

  it('leaves an unbalanced status untouched rather than guessing', () => {
    assert.equal(detailOf('Complete (unbalanced — oops'), '(unbalanced — oops');
  });

  it('strips a plain separator detail, and yields empty for a bare token', () => {
    assert.equal(detailOf('In Progress — Cluster B pending'), 'Cluster B pending');
    assert.equal(detailOf('Complete'), '');
  });

  it('escapes a pipe so a detail cannot break the markdown table', () => {
    assert.equal(detailOf('Complete — a | b'), String.raw`a \| b`);
  });
});

describe('extractStatusDetail — wrapped Status lines', () => {
  it('carries an indented continuation into the detail', () => {
    const content = [
      '# Plan: Example',
      '',
      '- **Status**: Complete — first line of the reason,',
      '  continued on a second line,',
      '  and a third.',
      '- **Author**: Someone',
      '',
      '## 1. Context',
    ].join('\n');
    const parsed = parsePlanStatus(content);
    assert.equal(parsed.ok, true);
    assert.equal(
      extractStatusDetail(parsed.raw, parsed.token),
      'first line of the reason, continued on a second line, and a third.',
    );
  });

  it('does NOT fold an unindented following metadata field', () => {
    // 7 plans in this corpus put `Date:` / `**Owner**:` / `**Scope**:` on the
    // next line, unindented. Folding those would attribute one field to another.
    const content = [
      '# Plan: Example',
      '',
      '- **Status**: Complete — the real reason',
      'Date: 2026-07-13',
      '',
      '## 1. Context',
    ].join('\n');
    const parsed = parsePlanStatus(content);
    assert.equal(parsed.ok, true);
    assert.equal(extractStatusDetail(parsed.raw, parsed.token), 'the real reason');
  });

  it('leaves a nested sub-bullet as its own item', () => {
    const content = [
      '# Plan: Example',
      '',
      '- **Status**: Complete — top level only',
      '  - a nested bullet',
      '',
      '## 1. Context',
    ].join('\n');
    const parsed = parsePlanStatus(content);
    assert.equal(parsed.ok, true);
    assert.equal(extractStatusDetail(parsed.raw, parsed.token), 'top level only');
  });
  it('still reports a duplicate Status line even when the second is indented', () => {
    // Folding must not swallow a second Status line: check-plan-status FAILS on
    // `duplicate`, so absorbing one would convert a hard failure into a pass.
    const content = [
      '# Plan: Example',
      '',
      '- **Status**: Complete — one',
      '  **Status**: In Progress — two',
      '',
      '## 1. Context',
    ].join('\n');
    const parsed = parsePlanStatus(content);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, 'duplicate');
    assert.deepEqual(parsed.rawStatusValues, ['Complete — one', 'In Progress — two']);
  });

  it('still folds a continuation that merely starts with bold', () => {
    const content = [
      '# Plan: Example',
      '',
      '- **Status**: Complete — one',
      '  **Round 2**: a later audit round',
      '',
      '## 1. Context',
    ].join('\n');
    const parsed = parsePlanStatus(content);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.raw, 'Complete — one **Round 2**: a later audit round');
  });
});

describe('extractStatusDetail — clipping', () => {
  const long = (n) => `Complete — ${'word '.repeat(n).trim()}`;

  it('marks every clip with an ellipsis and stays within budget', () => {
    const out = detailOf(long(60));
    assert.ok(out.endsWith('…'), `clip not marked: ${out}`);
    assert.ok(out.length <= 110, `over budget: ${out.length}`);
  });

  it('never splits a word', () => {
    const status = long(60);
    const out = detailOf(status);
    const kept = out.slice(0, -1);
    const source = status.slice('Complete — '.length);
    assert.ok(source.startsWith(kept), 'clipped text is not a prefix of the source');
    // The character right after the kept run must be a boundary, not mid-word.
    const next = source[kept.length];
    assert.ok(next === undefined || next === ' ', `split mid-word before ${JSON.stringify(next)}`);
  });

  it('never ends inside an unclosed parenthesis', () => {
    // The tail parenthetical starts before the budget and closes after it, so a
    // bare slice would leave the opener orphaned — the same defect
    // unwrapWholeParenthetical fixes at the front, arriving from the clip.
    const out = detailOf(`Complete — ${'x '.repeat(30)}and then a (parenthetical that runs well past the budget for certain)`);
    const opens = (out.match(/\(/g) || []).length;
    const closes = (out.match(/\)/g) || []).length;
    assert.ok(opens <= closes, `orphan open bracket: ${out}`);
    assert.ok(out.endsWith('…'));
  });

  it('leaves a detail inside the budget untouched', () => {
    const out = detailOf('Complete — a short reason');
    assert.equal(out, 'a short reason');
    assert.ok(!out.includes('…'));
  });

  it('still bounds a single unbroken run with no space to back off to', () => {
    const out = detailOf(`Complete — ${'y'.repeat(300)}`);
    assert.ok(out.length <= 110, `unbounded: ${out.length}`);
    assert.ok(out.endsWith('…'));
  });
});

describe('one Status-line reader (layering contract)', () => {
  // Both index bugs fixed on 2026-09-03 came from a SECOND reader parsing the
  // Status line with its own regex: it silently inherited the `$`-anchored
  // fragment bug that lib/plan-status.mjs had already outgrown. Nothing gated
  // that — `arch:duplicates` is cloud-snapshot-backed and on-demand, so it can
  // neither see the commit being pushed nor run in the pre-push sandbox. This
  // does, from source, in a clean checkout.
  //
  // Retire when a real second owner is justified: add it to OWNERS with a
  // written reason rather than deleting the assertion.
  const OWNERS = ['scripts/lib/plan-status.mjs'];
  // The escaped bold only ever occurs inside a regex literal; prose writes
  // `**Status**` unescaped, so this does not fire on comments or docs.
  const NEEDLE = `Status${String.fromCharCode(92)}*${String.fromCharCode(92)}*`;

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const scan = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') scan(abs, out); }
      else if (e.name.endsWith('.mjs') && fs.readFileSync(abs, 'utf8').includes(NEEDLE)) {
        out.push(path.relative(repoRoot, abs).split(path.sep).join('/'));
      }
    }
    return out;
  };

  it('finds the needle in the declared owner (vacuity guard)', () => {
    // Without this, a typo in NEEDLE makes the census empty and the next
    // assertion pass having checked nothing.
    const owner = path.join(repoRoot, OWNERS[0]);
    assert.ok(fs.readFileSync(owner, 'utf8').includes(NEEDLE), 'NEEDLE no longer matches the owner');
  });

  it('is the only module parsing the Status line', () => {
    const found = scan(path.join(repoRoot, 'scripts')).sort();
    assert.deepEqual(found, OWNERS.slice().sort(),
      `a second Status-line parser appeared. Read it through parsePlanStatus (which returns \`raw\`) instead of re-deriving the regex, or add it to OWNERS with a reason.`);
  });
});

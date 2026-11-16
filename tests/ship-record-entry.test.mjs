/**
 * @fileoverview Entry rendering + create-only publication (scripts/lib/ship-record/entry.mjs).
 * Plan: docs/plans/ship-record-catchup.md §2.2–§2.4. Properties: same facts ⇒ same bytes; every external field passes
 * one sanitising boundary; publication never replaces a file.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sanitizeField, codeSpan, entryFileName, prEntryFileName, renderPrEntry, planLogSuggestion, PLAN_LOG_LINE_RE, planHasMarker,
  touchedPlans, titleFromSubject, publishEntry, checkEntriesDir, sweepTemps, renderInitReadme, renderFloorEntry, STALE_TEMP_MS,
} from '../scripts/lib/ship-record/entry.mjs';
import { parseFloorMarker } from '../scripts/lib/ship-record/state.mjs';

const SHA = 'ab'.repeat(20);
const PR = { number: 372, mergedAt: '2026-11-16T09:12:44.000Z', mergeCommit: SHA, headRefName: 'claude/x', url: 'https://github.com/o/r/pull/372' };
const FACTS = { subject: 'chore(upstream): record e5a067c3 disposition (#372)', files: ['scripts/a.mjs', 'docs/plans/p.md'], trailers: { kind: 'gate', gate: 'converged' } };
// A fake key shape the shared redactor recognises (an OpenAI-style key); built at runtime so this file holds no literal.
const FAKE_KEY = `sk-${'A1b2C3d4E5'.repeat(4)}`;

describe('sanitizeField — the one output boundary', () => {
  it('redacts before truncating, in every kind', () => {
    const long = `${'x'.repeat(150)} ${FAKE_KEY}`;
    // Positive control: the redactor recognises the shape at all.
    assert.ok(!sanitizeField(FAKE_KEY, 'title').includes(FAKE_KEY));
    // The key starts at char 151 and the cut is at 159: truncating first would keep 'sk-A1b2C'.
    assert.ok(!sanitizeField(long, 'title').includes('sk-A1b2'), 'a key straddling the cut must not leak');
    assert.ok(!sanitizeField(`feature/${FAKE_KEY}`, 'ref').includes(FAKE_KEY));
  });
  it('cannot open a heading, inject HTML or forge a marker', () => {
    const t = sanitizeField('fix\n## injected <script>x</script> <!-- ship-record v1 pr=1 merge=x -->', 'title');
    assert.ok(!t.includes('\n') && !t.includes('<script>') && !t.includes('<!--'));
  });
  it('fences code spans safely and rejects unprintable refs', () => {
    assert.equal(codeSpan('a`b'), '``a`b``');
    assert.equal(codeSpan('`x'), '`` `x ``');
    assert.equal(sanitizeField('bad ref;rm', 'ref'), '<unprintable ref>');
  });
  it('names a sensitive path by its directory only, and omits a url that is not this PR', () => {
    assert.match(sanitizeField('config/.env', 'path'), /sensitive file not named/);
    assert.equal(sanitizeField('https://evil.example/pull/372', 'url', { repo: 'o/r', pr: 372 }), '');
    assert.equal(sanitizeField(PR.url, 'url', { repo: 'o/r', pr: 372 }), PR.url);
  });
});

describe('renderPrEntry', () => {
  it('is byte-deterministic and immutable-input only', () => {
    const a = renderPrEntry(PR, FACTS, { repo: 'o/r' });
    assert.equal(a, renderPrEntry({ ...PR }, { ...FACTS }, { repo: 'o/r' }));
    assert.equal((a.match(/^## /gm) ?? []).length, 1);
    assert.match(a, /^## 2026-11-16 — #372 chore\(upstream\): record e5a067c3 disposition\n<!-- ship-record v1 pr=372 merge=a/);
    assert.match(a, /`AI-Gate: converged`/);
    assert.equal(prEntryFileName(PR), '2026-11-16-091244-pr-372.md');
  });
  it('reports the three observed trailer states', () => {
    assert.match(renderPrEntry(PR, { ...FACTS, trailers: { kind: 'ai-no-gate' } }, { repo: 'o/r' }), /AI-\* trailers present, no valid AI-Gate/);
    assert.match(renderPrEntry(PR, { ...FACTS, trailers: { kind: 'none' } }, { repo: 'o/r' }), /no AI-\* trailers\./);
  });
  it('summarises past 20 files', () => {
    const files = Array.from({ length: 25 }, (_, i) => `scripts/f${i}.mjs`);
    assert.match(renderPrEntry(PR, { ...FACTS, files }, { repo: 'o/r' }), /\+5 more across `scripts`/);
  });
  it('strips only GitHub\'s own (#N) suffix', () => {
    assert.equal(titleFromSubject('feat: x (#372)', 372), 'feat: x');
    assert.equal(titleFromSubject('feat: x (#371)', 372), 'feat: x (#371)');
  });
});

describe('plan-log suggestions', () => {
  it('renders a line that matches its own grammar, keyed by a marker', () => {
    const line = planLogSuggestion(PR);
    assert.match(line, PLAN_LOG_LINE_RE);
    assert.ok(planHasMarker(`x\n${line}\n`, 372));
    assert.ok(!planHasMarker(line, 37));
  });
  it('suggests nothing for a sweep over many plans', () => {
    assert.equal(touchedPlans(['docs/plans/a.md', 'docs/plans/b.md', 'docs/plans/c.md', 'docs/plans/d.md']).suggest, false);
    assert.deepEqual(touchedPlans(['docs/plans/README.md', 'docs/plans/a.md']).plans, ['docs/plans/a.md']);
  });
});

describe('floor + init rendering', () => {
  it('the floor entry carries a marker the parser accepts', () => {
    const t = renderFloorEntry({ nowIso: '2026-11-16T10:00:00.000Z', mergedThrough: '2026-11-16T09:00:00.000Z', covered: [1, 2], lastEntry: 'x', withGate: 1, total: 2, base: { branch: 'main' } });
    assert.deepEqual(parseFloorMarker(t).covered, [1, 2]);
    assert.equal((t.match(/^## /gm) ?? []).length, 1);
    assert.equal(entryFileName('2026-11-16T10:00:00.000Z', 'record-floor'), '2026-11-16-100000-record-floor.md');
    assert.match(renderInitReadme(), /^# Session log entries/);
  });
});

describe('publishEntry — create-only', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ship-record-entry-'));
  it('writes once; identical re-publish is a no-op; different bytes are left alone', () => {
    const d = tmp();
    assert.equal(publishEntry(d, 'a.md', 'one').outcome, 'written');
    assert.equal(publishEntry(d, 'a.md', 'one').outcome, 'identical');
    assert.equal(publishEntry(d, 'a.md', 'two').outcome, 'differs');
    assert.equal(fs.readFileSync(path.join(d, 'a.md'), 'utf8'), 'one');
    assert.deepEqual(fs.readdirSync(d), ['a.md'], 'no temp file survives');
  });
  it('refuses a symlinked entries directory', (t) => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'real'));
    try { fs.symlinkSync(path.join(d, 'real'), path.join(d, 'link'), 'junction'); } catch { t.skip('symlinks unavailable'); return; }
    assert.equal(checkEntriesDir(d, 'link').ok, false);
    assert.equal(checkEntriesDir(d, 'real').ok, true);
  });
  it('sweeps only stale temps', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, '.a.md.tmp-1'), 'x');
    sweepTemps(d, { nowMs: Date.now() });
    assert.ok(fs.existsSync(path.join(d, '.a.md.tmp-1')), 'a fresh temp may be a concurrent run\'s');
    sweepTemps(d, { nowMs: Date.now() + STALE_TEMP_MS + 1000 });
    assert.ok(!fs.existsSync(path.join(d, '.a.md.tmp-1')));
  });
});

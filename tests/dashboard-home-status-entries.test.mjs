/**
 * @fileoverview Tier 1 (pure): the `status.md` head parser behind the Home
 * "Recently shipped" card. Fixtures: an excerpt copied from this repo's real
 * `status.md`, the real file read at test time (structural assertions only — the
 * file moves), and synthetic edge cases.
 *
 * Plan: docs/plans/dashboard-home-summary.md §2, §9.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseStatusEntries, latestBacklogLine, STATUS_HEAD_BYTES } from '../scripts/lib/dashboard/status-entries.mjs';
import { readStatusHead, shippedLog } from '../scripts/lib/dashboard/collect-home-shipped.mjs';
import { parseBacklogLine } from '../scripts/lib/store/backlog-snapshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Copied (trimmed) from status.md at 5b6fedd3.
const REAL_EXCERPT = `# Status

Preamble prose that is not an entry.

## 2026-10-06 — /fleet: coordinate concurrent AI coding sessions (17th skill)

Plan: \`docs/plans/fleet-multi-session-coordination.md\`. Built by \`/cycle --autonomous\`.

### What shipped
- **\`/fleet\`** — \`status\` (read-only)

### Backlog
Backlog 2026-10-06T04:56Z: Q1 68c/8p (+353 aged) · Q2 89c/42p (54 perm) · Q3 35 · debt 303 cloud/67 local (0 spilled) · upstream 1

---

## 2026-10-03 — backlog + arch-drift sweep: verified debt fixes, test-helper dedup, ledger single-writer

Backlog 2026-10-03T12:42Z: Q1 68c/23p (+338 aged) · Q2 101c/60p (54 perm) · Q3 35 · debt unmeasured · upstream 1

## 2026-10-02 — correction: accepted control-marker count (PR #147)
`;

describe('parseStatusEntries', () => {
  test('parses a real excerpt: dates, titles (with an em dash and colons), the plan path from the body', () => {
    const { entries, skippedHeadings } = parseStatusEntries(REAL_EXCERPT, 10);
    assert.equal(skippedHeadings, 0, 'the ### subsections are not entries and not "unparsed"');
    assert.deepEqual(entries.map((e) => e.date), ['2026-10-06', '2026-10-03', '2026-10-02']);
    assert.equal(entries[0].title, '/fleet: coordinate concurrent AI coding sessions (17th skill)');
    assert.equal(entries[0].planPath, 'docs/plans/fleet-multi-session-coordination.md');
    assert.equal(entries[1].planPath, null);
  });

  test('the limit bounds the list', () => {
    assert.equal(parseStatusEntries(REAL_EXCERPT, 2).entries.length, 2);
    assert.equal(parseStatusEntries(REAL_EXCERPT, 0).entries.length, 0);
  });

  test('no headings at all: no entries, nothing skipped', () => {
    assert.deepEqual(parseStatusEntries('just prose\nmore prose\n'), { entries: [], skippedHeadings: 0, capped: false });
    assert.deepEqual(parseStatusEntries(''), { entries: [], skippedHeadings: 0, capped: false });
    assert.deepEqual(parseStatusEntries(null), { entries: [], skippedHeadings: 0, capped: false });
  });

  test('non-dated ## headings are COUNTED, never silently dropped', () => {
    const text = '## Not a date\n\n## 2026-10-06 — real\n\n## 2026/10/05 — wrong separators\n\n## 2026-10-04 title with no dash\n';
    const r = parseStatusEntries(text);
    assert.equal(r.entries.length, 1);
    assert.equal(r.skippedHeadings, 3);
  });

  test('a ## line inside a code fence is not a heading', () => {
    const text = '## 2026-10-06 — real\n```\n## 2026-01-01 — inside a fence\n## nonsense\n```\n';
    const r = parseStatusEntries(text);
    assert.equal(r.entries.length, 1);
    assert.equal(r.skippedHeadings, 0);
  });

  test('M4: a nested fence (a ``` example inside ~~~~markdown) is handled by the shared tracker', () => {
    const text = [
      '## 2026-10-06 — real',
      '~~~~markdown',
      '## 2026-01-01 — inside the outer fence',
      '```',
      '## 2026-01-02 — still inside (the inner ``` neither closes nor reopens the outer)',
      '```',
      'Backlog 2026-01-01T00:00Z: Q1 1c/1p · Q2 1c/1p · Q3 1 · debt unmeasured · upstream 1',
      '~~~~',
      '## 2026-10-05 — after the fence',
      '',
    ].join('\n');
    const r = parseStatusEntries(text);
    assert.deepEqual(r.entries.map((e) => e.title), ['real', 'after the fence']);
    assert.equal(r.skippedHeadings, 0);
    assert.equal(latestBacklogLine(text), null, 'a Backlog line inside a fenced example is not the latest line');
  });

  test('M4: a Backlog line inside a fence is skipped in favour of the real one after it', () => {
    const text = '```\nBacklog 2026-01-01T00:00Z: Q1 9c/9p · Q2 9c/9p · Q3 9 · debt unmeasured · upstream 9\n```\nBacklog 2026-10-06T04:56Z: Q1 1c/1p · Q2 1c/1p · Q3 1 · debt unmeasured · upstream 1\n';
    assert.match(latestBacklogLine(text), /^Backlog 2026-10-06T04:56Z/);
  });

  test('M5/H6c: `capped` comes from the caller (file size), so an exact-cap PREFIX of a larger file is reported partial', () => {
    const exact = '## 2026-10-06 — one\n' + 'x'.repeat(STATUS_HEAD_BYTES - 20);
    assert.equal(exact.length, STATUS_HEAD_BYTES);
    assert.equal(parseStatusEntries(exact).capped, false, 'by length alone it looks complete');
    const r = parseStatusEntries(exact, 10, { capped: true });
    assert.equal(r.capped, true);
    assert.equal(r.entries.length, 1);
    assert.equal(parseStatusEntries('## 2026-10-06 — one\n', 10, { capped: false }).capped, false);
  });

  test('a plan path must be docs/plans/*.md and never contain ..', () => {
    const r = parseStatusEntries('## 2026-10-06 — x\nSee docs/plans/../../etc/passwd.md and docs/plans/ok-plan.md\n');
    assert.equal(r.entries[0].planPath, 'docs/plans/ok-plan.md');
    const bad = parseStatusEntries('## 2026-10-06 — x\nsee docs/plans/..%2f.md\n');
    assert.ok(bad.entries[0].planPath === null || !bad.entries[0].planPath.includes('..'));
  });

  test('256 KB cap: entries past the window are not read, and a cut final line is dropped, not parsed as garbage', () => {
    const early = '## 2026-10-06 — early\n';
    const filler = 'x'.repeat(100) + '\n';
    let body = early;
    while (body.length < STATUS_HEAD_BYTES - 30) body += filler;
    body += '## 2026-01-01 — straddles the cap\nplus more\n'.repeat(3) + '## 2026-01-02 — far past the cap\n';
    const r = parseStatusEntries(body, 50);
    assert.deepEqual(r.entries.map((e) => e.title), ['early']);
    assert.equal(r.skippedHeadings, 0);
  });

  test('CRLF files (a Windows checkout) parse the same', () => {
    assert.equal(parseStatusEntries(REAL_EXCERPT.replace(/\n/g, '\r\n')).entries.length, 3);
  });
});

describe('latestBacklogLine', () => {
  test('returns the NEWEST (first) Backlog line and it parses', () => {
    const line = latestBacklogLine(REAL_EXCERPT);
    assert.equal(line, 'Backlog 2026-10-06T04:56Z: Q1 68c/8p (+353 aged) · Q2 89c/42p (54 perm) · Q3 35 · debt 303 cloud/67 local (0 spilled) · upstream 1');
    assert.equal(parseBacklogLine(line).q1.code, 68);
  });
  test('null when there is none', () => {
    assert.equal(latestBacklogLine('## 2026-10-06 — x\nno backlog here\n'), null);
    assert.equal(latestBacklogLine(undefined), null);
  });
});

describe('against the REAL status.md of this repo (structural only)', () => {
  test('the head parses to entries and the newest Backlog line round-trips through parseBacklogLine', () => {
    const read = readStatusHead(ROOT);
    assert.equal(read.absent, false);
    const { entries } = parseStatusEntries(read.text, 10);
    assert.ok(entries.length >= 1 && entries.length <= 10);
    assert.ok(entries.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.title.length > 0));
    const line = latestBacklogLine(read.text);
    assert.ok(line, 'this repo records a Backlog line');
    assert.notEqual(parseBacklogLine(line), null, `the real line must parse: ${line}`);
  });
});

describe('readStatusHead / shippedLog', () => {
  test('H6c/M5: readStatusHead reports capped from the FILE SIZE: exactly the cap is complete, one byte more is partial', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-status-'));
    try {
      const heading = '## 2026-10-06 — head\n';
      const body = (n) => heading + 'a'.repeat(n - Buffer.byteLength(heading)); // bytes, not chars: the dash is 3 bytes
      fs.writeFileSync(path.join(dir, 'status.md'), body(STATUS_HEAD_BYTES));
      assert.equal(readStatusHead(dir).capped, false);
      fs.writeFileSync(path.join(dir, 'status.md'), body(STATUS_HEAD_BYTES) + 'b');
      const read = readStatusHead(dir);
      assert.equal(read.capped, true);
      const m = shippedLog(read);
      assert.equal(m.status, 'ok');
      assert.equal(m.value.partial, true);
      assert.match(m.detail, /partial: only the first 256 KB/);
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  test('a complete file is not partial', () => {
    const m = shippedLog({ text: '## 2026-10-06 — ok\n', absent: false, error: null, capped: false });
    assert.equal(m.value.partial, false);
    assert.equal(m.detail, '');
  });

  test('no status.md: missing-optional "nothing to list", not an error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-status-'));
    try {
      const read = readStatusHead(dir);
      assert.deepEqual(read, { text: null, absent: true, error: null, capped: false });
      const m = shippedLog(read, new Date('2026-10-06T12:00:00Z'));
      assert.equal(m.status, 'missing-optional');
      assert.match(m.detail, /No status\.md/);
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  test('reads at most STATUS_HEAD_BYTES from the head of a large file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-status-'));
    try {
      const big = `## 2026-10-06 — head\n${'y'.repeat(100)}\n`.repeat(1) + 'z'.repeat(STATUS_HEAD_BYTES * 2);
      fs.writeFileSync(path.join(dir, 'status.md'), big);
      const read = readStatusHead(dir);
      assert.ok(Buffer.byteLength(read.text, 'utf8') <= STATUS_HEAD_BYTES);
      assert.equal(shippedLog(read).value.entries[0].title, 'head');
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  test('unparsed headings are surfaced in the measurement', () => {
    const m = shippedLog({ text: '## 2026-10-06 — ok\n## Mystery\n## Another\n', absent: false, error: null });
    assert.equal(m.status, 'ok');
    assert.equal(m.value.skippedHeadings, 2);
    assert.match(m.detail, /2 heading\(s\) unparsed/);
  });

  test('a status.md that cannot be read is unexpected-error (a defect), never silently empty', () => {
    const m = shippedLog({ text: null, absent: false, error: 'cannot read status.md (EACCES)' });
    assert.equal(m.status, 'unexpected-error');
  });
});

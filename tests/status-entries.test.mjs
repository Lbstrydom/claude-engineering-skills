/**
 * @fileoverview The session log as one file per entry (plan §12): the name grammar, the
 * entry-record vs marker split, Laws 6-9 of the conservation gate, and the reader.
 *
 * Each law is tested ALONE (its own `kind`, no other violation), plus the legal neighbour that
 * must keep passing, because a gate is only trustworthy once it has been seen to fail and seen
 * not to over-fire.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ENTRIES_DIR, MARKER_REL, parseEntryName, validateEntryText, perEntryMode, isEntryRecordPath,
  listEntryFiles, readLogHead,
} from '../scripts/lib/status-entry-files.mjs';
import { checkConservation } from '../scripts/lib/status-log-integrity.mjs';

const HEADER = '# Project Status Log\n\n';
const root = (...entries) => HEADER + entries.join('');
const old = (date, body = 'old work') => `## ${date} — old\n\n${body}\n\n---\n`;
const entryPath = (name) => `${ENTRIES_DIR}/${name}`;
const GOOD_NAME = '2026-10-16-093000-per-entry-log.md';
const GOOD_TEXT = '## 2026-10-16 — per-entry log\n\nBody of the entry.\n';

const state = (over = {}) => ({ root: root(old('2026-10-01')), archives: {}, manifest: null, ...over });
const kinds = (r) => r.violations.map((v) => v.kind);

describe('parseEntryName / validateEntryText', () => {
  test('a well-formed name parses into date, time and slug', () => {
    assert.deepEqual(parseEntryName(GOOD_NAME), { date: '2026-10-16', time: '093000', slug: 'per-entry-log' });
  });

  for (const [why, name] of [
    ['an uppercase slug', '2026-10-16-093000-Per-Entry.md'],
    ['a missing time', '2026-10-16-per-entry-log.md'],
    ['a short time', '2026-10-16-0930-per-entry-log.md'],
    ['a .txt extension', '2026-10-16-093000-per-entry-log.txt'],
    ['an empty slug', '2026-10-16-093000-.md'],
    ['a double hyphen in the slug', '2026-10-16-093000-per--entry.md'],
    ['a nested path', 'sub/2026-10-16-093000-x.md'],
  ]) {
    test(`rejects ${why}`, () => assert.equal(parseEntryName(name), null));
  }

  test('a good name and body validate clean', () => {
    assert.deepEqual(validateEntryText(GOOD_NAME, GOOD_TEXT), []);
  });

  test('CRLF text validates the same as LF', () => {
    assert.deepEqual(validateEntryText(GOOD_NAME, GOOD_TEXT.replace(/\n/g, '\r\n')), []);
  });

  for (const [why, name, text, re] of [
    ['a heading date that differs from the name', GOOD_NAME, '## 2026-10-17 — x\n\nbody\n', /differs from the file name/],
    ['a first line that is not a dated heading', GOOD_NAME, 'intro\n## 2026-10-16 — x\n\nbody\n', /first line/],
    ['two ## headings (an entry hidden inside another)', GOOD_NAME, '## 2026-10-16 — a\n\nbody\n\n## 2026-10-16 — b\n\nmore\n', /exactly one/],
    ['an empty body', GOOD_NAME, '## 2026-10-16 — a\n\n\n', /no body/],
    ['a heading with a date but no summary', GOOD_NAME, '## 2026-10-16\n\nbody\n', /no summary/],
    ['a bad file name', 'notes.md', GOOD_TEXT, /does not match/],
  ]) {
    test(`flags ${why}`, () => {
      assert.ok(validateEntryText(name, text).some((p) => re.test(p)), why);
    });
  }
});

describe('the marker is a control file, not an entry record', () => {
  test('perEntryMode is true iff the marker path is present', () => {
    assert.equal(perEntryMode([MARKER_REL, entryPath(GOOD_NAME)]), true);
    assert.equal(perEntryMode([entryPath(GOOD_NAME)]), false, 'entries without the marker are NOT per-entry mode');
    assert.equal(perEntryMode([]), false);
  });

  test('isEntryRecordPath excludes the marker, nested paths and non-markdown', () => {
    assert.equal(isEntryRecordPath(entryPath(GOOD_NAME)), true);
    assert.equal(isEntryRecordPath(MARKER_REL), false);
    assert.equal(isEntryRecordPath(`${ENTRIES_DIR}/sub/${GOOD_NAME}`), false);
    assert.equal(isEntryRecordPath(`${ENTRIES_DIR}/notes.txt`), false);
    assert.equal(isEntryRecordPath(`docs/status/${GOOD_NAME}`), false);
  });
});

describe('conservation gate, Laws 6-9', () => {
  const marked = (over = {}) => state({ marker: true, entries: {}, ...over });

  test('legacy: no marker, no entries behaves exactly as before (a new root entry is legal)', () => {
    const prev = state();
    const curr = state({ root: root(old('2026-10-15', 'newer'), old('2026-10-01')) });
    assert.deepEqual(checkConservation(prev, curr), { ok: true, violations: [] });
  });

  test('marker-only directory, both ends: conserved (and only because the marker was detected)', () => {
    assert.equal(checkConservation(marked(), marked()).ok, true);
  });

  test('Law 6 alone: the root may not gain a heading once the marker exists', () => {
    const r = checkConservation(marked(), marked({ root: root(old('2026-10-15', 'newer'), old('2026-10-01')) }));
    assert.deepEqual(kinds(r), ['root-entry-added']);
    assert.match(r.violations[0].detail, /move ONLY your added/);
  });

  test('Law 6 neighbour: appending to an EXISTING root entry stays legal', () => {
    const curr = marked({ root: root(old('2026-10-01', 'old work\n\nan appended line')) });
    assert.equal(checkConservation(marked(), curr).ok, true);
  });

  test('Law 6 recipe: new root block + a legal amendment to an older entry; the span-aware fix passes', () => {
    const prev = marked({ root: root(old('2026-10-01', 'old work')) });
    const tripped = marked({ root: root(old('2026-10-15', 'mine'), old('2026-10-01', 'old work\n\namended note')) });
    assert.deepEqual(kinds(checkConservation(prev, tripped)), ['root-entry-added']);
    // The recipe: move ONLY the added block into a file, keep the amendment in status.md.
    const fixed = marked({
      root: root(old('2026-10-01', 'old work\n\namended note')),
      entries: { [entryPath('2026-10-15-120000-mine.md')]: '## 2026-10-15 — old\n\nmine\n\n---\n' },
    });
    assert.deepEqual(checkConservation(prev, fixed), { ok: true, violations: [] });
  });

  test('Law 6 counts a DUPLICATE heading as a gain (multiset, not set)', () => {
    const prev = marked();
    const curr = marked({ root: root(old('2026-10-01'), old('2026-10-01')) });
    assert.deepEqual(kinds(checkConservation(prev, curr)), ['root-entry-added']);
  });

  test('a new well-formed entry passes', () => {
    const curr = marked({ entries: { [entryPath(GOOD_NAME)]: GOOD_TEXT } });
    assert.deepEqual(checkConservation(marked(), curr), { ok: true, violations: [] });
  });

  test('Law 7 alone: editing an entry that exists at the base fails', () => {
    const prev = marked({ entries: { [entryPath(GOOD_NAME)]: GOOD_TEXT } });
    const curr = marked({ entries: { [entryPath(GOOD_NAME)]: `${GOOD_TEXT}\nsneaky edit\n` } });
    assert.deepEqual(kinds(checkConservation(prev, curr)), ['entry-edited']);
  });

  test('Law 7 alone: deleting an entry that exists at the base fails', () => {
    const prev = marked({ entries: { [entryPath(GOOD_NAME)]: GOOD_TEXT } });
    assert.deepEqual(kinds(checkConservation(prev, marked())), ['entry-deleted']);
  });

  test('Law 7 neighbour: a CRLF checkout of an unchanged entry is not an edit', () => {
    const prev = marked({ entries: { [entryPath(GOOD_NAME)]: GOOD_TEXT } });
    const curr = marked({ entries: { [entryPath(GOOD_NAME)]: GOOD_TEXT.replace(/\n/g, '\r\n') } });
    assert.equal(checkConservation(prev, curr).ok, true);
  });

  test('the marker\'s documentation may change freely (it is not an entry record)', () => {
    // The marker's TEXT is not part of `entries`, so a rewrite of it cannot trip Law 7.
    assert.equal(checkConservation(marked(), marked()).ok, true);
  });

  test('Law 8 alone: a malformed NEW entry fails with its own kind', () => {
    const curr = marked({ entries: { [entryPath('2026-10-16-093000-x.md')]: '## 2026-10-17 — x\n\nbody\n' } });
    const r = checkConservation(marked(), curr);
    assert.deepEqual(kinds(r), ['entry-malformed']);
    assert.match(r.violations[0].detail, /differs from the file name/);
  });

  test('Law 8 does not re-judge an entry that already existed at the base', () => {
    const odd = { [entryPath('2026-10-16-093000-x.md')]: 'no heading at all\n' };
    assert.equal(checkConservation(marked({ entries: odd }), marked({ entries: odd })).ok, true);
  });

  test('Law 9 alone: deleting the marker fails, and cannot switch the other laws off', () => {
    const prev = marked();
    const curr = state({ marker: false, entries: {}, root: root(old('2026-10-15', 'newer'), old('2026-10-01')) });
    const r = checkConservation(prev, curr);
    assert.ok(kinds(r).includes('marker-removed'), 'the removal itself is the violation');
  });

  test('entries with NO marker are named, not read as "no entries"', () => {
    const curr = state({ marker: false, entries: { [entryPath(GOOD_NAME)]: GOOD_TEXT } });
    assert.deepEqual(kinds(checkConservation(state(), curr)), ['entries-without-marker']);
  });

  test('a foreign file in the entries directory is named', () => {
    const curr = marked({ strays: [`${ENTRIES_DIR}/notes.txt`] });
    assert.deepEqual(kinds(checkConservation(marked(), curr)), ['entry-stray']);
  });
});

describe('readLogHead', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'status-entries-'));
  const rm = (d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  const write = (dir, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };

  test('no entries directory: exactly the old status.md head, uncapped', () => {
    const d = tmp();
    try {
      write(d, 'status.md', root(old('2026-10-01')));
      assert.deepEqual(readLogHead(d), { text: root(old('2026-10-01')), absent: false, error: null, capped: false });
    } finally { rm(d); }
  });

  test('neither entries nor status.md: absent', () => {
    const d = tmp();
    try { assert.equal(readLogHead(d).absent, true); } finally { rm(d); }
  });

  test('entries newest-first, then status.md; the marker is never read as an entry', () => {
    const d = tmp();
    try {
      write(d, 'status.md', root(old('2026-10-01')));
      write(d, MARKER_REL, '# marker\n\n## 2099-01-01 — not an entry\n');
      write(d, entryPath('2026-10-15-100000-older.md'), '## 2026-10-15 — older\n\nbody\n');
      write(d, entryPath('2026-10-16-090000-newer.md'), '## 2026-10-16 — newer\n\nbody\n');
      const { text } = readLogHead(d);
      const order = [...text.matchAll(/^## (\S+) — (\S+)/gm)].map((m) => m[2]);
      assert.deepEqual(order, ['newer', 'older', 'old']);
      assert.ok(!text.includes('not an entry'));
      assert.deepEqual(listEntryFiles(d).map((p) => path.basename(p)), ['2026-10-16-090000-newer.md', '2026-10-15-100000-older.md']);
    } finally { rm(d); }
  });

  test('entries but no status.md still reads', () => {
    const d = tmp();
    try {
      write(d, entryPath('2026-10-16-090000-only.md'), '## 2026-10-16 — only\n\nbody\n');
      const r = readLogHead(d);
      assert.equal(r.absent, false);
      assert.match(r.text, /only/);
    } finally { rm(d); }
  });

  test('the cap is honest across both sources: capped is decided from sizes, not the string', () => {
    const d = tmp();
    try {
      write(d, 'status.md', 'x'.repeat(100));
      write(d, entryPath('2026-10-16-090000-big.md'), `## 2026-10-16 — big\n${'y'.repeat(80)}\n`);
      assert.equal(readLogHead(d, 10_000).capped, false, 'everything fits');
      const small = readLogHead(d, 60);
      assert.equal(small.capped, true, 'the entry alone exceeds the window');
      assert.ok(!small.text.includes('xxx'), 'status.md is not read once the window is spent');
      const exact = readLogHead(d, 100 + Buffer.byteLength(`## 2026-10-16 — big\n${'y'.repeat(80)}\n`));
      assert.equal(exact.capped, false, 'exactly the window is complete');
    } finally { rm(d); }
  });
});

describe('the writer instructions name the marker (a consumer without it keeps the old flow)', () => {
  const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

  test('/ship Step 2 and its format reference condition on the marker, not on the directory', () => {
    for (const rel of ['skills/ship/SKILL.md', 'skills/ship/references/status-md-format.md']) {
      assert.match(read(rel), /docs\/status\/entries\/README\.md/, `${rel} must name the marker`);
    }
    assert.match(read('skills/ship/references/status-md-format.md'), /Marker absent[^]*append to\s+`status\.md`/,
      'the marker-absent flow stays the documented default for a consumer');
  });
});

/**
 * @fileoverview Conservation law for the session log — pure logic.
 *
 * **The incident.** PR #87 replaced `status.md` with a single entry, deleting
 * 19,257 lines of history; PR #88 restored it (`3a17bbce`, 19,257 insertions,
 * 0 deletions). A partial Read followed by a whole-file Write did it, and it
 * reached `main` through a full `npm run check` and a pre-push run. **Nothing
 * in this repo asserts that the log does not shrink** — that is the gap.
 *
 * **Why identity, not counting.** An entry-count check is trivially defeated:
 * delete real entries, add the same number of invented ones, total unchanged.
 * So entries are compared by digest.
 *
 * **Why the digest covers the FULL SPAN, not the heading.** A heading-only
 * digest leaves every paragraph beneath a retained `## ` free to be deleted or
 * rewritten with the digest multiset unchanged — a quieter PR #87 that the
 * guard would wave through.
 *
 * **Why two laws, not one.** "No digest may disappear" would ban appending to
 * the current entry, because a full-span digest changes on every edit. That is
 * ordinary work — and this repo's own `/ship` appends a backlog line to the
 * entry it just wrote. So:
 *   - **archived** entries (frozen, in `docs/status/`) — exact digest identity;
 *   - **root** entries (live) — heading-presence plus append-only: a retained
 *     entry's new text must START WITH its old text.
 *
 * @module scripts/lib/status-log-integrity
 */

import crypto from 'node:crypto';

/** Heading form the rotation and the guard both key on. */
export const ENTRY_HEADING_RE = /^## (\d{4}-\d{2}-\d{2})\b/;

/** Normalise line endings so a CRLF checkout does not read as a rewrite. */
export function canonicalize(text) {
  return String(text ?? '').replace(/\r\n/g, '\n');
}

/**
 * Split a log body into entries: each `## ` heading through the byte before the
 * next `## ` (or end of file). Content above the first heading (the `# Project
 * Status Log` header) is returned separately as `preamble`.
 *
 * Undated headings are still returned as entries — the guard must protect them
 * even though the rotation refuses to move them.
 *
 * @param {string} text
 * @returns {{preamble: string, entries: Array<{heading: string, date: string|null, body: string, digest: string}>}}
 */
export function splitEntries(text) {
  const src = canonicalize(text);
  const lines = src.split('\n');
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^## /.test(lines[i])) starts.push(i);
  }
  const preamble = starts.length ? lines.slice(0, starts[0]).join('\n') : src;
  const entries = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const body = lines.slice(from, to).join('\n');
    const heading = lines[from];
    const m = heading.match(ENTRY_HEADING_RE);
    entries.push({
      heading,
      date: m ? m[1] : null,
      body,
      digest: crypto.createHash('sha256').update(body, 'utf8').digest('hex'),
    });
  }
  return { preamble, entries };
}

/** `YYYY-MM` taken verbatim from the heading — no Date parsing, no timezone. */
export function monthOf(entry) {
  return entry.date ? entry.date.slice(0, 7) : null;
}

/**
 * Whether `after` retains every non-empty line of `before`, in order.
 *
 * The law for a LIVE entry is *nothing is removed*, not *text may only be added
 * at the very end*. A real append lands inside the entry — above its trailing
 * `---` separator — so a literal `startsWith` check would reject the ordinary
 * case it is meant to allow, including `/ship`'s own Step 2b backlog line.
 *
 * A subsequence check permits insertion anywhere while still catching deletion
 * and rewriting, which is exactly the property worth guarding. Blank lines are
 * ignored so reflowing whitespace is not a violation.
 */
export function retainsEveryLine(before, after) {
  const want = canonicalize(before).split('\n').map((l) => l.trim()).filter(Boolean);
  const have = canonicalize(after).split('\n').map((l) => l.trim()).filter(Boolean);
  let i = 0;
  for (const line of have) {
    if (i < want.length && line === want[i]) i++;
  }
  return i === want.length;
}

/**
 * Compare a previous state to a current one.
 *
 * @param {object} prev - `{ root: string, archives: Record<path,string>, manifest: object|null }`
 * @param {object} curr - same shape
 * @returns {{ok: boolean, violations: Array<{kind: string, detail: string}>}}
 */
export function checkConservation(prev, curr) {
  const violations = [];
  const V = (kind, detail) => violations.push({ kind, detail });

  const prevRoot = splitEntries(prev.root || '');
  const currRoot = splitEntries(curr.root || '');

  // Every entry visible anywhere in the CURRENT tree, by digest and by heading.
  const currArchiveEntries = [];
  for (const [p, text] of Object.entries(curr.archives || {})) {
    for (const e of splitEntries(text).entries) currArchiveEntries.push({ ...e, path: p });
  }
  // MULTISETS, not sets. Duplicate headings are explicitly legal (two entries
  // may share a date), so a Set of digests plus a first-wins Map of headings
  // lets ONE surviving entry satisfy SEVERAL prior ones — delete a duplicate
  // and the check still passes. Conservation has to be one-to-one to mean
  // anything, so each match consumes its counterpart.
  const currDigestCounts = new Map();
  for (const e of [...currRoot.entries, ...currArchiveEntries]) {
    currDigestCounts.set(e.digest, (currDigestCounts.get(e.digest) || 0) + 1);
  }
  // An IMMUTABLE snapshot of what exists now, for the laws that ask "is this
  // still present anywhere" rather than "does it have its own survivor". Law 1
  // consumes from `currDigestCounts`; reusing that counter here would make an
  // archived entry read as mutated merely because a root entry matched it.
  const allCurrDigests = new Set(currDigestCounts.keys());
  const currDigests = { has: (d) => allCurrDigests.has(d) };
  /** Consume one occurrence of a digest; false when none remain unmatched. */
  const consumeDigest = (d) => {
    const n = currDigestCounts.get(d) || 0;
    if (n === 0) return false;
    currDigestCounts.set(d, n - 1);
    return true;
  };

  const currHeadingPool = new Map();
  for (const e of [...currRoot.entries, ...currArchiveEntries]) {
    if (!currHeadingPool.has(e.heading)) currHeadingPool.set(e.heading, []);
    currHeadingPool.get(e.heading).push(e);
  }
  /** Take one unmatched entry with this heading, or undefined. */
  const takeHeading = (h) => {
    const pool = currHeadingPool.get(h);
    return pool && pool.length ? pool.shift() : undefined;
  };

  // ── Law 1: root entries are append-only and never vanish ─────────────────
  for (const before of prevRoot.entries) {
    // Exact survivor first, consuming it — so N prior duplicates need N
    // survivors, not one shared between them.
    if (consumeDigest(before.digest)) {
      const pool = currHeadingPool.get(before.heading);
      if (pool) {
        const i = pool.findIndex((e) => e.digest === before.digest);
        if (i !== -1) pool.splice(i, 1);
      }
      continue;
    }
    const after = takeHeading(before.heading);
    if (!after) {
      V('entry-vanished', `entry "${before.heading}" was in the log and is now in neither the root nor any archive`);
      continue;
    }
    // Consume the matched entry's digest too. Taking it from the heading pool
    // alone left its digest available, so a LATER prior entry could match the
    // same survivor by digest — one entry satisfying two, which is the very
    // hole this loop was rewritten to close. Caught by the byte-identical
    // duplicate case, where consecutive equal entries differ only by a trailing
    // newline and so carry different digests.
    consumeDigest(after.digest);
    if (!retainsEveryLine(before.body, after.body)) {
      V('entry-rewritten', `entry "${before.heading}" lost or altered existing content`);
    }
  }

  // ── Law 2: archived entries are frozen ───────────────────────────────────
  // Multiset here too. A `Map<digest, path>` collapses byte-identical archived
  // entries to one record, so deleting one of two identical entries left the
  // survivor covering for it — the same multiplicity hole fixed above in Law 1,
  // missed on the first pass because the two loops keep separate bookkeeping.
  const prevArchiveCounts = new Map();
  const prevArchivePath = new Map();
  for (const [p, text] of Object.entries(prev.archives || {})) {
    for (const e of splitEntries(text).entries) {
      prevArchiveCounts.set(e.digest, (prevArchiveCounts.get(e.digest) || 0) + 1);
      if (!prevArchivePath.has(e.digest)) prevArchivePath.set(e.digest, p);
    }
  }
  const currTotalCounts = new Map();
  for (const e of [...currRoot.entries, ...currArchiveEntries]) {
    currTotalCounts.set(e.digest, (currTotalCounts.get(e.digest) || 0) + 1);
  }
  for (const [digest, needed] of prevArchiveCounts) {
    const have = currTotalCounts.get(digest) || 0;
    if (have < needed) {
      const p = prevArchivePath.get(digest);
      V('archive-mutated',
        `${needed} identical entr(ies) archived in ${p}, only ${have} still present anywhere`);
    }
  }

  // ── Law 2b: the root PREAMBLE is conserved ───────────────────────────────
  // Every law above is keyed on `## ` entries, so the content ABOVE the first
  // heading — the `# Project Status Log` title and any standing note — was
  // outside conservation entirely and could be deleted or rewritten freely.
  // It may GROW (a note added); it may not lose lines.
  if (!retainsEveryLine(prevRoot.preamble, currRoot.preamble)) {
    V('preamble-lost', 'content above the first entry heading was removed or rewritten');
  }

  // ── Law 3: the manifest itself is monotonic ──────────────────────────────
  // Without this, deleting an archive file AND its manifest record in one
  // commit passes both laws above: the root is unreduced and every REMAINING
  // archive still matches its REMAINING record.
  const prevRecords = (prev.manifest && prev.manifest.archives) || {};
  const currRecords = (curr.manifest && curr.manifest.archives) || {};
  for (const [month, rec] of Object.entries(prevRecords)) {
    const now = currRecords[month];
    if (!now) { V('manifest-shrank', `manifest no longer records archived month ${month}`); continue; }
    const before = rec.entryDigests || [];
    const after = now.entryDigests || [];
    for (const d of before) {
      if (!after.includes(d)) V('manifest-digest-dropped', `manifest for ${month} dropped an entry digest`);
    }
  }

  // ── Law 4: every manifest record matches the archive on disk ─────────────
  for (const [month, rec] of Object.entries(currRecords)) {
    const p = rec.path || `docs/status/${month}.md`;
    const text = (curr.archives || {})[p];
    if (text === undefined) { V('archive-missing', `manifest records ${month} but ${p} is absent`); continue; }
    const actual = splitEntries(text).entries.map((e) => e.digest);
    const expected = rec.entryDigests || [];
    if (actual.length !== expected.length || actual.some((d, i) => d !== expected[i])) {
      V('archive-digest-mismatch', `${p} does not match its manifest record (order or content)`);
    }
  }

  // ── Law 5: no archive without a manifest record ──────────────────────────
  // Law 4 walks manifest → disk. The reverse was unchecked, so an archive file
  // could be added (or an existing one renamed) with no record vouching for it,
  // and every other law would pass: the root is unreduced, the recorded
  // archives all match, and the manifest never shrank. An unvouched archive is
  // content nothing attests to — exactly what the manifest exists to prevent.
  const recordedPaths = new Set(Object.values(currRecords).map((r) => r.path).filter(Boolean));
  for (const p of Object.keys(curr.archives || {})) {
    if (p.endsWith('README.md')) continue; // the index, not an entry archive
    if (!recordedPaths.has(p)) {
      V('archive-unrecorded', `${p} exists but no manifest record vouches for it`);
    }
  }

  return { ok: violations.length === 0, violations };
}

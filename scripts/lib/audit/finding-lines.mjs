/**
 * @fileoverview Resolve a model-supplied verbatim `lineQuote` to `lineStart`/`lineEnd`
 * on an audit finding, so the T2 `reopenRate` signal (`round-signals.mjs`
 * `citedLocation`) has a line to read. Plan: docs/plans/structured-finding-lines.md.
 *
 * The model never counts lines (it is not shown line numbers — block-style annotation
 * and the plain R1 render carry no gutter). It copies ONE source line (up to three
 * consecutive lines) and CODE finds where that text sits in the file the audit saw.
 * That keeps the number verified (the 2026-07-26 `FindingBase` decision rejected a
 * self-reported line) and file-relative (never a diff-hunk number).
 *
 * Trust rules, each pinned by a test:
 *   - EXACT per-line match after one fold (CRLF to LF). No trimming: whitespace can be
 *     string-literal content, so a tolerant match could equate two different lines.
 *   - Unique match or null. Ambiguous and not-found are "unlocated", never a guess.
 *   - Only `_primaryFile` is searched, read through `safeReadFile` (containment after
 *     symlink resolution, sensitive-file refusal).
 *   - Snapshot contract: a line is valid for the signal only when the text read IS the
 *     audited commit's content (the signal maps lines through `auditedSha(N)`). A file
 *     whose working text differs from `git show <auditedSha>:<path>` is `dirty`, and a
 *     missing sha or blob is `no-basis`.
 *   - The resolver is the SOLE writer of `lineStart`/`lineEnd` for LLM-pass findings: it
 *     writes the pair together on `anchored` and clears both on every other status.
 *
 * `_hash`, topic ids and `section`/`detail` are never touched (`semanticId` hashes
 * category|section|detail only), so ledger suppression is unaffected.
 *
 * @module scripts/lib/audit/finding-lines
 */
import { execFileSync } from 'node:child_process';
import { safeReadFile } from '../audit-scope.mjs';

/** Max consecutive lines a quote may span (the schema's 400-char cap bounds the rest). */
export const MAX_QUOTE_LINES = 3;

export const LINE_STATUSES = Object.freeze(['anchored', 'no-quote', 'not-found', 'ambiguous', 'dirty', 'no-basis', 'no-file']);

const SHA_RE = /^[0-9a-f]{40,64}$/;
const fold = (s) => String(s).replace(/\r\n?/g, '\n');

/** `git show <sha>:<path>` as text, or null (unknown sha/blob, git failure). */
export function gitShowText(cwd, sha, relPath) {
  if (!SHA_RE.test(sha || '') || !relPath) return null;
  try {
    return execFileSync('git', ['show', `${sha}:${relPath.split('\\').join('/')}`], {
      cwd, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024,
    }).toString('utf8');
  } catch { return null; }
}

/**
 * Round-scoped snapshot reader: each distinct path is read and compared to its audited
 * blob ONCE and the verdict reused by every finding on that path. Lives for one run;
 * a new run builds a new reader, so nothing is shared across rounds.
 * @param {{cwd?: string, auditedSha?: string|null, showText?: (cwd:string, sha:string, rel:string)=>string|null}} [opts]
 * @returns {{read: (relPath: string) => {status: 'ok', lines: string[]} | {status: 'no-file'|'no-basis'|'dirty'}}}
 */
export function createSnapshotReader({ cwd = process.cwd(), auditedSha = null, showText = gitShowText } = {}) {
  const cache = new Map();
  return {
    read(relPath) {
      const key = String(relPath || '');
      if (cache.has(key)) return cache.get(key);
      let out;
      const file = key ? safeReadFile(key, cwd) : null;
      if (!file) out = { status: 'no-file' };
      else {
        const blob = auditedSha ? showText(cwd, auditedSha, key) : null;
        if (blob === null || blob === undefined) out = { status: 'no-basis' };
        else if (fold(blob) !== fold(file.content)) out = { status: 'dirty' };
        else out = { status: 'ok', lines: fold(file.content).split('\n') };
      }
      cache.set(key, out);
      return out;
    },
  };
}

/**
 * Find a verbatim quote in a file's lines. Exact match, consecutive lines, unique or null.
 * @param {string[]} fileLines
 * @param {string} quote
 * @returns {{status: 'anchored', lineStart: number, lineEnd: number} | {status: 'no-quote'|'not-found'|'ambiguous'}}
 */
export function locateQuote(fileLines, quote) {
  if (typeof quote !== 'string') return { status: 'no-quote' };
  const q = fold(quote).split('\n');
  while (q.length > 0 && q.at(-1) === '') q.pop(); // a trailing newline is not a line
  if (q.length === 0 || q.length > MAX_QUOTE_LINES || q.every((l) => l.trim() === '')) return { status: 'no-quote' };
  let first = -1; let count = 0;
  for (let i = 0; i + q.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < q.length; j++) if (fileLines[i + j] !== q[j]) { ok = false; break; }
    if (ok) { count++; if (first < 0) first = i; if (count > 1) break; }
  }
  if (count === 0) return { status: 'not-found' };
  if (count > 1) return { status: 'ambiguous' };
  return { status: 'anchored', lineStart: first + 1, lineEnd: first + q.length };
}

/**
 * Resolve one finding. Pure given the reader.
 * @returns {{status: string, lineStart: number|null, lineEnd: number|null}}
 */
export function resolveFindingLines(finding, reader) {
  const none = (status) => ({ status, lineStart: null, lineEnd: null });
  if (typeof finding?.lineQuote !== 'string' || finding.lineQuote.trim() === '') return none('no-quote');
  const file = finding._primaryFile;
  if (!file) return none('no-file');
  const snap = reader.read(file);
  if (snap.status !== 'ok') return none(snap.status);
  const hit = locateQuote(snap.lines, finding.lineQuote);
  return hit.status === 'anchored' ? { status: 'anchored', lineStart: hit.lineStart, lineEnd: hit.lineEnd } : none(hit.status);
}

/**
 * Registry entries whose findings do NOT come from a `ProducerFindingSchema` response, so
 * they can never carry `lineQuote` and are never asked for it. NOT `MECHANICAL_WAVES`:
 * that list is the paid shadow's exclusion set and contains `quickfix`, which IS an LLM
 * pass emitting `ProducerFindingSchema` findings.
 */
export const NON_PRODUCER_PASSES = Object.freeze(['duplication', 'adjacency', 'architecture', 'orphan-introduced', 'event-wiring-symmetry']);

/**
 * Display prefixes of the passes whose findings are model-authored against
 * `ProducerFindingSchema` (so they can carry `lineQuote`): every registry entry not in
 * `NON_PRODUCER_PASSES`.
 * @param {Array<{name: string, _displayPrefix: string}>} passRegistry
 * @returns {Set<string>}
 */
export function llmPassPrefixes(passRegistry) {
  return new Set((passRegistry || [])
    .filter((e) => !NON_PRODUCER_PASSES.includes(e.name))
    .map((e) => e._displayPrefix));
}

/**
 * Resolve every eligible finding in place and report coverage. Writes the pair together
 * on `anchored`; clears both otherwise. Ineligible findings (tool, mechanical) are untouched.
 * @returns {{total: number, counts: Record<string, number>, line: string}}
 */
export function applyLineResolution(findings, { llmPrefixes, reader }) {
  const counts = Object.fromEntries(LINE_STATUSES.map((s) => [s, 0]));
  let total = 0;
  for (const f of findings || []) {
    if (!llmPrefixes.has(f._pass)) continue;
    const r = resolveFindingLines(f, reader);
    f.lineStart = r.lineStart;
    f.lineEnd = r.lineEnd;
    counts[r.status]++; total++;
  }
  const line = `  [lines] ${total} findings: ${LINE_STATUSES.map((s) => `${s} ${counts[s]}`).join(', ')}\n`;
  return { total, counts, line };
}

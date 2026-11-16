/**
 * @fileoverview Memory → enforcement promotion (plan docs/plans/harness-retro.md
 * §2 components 8 and 13).
 *
 * `MEMORY.md` is the auto-memory index loaded every session: each tripwire is a
 * `[Title](file.md)` link, and one line may carry several. This module
 *   - parses the index into individual links (never whole lines),
 *   - scores each linked memory against the scan's fingerprint labels to find
 *     tripwires that FIRED (≥2 sessions) — promotion candidates,
 *   - retires an enforced tripwire: frontmatter `metadata.enforced_by`, and the
 *     index line moved to `index-enforced.md` ONLY when this memory is the line's
 *     sole link. A shared line is never rewritten (that would garble the other
 *     tripwires); it is reported `needs-manual-reflow`.
 * Every write is atomic and every step idempotent.
 *
 * @module scripts/lib/friction/retro/memory-tripwires
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { atomicWriteFileSync } from '../../file-io.mjs';
import { tokenise, containmentScore, COVERAGE_FLOOR } from './inventory.mjs';

export const INDEX_FILE = 'MEMORY.md';
export const ENFORCED_INDEX_FILE = 'index-enforced.md';
export const PROMOTION_MIN_SESSIONS = 2;
const LINK_RE = /\[([^\]]+)\]\(([^)\s]+\.md)\)/g;
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const ENFORCED_POINTER = `- [Enforced tripwires](${ENFORCED_INDEX_FILE}) — retired from this index once a check enforces them (harness-retro).`;

/** Every link in an index text, with its line number. Sub-indexes (`index-*.md`) are not tripwires. */
export function parseMemoryIndex(text) {
  const links = [];
  String(text ?? '').split(/\r?\n/).forEach((line, lineNo) => {
    for (const m of line.matchAll(LINK_RE)) {
      const file = m[2];
      if (/^index-/.test(path.basename(file))) continue;
      links.push({ title: m[1], file, lineNo });
    }
  });
  return links;
}

/** Absence (ENOENT) reads as `fb`; any OTHER failure throws — an unreadable index
 *  must never be treated as an empty one and then rewritten (audit H16). */
const readOr = (p, fb = '') => {
  try { return fs.readFileSync(p, 'utf8'); } catch (err) {
    if (err?.code === 'ENOENT') return fb;
    throw err;
  }
};

/** Frontmatter of a memory file (null when absent or unparseable). */
export function readFrontmatter(filePath) {
  const m = readOr(filePath).match(FM_RE);
  if (!m) return null;
  try { return { fm: yaml.parse(m[1]) ?? {}, body: m[2] }; } catch { return null; }
}

/**
 * Score each tripwire against the scan's fingerprints.
 * @param {{memoryDir: string, fingerprints: Record<string, {label: string}>,
 *          sessionsByFingerprint: Map<string, Set<string>>, occurrencesByFingerprint: Map<string, number>,
 *          idf: (t: string) => number}} opts
 */
export function scanTripwires({ memoryDir, fingerprints, sessionsByFingerprint, occurrencesByFingerprint, idf }) {
  const links = parseMemoryIndex(readOr(path.join(memoryDir, INDEX_FILE)));
  const seen = new Set();
  const out = [];
  const fpTokens = Object.entries(fingerprints).map(([fp, meta]) => [fp, tokenise(meta.label)]);
  for (const link of links) {
    const name = path.basename(link.file, '.md');
    if (seen.has(name)) continue;
    seen.add(name);
    const parsed = readFrontmatter(path.join(memoryDir, link.file));
    const description = String(parsed?.fm?.description ?? '');
    const enforced = Boolean(parsed?.fm?.metadata?.enforced_by);
    const memTokens = tokenise(`${link.title} ${name.replace(/[_-]/g, ' ')} ${description}`);
    const matched = [];
    for (const [fp, toks] of fpTokens) {
      // the LABEL is the short side; score how much of it the tripwire names
      if (toks.size && containmentScore(toks, memTokens, idf) >= COVERAGE_FLOOR) matched.push(fp);
    }
    const sessions = new Set();
    let occurrences = 0;
    for (const fp of matched) {
      for (const s of sessionsByFingerprint.get(fp) ?? []) sessions.add(s);
      occurrences += occurrencesByFingerprint.get(fp) ?? 0;
    }
    const status = enforced ? 'enforced'
      : matched.length === 0 ? 'no-evidence'
        : sessions.size >= PROMOTION_MIN_SESSIONS ? 'promotion-candidate' : 'fired-once';
    out.push({
      identity: `tripwire:${name}`, memory: name, title: link.title, status,
      firedSessions: sessions.size, occurrences, matchedFingerprints: matched.sort(),
    });
  }
  out.sort((a, b) => (b.firedSessions - a.firedSessions) || a.memory.localeCompare(b.memory));
  return out;
}

/** Idempotently set `metadata.enforced_by` in a memory file. */
export function markEnforced(filePath, enforcedBy) {
  const parsed = readFrontmatter(filePath);
  if (!parsed) throw new Error(`memory file has no parseable frontmatter: ${path.basename(filePath)}`);
  const { fm, body } = parsed;
  if (fm.metadata?.enforced_by) return { changed: false };
  fm.metadata = { ...(fm.metadata ?? {}), enforced_by: enforcedBy };
  atomicWriteFileSync(filePath, `---\n${yaml.stringify(fm).trimEnd()}\n---\n${body}`);
  return { changed: true };
}

/**
 * Retire a memory from the index. Pure text transform over the two index files.
 * @returns {{index: string, enforcedIndex: string, moved: number, needsManualReflow: number, alreadyRetired: boolean}}
 */
export function retireFromIndexText({ index, enforcedIndex, file }) {
  const lines = String(index ?? '').split('\n');
  const keep = [];
  const movedLines = [];
  let needsManualReflow = 0;
  for (const line of lines) {
    const links = [...line.matchAll(LINK_RE)].map((m) => m[2]);
    if (!links.includes(file)) { keep.push(line); continue; }
    const others = links.filter((l) => l !== file);
    if (others.length === 0) movedLines.push(line.replace(/\r$/, ''));
    else { needsManualReflow++; keep.push(line); }
  }
  let enf = String(enforcedIndex ?? '');
  if (!enf.trim()) enf = '# Enforced tripwires\n\nRetired from MEMORY.md because a check now enforces them. Files are kept.\n';
  const already = enf.includes(`(${file})`);
  for (const l of movedLines) if (!enf.includes(l)) enf = `${enf.replace(/\n*$/, '\n')}${l}\n`;
  if (!already && movedLines.length === 0) {
    enf = `${enf.replace(/\n*$/, '\n')}- [${path.basename(file, '.md')}](${file}) — enforced; its MEMORY.md line is shared (needs manual reflow).\n`;
  }
  let out = keep.join('\n');
  if (!out.includes(`(${ENFORCED_INDEX_FILE})`)) out = `${out.replace(/\n*$/, '\n')}${ENFORCED_POINTER}\n`;
  return {
    index: out, enforcedIndex: enf, moved: movedLines.length, needsManualReflow,
    alreadyRetired: movedLines.length === 0 && needsManualReflow === 0 && already,
  };
}

/** Apply {@link retireFromIndexText} to a memory dir (atomic writes; idempotent). */
export function retireFromIndex(memoryDir, file) {
  const indexPath = path.join(memoryDir, INDEX_FILE);
  const enfPath = path.join(memoryDir, ENFORCED_INDEX_FILE);
  const before = readOr(indexPath);
  const beforeEnf = readOr(enfPath);
  const r = retireFromIndexText({ index: before, enforcedIndex: beforeEnf, file });
  if (r.enforcedIndex !== beforeEnf) atomicWriteFileSync(enfPath, r.enforcedIndex);
  if (r.index !== before) atomicWriteFileSync(indexPath, r.index);
  return { moved: r.moved, needsManualReflow: r.needsManualReflow, alreadyRetired: r.alreadyRetired };
}

/**
 * Retirement consistency for `status`, checked in BOTH directions (audit H10/M7):
 * every memory carrying the `enforced_by` mark, and every entry of the enforced
 * index, must agree with `MEMORY.md`. Catches an interruption at any write boundary.
 */
export function retirementStatus(memoryDir) {
  const index = readOr(path.join(memoryDir, INDEX_FILE));
  const enf = readOr(path.join(memoryDir, ENFORCED_INDEX_FILE));
  const soleLinks = new Set();
  const sharedLinks = new Set();
  for (const line of index.split('\n')) {
    const links = [...line.matchAll(LINK_RE)].map((m) => m[2]);
    if (links.length === 1) soleLinks.add(links[0]);
    else for (const l of links) sharedLinks.add(l);
  }
  const inEnforced = new Set([...enf.matchAll(LINK_RE)].map((m) => m[2]));
  const marked = new Set();
  let names = [];
  try { names = fs.readdirSync(memoryDir); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
  for (const f of names) {
    if (!f.endsWith('.md') || f === INDEX_FILE || f === ENFORCED_INDEX_FILE) continue;
    if (readFrontmatter(path.join(memoryDir, f))?.fm?.metadata?.enforced_by) marked.add(f);
  }
  const problems = [];
  for (const file of [...new Set([...marked, ...inEnforced])].sort()) {
    if (inEnforced.has(file) && !marked.has(file)) problems.push({ memory: file, problem: 'listed-enforced-without-mark' });
    if (marked.has(file) && !inEnforced.has(file)) problems.push({ memory: file, problem: 'marked-but-not-in-enforced-index' });
    if (marked.has(file) && soleLinks.has(file)) problems.push({ memory: file, problem: 'still-in-index' });
    if (marked.has(file) && sharedLinks.has(file)) problems.push({ memory: file, problem: 'needs-manual-reflow' });
  }
  return problems;
}

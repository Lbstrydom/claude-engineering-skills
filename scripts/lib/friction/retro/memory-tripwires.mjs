/**
 * @fileoverview Memory → enforcement promotion (plan docs/plans/harness-retro.md
 * §2 components 8 and 13).
 *
 * `MEMORY.md` is the auto-memory index loaded every session: each tripwire is a
 * `[Title](file.md)` link, and one line may carry several. This module
 *   - parses the index into individual links (never whole lines),
 *   - scores each linked memory against the scan's fingerprint labels to find
 *     tripwires that FIRED (≥2 sessions) — promotion candidates,
 *   - v1 only LISTS them: retiring a tripwire from the index is a human edit
 *     (plan right-sizing gate, cut 3). This module never writes.
 *
 * @module scripts/lib/friction/retro/memory-tripwires
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { tokenise, containmentScore, COVERAGE_FLOOR } from './inventory.mjs';

export const INDEX_FILE = 'MEMORY.md';
export const PROMOTION_MIN_SESSIONS = 2;
const LINK_RE = /\[([^\]]+)\]\(([^)\s]+\.md)\)/g;
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

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

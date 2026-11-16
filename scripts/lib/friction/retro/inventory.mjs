/**
 * @fileoverview "Check what already exists before proposing" (plan
 * docs/plans/harness-retro.md §2 component 7).
 *
 * A token index over the existing harness surfaces — memory index + memory
 * descriptions, AGENTS.md, hook sources, `*:gate` npm scripts, skill SKILL.md
 * files — scored against a candidate's label by IDF-weighted CONTAINMENT (the
 * label is the short side). The result is a HINT for the judge, never a
 * suppressor: lexical overlap cannot see meaning.
 *
 * @module scripts/lib/friction/retro/inventory
 */
import fs from 'node:fs';
import path from 'node:path';

export const COVERAGE_FLOOR = 0.35;
const MAX_HITS = 3;
const STOP = new Set([
  'this', 'that', 'with', 'from', 'have', 'when', 'what', 'will', 'were', 'they', 'then', 'than', 'your',
  'into', 'only', 'also', 'must', 'never', 'does', 'each', 'here', 'there', 'their', 'which', 'while',
  'path', 'file', 'line', 'error', 'failed', 'tool', 'call', 'would', 'should', 'could', 'been', 'being',
]);

/** Distinct informative tokens of a text. */
export function tokenise(text) {
  const out = new Set();
  for (const t of String(text ?? '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) ?? []) {
    if (!STOP.has(t) && !/^\d+$/.test(t)) out.add(t);
  }
  return out;
}

/** Inverse document frequency over a list of token sets. */
export function buildIdf(docs) {
  const df = new Map();
  for (const d of docs) for (const t of d) df.set(t, (df.get(t) ?? 0) + 1);
  const n = Math.max(1, docs.length);
  return (t) => Math.log(1 + n / (1 + (df.get(t) ?? 0)));
}

/** Σ idf over shared tokens / Σ idf over the query's tokens. 0 for an empty query. */
export function containmentScore(queryTokens, docTokens, idf) {
  let num = 0; let den = 0;
  for (const t of queryTokens) { const w = idf(t); den += w; if (docTokens.has(t)) num += w; }
  return den === 0 ? 0 : num / den;
}

/** Max characters per indexed chunk. A whole 40 KB SKILL.md "contains" almost
 *  any label's tokens, so large surfaces are split into sections first
 *  (measured on the real corpus 2026-11-16: unchunked, every candidate hit a SKILL.md). */
const CHUNK_MAX = 1500;

/**
 * Split a document into ≤ CHUNK_MAX pieces at markdown headings, then blank
 * lines. Each chunk carries the nearest heading for its ref.
 */
export function chunkText(text) {
  const out = [];
  let heading = '';
  for (const section of String(text ?? '').split(/\n(?=#{1,4} )/)) {
    const h = section.match(/^#{1,4} (.+)$/m);
    if (h && section.startsWith('#')) heading = h[1].trim().slice(0, 60);
    let buf = '';
    for (const para of section.split(/\n\s*\n/)) {
      if (buf && buf.length + para.length > CHUNK_MAX) { out.push({ heading, text: buf }); buf = ''; }
      buf = buf ? `${buf}\n\n${para}` : para;
    }
    if (buf.trim()) out.push({ heading, text: buf });
  }
  return out;
}

/**
 * Collect the harness surfaces as `{surface, ref, text}` documents. Absence of a
 * surface is normal; a surface that EXISTS but cannot be read or parsed is
 * recorded in `errors` (audit M11) so the report can say the inventory is
 * incomplete instead of presenting a silent gap as "nothing covers this".
 * @param {{repoRoot: string, memoryDir?: string|null}} opts
 * @returns {{docs: Array<{surface: string, ref: string, text: string}>, errors: Array<{path: string, code: string}>}}
 */
export function collectHarnessDocs({ repoRoot, memoryDir = null }) {
  const docs = [];
  const errors = [];
  const readOr = (p) => {
    try { return fs.readFileSync(p, 'utf8'); } catch (err) {
      if (err?.code !== 'ENOENT') errors.push({ path: path.relative(repoRoot, p) || p, code: err?.code ?? 'EREAD' });
      return '';
    }
  };
  const listDir = (d) => {
    try { return fs.readdirSync(d); } catch (err) {
      if (err?.code !== 'ENOENT') errors.push({ path: path.relative(repoRoot, d) || d, code: err?.code ?? 'EREAD' });
      return [];
    }
  };
  const pushChunks = (surface, ref, text) => {
    for (const c of chunkText(text)) docs.push({ surface, ref: c.heading ? `${ref} § ${c.heading}` : ref, text: c.text });
  };
  if (memoryDir) {
    for (const line of readOr(path.join(memoryDir, 'MEMORY.md')).split(/\r?\n/)) {
      if (line.trim().startsWith('-')) docs.push({ surface: 'memory-index', ref: line.trim().slice(0, 120), text: line });
    }
    for (const f of listDir(memoryDir)) {
      if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
      const head = readOr(path.join(memoryDir, f)).slice(0, 1500);
      const desc = head.match(/^description:\s*(.+)$/m)?.[1] ?? '';
      docs.push({ surface: 'memory', ref: f, text: `${f.replace(/[_-]/g, ' ')} ${desc}` });
    }
  }
  pushChunks('agents-md', 'AGENTS.md', readOr(path.join(repoRoot, 'AGENTS.md')));
  const hooksDir = path.join(repoRoot, '.claude', 'hooks');
  for (const f of listDir(hooksDir)) pushChunks('hook', `.claude/hooks/${f}`, readOr(path.join(hooksDir, f)));
  const pkgText = readOr(path.join(repoRoot, 'package.json'));
  let scripts = {};
  if (pkgText) {
    try { scripts = JSON.parse(pkgText).scripts ?? {}; } catch { errors.push({ path: 'package.json', code: 'EPARSE' }); }
  }
  for (const [name, cmd] of Object.entries(scripts)) {
    if (name.endsWith(':gate')) docs.push({ surface: 'gate', ref: `npm run ${name}`, text: `${name.replace(/[:_-]/g, ' ')} ${cmd}` });
  }
  const skillsDir = path.join(repoRoot, 'skills');
  for (const s of listDir(skillsDir)) {
    const t = readOr(path.join(skillsDir, s, 'SKILL.md'));
    if (t) pushChunks('skill', `skills/${s}/SKILL.md`, t);
  }
  return { docs, errors };
}

/**
 * Index the docs; `coverageFor(label)` returns the best surfaces above the floor.
 * @param {Array<{surface: string, ref: string, text: string}>} docs
 */
export function buildHarnessInventory(docs) {
  const indexed = docs.map((d) => ({ surface: d.surface, ref: d.ref, tokens: tokenise(d.text) }));
  const idf = buildIdf(indexed.map((d) => d.tokens));
  function coverageFor(label, { floor = COVERAGE_FLOOR } = {}) {
    const q = tokenise(label);
    if (q.size === 0) return [];
    return indexed
      .map((d) => ({ surface: d.surface, ref: d.ref, score: Math.round(containmentScore(q, d.tokens, idf) * 100) / 100 }))
      .filter((h) => h.score >= floor)
      .sort((a, b) => (b.score - a.score) || a.ref.localeCompare(b.ref))
      .slice(0, MAX_HITS);
  }
  return { coverageFor, idf, size: indexed.length };
}

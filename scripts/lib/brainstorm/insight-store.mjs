/**
 * @fileoverview Save/load brainstorm insights — gitignored, per-topic.
 * Plan: docs/plans/brainstorm-quickfix-v1.md §10.A, §11.H, §12.G, §14.B, §14.D.
 *
 * Storage: `.brainstorm/insights/<topic-slug>/<timestamp>-<hash>.md`
 * Format:  YAML frontmatter (via `yaml` lib — no string interpolation) + body.
 *
 * Slug allocation:
 *   - First save for a topic → slugifyTopic(topic) (pure)
 *   - Collision (different topic, same slug base) → resolveUniqueSlug appends -2, -3...
 *   - Subsequent saves for the SAME exact topic → findExistingSlugForTopic finds
 *     and reuses the previously-allocated slug (matches by frontmatter `topic` field).
 *
 * Idempotency: same (sid, round, insightText) → no new file written, return existing path.
 *
 * @module scripts/lib/brainstorm/insight-store
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import yaml from 'yaml';
import { atomicWriteFileSync } from '../file-io.mjs';
import { InsightFrontmatterSchema } from './schemas.mjs';
import { withFileLock } from './file-lock.mjs';
import { validateSid } from './id-validator.mjs';
import { ensureDir } from '../cli-io.mjs';

const INSIGHTS_DIR_DEFAULT = '.brainstorm/insights';
const MAX_INSIGHT_CHARS = 2000;
const MAX_TOPIC_CHARS = 200;
const MAX_SLUG_LEN = 60;
const MAX_SLUG_COLLISIONS = 1000;

function rootDir(rootOverride = null) {
  return rootOverride ?? INSIGHTS_DIR_DEFAULT;
}


function shortHash(...parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

function tsStamp() {
  // YYYYMMDD-HHMMSS in UTC
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/**
 * Pure deterministic slug from a topic string. Same input always
 * returns same output (no FS lookup, no collision-resolution).
 *
 * @param {string} topic
 * @returns {string}
 */
export function slugifyTopic(topic) {
  return String(topic || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LEN) || 'untitled';
}

/**
 * Filesystem-aware allocator — appends `-2`, `-3`, ... to baseSlug if a
 * directory with that slug already exists. Used ONLY when no existing
 * slug for the topic could be found (see findExistingSlugForTopic).
 *
 * @param {string} baseSlug
 * @param {string} insightsRootDir
 * @returns {string}
 */
export function resolveUniqueSlug(baseSlug, insightsRootDir) {
  if (!fs.existsSync(insightsRootDir)) return baseSlug;
  let slug = baseSlug;
  let n = 2;
  while (fs.existsSync(path.join(insightsRootDir, slug))) {
    slug = `${baseSlug}-${n++}`;
    if (n > MAX_SLUG_COLLISIONS) {
      throw new Error(`slug collision storm: ${MAX_SLUG_COLLISIONS} variants of ${baseSlug} all exist`);
    }
  }
  return slug;
}

/**
 * Scan existing insight directories for one whose frontmatter `topic`
 * field exactly matches the input topic. Used to reuse a previously-
 * allocated collision slug for repeated saves of the same topic.
 *
 * Plan §14.B — null-safe on `.find()` (no .md file in candidate dir).
 *
 * @param {string} topic
 * @param {string} insightsRootDir
 * @returns {string|null}
 */
export function findExistingSlugForTopic(topic, insightsRootDir) {
  if (!fs.existsSync(insightsRootDir)) return null;
  const baseSlug = slugifyTopic(topic);
  for (let n = 1; n <= MAX_SLUG_COLLISIONS; n++) {
    const slug = n === 1 ? baseSlug : `${baseSlug}-${n}`;
    const dirPath = path.join(insightsRootDir, slug);
    if (!fs.existsSync(dirPath)) return null;  // first non-existent → no more candidates
    let files;
    try { files = fs.readdirSync(dirPath); } catch { continue; }
    const mdFile = files.find(f => f.endsWith('.md'));
    if (!mdFile) continue;
    const sample = path.join(dirPath, mdFile);
    let content;
    try { content = fs.readFileSync(sample, 'utf-8'); } catch { continue; }
    const fm = parseFrontmatter(content);
    if (fm?.topic === topic) return slug;
  }
  return null;
}

/**
 * Parse `--- yaml ---\nbody` markdown into { ...frontmatter, body }.
 * Returns null on parse failure (don't throw — caller may want fallback).
 *
 * @param {string} content
 * @returns {object|null}
 */
export function parseFrontmatter(content) {
  const m = String(content || '').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  try {
    const fm = yaml.parse(m[1]);
    return { ...fm, body: m[2] };
  } catch { return null; }
}

/**
 * Build the markdown content with safe YAML frontmatter (no string
 * interpolation — yaml.stringify handles escaping per plan §14.D).
 */
function buildInsightFile({ sid, round, topic, topicSlug, insightText, tags = [] }) {
  const fm = {
    sid, round, topic, topicSlug,
    capturedAt: new Date().toISOString(),
    ...(tags.length > 0 ? { tags } : {}),
  };
  const validation = InsightFrontmatterSchema.safeParse(fm);
  if (!validation.success) {
    const err = new Error('insight frontmatter failed schema validation');
    err.code = 'SCHEMA_INVALID';
    err.issues = validation.error.issues;
    throw err;
  }
  const fmYaml = yaml.stringify(validation.data).trimEnd();
  return `---\n${fmYaml}\n---\n${insightText}\n`;
}

/**
 * Save an insight to disk. Idempotent: identical (sid, round, insightText)
 * yields no new file (returns existing path).
 *
 * @param {{sid: string, round: number, topic: string, insightText: string, tags?: string[], root?: string}} args
 * @returns {{path: string, slugUsed: string, created: boolean}}
 */
export async function saveInsight({ sid, round, topic, insightText, tags = [], root = null }) {
  validateSid(sid, 'saveInsight.sid');
  if (typeof round !== 'number' || !Number.isInteger(round) || round < 0) {
    throw new Error('saveInsight: round must be non-negative integer');
  }
  if (!topic || topic.length === 0 || topic.length > MAX_TOPIC_CHARS) {
    throw new Error(`saveInsight: topic must be 1..${MAX_TOPIC_CHARS} chars`);
  }
  if (!insightText || insightText.length === 0 || insightText.length > MAX_INSIGHT_CHARS) {
    throw new Error(`saveInsight: insightText must be 1..${MAX_INSIGHT_CHARS} chars`);
  }

  const insightsRoot = rootDir(root);
  ensureDir(insightsRoot);

  // Audit R1-H15: serialise slug allocation per insightsRoot under a
  // shared lock. Two concurrent first-time saves for topics that
  // normalise to the same base slug used to race; now they queue on
  // the same lock and resolve collisions deterministically.
  const allocLockPath = path.join(insightsRoot, '.alloc.lock');
  return await withFileLock(allocLockPath, { maxWaitMs: 5000 }, () => {
    // 1. Resolve slug — reuse existing slug for this exact topic, else allocate new
    let slug = findExistingSlugForTopic(topic, insightsRoot);
    if (slug === null) {
      slug = resolveUniqueSlug(slugifyTopic(topic), insightsRoot);
    }
    const slugDir = path.join(insightsRoot, slug);
    ensureDir(slugDir);

    // 2. Idempotency check — same (sid, round, insightText) hash means same content
    const contentHash = shortHash(sid, String(round), insightText);
    const existing = fs.readdirSync(slugDir).find(f => f.endsWith(`-${contentHash}.md`));
    if (existing) {
      return { path: path.join(slugDir, existing), slugUsed: slug, created: false };
    }

    // 3. Build + write atomically
    const filename = `${tsStamp()}-${contentHash}.md`;
    const filepath = path.join(slugDir, filename);
    const fileContent = buildInsightFile({ sid, round, topic, topicSlug: slug, insightText, tags });
    atomicWriteFileSync(filepath, fileContent);
    return { path: filepath, slugUsed: slug, created: true };
  });
}

/**
 * List insights for a topic. Audit R1-H10/M10: when a topic IS supplied
 * but no slug exists for it, return [] (NOT all topics). Use
 * listAllInsights() for the full-discovery semantic.
 *
 * @param {string} topic
 * @param {{root?: string}} [opts]
 * @returns {Array<{path: string, mtime: Date, frontmatter: object|null}>}
 */
export function listInsightsByTopic(topic, { root = null } = {}) {
  if (!topic || typeof topic !== 'string') {
    throw new Error('listInsightsByTopic: topic required (use listAllInsights() for the full scan)');
  }
  const insightsRoot = rootDir(root);
  if (!fs.existsSync(insightsRoot)) return [];
  const slug = findExistingSlugForTopic(topic, insightsRoot);
  if (slug === null) return [];   // R1-H10: scoped query stays scoped
  return readInsightsFromDirs(insightsRoot, [slug]);
}

/**
 * Discover ALL insights across all topic slugs. Distinct API from
 * listInsightsByTopic so caller intent is explicit (Audit R1-H10/M10).
 *
 * @param {{root?: string}} [opts]
 * @returns {Array<{path: string, mtime: Date, frontmatter: object|null}>}
 */
export function listAllInsights({ root = null } = {}) {
  const insightsRoot = rootDir(root);
  if (!fs.existsSync(insightsRoot)) return [];
  let dirs;
  try {
    dirs = fs.readdirSync(insightsRoot).filter(d => {
      if (d.startsWith('.')) return false;  // skip dotfiles like .alloc.lock
      try { return fs.statSync(path.join(insightsRoot, d)).isDirectory(); }
      catch { return false; }
    });
  } catch { return []; }
  return readInsightsFromDirs(insightsRoot, dirs);
}

function readInsightsFromDirs(insightsRoot, dirs) {
  const out = [];
  for (const d of dirs) {
    const dirPath = path.join(insightsRoot, d);
    let files;
    try { files = fs.readdirSync(dirPath); }
    catch (err) {
      // Audit R1-M14: distinguish ENOENT (expected absence) from real I/O failures
      if (err.code !== 'ENOENT') {
        process.stderr.write(`  [insight-store] WARN: cannot list ${dirPath}: ${err.code || err.message}\n`);
      }
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const filepath = path.join(dirPath, f);
      // Audit R1-L2: per-entry try/catch — file vanished between readdir
      // and stat/read should skip cleanly, not abort the whole listing
      try {
        const stat = fs.statSync(filepath);
        const content = fs.readFileSync(filepath, 'utf-8');
        out.push({ path: filepath, mtime: stat.mtime, frontmatter: parseFrontmatter(content) });
      } catch (err) {
        if (err.code !== 'ENOENT') {
          process.stderr.write(`  [insight-store] WARN: skipping ${filepath}: ${err.code || err.message}\n`);
        }
      }
    }
  }
  return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

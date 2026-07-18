/**
 * @fileoverview The harness-memory path resolver + friction-frontmatter parser — the single
 * source for the path coupling (plan docs/plans/friction-feedback-loop.md, C1/C4). Reads the
 * harness auto-memory (`~/.claude/projects/<slug>/memory/`); never writes here (capture is
 * `quality add`). Pure parse — redaction happens at the egress boundaries (store DB-write +
 * commands breadcrumb/output), not here, so the parser stays a deterministic function of bytes.
 *
 * @module scripts/lib/memory-paths
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import yaml from 'yaml';
import { z } from 'zod';
import { frictionConfig } from './config.mjs';

const MitigationRefSchema = z.object({
  kind: z.enum(['commit', 'agents_rule', 'doc', 'test', 'durable_memory', 'ignore']),
  ref: z.string().min(1),
}).strict();

/** C1 friction-memory frontmatter contract (versioned). `metadata` is permissive (node_type etc.)
 *  but `type: friction` + the `friction` block are required + validated. */
export const FrictionFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  metadata: z.object({
    type: z.literal('friction'),
    schema_version: z.number().int().min(1).max(1).default(1),
    friction: z.object({
      cost: z.enum(['S', 'M', 'L']).default('M'),
      scope_tags: z.array(z.string().min(1)).min(1),
      files: z.array(z.string()).default([]),
      symbols: z.array(z.string()).default([]),
      mitigation_refs: z.array(MitigationRefSchema).default([]),
    }),
  }).passthrough(),
}).passthrough();

/** Harness project slug — VERIFIED: `C:\GIT\claude-engineering-skills` → `c--GIT-claude-engineering-skills`
 *  (lowercase the drive letter, then each non-alphanumeric char → a single `-`, per-char not per-run). */
export function harnessProjectSlug(absRoot) {
  return String(absRoot)
    .replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}:`)
    .replace(/[^A-Za-z0-9]/g, '-');
}

const dirExists = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };

/** Resolve the harness memory dir (C4 precedence): FRICTION_MEMORY_DIR → slug-derived → absent.
 *  Never throws; absent/unreadable → `{dir, exists:false}` (every caller treats as a graceful no-op). */
export function resolveHarnessMemoryDir({ repoRoot = process.cwd(), env = process.env } = {}) {
  if (env.FRICTION_MEMORY_DIR) {
    const dir = env.FRICTION_MEMORY_DIR;
    return { dir, exists: dirExists(dir), source: 'env' };
  }
  const slug = harnessProjectSlug(path.resolve(repoRoot));
  const dir = path.join(os.homedir(), '.claude', 'projects', slug, 'memory');
  return { dir, exists: dirExists(dir), source: 'derived' };
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
const lower = (s) => String(s || '').toLowerCase();

/** Build a mirror row from validated frontmatter + the raw file content. RAW (no redaction — the
 *  store redacts at the DB-egress boundary). `source_hash` = file bytes; `fingerprint` = normalized
 *  title+tags; `trgm_text` (recurrence) = title+body+tags; `signature_text` (injection) = title+tags. */
function buildRow(fm, content) {
  const f = fm.metadata.friction;
  const tags = [...f.scope_tags];
  const bodyExcerpt = (fm.body || '').slice(0, frictionConfig.bodyExcerptMaxChars);
  const tagStr = tags.join(' ');
  const fingerprint = crypto.createHash('sha256')
    .update(`${lower(fm.description).trim()}|${[...tags].sort().join(',')}`)
    .digest('hex').slice(0, 16);
  return {
    memory_name: fm.name,
    source_hash: crypto.createHash('sha256').update(content).digest('hex'),
    title: fm.description,
    body_excerpt: bodyExcerpt,
    scope_tags: tags,
    files: f.files,
    symbols: f.symbols,
    cost: f.cost,
    fingerprint,
    trgm_text: lower(`${fm.description} ${bodyExcerpt} ${tagStr}`),
    signature_text: lower(`${fm.description} ${tagStr}`),
    mitigation_refs: f.mitigation_refs,
  };
}

/**
 * Scan a memory dir for `type: friction` files. Returns the C5 contract:
 *   `{scanComplete, observedNames, validRows, skipped}`.
 * `scanComplete:false` (dir/read error mid-pass) → the caller MUST NOT tombstone. A
 * `type:friction`-but-schema-invalid file is `observed` (so it's not tombstoned) AND `skipped` (its
 * row is left untouched). Never follows symlinks.
 */
export function parseFrictionMemories(dir) {
  const observedNames = [];
  const validRows = [];
  const skipped = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return { scanComplete: false, observedNames, validRows, skipped }; }

  let scanComplete = true;
  for (const e of entries) {
    if (e.isSymbolicLink()) { skipped.push({ name: e.name, reason: 'symlink-refused' }); continue; }
    if (!e.isFile() || !e.name.endsWith('.md') || e.name === 'MEMORY.md') continue;
    const abs = path.join(dir, e.name);
    let content;
    try { content = fs.readFileSync(abs, 'utf8'); }
    catch { scanComplete = false; skipped.push({ name: e.name, reason: 'read-error' }); continue; }

    const m = content.match(FM_RE);
    if (!m) continue;                                  // no frontmatter → not a memory file
    let fm;
    try { fm = { ...yaml.parse(m[1]), body: m[2] }; }
    catch { continue; }                                // unparseable YAML → not our concern
    if (fm?.metadata?.type !== 'friction') continue;   // only friction files

    const name = (typeof fm.name === 'string' && fm.name) ? fm.name : e.name.replace(/\.md$/, '');
    observedNames.push(name);                          // observed (valid or not) → not tombstoned
    const parsed = FrictionFrontmatterSchema.safeParse(fm);
    if (!parsed.success) {
      skipped.push({ name, reason: 'schema-invalid', issue: parsed.error.issues[0]?.message });
      continue;
    }
    validRows.push(buildRow({ ...parsed.data, body: fm.body }, content));
  }
  return { scanComplete, observedNames, validRows, skipped };
}

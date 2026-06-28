/**
 * @fileoverview The `quality` friction-feedback command implementations + the
 * single named egress choke-point. Plan: docs/completed/friction-feedback-loop.md
 * (C0–C10, §2b). Keeps `cross-skill.mjs` a thin dispatcher (R1-MED) — every
 * command here returns a plain C8 JSON shape (`{ok, cloud, …, warnings?}`) and is
 * unit-testable without the CLI shell (deps are injectable).
 *
 * Memory file is the source of truth; the DB row is a derived mirror. `add`/`link`
 * are LOCAL-FIRST (write the memory file even cloud-off; the DB catches up on the
 * next `mirror`). `mirror` is reconciliation gated on a COMPLETE scan (C5).
 *
 * §2b egress invariant: `sanitizeFrictionQueryInput()` is THE boundary — every
 * field that reaches the DB, the breadcrumb, or a rendered callout passes through
 * it first. It wraps `preWriteSecretGate` (REFUSE high-confidence secret shapes,
 * auto-redact low-confidence PII), mirroring the `security:refresh` posture. The
 * store re-redacts at the DB write as defense-in-depth.
 *
 * @module scripts/lib/friction/commands
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';

import { atomicWriteFileSync } from '../file-io.mjs';
import { withFileLock } from '../brainstorm/file-lock.mjs';
import { frictionConfig } from '../config.mjs';
import { preWriteSecretGate } from '../security/secret-classifier.mjs';
import { redactSecrets } from '../secret-patterns.mjs';
import { classifyPath } from '../sensitive-paths.mjs';
import {
  resolveHarnessMemoryDir,
  parseFrictionMemories,
  FrictionFrontmatterSchema,
} from '../memory-paths.mjs';
import {
  upsertFrictionRow,
  reconcileTombstones,
  appendMitigationRef,
  listFrictionSourceHashes,
  getFrictionRecurrence,
  getFrictionNeighbourhood as storeFrictionNeighbourhood,
} from '../store/friction.mjs';
import { isCloudEnabled, resolveRepoForStore, getRepoIdByUuid } from '../store/repo.mjs';
import { resolveRepoIdentity } from '../repo-identity.mjs';
import { appendInjected, readRecent } from './breadcrumb.mjs';

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
const redactText = (s) => (typeof s === 'string' ? redactSecrets(s).text : s);

/** Default real dependency set; tests override any subset. */
function resolveDeps(overrides = {}) {
  return {
    resolveHarnessMemoryDir,
    parseFrictionMemories,
    isCloudEnabled,
    resolveRepoForStore,
    getRepoIdByUuid,
    resolveRepoIdentity,
    upsertFrictionRow,
    reconcileTombstones,
    appendMitigationRef,
    listFrictionSourceHashes,
    getFrictionRecurrence,
    storeFrictionNeighbourhood,
    appendInjected,
    readRecent,
    ...overrides,
  };
}

// ── §2b — the single egress choke-point ─────────────────────────────────────

/** Free-text scalar fields that egress (DB / breadcrumb / callout). */
const PROSE_FIELDS = ['title', 'body_excerpt', 'trgm_text', 'signature_text'];
/** Genuine text[] fields whose ELEMENTS are free text. */
const TEXT_ARRAY_FIELDS = ['scope_tags', 'symbols'];
/** Identifier/hash fields: shape-redacted, never refused, never traversed. */
const ID_FIELDS = ['memory_name', 'source_hash', 'fingerprint'];
/** Passed-through structural fields (no free text). */
const PASSTHROUGH_FIELDS = ['cost'];
/** The COMPLETE allowlist of fields that may leave the choke-point (H9). Any
 *  field not named here is DROPPED — sanitize is allowlist-based, not copy-and-
 *  mutate, so a future buildRow field can't silently bypass the gate. */
const EGRESS_ALLOWLIST = new Set([
  ...PROSE_FIELDS, ...TEXT_ARRAY_FIELDS, ...ID_FIELDS, ...PASSTHROUGH_FIELDS, 'files', 'mitigation_refs',
]);

/**
 * THE friction egress boundary (§2b). Runs every free-text field through
 * `preWriteSecretGate`: a high-confidence secret REFUSES the whole row (counted),
 * low-confidence PII is auto-redacted, and a final shape-redact pass catches
 * leftovers. `files` additionally drop any path classifying as sensitive.
 * `memory_name`/`source_hash`/`fingerprint`/`cost` are identifiers/hashes —
 * shape-redacted (never refused) so an id can't carry a token but a normal slug
 * is untouched.
 *
 * @param {object} row - a friction mirror row (memory-paths buildRow shape)
 * @returns {{ok: boolean, kind: 'clean'|'redacted'|'refused', sanitized?: object,
 *            refusedFields?: string[], warnings: string[],
 *            events: Array<{event_kind: string, detail: object}>}}
 */
export function sanitizeFrictionQueryInput(row) {
  const warnings = [];
  const events = [];
  const refusedFields = [];
  const src = row || {};
  // H9: allowlist-based — start EMPTY, copy only approved fields. An unlisted
  // field (now or future) never reaches the DB / breadcrumb / callout.
  const out = {};
  for (const k of Object.keys(src)) {
    if (EGRESS_ALLOWLIST.has(k)) out[k] = src[k];
  }

  // gate() returns the safe value, or pushes a refusal and returns the original.
  const gate = (val, field) => {
    if (typeof val !== 'string' || val === '') return val;
    const r = preWriteSecretGate(val);
    if (!r.ok) {
      refusedFields.push(field);
      events.push(...(r.events || []));
      return val;
    }
    if (r.kind === 'redacted') {
      warnings.push(`${field}: ${r.warning}`);
      events.push(...(r.events || []));
    }
    return r.content;
  };

  for (const f of PROSE_FIELDS) {
    if (f in out) out[f] = gate(out[f], f);
  }
  for (const f of TEXT_ARRAY_FIELDS) {
    if (Array.isArray(out[f])) out[f] = out[f].map((v, i) => gate(v, `${f}[${i}]`));
  }
  // files: drop sensitive paths first (defense-in-depth), then gate each element.
  if (Array.isArray(out.files)) {
    out.files = out.files
      .filter((p) => typeof p === 'string' && classifyPath(p) !== 'sensitive')
      .map((v, i) => gate(v, `files[${i}]`));
  }
  // mitigation_refs[].ref is free text (a doc path / string can carry a secret).
  if (Array.isArray(out.mitigation_refs)) {
    out.mitigation_refs = out.mitigation_refs.map((m, i) => ({
      ...m,
      ref: gate(m?.ref, `mitigation_refs[${i}].ref`),
    }));
  }
  // identifiers: shape-redact only, never refuse.
  for (const f of ['memory_name', 'source_hash', 'fingerprint']) {
    if (typeof out[f] === 'string') out[f] = redactText(out[f]);
  }

  if (refusedFields.length > 0) {
    return { ok: false, kind: 'refused', refusedFields, warnings, events };
  }
  return { ok: true, kind: warnings.length ? 'redacted' : 'clean', sanitized: out, warnings, events };
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** A friction memory_name MUST be a safe single-segment slug — no path
 *  separators / traversal / control chars. Guards `${name}.md` + path.join
 *  against directory traversal (H3/H7). Generated slugs already satisfy this;
 *  an explicit `--name`/`--memory` is validated against the SAME rule. */
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
export function isSafeMemoryName(name) {
  return typeof name === 'string' && SAFE_NAME_RE.test(name);
}

/** kebab-slug a title into a stable memory_name (prefixed `friction-`). */
export function slugifyTitle(title) {
  const base = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return base ? `friction-${base}` : 'friction-note';
}

/** Resolve the storage repo_id for a WRITE (mints/finds the canonical row). */
async function resolveWriteRepoId(d) {
  const ref = await d.resolveRepoForStore({}).catch(() => null);
  return ref?.repoRowId ?? null;
}

/** Resolve the storage repo_id for a repo-scoped READ (no minting). */
async function resolveReadRepoId(d, repoRoot) {
  const { repoUuid } = d.resolveRepoIdentity(repoRoot || process.cwd());
  const repo = await d.getRepoIdByUuid(repoUuid).catch(() => null);
  return repo?.id ?? null;
}

/** Best-effort mirror of ONE row (used by add/link). Sanitizes then upserts. */
async function mirrorOneRow(d, repoId, row) {
  const san = sanitizeFrictionQueryInput(row);
  if (!san.ok) {
    return { mirrored: false, refused: true,
      warnings: [...san.warnings, `mirror refused — high-confidence secret in: ${(san.refusedFields || []).join(', ')} (memory file kept locally; DB row withheld)`] };
  }
  try {
    await d.upsertFrictionRow(repoId, san.sanitized);
    return { mirrored: true, refused: false, warnings: san.warnings };
  } catch (err) {
    return { mirrored: false, refused: false, warnings: [...san.warnings, `mirror failed: ${err.message}`] };
  }
}

/** Build a C1-schema friction memory file body (frontmatter + prose). */
function buildMemoryFileContent({ name, title, cost, scopeTags, files, symbols, body }) {
  const fm = {
    name,
    description: title,
    metadata: {
      node_type: 'memory',
      type: 'friction',
      schema_version: 1,
      friction: {
        cost,
        scope_tags: scopeTags,
        files,
        symbols,
        mitigation_refs: [],
      },
    },
  };
  const yamlStr = yaml.stringify(fm).trimEnd();
  const prose = (body || title).trim();
  return `---\n${yamlStr}\n---\n\n${prose}\n`;
}

/** Append a one-line pointer to MEMORY.md if not already present (best-effort). */
function updateMemoryIndex(dir, fileName, title) {
  const indexPath = path.join(dir, 'MEMORY.md');
  let raw = '';
  try { raw = fs.readFileSync(indexPath, 'utf8'); } catch { raw = ''; }
  if (raw.includes(`(${fileName})`)) return false;     // pointer already present
  // L1: neutralise markdown-link/control chars in the title so a crafted title
  // can't corrupt MEMORY.md or forge a misleading entry.
  const safeTitle = String(title).replace(/[\r\n]+/g, ' ').replace(/[\[\]()]/g, ' ').trim();
  const line = `- [${safeTitle}](${fileName}) — friction`;
  const next = raw.trimEnd() ? `${raw.trimEnd()}\n${line}\n` : `${line}\n`;
  atomicWriteFileSync(indexPath, next);
  return true;
}

// ── quality add (C0) ─────────────────────────────────────────────────────────

/**
 * Capture a friction note: write a C1 `type:friction` memory file (the SoT) +
 * MEMORY.md pointer, THEN best-effort mirror the one row. Cloud-off still writes
 * the file. Idempotent on `name` (re-add overwrites the file + re-mirrors).
 *
 * @param {{title: string, scopeTags: string[], cost?: string, name?: string,
 *          files?: string[], symbols?: string[], body?: string, repoRoot?: string}} args
 */
export async function frictionAdd(args = {}, deps = {}) {
  const d = resolveDeps(deps);
  const title = String(args.title || '').trim();
  const scopeTags = (args.scopeTags || []).map((s) => String(s).trim()).filter(Boolean);
  if (!title) return { ok: false, cloud: false, error: { code: 'BAD_INPUT', message: 'title is required' } };
  if (scopeTags.length === 0) return { ok: false, cloud: false, error: { code: 'BAD_INPUT', message: 'at least one scope-tag is required' } };

  const cost = ['S', 'M', 'L'].includes(args.cost) ? args.cost : 'M';
  const name = args.name ? String(args.name).trim() : slugifyTitle(title);
  // H3/H7: an explicit name must be a safe single-segment slug (no traversal).
  if (!isSafeMemoryName(name)) {
    return { ok: false, cloud: false, error: { code: 'BAD_INPUT', message: `invalid --name '${name}' (must match ${SAFE_NAME_RE})` } };
  }
  const files = (args.files || []).map(String);
  const symbols = (args.symbols || []).map(String);
  const body = args.body ? String(args.body) : '';

  const { dir } = d.resolveHarnessMemoryDir({ repoRoot: args.repoRoot });
  // C0: create the dir if absent (capture is local-first).
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (err) { return { ok: false, cloud: false, error: { code: 'DIR_UNWRITABLE', message: err.message } }; }

  const fileName = `${name}.md`;
  const filePath = path.join(dir, fileName);
  const content = buildMemoryFileContent({ name, title, cost, scopeTags, files, symbols, body });

  // Validate our own output against the parse contract before writing (fail-fast).
  const fmCheck = FrictionFrontmatterSchema.safeParse({ ...yaml.parse(content.match(FM_RE)[1]) });
  if (!fmCheck.success) {
    return { ok: false, cloud: false, error: { code: 'SCHEMA_INVALID', message: fmCheck.error.issues[0]?.message } };
  }

  const lockPath = `${filePath}.lock`;
  await withFileLock(lockPath, {}, async () => {
    atomicWriteFileSync(filePath, content);
    updateMemoryIndex(dir, fileName, title);
  });

  // Best-effort mirror (local-first: the file is already written).
  const cloud = await d.isCloudEnabled();
  let mirrored = false; const warnings = [];
  if (cloud) {
    const repoId = await resolveWriteRepoId(d);
    if (repoId) {
      const { validRows } = d.parseFrictionMemories(dir);
      const row = validRows.find((r) => r.memory_name === name);
      if (row) {
        const res = await mirrorOneRow(d, repoId, row);
        mirrored = res.mirrored; warnings.push(...res.warnings);
      }
    }
  }
  return { ok: true, cloud, action: 'add', name, file: filePath, mirrored, warnings };
}

// ── quality mirror (C5) ──────────────────────────────────────────────────────

/**
 * Reconcile the DB mirror against the memory dir. Upsert each valid row (skipping
 * unchanged source_hash), tombstone absent rows ONLY on a complete scan, and route
 * every row through the sanitize choke-point. Cloud-off → `upserted:0` no-op, but
 * the parse still runs so warnings/skips surface.
 */
export async function frictionMirror(args = {}, deps = {}) {
  const d = resolveDeps(deps);
  const { dir, exists } = d.resolveHarnessMemoryDir({ repoRoot: args.repoRoot });
  if (!exists) {
    return { ok: true, cloud: await d.isCloudEnabled(), dir, exists: false, scanComplete: false,
      upserted: 0, unchanged: 0, tombstoned: 0, skipped: [], warnings: ['memory dir absent — nothing to mirror'] };
  }

  const { scanComplete, observedNames, validRows, skipped } = d.parseFrictionMemories(dir);
  const warnings = [];
  const cloud = await d.isCloudEnabled();
  if (!cloud) {
    return { ok: true, cloud: false, dir, exists: true, scanComplete,
      upserted: 0, unchanged: 0, tombstoned: 0, skipped, warnings: ['cloud disabled — parse only'] };
  }

  const repoId = await resolveWriteRepoId(d);
  if (!repoId) {
    return { ok: true, cloud: true, dir, exists: true, scanComplete,
      upserted: 0, unchanged: 0, tombstoned: 0, skipped, warnings: ['repo identity unresolved — skipping writes'] };
  }

  const existingHashes = await d.listFrictionSourceHashes(repoId);
  let upserted = 0, unchanged = 0;
  const skips = [...skipped];
  for (const row of validRows) {
    if (existingHashes.get(row.memory_name) === row.source_hash) { unchanged++; continue; }
    const san = sanitizeFrictionQueryInput(row);
    if (!san.ok) {
      skips.push({ name: row.memory_name, reason: 'secret-refused', fields: san.refusedFields });
      continue;     // refused rows are observed (not tombstoned) but never written
    }
    warnings.push(...san.warnings);
    try {
      await d.upsertFrictionRow(repoId, san.sanitized);
      upserted++;
    } catch (err) {
      skips.push({ name: row.memory_name, reason: 'upsert-failed', message: err.message });
    }
  }

  // Tombstone absent rows ONLY on a complete scan (C5 safety).
  const { tombstoned } = await d.reconcileTombstones({ repoId, seenNames: observedNames, scanComplete });
  return { ok: true, cloud: true, dir, exists: true, scanComplete, upserted, unchanged, tombstoned, skipped: skips, warnings };
}

// ── quality digest (C7) ──────────────────────────────────────────────────────

/**
 * Recurrence digest — cross-repo by default (the unique value), or repo-scoped
 * with `--repo-scoped`. Ranks clusters by recurrence × cost weight, marks the
 * `protected` and `alarm` flags Node-side from config.
 */
export async function frictionDigest(args = {}, deps = {}) {
  const d = resolveDeps(deps);
  const cloud = await d.isCloudEnabled();
  if (!cloud) return { ok: true, cloud: false, clusters: [] };

  let repoIdFilter = null;
  if (args.repoScoped) {
    repoIdFilter = await resolveReadRepoId(d, args.repoRoot);
    if (!repoIdFilter) return { ok: true, cloud: true, clusters: [], warnings: ['repo not indexed'] };
  }
  const res = await d.getFrictionRecurrence({
    repoIdFilter,
    windowDays: args.windowDays ?? frictionConfig.recurrenceWindowDays,
    minSimilarity: args.minSimilarity,
  });
  const clusters = (res?.clusters || []).map((c) => annotateCluster(c));
  // Rank by recurrence × cost weight; protected + alarm float to the top.
  clusters.sort((a, b) =>
    (b.protected - a.protected) || (b.alarm - a.alarm) || (b.rank - a.rank));
  return { ok: true, cloud: true, repoScoped: repoIdFilter != null, windowDays: res?.window_days ?? null, clusters };
}

/** Annotate a raw recurrence cluster with config-derived `protected`/`alarm`/`rank`. */
export function annotateCluster(c) {
  const tags = Array.isArray(c.scope_tags) ? c.scope_tags : [];
  const isProtected = tags.some((t) => frictionConfig.protectedScopeTags.includes(t));
  const weight = frictionConfig.costWeight[c.max_cost] ?? frictionConfig.costWeight.M;
  const rank = (c.recurrence_count || 0) * weight;
  const alarm = (c.recurrence_count || 0) >= frictionConfig.recurrenceAlarmCount
    && (c.oldest_age_days || 0) > frictionConfig.recurrenceAlarmAgeDays;
  return { ...c, protected: isProtected, alarm, rank };
}

// ── quality link (C6) ────────────────────────────────────────────────────────

/**
 * Closure: append a `{kind, ref}` mitigation to a friction note's frontmatter
 * (local-first, atomic, under a file lock), THEN best-effort mirror. Idempotent
 * (a duplicate {kind,ref} is a no-op). Cloud-off still appends locally.
 *
 * @param {{memory: string, kind: string, ref: string, repoRoot?: string}} args
 */
export async function frictionLink(args = {}, deps = {}) {
  const d = resolveDeps(deps);
  const name = String(args.memory || '').trim();
  const kind = String(args.kind || '').trim();
  const ref = String(args.ref || '').trim();
  const VALID = ['commit', 'agents_rule', 'doc', 'test', 'durable_memory', 'ignore'];
  if (!name) return { ok: false, cloud: false, error: { code: 'BAD_INPUT', message: 'memory name required' } };
  // H3/H7: guard `${name}.md` + path.join against traversal.
  if (!isSafeMemoryName(name)) return { ok: false, cloud: false, error: { code: 'BAD_INPUT', message: `invalid --memory '${name}'` } };
  if (!VALID.includes(kind)) return { ok: false, cloud: false, error: { code: 'BAD_INPUT', message: `kind must be one of ${VALID.join('|')}` } };
  if (!ref) return { ok: false, cloud: false, error: { code: 'BAD_INPUT', message: 'ref required' } };

  const { dir, exists } = d.resolveHarnessMemoryDir({ repoRoot: args.repoRoot });
  if (!exists) return { ok: false, cloud: false, error: { code: 'NO_MEMORY_DIR', message: 'memory dir absent' } };
  const filePath = path.join(dir, `${name}.md`);
  if (!fs.existsSync(filePath)) return { ok: false, cloud: false, error: { code: 'NOT_FOUND', message: `no friction memory '${name}'` } };

  let appended = false;
  let lockErr = null;
  await withFileLock(`${filePath}.lock`, {}, async () => {
    const content = fs.readFileSync(filePath, 'utf8');
    const m = content.match(FM_RE);
    if (!m) { lockErr = 'no frontmatter'; return; }
    let fm;
    try { fm = yaml.parse(m[1]); } catch (e) { lockErr = `yaml parse: ${e.message}`; return; }
    const parsed = FrictionFrontmatterSchema.safeParse(fm);
    if (!parsed.success) { lockErr = `schema invalid: ${parsed.error.issues[0]?.message}`; return; }

    fm.metadata.friction.mitigation_refs = fm.metadata.friction.mitigation_refs || [];
    const refs = fm.metadata.friction.mitigation_refs;
    if (refs.some((r) => r.kind === kind && r.ref === ref)) return;   // idempotent
    refs.push({ kind, ref });
    const yamlStr = yaml.stringify(fm).trimEnd();
    atomicWriteFileSync(filePath, `---\n${yamlStr}\n---\n${m[2]}`);
    appended = true;
  });
  if (lockErr) return { ok: false, cloud: false, error: { code: 'PARSE', message: lockErr } };

  // Best-effort mirror of the closure (local-first already done).
  const cloud = await d.isCloudEnabled();
  let mirrored = false; const warnings = [];
  if (cloud) {
    const repoId = await resolveWriteRepoId(d);
    if (repoId) {
      const safeRef = sanitizeRef({ kind, ref });
      try { const r = await d.appendMitigationRef(repoId, name, safeRef); mirrored = (r.updated ?? 0) > 0; }
      catch (err) { warnings.push(`mirror failed: ${err.message}`); }
    }
  }
  return { ok: true, cloud, action: 'link', name, appended, mirrored, warnings };
}

/** Redact a single mitigation ref through the egress gate (refuse → empty marker). */
function sanitizeRef({ kind, ref }) {
  const r = preWriteSecretGate(ref);
  return { kind, ref: r.ok ? r.content : '[REDACTED:secret]' };
}

// ── quality session-review (C10) ─────────────────────────────────────────────

/**
 * List friction notes injected within a recent time window that are candidates
 * for closure, each with a ready-to-run `quality link` command. Advisory; reads
 * the breadcrumb (+ DB to drop already-resolved notes when cloud is on).
 *
 * @param {{sinceMs?: number, windowHours?: number, repoRoot?: string}} args
 */
export async function frictionSessionReview(args = {}, deps = {}) {
  const d = resolveDeps(deps);
  const windowHours = args.windowHours ?? 24;
  const sinceMs = Number.isFinite(args.sinceMs)
    ? args.sinceMs
    : Date.now() - windowHours * 60 * 60 * 1000;
  const recent = d.readRecent(sinceMs, { repoRoot: args.repoRoot });
  const cloud = await d.isCloudEnabled();

  // Closure is human-gated (the C10 y/N prompt), so we surface ALL recently-
  // injected notes rather than pre-filtering on a DB "is resolved" read — a
  // wrong-window suggestion is rejected by the user, never a silent mislink.
  const pending = recent.map((r) => ({
    memory_name: r.memory_name,
    title: r.title || '',
    injected_at: new Date(r.ts).toISOString(),
    suggested_command: `node scripts/cross-skill.mjs quality link --memory ${r.memory_name} --kind commit --ref <sha>`,
  }));
  return { ok: true, cloud, pending };
}

// ── get-friction-neighbourhood (C9) ──────────────────────────────────────────

/**
 * Hook injection: top-k OPEN friction whose SHORT signature matches the prompt
 * (word_similarity, asymmetric). Writes a breadcrumb line per returned record
 * (title redacted). Repo-scoped; cloud-off / repo-absent → `records:[]`.
 *
 * @param {{prompt: string, k?: number, repoRoot?: string}} args
 */
export async function frictionNeighbourhood(args = {}, deps = {}) {
  const d = resolveDeps(deps);
  const prompt = typeof args.prompt === 'string' ? args.prompt : '';
  const cloud = await d.isCloudEnabled();
  if (!cloud || !prompt.trim()) return { ok: true, cloud, records: [] };

  const repoId = await resolveReadRepoId(d, args.repoRoot);
  if (!repoId) return { ok: true, cloud: true, records: [] };

  // §2b: the prompt hits an RPC (word_similarity query param) — redact secret
  // shapes before egress, like every other friction field. Ephemeral (not
  // stored); redaction barely affects matching (secrets aren't search terms).
  const safePrompt = redactText(prompt);
  let records = [];
  try {
    records = await d.storeFrictionNeighbourhood({
      repoId, prompt: safePrompt, k: args.k,
      minWordSim: args.minWordSim ?? frictionConfig.injectionWordSim,
    });
  } catch (err) {
    return { ok: true, cloud: true, records: [], warnings: [`neighbourhood query failed: ${err.message}`] };
  }
  records = Array.isArray(records) ? records : [];

  // Breadcrumb each injected note (title redacted — DB content is already
  // redacted on write, this is belt-and-braces). Best-effort, never throws.
  for (const r of records) {
    await d.appendInjected(
      { memory_name: r.memory_name, title: redactText(r.title || ''), repo_id: repoId },
      { repoRoot: args.repoRoot },
    );
  }
  return { ok: true, cloud: true, records };
}

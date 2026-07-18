/**
 * @fileoverview Zod schemas for install infrastructure.
 * Manifest, receipt, cache, and bundle-history validation.
 */
import { z } from 'zod';

// ── Manifest Schema ─────────────────────────────────────────────────────────

/**
 * Manifest schema versions the installer currently understands.
 * - 1: one-file-per-skill (path/sha/size/summary only). Legacy.
 * - 2: multi-file skills — adds `files: FileEntry[]` with each file's SHA.
 *      Supports references/** and examples/** inside a skill directory.
 *
 * A new installer can read v1 manifests (back-compat). An old installer
 * reading a v2 manifest must REJECT with UNSUPPORTED_MANIFEST_VERSION —
 * silently stripping `files` would cause consumer repos to get broken
 * progressive-disclosure skills.
 */
export const MANIFEST_SUPPORTED_VERSIONS = Object.freeze([1, 2]);

export const FileEntrySchema = z.object({
  relPath: z.string(),   // 'SKILL.md' or 'references/interop.md' — relative to skill dir
  sha: z.string(),
  size: z.number(),
});

export const SkillEntrySchema = z.object({
  path: z.string(),        // always 'skills/<name>/SKILL.md' — back-compat pointer
  sha: z.string(),         // SHA of SKILL.md specifically
  size: z.number(),
  summary: z.string(),
  // Added in v2. Absent on v1 manifests — v2 installer backfills to single-SKILL.md.
  files: z.array(FileEntrySchema).optional(),
});

export const ManifestSchema = z.object({
  schemaVersion: z.number(),
  bundleVersion: z.string(),
  repoUrl: z.string(),
  rawUrlBase: z.string(),
  // NO `updatedAt` — the manifest carries no volatile provenance (see
  // build-manifest.mjs). The schema is non-strict, so an OLD manifest that still
  // has the field parses fine (Zod strips unknown keys) — backward-compatible.
  skills: z.record(z.string(), SkillEntrySchema),
});

// ── Install Receipt Schema ──────────────────────────────────────────────────

export const ManagedFileSchema = z.object({
  path: z.string(),
  sha: z.string(),
  skill: z.string().optional(),
  blockSha: z.string().optional(),
  merged: z.boolean().optional(),
  /**
   * Which surface this file lives on — and therefore how `path` is encoded:
   * `global` entries are ABSOLUTE (they live in ~/.claude/skills, outside any
   * repo); `repo` entries are repo-relative. Every reader branches on this to
   * decode `path` again, so it is a load-bearing discriminator, not metadata.
   *
   * It MUST be declared here even though nothing in this module reads it:
   * `z.object()` strips undeclared keys, so omitting it meant `scope` reached
   * disk and then vanished on every read — making `computeDeletes`' global
   * branch unreachable, resolving each global path as
   * `path.join(repoRoot, '<absolute path>')`, and silently orphaning the file.
   *
   * Optional because pre-existing receipts carry no scope; absence means
   * `repo`, matching partitionManagedFilesByScope and computeDeletes.
   */
  scope: z.enum(['global', 'repo']).optional(),
});

export const InstallReceiptSchema = z.object({
  receiptVersion: z.number(),
  bundleVersion: z.string(),
  installedAt: z.string(),
  sourceUrl: z.string(),
  surface: z.string(),
  managedFiles: z.array(ManagedFileSchema),
});

// ── Update Cache Schema ─────────────────────────────────────────────────────

export const UpdateCacheSchema = z.object({
  fetchedAt: z.string(),
  manifest: ManifestSchema,
});

// ── Bundle History Schema ───────────────────────────────────────────────────

export const BundleHistoryEntrySchema = z.object({
  sha: z.string(),
  ts: z.string(),
  commit: z.string(),
});

export const BundleHistorySchema = z.record(z.string(), BundleHistoryEntrySchema);

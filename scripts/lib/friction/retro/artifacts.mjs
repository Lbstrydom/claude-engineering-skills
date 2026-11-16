/**
 * @fileoverview Versioned LOCAL artifacts under `.audit/harness-retro/`
 * (gitignored) — the hand-off between `scan`, `record`, `enforce` and `effect`
 * across processes (plan docs/plans/harness-retro.md §2 component 9).
 *
 * Derived data only. A scan artifact holds per-session fingerprint COUNTS and the
 * bounded, redacted labels; never a transcript record.
 *
 * @module scripts/lib/friction/retro/artifacts
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../../file-io.mjs';

export const ARTIFACT_DIR_REL = path.join('.audit', 'harness-retro');
export const SCAN_SCHEMA_VERSION = 1;
export const PRUNE_AFTER_DAYS = 60;
const SCAN_ID_RE = /^\d{8}T\d{9}Z-[0-9a-f]{6}$/;
const SCAN_FILE_RE = /^scan-(\d{8}T\d{9}Z-[0-9a-f]{6})\.json$/;

const SessionSchema = z.object({
  sessionKey: z.string().regex(/^[0-9a-f]{32}$/),
  repoUuid: z.string().min(1),
  repoName: z.string(),
  origin: z.enum(['interactive', 'automated']),
  startedAt: z.string().min(10),
  complete: z.boolean(),
  counts: z.record(z.string(), z.number().int().positive()),
  spans: z.record(z.string(), z.object({ firstAt: z.string().nullable(), lastAt: z.string().nullable() })),
}).strict();

export const ScanArtifactSchema = z.object({
  schemaVersion: z.literal(SCAN_SCHEMA_VERSION),
  scanId: z.string().regex(SCAN_ID_RE),
  createdAt: z.string(),
  fingerprintVersion: z.number().int().positive(),
  accountKey: z.string(),
  repoUuid: z.string().nullable(),
  fleet: z.boolean(),
  requested: z.object({ since: z.string(), until: z.string() }).strict(),
  retentionDays: z.number().positive(),
  sinceClamped: z.boolean(),
  files: z.object({
    listed: z.number().int(), read: z.number().int(), readErrors: z.number().int(),
    unparseableLines: z.number().int(), unjoinedResults: z.number().int(), enumerationErrors: z.number().int(), truncatedTails: z.number().int(),
  }).strict(),
  completed: z.boolean(),
  measured: z.boolean(),
  reason: z.string().optional(),
  transcriptVersions: z.array(z.string()),
  excluded: z.object({
    otherRepo: z.number().int(), unresolved: z.number().int(), incomplete: z.number().int(),
    untimestamped: z.number().int(), afterUntil: z.number().int(),
  }).strict(),
  sessions: z.array(SessionSchema),
  fingerprints: z.record(z.string(), z.object({ kind: z.string(), tool: z.string(), label: z.string() }).strict()),
  candidates: z.array(z.record(z.string(), z.unknown())),
  tripwires: z.array(z.record(z.string(), z.unknown())),
  summary: z.record(z.string(), z.unknown()),
}).strict();

/** UTC timestamp to the MILLISECOND + 6 random hex — lexical order is creation
 *  order (audit M9: second resolution made `latest` random within a second). */
export function newScanId(now = new Date()) {
  const ts = now.toISOString().replace(/[-:.]/g, '');
  return `${ts}-${crypto.randomBytes(3).toString('hex')}`;
}

export const artifactDir = (repoRoot) => path.join(repoRoot, ARTIFACT_DIR_REL);

export function writeScanArtifact(repoRoot, artifact) {
  const parsed = ScanArtifactSchema.parse(artifact);
  const dir = artifactDir(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `scan-${parsed.scanId}.json`);
  atomicWriteFileSync(p, `${JSON.stringify(parsed, null, 2)}\n`);
  return p;
}

/** Scan ids on disk, oldest first. */
export function listScanIds(repoRoot) {
  let names = [];
  try { names = fs.readdirSync(artifactDir(repoRoot)); } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;   // an unreadable artifact dir is not "no scans" (audit H3)
  }
  return names.map((n) => n.match(SCAN_FILE_RE)?.[1]).filter(Boolean).sort();
}

/**
 * Read one scan artifact (`'latest'` = newest). Throws a named error when absent
 * or invalid — a missing scan must never read as an empty one.
 */
export function readScanArtifact(repoRoot, id = 'latest') {
  const ids = listScanIds(repoRoot);
  const want = id === 'latest' ? ids[ids.length - 1] : id;
  if (!want || !ids.includes(want)) {
    const e = new Error(id === 'latest' ? 'no scan artifact yet — run `scan` first' : `scan artifact ${id} not found`);
    e.code = 'NO_SCAN';
    throw e;
  }
  const raw = JSON.parse(fs.readFileSync(path.join(artifactDir(repoRoot), `scan-${want}.json`), 'utf8'));
  return ScanArtifactSchema.parse(raw);
}

/** Every readable scan artifact (invalid ones are skipped and counted). */
export function readAllScanArtifacts(repoRoot) {
  const out = []; let invalid = 0;
  for (const id of listScanIds(repoRoot)) {
    try { out.push(readScanArtifact(repoRoot, id)); } catch { invalid++; }
  }
  return { scans: out, invalid };
}

/**
 * Whether a scan artifact is EFFECT EVIDENCE: a completed, measured, repo-local
 * scan. Its per-session counts are the only surviving record of sessions whose
 * transcripts Claude Code has since deleted (cleanupPeriodDays, default 30), so
 * it is never pruned — deleting it would turn a later `effect` UNMEASURED.
 */
export const isEffectEvidence = (a) => a.completed === true && a.measured === true && a.fleet === false && Boolean(a.repoUuid);

/** Prune only artifacts that can never be effect evidence (fleet, unmeasured or incomplete scans) older than `days`. */
export function pruneScanArtifacts(repoRoot, { now = Date.now(), days = PRUNE_AFTER_DAYS } = {}) {
  let pruned = 0;
  for (const id of listScanIds(repoRoot)) {
    const p = path.join(artifactDir(repoRoot), `scan-${id}.json`);
    try {
      if (now - fs.statSync(p).mtimeMs <= days * 86_400_000) continue;
      if (isEffectEvidence(JSON.parse(fs.readFileSync(p, 'utf8')))) continue;
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      pruned++;
    } catch { /* unreadable: leave it — never delete what could not be classified */ }
  }
  return pruned;
}

export function writeProposalsArtifact(repoRoot, scanId, envelope, markdown) {
  const dir = artifactDir(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  const json = path.join(dir, `proposals-${scanId}.json`);
  const md = path.join(dir, `proposals-${scanId}.md`);
  atomicWriteFileSync(json, `${JSON.stringify(envelope, null, 2)}\n`);
  atomicWriteFileSync(md, markdown);
  return { json, md };
}

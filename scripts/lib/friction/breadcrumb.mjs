/**
 * @fileoverview The friction injection breadcrumb — the ONLY reader/writer of the
 * SINGLE rolling `.audit/friction-injected.jsonl` (gitignored). Plan:
 * docs/completed/friction-feedback-loop.md (C8, Phase 3).
 *
 * The UserPromptSubmit hook envelope is `{hook_event_name, prompt}` — it carries
 * NO session id (Gemini-MED), so this is a single rolling log, NOT per-session.
 * `get-friction-neighbourhood` appends one line per injected note on inject;
 * `/ship` + `quality session-review` read recent lines by TIME WINDOW. Closure is
 * human-gated (the C10 y/N prompt), so a wrong-window suggestion is rejected by the
 * user — never a silent mislink.
 *
 * Line schema (C8 / §2b — NEVER the body): `{ts, memory_name, title, repo_id}`.
 * `title` is redacted by the caller (commands.mjs sanitize choke-point) before it
 * reaches here; this module does no redaction (it stores what it's given).
 *
 * Each `appendInjected` prunes lines older than `frictionConfig.breadcrumbTtlDays`
 * so the file is self-bounding without a separate sweeper.
 *
 * @module scripts/lib/friction/breadcrumb
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../file-io.mjs';
import { withFileLock } from '../file-lock.mjs';
import { frictionConfig } from '../config.mjs';

const BREADCRUMB_REL = path.join('.audit', 'friction-injected.jsonl');

/** Absolute breadcrumb path under the given repo root (default cwd). */
export function breadcrumbPath(repoRoot = process.cwd()) {
  return path.join(repoRoot, BREADCRUMB_REL);
}

/** Read + parse all valid JSONL lines; unparseable lines are skipped (never throw). */
function readLines(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return []; }                              // absent / unreadable → empty
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o.ts === 'number' && typeof o.memory_name === 'string') out.push(o);
    } catch { /* skip corrupt line */ }
  }
  return out;
}

/**
 * Append one injection record, pruning lines older than `breadcrumbTtlDays` first
 * (bounds growth). The whole read-prune-write runs under a file lock (H4) so two
 * concurrent injectors/commands can't lose each other's line. Never throws — a
 * breadcrumb failure (incl. lock timeout) must never break injection.
 *
 * @param {{memory_name: string, title?: string, repo_id?: string|null}} record
 * @param {{repoRoot?: string, now?: number}} [opts]
 * @returns {Promise<{ok: boolean, written: number, pruned: number}>}
 */
export async function appendInjected(record, { repoRoot = process.cwd(), now = Date.now() } = {}) {
  if (!record || typeof record.memory_name !== 'string' || !record.memory_name) {
    return { ok: false, written: 0, pruned: 0 };
  }
  const file = breadcrumbPath(repoRoot);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Short lock window — the read-prune-write must be atomic vs concurrent writers.
    return await withFileLock(`${file}.lock`, { maxWaitMs: 2000 }, () => {
      const ttlMs = Math.max(1, frictionConfig.breadcrumbTtlDays) * 24 * 60 * 60 * 1000;
      const horizon = now - ttlMs;
      const existing = readLines(file);
      const kept = existing.filter((o) => o.ts >= horizon);
      const pruned = existing.length - kept.length;
      kept.push({
        ts: now,
        memory_name: record.memory_name,
        title: typeof record.title === 'string' ? record.title : '',
        repo_id: record.repo_id ?? null,
      });
      atomicWriteFileSync(file, kept.map((o) => JSON.stringify(o)).join('\n') + '\n');
      return { ok: true, written: 1, pruned };
    });
  } catch {
    return { ok: false, written: 0, pruned: 0 };   // best-effort — never break the hook
  }
}

/**
 * Recent injection records (ts >= sinceMs), newest first, de-duplicated by
 * memory_name (keeps the most recent line per note). Used by closure (C10).
 *
 * @param {number} sinceMs - absolute epoch ms lower bound
 * @param {{repoRoot?: string}} [opts]
 * @returns {Array<{ts, memory_name, title, repo_id}>}
 */
export function readRecent(sinceMs, { repoRoot = process.cwd() } = {}) {
  const lower = Number.isFinite(sinceMs) ? sinceMs : 0;
  const lines = readLines(breadcrumbPath(repoRoot))
    .filter((o) => o.ts >= lower)
    .sort((a, b) => b.ts - a.ts);
  const seen = new Set();
  const out = [];
  for (const o of lines) {
    if (seen.has(o.memory_name)) continue;
    seen.add(o.memory_name);
    out.push(o);
  }
  return out;
}

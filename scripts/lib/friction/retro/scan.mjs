/**
 * @fileoverview The scan orchestrator — enumerate → assemble sessions → extract →
 * resolve repo → derived result. No writes and no network (plan
 * docs/plans/harness-retro.md §2 components 1–4).
 *
 * Session assembly: files are grouped by the session id their PATH names
 * (`<slug>/<id>.jsonl`, `<slug>/<id>/subagents/agent-*.jsonl`), so a parent and
 * its subagents share one extractor; the main file is fed first, then the
 * subagent files in sorted order, with `endFile()` between files.
 *
 * The result is honest about what it read: `measured:false` with a `reason`
 * whenever the read cannot support a "nothing recurring" conclusion.
 *
 * @module scripts/lib/friction/retro/scan
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { listTranscriptFiles, streamTranscript } from './transcripts.mjs';
import { createSessionExtractor } from './signals.mjs';
import { FINGERPRINT_VERSION } from './fingerprint.mjs';

/** sha256 of a session id — the only session identifier that leaves the scanner. */
export const sessionKeyOf = (sessionId) => crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 32);
/** sha256 of the account's config root — distinguishes accounts without naming a path. */
export const accountKeyOf = (configDir) => crypto.createHash('sha256')
  .update(path.resolve(String(configDir)).replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 16);

/** The session id a transcript PATH names. */
export function sessionIdFromPath(file) {
  if (file.subagent) return path.basename(path.dirname(path.dirname(file.path)));
  return path.basename(file.path, '.jsonl');
}

/** Group files by session, main file first. Pure. */
export function groupFilesBySession(files) {
  const groups = new Map();
  for (const f of files) {
    const id = sessionIdFromPath(f);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(f);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => (a.subagent - b.subagent) || a.path.localeCompare(b.path));
  }
  return groups;
}

/**
 * Decide whether a read can support a conclusion. Pure. Every `false` names
 * why — an UNMEASURED scan must never read as a clean one.
 * @returns {{measured: boolean, reason?: string}}
 */
export function assessMeasurement({ projectsDirExists, projectsDirUnreadable = false, listed, read, conversationalSessions, inScopeSessions }) {
  if (projectsDirUnreadable) return { measured: false, reason: 'enumeration-errors' };
  if (!projectsDirExists || listed === 0) return { measured: false, reason: 'no-transcripts' };
  if (read === 0) return { measured: false, reason: 'read-errors' };
  if (conversationalSessions === 0) return { measured: false, reason: 'format-unrecognised' };
  if (inScopeSessions === 0) return { measured: false, reason: 'no-in-scope-sessions' };
  return { measured: true };
}

/**
 * @param {{configDir: string, sinceMs: number, untilMs?: number,
 *          resolver: {resolve: (cwd: string) => ({repoUuid: string, name: string}|null)},
 *          thisRepoUuid: string|null, fleet?: boolean,
 *          list?: typeof listTranscriptFiles, stream?: typeof streamTranscript}} opts
 */
export async function runScan(opts) {
  const {
    configDir, sinceMs, resolver, thisRepoUuid, fleet = false,
    list = listTranscriptFiles, stream = streamTranscript,
  } = opts;
  // `until` can never be in the future: coverage claims what was READ (audit H6).
  const untilMs = Math.min(opts.untilMs ?? Date.now(), Date.now());
  // Coverage can never reach behind the transcript-retention horizon: Claude Code
  // deletes transcripts after `cleanupPeriodDays` (default 30), so a session that
  // started earlier may be gone and its absence would read as "no failure".
  // The REQUESTED since is clamped for the coverage claim (coordinator check, 2026-11-16).
  const retentionDays = Number.isFinite(opts.retentionDays) && opts.retentionDays > 0 ? opts.retentionDays : 30;
  const coverageSinceMs = Math.max(sinceMs, untilMs - retentionDays * 86_400_000);
  const listing = list({ configDir });
  const { projectsDirExists, files: allFiles } = listing;
  const enumerationErrors = listing.enumerationErrors ?? [];
  const projectsDir = listing.projectsDir;
  // Select sessions by ANY constituent file's mtime, then read ALL their files.
  const groups = [...groupFilesBySession(allFiles)]
    .filter(([, g]) => g.some((f) => f.mtimeMs >= sinceMs));
  const files = groups.flatMap(([, g]) => g);
  const stats = {
    listed: files.length, read: 0, readErrors: 0, unparseableLines: 0, unjoinedResults: 0,
    enumerationErrors: enumerationErrors.length, truncatedTails: 0,
  };
  const versions = new Set();
  const fingerprints = {};
  const sessions = [];
  const excluded = { otherRepo: 0, unresolved: 0, incomplete: 0, untimestamped: 0, afterUntil: 0 };
  let conversationalSessions = 0;

  for (const [sessionId, group] of groups) {
    const ex = createSessionExtractor();
    let complete = true;
    for (const f of group) {
      const r = await stream(f.path, ex.push);
      ex.endFile();
      if (r.readError) { stats.readErrors++; complete = false; } else stats.read++;
      // A garbled line MID-file means records were lost: incomplete, reported but
      // never effect evidence (audit H5). A garbled LAST line is a write in progress —
      // the snapshot is exact as of `until`, and a later scan supersedes it.
      if (r.unparseable - (r.truncatedTail ? 1 : 0) > 0) complete = false;
      if (r.truncatedTail) stats.truncatedTails++;
      stats.unparseableLines += r.unparseable;
    }
    const s = ex.finish();
    stats.unjoinedResults += s.unjoined;
    for (const v of s.versions) versions.add(v);
    if (s.conversational === 0) continue;   // not a conversation (e.g. a metadata-only file)
    conversationalSessions++;
    if (!s.firstTs) { excluded.untimestamped++; continue; }
    if (Date.parse(s.firstTs) > untilMs) { excluded.afterUntil++; continue; }

    const repo = s.firstCwd ? resolver.resolve(s.firstCwd) : null;
    if (!repo) { excluded.unresolved++; continue; }
    if (!fleet && repo.repoUuid !== thisRepoUuid) { excluded.otherRepo++; continue; }
    if (!complete) excluded.incomplete++;   // still reported; never effect evidence (plan R3-H1)

    const counts = {};
    const spans = {};
    for (const o of s.occurrences) {
      counts[o.fingerprint] = (counts[o.fingerprint] ?? 0) + 1;
      if (!fingerprints[o.fingerprint]) fingerprints[o.fingerprint] = { kind: o.kind, tool: o.tool, label: o.label };
      const sp = spans[o.fingerprint] ?? (spans[o.fingerprint] = { firstAt: o.ts, lastAt: o.ts });
      if (o.ts && (!sp.firstAt || o.ts < sp.firstAt)) sp.firstAt = o.ts;
      if (o.ts && (!sp.lastAt || o.ts > sp.lastAt)) sp.lastAt = o.ts;
    }
    sessions.push({
      sessionKey: sessionKeyOf(sessionId),
      repoUuid: repo.repoUuid,
      repoName: repo.name,
      origin: s.humanTurns > 0 ? 'interactive' : 'automated',
      complete,
      startedAt: s.firstTs,
      counts,
      spans,
    });
  }

  sessions.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)) || a.sessionKey.localeCompare(b.sessionKey));
  const verdict = assessMeasurement({
    projectsDirExists, projectsDirUnreadable: enumerationErrors.some((e) => e.path === projectsDir),
    listed: stats.listed, read: stats.read, conversationalSessions, inScopeSessions: sessions.length,
  });
  return {
    fingerprintVersion: FINGERPRINT_VERSION,
    accountKey: accountKeyOf(configDir),
    requested: { since: new Date(coverageSinceMs).toISOString(), until: new Date(untilMs).toISOString() },
    retentionDays,
    sinceClamped: coverageSinceMs > sinceMs,
    files: stats,
    // Coverage evidence: every listed file read cleanly AND the walk itself saw no error.
    // ...and no in-scope session was incomplete (audit R2-M3): a scan that could
    // not read a session completely cannot claim to cover it.
    completed: stats.listed > 0 && stats.readErrors === 0 && enumerationErrors.length === 0 && excluded.incomplete === 0,
    ...verdict,
    transcriptVersions: [...versions].sort(),
    excluded,
    sessions,
    fingerprints,
  };
}

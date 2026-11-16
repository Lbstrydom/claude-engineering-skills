/**
 * @fileoverview The verbs behind `scripts/ship-record.mjs` (docs/plans/ship-record-catchup.md §2.9): `status`, `catchup`,
 * `floor`, `init`. Under lib/ so tests drive them through an injected context (runners, fs root, clock, backlog,
 * events) without importing the CLI.
 *
 * The record half of /ship, without its push/merge authority: these verbs write NEW files under docs/status/entries/ and
 * nothing else; they never commit, push or merge. Committing is `ship-commit.mjs --record`; merging stays the user's.
 *
 * @module scripts/lib/ship-record/commands
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gatherRecordState, readBaseEntries, resolveBase, discoverBaseBranch, listMergedSince, mergeFacts, ENTRIES_DIR, MARKER_FILE } from './facts.mjs';
import { isFloorEntryName, SHA_RE, RUN_ENTRY_RE } from './state.mjs';
import {
  parseRunMarker, prEntryFileName, renderPrEntry, renderRunEntry, renderFloorEntry, renderInitReadme, publishEntry, checkEntriesDir, sweepTemps,
  touchedPlans, planLogSuggestion, planHasMarker, entryFileName,
} from './entry.mjs';

export const DEFAULT_MAX = 30;
/** Markers older than this are not reconciled for events (plan §2.5, stated limit). */
export const EVENT_HORIZON_DAYS = 90;
export const EVENT_BATCH = 500;
export const EVENT_REASON = 'merged-without-ship';
/** A floor's cutoff is the newest PR merged at least this long ago (GitHub's search index settles, plan §2.3). */
export const SETTLE_MS = 15 * 60 * 1000;
/** With no log entry to start from, the floor summarises this far back. */
export const FLOOR_DEFAULT_LOOKBACK_DAYS = 30;

export class RecordRefusal extends Error {
  constructor(message, details = {}) { super(message); this.name = 'RecordRefusal'; this.details = details; }
}

/** The one executable next command for a state. */
export function remedyFor(st, cmd) {
  switch (st.state) {
    case 'no-marker': return `${cmd} init`;
    case 'no-floor': return `${cmd} floor --write`;
    case 'ambiguous-floor': return 'a human removes all but one *-record-floor.md entry in a reviewed PR';
    case 'unmeasured': return /git fetch/.test(st.reason ?? '') ? `${cmd} status --fetch` : `${cmd} status (after fixing: ${st.reason})`;
    default:
      if (st.counts?.unrecorded > 0) return `${cmd} catchup --write`;
      if (st.counts?.unknown > 0) return `${cmd} status --fetch`;
      return null;
  }
}

const baseView = (b) => (b ? { branch: b.branch, ref: b.ref, repo: b.repo, oid: b.oid } : null);

function envelope(verb, st, cmd, extra = {}) {
  const measured = st.state === 'measured' || st.state === 'partial';
  return {
    ok: true, verb, state: st.state, reason: st.reason ?? null, base: baseView(st.base), floor: st.floor ?? null,
    counts: measured ? { ...st.counts, withTrailers: null } : { merged: null, recorded: null, unrecorded: null, unknown: null, withTrailers: null },
    unrecorded: measured ? st.prs.filter((p) => p.status === 'unrecorded').map(({ number, mergedAt, mergeCommit }) => ({ number, mergedAt, mergeCommit })) : [],
    wrote: [], events: { written: 0, existing: 0, lost: 0, skipped: 0, backlog: 0 },
    remedy: remedyFor(st, cmd), ...extra,
  };
}

function maybeFetch(ctx, opts) {
  if (!opts.fetch) return null;
  // Discovery, not resolution: the tracking ref may be exactly what is missing. No branch known ⇒ say so, never fetch a guess.
  const d = discoverBaseBranch(ctx.runners, opts.base ?? null);
  if (!d.ok) return `--fetch skipped: ${d.reason}`;
  const branch = d.branch;
  // An EXPLICIT destination (A-R5-M1): a single-branch clone's refspec may not map this branch to the tracking ref the
  // resolver needs. The name is validated before this line (isSafeBranch), so it cannot read as an option.
  const r = ctx.runners.git(['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  return r.status === 0 && !r.error ? null : `git fetch origin ${branch} failed (${String(r.stderr ?? r.error?.message ?? '').trim().slice(0, 200)}); measured against the last fetch`;
}

/** `status` — read-only. */
export function runStatus(ctx, opts = {}) {
  const warning = maybeFetch(ctx, opts);
  const st = gatherRecordState(ctx.runners, { branch: opts.base ?? null, now: ctx.now() });
  return envelope('status', st, ctx.cmd, warning ? { warnings: [warning] } : {});
}

const entriesDirOf = (ctx) => path.join(ctx.repoRoot, ENTRIES_DIR);
const localFloors = (ctx) => { try { return fs.readdirSync(entriesDirOf(ctx)).filter(isFloorEntryName); } catch { return []; } };

/** Read a working-tree plan; null when absent or not a regular file. */
function readPlan(ctx, rel) {
  const p = path.join(ctx.repoRoot, rel);
  try { return fs.lstatSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null; } catch { return null; }
}

/** `catchup` — dry run unless `write`. */
export async function runCatchup(ctx, opts = {}) {
  const warning = maybeFetch(ctx, opts);
  const st = gatherRecordState(ctx.runners, { branch: opts.base ?? null, now: ctx.now() });
  if (st.state !== 'measured' && st.state !== 'partial') {
    throw new RecordRefusal(`catchup refused: state is ${st.state} (${st.reason})`, { state: st.state, remedy: remedyFor(st, ctx.cmd) });
  }
  const max = opts.max ?? DEFAULT_MAX;
  const todo = st.prs.filter((p) => p.status === 'unrecorded');
  const batch = todo.slice(0, max);
  const env = envelope('catchup', st, ctx.cmd, { write: Boolean(opts.write), wouldWrite: [], deferred: todo.length - batch.length, skipped: [], suggestions: [], errors: [], ...(warning ? { warnings: [warning] } : {}) });
  const dir = entriesDirOf(ctx);
  if (opts.write) {
    const d = checkEntriesDir(ctx.repoRoot, ENTRIES_DIR);
    if (!d.ok) throw new RecordRefusal(`catchup refused: ${d.reason}`, { remedy: `${ctx.cmd} init` });
    sweepTemps(dir, { nowMs: ctx.now().getTime() });
  }
  const recorded = [];
  for (const pr of batch) {
    const facts = mergeFacts(ctx.runners, pr.mergeCommit);
    if (!facts) { env.skipped.push({ number: pr.number, reason: 'merge commit not in the local object store' }); continue; }
    const name = prEntryFileName(pr);
    const bytes = renderPrEntry(pr, facts, { repo: st.base.repo });
    const { plans, suggest } = touchedPlans(facts.files);
    if (suggest) {
      for (const plan of plans) {
        const text = readPlan(ctx, plan);
        if (text !== null && !planHasMarker(text, pr.number)) env.suggestions.push({ plan, pr: pr.number, line: planLogSuggestion(pr) });
      }
    }
    if (!opts.write) { env.wouldWrite.push(`${ENTRIES_DIR}/${name}`); recorded.push(pr); continue; }
    const r = publishEntry(dir, name, bytes);
    if (r.outcome === 'written') { env.wrote.push(`${ENTRIES_DIR}/${name}`); recorded.push(pr); }
    else if (r.outcome === 'identical') recorded.push(pr);
    else env.errors.push(r.reason);
  }
  // The run entry is RECOVERABLE (audit A-R1-H4): it lists every per-PR entry in the working tree that is not yet on the
  // base tree and that no local run entry already lists — so a run that died after its per-PR files still gets one.
  const pending = opts.write ? pendingForRunEntry(ctx, st, recorded) : [];
  if (opts.write && pending.length) {
    const nowIso = ctx.now().toISOString();
    const runBytes = renderRunEntry({ nowIso, recorded: pending, backlogLine: ctx.backlog(), suggestions: env.suggestions, base: st.base });
    // 32 random bits per name, and an exclusive create retried under a fresh suffix on a collision (A-R2-M2, A-R3-M1).
    let r = null;
    for (let attempt = 0; attempt < 3 && r?.outcome !== 'written'; attempt++) {
      const runName = entryFileName(nowIso, `record-catchup-${crypto.randomBytes(4).toString('hex')}`);
      r = publishEntry(dir, runName, runBytes);
      if (r.outcome === 'written') env.wrote.push(`${ENTRIES_DIR}/${runName}`);
    }
    if (r.outcome !== 'written') env.errors.push(r.reason);
  }
  if (opts.write && opts.events !== false) env.events = await reconcileEvents(ctx, st, recorded);
  else env.events.skipped = recorded.length;
  env.remedy = env.deferred > 0 ? `${ctx.cmd} catchup --write (${env.deferred} more)` : (env.wrote.length ? `commit with ship-commit.mjs --record, then open a docs-only PR` : env.remedy);
  if (env.errors.length || env.events.lost > 0) env.ok = false;
  return env;
}

/** Recorded-this-run PRs whose entry no local run entry lists yet (the run-entry marker is the key). */
export function pendingForRunEntry(ctx, st, recorded) {
  const dir = entriesDirOf(ctx);
  const onBase = new Set(st.entries?.names ?? []);
  const listed = new Set();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return recorded; }
  for (const n of names) {
    if (!RUN_ENTRY_RE.test(n) || onBase.has(n)) continue;
    try { for (const x of parseRunMarker(fs.readFileSync(path.join(dir, n), 'utf8'))) listed.add(x); } catch { /* unreadable: treat as listing nothing */ }
  }
  return recorded.filter((p) => !onBase.has(prEntryFileName(p)) && !listed.has(p.number));
}

/**
 * Ensure one `merged-without-ship` event per catch-up-recorded PR (plan §2.5). At-least-once. A failed write is retried by
 * the next run, because the set to reconcile is re-derived from the entries every time, not from what this run wrote.
 */
export async function reconcileEvents(ctx, st, recordedThisRun) {
  const ev = { written: 0, existing: 0, lost: 0, skipped: 0, backlog: 0, lostPrs: [] };
  if (!ctx.events) { ev.skipped = recordedThisRun.length; return ev; }
  const horizon = ctx.now().getTime() - EVENT_HORIZON_DAYS * 86_400_000;
  const byPr = new Map();
  for (const p of st.prs) if (p.status === 'recorded' && p.by === 'marker') byPr.set(p.number, p);
  for (const p of recordedThisRun) byPr.set(p.number, p);
  const all = [...byPr.values()].filter((p) => SHA_RE.test(p.mergeCommit ?? '') && Date.parse(p.mergedAt) >= horizon)
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
  if (!all.length) return ev;
  const scope = await ctx.events.resolveRepoId();
  if (!scope.ok) { ev.skipped = all.length; ev.reason = scope.reason; if (scope.fatal) { ev.lost = all.length; ev.lostPrs = all.map((p) => p.number); } return ev; }
  // Existence is read for EVERY eligible PR (in bounded chunks) BEFORE the write cap applies (audit A-R1-H3/M8): capping
  // first would re-select the same already-reconciled newest PRs every run and starve the oldest forever.
  const missing = [];
  for (let i = 0; i < all.length; i += EVENT_BATCH) {
    const chunk = all.slice(i, i + EVENT_BATCH);
    const found = await ctx.events.find(scope.repoId, chunk.map((p) => p.mergeCommit), EVENT_REASON);
    if (!found.ok) {
      // Nothing has been written yet (writes follow every read), so all that is not already present is unreconciled (A-R2-M1).
      const lost = [...missing, ...all.slice(i)];
      ev.lost = lost.length; ev.lostPrs = lost.map((p) => p.number); ev.reason = found.error ?? found.reason; return ev;
    }
    if (!found.cloud) { ev.skipped = all.length; ev.reason = 'cloud off'; return ev; }
    for (const p of chunk) { if (found.present.has(p.mergeCommit)) ev.existing++; else missing.push(p); }
  }
  const batch = missing.slice(0, EVENT_BATCH);
  ev.backlog = missing.length - batch.length;
  for (const p of batch) {
    const r = await ctx.events.record(scope.repoId, { outcome: 'warned', blockReasons: [EVENT_REASON], commitSha: p.mergeCommit, branch: p.headRefName || null });
    if (r.ok && r.cloud) ev.written++;
    else if (r.ok) ev.skipped++;
    else { ev.lost++; ev.lostPrs.push(p.number); }
  }
  return ev;
}

/** The newest log entry name before a floor (base tree), else status.md's first `## ` heading. */
function lastLogEntry(ctx, base, names) {
  const entries = names.filter((n) => n !== 'README.md' && /\.md$/.test(n)).sort();
  if (entries.length) return { label: entries[entries.length - 1], dateIso: `${entries[entries.length - 1].slice(0, 10)}T00:00:00Z` };
  const r = ctx.runners.git(['show', `${base.oid}:status.md`]);
  const m = r.status === 0 ? /^## (\d{4}-\d{2}-\d{2})\b.*$/m.exec(String(r.stdout)) : null;
  return m ? { label: `status.md: ${m[0].slice(3).trim()}`, dateIso: `${m[1]}T00:00:00Z` } : null;
}

/** `floor` — the summarised backfill entry; dry run unless `write`. */
export function runFloor(ctx, opts = {}) {
  const warning = maybeFetch(ctx, opts);
  const base = resolveBase(ctx.runners, { branch: opts.base ?? null });
  if (!base.ok) throw new RecordRefusal(`floor refused: ${base.reason}`);
  const entries = readBaseEntries(ctx.runners, base.oid); // the pinned commit, never the moving tracking ref (A-R2-H2)
  if (!entries.ok) throw new RecordRefusal(`floor refused: ${entries.reason}`);
  const markerLocal = fs.existsSync(path.join(ctx.repoRoot, MARKER_FILE));
  if (!entries.markerPresent && !markerLocal) throw new RecordRefusal('floor refused: docs/status/entries/README.md is absent', { remedy: `${ctx.cmd} init` });
  const existing = [...entries.floors.map((f) => f.file), ...localFloors(ctx)];
  if (existing.length) throw new RecordRefusal(`floor refused: a floor already exists (${[...new Set(existing)].join(', ')}); a floor never moves`);
  const now = ctx.now();
  const last = lastLogEntry(ctx, base, entries.names);
  const fromIso = last?.dateIso ?? new Date(now.getTime() - FLOOR_DEFAULT_LOOKBACK_DAYS * 86_400_000).toISOString();
  const listing = listMergedSince(ctx.runners, { repo: base.repo, branch: base.branch, fromIso, toIso: now.toISOString() });
  if (!listing.ok) throw new RecordRefusal(`floor refused: ${listing.reason}`);
  if (!listing.complete) throw new RecordRefusal(`floor refused: the listing is not complete (${listing.partialReason}) — a floor is a claim about everything before it`);
  const settled = listing.prs.filter((p) => Date.parse(p.mergedAt) <= now.getTime() - SETTLE_MS);
  const mergedThrough = settled.length ? settled[settled.length - 1].mergedAt : new Date(now.getTime() - SETTLE_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const covered = settled.map((p) => p.number);
  // Every covered PR's merge must be MEASURED: an unreadable one is neither "has a gate" nor "has none" (A-R1-H7/M10).
  const facts = settled.map((p) => ({ p, f: mergeFacts(ctx.runners, p.mergeCommit) }));
  const unknown = facts.filter((x) => !x.f).map((x) => `#${x.p.number}`);
  if (unknown.length) throw new RecordRefusal(`floor refused: ${unknown.length} covered merge commit(s) are not in the local object store (${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? ', …' : ''}) — git fetch origin ${base.branch}`, { remedy: `${ctx.cmd} floor --write --fetch` });
  const withGate = facts.filter((x) => x.f.trailers.kind === 'gate').length;
  const nowIso = now.toISOString();
  const name = entryFileName(nowIso, 'record-floor');
  const bytes = renderFloorEntry({ nowIso, mergedThrough, covered, lastEntry: last?.label ?? null, withGate, total: settled.length, base });
  const env = { ok: true, verb: 'floor', write: Boolean(opts.write), base: baseView(base), floor: { file: name, mergedThrough, covered: covered.length }, counts: { merged: settled.length, withTrailers: withGate }, wrote: [], remedy: null, ...(warning ? { warnings: [warning] } : {}) };
  if (!opts.write) { env.wouldWrite = [`${ENTRIES_DIR}/${name}`]; env.remedy = `${ctx.cmd} floor --write`; return env; }
  const d = checkEntriesDir(ctx.repoRoot, ENTRIES_DIR);
  if (!d.ok) throw new RecordRefusal(`floor refused: ${d.reason}`, { remedy: `${ctx.cmd} init` });
  const r = publishEntry(path.join(ctx.repoRoot, ENTRIES_DIR), name, bytes);
  if (r.outcome !== 'written') { env.ok = false; env.errors = [r.reason]; return env; }
  env.wrote.push(`${ENTRIES_DIR}/${name}`);
  env.remedy = 'commit it with ship-commit.mjs --record in a docs-only PR; after it merges, run catchup';
  return env;
}

/** `init` — adopt per-entry status files (the consumer cutover marker). */
export function runInit(ctx) {
  const markerPath = path.join(ctx.repoRoot, MARKER_FILE);
  if (fs.existsSync(markerPath)) throw new RecordRefusal(`init refused: ${MARKER_FILE} already exists`);
  const dir = path.join(ctx.repoRoot, ENTRIES_DIR);
  // Walk docs → docs/status → docs/status/entries: each EXISTING component must be a real directory (never a symlink that
  // could redirect creation outside the repo, audit A-R1-H6/M13); a missing one is created alone, non-recursively.
  let cur = ctx.repoRoot;
  for (const part of ENTRIES_DIR.split('/')) {
    cur = path.join(cur, part);
    let st = null;
    try { st = fs.lstatSync(cur); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new RecordRefusal(`init refused: ${path.relative(ctx.repoRoot, cur)} exists and is not a real directory`);
    if (!st) fs.mkdirSync(cur);
  }
  const d = checkEntriesDir(ctx.repoRoot, ENTRIES_DIR);
  if (!d.ok) throw new RecordRefusal(`init refused: ${d.reason}`);
  const r = publishEntry(dir, 'README.md', renderInitReadme());
  if (r.outcome !== 'written') throw new RecordRefusal(`init refused: ${r.reason}`);
  return { ok: true, verb: 'init', wrote: [MARKER_FILE], remedy: `commit it with ship-commit.mjs --record, then ${ctx.cmd} floor --write` };
}

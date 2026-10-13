/**
 * @fileoverview The findings intake queue: durable PROPOSALS a session records with `fleet propose` and a
 * coordinator triages. A chip is admission for ready work, not a record of every finding (coordinator rule 10);
 * this is the record that outlives the session, its worktree and its archive.
 *
 * Store: one JSON file per proposal under `<git-common-dir>/fleet/proposals/` — a new sibling of `sessions/` and
 * `directives/`, so an older bundle never reads it. Same discipline as `directives.mjs`: a strict zod schema with
 * `schemaVersion`, a record this reader does not understand is listed and never rewritten, reads are bounded and
 * report `complete:false` instead of a short list, writes happen under the registry lock (the caller holds it).
 *
 * Lifecycle: `pending` (untriaged) -> `folded <session>` | `queued <reason>` | `declined <reason>` | `done <PR>`.
 * Every transition APPENDS a history entry with a required detail; nothing is deleted. `done` and `declined` are
 * final: the atomic write of the final state is the COMMIT; moving the file to `closed/<yyyy-mm>/` is an idempotent
 * archival that follows (and is retried by the next mutation), so a crash between the two leaves a committed record
 * that readers still treat as closed. Active reads never scan `closed/`, so lifetime growth cannot starve the queue.
 *
 * Unmeasured is never zero: a directory that cannot be listed is `unmeasured`, never `none pending`; an incomplete
 * read prints lower bounds.
 *
 * `blockedBy` is DATA rechecked against facts on request (`recheckBlockedBy`): a label next to the item, never a
 * scheduler — nothing is promoted, assigned or spawned.
 *
 * This module imports nothing from `commands.mjs`, so every surface can import it without a cycle.
 *
 * Plan: docs/plans/fleet-proposals-queue.md.
 *
 * @module scripts/lib/fleet/proposals
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../file-io.mjs';
import { assertManaged } from './registry.mjs';

export const PROPOSAL_STATES = Object.freeze(['pending', 'folded', 'queued', 'declined', 'done']);
export const FINAL_STATES = Object.freeze(['declined', 'done']);
export const OPEN_STATES = Object.freeze(['pending', 'queued', 'folded']);
export const PROPOSAL_ID_RE = /^p-[0-9]{14}-[0-9a-f]{4}$/;
/** Active records read per call; past it the read is `truncated`, never a short list. */
export const PROPOSALS_CAP = 2000;
/** History entries per record, creation included; the last slot is reserved for a final outcome. */
export const HISTORY_MAX = 50;
/** A file larger than this is an unreadable record, reported with its reason. */
export const MAX_RECORD_BYTES = 64 * 1024;
/**
 * Bytes kept free for the closing entry: a non-final write (creation, `queued`, `folded`) must leave this much room,
 * so a record can always be closed. A final entry is at most ~2.3 KB (500-char detail and 200-char `by`, 3 bytes each).
 */
export const FINAL_RESERVE_BYTES = 4 * 1024;
/** A pending (untriaged) proposal older than this is flagged. */
export const PROPOSAL_STALE_DAYS = 3;
/** Distinct blockers `recheckBlockedBy` probes per call. */
export const RECHECK_MAX = 20;
/** Per-record diagnostics listed before the rest are only counted. */
export const DIAGNOSTICS_LISTED = 20;
const DAY_MS = 86_400_000;

const NO_CONTROL = /^[^\u0000-\u001f\u007f]+$/;
/** Canonical UTC form (`Date#toISOString`); the archive month is derived from it, so no other spelling is accepted. */
const ISO_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,9})?Z$/;
const IsoSchema = z.string().refine((s) => ISO_RE.test(s) && Number.isFinite(Date.parse(s)), 'must be a UTC ISO timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)');
const text = (max) => z.string().min(1).max(max).regex(NO_CONTROL, 'must be one line without control characters');
const THEME_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
/** `owner/name`, or `host/owner/name` for a host other than github.com (what `gh --repo` accepts). */
const REPO_RE = /^([A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * A branch name as `blockedBy` accepts it: a LITERAL ref name (the rules of `git check-ref-format --branch`), bare, no
 * `refs/` prefix. Revision syntax (`topic~1`, `topic^`, `topic@{1}`) is refused: it would be resolved as an expression,
 * not as the branch it names.
 */
export function isBranchName(v) {
  if (typeof v !== 'string' || v.length === 0 || v.length > 200 || !NO_CONTROL.test(v) || /\s/.test(v)) return false;
  if (/[~^:?*[\\]/.test(v) || v.includes('..') || v.includes('@{') || v.includes('//') || v === '@') return false;
  if (v.startsWith('-') || v.startsWith('/') || v.endsWith('/') || v.endsWith('.') || v.startsWith('refs/')) return false;
  return v.split('/').every((c) => c !== '' && !c.startsWith('.') && !c.endsWith('.lock'));
}

const BlockedBySchema = z.union([
  z.strictObject({ kind: z.literal('pr'), ref: z.string().regex(/^#[1-9][0-9]*$/), repo: z.string().regex(REPO_RE).optional() }),
  z.strictObject({ kind: z.literal('branch'), ref: z.string().refine(isBranchName, 'not a bare branch name') }),
]);

const HistorySchema = z.strictObject({ at: IsoSchema, state: z.enum(PROPOSAL_STATES), by: text(200), detail: text(500).optional() });

export const ProposalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().regex(PROPOSAL_ID_RE),
  what: text(600),
  where: text(600),
  why: text(600),
  evidence: text(1000).optional(),
  theme: z.string().regex(THEME_RE).optional(),
  blockedBy: BlockedBySchema.optional(),
  originator: z.strictObject({ id: text(200), branch: text(200).nullable() }),
  createdAt: IsoSchema,
  state: z.enum(PROPOSAL_STATES),
  history: z.array(HistorySchema).min(1).max(HISTORY_MAX),
}).superRefine((p, ctx) => {
  const bad = (message) => ctx.addIssue({ code: 'custom', path: ['history'], message });
  const h = p.history;
  if (h.length === 0) return; // the array's own min(1) issue is reported; the refinement must not throw on it
  if (h[0].state !== 'pending') bad('the first history entry must be the pending creation');
  if (h[h.length - 1].state !== p.state) bad('state must equal the last history entry');
  h.slice(1).forEach((e, i) => {
    if (e.state === 'pending') bad('only the first history entry may be pending');
    if (!e.detail) bad(`history entry ${i + 1} needs a detail (the reason or ref)`);
  });
  if (h.slice(0, -1).some((e) => FINAL_STATES.includes(e.state))) bad('nothing may follow a final state');
});

export const isFinal = (p) => FINAL_STATES.includes(p.state);
export const isOpen = (p) => OPEN_STATES.includes(p.state);

// ── Paths and ids ───────────────────────────────────────────────────────────

const root = (dir) => path.join(dir, 'proposals');
const closedRoot = (dir) => path.join(root(dir), 'closed');
/** The one serialisation: writers check it against the SAME byte limit readers enforce. */
function serialize(record) {
  const body = `${JSON.stringify(record, null, 2)}\n`;
  const bytes = Buffer.byteLength(body, 'utf8');
  // A final state may use the whole limit; anything else leaves the closing entry's room free.
  const limit = FINAL_STATES.includes(record.state) ? MAX_RECORD_BYTES : MAX_RECORD_BYTES - FINAL_RESERVE_BYTES;
  if (bytes > limit) {
    throw Object.assign(new Error(`proposal ${record.id} would be ${bytes} bytes, over the ${limit / 1024} KiB limit for a ${record.state} record (${FINAL_STATES.includes(record.state) ? '' : `${FINAL_RESERVE_BYTES / 1024} KiB stay free so it can always be closed; `}decide it with a final outcome (done or declined))`), { code: 'EPROPOSAL_TOO_LARGE' });
  }
  return body;
}
const writeJson = (file, record) => atomicWriteFileSync(file, serialize(record));

/** `p-<yyyymmddhhmmss>-<4 hex>`. */
export function newProposalId(now = new Date()) {
  return `p-${now.toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${crypto.randomBytes(2).toString('hex')}`;
}

// ── Input parsing ───────────────────────────────────────────────────────────

/**
 * A PR reference as the user typed it: `#12`, `12`, or a PR URL. A URL keeps its repository so the recheck asks that
 * repository, not a same-numbered PR here.
 * @returns {{ok: true, ref: string, repo?: string}|{ok: false, reason: string}}
 */
export function parsePrRef(input) {
  const s = String(input ?? '').trim();
  const num = /^#?([1-9][0-9]*)$/.exec(s);
  if (num) return { ok: true, ref: `#${num[1]}` };
  const url = /^https?:\/\/([^/\s:]+)(?::\d+)?\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)(?:[/?#].*)?$/.exec(s);
  // The host is part of the PR's identity: another host's PR #7 is not github.com's PR #7.
  if (url) return { ok: true, ref: `#${url[4]}`, repo: `${url[1].toLowerCase() === 'github.com' ? '' : `${url[1].toLowerCase()}/`}${url[2]}/${url[3]}` };
  return { ok: false, reason: `not a PR reference (#12, 12, or a PR URL): ${JSON.stringify(s.slice(0, 80))}` };
}

/** `--blocked-by`: a PR reference, else a bare branch name. */
export function parseBlockedBy(input) {
  const s = String(input ?? '').trim();
  if (s === '') return { ok: false, reason: '--blocked-by must not be empty' };
  const pr = parsePrRef(s);
  if (pr.ok) return { ok: true, value: { kind: 'pr', ref: pr.ref, ...(pr.repo ? { repo: pr.repo } : {}) } };
  if (isBranchName(s)) return { ok: true, value: { kind: 'branch', ref: s } };
  return { ok: false, reason: `--blocked-by ${JSON.stringify(s.slice(0, 80))} is neither a PR (#12, 12, a PR URL) nor a bare branch name` };
}

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * @typedef {{records: object[], complete: boolean, truncated: boolean, unmeasured: boolean, reason?: string,
 *   unreadable: Array<{file: string, reason: string}>, unsupported: Array<{file: string, reason: string}>}} ReadResult
 */

function classify(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { invalid: 'not an object' };
  if (raw.schemaVersion !== 1) return { unsupported: `schemaVersion ${JSON.stringify(raw.schemaVersion)} is not understood by this fleet` };
  const p = ProposalSchema.safeParse(raw);
  return p.success ? { proposal: p.data } : { invalid: p.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ') };
}

/** One directory's records: `{names, truncated}` or `{error, missing}`. */
function listJson(d, cap) {
  let names;
  try { names = fs.readdirSync(d).filter((n) => n.endsWith('.json')).sort(); } catch (e) {
    return e.code === 'ENOENT' ? { names: [], truncated: false, missing: true } : { error: `unreadable: ${e.code ?? e.message}` };
  }
  return names.length > cap ? { names: names.slice(0, cap), truncated: true } : { names, truncated: false };
}

/** Is there a closed copy of `id`? Any failure to look reads as "no", the direction that reports the gap. */
function closedHas(dir, id) {
  try { return fs.readdirSync(closedRoot(dir)).some((m) => fs.existsSync(path.join(closedRoot(dir), m, `${id}.json`))); } catch { return false; }
}

/**
 * Read the proposals. Active records only by default (what every checkpoint surface needs); `closed:true` adds the
 * archived ones. A record that cannot be understood is a diagnostic, never silently dropped.
 *
 * Move-aware: a record only ever moves active -> closed, so the active directory is read FIRST, then `closed/`,
 * then the two are reconciled by id with the `closed/` copy winning. An active file that vanishes between listing
 * and opening is only ever skipped once a closed copy is found (in the `closed/` scan, or for an active-only read by a
 * bounded lookup of that one file name); otherwise it is reported unreadable and the read is incomplete.
 *
 * @param {string} dir the fleet registry directory
 * @param {{cap?: number, closed?: boolean}} [opts]
 * @returns {ReadResult}
 */
export function readProposals(dir, { cap = PROPOSALS_CAP, closed = false } = {}) {
  const out = { records: [], complete: true, truncated: false, unmeasured: false, unreadable: [], unsupported: [] };
  const byId = new Map();
  const vanished = [];
  const take = (d, names, { fromClosed }) => {
    for (const n of names) {
      const file = path.join(d, n);
      let size;
      try { size = fs.statSync(file).size; } catch (e) {
        if (e.code === 'ENOENT' && !fromClosed) { vanished.push(n); continue; }
        out.unreadable.push({ file: n, reason: `unreadable: ${e.code ?? e.message}` }); continue;
      }
      if (size > MAX_RECORD_BYTES) { out.unreadable.push({ file: n, reason: `larger than ${MAX_RECORD_BYTES / 1024} KiB (${size} bytes)` }); continue; }
      let raw;
      try { raw = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) {
        if (e.code === 'ENOENT' && !fromClosed) { vanished.push(n); continue; }
        out.unreadable.push({ file: n, reason: `unreadable: ${e.message}` }); continue;
      }
      const c = classify(raw);
      if (c.proposal) {
        if (`${c.proposal.id}.json` !== n) out.unreadable.push({ file: n, reason: 'embedded id does not match the filename' });
        else byId.set(c.proposal.id, { ...c.proposal, closed: fromClosed });
      } else if (c.unsupported) out.unsupported.push({ file: n, reason: c.unsupported });
      else out.unreadable.push({ file: n, reason: c.invalid });
    }
  };

  const active = listJson(root(dir), cap);
  if (active.error) return { ...out, complete: false, unmeasured: true, reason: active.error };
  if (active.truncated) { out.truncated = true; out.complete = false; out.reason = `more than ${cap} active proposals; only the first ${cap} were read`; }
  take(root(dir), active.names, { fromClosed: false });

  if (closed) {
    let months = [];
    try { months = fs.readdirSync(closedRoot(dir)).sort(); } catch (e) {
      if (e.code !== 'ENOENT') { out.complete = false; out.reason = `closed/ unreadable: ${e.code ?? e.message}`; }
    }
    let budget = cap;
    for (const m of months) {
      const l = listJson(path.join(closedRoot(dir), m), budget);
      if (l.error) { out.complete = false; out.reason = `closed/${m} ${l.error}`; continue; }
      if (l.truncated) { out.truncated = true; out.complete = false; out.reason = `more than ${cap} closed proposals; only the first ${cap} were read`; }
      budget = Math.max(0, budget - l.names.length);
      take(path.join(closedRoot(dir), m), l.names, { fromClosed: true });
    }
  }
  // A file that vanished between listing and opening is EVIDENCE of nothing until it is found closed: the reader
  // does not infer an outcome. Found in closed/ (already read, or by a bounded lookup of one file name per month) it is
  // simply not open; otherwise the read is incomplete and says which file.
  for (const n of vanished) {
    const id = n.replace(/\.json$/, '');
    if (!byId.has(id) && !closedHas(dir, id)) out.unreadable.push({ file: n, reason: 'vanished while reading and was not found in closed/' });
  }
  out.records = [...byId.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
  if (out.unreadable.length || out.unsupported.length) out.complete = false;
  return out;
}

// ── Writing (the caller holds `fleet/.lock`) ────────────────────────────────

/** Does `file` exist? Only ENOENT means no: any other failure is NOT proof of absence, so it propagates. */
function exists(file) {
  try { fs.statSync(file); return true; } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw Object.assign(new Error(`cannot establish whether ${path.basename(file)} exists (${e.code ?? e.message})`), { code: 'EPROPOSAL_UNVERIFIABLE' });
  }
}

/** Is `id` taken, in the active directory or any month of `closed/`? Throws `EPROPOSAL_UNVERIFIABLE` when it cannot tell. */
export function proposalIdExists(dir, id) {
  if (exists(path.join(root(dir), `${id}.json`))) return true;
  let months;
  try { months = fs.readdirSync(closedRoot(dir)); } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw Object.assign(new Error(`cannot read closed/ to check id uniqueness (${e.code ?? e.message})`), { code: 'EPROPOSAL_UNVERIFIABLE' });
  }
  return months.some((m) => exists(path.join(closedRoot(dir), m, `${id}.json`)));
}

/** Write a NEW proposal. An id is unique across active AND closed records; a collision is `code: 'EPROPOSAL_EXISTS'`. */
export function writeProposal(dir, record) {
  const p = ProposalSchema.parse(record);
  const file = assertManaged(dir, path.join(root(dir), `${p.id}.json`));
  if (proposalIdExists(dir, p.id)) throw Object.assign(new Error(`proposal ${p.id} already exists`), { code: 'EPROPOSAL_EXISTS' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, p);
  return p;
}

/**
 * A new pending record.
 * @param {{id: string, what: string, where: string, why: string, evidence?: string, theme?: string,
 *   blockedBy?: object, originator: {id: string, branch: string|null}, at: string}} a
 */
export function newProposal({ id, what, where, why, evidence, theme, blockedBy, originator, at }) {
  return ProposalSchema.parse({
    schemaVersion: 1, id, what, where, why,
    ...(evidence !== undefined ? { evidence } : {}), ...(theme !== undefined ? { theme } : {}), ...(blockedBy ? { blockedBy } : {}),
    originator, createdAt: at, state: 'pending', history: [{ at, state: 'pending', by: originator.id }],
  });
}

/**
 * Pure: apply one outcome. `detail` is the required reason or ref (a PR is normalised to `#N` / `owner/name#N`).
 * @returns {{ok: true, record: object}|{ok: false, reason: string}}
 */
export function applyOutcome(p, { state, detail, by, at }) {
  if (!['folded', 'queued', 'declined', 'done'].includes(state)) return { ok: false, reason: `${JSON.stringify(state)} is not an outcome (folded, queued, declined, done)` };
  if (isFinal(p)) return { ok: false, reason: `proposal ${p.id} is already ${p.state}; final outcomes are not changed (record a new proposal instead)` };
  let d = String(detail ?? '').trim();
  if (d === '') return { ok: false, reason: `${state} needs ${state === 'done' ? 'the PR that resolved it' : state === 'folded' ? 'the session it was folded into' : 'a reason'}` };
  if (state === 'done') {
    const pr = parsePrRef(d);
    if (!pr.ok) return { ok: false, reason: `done needs a PR reference: ${pr.reason}` };
    d = pr.repo ? `${pr.repo}${pr.ref}` : pr.ref;
  }
  if (p.state === 'folded' && state === 'folded') return { ok: false, reason: `proposal ${p.id} is already folded; record queued, declined or done` };
  const last = !FINAL_STATES.includes(state);
  // The 50th history slot is reserved so a record can always be closed.
  if (last && p.history.length + 1 >= HISTORY_MAX) {
    return { ok: false, reason: `proposal ${p.id} history is nearly full (${p.history.length} of ${HISTORY_MAX}); decide it with a final outcome (done or declined)` };
  }
  if (p.history.length >= HISTORY_MAX) return { ok: false, reason: `proposal ${p.id} history is full (${HISTORY_MAX})` };
  const { closed: _closed, ...rec } = p; // a read result carries `closed`; the stored record does not
  const parsed = ProposalSchema.safeParse({ ...rec, state, history: [...p.history, { at, state, by, detail: d }] });
  if (!parsed.success) return { ok: false, reason: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ') };
  return { ok: true, record: parsed.data };
}

/**
 * Move a FINAL record to `closed/<yyyy-mm>/`. Idempotent; never throws.
 * @returns {{archived: true}|{archived: false, reason: string}}
 */
export function archiveProposal(dir, p, { rename = fs.renameSync } = {}) {
  try {
    const from = assertManaged(dir, path.join(root(dir), `${p.id}.json`));
    const month = String(p.history[p.history.length - 1].at).slice(0, 7);
    const to = assertManaged(dir, path.join(closedRoot(dir), month, `${p.id}.json`));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (!fs.existsSync(from)) return fs.existsSync(to) ? { archived: true } : { archived: false, reason: `${p.id}.json is in neither proposals/ nor closed/` };
    // Never replace a closed record with another: ids are unique across both directories, so this is corruption to report.
    if (fs.existsSync(to)) return { archived: false, reason: `closed/ already holds a different record with id ${p.id}; not overwritten` };
    rename(from, to);
    return { archived: true };
  } catch (e) { return { archived: false, reason: e.message }; }
}

/**
 * Archive every committed-but-not-archived final record left in `proposals/` (a crash or rename failure between a
 * final write and its move). Each record is isolated: one failing never blocks the rest or the caller.
 * @returns {{moved: string[], failed: Array<{id: string, reason: string}>}}
 */
export function sweepStranded(dir, { rename } = {}) {
  const moved = []; const failed = [];
  // Bounded like every read: the active directory should never approach the cap, and when it does the read says so.
  const r = readProposals(dir);
  for (const p of r.records.filter(isFinal)) {
    const a = archiveProposal(dir, p, { rename });
    if (a.archived) moved.push(p.id); else failed.push({ id: p.id, reason: a.reason });
  }
  return { moved, failed, ...(r.truncated ? { truncated: true } : {}) };
}

/**
 * Record one outcome on proposal `id` (the caller holds the lock). The atomic write of the new state is the commit;
 * for a final state the archival follows and its failure is reported as `archivalPending`, not as a failed command.
 * @returns {{ok: true, record: object, archived: boolean, archivalPending?: string}|{ok: false, reason: string, code?: string}}
 */
export function transitionProposal(dir, id, change, { rename } = {}) {
  if (!PROPOSAL_ID_RE.test(String(id))) return { ok: false, reason: `not a proposal id: ${JSON.stringify(id)}`, code: 'bad-id' };
  const file = assertManaged(dir, path.join(root(dir), `${id}.json`));
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) {
    if (e.code !== 'ENOENT') return { ok: false, reason: `proposal ${id} is unreadable (${e.message}); not modified` };
    const c = readProposals(dir, { closed: true }).records.find((p) => p.id === id);
    return c ? { ok: false, reason: `proposal ${id} is already ${c.state}; final outcomes are not changed`, code: 'final' } : { ok: false, reason: `no proposal ${id}`, code: 'unknown' };
  }
  const c = classify(raw);
  if (c.proposal && c.proposal.id !== id) return { ok: false, reason: `${id}.json holds proposal ${c.proposal.id} (embedded id does not match the filename); not modified` };
  if (!c.proposal) return { ok: false, reason: c.unsupported ? `proposal ${id} is not understood by this fleet (${c.unsupported}); not modified` : `proposal ${id} is invalid (${c.invalid}); not modified` };
  const next = applyOutcome(c.proposal, change);
  if (!next.ok) return { ok: false, reason: next.reason, code: isFinal(c.proposal) ? 'final' : 'refused' };
  try { writeJson(file, next.record); } catch (e) { // the commit point
    if (e.code === 'EPROPOSAL_TOO_LARGE') return { ok: false, reason: e.message, code: 'refused' };
    throw e;
  }
  if (!isFinal(next.record)) return { ok: true, record: next.record, archived: false };
  const a = archiveProposal(dir, next.record, { rename });
  return { ok: true, record: next.record, archived: a.archived, ...(a.archived ? {} : { archivalPending: a.reason }) };
}

// ── Summary and the one line every surface prints ───────────────────────────

/**
 * What a surface says about the queue. `unmeasured` when the directory cannot be listed; `complete:false` makes the
 * counts lower bounds.
 * @param {ReadResult} read
 * @param {Date|number} now
 */
export function proposalsSummary(read, now) {
  if (read.unmeasured) return { state: 'unmeasured', reason: read.reason ?? 'the proposals directory could not be read' };
  const nowMs = now instanceof Date ? now.getTime() : (typeof now === 'number' ? now : Date.now());
  const open = read.records.filter(isOpen);
  const pending = open.filter((p) => p.state === 'pending');
  const ages = pending.map((p) => nowMs - Date.parse(p.createdAt));
  return {
    state: 'ok', complete: read.complete, truncated: read.truncated,
    unreadable: read.unreadable.length + read.unsupported.length,
    pending: pending.length, queued: open.filter((p) => p.state === 'queued').length, folded: open.filter((p) => p.state === 'folded').length,
    oldestPendingDays: ages.length ? Math.max(0, Math.floor(Math.max(...ages) / DAY_MS)) : null,
    stalePending: ages.filter((a) => a > PROPOSAL_STALE_DAYS * DAY_MS).length,
  };
}

/** The one `status`/`next` line. Shared, so the two surfaces never disagree. */
export function proposalsLine(s, cmd = 'fleet') {
  if (s.state === 'unmeasured') return `proposals: unmeasured (${s.reason}) — \`${cmd} proposals\` says what it could not read`;
  const lb = s.complete ? '' : '≥';
  const others = [s.queued ? `${s.queued} queued` : null, s.folded ? `${s.folded} folded` : null].filter(Boolean);
  const tail = others.length ? ` (${others.join(', ')})` : '';
  const warn = s.complete ? '' : ` — ${s.truncated ? 'read truncated' : `${s.unreadable} record(s) unreadable`}; \`${cmd} proposals\` names them`;
  if (s.pending === 0) return `proposals: ${s.complete ? 'none pending' : 'none pending among the records read'}${tail}${warn}`;
  const stale = s.stalePending ? ` — ${s.stalePending} pending more than ${PROPOSAL_STALE_DAYS}d: triage with \`${cmd} proposals\`` : '';
  return `proposals: ${lb}${s.pending} pending, oldest ${lb}${s.oldestPendingDays}d${tail}${stale}${warn}`;
}

/** Nothing worth saying at a checkpoint: measured, complete, and no open item at all. */
export const proposalsQuiet = (s) => s.state === 'ok' && s.complete && !s.pending && !s.queued && !s.folded;

/**
 * Read + summarise for `status`/`next`. Never throws.
 * @returns {{summary: object, read: ReadResult|null}}
 */
export function readProposalsSummary(dir, now) {
  try {
    if (!dir) return { summary: { state: 'unmeasured', reason: 'the git common dir could not be resolved' }, read: null };
    const read = readProposals(dir);
    return { summary: proposalsSummary(read, now), read };
  } catch (e) {
    return { summary: { state: 'unmeasured', reason: e.message }, read: null };
  }
}

// ── Listing helpers ─────────────────────────────────────────────────────────

export const NO_THEME = '(no theme)';

/** Group by theme: alphabetical themes, `(no theme)` last, each group oldest first. */
export function groupByTheme(records) {
  const m = new Map();
  for (const p of records) {
    const k = p.theme ?? NO_THEME;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(p);
  }
  const keys = [...m.keys()].sort((a, b) => (a === NO_THEME) - (b === NO_THEME) || a.localeCompare(b));
  return keys.map((theme) => ({ theme, items: m.get(theme).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id)) }));
}

/** Pending proposals originated by `id` (the `selfId` identity; the creation branch is provenance and never matched). */
export const originatedBy = (records, id) => records.filter((p) => p.state === 'pending' && p.originator.id === id);

// ── blockedBy recheck ───────────────────────────────────────────────────────

const blockerKey = (b) => (b.kind === 'pr' ? `pr:${b.repo ?? ''}${b.ref}` : `branch:${b.ref}`);
export const blockerText = (b) => (b.kind === 'pr' ? `PR ${b.repo ?? ''}${b.ref}` : `branch ${b.ref}`);

/**
 * Recheck each distinct `blockedBy` against facts. A label for the listing: nothing is promoted or scheduled. Every
 * failure is `unknown`, never `resolved`.
 *
 * @param {object[]} proposals
 * @param {{ghRun: (args: string[]) => {error?: Error, status: number|null, stdout?: string, stderr?: string},
 *   gitRun: (args: string[]) => {ok: boolean, status: number|null, stdout: string, reason: string|null},
 *   baseBranch: string|null}} io
 * @returns {Map<string, {state: 'resolved'|'waiting'|'closed-unmerged'|'gone'|'unknown', text: string}>}
 */
export function recheckBlockedBy(proposals, { ghRun, gitRun, baseBranch, baseError = null }) {
  const out = new Map();
  const distinct = [];
  for (const p of proposals) {
    if (!p.blockedBy) continue;
    const k = blockerKey(p.blockedBy);
    if (!out.has(k)) { out.set(k, null); distinct.push(p.blockedBy); }
  }
  distinct.forEach((b, i) => {
    const k = blockerKey(b);
    if (i >= RECHECK_MAX) { out.set(k, { state: 'unknown', text: `unknown (not checked: more than ${RECHECK_MAX} distinct blockers)` }); return; }
    try { out.set(k, b.kind === 'pr' ? checkPr(b, ghRun) : checkBranch(b, gitRun, baseBranch, baseError)); } catch (e) {
      out.set(k, { state: 'unknown', text: `unknown (${e.message})` });
    }
  });
  return out;
}

function checkPr(b, ghRun) {
  const args = ['pr', 'view', b.ref.slice(1), ...(b.repo ? ['--repo', b.repo] : []), '--json', 'state,mergedAt'];
  const res = ghRun(args);
  if (res.error) return { state: 'unknown', text: `unknown (${res.error.code === 'ENOENT' ? 'gh not installed' : res.error.message})` };
  if (res.status !== 0) return { state: 'unknown', text: `unknown (gh pr view exited ${res.status}: ${String(res.stderr ?? '').trim().split('\n')[0] || 'no output'})` };
  let j;
  try { j = JSON.parse(res.stdout); } catch { return { state: 'unknown', text: 'unknown (gh returned unparseable output)' }; }
  if (j?.state === 'MERGED') return { state: 'resolved', text: `resolved: ${blockerText(b)} merged` };
  if (j?.state === 'CLOSED') return { state: 'closed-unmerged', text: `${blockerText(b)} closed without merging` };
  if (j?.state === 'OPEN') return { state: 'waiting', text: `waiting on ${blockerText(b)}` };
  return { state: 'unknown', text: `unknown (unexpected PR state ${JSON.stringify(j?.state)})` };
}

/** Resolve a ref to a commit id: `{oid}`, `{missing:true}` (exit 1 under --quiet) or `{error}`. */
function oidOf(gitRun, ref) {
  const r = gitRun(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (r.ok && /^[0-9a-f]{40,64}$/.test(r.stdout.trim())) return { oid: r.stdout.trim() };
  return r.status === 1 ? { missing: true } : { error: r.reason ?? 'rev-parse gave no commit id' };
}

function checkBranch(b, gitRun, baseBranch, baseError) {
  if (!baseBranch) return { state: 'unknown', text: `unknown (${baseError ?? 'the base branch is not known'})` };
  const tips = [`refs/heads/${b.ref}`, `refs/remotes/origin/${b.ref}`].map((r) => oidOf(gitRun, r));
  const tipErr = tips.find((t) => t.error);
  if (tipErr) return { state: 'unknown', text: `unknown (${tipErr.error})` };
  const tipOids = [...new Set(tips.filter((t) => t.oid).map((t) => t.oid))];
  if (!tipOids.length) return { state: 'gone', text: `blocker ${blockerText(b)} is gone` };
  const bases = [`refs/heads/${baseBranch}`, `refs/remotes/origin/${baseBranch}`].map((r) => oidOf(gitRun, r));
  const baseErr = bases.find((x) => x.error);
  if (baseErr) return { state: 'unknown', text: `unknown (${baseErr.error})` };
  const baseOids = bases.filter((x) => x.oid).map((x) => x.oid);
  if (!baseOids.length) return { state: 'unknown', text: `unknown (base ${baseBranch} does not resolve to a commit)` };
  // Resolved only when EVERY existing tip (local and origin may differ) is already in a base: an unmerged tip is unmerged work.
  let failed = null; let allMerged = true;
  for (const tip of tipOids) {
    let merged = false;
    for (const bo of baseOids) {
      const a = gitRun(['merge-base', '--is-ancestor', tip, bo]);
      if (a.ok) { merged = true; break; }
      if (a.status !== 1) failed = a.reason ?? 'merge-base failed';
    }
    if (!merged) allMerged = false;
  }
  if (allMerged) return { state: 'resolved', text: `resolved: ${blockerText(b)} merged into ${baseBranch}` };
  return failed ? { state: 'unknown', text: `unknown (${failed})` } : { state: 'waiting', text: `waiting on ${blockerText(b)}` };
}

export { blockerKey };

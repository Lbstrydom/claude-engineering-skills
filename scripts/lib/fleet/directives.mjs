/**
 * @fileoverview Coordination records that need no host messaging: DIRECTIVES (a
 * coordinator asks sessions to pause, resume, rebase, release or re-run ready)
 * and the HOST sidecar (which host session id a fleet session runs as).
 *
 * Both live in NEW directories under the shared registry (`fleet/directives/`,
 * `fleet/hosts/`), so an older bundle's reader — which opens only `sessions/`
 * and `trains/` — never sees them: no existing record schema changes, and a
 * mixed-version fleet keeps working.
 *
 * Invariants:
 *  - **Closed vocabulary.** A directive kind is one of five safe actions; no
 *    merge, push, override or delete is expressible. The schema is the boundary.
 *  - **Version dispatch.** A record of an unknown `schemaVersion`, or a v1
 *    directive of an unknown kind, is collected as `unsupported`: listed, never
 *    actionable, never verified — and NEVER makes the session registry
 *    incomplete. A writer never rewrites a record it does not understand.
 *  - **Bounded reads.** Only `active/` is read at a checkpoint, capped; over the
 *    cap is `complete:false`, never "no directives". Expired and fully
 *    acknowledged records are MOVED to `archive/<yyyy-mm>/`, never deleted.
 *  - Writes happen inside `transact` (the caller holds `fleet/.lock`).
 *
 * Whether a directive is VERIFIED for a recipient is decided in
 * `obligations.mjs` — a directive adds attention, never authority.
 *
 * Plan: docs/plans/fleet-consumer-feedback-oct.md §2.4.
 *
 * @module scripts/lib/fleet/directives
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../file-io.mjs';
import { TRAIN_ID_RE, assertManaged, storageKey } from './registry.mjs';

export const DIRECTIVE_KINDS = Object.freeze(['pause', 'resume', 'rebase', 'release', 'rerun-ready']);
export const REASON_KINDS = Object.freeze(['pr-merged', 'hold', 'train', 'note']);
export const DIRECTIVE_ID_RE = /^d-[0-9]{14}-[0-9a-f]{4}$/;
/** At most this many active directives are read at a checkpoint. */
export const ACTIVE_CAP = 200;
export const DEFAULT_EXPIRY_HOURS = 24;

const NO_CONTROL = /^[^\u0000-\u001f\u007f]+$/;
const IsoSchema = z.string().refine((s) => Number.isFinite(Date.parse(s)), 'must be an ISO timestamp');
const Id = z.string().min(1).max(200).regex(NO_CONTROL, 'must not contain control characters');

const ReasonSchema = z.strictObject({
  kind: z.enum(REASON_KINDS),
  ref: z.string().min(1).max(200).regex(NO_CONTROL).optional(),
  note: z.string().max(500).optional(),
}).superRefine((r, ctx) => {
  const bad = (message) => ctx.addIssue({ code: 'custom', path: ['ref'], message });
  if (r.kind === 'note') { if (!r.note) ctx.addIssue({ code: 'custom', path: ['note'], message: 'a note reason needs --note' }); return; }
  if (!r.ref) return bad(`a ${r.kind} reason needs --ref`);
  if (r.kind === 'pr-merged' && !/^#[1-9][0-9]*$/.test(r.ref)) bad('a pr-merged ref is #<number>');
  if (r.kind === 'hold' && !Number.isFinite(Date.parse(r.ref))) bad('a hold ref is the hold event time (ISO)');
  if (r.kind === 'train' && !TRAIN_ID_RE.test(r.ref)) bad('a train ref is a train id (t-<14 digits>-<4 hex>)');
});

export const AckSchema = z.strictObject({
  session: Id, at: IsoSchema, outcome: z.enum(['done', 'declined']), note: z.string().max(500).optional(),
});

export const DirectiveSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().regex(DIRECTIVE_ID_RE),
  to: Id, // a session id, or "all"
  kind: z.enum(DIRECTIVE_KINDS),
  reason: ReasonSchema,
  by: z.string().max(200),
  createdAt: IsoSchema,
  expiresAt: IsoSchema,
  acks: z.array(AckSchema),
});

export const HostSchema = z.strictObject({
  schemaVersion: z.literal(1), id: Id, hostSession: z.string().min(1).max(200).regex(NO_CONTROL), updatedAt: IsoSchema,
});

const directivesDir = (dir) => path.join(dir, 'directives');
const activeDir = (dir) => path.join(directivesDir(dir), 'active');
const archiveDir = (dir, at) => path.join(directivesDir(dir), 'archive', String(at).slice(0, 7));
const hostsDir = (dir) => path.join(dir, 'hosts');
const writeJson = (file, value) => atomicWriteFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

/** `d-<yyyymmddhhmmss>-<4 hex>`. */
export function newDirectiveId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `d-${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

/**
 * Classify one parsed record: a valid v1 directive, `unsupported` (a version or
 * kind this reader does not know — the NEXT release's record), or `invalid`.
 * @returns {{directive?: object, unsupported?: object, invalid?: string}}
 */
export function classifyDirective(raw) {
  if (!raw || typeof raw !== 'object') return { invalid: 'not an object' };
  if (raw.schemaVersion !== 1) return { unsupported: { id: raw.id ?? null, reason: `schemaVersion ${JSON.stringify(raw.schemaVersion)} is not understood by this fleet` } };
  if (typeof raw.kind === 'string' && !DIRECTIVE_KINDS.includes(raw.kind)) {
    return { unsupported: { id: raw.id ?? null, kind: raw.kind, reason: `kind ${JSON.stringify(raw.kind)} is not understood by this fleet` } };
  }
  const p = DirectiveSchema.safeParse(raw);
  return p.success ? { directive: p.data } : { invalid: p.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ') };
}

function readDirFiles(d, cap) {
  let names;
  try { names = fs.readdirSync(d).filter((n) => n.endsWith('.json')).sort(); } catch (e) {
    return e.code === 'ENOENT' ? { names: [], complete: true } : { names: [], complete: false, reason: `unreadable: ${e.message}` };
  }
  return names.length > cap ? { names: names.slice(0, cap), complete: false, reason: `more than ${cap} records; only the first ${cap} were read` } : { names, complete: true };
}

/**
 * Directive records. Active only by default (the checkpoint read); `archive:true`
 * adds the archived history.
 * @returns {{active: object[], archived: object[], unsupported: object[], invalid: Array<{file: string, reason: string}>, complete: boolean, reason?: string}}
 */
export function readDirectives(dir, { archive = false, cap = ACTIVE_CAP } = {}) {
  const out = { active: [], archived: [], unsupported: [], invalid: [], complete: true };
  const take = (d, bucket) => {
    const r = readDirFiles(d, cap);
    if (!r.complete) { out.complete = false; out.reason = r.reason; }
    for (const n of r.names) {
      let raw;
      try { raw = JSON.parse(fs.readFileSync(path.join(d, n), 'utf-8')); } catch (e) { out.invalid.push({ file: n, reason: `unreadable: ${e.message}` }); continue; }
      const c = classifyDirective(raw);
      if (c.directive) {
        if (`${c.directive.id}.json` !== n) out.invalid.push({ file: n, reason: 'embedded id does not match the filename' });
        else out[bucket].push(c.directive);
      } else if (c.unsupported) out.unsupported.push({ file: n, ...c.unsupported });
      else out.invalid.push({ file: n, reason: c.invalid });
    }
  };
  take(activeDir(dir), 'active');
  if (archive) {
    let months = [];
    try { months = fs.readdirSync(path.join(directivesDir(dir), 'archive')).sort(); } catch (e) {
      if (e.code !== 'ENOENT') { out.complete = false; out.reason = `archive unreadable: ${e.message}`; }
    }
    for (const m of months) take(path.join(directivesDir(dir), 'archive', m), 'archived');
  }
  return out;
}

/** Write a NEW directive (caller holds `fleet/.lock`). Refuses to overwrite an existing id. */
export function writeDirective(dir, record) {
  const d = DirectiveSchema.parse(record);
  const file = assertManaged(dir, path.join(activeDir(dir), `${d.id}.json`));
  if (fs.existsSync(file)) throw new Error(`directive ${d.id} already exists`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, d);
  return d;
}

/**
 * Append `ack` to directive `id` (caller holds `fleet/.lock`). Acks only grow; a
 * session that already acked is a no-op. A record this reader does not
 * understand is never rewritten.
 * @returns {{ok: true, directive: object, changed: boolean} | {ok: false, reason: string}}
 */
export function ackDirective(dir, id, ack) {
  if (!DIRECTIVE_ID_RE.test(String(id))) return { ok: false, reason: `not a directive id: ${JSON.stringify(id)}` };
  const file = assertManaged(dir, path.join(activeDir(dir), `${id}.json`));
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { return { ok: false, reason: e.code === 'ENOENT' ? `no active directive ${id}` : `unreadable: ${e.message}` }; }
  const c = classifyDirective(raw);
  if (!c.directive) return { ok: false, reason: c.unsupported ? `directive ${id} is not understood by this fleet (${c.unsupported.reason}); not modified` : `directive ${id} is invalid (${c.invalid}); not modified` };
  const d = c.directive;
  if (d.id !== id) return { ok: false, reason: `${id}.json holds directive ${d.id}; not modified` };
  if (d.to !== 'all' && d.to !== ack.session) return { ok: false, reason: `directive ${id} is addressed to ${d.to}, not ${ack.session}` };
  if (d.acks.some((a) => a.session === ack.session)) return { ok: true, directive: d, changed: false };
  const next = DirectiveSchema.parse({ ...d, acks: [...d.acks, AckSchema.parse(ack)] });
  writeJson(file, next);
  return { ok: true, directive: next, changed: true };
}

/**
 * Move expired directives, and addressed directives their recipient acknowledged,
 * to `archive/<yyyy-mm>/` (caller holds `fleet/.lock`). Moved, never deleted.
 * A `to:"all"` directive is archived only when it expires: "everyone" is not a
 * set this record can know is complete.
 * @returns {string[]} ids moved
 */
export function sweepDirectives(dir, now) {
  const moved = [];
  // Maintenance reads EVERY active record (no checkpoint cap), so records past the cap still age out.
  const { active } = readDirectives(dir, { cap: Infinity });
  for (const d of active) {
    const expired = Date.parse(d.expiresAt) <= now.getTime();
    const answered = d.to !== 'all' && d.acks.some((a) => a.session === d.to);
    if (!expired && !answered) continue;
    const from = assertManaged(dir, path.join(activeDir(dir), `${d.id}.json`));
    const to = assertManaged(dir, path.join(archiveDir(dir, d.createdAt), `${d.id}.json`));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    moved.push(d.id);
  }
  return moved;
}

/** Is directive `d` addressed to `sessionId`, and still open for it (unexpired, not acked by it)? */
export function isOpenFor(d, sessionId, now) {
  if (d.to !== 'all' && d.to !== sessionId) return false;
  if (Date.parse(d.expiresAt) <= now.getTime()) return false;
  return !d.acks.some((a) => a.session === sessionId);
}

// ── Host sidecar ────────────────────────────────────────────────────────────

/** Record which host session (e.g. a desktop session id) runs fleet session `id`. Caller holds the lock. */
export function writeHost(dir, { id, hostSession, at }) {
  const rec = HostSchema.parse({ schemaVersion: 1, id, hostSession, updatedAt: at });
  const file = assertManaged(dir, path.join(hostsDir(dir), `${storageKey(id)}.json`));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, rec);
  return rec;
}

/**
 * Host ids by fleet session id. Unknown versions and malformed files are skipped
 * AND listed — never a reason to doubt the session registry.
 * @returns {{hosts: Record<string, string>, skipped: Array<{file: string, reason: string}>}}
 */
export function readHosts(dir) {
  const out = { hosts: {}, skipped: [] };
  let names = [];
  try { names = fs.readdirSync(hostsDir(dir)).filter((n) => n.endsWith('.json')); } catch { return out; }
  for (const n of names.sort()) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(hostsDir(dir), n), 'utf-8'));
      const p = HostSchema.safeParse(raw);
      if (!p.success) { out.skipped.push({ file: n, reason: raw?.schemaVersion !== 1 ? 'unknown schemaVersion' : 'schema' }); continue; }
      if (`${storageKey(p.data.id)}.json` !== n) { out.skipped.push({ file: n, reason: 'embedded id does not hash to this filename' }); continue; }
      out.hosts[p.data.id] = p.data.hostSession;
    } catch (e) { out.skipped.push({ file: n, reason: e.message }); }
  }
  return out;
}

/**
 * @fileoverview Decision records — a durable channel for a user decision, in the user's exact words
 * (docs/plans/ship-record-catchup.md §2.6; gd-afeu finding 7).
 *
 * A chat approval dies with the transcript; a decision record does not. It holds the words, who recorded them and when,
 * and is IMMUTABLE: a revocation is a separate record, never an edit.
 *
 * **A declaration, not verified authority.** No code here can prove the words came from the user — any process that can
 * run fleet can write a record. So nothing treats a decision as the safety boundary: `ship-commit.mjs --record` checks
 * the change itself against HEAD regardless, and the decision's id rides in the commit (`AI-Decision`) so whoever
 * approves the merge reads the words first. **Closed scope**: `record-catchup` and `note`; no merge, push or override
 * value exists, so none can be granted.
 *
 * Storage: `fleet/decisions/<id>.json` in the shared registry — a NEW directory, so an older bundle's reader never sees
 * it. Writes happen inside `transact` (the caller holds `fleet/.lock`). Pure of fleet's command layer, so ship-commit can
 * import the reader without fleet's whole graph.
 *
 * @module scripts/lib/fleet/decisions
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../file-io.mjs';
import { assertManaged } from './registry.mjs';

export const DECISION_SCOPES = Object.freeze(['record-catchup', 'note']);
export const DECISION_ID_RE = /^dec-[0-9]{14}-[0-9a-f]{4}$/;
export const REVOCATION_ID_RE = /^rev-[0-9]{14}-[0-9a-f]{4}$/;
export const WORDS_MAX = 4000;
/** At most this many records are read; over it the read is `complete:false`, never "none". */
export const DECISIONS_CAP = 500;
export const GRANTS_NOTE = 'a decision records the user\'s words; it grants only its scope, and never a merge';

const NO_CONTROL_EXCEPT_NEWLINE = /^[^\u0000-\u0008\u000b-\u001f\u007f]+$/;
const IsoSchema = z.string().refine((s) => Number.isFinite(Date.parse(s)), 'must be an ISO timestamp');
const Words = z.string().min(1).max(WORDS_MAX).regex(NO_CONTROL_EXCEPT_NEWLINE, 'must not contain control characters');
const By = z.strictObject({ session: z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/), hostSession: z.string().max(200).nullable() });

export const DecisionSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('decision'), id: z.string().regex(DECISION_ID_RE),
  at: IsoSchema, scope: z.enum(DECISION_SCOPES), words: Words, recordedBy: By, expiresAt: IsoSchema.nullable(),
});
export const RevocationSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('revocation'), id: z.string().regex(REVOCATION_ID_RE),
  at: IsoSchema, revokes: z.string().regex(DECISION_ID_RE), words: Words, recordedBy: By,
});

export const decisionsDir = (dir) => path.join(dir, 'decisions');

const stampOf = (now) => now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
export const newDecisionId = (now = new Date()) => `dec-${stampOf(now)}-${crypto.randomBytes(2).toString('hex')}`;
export const newRevocationId = (now = new Date()) => `rev-${stampOf(now)}-${crypto.randomBytes(2).toString('hex')}`;

/** Classify a parsed record. Unknown version/kind/scope ⇒ `unsupported` (listed, never active); malformed ⇒ `invalid`. */
export function classifyRecord(raw) {
  if (!raw || typeof raw !== 'object') return { invalid: 'not an object' };
  if (raw.schemaVersion !== 1) return { unsupported: { id: raw.id ?? null, reason: `schemaVersion ${JSON.stringify(raw.schemaVersion)} is not understood by this fleet` } };
  if (raw.kind === 'decision' && typeof raw.scope === 'string' && !DECISION_SCOPES.includes(raw.scope)) {
    return { unsupported: { id: raw.id ?? null, reason: `scope ${JSON.stringify(raw.scope)} is not understood by this fleet` } };
  }
  const schema = raw.kind === 'decision' ? DecisionSchema : raw.kind === 'revocation' ? RevocationSchema : null;
  if (!schema) return { unsupported: { id: raw.id ?? null, reason: `kind ${JSON.stringify(raw.kind)} is not understood by this fleet` } };
  const p = schema.safeParse(raw);
  return p.success ? { record: p.data } : { invalid: p.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ') };
}

/**
 * Read every record (bounded). Never throws.
 * @returns {{decisions: object[], revocations: object[], unsupported: object[], invalid: Array<{file:string, reason:string}>, complete: boolean, reason?: string}}
 */
export function readDecisions(dir, { cap = DECISIONS_CAP } = {}) {
  const out = { decisions: [], revocations: [], unsupported: [], invalid: [], complete: true };
  let names;
  try { names = fs.readdirSync(decisionsDir(dir)).filter((n) => n.endsWith('.json')).sort(); } catch (e) {
    if (e.code === 'ENOENT') return out;
    return { ...out, complete: false, reason: `unreadable: ${e.message}` };
  }
  if (names.length > cap) { out.complete = false; out.reason = `more than ${cap} records; only the first ${cap} were read`; names = names.slice(0, cap); }
  for (const n of names) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(decisionsDir(dir), n), 'utf8')); } catch (e) { out.invalid.push({ file: n, reason: `unreadable: ${e.message}` }); continue; }
    const c = classifyRecord(raw);
    if (c.record) {
      if (`${c.record.id}.json` !== n) out.invalid.push({ file: n, reason: 'embedded id does not match the filename' });
      else (c.record.kind === 'decision' ? out.decisions : out.revocations).push(c.record);
    } else if (c.unsupported) out.unsupported.push({ file: n, ...c.unsupported });
    else out.invalid.push({ file: n, reason: c.invalid });
  }
  return out;
}

/**
 * Is decision `id` active for `scope` at `now`? Fail closed: an incomplete read, a revocation, an expiry, another scope
 * or an absent id each refuse with its own reason.
 * @returns {{ok: true, decision: object} | {ok: false, reason: string}}
 */
export function activeDecision(dir, id, scope, now = new Date()) {
  if (!DECISION_ID_RE.test(String(id ?? ''))) return { ok: false, reason: `${JSON.stringify(id ?? null)} is not a decision id (dec-<14 digits>-<4 hex>)` };
  const r = readDecisions(dir);
  const d = r.decisions.find((x) => x.id === id);
  if (!d) return { ok: false, reason: r.complete ? `no decision ${id} in this repository's fleet registry` : `decision ${id} not found, and the registry read was incomplete (${r.reason})` };
  if (d.scope !== scope) return { ok: false, reason: `decision ${id} is scoped ${d.scope}, not ${scope}` };
  const rev = r.revocations.find((x) => x.revokes === id);
  if (rev) return { ok: false, reason: `decision ${id} was revoked by ${rev.id} at ${rev.at}` };
  if (!r.complete) return { ok: false, reason: `the registry read was incomplete (${r.reason}), so a revocation may be unread` };
  if (d.expiresAt && Date.parse(d.expiresAt) <= now.getTime()) return { ok: false, reason: `decision ${id} expired at ${d.expiresAt}` };
  return { ok: true, decision: d };
}

/** Write a NEW record (caller holds `fleet/.lock`). Refuses to overwrite an existing id. */
export function writeRecord(dir, record) {
  const r = (record.kind === 'decision' ? DecisionSchema : RevocationSchema).parse(record);
  const file = assertManaged(dir, path.join(decisionsDir(dir), `${r.id}.json`));
  if (fs.existsSync(file)) throw new Error(`decision record ${r.id} already exists`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
  return r;
}

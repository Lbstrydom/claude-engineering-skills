/**
 * @fileoverview Where a stacked session forked: `claim --base <branch>` records the stack base's COMMIT at claim time, so
 * overlap is measured from that fixed fork point, not from wherever the branch name points later (audit R3 H1/M1: a base
 * fast-forwarded onto the session's own work, or one that absorbed commits made before the claim, is indistinguishable from
 * a fresh stacked branch by the graph alone).
 *
 * **Immutable, create-only** (audit R4/R5): one file per (session id, claim gen, base name) under `fleet/stack-bases/`,
 * written with `wx` and never overwritten or deleted. So no partial write, crash or re-claim can move or lose a fork point:
 *  - a re-claim of the same gen and base finds its file and keeps it;
 *  - switching base, or a new gen, is a NEW key; un-stacking just stops naming one (the session's `source.baseRef`);
 *  - a file written for a claim whose session write then failed is matched only if that exact (gen, base) is later claimed,
 *    and then it holds that base's commit from a moment earlier — still a commit of the base, so still a sound fork point;
 *  - an unreadable or invalid file is never replaced: the session is measured conservatively, from the repo's base.
 * A NEW directory beside `sessions/` (the `decisions/` pattern): the session schema is strict and shared by every worktree's
 * bundle, and an older bundle never reads this one.
 *
 * @module scripts/lib/fleet/stack-bases
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { OID_RE } from './contracts.mjs';
import { assertManaged, storageKey } from './registry.mjs';

export const stackBasesDir = (dir) => path.join(dir, 'stack-bases');
const keyOf = (id, gen, base) => `${storageKey(id)}-g${gen}-${crypto.createHash('sha256').update(base).digest('hex').slice(0, 12)}`;
const fileFor = (dir, id, gen, base) => assertManaged(dir, path.join(stackBasesDir(dir), `${keyOf(id, gen, base)}.json`));

export const StackBaseSchema = z.strictObject({
  schemaVersion: z.literal(1), id: z.string().min(1).max(200), gen: z.number().int().min(1),
  base: z.string().min(1).max(250), oid: z.string().regex(OID_RE), at: z.string(),
});

/**
 * Record a session's fork point for (id, gen, base) if none exists. Create-only: an existing file — valid, invalid or
 * unreadable — is left exactly as it is. The caller holds `fleet/.lock`.
 * @returns {{created: boolean}}
 */
export function writeStackBase(dir, { id, gen, base, oid, at }) {
  const rec = StackBaseSchema.parse({ schemaVersion: 1, id, gen, base, oid, at });
  const file = fileFor(dir, id, gen, base);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`, { flag: 'wx' });
    return { created: true };
  } catch (e) {
    if (e.code === 'EEXIST') return { created: false };
    throw e;
  }
}

/**
 * The fork point for one session's CURRENT claim (its gen and `source.baseRef`), or why there is none. Never throws: an
 * absent, unreadable or invalid record is a reason, and the caller measures conservatively (from the repo's base).
 * @returns {{ok: true, oid: string} | {ok: false, reason: string}}
 */
export function stackBaseFor(dir, session) {
  const base = session.source?.baseRef;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(fileFor(dir, session.id, session.gen, base), 'utf8')); } catch (e) {
    return { ok: false, reason: e.code === 'ENOENT' ? 'no fork point recorded for this claim (an older fleet made it, or the base did not predate the session\'s own commits at claim)' : `fork-point record unreadable (${e.message})` };
  }
  const p = StackBaseSchema.safeParse(raw);
  if (!p.success) return { ok: false, reason: 'fork-point record failed validation' };
  const r = p.data;
  if (r.id !== session.id || r.gen !== session.gen || r.base !== base) return { ok: false, reason: 'fork-point record does not match this claim' };
  return { ok: true, oid: r.oid };
}

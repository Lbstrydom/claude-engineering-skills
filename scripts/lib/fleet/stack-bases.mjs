/**
 * @fileoverview Where a stacked session forked: `claim --base <branch>` records the stack base's COMMIT at claim time, so
 * overlap is measured from that fixed fork point, not from wherever the branch name points later (audit R3 H1/M1: a base
 * fast-forwarded onto the session's own work, or one that absorbed commits made before the claim, is indistinguishable from
 * a fresh stacked branch by the graph alone).
 *
 * One file per session under `fleet/stack-bases/`, keyed like the session registry and tied to the claim's `gen`, so a
 * released-and-reclaimed id never inherits an old fork point. A NEW directory beside `sessions/`: the session schema is
 * strict and shared by every worktree's bundle, and an older bundle never reads this one (the `decisions/` pattern). The
 * branch name itself stays in the session's existing `source.baseRef`.
 *
 * @module scripts/lib/fleet/stack-bases
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../file-io.mjs';
import { OID_RE } from './contracts.mjs';
import { assertManaged, storageKey } from './registry.mjs';

export const stackBasesDir = (dir) => path.join(dir, 'stack-bases');
const fileFor = (dir, id) => assertManaged(dir, path.join(stackBasesDir(dir), `${storageKey(id)}.json`));

export const StackBaseSchema = z.strictObject({
  schemaVersion: z.literal(1), id: z.string().min(1).max(200), gen: z.number().int().min(1),
  base: z.string().min(1).max(250), oid: z.string().regex(OID_RE), at: z.string(),
});

/**
 * Record (or, with `base: null`, remove) a session's fork point. The same claim (gen) on the same base KEEPS the fork point
 * it has: re-running `claim --base` after the base moved — perhaps onto this session's own commits — must not move it. The
 * caller holds `fleet/.lock`.
 */
export function writeStackBase(dir, { id, gen, base, oid, at }) {
  const file = fileFor(dir, id);
  if (base === null) { fs.rmSync(file, { force: true }); return null; }
  const rec = StackBaseSchema.parse({ schemaVersion: 1, id, gen, base, oid, at });
  try {
    const cur = StackBaseSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (cur.success && cur.data.gen === gen && cur.data.base === base) return cur.data;
  } catch { /* absent or unreadable: write it */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
  return rec;
}

/**
 * The fork point for one session, or why there is none. Never throws: an absent, unreadable or mismatched record is a
 * reason, and the caller measures conservatively (from the repo's base).
 * @returns {{ok: true, oid: string} | {ok: false, reason: string}}
 */
export function stackBaseFor(dir, session) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(fileFor(dir, session.id), 'utf8')); } catch (e) {
    return { ok: false, reason: e.code === 'ENOENT' ? 'no fork point recorded (claimed with --base by an older fleet?) — re-run claim --base' : `fork-point record unreadable (${e.message})` };
  }
  const p = StackBaseSchema.safeParse(raw);
  if (!p.success) return { ok: false, reason: 'fork-point record failed validation' };
  const r = p.data;
  if (r.id !== session.id || r.gen !== session.gen || r.base !== session.source?.baseRef) return { ok: false, reason: 'fork-point record is for an earlier claim — re-run claim --base' };
  return { ok: true, oid: r.oid };
}

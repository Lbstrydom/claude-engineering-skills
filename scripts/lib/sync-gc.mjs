/**
 * @fileoverview Garbage collection of files a consumer no longer receives —
 * what to delete, deleting it safely, and reporting what actually happened.
 *
 * ## Why this is not five lines in the sync loop any more
 *
 * It was, and each of those lines had a hole (verified by fixture, 2026-10-13,
 * docs/plans/sync-to-repos-failure-honesty.md):
 *
 *   - **No containment.** It unlinked `path.join(root, key)` directly. Every
 *     WRITE goes through `assertContainedDestination`, because a managed
 *     destination (`scripts/.claude-skills/` itself) can be a junction pointing
 *     out of the consumer — but the write guard only runs on files that
 *     CHANGE, so on a steady-state run nothing at all noticed the junction, and
 *     gc deleted a file outside the repo it was pointed at.
 *   - **A prefix test is not a path test.** `scripts/.claude-skills/../../x`
 *     starts with the tooling prefix and resolves INSIDE the root, so even
 *     containment would let it delete the consumer's own `x`. Manifest keys are
 *     only ever written by the sync, so a key that does not normalise to itself
 *     names nothing we wrote — and is refused, not trusted.
 *   - **Requested ≠ done.** A failed unlink only warned. The receipt still listed
 *     the path under `gcDeleted`, the replacement manifest dropped it (so no
 *     later run would ever retry it), and the run exited 0 — leaving a retired
 *     file in the tooling tree for ever, under a record saying it was gone.
 *
 * So: plan (pure) → execute (every path through the containment oracle, each
 * with its own outcome) → the caller records only what happened. Failures stay
 * in the manifest so the next run retries them, and fail the run.
 *
 * @module scripts/lib/sync-gc
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { assertContainedDestination } from './install/safe-destination.mjs';
import { OWNED_SIDECAR_RELATIVE_PATH } from './sync-owned-sidecar.mjs';
import { SYNC_RECEIPT_PATH } from './bundle-generated-stores.mjs';

/**
 * Files EVERY sync writes after its payload — the committed ownership sidecar and the receipt — and records in the manifest via
 * `patchManifestWithExtraHashes` (lib/sync-manifest.mjs), so they are in the prior manifest's `files` but never in a run's
 * payload destinations. The ONE list both the manifest patch and gc read: without it gc saw them as files "we no longer sync",
 * advised them as "likely renamed upstream" with their citations counted, and the same run's `sync:pr` then committed fresh
 * copies of both as sync-owned (wine dry run, 2026-11-15). They are sync output every run, never orphans.
 */
export const SYNC_RUN_ARTIFACTS = Object.freeze([OWNED_SIDECAR_RELATIVE_PATH, SYNC_RECEIPT_PATH]);

/**
 * Is this manifest key a plain, normalised, POSIX repo-relative path?
 *
 * @param {string} key
 * @returns {boolean}
 */
function isPlainRelativeKey(key) {
  if (typeof key !== 'string' || key === '' || key.includes('\\') || path.posix.isAbsolute(key)) return false;
  if (key.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return false;
  return path.posix.normalize(key) === key;
}

/**
 * Decide what gc should do with the prior manifest's keys. PURE.
 *
 * - A key still intended this run is not gc's business; nor is a `SYNC_RUN_ARTIFACTS` path, which every run rewrites.
 * - A key that is not a plain normalised relative path names nothing the sync
 *   ever wrote: `unsafeKeys` — never deleted, never advised, reported.
 * - A key under the tooling dir is gitignored, regenerable payload: delete it.
 * - Anything else is a TRACKED consumer path: deleting it would be a commit in
 *   someone's repo, so it is only ADVISED (`orphanedTracked`), and only while it
 *   still exists. `exists` is consulted for that advisory and nothing else —
 *   deletion candidates are never pre-filtered by existence, so a dangling link
 *   still reaches the executor and gets an honest outcome there.
 *
 * @param {object} args
 * @param {Record<string, string>} args.priorFiles  prior manifest `files`
 * @param {Set<string>} args.intendedDests          destinations written/held this run
 * ## The divergence question (debt 489588c47264)
 *
 * With a `probe`, a tooling-dir candidate is not deleted blindly: the write path never overwrites a file the consumer has
 * edited since we last wrote it, and GC now asks the same thing of a file upstream RETIRED. The probe answers
 * `{state:'present', hash}` (the `sha256:<hex>` form the manifest stores) / `absent` / `refused` / `failed`:
 *
 *   deletions        present, hash === the manifest base                     (the consumer never touched it)
 *   divergedHeld     present, hash differs from a valid base                 (an edited retired file: kept; `--overwrite-diverged` deletes)
 *   unknownBaseHeld  the stored base is not a valid hash                      (invalid provenance: NEVER deleted, with or without the flag)
 *   alreadyAbsent    absent                                                   (the goal state; the manifest entry is simply dropped)
 *   probeFailed      refused or failed                                        (the caller skips GC for this target entirely)
 *
 * Without a `probe` every candidate is a deletion (the pre-existing behaviour, kept for callers that have no disk to ask).
 *
 * ## Retiring a tracked, manifest-owned path (2026-11-22)
 *
 * `retirePrefixes` extends the probe-gated retirement to TRACKED destinations the sync owns by manifest record (the migrations
 * at `.audit-loop/migrations/`): upstream stopped tracking a migration, so a consumer's copy would otherwise persist for ever
 * and make every consumer audit refuse. Same three-way rule as the tooling dir; `isDeclaredDivergence(key)` (the consumer's
 * `.sync-overrides.json`) holds a key in `declaredHeld`, which nothing deletes.
 *
 * @param {string} args.toolingDir                  e.g. `scripts/.claude-skills`
 * @param {string[]} [args.retirePrefixes]
 * @param {(key: string) => boolean} [args.isDeclaredDivergence]
 * @param {(rel: string) => boolean} args.exists
 * @param {(rel: string) => {state: 'present', hash: string} | {state: 'absent'} | {state: 'refused'|'failed', reason?: string}} [args.probe]
 * @returns {{deletions: string[], orphanedTracked: string[], unsafeKeys: string[], divergedHeld: string[], declaredHeld: string[], unknownBaseHeld: string[], alreadyAbsent: string[], probeFailed: Array<{path: string, reason: string}>, probedHash: Record<string, string>}}
 */
export function planGarbageCollection({ priorFiles, intendedDests, toolingDir, exists, probe, retirePrefixes = [], isDeclaredDivergence = () => false }) {
  const prefix = `${toolingDir}/`;
  const deletions = [];
  const orphanedTracked = [];
  const unsafeKeys = [];
  const divergedHeld = [];
  const declaredHeld = []; // a retired file a consumer's `.sync-overrides.json` claims: never deleted, with or without --overwrite-diverged
  const unknownBaseHeld = [];
  const alreadyAbsent = [];
  const probeFailed = [];
  const probedHash = {}; // the hash each present candidate was PLANNED against: executeGarbageCollection re-checks it before the unlink
  for (const key of Object.keys(priorFiles || {})) {
    if (intendedDests.has(key) || SYNC_RUN_ARTIFACTS.includes(key)) continue;
    if (!isPlainRelativeKey(key)) unsafeKeys.push(key);
    else if (key.startsWith(prefix) || (typeof probe === 'function' && retirePrefixes.some((p) => key.startsWith(p)))) {
      // `retirePrefixes` (audit-loop's `.audit-loop/migrations/`) are TRACKED consumer paths that the sync nonetheless OWNS
      // by manifest record: they retire only through the probe (unedited -> delete, edited -> hold), never blindly, and
      // never without a probe (without one such a key stays advisory, below).
      if (typeof probe !== 'function') { deletions.push(key); continue; }
      if (!key.startsWith(prefix) && isDeclaredDivergence(key)) { declaredHeld.push(key); continue; }
      const seen = probe(key);
      if (seen.state === 'absent') alreadyAbsent.push(key);
      else if (seen.state !== 'present') probeFailed.push({ path: key, reason: `${seen.state}${seen.reason ? `: ${seen.reason}` : ''}` });
      else if (probedHash[key] = seen.hash, !isManifestHash(priorFiles[key])) unknownBaseHeld.push(key);
      else if (seen.hash === priorFiles[key]) deletions.push(key);
      else divergedHeld.push(key);
    } else if (exists(key)) orphanedTracked.push(key);
  }
  return { deletions, orphanedTracked, unsafeKeys, divergedHeld, declaredHeld, unknownBaseHeld, alreadyAbsent, probeFailed, probedHash };
}

/**
 * The operator-facing lines for what gc held, skipped, failed or refused (moved out of sync-to-repos.mjs, which may not grow).
 * PURE: returns the lines. `declaredHeld` is the 2026-11-22 addition: a retired migration the consumer's overrides claim.
 *
 * @returns {string[]}
 */
export function renderGcReport({ gcPlan, gcResult, retiredHeld, overridesPath, colors: { R, Y, D, X } }) {
  const out = [];
  for (const f of gcPlan.declaredHeld) out.push(`  ${Y}hold${X}  ${f} ${D}(upstream retired it; your ${overridesPath} declares this path as divergence, so it is kept. Remove the override to let the sync retire it)${X}`);
  for (const f of gcPlan.divergedHeld.filter((x) => retiredHeld.includes(x))) out.push(`  ${D}hold${X}  ${f} ${D}(upstream retired it, but this copy was edited locally; --overwrite-diverged deletes it)${X}`);
  for (const f of gcPlan.unknownBaseHeld) out.push(`  ${D}hold${X}  ${f} ${D}(its ownership record is malformed; delete it by hand if it is ours)${X}`);
  for (const f of gcResult.held) out.push(`  ${D}hold${X}  ${f} ${D}(changed between the check and the delete)${X}`);
  for (const f of gcPlan.probeFailed) out.push(`  ${R}gc SKIPPED${X} ${f.path} ${D}(${f.reason.slice(0, 160)}) — no gc this run: nothing is deleted on a guess${X}`);
  for (const f of gcResult.failed) out.push(`  ${R}gc FAILED${X} ${f.path} ${D}(${f.reason.slice(0, 160)}; still tracked — the next run retries)${X}`);
  for (const k of gcPlan.unsafeKeys) out.push(`  ${R}gc REFUSED${X} ${k} ${D}(manifest key is not a plain relative path — nothing this sync writes; dropped)${X}`);
  return out;
}

/**
 * The manifest's base for each destination this run was responsible for (debt 4e0763d54f00). PURE.
 *
 * A path WRITTEN (or confirmed equal) this run takes the hash of the exact bytes handed to the write, never a re-read of the
 * disk: re-reading after the loop recorded a concurrent edit as OUR base, and the base is what the divergence gate compares
 * against. A path NOT written (refused, held, failed, source absent) carries its PRIOR entry forward, and only while it is still
 * there; a failed one with no carried base keeps the journal. A path in neither set is omitted: a base is never invented.
 *
 * @param {object} a
 * @param {Iterable<string>} a.intendedDests
 * @param {Set<string>} a.notWrittenByUs
 * @param {Map<string, string>} a.writtenHash
 * @param {Set<string>} a.failedWrites
 * @param {(rel: string) => string|undefined} a.carriedFor   the prior manifest entry (either layout)
 * @param {(rel: string) => boolean} a.stillThere
 * @param {(rel: string) => boolean} a.mayStillExist
 * @returns {{files: Record<string, string>, keepJournal: boolean}}
 */
export function selectManifestBases({ intendedDests, notWrittenByUs, writtenHash, failedWrites, carriedFor, stillThere, mayStillExist: mayExist }) {
  const files = {};
  let keepJournal = false;
  for (const rel of intendedDests) {
    if (notWrittenByUs.has(rel)) {
      const carried = carriedFor(rel);
      if (carried && stillThere(rel)) files[rel] = carried;
      else if (failedWrites.has(rel) && mayExist(rel)) keepJournal = true;
    } else if (writtenHash.has(rel)) files[rel] = writtenHash.get(rel);
  }
  return { files, keepJournal };
}

/** The one stored hash form: `sha256:` + 64 lowercase hex. */
export function isManifestHash(v) { return typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v); }

/**
 * Delete each planned path through the containment oracle, recording an
 * outcome per path. Never throws.
 *
 * `absent` (ENOENT) is the goal state, but this run did not delete it — so it
 * is not claimed as deleted. `failed` covers a refused containment check and
 * every other unlink error.
 *
 * @param {object} args
 * @param {string} args.root
 * @param {string[]} args.deletions
 * @param {(p: string) => void} [args.unlink]
 * @param {(a: {root: string, relPath: string}) => string} [args.contain]
 * @param {Record<string, string>} [args.expectHash]  per path, the `sha256:` form the plan was made against: the bytes are
 *   re-hashed IMMEDIATELY before the unlink and a mismatch is HELD (`changed-since-probe`), so the probe-to-unlink window is one
 *   read-compare-unlink, not the whole GC loop. An edit landing inside that last window is the stated residual.
 * @param {(abs: string) => string} [args.hashFile]
 * @returns {{deleted: string[], absent: string[], held: string[], failed: Array<{path: string, reason: string}>}}
 */
export function executeGarbageCollection({
  root, deletions, unlink = fs.unlinkSync, contain = assertContainedDestination,
  expectHash = {}, hashFile = (abs) => `sha256:${createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}`,
}) {
  const deleted = [];
  const absent = [];
  const held = [];
  const failed = [];
  for (const rel of deletions) {
    let abs;
    try {
      abs = contain({ root, relPath: rel });
    } catch (err) {
      failed.push({ path: rel, reason: `refused: ${err.message}` });
      continue;
    }
    if (expectHash[rel]) {
      try {
        if (hashFile(abs) !== expectHash[rel]) { held.push(rel); continue; }
      } catch (err) {
        if (err?.code === 'ENOENT') { absent.push(rel); continue; }
        failed.push({ path: rel, reason: `${err?.code ?? 'error'}: ${err?.message ?? String(err)}` });
        continue;
      }
    }
    try {
      unlink(abs);
      deleted.push(rel);
    } catch (err) {
      if (err?.code === 'ENOENT') absent.push(rel);
      else failed.push({ path: rel, reason: `${err?.code ?? 'error'}: ${err?.message ?? String(err)}` });
    }
  }
  return { deleted, absent, held, failed };
}

/**
 * How many tracked files still cite `rel` (excluding `rel` itself)?
 *
 * Advisory only — it decides what the operator is told, never what is deleted.
 * No shell: the path is an argv element and the pattern goes in via `-e`, so
 * neither `%VAR%`/`$VAR` expansion nor a leading `-` can change what runs.
 *
 * @param {string} repoRoot
 * @param {string} rel
 * @param {{run?: (file: string, args: string[], opts: object) => string}} [opts]
 * @returns {{count: number} | {count: null, reason: string}}
 *   `{count: 0}` on git grep's "no match" (exit 1, stderr empty); `count: null` when the
 *   question could not be answered — never rendered as "no citations".
 */
export function countCitations(repoRoot, rel, { run = execFileSync } = {}) {
  try {
    // `-z`: NUL-terminated, UNQUOTED names. The default output quotes a path
    // with non-ASCII bytes (core.quotePath), so `docs/café.md` would never
    // compare equal to itself and would count as its own citation.
    const out = run('git', ['grep', '-l', '-z', '-F', '-e', rel], {
      cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    return { count: String(out).split('\0').filter((name) => name !== '' && name !== rel).length };
  } catch (err) {
    // Exit 1 is "no match" only when git said nothing else: an unreadable file
    // is reported on stderr, and a search that skipped one cannot claim zero.
    if (err?.status === 1 && !String(err.stderr ?? '').trim()) return { count: 0 };
    if (err?.status === 1) return { count: null, reason: `incomplete search: ${String(err.stderr).trim().split('\n')[0].slice(0, 120)}` };
    const why = err?.status != null ? `git exited ${err.status}` : (err?.code ?? err?.signal ?? 'spawn failed');
    return { count: null, reason: String(why) };
  }
}

/**
 * Might `abs` still exist? `false` ONLY for a confirmed absence (ENOENT /
 * ENOTDIR, following links — a dangling link is absent). An inspection that
 * FAILS (EACCES, EIO, …) answers `true`: "could not look" must never be read as
 * "gone", or a deletion that failed behind an unreadable directory would be
 * dropped from the manifest and never retried. `fs.existsSync` folds both into
 * `false`, which is why it is not used here.
 *
 * @param {string} abs
 * @param {{stat?: (p: string) => unknown}} [opts]
 * @returns {boolean}
 */
export function mayStillExist(abs, { stat = fs.statSync } = {}) {
  try { stat(abs); return true; } catch (err) { return err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR'; }
}

/**
 * Prior manifest entries to carry forward for deletions that FAILED, so the
 * next run sees them again and retries.
 *
 * Only while the path still resolves — the same "still there" rule the sync
 * applies to refused/held paths. A carried entry for something absent (a
 * dangling leaf link, a file missing behind a refused junction) would make the
 * manifest claim delivery of a file upstream no longer ships, and the delivery
 * post-condition would then fail every run with advice to "re-deliver" it.
 *
 * @param {Array<{path: string}>} failed
 * @param {Record<string, string>} priorFiles
 * @param {(rel: string) => boolean} exists  pass a `mayStillExist`-based probe:
 *   only a CONFIRMED absence may drop an entry
 * @returns {Record<string, string>}
 */
export function carriedForFailedDeletions(failed, priorFiles, exists) {
  const out = {};
  for (const { path: rel } of failed) {
    if (priorFiles?.[rel] && exists(rel)) out[rel] = priorFiles[rel];
  }
  return out;
}

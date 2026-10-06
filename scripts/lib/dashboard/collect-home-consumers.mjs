/**
 * @fileoverview Home collector: consumer sync state, from `.sync-receipt.json`.
 *
 * **What is compared to what.** A receipt's `source.commitSha` is a commit of THIS
 * (the source) repo; a consumer's own HEAD is a different history and is never
 * compared. In the source repo each registered consumer's latest receipt is judged
 * against THIS repo's history by git ancestry, not string equality: equal =
 * `current`; an ancestor of HEAD = `behind N`; a sha this clone lacks, or one that
 * is neither equal nor an ancestor = `not-comparable` (newer, divergent, a fork) —
 * never reported as current or behind. In a consumer there is no offline way to know
 * the upstream HEAD, so it shows a neutral "last synced" fact.
 *
 * **Receipts are untrusted input** (another repo's working tree): size-capped at
 * 1 MB, JSON-parsed, then validated with Zod where this module consumes them. The
 * sha is hex-only because it reaches a git argv. At most 20 consumers are inspected;
 * `{total, inspected, omitted}` is explicit and `omitted > 0` can never grade `ok`.
 *
 * Everything here that touches git is SYNCHRONOUS, so it runs inside the Home
 * worker thread (`home-worker.mjs`) where `collect-home.mjs` can terminate it.
 *
 * Plan: docs/plans/dashboard-home-summary.md §2 (Consumer comparison target).
 *
 * @module scripts/lib/dashboard/collect-home-consumers
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { RECEIPT_PATH, readSyncReceipt, latestReceiptEntry, detectSourceRollback } from '../sync-receipt.mjs';
import { headOf, isAncestor, runGit } from '../fleet/git-facts.mjs';
import { makeMeasurement, isConsumerName } from './home-model.mjs';

export const MAX_CONSUMERS = 20;
export const MAX_RECEIPT_BYTES = 1024 * 1024;
const SOURCE_REPO_NAME = 'claude-engineering-skills';

const Sha = z.string().regex(/^[0-9a-f]{7,64}$/, 'not a hex commit id');
const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not a date');
/** The fields this module consumes. `source` is strict; the rest of an entry (file lists, counts) is not ours to judge. */
const EntrySchema = z.looseObject({
  syncedAt: isoDate,
  source: z.strictObject({
    repo: z.string().nullish(),
    branch: z.string().nullish(),
    commitSha: Sha.nullable(),
    sourceDirty: z.boolean().nullish(),
  }),
});

/** Names the failing fields, never their values (a receipt is untrusted text). */
const issuePaths = (err) => err.issues.slice(0, 3).map((i) => i.path.join('.') || '(root)').join(', ');

/** Read at most MAX_RECEIPT_BYTES + 1 bytes from an open fd: the cap holds however the file grows after any stat. */
function readCapped(fsx, fd) {
  const buf = Buffer.alloc(MAX_RECEIPT_BYTES + 1);
  let total = 0;
  while (total < buf.length) {
    const n = fsx.readSync(fd, buf, total, buf.length - total, total);
    if (n === 0) break;
    total += n;
  }
  return { tooLarge: total > MAX_RECEIPT_BYTES, text: total > MAX_RECEIPT_BYTES ? '' : buf.subarray(0, total).toString('utf8') };
}

/**
 * @param {string} dir
 * @param {object} [fsx] - fs API (openSync/fstatSync/readSync/closeSync), injectable so a file that grows
 *   between the stat and the read can be simulated.
 * @returns {{ok: true, entries: object[], latest: object} | {ok: false, absent: boolean, detail: string}}
 */
function readReceipt(dir, fsx = fs) {
  const file = path.join(dir, RECEIPT_PATH);
  let fd;
  try {
    // Check the TYPE before opening: opening a FIFO (or a device) for reading can block forever, which
    // would stall the build before any size or type check ran. lstat does not open the path.
    try {
      if (!(fsx.lstatSync ?? fs.lstatSync)(file).isFile()) return { ok: false, absent: false, detail: 'receipt path is not a regular file' };
    } catch (err) {
      return { ok: false, absent: err.code === 'ENOENT', detail: err.code === 'ENOENT' ? 'no receipt: never synced, or the path is missing' : `receipt not readable (${err.code})` };
    }
    // O_NONBLOCK as well, for the window between the lstat and the open (a file swapped for a FIFO).
    try { fd = fsx.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0)); } catch (err) {
      return { ok: false, absent: err.code === 'ENOENT', detail: err.code === 'ENOENT' ? 'no receipt: never synced, or the path is missing' : `receipt not readable (${err.code})` };
    }
    if (!fsx.fstatSync(fd).isFile()) return { ok: false, absent: false, detail: 'receipt path is not a regular file' };
    let body;
    try { body = readCapped(fsx, fd); } catch (err) { return { ok: false, absent: false, detail: `receipt not readable (${err.code})` }; }
    if (body.tooLarge) return { ok: false, absent: false, detail: `too large (over ${MAX_RECEIPT_BYTES} bytes)` };
    let raw;
    try { raw = JSON.parse(body.text); } catch { return { ok: false, absent: false, detail: 'receipt is not valid JSON' }; }
    const read = readSyncReceipt(raw);
    if (read.status === 'unsupported') return { ok: false, absent: false, detail: `receipt is a newer version (${read.version}) than this reader understands` };
    if (read.status !== 'ok') return { ok: false, absent: false, detail: 'receipt carries no usable sync entry' };
    const parsed = EntrySchema.safeParse(latestReceiptEntry(read));
    if (!parsed.success) return { ok: false, absent: false, detail: `receipt entry failed validation (${issuePaths(parsed.error)})` };
    return { ok: true, entries: read.entries, latest: parsed.data };
  } finally {
    if (fd !== undefined) try { fsx.closeSync(fd); } catch { /* best effort */ }
  }
}

const HEX = /^[0-9a-f]{7,64}$/;

/**
 * Resolve a receipt sha to a FULL object id in THIS repo. Never prefix-compares strings: the sha is
 * hex-validated, handed to git after `--end-of-options`, and an ambiguous or unknown one is a
 * distinct "cannot compare", not a guess.
 * @returns {{oid: string} | {oid: null, reason: 'invalid'|'ambiguous'|'missing'}}
 */
function resolveOid(root, sha) {
  if (typeof sha !== 'string' || !HEX.test(sha)) return { oid: null, reason: 'invalid' };
  const r = runGit(['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`], root);
  if (r.ok && /^[0-9a-f]{40,64}$/.test(r.stdout.trim())) return { oid: r.stdout.trim() };
  return { oid: null, reason: /ambiguous/i.test(r.stderr ?? '') ? 'ambiguous' : 'missing' };
}

const ancestryOracle = (root) => (ancestor, descendant) => {
  const r = isAncestor(root, ancestor, descendant);
  if (!r.ok) return 'unknown';
  return r.value ? 'yes' : 'no';
};

/** Judge one consumer's receipt against THIS repo's history, by FULL oid. */
function judge(root, head, r) {
  const sha = r.latest.source.commitSha;
  const base = { syncedAt: new Date(Date.parse(r.latest.syncedAt)).toISOString(), sha7: sha ? sha.slice(0, 7) : null, behind: null, rolledBack: false };
  if (!sha) return { ...base, state: 'not-comparable', detail: 'the receipt records no source commit' };
  const res = resolveOid(root, sha);
  if (!res.oid) {
    return { ...base, state: 'not-comparable', detail: res.reason === 'ambiguous' ? 'that abbreviated commit id is ambiguous in this clone' : 'that commit is not in this clone (newer, divergent, or a fork)' };
  }
  let result;
  if (res.oid === head.oid) result = { state: 'current', detail: 'at this HEAD' };
  else {
    const anc = isAncestor(root, res.oid, head.oid);
    if (!anc.ok) result = { state: 'not-comparable', detail: 'ancestry could not be established' };
    else if (!anc.value) result = { state: 'not-comparable', detail: 'not an ancestor of this HEAD (newer or divergent)' };
    else {
      const n = runGit(['rev-list', '--count', `${res.oid}..${head.oid}`], root);
      const behind = n.ok ? Number.parseInt(n.stdout.trim(), 10) : NaN;
      result = Number.isFinite(behind) && behind > 0
        ? { state: 'behind', behind, detail: `${behind} commit(s) behind this HEAD` }
        : { state: 'not-comparable', detail: 'could not count the commits between' };
    }
  }
  // The last sync may itself have moved the consumer BACKWARDS (the sync's own predicate), on FULL oids.
  const prior = r.entries[1];
  const priorOid = prior ? resolveOid(root, prior.source?.commitSha).oid : null;
  const rolled = priorOid
    ? detectSourceRollback({ ...prior, source: { ...prior.source, commitSha: priorOid } }, res.oid, ancestryOracle(root))
    : null;
  return { ...base, ...result, rolledBack: Boolean(rolled), detail: rolled ? `${result.detail}; the last sync rolled it back from ${String(rolled.recordedSha).slice(0, 7)}` : result.detail };
}

/** Is `root` the source repo (vs a consumer)? By package name, the stable identity. */
function isSourceRepoRoot(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name === SOURCE_REPO_NAME; } catch { return false; }
}

async function defaultConsumers() {
  // consumer-repos.mjs is SOURCE-REPO-ONLY tooling (its repo-root derivation breaks once relocated
  // into a consumer, and its private half is gitignored). A literal specifier here would make the
  // sync's import-closure walker ship it to every consumer; a COMPUTED specifier is not followed
  // (the same idiom collect-telemetry.mjs uses). Callers only reach this when running in the source
  // repo, and a failure to load it is reported by the caller as an absent registry.
  const mod = await import(new URL('../consumer-repos.mjs', import.meta.url).href);
  return mod.CONSUMER_REPOS.map((c) => ({ name: c.name, path: c.path }));
}

/**
 * @param {string} root
 * @param {object} [opts]
 * @param {Date} [opts.now]
 * @param {Array<{name: string, path: string}>} [opts.consumers] - registry override (tests); default `CONSUMER_REPOS`
 * @param {boolean} [opts.isSource] - override the source/consumer detection
 * @param {object} [opts.fsApi] - fs API override (tests)
 * @returns {Promise<{card: 'consumers', measurements: object[]}>}
 */
export async function collectConsumers(root, { now = new Date(), consumers, isSource, fsApi } = {}) {
  const asOf = now.toISOString();
  const agg = { id: 'consumers', label: 'Consumers', card: 'consumers', asOf, source: '.sync-receipt.json' };
  const done = (m, rows = []) => ({ card: 'consumers', measurements: [m, ...rows] });

  if (!(isSource ?? isSourceRepoRoot(root))) {
    // This repo's OWN receipt: an unreadable one is this repo's defect (invalid); an absent one is just not-yet-synced.
    const r = readReceipt(root, fsApi);
    if (!r.ok) return done(makeMeasurement({ ...agg, source: `${RECEIPT_PATH} (this repo)`, status: r.absent ? 'missing-optional' : 'invalid', detail: r.detail }));
    const sha = r.latest.source.commitSha;
    return done(makeMeasurement({ ...agg, source: `${RECEIPT_PATH} (this repo)`, status: 'ok', value: { mode: 'consumer', syncedAt: new Date(Date.parse(r.latest.syncedAt)).toISOString(), sha7: sha ? sha.slice(0, 7) : null } }));
  }

  let list;
  try { list = consumers ?? await defaultConsumers(); } catch (err) {
    return done(makeMeasurement({ ...agg, status: 'unexpected-error', detail: `consumer registry could not be loaded: ${String(err.message).split('\n')[0]}` }));
  }
  if (!list.length) return done(makeMeasurement({ ...agg, status: 'missing-optional', detail: 'no consumer repositories are registered' }));
  const head = headOf(root);
  if (!head.ok) return done(makeMeasurement({ ...agg, status: 'missing-optional', detail: 'this repository has no HEAD commit to compare receipts with' }));

  const inspectedList = list.slice(0, MAX_CONSUMERS);
  const rows = inspectedList.map((c) => {
    const base = { id: `consumer:${c.name}`, label: `Consumer ${String(c.name).slice(0, 60)}`, card: 'consumers', asOf, source: `${RECEIPT_PATH} in the consumer` };
    if (!isConsumerName(c.name)) {
      return makeMeasurement({ ...base, id: 'consumer:(invalid-name)', label: 'Consumer (invalid name)', status: 'missing-optional', detail: 'unreadable (registered consumer name does not match [A-Za-z0-9._-]+)', value: { name: null, state: 'unreadable', behind: null, syncedAt: null, sha7: null, detail: 'invalid name' } });
    }
    const r = readReceipt(c.path, fsApi);
    // Another repo's file must never fail THIS repo's build: unreadable is missing-optional, and still a warn / N01 row.
    if (!r.ok) return makeMeasurement({ ...base, status: 'missing-optional', detail: r.absent ? r.detail : `unreadable (${r.detail})`, value: { name: c.name, state: 'unreadable', behind: null, syncedAt: null, sha7: null, detail: r.detail } });
    const j = judge(root, head, r);
    return makeMeasurement({ ...base, status: 'ok', value: { name: c.name, ...j } });
  });

  const states = rows.map((m) => m.value.state);
  const count = (s) => states.filter((x) => x === s).length;
  const value = {
    mode: 'source', total: list.length, inspected: inspectedList.length, omitted: list.length - inspectedList.length,
    current: count('current'), behind: count('behind'), notComparable: count('not-comparable'), unreadable: count('unreadable'),
    rows: rows.map((m) => m.value),
  };
  return done(makeMeasurement({ ...agg, status: 'ok', value, detail: value.omitted > 0 ? `${value.omitted} not inspected (cap ${MAX_CONSUMERS})` : '' }), rows);
}

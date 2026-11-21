/**
 * @fileoverview CES-side reader for `telemetry-export/v1` — scan a drop directory and say, per
 * EXPECTED exporter, exactly one of five things. Never a guess, never a zero.
 *
 * The rule (docs/plans/private-store-telemetry-path.md §2.4): **an absent export is a missing
 * measurement; it is never summed as zero.** So the states are:
 *
 *   received         a valid export within its freshness policy — its figures, with their age
 *   stale            the newest valid export is outside the policy — figures LABELLED with age
 *   rejected         files arrived and none validated — the reasons, never silently dropped
 *   never-received   an expected exporter, a CLEAN scan, no file — "unmeasured"
 *   drop-unreadable  the drop directory could not be read — "we could not look", which is NOT
 *                    "nothing was there", so no per-consumer `never-received` claim is made
 *   scan-incomplete  a scan bound was hit — likewise never a `never-received` claim
 *
 * CES does not trust the sender: every file is re-validated against the shared strict schema AND
 * re-run through the fail-closed redaction check, and a file is attributed only to the alias whose
 * directory it sits in AND whose body names the same alias. A file the reader cannot attribute is
 * listed as unattributed, never assigned to a guess.
 *
 * What an export says is "reported by the consumer, unauthenticated by CES" (§2.4a): authentication
 * is whatever the delivery channel provides. Nothing here gates anything.
 *
 * PURE over `fs` and `now`, so every state is testable without a real drop directory.
 *
 * @module scripts/lib/telemetry-export/reader
 */
import nodeFs from 'node:fs';
import path from 'node:path';
import { SCHEMA_ID, MAX_EXPORT_BYTES, validateExport } from './schema.mjs';
import { assertExportClean, ExportRefusedError } from './redact.mjs';

export const MAX_FILES_PER_ALIAS = 200;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const KEEP_VALID = 8;
export const KEEP_REJECTED = 20;
export const WEEKLY_STALE_DAYS = 14;
const DAY_MS = 86_400_000;
const FILE_RE = /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
const ALIAS_RE = /^[a-z0-9-]{1,32}$/;
export const CADENCES = Object.freeze(['weekly', 'on-demand']);

/** A closed reason: the first issue's code and path, never an offending value. */
const short = (s) => String(s).slice(0, 120);

/**
 * Judge ONE file. Returns a valid doc or a closed rejection reason.
 *
 * @returns {{ok: true, doc: object} | {ok: false, reason: string}}
 */
function judgeFile({ fs, file, expectedAlias, now }) {
  let ls;
  try { ls = fs.lstatSync(file); } catch (err) { return { ok: false, reason: `unreadable: ${err?.code || 'error'}` }; }
  if (ls.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  // Before OPENING: a FIFO or device with an export-shaped name would block `open` waiting for a writer, so the
  // type is refused on the lstat, and the open itself is non-blocking where the platform has the flag.
  if (!ls.isFile()) return { ok: false, reason: 'not-a-file' };
  // Type and size are taken from the OPEN descriptor, and the read itself is capped, so the entry cannot be
  // swapped or grown between a check and the read. Refused WITHOUT parsing: a cap that parsed first is no cap.
  let raw;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: 'not-a-file' };
    if (st.size > MAX_EXPORT_BYTES) return { ok: false, reason: 'oversize' };
    // Read until EOF or one byte past the cap: a single readSync may legitimately return less than the file
    // (network filesystems, pipes), and a truncated body would read as corrupt rather than as what it is.
    const buf = Buffer.alloc(MAX_EXPORT_BYTES + 1);
    let n = 0;
    while (n < buf.length) {
      const got = fs.readSync(fd, buf, n, buf.length - n, n);
      if (got === 0) break;
      n += got;
    }
    if (n > MAX_EXPORT_BYTES) return { ok: false, reason: 'oversize' };
    raw = buf.toString('utf8', 0, n);
  } catch (err) {
    return { ok: false, reason: `unreadable: ${err?.code || 'error'}` };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* nothing to do */ } }
  }
  let doc;
  try { doc = JSON.parse(raw); } catch { return { ok: false, reason: 'not-json' }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, reason: 'not-an-export' };
  if (doc.schema !== SCHEMA_ID) {
    return { ok: false, reason: typeof doc.schema === 'string' && doc.schema.startsWith('telemetry-export/') ? 'unsupported-version' : 'not-an-export' };
  }
  const v = validateExport(doc);
  if (!v.ok) return { ok: false, reason: short(`invalid: ${v.reason}`) };
  try { assertExportClean(v.doc); } catch (err) {
    return { ok: false, reason: err instanceof ExportRefusedError ? `redaction-refused: ${err.categories.join(',')}` : 'redaction-check-failed' };
  }
  if (v.doc.consumerAlias !== expectedAlias) return { ok: false, reason: 'alias-mismatch' };
  if (Date.parse(v.doc.generatedAt) > now.getTime() + DAY_MS) return { ok: false, reason: 'future-dated' };
  return { ok: true, doc: v.doc };
}

/** The headline figures of a valid export, each carrying its own measured flag. */
export function figuresOf(doc) {
  return {
    store: doc.health.store,
    drift: doc.health.drift.measured
      ? { measured: true, unapplied: doc.health.drift.unapplied, shaMismatch: doc.health.drift.shaMismatch, liveBroken: doc.health.drift.liveBroken }
      : { measured: false, reason: doc.health.drift.reason },
    audit: doc.audit.measured
      ? { measured: true, runs: doc.audit.runs, convergedRuns: doc.audit.convergedRuns }
      : { measured: false, reason: doc.audit.reason },
    upstream: doc.upstream.measured
      ? { measured: true, totalOpen: doc.upstream.totalOpen }
      : { measured: false, reason: doc.upstream.reason },
  };
}

/**
 * @param {object} p
 * @param {string|null} p.dropDir
 * @param {Array<{alias: string, cadence: 'weekly'|'on-demand'}>} p.expected
 * @param {Date} p.now
 * @param {typeof nodeFs} [p.fs]
 * @returns {{scanError: string|null, scanIncomplete: string|null, aliases: object[], unattributed: object[]}}
 */
export function scanDrop({ dropDir, expected, now, fs = nodeFs }) {
  const empty = (state, extra = {}) => expected.map(({ alias, cadence }) => ({ alias, cadence, state, ...extra }));
  if (!dropDir) return { scanError: 'no-drop-dir', scanIncomplete: null, aliases: empty('drop-unreadable'), unattributed: [] };

  let top;
  try { top = fs.readdirSync(dropDir, { withFileTypes: true }); } catch (err) {
    // Absent, unreadable, a file where a directory should be: "we could not look". No per-consumer claim.
    return { scanError: String(err?.code || 'unreadable'), scanIncomplete: null, aliases: empty('drop-unreadable'), unattributed: [] };
  }

  const expectedAliases = new Set(expected.map((e) => e.alias));
  const unattributed = [];
  for (const d of top) {
    if (d.name.startsWith('.')) continue;                              // .git and friends are not exporters
    // A symlink in the drop is never followed, and never silently ignored either.
    if (d.isSymbolicLink()) { unattributed.push({ dir: ALIAS_RE.test(d.name) ? d.name : '(invalid name)', reason: 'symlink' }); continue; }
    if (!d.isDirectory()) continue;
    if (!expectedAliases.has(d.name)) unattributed.push({ dir: ALIAS_RE.test(d.name) ? d.name : '(invalid name)', reason: 'unexpected-alias' });
  }

  let scanIncomplete = null;
  // A COUNT bound outranks `alias-unreadable`: it is the one that makes "nothing was there" unprovable elsewhere,
  // so a later bound must not be hidden behind an earlier unreadable alias.
  const markIncomplete = (why) => { if (scanIncomplete === null || (scanIncomplete === 'alias-unreadable' && why !== 'alias-unreadable')) scanIncomplete = why; };
  let bytes = 0;
  const aliases = [];
  for (const { alias, cadence } of expected) {
    const dir = path.join(dropDir, alias);
    let names = [];
    try {
      // The alias directory must be a real directory INSIDE the drop: a symlink here would walk the scan (and a
      // later prune) out of it.
      const ds = fs.lstatSync(dir);
      if (ds.isSymbolicLink() || !ds.isDirectory()) throw Object.assign(new Error('x'), { code: ds.isSymbolicLink() ? 'SYMLINK' : 'NOTDIR' });
      names = fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        // "Could not look" for THIS alias also means the scan as a whole is not trusted (no pruning, no clean claim).
        markIncomplete('alias-unreadable');
        aliases.push({ alias, cadence, state: 'drop-unreadable', reason: String(err?.code || 'unreadable') });
        continue;
      }
    }
    // Newest first: the file name starts with the export date.
    names.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    let truncated = false;
    if (names.length > MAX_FILES_PER_ALIAS) { markIncomplete('files-per-alias'); names = names.slice(0, MAX_FILES_PER_ALIAS); truncated = true; }

    const valid = []; const rejected = [];
    for (const name of names) {
      const file = path.join(dir, name);
      if (!FILE_RE.test(name)) { rejected.push({ file, name, reason: 'bad-name' }); continue; }
      let size = 0;
      try { size = fs.lstatSync(file).size; } catch { /* judgeFile reports it */ }
      bytes += size;
      if (bytes > MAX_TOTAL_BYTES) { markIncomplete('total-bytes'); truncated = true; break; }
      const j = judgeFile({ fs, file, expectedAlias: alias, now });
      if (j.ok) valid.push({ file, name, doc: j.doc }); else rejected.push({ file, name, reason: j.reason });
    }
    valid.sort((a, b) => (a.doc.generatedAt < b.doc.generatedAt ? 1 : a.doc.generatedAt > b.doc.generatedAt ? -1 : 0));

    const newest = valid[0] ?? null;
    const base = { alias, cadence, validCount: valid.length, rejectedCount: rejected.length, files: { valid: valid.map((v) => v.file), rejected: rejected.map((r) => r.file) } };
    // `newer` is claimed only when it is established: the rejected file's own name-date against the chosen export.
    const latestRejected = rejected[0]
      ? { name: rejected[0].name, reason: rejected[0].reason, newer: newest ? rejected[0].name.slice(0, 10) > newest.doc.generatedAt.slice(0, 10) : null }
      : null;
    if (truncated) {
      // Unexamined files may include a newer valid export or change the verdict: no definitive state from a partial read.
      aliases.push({ ...base, state: 'scan-incomplete', reason: scanIncomplete });
    } else if (newest) {
      const ageMs = Math.max(0, now.getTime() - Date.parse(newest.doc.generatedAt));
      const ageDays = Math.floor(ageMs / DAY_MS);   // for DISPLAY only
      // `on-demand` promised no cadence: shown with its age, never stale. The threshold is compared on the exact
      // elapsed time: flooring to days first would keep an export 14 days and 23 hours old "received".
      const stale = cadence === 'weekly' && ageMs > WEEKLY_STALE_DAYS * DAY_MS;
      aliases.push({ ...base, state: stale ? 'stale' : 'received', ageDays, generatedAt: newest.doc.generatedAt, figures: figuresOf(newest.doc), latestRejected });
    } else if (rejected.length > 0) {
      aliases.push({ ...base, state: 'rejected', latestRejected });
    } else if (scanIncomplete && scanIncomplete !== 'alias-unreadable') {
      aliases.push({ ...base, state: 'scan-incomplete', reason: scanIncomplete });
    } else {
      aliases.push({ ...base, state: 'never-received' });
    }
  }
  // A bound hit anywhere makes "nothing was there" unprovable for an alias that found nothing.
  // An alias that could not be READ taints pruning, but says nothing about another alias's empty directory, which
  // was read cleanly; a COUNT bound (files / bytes) does make "nothing was there" unprovable for those that found none.
  if (scanIncomplete && scanIncomplete !== 'alias-unreadable') {
    for (const a of aliases) if (a.state === 'never-received') { a.state = 'scan-incomplete'; a.reason = scanIncomplete; }
  }
  return { scanError: null, scanIncomplete, aliases, unattributed };
}

/**
 * Remove files beyond retention: the newest KEEP_VALID valid and KEEP_REJECTED rejected per alias stay.
 * Explicit and opt-in (the drop is usually a Git clone; deleting is a deliberate act), single-file
 * `unlink`s only, and only paths the scan itself produced.
 *
 * @param {ReturnType<typeof scanDrop>} scan
 * @param {{unlink?: (p: string) => void}} [io]
 * @returns {{removed: number, failed: number, skipped: boolean}} `skipped` = the scan was not trusted; `failed` = deletions that errored
 */
export function pruneDrop(scan, { unlink = nodeFs.unlinkSync } = {}) {
  if (scan.scanError || scan.scanIncomplete) return { removed: 0, failed: 0, skipped: true };   // never prune on a scan we do not fully trust
  let removed = 0; let failed = 0;
  const drop = (f) => { try { unlink(f); removed++; } catch { failed++; } };
  for (const a of scan.aliases) {
    for (const f of (a.files?.valid ?? []).slice(KEEP_VALID)) drop(f);
    for (const f of (a.files?.rejected ?? []).slice(KEEP_REJECTED)) drop(f);
  }
  return { removed, failed, skipped: false };
}

const fig = (g, text) => (g.measured ? text : `unmeasured (${g.reason})`);

/**
 * Plain-text rendering, shared by `telemetry:exports`, `upstream:queues` and `stores:drift`.
 * A figure appears ONLY from a received/stale export, and every one carries its own measured flag.
 *
 * @param {ReturnType<typeof scanDrop>} scan
 * @returns {string[]}
 */
export function renderTelemetryExports(scan) {
  const out = [];
  if (scan.scanError) out.push(`drop unreadable: ${scan.scanError} — could not look; NO consumer is reported as "never received"`);
  if (scan.scanIncomplete) out.push(`scan incomplete: ${scan.scanIncomplete} bound reached — "never received" is not claimed`);
  for (const a of scan.aliases) {
    const head = `${a.alias} (${a.cadence})`;
    if (a.state === 'received' || a.state === 'stale') {
      const f = a.figures;
      const body = [
        `store ${f.store}`,
        `audit runs ${fig(f.audit, String(f.audit.runs))}`,
        `upstream open ${fig(f.upstream, String(f.upstream.totalOpen))}`,
        `migrations behind ${fig(f.drift, String(f.drift.unapplied))}`,
        `sha-mismatched ${fig(f.drift, String(f.drift.shaMismatch))}`,
        `constraints broken ${fig(f.drift, String(f.drift.liveBroken))}`,
      ].join(' · ');
      out.push(`${a.state === 'stale' ? 'STALE' : 'ok'} ${head}: export ${a.ageDays}d old — ${body} (reported by the consumer, unauthenticated)`
        + (a.state === 'stale' ? ' — OLDER than its freshness policy; not current' : '')
        + (a.latestRejected ? ` · ${a.latestRejected.newer ? 'newer file' : 'another file'} rejected: ${a.latestRejected.reason}` : ''));
    } else if (a.state === 'rejected') {
      out.push(`rejected ${head}: ${a.rejectedCount} file(s), none valid — newest: ${a.latestRejected?.reason ?? 'unknown'}`);
    } else if (a.state === 'never-received') {
      out.push(`unmeasured ${head}: no export received (a clean scan found none) — NOT zero`);
    } else if (a.state === 'scan-incomplete') {
      out.push(`unmeasured ${head}: scan incomplete (${a.reason}) — could not establish that none exists`);
    } else {
      out.push(`unmeasured ${head}: drop unreadable${a.reason ? ` (${a.reason})` : ''} — could not look`);
    }
  }
  for (const u of scan.unattributed) out.push(`unattributed: ${u.dir} (${u.reason}) — not an expected exporter; ignored`);
  return out;
}

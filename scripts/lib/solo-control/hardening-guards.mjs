/**
 * @fileoverview Pure guards for the solo-control CLI's pre-existing defects
 * (docs/plans/solo-control-hardening.md). Extracted from
 * scripts/solo-control-audit.mjs, an over-1000-line file that may not grow.
 * Each is a decision that lived inline in a subcommand where nothing could
 * test it; the subcommand now calls it.
 *
 * @module scripts/lib/solo-control/hardening-guards
 */
import crypto from 'node:crypto';

/** A numeric CLI option that must be a positive integer. `parseInt('0')`, `('abc')` and `('-5')` used to flow straight
 * into a loop increment (`--batch-size 0` re-sent the same PAID judge batch forever) or a slice width (`--max-chars 0`
 * made chunkDiff spin). Throws naming the flag; the caller turns that into exit 2. */
export function positiveInt(raw, flag) {
  const s = String(raw ?? '').trim();
  if (!/^\d+$/.test(s) || Number(s) < 1 || !Number.isSafeInteger(Number(s))) throw new Error(`--${flag} must be a positive integer, got ${JSON.stringify(raw)}`);
  return Number(s);
}

/** A numeric CLI option that must be a finite number >= 0 (a budget ceiling; 0 is a legitimate "spend nothing"). NaN compares false against everything, so `spent >= NaN` never breached. */
export function nonNegativeNumber(raw, flag) {
  const s = String(raw ?? '').trim();
  const n = s === '' ? NaN : Number(s);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${flag} must be a finite number >= 0, got ${JSON.stringify(raw)}`);
  return n;
}

/**
 * Is the budget ceiling breached — or can it not be CHECKED? Unpriced means unmeasured, never zero: a row that
 * reached a provider and came back without a price (an unpriced model, a provider that reported no usage) makes
 * the running total a FLOOR, and `floor < ceiling` proves nothing. The old check summed those rows as $0 and let
 * every later call through. Not counted as unmeasured: a `provider-error`/`excluded` row with NO usage — nothing
 * came back, so there is no evidence anything was billed, and counting it would wedge the experiment on its own
 * failures. Cells dedupe by callId, LAST row wins (the rule completion.mjs and aggregateCostForArm apply), so a
 * priced re-run supersedes its unpriced first attempt.
 *
 * Stated limit: callId is the cell's identity, so a re-run of the SAME cell is one row — spend on re-runs under
 * `--force` is not additive here (docs/plans/solo-control-hardening.md, Deferred: call identity).
 *
 * @returns {null | {spentUsd:number, complete:boolean, unmeasured:number, reason:'ceiling'|'unmeasured'}}
 */
export function budgetVerdict(rows, budgetUsd) {
  const byCallId = new Map();
  for (const r of rows) byCallId.set(r.callId, r);
  let spentUsd = 0; let unmeasured = 0;
  for (const r of byCallId.values()) {
    if (r.costUsd != null) { spentUsd += r.costUsd; continue; }
    const nothingCameBack = (r.state === 'provider-error' || r.state === 'excluded') && !r.usage;
    if (!nothingCameBack) unmeasured++;
  }
  spentUsd = +spentUsd.toFixed(4);
  if (spentUsd >= budgetUsd) return { spentUsd, complete: unmeasured === 0, unmeasured, reason: 'ceiling' };
  if (unmeasured > 0) return { spentUsd, complete: false, unmeasured, reason: 'unmeasured' };
  return null;
}

/** The sheet/map pairing check `score` runs before reading a label. The blind CSV and the private map are two files;
 * they are only meaningful as a pair, and the pair is edited by a human in between. Every map id must be on the sheet
 * EXACTLY once (a deleted ungraded row used to vanish from the coverage denominator, scoring a sheet nobody finished
 * as complete), no sheet id may be absent from the map, and each row's recorded commit/severity/category must agree
 * with the map's (an interrupted `merge` leaves a NEW sheet beside an OLD map — blind ids renumber on re-merge, so
 * the same id then names a different finding and every arm is mis-credited).
 * @param {Record<string,{commit:string,severity:string,category:string}>} map
 * @param {Array<{blindId:string,commit:string,severity:string,category:string}>} sheetRows
 * @returns {string[]} problems; empty = paired */
export function sheetPairingProblems(map, sheetRows) {
  const problems = [];
  const seen = new Map();
  for (const r of sheetRows) seen.set(r.blindId, (seen.get(r.blindId) || 0) + 1);
  const dup = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  const missing = Object.keys(map).filter((id) => !seen.has(id));
  const unknown = [...seen.keys()].filter((id) => !Object.hasOwn(map, id));
  if (dup.length) problems.push(`duplicate blind_id on the sheet: ${dup.slice(0, 8).join(', ')}`);
  if (missing.length) problems.push(`${missing.length} blind_id(s) in the map are missing from the sheet (deleted rows?): ${missing.slice(0, 8).join(', ')}`);
  if (unknown.length) problems.push(`${unknown.length} blind_id(s) on the sheet are not in the map (a different merge?): ${unknown.slice(0, 8).join(', ')}`);
  const drift = sheetRows.filter((r) => map[r.blindId] && (
    r.commit === '' || !String(map[r.blindId].commit || '').startsWith(String(r.commit || ''))
    || String(map[r.blindId].severity || '') !== String(r.severity || '')
    || String(map[r.blindId].category || '') !== String(r.category || ''))).map((r) => r.blindId);
  if (drift.length) problems.push(`${drift.length} row(s) disagree with the map on commit/severity/category — the sheet and map are from different merges: ${drift.slice(0, 8).join(', ')}`);
  return problems;
}

/** judge-gpt: keep only gradings for ids IN this batch, each once. The model's returned `blind_id` used to be written
 * into the global grading map unchecked, so a hallucinated or cross-batch id graded a row this call never saw.
 * @returns {{valid: object[], rejected: string[]}} */
export function validateGradings(gradings, batchIds) {
  const allowed = new Set(batchIds);
  const taken = new Set();
  const valid = []; const rejected = [];
  for (const g of gradings) {
    if (!allowed.has(g.blind_id) || taken.has(g.blind_id)) { rejected.push(String(g.blind_id)); continue; }
    taken.add(g.blind_id); valid.push(g);
  }
  return { valid, rejected };
}

/** sha256 over a findings list in the order given — binds a saved artifact's findings to the digest it was written with. */
export const findingsDigest = (findings) => crypto.createHash('sha256').update(JSON.stringify(findings ?? [])).digest('hex');

/** A Gemini reply's findings, schema-validated. `parsed?.findings || []` accepted any JSON object — one lacking
 * `findings` read as a clean "found nothing" instead of a conformance miss. */
export function geminiFindingsOrMiss(text, schema) {
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* conformance miss */ }
  const check = parsed ? schema.safeParse(parsed) : null;
  return check?.success ? { findings: check.data.findings } : { findings: [], state: 'conformance-miss' };
}

/**
 * Resume refuses when the arm file's recorded measurement configuration differs from this run's. `assertResumableBackend`
 * checks the transport alone; a resumed run also skips every unit the prior file marks `ran`, so a changed model, reasoning
 * effort, repeat count or chunk size would splice two different measurements into ONE arm — compared across arms as if
 * it were a single configuration. Only fields the prior file RECORDED are compared (an absent field is unknown, not a
 * mismatch), and only when the prior file has units that would be skipped.
 * @param {object|null} prior the arm file on disk
 * @param {Record<string, unknown>} planned this run's value for each field
 * @param {boolean} force
 * @throws {Error} naming each differing field and the way forward
 */
export function assertResumableProvenance(prior, planned, force) {
  const was = prior?.provenance;
  if (force || !was || !prior.perCommit?.some((c) => c.state === 'ran')) return;
  const diffs = Object.keys(planned)
    .filter((k) => was[k] !== undefined && JSON.stringify(was[k]) !== JSON.stringify(planned[k] ?? null))
    .map((k) => `${k}: ${JSON.stringify(was[k])} → ${JSON.stringify(planned[k] ?? null)}`);
  if (diffs.length === 0) return;
  throw new Error(`this arm file was produced with a different measurement configuration (${diffs.join('; ')}) — `
    + 'resuming would splice two configurations into one arm. Re-run with --force to start the arm over, or run the new configuration under its own --label.');
}

/** What a cold pass's attempts amounted to. A reply that arrived but did not conform is a conformance MISS (a real,
 * countable outcome of the model); NO reply on ANY attempt — an auth failure, a rate limit, a 5xx, a timeout — is a
 * PROVIDER ERROR (the cell is unmeasured). Both used to come back as `{findings: [], conformanceMiss: true}`, so a
 * revoked key scored every cell of every commit as "the model found nothing" and the commit read as complete.
 * @param {{gotReply: boolean, conformant: boolean}} attempts */
export const coldPassOutcome = ({ gotReply, conformant }) => (conformant ? 'ok' : gotReply ? 'conformance-miss' : 'provider-error');

/** judge-gpt resume: the identity a prior output's grades were made under. A grade depends on the judge MODEL and the
 * known-defect rubric the judge was shown, neither of which is in the row content `seedResumedGrades` fingerprints.
 * @returns {{ok: boolean, note?: string}} ok=false ⇒ discard every prior grade; a missing meta file is a legacy output
 * (accepted with a note, never silently). */
export function judgeResumeIdentity(meta, current) {
  if (!meta) return { ok: true, note: 'prior output has no meta sidecar (written before the judge identity was recorded) — its grades are unverifiable but kept' };
  const diffs = Object.keys(current).filter((k) => meta[k] !== current[k]);
  return diffs.length ? { ok: false, note: `judge identity changed (${diffs.join(', ')}) — prior grades were made by a different judge/rubric` } : { ok: true };
}

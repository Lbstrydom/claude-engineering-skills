/**
 * @fileoverview `telemetry-export --report`: the analysis, run where the data is, printed for a human.
 *
 * A consumer whose policy forbids any data leaving cannot send CES an export, not even a redacted
 * one — a person carries a verdict out in prose. So the questions CES asks of a store
 * (capture-v1 (a)-(c), coverage floors, shadow-window progress) have to be answerable ON the consumer.
 * This module is the report half; it is a MODE of the existing exporter, never a second pipeline: the
 * groups run INSIDE the snapshot transaction `makeRowReader` already opens (`extraReads`), so the
 * report and the export it rides beside describe one instant.
 *
 * Three rules this file keeps:
 *  - **An unreadable group is `{measured:false, reason}`, never a zero.** A denominator of 0 is
 *    `no-eligible-rows`, not a rate. One group's SQL error cannot poison the others: each runs under its
 *    own SAVEPOINT (a Postgres error otherwise aborts the whole transaction). A connection-level
 *    error ends the remaining groups as `store-unreachable` without more statements.
 *  - **Nothing here prints a repo, a path, a host or a finding.** Model ids pass a closed charset and
 *    the leak scan (a failing one is `other`, counted in `redactions`); pass names map to the closed
 *    PASSES enum; repo ids never leave the SQL. The assembled object is re-checked by
 *    `assertExportClean` before it is rendered.
 *  - **Bound at the CALLER.** `SET LOCAL statement_timeout` per group, here, not inside a function.
 *
 * @module scripts/lib/telemetry-export/report
 */
import { captureStatement, CAPTURE_EPOCHS } from '../telemetry/capture-queries.mjs';
import { buildMeasureSql, evaluateEntry, validateConfig } from '../telemetry/coverage.mjs';
import { PASSES } from './schema.mjs';
import { strictCount, reasonForError } from './build.mjs';
import { assertExportClean } from './redact.mjs';
import { renderPopulationLine } from '../population.mjs';
import { STATIC_POOL, OSS_POOL, XAI_POOL, ALIBABA_POOL, DEEPSEEK_POOL, modelFamily } from '../model-resolver.mjs';

export const REPORT_SCHEMA = 'telemetry-report/v1';
/** Caller-side bound on any one group's statement. */
export const GROUP_TIMEOUT_MS = 15_000;
/** The last line of the human output, exactly. */
export const REPORT_FOOTER = 'Nothing was written or sent.';

/** A group that cannot be measured is an ANSWER, with a closed reason. */
const unmeasured = (reason) => ({ unmeasured: reason });

/**
 * Closed reason for an error thrown by a group. `57014` (statement_timeout, our own bound) is `timeout`; every other
 * class is `reasonForError`'s. Not folded into `reasonForError` itself: that one feeds the EXPORT's closed
 * `UNMEASURED_REASONS` enum, which `timeout` is not in, so a server-side timeout during an export would stop validating.
 */
export function reasonForReportError(err) {
  if (String(err?.code ?? '') === '57014') return 'timeout';
  return reasonForError(err);
}

/** Did the CONNECTION (not the statement) fail? After one, no further statement is attempted. */
export function isConnectionError(err) {
  const code = String(err?.code ?? '');
  if (reasonForError(err) === 'store-unreachable') return true;
  if (/^08/.test(code) || /^57P0[123]$/.test(code)) return true;
  return /connection terminated|connection error|client was closed|ECONNRESET/i.test(String(err?.message ?? ''));
}

/**
 * The ids a report may print verbatim: the resolver's own catalogue of PUBLIC model ids (never a list kept here).
 * A consumer routing through a private deployment names it for its organisation (`gpt-5-prod-eu-acme`), and a charset
 * check cannot tell that from a public id, so membership is exact.
 */
const KNOWN_MODEL_IDS = new Set([
  ...Object.values(STATIC_POOL).flat(), ...Object.values(OSS_POOL).flat(), ...XAI_POOL, ...ALIBABA_POOL, ...DEEPSEEK_POOL,
]);
/** Vendor families of the known ids: a family name may be printed only if a PUBLIC id has it (`acme-gpt` must not become `acme:other`). */
const KNOWN_FAMILIES = new Set([...KNOWN_MODEL_IDS].map((id) => modelFamily(id)));

/**
 * A model id as the report may print it: exactly a known public id, else `<family>:other` (counted in `redactions`),
 * or plain `other` when even the family is not a known vendor. An absent id is `none` - a missing value, not a redaction.
 *
 * @param {unknown} id
 * @param {{n: number}} tally
 * @returns {string}
 */
export function sanitizeModelId(id, tally) {
  if (id == null || id === '') return 'none';
  const v = String(id);
  if (KNOWN_MODEL_IDS.has(v)) return v;
  tally.n += 1;
  const fam = modelFamily(v);
  return fam && KNOWN_FAMILIES.has(fam) ? `${fam}:other` : 'other';
}

const toPass = (v, tally) => {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (PASSES.includes(s)) return s;
  tally.n += 1;
  return 'other';
};

/** A nullable aggregate (a `sum` over no key reads NULL): absent means the writer recorded none, so 0 — only used where a receipt exists. */
const nz = (v, what) => (v == null ? 0 : strictCount(v, what));

/**
 * Run groups one by one inside the caller's open transaction.
 *
 * @param {{query: (sql: string, params?: any[]) => Promise<{rows: object[]}>}} client the snapshot transaction's client
 * @param {Array<{id: string, run: (q: (sql: string, params?: any[]) => Promise<object[]>) => Promise<object>}>} groups
 *        `run` returns the group's data, or `{unmeasured: reason}`; it may throw
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<Record<string, {measured: true, [k: string]: any} | {measured: false, reason: string}>>}
 */
export async function runGroups(client, groups, { timeoutMs = GROUP_TIMEOUT_MS } = {}) {
  const q = async (sql, params) => (await client.query(sql, params)).rows;
  const out = {};
  let dead = false;
  for (let i = 0; i < groups.length; i += 1) {
    const g = groups[i];
    if (dead) { out[g.id] = { measured: false, reason: 'store-unreachable' }; continue; }
    const sp = `g_${i}`;
    try {
      await client.query(`SAVEPOINT ${sp}`);
      await client.query(`SET LOCAL statement_timeout = ${Math.trunc(timeoutMs)}`);
    } catch {
      dead = true;
      out[g.id] = { measured: false, reason: 'store-unreachable' };
      continue;
    }
    try {
      const r = await g.run(q);
      await client.query(`RELEASE SAVEPOINT ${sp}`);
      out[g.id] = r && r.unmeasured ? { measured: false, reason: r.unmeasured } : { measured: true, ...r };
    } catch (err) {
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      } catch {
        // The connection cannot even undo: nothing further is attempted.
        dead = true;
        out[g.id] = { measured: false, reason: 'store-unreachable' };
        continue;
      }
      out[g.id] = { measured: false, reason: reasonForReportError(err) };
      if (isConnectionError(err)) dead = true;
    }
  }
  return out;
}

const first = (rows) => (Array.isArray(rows) ? rows[0] : undefined);

/**
 * The report's groups, with their inputs fixed here (docs/plans/policy-private-consumer-stores.md §2.3).
 *
 * @param {object} p
 * @param {readonly string[]} [p.epochs]
 * @param {object|null} p.coverageConfig the resolved `own-model-coverage` config, or null when it is not there
 * @param {Function} p.readTieredShadow `getTieredShadowObservations` (injected: it touches the store)
 * @param {(rows: object[]) => {comparedRuns: number, window: object}} p.summariseShadow `summarize` + `windowProgress` over the
 *        normalised rows (injected: they live in the audit domain, which this shared-lib module may not import)
 * @param {{n: number}} p.tally redaction counter
 */
export function buildReportGroups({ epochs = CAPTURE_EPOCHS, coverageConfig, readTieredShadow, summariseShadow, tally }) {
  const stmt = (name) => captureStatement(name, epochs);
  const rows = (name) => async (q) => { const s = stmt(name); return q(s.sql, s.params); };
  const groups = [
    { id: 'reraise', run: async (q) => {
      const r = first(await rows('reraise-rate')(q));
      const concerns = strictCount(r?.concerns, 'concerns');
      return concerns === 0 || r.reraise_rate == null ? unmeasured('no-eligible-rows') : { rate: Number(r.reraise_rate), concerns };
    } },
    { id: 'reopen', run: async (q) => {
      const r = first(await rows('reopen-rate')(q));
      const dismissedConcerns = strictCount(r?.dismissed_concerns, 'dismissed concerns');
      return dismissedConcerns === 0 || r.reopen_rate == null ? unmeasured('no-eligible-rows') : { rate: Number(r.reopen_rate), dismissedConcerns };
    } },
    { id: 'dispute', run: async (q) => {
      const r = first(await rows('dispute-rate')(q));
      const withTwoKinds = strictCount(r?.rows_with_two_kinds, 'rows with two kinds');
      return withTwoKinds === 0 || r.dispute_rate == null ? unmeasured('no-eligible-rows') : { rate: Number(r.dispute_rate), withTwoKinds };
    } },
    { id: 'equivalence', run: async (q) => {
      const r = first(await rows('equivalence-receipt')(q));
      const runsWithReceipt = strictCount(r?.runs_with_receipt, 'runs with receipt');
      if (runsWithReceipt === 0) return unmeasured('no-eligible-rows');
      return {
        runsWithReceipt, expected: nz(r.expected, 'expected'), written: nz(r.written, 'written'),
        skipped: nz(r.skipped, 'skipped'), spilled: nz(r.spilled, 'spilled'), lost: nz(r.lost, 'lost'),
      };
    } },
    { id: 'qualityProspective', run: async (q) => {
      const merged = new Map();
      for (const r of await rows('quality-prospective')(q)) {
        const model = sanitizeModelId(r.source_model, tally);
        const pass = toPass(r.pass_name, tally);
        const k = `${model}\u0000${pass}`;
        const cur = merged.get(k) ?? { model, pass, n: 0, accepted: 0, dismissed: 0, severityAdjusted: 0, unresolved: 0 };
        cur.n += strictCount(r.n, 'n'); cur.accepted += strictCount(r.accepted, 'accepted');
        cur.dismissed += strictCount(r.dismissed, 'dismissed'); cur.severityAdjusted += strictCount(r.severity_adjusted, 'severity_adjusted');
        cur.unresolved += strictCount(r.unresolved, 'unresolved');
        merged.set(k, cur);
      }
      return merged.size === 0 ? unmeasured('no-eligible-rows') : { rows: [...merged.values()].sort((a, b) => b.n - a.n || a.model.localeCompare(b.model) || a.pass.localeCompare(b.pass)) };
    } },
    { id: 'qualityHistorical', run: async (q) => {
      const merged = new Map();
      let excluded = 0;
      for (const r of await rows('quality-historical')(q)) {
        const n = strictCount(r.n, 'n');
        // Classified on the query's own boolean, never on the text of a model id: a pass-stat model may be named anything.
        if (r.excluded === true) { excluded += n; continue; }
        if (r.excluded !== false) throw Object.assign(new Error('excluded flag is not a boolean'), { code: 'BAD_AGGREGATE' });
        const model = sanitizeModelId(r.source_model, tally);
        merged.set(model, (merged.get(model) ?? 0) + n);
      }
      const models = [...merged].map(([model, n]) => ({ model, n })).sort((a, b) => b.n - a.n || a.model.localeCompare(b.model));
      return models.length === 0 && excluded === 0 ? unmeasured('no-eligible-rows') : { models, excluded };
    } },
    { id: 'agreement', run: async (q) => {
      const counts = { agree: 0, disagree: 0, unknown: 0 };
      for (const r of await rows('c-run-agreement-counts')(q)) {
        if (Object.hasOwn(counts, r.result)) counts[r.result] += strictCount(r.n, 'n');
      }
      const total = counts.agree + counts.disagree + counts.unknown;
      return total === 0 ? unmeasured('no-eligible-rows') : { ...counts, total };
    } },
    { id: 'reversal', run: async (q) => {
      const r = first(await rows('reversal-rate')(q));
      const presentedResolved = r?.presented_resolved == null ? 0 : strictCount(r.presented_resolved, 'presented_resolved');
      if (presentedResolved === 0 || r.reversal_rate == null) return unmeasured('no-eligible-rows');
      return { rate: Number(r.reversal_rate), reversals: nz(r.reversals, 'reversals'), presentedResolved, runs: strictCount(r.runs, 'runs') };
    } },
    // A count, not a rate: an honest 0 is possible, and this is the one group where it means "none".
    { id: 'incompleteReviews', run: async (q) => ({ count: strictCount(first(await rows('incomplete-reviews')(q))?.incomplete_reviews, 'incomplete reviews') }) },
  ];

  const windowDays = coverageConfig?.windowDays ?? 30;
  const entries = Array.isArray(coverageConfig?.entries) ? coverageConfig.entries : [];
  entries.forEach((e, i) => groups.push({
    id: `coverage:${i}`,
    run: async (q) => { const { sql, params } = buildMeasureSql(e, windowDays); return { row: first(await q(sql, params)) ?? null }; },
  }));

  groups.push({ id: 'shadowTiered', run: async (q) => {
    // Store-wide: every repo in this store. The ids are an input to the read and are never printed.
    const repoIds = (await q('SELECT id FROM audit_repos', [])).map((r) => String(r.id));
    if (repoIds.length === 0) return unmeasured('no-eligible-rows');
    // Through THIS transaction's runner: same snapshot, same SAVEPOINT, same statement_timeout, and an error keeps its SQLSTATE.
    const res = await readTieredShadow({ repoIds }, { query: q });
    if (!res?.cloud) return unmeasured('store-unconfigured');
    if (!res.ok) throw Object.assign(new Error('tiered shadow read failed'), { code: 'READ_FAILED' });
    if (res.rows.length === 0) return unmeasured('no-eligible-rows');
    // comparedRuns ONLY: totalRuns counts runs that never produced a decision-grade comparison.
    const s = summariseShadow(res.rows);
    return { comparedRuns: s.comparedRuns, window: s.window, truncated: Boolean(res.truncated) };
  } });
  return groups;
}

/**
 * The collector `telemetry-export.mjs` hands to `makeRowReader`: it runs the groups when the snapshot is open and keeps what
 * they measured. Nothing is read twice and nothing runs outside the transaction.
 *
 * @param {object} p see {@link buildReportGroups}
 */
export function createReportCollector(p) {
  const tally = { n: 0 };
  let results = null;
  return {
    tally,
    extraReads: async (client) => {
      results = await runGroups(client, buildReportGroups({ ...p, tally }));
    },
    results: () => results,
  };
}

/**
 * Fold the flat group results (and the export's own health verdict) into the report object. Coverage entries are
 * evaluated with the committed `evaluateEntry`, statuses unchanged.
 *
 * @param {object} p
 * @param {{generatedAt: string, health: object, audit: object}} p.doc the built export (health + the reason the snapshot did not open)
 * @param {Record<string, object>|null} p.results `runGroups` output; null when the snapshot never opened
 * @param {object|null} p.coverageConfig
 * @param {string|null} p.coverageProblem closed reason when the config is absent/invalid
 * @param {{n: number}} p.tally
 * @param {readonly string[]} [p.epochs]
 */
export function assembleReport({ doc, results, coverageConfig, coverageProblem = null, tally, epochs = CAPTURE_EPOCHS }) {
  // The groups are store-wide: they do not depend on the repo the EXPORT is scoped to. So when the snapshot opened and the
  // groups ran (`results` present) they stand even if the export's own repo-scoped group is unmeasured (repo unresolved or
  // unregistered). `results` is null only when the snapshot never opened, and then the export's reason is the honest one.
  const snapshotReason = doc.audit?.measured === false ? (doc.audit.reason ?? 'read-failed') : null;
  const usable = results ?? null;
  const get = (id) => usable?.[id] ?? { measured: false, reason: snapshotReason ?? 'read-failed' };

  const groups = {};
  for (const id of ['reraise', 'reopen', 'dispute', 'equivalence', 'qualityProspective', 'qualityHistorical', 'agreement', 'reversal', 'incompleteReviews', 'shadowTiered']) groups[id] = get(id);
  groups.shadowFinalReview = { measured: false, reason: 'no-reader' };

  if (!coverageConfig) {
    groups.coverage = { measured: false, reason: coverageProblem ?? 'config-missing' };
  } else {
    const windowDays = coverageConfig.windowDays ?? 30;
    const entries = coverageConfig.entries.map((e, i) => {
      const g = get(`coverage:${i}`);
      const ev = evaluateEntry(e, g.measured === true ? g.row : null);
      return {
        table: e.table, column: e.column, where: e.where ?? 'all', since: e.since, expectFill: e.expectFill,
        ...ev, ...(g.measured === false ? { reason: g.reason } : {}),
      };
    });
    // Every entry failing keeps EACH entry's own reason (they can differ: one schema fault among timeouts is information).
    // No entry produced a rate (every status is unmeasured:*) → the group is unmeasured, never "measured with no numbers".
    // A store failure keeps its reason; an entry with no eligible rows says so (R3 M1).
    const isUnmeasured = (e) => String(e.status).startsWith('unmeasured');
    const entryReason = (e) => (e.status === 'unmeasured:store' ? (e.reason ?? 'read-failed') : 'no-eligible-rows');
    groups.coverage = entries.every(isUnmeasured)
      ? {
        measured: false,
        reason: entries.length ? entryReason(entries[0]) : 'no-eligible-rows',
        entries: entries.map((e) => ({ table: e.table, column: e.column, where: e.where, reason: entryReason(e) })),
      }
      : { measured: true, windowDays, entries };
  }

  const anyMeasured = Object.values(groups).some((g) => g.measured === true);
  const report = {
    schema: REPORT_SCHEMA,
    generatedAt: doc.generatedAt,
    epochs: [...epochs],
    health: doc.health,
    groups,
    redactions: tally.n,
    anyMeasured,
  };
  assertExportClean(report);
  return report;
}

const pct = (r) => `${(r * 100).toFixed(1)}%`;
const um = (g) => `unmeasured (${g.reason})`;

/**
 * Human text for the report. PURE. Ends with exactly {@link REPORT_FOOTER}.
 *
 * @param {ReturnType<typeof assembleReport>} report
 * @param {object} population a `population/v1` object
 * @returns {string}
 */
export function renderReport(report, population) {
  const g = report.groups;
  const L = [];
  const line = (s = '') => L.push(s);
  line(`Telemetry report — ${report.epochs.join(', ')} (store-wide, read-only, one snapshot) — ${report.generatedAt}`);
  line(renderPopulationLine(population));
  const h = report.health ?? {};
  const drift = h.drift?.measured === true
    ? `${h.drift.unapplied} unapplied, ${h.drift.shaMismatch} sha mismatch, ${h.drift.liveBroken} live constraint(s) broken`
    : `unmeasured (${h.drift?.reason ?? 'read-failed'})`;
  line(`Store: ${h.store ?? 'unknown'}; migration drift: ${drift}`);
  line('');

  line('(a) Re-raise, reopen, dispute — each rate has its own denominator and they are never combined. All are lower bounds.');
  line(`  re-raise rate:  ${g.reraise.measured ? `${pct(g.reraise.rate)} over ${g.reraise.concerns} concern(s)` : um(g.reraise)}`);
  line(`  reopen rate:    ${g.reopen.measured ? `${pct(g.reopen.rate)} over ${g.reopen.dismissedConcerns} dismissed concern(s)` : um(g.reopen)}`);
  line(`  dispute rate:   ${g.dispute.measured ? `${pct(g.dispute.rate)} over ${g.dispute.withTwoKinds} finding(s) with two adjudicator kinds` : um(g.dispute)}`);
  line(`  equivalence receipt: ${g.equivalence.measured
    ? `${g.equivalence.runsWithReceipt} run(s): expected ${g.equivalence.expected}, written ${g.equivalence.written}, skipped ${g.equivalence.skipped}, spilled ${g.equivalence.spilled}, lost ${g.equivalence.lost}`
    : um(g.equivalence)}`);
  line('');

  line('(b) Finding quality per model — observational, not a controlled eval; the two cohorts are never pooled.');
  line('  prospective (capture-v1 runs), by model and pass:');
  if (g.qualityProspective.measured) {
    for (const r of g.qualityProspective.rows) line(`    ${r.model} / ${r.pass}: n=${r.n}, accepted ${r.accepted}, dismissed ${r.dismissed}, severity-adjusted ${r.severityAdjusted}, unresolved ${r.unresolved}`);
  } else line(`    ${um(g.qualityProspective)}`);
  line('  historical (one-model pass-stat pairs only):');
  if (g.qualityHistorical.measured) {
    for (const r of g.qualityHistorical.models) line(`    ${r.model}: n=${r.n}`);
    line(`    excluded (zero, several or null-model pass-stat rows): ${g.qualityHistorical.excluded}`);
  } else line(`    ${um(g.qualityHistorical)}`);
  line('');

  line('(c) Final reviewer against the ledger');
  line(`  per-run agreement: ${g.agreement.measured ? `agree ${g.agreement.agree}, disagree ${g.agreement.disagree}, unknown ${g.agreement.unknown} (${g.agreement.total} run(s))` : um(g.agreement)}`);
  line(`  reversal rate:     ${g.reversal.measured ? `${pct(g.reversal.rate)} (${g.reversal.reversals} of ${g.reversal.presentedResolved} presented_resolved, ${g.reversal.runs} run(s))` : um(g.reversal)}`);
  line(`  incomplete reviews (counted apart): ${g.incompleteReviews.measured ? g.incompleteReviews.count : um(g.incompleteReviews)}`);
  line('');

  line('Own-model coverage');
  if (g.coverage.measured) {
    line(`  window ${g.coverage.windowDays} day(s)`);
    for (const e of g.coverage.entries) {
      line(`  ${e.table}.${e.column} [${e.where}]: ${e.reason ? `unmeasured (${e.reason})` : e.status}${e.rate == null ? '' : `, fill ${pct(e.rate)} of ${e.total} (floor ${pct(e.expectFill)})`}`);
    }
  } else {
    line(`  ${um(g.coverage)}`);
    for (const e of g.coverage.entries ?? []) line(`  ${e.table}.${e.column} [${e.where}]: unmeasured (${e.reason})`);
  }
  line('');

  line('Shadow windows');
  if (g.shadowTiered.measured) {
    const w = g.shadowTiered.window;
    line(`  tiered pipeline: ${g.shadowTiered.comparedRuns} compared run(s) of ${w.min}-${w.max} needed (${w.met ? 'window met' : w.withinWindow ? 'within the window' : 'below the window'})${g.shadowTiered.truncated ? '; query limit hit, newer rows may be missing' : ''}`);
  } else line(`  tiered pipeline: ${um(g.shadowTiered)}`);
  line(`  final-review shadow: ${um(g.shadowFinalReview)}`);
  if (report.redactions > 0) { line(''); line(`${report.redactions} value(s) were replaced by "other" because they did not pass the redaction check.`); }
  line('');
  line(REPORT_FOOTER);
  return L.join('\n');
}

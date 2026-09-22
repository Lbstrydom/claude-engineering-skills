#!/usr/bin/env node
/**
 * @fileoverview Read back the concern-identity telemetry (concern-identity.mjs)
 * for an observation window: is the hard-suppress counter firing, is the
 * adjudicator using `sameConcernAs`, and how many re-raises still slip past.
 *
 * Reads only rounds stamped with `CONCERN_TELEMETRY_EPOCH` at the collector
 * (`audit_runs.suppression_stats.concern.epoch`) — never a date cut-off — and
 * COUNTS the R2+ rounds in the window that had rulings to match against but no
 * stamp, per repo (an older bundle, or the tiered pipeline, which keeps its own
 * accounting): unmeasured, not clean. A store with no stamped rounds
 * prints UNMEASURED, never a row of zeros.
 *
 * One store per invocation. Consumers are not all on one store, so run it
 * wherever a consumer's rounds land (`npm run stores:drift` lists them).
 *
 * Usage:
 *   node scripts/concern-telemetry-report.mjs              # last 7 days
 *   node scripts/concern-telemetry-report.mjs --days 14 --json
 *
 * @module scripts/concern-telemetry-report
 */
import './lib/load-env.mjs';
import { pathToFileURL } from 'node:url';
import { many } from './lib/db/query.mjs';
import { getPool, storeDescriptor } from './lib/db/client.mjs';
import { finishAndExit, assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import { CONCERN_TELEMETRY_EPOCH, HARD_SUPPRESS_THRESHOLD } from './lib/concern-identity.mjs';

const KNOWN_FLAGS = ['--days', '--json', '--selfcheck-relocation'];
const BAND_KEYS = ['lt10', 'lt20', 'lt35', 'gte35'];

function emptyTotals() {
  return {
    runs: 0, unstampedR2Runs: 0,
    hardSuppressed: 0, hardSuppressedLinked: 0, fuzzySuppressed: 0, relitigationDeclined: 0,
    reopenUndeclaredOnDismissal: 0,
    nearMisses: 0, nearMissBands: Object.fromEntries(BAND_KEYS.map((k) => [k, 0])), nearMissInConcern: 0, nearMissMultiFile: 0,
    runsWithLinkedConcern: 0, maxConcernsAtThreshold: 0,
    recurringMissedTopics: 0, topRecurring: [],
  };
}

/**
 * Pure aggregation over the rows the queries below return.
 *
 * `recurringMissedTopics` is the direct measure of the field report's shape: a
 * prior ruling that a KEPT finding sat beside in two or more different rounds,
 * i.e. one concern re-adjudicated again and again.
 *
 * @param {{runs: Array<{id: string, repo: string, suppression_stats: object}>,
 *          events: Array<{run_id: string, repo: string, action: string,
 *                         matched_topic_id: string, match_score: number, reason: string}>,
 *          unstamped: Array<{repo: string, n: number}>}} rows
 * @returns {{byRepo: Record<string, object>, all: object}}
 */
export function summariseConcernTelemetry({ runs = [], events = [], unstamped = [] }) {
  const byRepo = {};
  const bucket = (repo) => (byRepo[repo || 'unknown'] ||= emptyTotals());
  const all = emptyTotals();

  for (const r of runs) {
    const c = r.suppression_stats?.concern || {};
    for (const t of [bucket(r.repo), all]) {
      t.runs += 1;
      for (const k of ['hardSuppressed', 'fuzzySuppressed', 'relitigationDeclined',
        'reopenUndeclaredOnDismissal', 'nearMisses', 'nearMissInConcern', 'nearMissMultiFile']) t[k] += Number(c[k] ?? 0);
      for (const k of BAND_KEYS) t.nearMissBands[k] += Number(c.nearMissBands?.[k] ?? 0);
      if (Number(c.concernsLinked ?? 0) > 0) t.runsWithLinkedConcern += 1;
      t.maxConcernsAtThreshold = Math.max(t.maxConcernsAtThreshold, Number(c.concernsAtThreshold ?? 0));
    }
  }
  for (const u of unstamped) {
    bucket(u.repo).unstampedR2Runs += Number(u.n);
    all.unstampedR2Runs += Number(u.n);
  }

  // topic → {runs:Set, best} per repo and overall, from KEPT rows only.
  const recur = new Map();
  for (const e of events) {
    if (e.action === 'suppressed' && /hard-suppressed/.test(e.reason || '') && /linked=yes/.test(e.reason || '')) {
      bucket(e.repo).hardSuppressedLinked += 1;
      all.hardSuppressedLinked += 1;
    }
    if (e.action !== 'kept' || !e.matched_topic_id) continue;
    for (const scope of [e.repo || 'unknown', '*']) {
      const key = `${scope}\u0000${e.matched_topic_id}`;
      const rec = recur.get(key) || { scope, topic: e.matched_topic_id, runs: new Set(), best: 0 };
      rec.runs.add(e.run_id);
      rec.best = Math.max(rec.best, Number(e.match_score ?? 0));
      recur.set(key, rec);
    }
  }
  for (const rec of recur.values()) {
    if (rec.runs.size < 2) continue;
    const t = rec.scope === '*' ? all : bucket(rec.scope);
    t.recurringMissedTopics += 1;
    t.topRecurring.push({ topic: rec.topic, runs: rec.runs.size, bestScore: rec.best });
  }
  for (const t of [all, ...Object.values(byRepo)]) {
    t.topRecurring = t.topRecurring.sort((a, b) => b.runs - a.runs || b.bestScore - a.bestScore).slice(0, 5);
  }
  return { byRepo, all };
}

/**
 * One line per question the observation window exists to answer. `unmeasured`
 * is its own answer — a window with no stamped rounds proves nothing.
 */
export function readout(t) {
  if (t.runs === 0) {
    return [`UNMEASURED — no ${CONCERN_TELEMETRY_EPOCH} rounds`
      + (t.unstampedR2Runs > 0 ? ` (${t.unstampedR2Runs} R2+ round(s) with rulings carried no stamp: older bundle or tiered pipeline)` : '')];
  }
  const hs = t.hardSuppressed > 0
    ? `FIRING — ${t.hardSuppressed} hard-suppressed (${t.hardSuppressedLinked} via an adjudicator link)`
    : (t.maxConcernsAtThreshold > 0
      ? `NOT FIRING though a concern reached ${HARD_SUPPRESS_THRESHOLD} dismissals — investigate`
      : `not exercised — no concern reached ${HARD_SUPPRESS_THRESHOLD} dismissals`);
  return [
    `hard-suppress: ${hs}`,
    `sameConcernAs adoption: ${t.runsWithLinkedConcern}/${t.runs} round(s) had a linked concern`,
    `missed re-raises: ${t.nearMisses} kept beside a prior ruling `
      + `(<.1:${t.nearMissBands.lt10} <.2:${t.nearMissBands.lt20} <.35:${t.nearMissBands.lt35} >=.35:${t.nearMissBands.gte35}); `
      + `${t.nearMissInConcern} in a known concern; ${t.nearMissMultiFile} multi-file; `
      + `${t.recurringMissedTopics} prior ruling(s) re-raised in 2+ rounds`,
    `fuzzy-suppressed: ${t.fuzzySuppressed} | re-litigation declined (Layer 3): ${t.relitigationDeclined} `
      + `| undeclared reopens of a dismissal: ${t.reopenUndeclaredOnDismissal}`,
    ...(t.unstampedR2Runs > 0 ? [`coverage: ${t.unstampedR2Runs} R2+ round(s) with rulings carried no stamp — older bundle or tiered pipeline (unmeasured)`] : []),
  ];
}

async function fetchRows(days) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const params = [since, CONCERN_TELEMETRY_EPOCH];
  const stamped = `r.created_at >= $1 AND r.suppression_stats->'concern'->>'epoch' = $2`;
  const [runs, events, unstamped] = await Promise.all([
    many(`SELECT r.id, rp.name AS repo, r.suppression_stats
            FROM audit_runs r LEFT JOIN audit_repos rp ON rp.id = r.repo_id
           WHERE ${stamped}`, params),
    many(`SELECT e.run_id, rp.name AS repo, e.action, e.matched_topic_id, e.match_score, e.reason
            FROM suppression_events e
            JOIN audit_runs r ON r.id = e.run_id
            LEFT JOIN audit_repos rp ON rp.id = r.repo_id
           WHERE ${stamped}`, params),
    many(`SELECT rp.name AS repo, count(*)::int AS n
            FROM audit_runs r LEFT JOIN audit_repos rp ON rp.id = r.repo_id
           WHERE r.created_at >= $1
             AND (r.suppression_stats->>'round')::int >= 2
             AND COALESCE((r.suppression_stats->'ledger'->>'adjudicated')::int, 0) > 0
             AND r.suppression_stats->'concern'->>'epoch' IS DISTINCT FROM $2
           GROUP BY rp.name`, params),
  ]);
  return { runs, events, unstamped };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'concern-telemetry-report' });
  } catch (err) {
    if (!(err instanceof ArgvError)) throw err;
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 2;
    return;
  }
  const daysArg = argv.includes('--days') ? Number(argv[argv.indexOf('--days') + 1]) : 7;
  if (!Number.isInteger(daysArg) || daysArg < 1) {
    process.stderr.write('concern-telemetry-report: --days must be a positive integer\n');
    process.exitCode = 2;
    return;
  }
  const store = storeDescriptor(process.env.AUDIT_DB_URL || '')?.label ?? 'unknown store';
  if (!await getPool()) {
    process.stderr.write('concern-telemetry-report: UNMEASURED — no audit store configured (AUDIT_DB_URL).\n');
    process.exitCode = 1;
    return;
  }
  const summary = summariseConcernTelemetry(await fetchRows(daysArg));

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ ok: true, store, days: daysArg, epoch: CONCERN_TELEMETRY_EPOCH, ...summary }, null, 2));
  } else {
    console.log(`Concern telemetry · store ${store} · last ${daysArg} day(s) · epoch ${CONCERN_TELEMETRY_EPOCH}\n`);
    for (const [name, t] of [['ALL', summary.all], ...Object.entries(summary.byRepo).sort()]) {
      console.log(`${name}  (${t.runs} stamped round(s))`);
      for (const line of readout(t)) console.log(`  ${line}`);
      for (const r of t.topRecurring) console.log(`    recurring ${String(r.topic).slice(0, 12)}  ${r.runs} rounds  best score ${r.bestScore.toFixed(2)}`);
      console.log('');
    }
  }
  await finishAndExit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(async (err) => {
    process.stderr.write(`concern-telemetry-report: ${err.message}\n`);
    await finishAndExit(1);   // an open pg pool would otherwise hold the process
  });
}

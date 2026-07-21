#!/usr/bin/env node
/**
 * @fileoverview memory-health — weekly decision gate for adopting graph-shaped
 * findings memory (pgvector clustering) vs staying on semantic_id + Jaccard.
 *
 * Calls the `memory_health_metrics` Postgres RPC, evaluates trigger thresholds,
 * writes a markdown report. Exits 0 when all green, 1 when any trigger fires.
 * The GH Actions workflow uses the exit code to decide whether to open/update
 * the sticky "memory-health" issue — silent when healthy.
 *
 * Thresholds (tune here, not in the migration):
 *   fuzzy_reraise.rate        > 0.15   → fingerprint-only dedup is leaking
 *   cluster_density.median    >= 5     → open findings have latent cluster structure
 *   recurrence.rate           > 0.10   → fixes are not sticking under new IDs
 *
 * Decision rule (from the discussion with the user):
 *   - 0 triggers for 4 consecutive weeks → shape has academic merit only
 *   - 1 trigger fires for 2 consecutive weeks → prototype pgvector similarity
 *   - 2+ triggers fire → build the full clustering pipeline
 *
 * @module scripts/memory-health
 */

import 'dotenv/config';
import { atomicWriteFileSync } from './lib/file-io.mjs';

// Parse a numeric env var, falling back to the default on absent/garbage. A bare
// `Number("abc")` → NaN, and every threshold comparison against NaN is false → no
// trigger ever fires → a silent FALSE-GREEN (the class this whole gate exists to
// avoid). Warn loudly when an explicit value is unparseable so it's never silent.
function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    process.stderr.write(`memory-health: WARNING — ${name}="${raw}" is not a finite number; using ${fallback}\n`);
    return fallback;
  }
  return n;
}

const WINDOW_DAYS = numEnv('MEMORY_HEALTH_WINDOW_DAYS', 30);

const THRESHOLDS = {
  fuzzyReraiseRate: numEnv('MEMORY_HEALTH_FUZZY_RATE', 0.15),
  clusterMedianPairs: numEnv('MEMORY_HEALTH_CLUSTER_MEDIAN', 5),
  recurrenceRate: numEnv('MEMORY_HEALTH_RECURRENCE_RATE', 0.10),
  minFindingsForSignal: numEnv('MEMORY_HEALTH_MIN_FINDINGS', 50),
  // Semantic cluster density (2026-07-21 migration off trigram): cosine over
  // finding_embeddings, same-file cross-run. 0.85 is the prototype's measuring
  // threshold (superset of trigram 0.5); higher-cosine churn is what the 0.92
  // suppression already removes.
  clusterCosine: numEnv('MEMORY_HEALTH_CLUSTER_COSINE', 0.85),
  // Coverage honesty: below this embedded-fraction the semantic reading is
  // NOT authoritative (unscored findings could harbour unseen churn), so the
  // trigger degrades to `unknown` rather than a false GREEN.
  clusterMinCoverage: numEnv('MEMORY_HEALTH_CLUSTER_MIN_COVERAGE', 0.5),
};

function parseArgs(argv) {
  const args = { out: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      process.stdout.write(
        'Usage: node scripts/memory-health.mjs [--out <path.md>] [--json]\n' +
        '\n' +
        'Exit codes:\n' +
        '  0 — all metrics within thresholds (or insufficient data)\n' +
        '  1 — at least one trigger fired — graphify-shape adoption worth reconsidering\n' +
        '  2 — Supabase connection / RPC failed (treated as infra error, not a health signal)\n'
      );
      process.exit(0);
    }
  }
  return args;
}

async function callRpc() {
  // M4 — migrated off direct supabase-js + raw RPC to the typed M1 wrapper.
  // Requires AUDIT_DB_URL (Postgres DSN); the legacy SUPABASE_AUDIT_URL +
  // ANON_KEY pair only sufficed because supabase-js wraps PostgREST.
  if (!process.env.AUDIT_DB_URL) {
    throw new Error('AUDIT_DB_URL not set — cannot run health check (legacy SUPABASE_AUDIT_* keys were sunset in postgres-parity M4)');
  }
  const { memoryHealthMetrics, memoryHealthSemanticCluster } = await import('./lib/db/rpc.mjs');
  const data = await memoryHealthMetrics({ windowDays: WINDOW_DAYS });
  if (!data) throw new Error('memory_health_metrics returned null');
  // Semantic cluster density (migration 20260721140000) — the primary cluster
  // signal, replacing the trigram one. Null on a pre-migration store, in which
  // case the gate transparently falls back to the trigram metric below.
  data.semantic_cluster = await memoryHealthSemanticCluster({
    windowDays: WINDOW_DAYS, cosineThreshold: THRESHOLDS.clusterCosine,
  });
  return data;
}

/**
 * Friction-recurrence section (plan: friction-feedback-loop.md C7, Cluster C).
 * Cross-repo recurrence among OPEN friction, ranked recurrence × cost. WARN by
 * default; HARD-FAIL (exit 1) only when a cluster is BOTH `protected` (a scope_tag
 * in frictionConfig.protectedScopeTags) AND alarming (recurrence + age past the
 * thresholds). Additive + graceful: if the migration/RPC isn't present, the
 * section degrades to "unavailable" and never crashes the health gate.
 *
 * @returns {Promise<{available: boolean, reason?: string, clusters?: Array, hardFail?: boolean}>}
 */
async function collectFrictionSection() {
  if (!process.env.AUDIT_DB_URL) return { available: false, reason: 'cloud-off' };
  try {
    const [{ getFrictionRecurrence }, { frictionConfig }] = await Promise.all([
      import('./lib/store/friction.mjs'),
      import('./lib/config.mjs'),
    ]);
    const res = await getFrictionRecurrence({ repoIdFilter: null, windowDays: WINDOW_DAYS });
    const raw = (res && Array.isArray(res.clusters)) ? res.clusters : [];
    // Mirrors commands.annotateCluster — kept inline so the weekly gate doesn't
    // pull the full friction command graph (file-lock/yaml/breadcrumb).
    const clusters = raw.map((c) => {
      const tags = Array.isArray(c.scope_tags) ? c.scope_tags : [];
      const isProtected = tags.some((t) => frictionConfig.protectedScopeTags.includes(t));
      const weight = frictionConfig.costWeight[c.max_cost] ?? frictionConfig.costWeight.M;
      const alarm = (c.recurrence_count || 0) >= frictionConfig.recurrenceAlarmCount
        && (c.oldest_age_days || 0) > frictionConfig.recurrenceAlarmAgeDays;
      return { ...c, protected: isProtected, rank: (c.recurrence_count || 0) * weight, alarm };
    }).sort((a, b) => (b.protected - a.protected) || (b.alarm - a.alarm) || (b.rank - a.rank));
    const hardFail = clusters.some((c) => c.protected && c.alarm);
    return { available: true, clusters, hardFail };
  } catch (err) {
    // H8 (false-green honesty): distinguish EXPECTED unavailability (migration
    // not applied → undefined_function/table) from an UNEXPECTED subsystem error.
    // The former is a silent skip; the latter must NOT read as benign "unavailable"
    // — it surfaces loudly and fails the gate so a broken subsystem can't pass green.
    const code = err && err.code;
    const expected = code === '42883' || code === '42P01';   // undefined_function / undefined_table
    return { available: false, errored: !expected, reason: err.message, pgCode: code || null };
  }
}

function renderFrictionSection(friction) {
  const lines = [];
  lines.push('## Friction recurrence');
  lines.push('');
  if (!friction.available) {
    if (friction.errored) {
      // H8: a broken subsystem must read as a problem, not a benign skip.
      lines.push(`> ⚠️ **Friction-recurrence check ERRORED** (not skipped): ${friction.reason}` +
        `${friction.pgCode ? ` [${friction.pgCode}]` : ''}. The recurrence signal is UNKNOWN this run — treat as a failure, not green.`);
      lines.push('');
      return lines;
    }
    const why = friction.reason === 'cloud-off'
      ? 'cloud store not configured'
      : `unavailable (${friction.reason} — is the memory_friction migration applied?)`;
    lines.push(`> Friction-recurrence check skipped (expected): ${why}.`);
    lines.push('');
    return lines;
  }
  const clusters = friction.clusters || [];
  if (clusters.length === 0) {
    lines.push('> No recurring open friction across repos in the window. Healthy.');
    lines.push('');
    return lines;
  }
  lines.push('Recurring **open** friction (unmitigated papercuts seen ≥2×), ranked recurrence × cost. ' +
    'A `protected`-scope cluster that alarms HARD-FAILS this gate; everything else is advisory (WARN).');
  lines.push('');
  lines.push('| Rank | Recurrence | Cost | Age (d) | Protected | State | Title |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const c of clusters.slice(0, 15)) {
    const state = (c.protected && c.alarm) ? 'HARD-FAIL' : (c.alarm ? 'WARN' : 'watch');
    const title = String(c.title || c.cluster_key || '').slice(0, 80).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| ${c.rank} | ${c.recurrence_count}× | ${c.max_cost} | ${c.oldest_age_days} | ${c.protected ? 'yes' : '—'} | ${state} | ${title} |`);
  }
  lines.push('');
  if (friction.hardFail) {
    lines.push('> **HARD-FAIL**: a protected-scope friction is recurring and unmitigated. ' +
      'Mitigate it (then `quality link` the fix) or the gate stays red.');
    lines.push('');
  }
  return lines;
}

/**
 * Cluster-density trigger — SEMANTIC (cosine, same-file, cross-run) as the
 * primary signal, with two honesty rules:
 *   - Pre-migration store (semantic RPC absent) → fall back to the trigram
 *     metric, byte-identical to before.
 *   - Coverage below the floor → the reading is `unknown`: NOT fired (a
 *     low-coverage green would be a false-clean), but flagged so it can never
 *     read as a clean pass. Mirrors arch-coverage-gate's "absent = unknown".
 */
function evaluateClusterDensity(metrics, insufficient) {
  const trigram = metrics.cluster_density;
  const sem = metrics.semantic_cluster;
  if (!sem) {
    // Transition/degraded: no semantic RPC → the legacy trigram metric.
    return {
      fired: !insufficient && Number(trigram.median_similar_pairs) >= THRESHOLDS.clusterMedianPairs,
      actual: Number(trigram.median_similar_pairs),
      threshold: THRESHOLDS.clusterMedianPairs,
      similarity: 'trigram (semantic RPC unavailable)',
      reading: 'median similar-pair count across repos (trigram fallback)',
    };
  }
  const median = Number(sem.median_similar_pairs);
  const coveragePct = Number(sem.coverage?.pct ?? 0);
  const lowCoverage = coveragePct / 100 < THRESHOLDS.clusterMinCoverage;
  return {
    fired: !insufficient && !lowCoverage && median >= THRESHOLDS.clusterMedianPairs,
    unknown: lowCoverage,
    actual: median,
    threshold: THRESHOLDS.clusterMedianPairs,
    similarity: `semantic cosine>${THRESHOLDS.clusterCosine}, same-file cross-run`,
    coveragePct,
    trigramActual: Number(trigram.median_similar_pairs),
    reading: lowCoverage
      ? `median semantic same-file re-raise pairs — UNKNOWN (only ${coveragePct}% of open findings embedded; below the ${Math.round(THRESHOLDS.clusterMinCoverage * 100)}% floor)`
      : `median semantic same-file re-raise pairs (${coveragePct}% coverage; trigram companion: ${Number(trigram.median_similar_pairs)})`,
  };
}

function evaluateTriggers(metrics) {
  const { total_findings_in_window, fuzzy_reraise, cluster_density, recurrence } = metrics;

  const insufficient = total_findings_in_window < THRESHOLDS.minFindingsForSignal;

  const triggers = {
    fuzzy_reraise: {
      fired: !insufficient && Number(fuzzy_reraise.rate) > THRESHOLDS.fuzzyReraiseRate,
      actual: Number(fuzzy_reraise.rate),
      threshold: THRESHOLDS.fuzzyReraiseRate,
      reading: `${fuzzy_reraise.fuzzy_matched}/${fuzzy_reraise.new_fingerprints} new-fingerprint findings matched a prior finding by text similarity`
    },
    cluster_density: evaluateClusterDensity(metrics, insufficient),
    recurrence: {
      fired: !insufficient && Number(recurrence.rate) > THRESHOLDS.recurrenceRate,
      actual: Number(recurrence.rate),
      threshold: THRESHOLDS.recurrenceRate,
      reading: `${recurrence.recurred}/${recurrence.fixed_findings} fixed findings recurred with a different fingerprint`
    }
  };

  const firedCount = Object.values(triggers).filter(t => t.fired).length;

  let status;
  if (insufficient) status = 'INSUFFICIENT_DATA';
  else if (firedCount === 0) status = 'GREEN';
  else if (firedCount === 1) status = 'AMBER';
  else status = 'RED';

  return { status, firedCount, insufficient, triggers };
}

function pct(n) {
  return `${(Number(n) * 100).toFixed(1)}%`;
}

function renderMarkdown(metrics, evaluation, friction = { available: false, reason: 'not-run' }) {
  const { status, firedCount, insufficient, triggers } = evaluation;
  const lines = [];

  lines.push('<!-- audit-loop:memory-health -->');
  lines.push('# Memory-health report');
  lines.push('');
  lines.push(`- **Status:** \`${status}\``);
  lines.push(`- **Generated:** ${metrics.generated_at}`);
  lines.push(`- **Window:** last ${metrics.window_days} days`);
  lines.push(`- **Findings in window:** ${metrics.total_findings_in_window}`);
  lines.push(`- **Triggers fired:** ${firedCount} of 3`);
  lines.push('');

  if (insufficient) {
    lines.push(`> Data volume below \`${THRESHOLDS.minFindingsForSignal}\` findings — metrics reported for visibility, but no trigger will fire this run.`);
    lines.push('');
  }

  lines.push('## What this measures');
  lines.push('');
  lines.push('Are we losing signal by storing findings as a flat table with fingerprint-only dedup? If any of the three triggers below fires consistently, a graph-shaped memory (pgvector similarity + community clusters) would likely pay off. All green for 4 weeks → current design is fine.');
  lines.push('');

  lines.push('## Metrics');
  lines.push('');
  lines.push('| Metric | Value | Threshold | Trigger |');
  lines.push('|---|---|---|---|');
  lines.push(`| Fuzzy re-raise rate | ${pct(triggers.fuzzy_reraise.actual)} | \`> ${pct(triggers.fuzzy_reraise.threshold)}\` | ${triggers.fuzzy_reraise.fired ? 'FIRED' : 'green'} |`);
  const cdState = triggers.cluster_density.unknown ? 'UNKNOWN (low coverage)' : (triggers.cluster_density.fired ? 'FIRED' : 'green');
  lines.push(`| Cluster density — ${triggers.cluster_density.similarity} | ${triggers.cluster_density.actual} | \`>= ${triggers.cluster_density.threshold}\` | ${cdState} |`);
  lines.push(`| Fixed-finding recurrence rate | ${pct(triggers.recurrence.actual)} | \`> ${pct(triggers.recurrence.threshold)}\` | ${triggers.recurrence.fired ? 'FIRED' : 'green'} |`);
  lines.push('');

  lines.push('### Fuzzy re-raise');
  lines.push(`${triggers.fuzzy_reraise.reading}.`);
  if (metrics.fuzzy_reraise.samples?.length) {
    lines.push('');
    lines.push('Top sample matches (trigram similarity):');
    for (const s of metrics.fuzzy_reraise.samples) {
      lines.push(`- \`${s.finding_id}\` ↔ \`${s.matched_finding_id}\` — similarity ${s.similarity}`);
    }
  }
  lines.push('');

  lines.push('### Cluster density');
  lines.push(`${triggers.cluster_density.reading}: **${triggers.cluster_density.actual}**.`);
  // Prefer the semantic per-repo breakdown (with coverage) when present.
  const cdPerRepo = metrics.semantic_cluster?.per_repo ?? metrics.cluster_density.per_repo;
  const isSemantic = !!metrics.semantic_cluster;
  if (cdPerRepo?.length) {
    lines.push('');
    lines.push('Top repos by same-file re-raise pairs:');
    for (const r of [...cdPerRepo].slice(0, 10)) {
      const name = r.repo_name || r.repo_id || '(unknown)';
      const cov = isSemantic ? ` — ${r.coverage_pct}% embedded (${r.embedded_findings}/${r.open_findings})` : '';
      lines.push(`- ${name} — ${r.similar_pairs} pairs across ${r.open_findings} open findings${cov}`);
    }
  }
  lines.push('');

  lines.push('### Recurrence');
  lines.push(`${triggers.recurrence.reading}.`);
  if (metrics.recurrence.samples?.length) {
    lines.push('');
    lines.push('Top sample recurrences:');
    for (const s of metrics.recurrence.samples) {
      lines.push(`- fixed \`${s.fixed_id}\` → recurred \`${s.recurred_id}\` — similarity ${s.similarity}`);
    }
  }
  lines.push('');

  for (const l of renderFrictionSection(friction)) lines.push(l);

  lines.push('## Decision rule');
  lines.push('');
  lines.push('- All green for 4 consecutive weeks → shape has academic merit only, no action.');
  lines.push('- Any single trigger fires consistently for 2 weeks → prototype pgvector similarity first (cheapest win), re-measure.');
  lines.push('- Two or more triggers fire → build the full clustering pipeline.');
  lines.push('');
  lines.push('Thresholds live in `scripts/memory-health.mjs` and can be overridden via env vars (`MEMORY_HEALTH_FUZZY_RATE`, `MEMORY_HEALTH_CLUSTER_MEDIAN`, `MEMORY_HEALTH_RECURRENCE_RATE`).');

  return lines.join('\n') + '\n';
}

function atomicWrite(filePath, contents) {
  atomicWriteFileSync(filePath, contents);
}

async function main() {
  const args = parseArgs(process.argv);
  let metrics;
  try {
    metrics = await callRpc();
  } catch (err) {
    process.stderr.write(`memory-health: ${err.message}\n`);
    process.exit(2);
  }

  const evaluation = evaluateTriggers(metrics);
  const friction = await collectFrictionSection();

  if (args.json) {
    process.stdout.write(JSON.stringify({ metrics, evaluation, friction }, null, 2) + '\n');
  }

  const md = renderMarkdown(metrics, evaluation, friction);
  if (args.out) {
    atomicWrite(args.out, md);
    process.stderr.write(`memory-health: wrote ${args.out}\n`);
  } else if (!args.json) {
    process.stdout.write(md);
  }

  // One-line summary on stderr regardless — useful for CI log scanning
  const frictionSummary = friction.available
    ? `friction=${(friction.clusters || []).length}cl${friction.hardFail ? '/HARD-FAIL' : ''}`
    : `friction=${friction.errored ? 'ERROR' : (friction.reason || 'n/a')}`;
  process.stderr.write(
    `memory-health: status=${evaluation.status} triggers=${evaluation.firedCount}/3 ` +
    `fuzzy=${(evaluation.triggers.fuzzy_reraise.actual * 100).toFixed(1)}% ` +
    `cluster=${evaluation.triggers.cluster_density.actual} ` +
    `recurrence=${(evaluation.triggers.recurrence.actual * 100).toFixed(1)}% ${frictionSummary}\n`
  );

  // Exit code: 0 green or insufficient data; 1 if any trigger fired, a protected
  // friction cluster hard-fails (plan C7), OR the friction subsystem ERRORED
  // unexpectedly (H8 — a broken check must not read green).
  process.exit((evaluation.firedCount > 0 || friction.hardFail || friction.errored) ? 1 : 0);
}

export const _internals = { atomicWrite, evaluateClusterDensity, THRESHOLDS };

const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
  } catch { return false; }
})();

if (isMain) {
  main().catch(err => {
    process.stderr.write(`memory-health: fatal: ${err.stack || err.message}\n`);
    process.exit(2);
  });
}

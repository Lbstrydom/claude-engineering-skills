/**
 * @fileoverview `skill-census` — the deterministic (no LLM) per-skill
 * invocation/conversion report. docs/plans/skill-efficacy-census.md Phase 2.
 *
 * @module scripts/lib/cross-skill/commands/census
 */
import { CommandError } from '../dispatch.mjs';

const FORMATS = new Set(['json', 'worksheet']);

/**
 * Positive integer 1-90, or the ArgvError-shaped throw (build-dashboard.mjs's
 * --port pattern). A strict digits-only regex, not `Number.parseInt` alone
 * (round-1 M3/M6 fix) — `parseInt` truncates at the first non-digit, so
 * `--window-days 14days` silently became `14` instead of a validation error.
 */
function parseWindowDays(raw) {
  if (raw == null) return 14;
  if (!/^\d+$/.test(raw)) {
    throw new CommandError('BAD_INPUT', `--window-days must be an integer 1-90 (got ${raw})`);
  }
  const n = Number.parseInt(raw, 10);
  if (n < 1 || n > 90) {
    throw new CommandError('BAD_INPUT', `--window-days must be an integer 1-90 (got ${raw})`);
  }
  return n;
}

function pct(v) {
  if (v == null) return '—';
  return `${v > 0 ? '+' : ''}${v}%`;
}

function rate(cr) {
  if (!cr) return 'n/a';
  const { numerator, denominator } = cr.current;
  if (denominator === 0) return '— (no accepted findings in this window)';
  return `${Math.round((numerator / denominator) * 100)}% (${numerator}/${denominator}, current window — right-censored, see caveat)`;
}

/** PowerShell-safe plain-text table — real values, never `<placeholder>` syntax. */
function renderWorksheet(result) {
  const lines = [];
  lines.push(`Skill-efficacy census — repo ${result.repoName ?? '(unresolved)'} — window ${result.windowDays}d`);
  lines.push(result.cloud ? '' : '⚠ cloud store off — DB-backed rows are missing-optional; trailer-proxy rows below still reflect this checkout.');
  lines.push('');
  for (const r of result.rows) {
    lines.push(`## ${r.skill}`);
    lines.push(`  signal: ${r.signalSource} · quality: ${r.signalQuality}${r.effectiveSince ? ` (effective since ${r.effectiveSince})` : ''}`);
    lines.push(`  window: current ${r.window.current ?? '—'} · prior ${r.window.prior ?? '—'} · trend ${pct(r.trend.pct)} · all-time ${r.allTimeCount ?? '—'}`);
    if (r.roundCount) lines.push(`  roundCount (raw, includes re-runs): current ${r.roundCount.current} · prior ${r.roundCount.prior} · all-time ${r.roundCount.allTime}`);
    if (r.conversionRate) lines.push(`  conversion rate: ${rate(r.conversionRate)}`);
    lines.push(`  last-run: ${r.lastRunAt ?? '—'}`);
    lines.push(`  caveat: ${r.caveat}`);
    lines.push('');
  }
  return lines.join('\n');
}

export async function skillCensusCmd(ctx) {
  const format = ctx.flag('format') ?? 'json';
  if (!FORMATS.has(format)) throw new CommandError('BAD_INPUT', `--format must be one of json, worksheet (got ${format})`);
  const windowDays = parseWindowDays(ctx.flag('window-days'));
  const repoNameOverride = ctx.flag('repo') ?? undefined;

  let result;
  try {
    result = await ctx.deps.censusAllSkills({ root: process.cwd(), windowDays, repoNameOverride });
  } catch (err) {
    // `censusAllSkills` is designed so every expected failure mode (no git
    // checkout, cloud off, a single source query failing) is caught INSIDE
    // it and returned as data, never thrown — so anything that reaches this
    // catch is, by construction, unexpected: a real bug, a malformed
    // dependency response, something this command did not anticipate.
    // Round-1 H7 fix: an earlier version labelled every such case
    // "environment-failure" without the code ever establishing that
    // distinction, which would have mislabelled a genuine defect as an
    // expected degraded state. `unexpected-error` makes no claim beyond
    // "something this command did not anticipate happened" — the ONLY
    // honest label available at this boundary. A legitimately
    // empty-but-valid census is NOT an error and stays ok:true (§2's
    // corrected exit-code contract) — this branch is reserved for what it
    // actually is.
    return { ok: false, cloud: false, reason: 'unexpected-error', error: err.message, rows: [] };
  }

  if (format === 'worksheet') {
    process.stdout.write(`${renderWorksheet(result)}\n`);
    return undefined; // exit 0 with no JSON — the worksheet IS the output
  }
  return result;
}

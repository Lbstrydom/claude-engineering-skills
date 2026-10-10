/**
 * @fileoverview `fleet-telemetry flush|stats` — the store side of /fleet
 * telemetry (docs/plans/fleet-telemetry.md).
 *
 *   flush --spool <dir>  drain a fleet registry's telemetry spool into
 *                        `fleet_events` (fleet spawns this detached; safe to
 *                        run by hand). Cloud off → the events stay spooled.
 *   stats [--days N] [--format json|worksheet]
 *                        golden signals, session flow, weakness findings, and
 *                        this checkout's spool backlog.
 *
 * @module scripts/lib/cross-skill/commands/fleet-telemetry
 */
import path from 'node:path';
import { CommandError } from '../dispatch.mjs';
import { drainSpool, spoolHealth } from '../../fleet/telemetry-drain.mjs';
import { isOwnSpool, spoolDir, telemetryEnabled } from '../../fleet/telemetry.mjs';
import { fleetDir } from '../../fleet/registry.mjs';
import { deriveWeaknesses } from '../../fleet/telemetry-insights.mjs';

const VERBS = new Set(['flush', 'stats']);
const FORMATS = new Set(['json', 'worksheet']);

/**
 * Only ever THIS checkout's `<git-common-dir>/fleet-telemetry`: flush deletes
 * the .json files it drains, and the rows are scoped to the repo resolved from
 * the cwd — so a spool belonging to another repository is refused, never
 * written under this one's id.
 */
function spoolArg(raw, cwd) {
  if (!raw) throw new CommandError('BAD_INPUT', 'flush needs --spool <git-common-dir>/fleet-telemetry');
  const dir = path.resolve(raw);
  if (path.basename(dir) !== 'fleet-telemetry') {
    throw new CommandError('BAD_INPUT', `--spool must be a fleet telemetry spool (…/fleet-telemetry), got ${raw}`);
  }
  let registry;
  try { registry = fleetDir(cwd); } catch {
    throw new CommandError('BAD_INPUT', 'flush must run inside the git repository whose spool it drains');
  }
  if (!isOwnSpool(registry, dir)) {
    throw new CommandError('BAD_INPUT', `--spool ${raw} is not this repository's spool (${spoolDir(registry)}); run flush from that repository`);
  }
  return dir;
}

function parseDays(raw) {
  if (raw == null) return 14;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 90) {
    throw new CommandError('BAD_INPUT', `--days must be an integer 1-90 (got ${raw})`);
  }
  return Number(raw);
}

function localSpool() {
  try { return spoolHealth(spoolDir(fleetDir(process.cwd()))); } catch { return null; }
}

const fmt = (v, d = 0) => (v == null ? '—' : Number(v).toFixed(d));

function renderWorksheet(r) {
  const L = [];
  L.push(`fleet telemetry — ${r.repo ?? '(unresolved repo)'} — last ${r.days}d`);
  if (r.spool?.error) L.push(`local spool: UNREADABLE (${r.spool.error})`);
  else if (r.spool) L.push(`local spool: ${r.spool.pending} pending${r.spool.oldestPendingAt ? ` (oldest ${r.spool.oldestPendingAt})` : ''} · ${r.spool.dropped} dropped · ${r.spool.rejected} rejected`);
  if (!r.measured) {
    let why = 'cloud store off (events stay in the local spool)';
    if (r.cloud) why = r.reason === 'schema-fault' ? 'fleet_events is missing or drifted in this store — run node scripts/setup-postgres.mjs --migrate'
      : r.reason ? `store query failed (${r.reason})` : 'no repo row resolvable for this checkout';
    L.push(`⚠ not measured: ${why}`);
  }
  L.push('', 'weaknesses:');
  if (!r.weaknesses.length) {
    if (r.measured) L.push('  none over the thresholds');
    else if (r.state === 'insufficient') L.push('  not enough data yet to judge any rule — this is not a clean bill of health');
    else L.push('  —');
  }
  if (r.insufficient?.length) L.push(`  (not judged, too little data: ${r.insufficient.join(', ')})`);
  for (const w of r.weaknesses) L.push(`  [${w.severity}] ${w.signal}: ${w.message}`);
  const m = r.telemetry;
  if (m && !m.error) {
    L.push('', 'golden signals (verb · n · ok/refused/pending/error/argv · p50/p95 ms):');
    for (const v of m.goldenSignals) {
      L.push(`  ${(v.mode ? `${v.verb} ${v.mode}` : v.verb).padEnd(22)} ${String(v.n).padStart(5)}  ${v.ok}/${v.refused}/${v.pending}/${v.error}/${v.argv}  ${fmt(v.p50Ms)}/${fmt(v.p95Ms)}`);
    }
    const f = m.sessionFlow;
    L.push('', `session flow: ${f.started} started · ${f.released} released · ${f.abandoned} abandoned · lead time p50 ${fmt(f.leadTimeP50Hours, 1)}h p90 ${fmt(f.leadTimeP90Hours, 1)}h · refusals/session ${fmt(f.refusalsPerSession, 2)} · restacks/session ${fmt(f.restacksPerSession, 2)}`);
    const s = m.saturation;
    L.push(`saturation (status): board items p50 ${fmt(s.itemsP50)} max ${fmt(s.itemsMax)} · held ${s.heldFraction == null ? '—' : `${Math.round(s.heldFraction * 100)}%`} of observations`);
    if (m.topReasons.length) {
      L.push('', 'top refusal / error / WAIT classes:');
      for (const x of m.topReasons) L.push(`  ${String(x.n).padStart(4)}  ${x.outcome.padEnd(8)} ${x.verb.padEnd(14)} ${x.reason_class}`);
    }
    if (m.versions.length) {
      L.push('', 'by tool version (newest first):');
      for (const v of m.versions) L.push(`  ${v.tool.slice(0, 12).padEnd(12)} n=${v.n} status p95 ${fmt(v.statusP95Ms)} ms · error rate ${v.errorRate == null ? '—' : `${(v.errorRate * 100).toFixed(1)}%`}`);
    }
  }
  return L.join('\n');
}

export async function fleetTelemetryCmd(ctx) {
  const verb = ctx.verb;
  if (!VERBS.has(verb)) throw new CommandError('BAD_INPUT', 'usage: fleet-telemetry flush --spool <dir> | stats [--days N] [--format json|worksheet]');

  if (verb === 'flush') {
    const dir = spoolArg(ctx.flag('spool'), process.cwd());
    // Turning telemetry off also stops sending what was already spooled.
    if (!telemetryEnabled(process.env)) return { ok: true, cloud: ctx.cloud.enabled, disabled: true, drained: 0, spool: spoolHealth(dir) };
    if (!ctx.cloud.enabled) return { ...ctx.degrade(), drained: 0, spool: spoolHealth(dir) };
    const scope = await ctx.resolveScope();
    // A row with no repo is unattributable: keep the events spooled until the
    // checkout resolves to a repo row, rather than writing them nowhere.
    if (scope.kind !== 'scoped' || !scope.repoId) {
      throw new CommandError('REPO_UNRESOLVED',
        `fleet telemetry not flushed: this checkout does not resolve to a repo row in the store (${scope.reason ?? scope.kind}); events stay spooled`,
        { remaining: spoolHealth(dir).pending }, 1);
    }
    const repoId = scope.repoId;
    const repoName = scope.slug ?? null;
    const res = await drainSpool({ dir, write: (events) => ctx.deps.recordFleetEvents(repoId, repoName, events) });
    if (!res.ok) {
      throw new CommandError('WRITE_FAILED',
        `fleet telemetry not persisted (${res.reason}${res.error ? `: ${res.error}` : ''}); ${res.remaining} event(s) stay spooled`,
        { reason: res.reason ?? null, remaining: res.remaining }, 1);
    }
    return { ok: true, cloud: true, ...res };
  }

  const format = ctx.flag('format') ?? 'json';
  if (!FORMATS.has(format)) throw new CommandError('BAD_INPUT', `--format must be one of json, worksheet (got ${format})`);
  const days = parseDays(ctx.flag('days'));
  const spool = localSpool();
  let result;
  if (!ctx.cloud.enabled) {
    const w = deriveWeaknesses(null, spool);
    result = { ...ctx.degrade(), measured: false, state: w.state, days, repo: null, spool, telemetry: null, weaknesses: w.findings };
  } else {
    const scope = await ctx.resolveScope();
    const repoId = scope.kind === 'scoped' ? scope.repoId : null;
    const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
    const telemetry = repoId ? await ctx.deps.readFleetTelemetry(repoId, { sinceIso }) : null;
    const w = deriveWeaknesses(telemetry, spool);
    result = {
      ok: true, cloud: true, measured: w.measured, state: w.state, insufficient: w.insufficient, days, repo: scope.slug ?? (repoId ? 'this checkout' : null), spool, telemetry, weaknesses: w.findings,
      ...(telemetry?.error ? { reason: telemetry.schemaFault ? 'schema-fault' : 'query-failed' } : {}),
    };
  }
  if (format === 'worksheet') {
    process.stdout.write(`${renderWorksheet(result)}\n`);
    return undefined;
  }
  return result;
}

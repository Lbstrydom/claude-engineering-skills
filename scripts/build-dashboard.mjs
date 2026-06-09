#!/usr/bin/env node
/**
 * @fileoverview CLI entry for the local dashboard generator. Builds the
 * reference and telemetry dashboards (both gitignored, per-machine local-only
 * — see .gitignore) and per-run audit-findings pages, or serves them over a
 * path-contained localhost server.
 *
 * Usage:
 *   node scripts/build-dashboard.mjs reference     # dashboard/index.html
 *   node scripts/build-dashboard.mjs telemetry     # dashboard/telemetry.html
 *   node scripts/build-dashboard.mjs all           # both
 *   node scripts/build-dashboard.mjs audit-run [--run <id>]  # dashboard/audit-runs/<id>.html
 *   node scripts/build-dashboard.mjs serve [--port N]   # build all, then serve
 *
 * Output paths are fixed (no --out). For the build subcommands the exit
 * code is non-zero when a *commanded* target is `degraded` (a source was
 * invalid / errored). `serve` is long-running — it reports degraded state
 * to stderr and serves anyway. See docs/plans/local-dashboard.md §7.1.
 *
 * @module scripts/build-dashboard
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ArgvError, emit, ensureDir } from './lib/cli-io.mjs';
import { atomicWriteFileSync } from './lib/file-io.mjs';
import { collectReference } from './lib/dashboard/collect-reference.mjs';
import { collectTelemetry } from './lib/dashboard/collect-telemetry.mjs';
import { collectAuditRun } from './lib/dashboard/collect-audit-run.mjs';
import { renderDocument } from './lib/dashboard/render.mjs';
import { loadAssets } from './lib/dashboard/load-assets.mjs';
import { serve } from './lib/dashboard/serve.mjs';
import { assertRepoRoot } from './lib/assert-repo-root.mjs';

const HELP = `build-dashboard — generate the local navigable dashboard

USAGE
  node scripts/build-dashboard.mjs reference        Build dashboard/index.html
  node scripts/build-dashboard.mjs telemetry        Build dashboard/telemetry.html
  node scripts/build-dashboard.mjs all              Build both
  node scripts/build-dashboard.mjs audit-run [--run <id>]  Build dashboard/audit-runs/<id>.html
  node scripts/build-dashboard.mjs serve [--port N] Build both, then serve

Output paths are fixed under dashboard/. The build subcommands
(reference|telemetry|all|audit-run) exit non-zero on a degraded build.
\`audit-run\` resolves the run from --run or .audit/last-audit-run.json; with no
resolvable id it exits non-zero without writing a file. \`serve\` is a
long-running server: it reports any degraded state to stderr and serves
anyway (a degraded page must stay viewable — its warnings are the point).`;

const OUT_DIR = path.join(process.cwd(), 'dashboard');
const REF_OUT = path.join(OUT_DIR, 'index.html');
const TEL_OUT = path.join(OUT_DIR, 'telemetry.html');
const AUDIT_RUN_DIR = path.join(OUT_DIR, 'audit-runs');
const DEFAULT_PORT = 4173;

function parseArgs(argv) {
  const args = { cmd: null, port: DEFAULT_PORT, explicitPort: false, run: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; }
    else if (a === '--port') {
      const v = argv[++i];
      const n = Number.parseInt(v, 10);
      if (!Number.isInteger(n) || n < 1024 || n > 65535) {
        throw new ArgvError(`--port must be an integer 1024–65535 (got ${v})`);
      }
      args.port = n;
      args.explicitPort = true;
    } else if (a === '--run') {
      const v = argv[++i];
      if (v == null || v.startsWith('--') || !String(v).trim()) {
        throw new ArgvError('--run requires a run id value');
      }
      args.run = String(v).trim();
    } else if (a.startsWith('--')) {
      throw new ArgvError(`Unknown flag: ${a}`);
    } else if (!args.cmd) {
      args.cmd = a;
    } else {
      throw new ArgvError(`Unexpected argument: ${a}`);
    }
  }
  if (!args.help) {
    if (!args.cmd) throw new ArgvError('Missing subcommand (reference|telemetry|all|audit-run|serve)');
    if (!['reference', 'telemetry', 'all', 'audit-run', 'serve'].includes(args.cmd)) {
      throw new ArgvError(`Unknown subcommand: ${args.cmd}`);
    }
    if (args.explicitPort && args.cmd !== 'serve') {
      throw new ArgvError('--port is only valid with the `serve` subcommand');
    }
    if (args.run !== undefined && args.cmd !== 'audit-run') {
      throw new ArgvError('--run is only valid with the `audit-run` subcommand');
    }
  }
  return args;
}

/**
 * Filename slug for a run id (L2): lowercase, non-`[a-z0-9-]` → `-`, collapse
 * repeats, trim edges. Empty result is an error (never write `-.html`).
 */
function slugifyRunId(runId) {
  const slug = String(runId).toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new ArgvError(`Cannot derive a safe filename from run id "${runId}"`);
  return slug;
}

/** Best-effort git provenance (base HEAD + dirty flag). */
function gitProvenance() {
  const run = (a) => execFileSync('git', a, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const baseSha = run(['rev-parse', '--short', 'HEAD']);
    let dirty = false;
    try { dirty = run(['status', '--porcelain']).length > 0; } catch { /* ignore */ }
    return { baseSha, dirty };
  } catch {
    return { baseSha: 'unknown', dirty: false };
  }
}

function isDegraded(sources) {
  return Object.values(sources).some(
    (s) => s.status === 'invalid' || s.status === 'unexpected-error',
  );
}

async function buildReference(git, assets) {
  const data = collectReference({ git });
  const html = renderDocument(data, 'reference', assets);
  ensureDir(OUT_DIR);
  atomicWriteFileSync(REF_OUT, html);
  return { target: 'reference', out: REF_OUT, degraded: isDegraded(data.sources), sources: data.sources };
}

async function buildTelemetry(git, assets) {
  const data = await collectTelemetry({ git });
  const html = renderDocument(data, 'telemetry', assets);
  ensureDir(OUT_DIR);
  atomicWriteFileSync(TEL_OUT, html);
  return { target: 'telemetry', out: TEL_OUT, degraded: isDegraded(data.sources), sources: data.sources };
}

/**
 * Build one per-run audit-findings page. The output path depends solely on
 * whether a runId resolved (H1, G3): the two no-id codes
 * (missing/invalid pointer) return a `{ cliError }` so the CLI boundary
 * (`main`) owns the stderr message + non-zero exit — a build helper should not
 * terminate the process (mirrors buildReference/buildTelemetry, which return
 * result objects). Every id-resolved code (ok / cloud_disabled /
 * run_not_found / query_error) renders its panel and writes
 * dashboard/audit-runs/<slug>.html, returning a normal build result.
 */
async function buildAuditRun(git, assets, runArg) {
  // build-dashboard owns the wall-clock stamp (scripts can't always call it
  // mid-pipeline — plan §7.0 G2) and augments gitProvenance with it + mode.
  const provenance = { baseSha: git.baseSha, dirty: git.dirty, generatedAt: new Date().toISOString(), mode: 'audit-run' };
  const { data, status } = await collectAuditRun({ runId: runArg, provenance });

  if (status.code === 'missing_run_pointer') {
    return { cliError: { code: status.code, message: 'No run specified and no .audit/last-audit-run.json — run an audit or pass --run <id>.' } };
  }
  if (status.code === 'invalid_run_pointer') {
    return { cliError: { code: status.code, message: '.audit/last-audit-run.json is unreadable or malformed — pass --run <id> explicitly.' } };
  }

  const slug = slugifyRunId(data.auditRun.runId);
  const html = renderDocument(data, 'audit-run', assets);
  ensureDir(AUDIT_RUN_DIR);
  const out = path.join(AUDIT_RUN_DIR, `${slug}.html`);
  atomicWriteFileSync(out, html);
  // query_error is the only degraded id-resolved code (cloud_disabled /
  // run_not_found render valid, intentional panels).
  return {
    target: 'audit-run',
    out,
    degraded: status.code === 'query_error',
    sources: { auditRun: { status: status.code === 'query_error' ? 'unexpected-error' : 'ok', detail: data.src.detail || '' } },
  };
}

function reportDegraded(results) {
  for (const r of results) {
    if (!r.degraded) continue;
    for (const [name, s] of Object.entries(r.sources)) {
      if (s.status === 'invalid' || s.status === 'unexpected-error') {
        process.stderr.write(`  [dashboard] ${r.target}: source "${name}" is ${s.status} — ${s.detail}\n`);
      } else if (s.status === 'missing-optional' && name === 'architecture') {
        process.stderr.write(`  [dashboard] ${r.target}: architecture data not built — run \`npm run dashboard:setup\` (or \`arch:refresh && arch:render\`) to populate the Architecture tab\n`);
      }
    }
  }
}

async function main() {
  assertRepoRoot(import.meta.url);
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (err) {
    if (err.code === 'ARGV_ERROR') {
      process.stderr.write(`Error: ${err.message}\n\n${HELP}\n`);
      process.exit(1);
    }
    throw err;
  }
  if (args.help) { process.stdout.write(HELP + '\n'); process.exit(0); }

  const git = gitProvenance();
  const assets = loadAssets();
  const results = [];
  // `commanded` = the target(s) the subcommand is responsible for; the
  // exit code reflects ONLY these. A side build (e.g. the auto-telemetry
  // build that `reference` mode triggers to seed the nav link) is reported
  // but must not fail the commanded target (plan §7.1 / Gemini M17).
  let commanded;

  if (args.cmd === 'reference') {
    const ref = await buildReference(git, assets);
    results.push(ref);
    commanded = [ref];
    // Also rebuild telemetry.html so BOTH pages stay on the same commit —
    // otherwise the committed index.html and the gitignored telemetry.html
    // drift apart and show mismatched provenance. Best-effort SIDE build: a
    // thrown failure here must not fail the commanded `reference` target.
    try {
      results.push(await buildTelemetry(git, assets));
    } catch (err) {
      process.stderr.write(`  [dashboard] side telemetry build failed (reference unaffected): ${err.message}\n`);
    }
  } else if (args.cmd === 'telemetry') {
    results.push(await buildTelemetry(git, assets));
    commanded = results.slice();
  } else if (args.cmd === 'audit-run') {
    const r = await buildAuditRun(git, assets, args.run);
    // No-id CLI-only states (G3): the boundary owns stderr + non-zero exit.
    if (r.cliError) {
      process.stderr.write(`  [dashboard] ${r.cliError.message}\n`);
      process.exit(2);
    }
    results.push(r);
    commanded = [r];
  } else { // all | serve
    results.push(...await Promise.all([buildReference(git, assets), buildTelemetry(git, assets)]));
    commanded = results.slice();
  }

  reportDegraded(results);
  const degraded = commanded.some((r) => r.degraded);

  if (args.cmd === 'serve') {
    await serve({ dir: OUT_DIR, port: args.port, explicitPort: args.explicitPort });
    return; // server keeps the process alive until Ctrl+C
  }

  emit({
    ok: !degraded,
    degraded,
    built: results.map((r) => ({ target: r.target, out: path.relative(process.cwd(), r.out), degraded: r.degraded })),
  });
  process.exit(degraded ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    process.stderr.write(`  [build-dashboard] FATAL: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}

export { parseArgs, isDegraded, gitProvenance };

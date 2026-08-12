#!/usr/bin/env node
/**
 * @fileoverview Requirements-layer CLI — extract / reconcile / index.
 * Plan: docs/plans/requirements-layer.md.
 *
 *   node scripts/requirements.mjs extract --files a.mjs,b.mjs [--runs 2]
 *   node scripts/requirements.mjs reconcile
 *   node scripts/requirements.mjs index [--json]
 *
 * `extract` and `reconcile` hold a repo-scoped lock so concurrent runs
 * cannot interleave `.requirements/` (audit M2). `overrides` is JSON
 * (`.requirements/overrides.json`) — dependency-free, no YAML parser needed.
 *
 * @module scripts/requirements
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { assertRepoRoot } from './lib/assert-repo-root.mjs';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import { atomicWriteFileSync } from './lib/file-io.mjs';
import { withFileLock } from './lib/file-lock.mjs';
import { extractRequirements } from './lib/requirements/extract.mjs';
import { classifyGaps, classifyGapsBatched, isDegradedGapAssessment } from './lib/requirements/gap-challenge.mjs';
import { loadLedger, writeLedger, reconcile, deriveIndex, statusFor, inferAmbiguousFromStatus } from './lib/requirements/ledger.mjs';
import { renderRequirementsMap } from './lib/requirements/render.mjs';
import { CandidatesFileSchema, GapsFileSchema, OverridesSchema } from './lib/requirements/schema.mjs';

const REQ_DIR = '.requirements';
const MAX_RUNS = 5;   // upper bound on --runs (cost/latency guard — audit M11)
const CANDIDATES = `${REQ_DIR}/candidates.json`;
const GAPS = `${REQ_DIR}/gaps.json`;
const OVERRIDES = `${REQ_DIR}/overrides.json`;
const LOCK = `${REQ_DIR}/.lock`;

const HELP = `requirements — extract / reconcile / index / render the de-facto requirements ledger

  node scripts/requirements.mjs extract --files <a,b,...> [--runs 2]
  node scripts/requirements.mjs reconcile
  node scripts/requirements.mjs reassess-gaps [--dry-run]
  node scripts/requirements.mjs index [--json]
  node scripts/requirements.mjs render [--out docs/requirements-map.md]
`;

/**
 * Union of every flag any subcommand accepts. `assertKnownFlags` validates
 * flag NAMES only, so the bare `extract|reconcile|index|render` positional is
 * ignored and per-subcommand semantics stay with each subcommand's parser.
 *
 * `render --check` is a SAFE mode over a MUTATING default (it otherwise
 * overwrites the committed `docs/requirements-map.md`), so a dropped `--chek`
 * silently rewrites the artifact the freshness gate compares against.
 */
const KNOWN_FLAGS = [
  // extract
  '--files', '--runs',
  // index
  '--json',
  // render
  '--out', '--check',
  // reassess-gaps: preview the tally without writing the ledger
  '--dry-run',
  // global
  '--help',
];

function gitSha() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

async function cmdExtract(argv, baseDir) {
  const filesArg = flag(argv, '--files');
  if (!filesArg) { process.stderr.write('Error: extract requires --files <a,b,...>\n'); process.exit(1); }
  const files = filesArg.split(',').map((s) => s.trim()).filter(Boolean);
  // --runs: explicit integer validation (audit M11/L3) — `parseInt` alone
  // lets `--runs nope` through as NaN, which later fails obscurely.
  let runs = 2;
  const runsArg = flag(argv, '--runs');
  if (runsArg != null) {
    const n = Number(runsArg);
    if (!Number.isInteger(n) || n < 1 || n > MAX_RUNS) {
      process.stderr.write(`Error: --runs must be an integer between 1 and ${MAX_RUNS}\n`);
      process.exit(1);
    }
    runs = n;
  }

  await withFileLock(path.join(baseDir, LOCK), {}, async () => {
    const sourceSha = gitSha();
    const { candidates, coveredFiles, runsSucceeded, runsRequested } =
      await extractRequirements({ files, baseDir, runs });
    const gaps = await classifyGaps(candidates);

    fs.mkdirSync(path.join(baseDir, REQ_DIR), { recursive: true });
    const candidatesFile = {
      generatedAt: new Date().toISOString(), extractionSourceSha: sourceSha, coveredFiles, candidates,
    };
    const gapsFile = { generatedAt: new Date().toISOString(), assessments: gaps };
    // Validate BOTH before writing EITHER — a schema failure aborts with no
    // file touched. Then write `gaps.json` FIRST and `candidates.json` LAST:
    // `candidates.json` is the strictly-required input `reconcile` validates,
    // so making it the final write makes it the effective commit point — a
    // crash between the two writes leaves a torn pair that `reconcile` still
    // degrades cleanly from (advisory gaps mismatch → no-gap), never a state
    // where new candidates reference gaps that were never written (audit M2).
    CandidatesFileSchema.parse(candidatesFile);
    GapsFileSchema.parse(gapsFile);
    atomicWriteFileSync(path.join(baseDir, GAPS), JSON.stringify(gapsFile, null, 2) + '\n');
    atomicWriteFileSync(path.join(baseDir, CANDIDATES), JSON.stringify(candidatesFile, null, 2) + '\n');
    process.stderr.write(`  [requirements] extract: ${candidates.length} candidate(s) from ${coveredFiles.length} file(s); ${runsSucceeded}/${runsRequested} runs\n`);
    process.stdout.write(`extracted ${candidates.length} candidates → ${CANDIDATES} + ${GAPS}\n`);
  });
}

async function cmdReconcile(argv, baseDir) {
  // The critical section THROWS on fatal input errors rather than calling
  // `process.exit` — exiting inside the `withFileLock` callback skips the
  // lock's `finally` release and orphans the `.lock` file (audit M15).
  // Failures unwind normally; the lock releases; we set the exit code here.
  try {
    await withFileLock(path.join(baseDir, LOCK), {}, () => {
      const read = (p) => JSON.parse(fs.readFileSync(path.join(baseDir, p), 'utf-8'));
      let candidatesFile;
      try { candidatesFile = CandidatesFileSchema.parse(read(CANDIDATES)); }
      catch (e) { throw new Error(`${CANDIDATES} missing/invalid — run extract first (${e.message})`); }

      // Gaps are advisory — degrade rather than block — but distinguish a
      // genuinely-absent file (fine) from a present-but-corrupt one, which
      // must NOT be silently treated as "no gaps / all clean" (audit H1/H3).
      const gapsFile = (() => {
        if (!fs.existsSync(path.join(baseDir, GAPS))) {
          process.stderr.write(`  [requirements] note: ${GAPS} absent — reconciling with no gap assessments\n`);
          return { assessments: [] };
        }
        try { return GapsFileSchema.parse(read(GAPS)); }
        catch (e) {
          process.stderr.write(`  [requirements] WARN: ${GAPS} present but INVALID — gap assessments dropped (NOT treated as clean); re-run extract — ${e.message}\n`);
          return { assessments: [] };
        }
      })();
      const overrides = (() => {
        if (!fs.existsSync(path.join(baseDir, OVERRIDES))) return {};
        try { return OverridesSchema.parse(read(OVERRIDES)); }
        catch (e) {
          // overrides.json encodes HUMAN intent — unlike the advisory,
          // LLM-generated gaps file, silently proceeding with `{}` would
          // DISCARD operator accept/reject/edit decisions. Fail closed: the
          // operator must fix or remove the file (audit M2/M4).
          throw new Error(`${OVERRIDES} is present but invalid — fix or remove it (operator overrides must not be silently dropped): ${e.message}`);
        }
      })();

      const ledger = reconcile({
        candidates: candidatesFile.candidates,
        coveredFiles: candidatesFile.coveredFiles,
        gapAssessments: gapsFile.assessments,
        overrides,
        priorLedger: loadLedger({ baseDir }),
        commitSha: gitSha(),
        extractionSourceSha: candidatesFile.extractionSourceSha,
      });
      writeLedger(ledger, { baseDir });
      const byStatus = ledger.requirements.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
      process.stdout.write(`reconciled ${ledger.requirements.length} requirements → ${JSON.stringify(byStatus)}\n`);
    });
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
  }
}

/**
 * Re-run the gap-challenge pass over EXISTING ledger entries whose prior
 * assessment was a degraded placeholder — never a whole re-extract, and never
 * over entries already genuinely assessed.
 *
 * **Why this command exists.** `classifyGaps` is called exactly once, inline,
 * inside `cmdExtract`, over that single call's freshly-extracted candidates —
 * there is no path to gap-challenge requirements already sitting in the
 * ledger. Extraction is the expensive step (real LLM spend across every
 * source file); re-running it just to get a second shot at gap assessment
 * would waste that spend to fix a defect in a DIFFERENT, decoupled pass. This
 * command targets only the pass that actually failed.
 *
 * Recomputes `status` through the exact same `statusFor` `reconcile` uses —
 * `ambiguous: false` is correct here (no new candidates are being merged, so
 * no split/merge identity question exists); `override` is read from
 * `overrides.json` so a human accept-decision on a requirement cannot be
 * silently overwritten by a gap re-assessment.
 */
async function cmdReassessGaps(argv, baseDir) {
  const dryRun = argv.includes('--dry-run');
  try {
    await withFileLock(path.join(baseDir, LOCK), {}, async () => {
      const ledger = loadLedger({ baseDir });
      const overrides = (() => {
        if (!fs.existsSync(path.join(baseDir, OVERRIDES))) return {};
        try { return OverridesSchema.parse(JSON.parse(fs.readFileSync(path.join(baseDir, OVERRIDES), 'utf-8'))); }
        catch (e) {
          // Same fail-closed reasoning as cmdReconcile: overrides encode HUMAN
          // intent, so an invalid file must block rather than silently apply
          // no overrides (which could demote a human-accepted requirement).
          throw new Error(`${OVERRIDES} is present but invalid — fix or remove it (operator overrides must not be silently dropped): ${e.message}`);
        }
      })();

      const toReassess = ledger.requirements.filter((r) => isDegradedGapAssessment(r.gap));
      if (toReassess.length === 0) {
        process.stdout.write(`reassess-gaps: 0/${ledger.requirements.length} requirement(s) need reassessment — nothing to do\n`);
        return;
      }

      const assessments = await classifyGapsBatched(toReassess);
      // classifyGaps's own contract guarantees one assessment per candidate
      // (defaulting to a 'not assessed' placeholder for anything the LLM
      // missed) — so this can only diverge if that contract breaks. A loud
      // check here rather than a silent `byId.get(id) ?? skip`, because
      // silently skipping entries is the exact failure class this command
      // exists to fix.
      if (assessments.length !== toReassess.length) {
        throw new Error(`classifyGapsBatched returned ${assessments.length} assessments for ${toReassess.length} candidates — contract violation`);
      }
      const byId = new Map(assessments.map((a) => [a.requirementId, a]));

      const byStatusBefore = ledger.requirements.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
      for (const req of toReassess) {
        // Computed on the OLD gap, before it is overwritten below — see
        // `inferAmbiguousFromStatus`'s docstring for why this must not be a
        // hardcoded `false`.
        const wasAmbiguous = inferAmbiguousFromStatus(req);
        const a = byId.get(req.id);
        req.gap = { ...a, requirementId: req.id };
        req.status = statusFor({ req, gap: req.gap, override: overrides[req.id], ambiguous: wasAmbiguous });
      }
      const byStatusAfter = ledger.requirements.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
      const stillDegraded = ledger.requirements.filter((r) => isDegradedGapAssessment(r.gap)).length;

      if (!dryRun) writeLedger(ledger, { baseDir });
      process.stdout.write(
        `reassess-gaps: ${toReassess.length}/${ledger.requirements.length} reassessed`
        + `${dryRun ? ' (DRY RUN — not written)' : ''} → before ${JSON.stringify(byStatusBefore)} `
        + `after ${JSON.stringify(byStatusAfter)} (still degraded: ${stillDegraded})\n`,
      );
    });
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
  }
}

function cmdIndex(argv, baseDir) {
  const idx = deriveIndex(loadLedger({ baseDir }));
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(idx, null, 2) + '\n');
  } else {
    for (const r of idx) process.stdout.write(`[${r.kind}|${r.status}] ${r.id}  ${r.assertion}\n`);
    process.stdout.write(`(${idx.length} requirements)\n`);
  }
}

/** Render the ledger as a human-readable map (Mermaid pie + grouped tables). */
/**
 * The repo's name, from COMMITTED source.
 *
 * Previously `path.basename(cwd)`, which made the rendered map depend on what
 * the checkout directory happens to be called — the committed map carried the
 * title "clusterB" because it was last generated inside a git worktree of that
 * name. That is not a pure function of committed source, so two clones
 * legitimately disagreed and the freshness check below would have false-failed
 * for anyone whose directory is named differently. Same class as the
 * CRLF-vs-committed-bytes bug the pre-push sandbox caught in skills.manifest.
 */
export function repoNameFor(baseDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(baseDir, 'package.json'), 'utf8'));
    if (pkg?.name) return pkg.name;
  } catch { /* fall through */ }
  return path.basename(path.resolve(baseDir));
}

/** Render the map. Pure w.r.t. committed source — no clock, sha, or cwd. */
function renderMap(baseDir) {
  const ledger = loadLedger({ baseDir });
  const md = renderRequirementsMap(ledger, { repoName: repoNameFor(baseDir) });
  return { ledger, text: md.endsWith('\n') ? md : `${md}\n` };
}

function cmdRender(argv, baseDir) {
  const outRel = flag(argv, '--out') || 'docs/requirements-map.md';
  const outAbs = path.join(baseDir, outRel);
  const { ledger, text } = renderMap(baseDir);

  // `--check` mirrors `plans:index:check`: regenerate in memory and compare,
  // never write. This is what makes the map a Category-B artefact — committed
  // AND freshness-verified — rather than a committed file whose staleness
  // nothing detects (it had drifted by 26 requirements).
  if (argv.includes('--check')) {
    let current = null;
    try { current = fs.readFileSync(outAbs, 'utf8'); } catch { /* missing */ }
    if (current === text) {
      process.stdout.write(`\x1b[32m✓\x1b[0m requirements:map — ${outRel} is up to date.\n`);
      return;
    }
    process.stderr.write(`\n\x1b[31m\x1b[1m✗ requirements:map\x1b[0m — ${outRel} is ${current === null ? 'missing' : 'stale'}.\n`);
    process.stderr.write('\x1b[2m  The ledger changed without regenerating the map.\n');
    process.stderr.write('  Fix: npm run requirements:map\x1b[0m\n\n');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  atomicWriteFileSync(outAbs, text);
  process.stderr.write(`  [requirements] render: ${ledger.requirements.length} requirement(s) → ${outRel}\n`);
  process.stdout.write(`requirements map → ${outRel}\n`);
}

async function main() {
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'requirements.mjs' });
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    throw err;
  }
  assertRepoRoot(import.meta.url);
  const argv = process.argv.slice(2);
  const mode = argv[0];
  const baseDir = process.cwd();
  if (!mode || mode === '--help' || mode === '-h') { process.stdout.write(HELP); process.exit(mode ? 0 : 1); }
  // Ensure `.requirements/` exists before any `withFileLock` — the lock
  // file lives inside it.
  if (mode === 'extract' || mode === 'reconcile' || mode === 'reassess-gaps') {
    fs.mkdirSync(path.join(baseDir, REQ_DIR), { recursive: true });
  }
  if (mode === 'extract') return cmdExtract(argv.slice(1), baseDir);
  if (mode === 'reconcile') return cmdReconcile(argv.slice(1), baseDir);
  if (mode === 'reassess-gaps') return cmdReassessGaps(argv.slice(1), baseDir);
  if (mode === 'index') return cmdIndex(argv.slice(1), baseDir);
  if (mode === 'render') return cmdRender(argv.slice(1), baseDir);
  process.stderr.write(`Error: unknown command '${mode}'\n\n${HELP}`);
  process.exit(1);
}

// `main()` used to run unconditionally, so merely IMPORTING this module ran the
// CLI — it printed help and called process.exit(1). That made the file
// untestable from a test runner and is a landmine for any future importer.
// Same isMain guard the other CLIs here use (check-rls.mjs, security-triage.mjs).
const isMain = (() => {
  const argv1 = process.argv[1]?.replace(/\\/g, '/');
  if (!argv1) return false;
  return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
})();

if (isMain) {
  main().catch((err) => {
    process.stderr.write(`  [requirements] FATAL: ${err.message}\n`);
    process.exit(1);
  });
}

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
import { atomicWriteFileSync } from './lib/file-io.mjs';
import { withFileLock } from './lib/brainstorm/file-lock.mjs';
import { extractRequirements } from './lib/requirements/extract.mjs';
import { classifyGaps } from './lib/requirements/gap-challenge.mjs';
import { loadLedger, writeLedger, reconcile, deriveIndex } from './lib/requirements/ledger.mjs';
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
  node scripts/requirements.mjs index [--json]
  node scripts/requirements.mjs render [--out docs/requirements-map.md]
`;

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
function cmdRender(argv, baseDir) {
  const ledger = loadLedger({ baseDir });
  const repoName = path.basename(path.resolve(baseDir));
  const md = renderRequirementsMap(ledger, { repoName });
  const outRel = flag(argv, '--out') || 'docs/requirements-map.md';
  const outAbs = path.join(baseDir, outRel);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  atomicWriteFileSync(outAbs, md.endsWith('\n') ? md : md + '\n');
  process.stderr.write(`  [requirements] render: ${ledger.requirements.length} requirement(s) → ${outRel}\n`);
  process.stdout.write(`requirements map → ${outRel}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const mode = argv[0];
  const baseDir = process.cwd();
  if (!mode || mode === '--help' || mode === '-h') { process.stdout.write(HELP); process.exit(mode ? 0 : 1); }
  // Ensure `.requirements/` exists before any `withFileLock` — the lock
  // file lives inside it.
  if (mode === 'extract' || mode === 'reconcile') {
    fs.mkdirSync(path.join(baseDir, REQ_DIR), { recursive: true });
  }
  if (mode === 'extract') return cmdExtract(argv.slice(1), baseDir);
  if (mode === 'reconcile') return cmdReconcile(argv.slice(1), baseDir);
  if (mode === 'index') return cmdIndex(argv.slice(1), baseDir);
  if (mode === 'render') return cmdRender(argv.slice(1), baseDir);
  process.stderr.write(`Error: unknown command '${mode}'\n\n${HELP}`);
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`  [requirements] FATAL: ${err.message}\n`);
  process.exit(1);
});

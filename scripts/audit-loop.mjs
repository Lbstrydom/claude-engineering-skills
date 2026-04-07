#!/usr/bin/env node
/**
 * @fileoverview Single entry point orchestrating the full audit loop.
 *
 * Runs all 8 steps end-to-end: scope → audit → triage → ledger → fix → verify → final review.
 * Designed for CLI use when not running inside an AI skill orchestrator (Claude Code, Copilot).
 *
 * Usage:
 *   node scripts/audit-loop.mjs code <plan-file>                     # Audit code (default scope=diff)
 *   node scripts/audit-loop.mjs code <plan-file> --scope full        # Full repo audit
 *   node scripts/audit-loop.mjs code <plan-file> --max-rounds 3      # Limit rounds
 *   node scripts/audit-loop.mjs code <plan-file> --skip-gemini       # Skip Step 7
 *   node scripts/audit-loop.mjs code <plan-file> --exclude-paths 'scripts/**,vendor/**'
 *   node scripts/audit-loop.mjs plan <plan-file>                     # Audit plan only
 *
 * Requires: OPENAI_API_KEY. Optional: GEMINI_API_KEY, ANTHROPIC_API_KEY, SUPABASE_AUDIT_URL.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

// ── Helpers ──────────────────────────────────────────────────────────────────

function banner(text) {
  const line = '═'.repeat(50);
  console.log(`\n${B}${line}\n  ${text}\n${line}${X}\n`);
}

function run(cmd, args, opts = {}) {
  const timeout = opts.timeout || 300000; // 5 min default
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout,
      ...opts,
    });
  } catch (err) {
    if (opts.ignoreError) return err.stdout || '';
    throw err;
  }
}

function runAudit(planFile, extraArgs = [], stderrFile = null) {
  const args = ['scripts/openai-audit.mjs', 'code', planFile, ...extraArgs];
  try {
    const result = execFileSync('node', args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 600000, // 10 min
    });
    return { stdout: result, stderr: '', success: true };
  } catch (err) {
    // execFileSync throws on non-zero exit, but stderr is in err.stderr
    return { stdout: err.stdout || '', stderr: err.stderr || '', success: err.status === 0 };
  }
}

function parseResults(outFile) {
  try {
    const raw = fs.readFileSync(outFile, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function countFindings(results) {
  if (!results) return { high: 0, medium: 0, low: 0, total: 0 };
  const findings = results.findings || [];
  const high = findings.filter(f => f.severity === 'HIGH').length;
  const medium = findings.filter(f => f.severity === 'MEDIUM').length;
  const low = findings.filter(f => f.severity === 'LOW').length;
  return { high, medium, low, total: findings.length };
}

function isConverged(counts) {
  return counts.high === 0 && counts.medium <= 2;
}

// ── Arg Parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    mode: argv[0],         // 'code' or 'plan'
    planFile: argv[1],
    maxRounds: 4,
    skipGemini: false,
    scope: null,           // null = use openai-audit default (diff)
    base: null,
    excludePaths: null,
    files: null,
    passes: null,
    noTools: false,
    strictLint: false,
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--max-rounds': args.maxRounds = parseInt(argv[++i], 10); break;
      case '--skip-gemini': args.skipGemini = true; break;
      case '--scope': args.scope = argv[++i]; break;
      case '--base': args.base = argv[++i]; break;
      case '--exclude-paths': args.excludePaths = argv[++i]; break;
      case '--files': args.files = argv[++i]; break;
      case '--passes': args.passes = argv[++i]; break;
      case '--no-tools': args.noTools = true; break;
      case '--strict-lint': args.strictLint = true; break;
      case '--dry-run': args.dryRun = true; break;
    }
  }

  return args;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const rawArgs = process.argv.slice(2);
  const args = parseArgs(rawArgs);

  if (!args.mode || !args.planFile) {
    console.error('Usage: node scripts/audit-loop.mjs <code|plan> <plan-file> [options]');
    console.error('');
    console.error('Options:');
    console.error('  --max-rounds <n>        Max audit rounds (default: 4)');
    console.error('  --skip-gemini           Skip Step 7 (Gemini final review)');
    console.error('  --scope <diff|plan|full> Audit scope (default: diff)');
    console.error('  --base <ref>            Git base ref for diff (default: HEAD~1)');
    console.error('  --exclude-paths <globs> Comma-separated glob patterns to exclude');
    console.error('  --files <list>          Comma-separated explicit file list');
    console.error('  --passes <list>         Comma-separated pass names');
    console.error('  --no-tools              Skip static analysis pre-pass');
    console.error('  --strict-lint           Count tool findings in verdict');
    process.exit(1);
  }

  if (!fs.existsSync(args.planFile)) {
    console.error(`${R}Plan file not found:${X} ${args.planFile}`);
    process.exit(1);
  }

  // Step 0 — Pre-flight checks
  banner(`AUDIT LOOP — ${args.mode.toUpperCase()} — Pre-flight`);

  // Check deps
  try {
    execFileSync('node', ['scripts/check-deps.mjs'], { stdio: 'inherit', timeout: 30000 });
  } catch {
    console.error(`${R}Pre-flight checks failed${X}. Fix issues above and retry.`);
    process.exit(1);
  }

  // Ensure .audit/ directory exists for ledger persistence
  const auditDir = path.resolve('.audit');
  if (!fs.existsSync(auditDir)) {
    fs.mkdirSync(auditDir, { recursive: true });
  }

  const sid = `audit-${Date.now()}`;
  const outDir = path.resolve('.audit');
  const ledgerFile = path.resolve(outDir, 'session-ledger.json');

  banner(`AUDIT LOOP — ${args.mode.toUpperCase()} — Starting\n  Plan: ${args.planFile} | Max ${args.maxRounds} rounds | SID: ${sid}`);

  // Plan audit mode — simpler loop
  if (args.mode === 'plan') {
    const outFile = path.join(outDir, `${sid}-plan-result.json`);
    const auditArgs = ['--out', outFile];
    if (args.scope) auditArgs.push('--scope', args.scope);

    // Plan audits: run openai-audit.mjs plan (not code)
    const planArgs = ['scripts/openai-audit.mjs', 'plan', args.planFile, ...auditArgs];
    try {
      execFileSync('node', planArgs, { stdio: 'inherit', timeout: 300000 });
    } catch (err) {
      console.error(`${R}Plan audit failed${X}: ${err.message?.slice(0, 200)}`);
      process.exit(1);
    }

    console.log(`\n${G}Plan audit complete${X}. Results: ${outFile}`);
    // Skip Gemini for plan audits (it's designed for code transcripts)
    return;
  }

  // Code audit mode — full multi-round loop
  let round = 1;
  let changedFiles = [];
  let stableCount = 0;
  let priorHashes = new Set();
  const roundResults = [];

  while (round <= args.maxRounds) {
    const outFile = path.join(outDir, `${sid}-r${round}-result.json`);
    const stderrFile = path.join(outDir, `${sid}-r${round}-stderr.log`);

    // Build audit args
    const auditArgs = ['--out', outFile, '--round', String(round)];
    if (round >= 2) {
      auditArgs.push('--ledger', ledgerFile);

      // Generate diff
      const diffFile = path.join(outDir, `${sid}-diff.patch`);
      try {
        const diff = run('git', ['diff', 'HEAD~1'], { ignoreError: true });
        fs.writeFileSync(diffFile, diff || '');
        auditArgs.push('--diff', diffFile);
      } catch { /* no diff available */ }

      if (changedFiles.length > 0) {
        auditArgs.push('--changed', changedFiles.join(','));
      }
    }
    if (args.scope) auditArgs.push('--scope', args.scope);
    if (args.base) auditArgs.push('--base', args.base);
    if (args.excludePaths) auditArgs.push('--exclude-paths', args.excludePaths);
    if (args.files) auditArgs.push('--files', args.files);
    if (args.passes) auditArgs.push('--passes', args.passes);
    if (args.noTools) auditArgs.push('--no-tools');
    if (args.strictLint) auditArgs.push('--strict-lint');

    // Step 2 — Run audit
    banner(`ROUND ${round} — GPT-5.4 Audit`);
    const fullAuditArgs = ['scripts/openai-audit.mjs', 'code', args.planFile, ...auditArgs];
    process.stderr.write(`${D}$ node ${fullAuditArgs.join(' ')}${X}\n`);

    try {
      execFileSync('node', fullAuditArgs, { stdio: 'inherit', timeout: 600000 });
    } catch (err) {
      console.error(`${Y}Round ${round} audit exited with errors${X} — checking results...`);
    }

    const results = parseResults(outFile);
    if (!results) {
      console.error(`${R}No results from round ${round}${X}`);
      break;
    }

    const counts = countFindings(results);
    roundResults.push({ round, counts, file: outFile });

    // Show results card
    banner(`ROUND ${round} RESULTS — ${results.verdict || 'UNKNOWN'}\n  H:${counts.high} M:${counts.medium} L:${counts.low} | Total: ${counts.total}`);

    // Track finding stability via _hash
    const currentHashes = new Set((results.findings || []).map(f => f._hash).filter(Boolean));
    const newFindings = [...currentHashes].filter(h => !priorHashes.has(h));
    const resolved = [...priorHashes].filter(h => !currentHashes.has(h));

    if (round > 1) {
      console.log(`  New: ${newFindings.length} | Resolved: ${resolved.length} | Recurring: ${currentHashes.size - newFindings.length}`);
    }

    // Check convergence
    if (isConverged(counts)) {
      if (newFindings.length === 0 || round === 1) {
        stableCount++;
      } else {
        stableCount = 0; // New architectural findings reset stability
      }

      if (stableCount >= 1 || round >= args.maxRounds) {
        console.log(`\n${G}Converged${X} after ${round} round(s). H:${counts.high} M:${counts.medium}`);
        break;
      }
    }

    priorHashes = currentHashes;

    // Step 3 — Triage: show findings for human review
    console.log(`\nFindings requiring attention:`);
    for (const f of (results.findings || []).filter(f => f.severity === 'HIGH' || f.severity === 'MEDIUM')) {
      console.log(`  [${f.id}] ${f.severity} — ${f.category}: ${f.detail?.slice(0, 100)}`);
    }

    // In non-interactive mode, we can't do triage/fix — report and stop
    console.log(`\n${Y}Non-interactive mode${X}: Round ${round} complete.`);
    console.log(`Results written to: ${outFile}`);
    console.log(`Ledger: ${ledgerFile}`);

    if (round >= args.maxRounds) {
      console.log(`\n${Y}Max rounds (${args.maxRounds}) reached${X}`);
      break;
    }

    round++;
  }

  // Step 8 — Debt Review (automatic when thresholds crossed)
  try {
    const debtLedgerPath = path.resolve('.audit', 'tech-debt.json');
    if (fs.existsSync(debtLedgerPath)) {
      const { readDebtLedger } = await import('./scripts/lib/debt-ledger.mjs');
      const { findRecurringEntries, buildLocalClusters, findBudgetViolations } = await import('./scripts/lib/debt-review-helpers.mjs');

      const ledger = readDebtLedger({ ledgerPath: debtLedgerPath });
      const entries = ledger.entries || [];

      if (entries.length >= 5) {
        // Check thresholds: recurring items or file-level accumulation
        const recurring = findRecurringEntries(entries, 5);
        const clusters = buildLocalClusters(entries);
        const violations = findBudgetViolations(entries, ledger.budgets || {});

        const shouldReview = recurring.length >= 2 || clusters.length >= 2 || violations.length > 0;

        if (shouldReview) {
          banner(`STEP 8 — Debt Review\n  Entries: ${entries.length} | Recurring (5+): ${recurring.length} | Clusters: ${clusters.length} | Budget violations: ${violations.length}`);

          // Try LLM review, fall back to local
          const debtOutFile = path.join(outDir, `${sid}-debt-review.md`);
          try {
            execFileSync('node', ['scripts/debt-review.mjs', '--out', debtOutFile, '--write-plan-doc'], {
              stdio: 'inherit', timeout: 120000
            });
            console.log(`  Debt review: ${debtOutFile}`);
          } catch {
            // Fall back to local-only clustering
            try {
              execFileSync('node', ['scripts/debt-review.mjs', '--local-only', '--out', debtOutFile], {
                stdio: 'inherit', timeout: 30000
              });
              console.log(`  Debt review (local): ${debtOutFile}`);
            } catch (err2) {
              console.error(`  ${Y}Debt review failed${X}: ${err2.message?.slice(0, 100)}`);
            }
          }

          // Show top refactor candidates inline
          if (clusters.length > 0) {
            console.log(`\n  Top clusters:`);
            for (const c of clusters.slice(0, 3)) {
              console.log(`    [${c.kind}] ${c.title} — ${c.entries.length} entries`);
            }
          }
          if (recurring.length > 0) {
            console.log(`\n  Recurring items (appeared in 5+ audits):`);
            for (const r of recurring.slice(0, 5)) {
              console.log(`    ${r.topicId} — ${r.category?.slice(0, 60)} (${r.distinctRunCount ?? r.occurrences} runs)`);
            }
          }
        } else {
          process.stderr.write(`  [debt] ${entries.length} entries, no thresholds crossed — skipping review\n`);
        }
      }
    }
  } catch (err) {
    process.stderr.write(`  [debt-review] ${err.message?.slice(0, 100)} — non-blocking\n`);
  }

  // Step 7 — Gemini Final Review (MANDATORY unless skipped)
  if (!args.skipGemini) {
    const hasGemini = !!process.env.GEMINI_API_KEY;
    const hasClaude = !!process.env.ANTHROPIC_API_KEY;

    if (hasGemini || hasClaude) {
      banner('STEP 7 — Final Review (Gemini/Claude Opus)');

      // Build transcript from all rounds
      const transcriptFile = path.join(outDir, `${sid}-transcript.json`);
      const transcript = {
        rounds: roundResults.map(r => {
          try { return JSON.parse(fs.readFileSync(r.file, 'utf-8')); } catch { return null; }
        }).filter(Boolean),
      };
      fs.writeFileSync(transcriptFile, JSON.stringify(transcript, null, 2));

      const geminiOutFile = path.join(outDir, `${sid}-gemini-result.json`);
      const provider = hasGemini ? 'gemini' : 'anthropic';
      const geminiArgs = [
        'scripts/gemini-review.mjs', 'review',
        args.planFile, transcriptFile,
        '--out', geminiOutFile,
        '--provider', provider,
      ];

      try {
        execFileSync('node', geminiArgs, { stdio: 'inherit', timeout: 300000 });
        const geminiResult = parseResults(geminiOutFile);
        if (geminiResult) {
          banner(`FINAL REVIEW — ${geminiResult.verdict || 'UNKNOWN'}\n  Provider: ${provider}\n  New findings: ${(geminiResult.new_findings || []).length}\n  Wrongly dismissed: ${(geminiResult.wrongly_dismissed || []).length}`);
        }
      } catch (err) {
        console.error(`${Y}Final review failed${X}: ${err.message?.slice(0, 200)}`);
        console.error('This is non-blocking — audit results are still valid.');
      }
    } else {
      console.log(`\n${Y}Step 7 skipped${X}: no GEMINI_API_KEY or ANTHROPIC_API_KEY`);
    }
  }

  // Step 8.5 — Meta-assessment (every N runs)
  try {
    const { shouldRunAssessment } = await import('./scripts/meta-assess.mjs');
    const { shouldRun, runsSinceLastAssessment } = shouldRunAssessment();
    if (shouldRun) {
      banner('META-ASSESSMENT — Loop Performance Review');
      const assessOutFile = path.join(outDir, `${sid}-meta-assessment.md`);
      try {
        execFileSync('node', ['scripts/meta-assess.mjs', '--force', '--out', assessOutFile], {
          stdio: 'inherit', timeout: 120000
        });
        console.log(`  Assessment: ${assessOutFile}`);
      } catch (err) {
        console.error(`  ${Y}Meta-assessment failed${X}: ${err.message?.slice(0, 100)}`);
      }
    } else {
      process.stderr.write(`  [meta-assess] Not due (${runsSinceLastAssessment} runs since last)\n`);
    }
  } catch (err) {
    process.stderr.write(`  [meta-assess] ${err.message?.slice(0, 80)} — non-blocking\n`);
  }

  // Summary
  banner('AUDIT LOOP COMPLETE');
  console.log(`  Rounds: ${roundResults.length}`);
  for (const r of roundResults) {
    console.log(`  R${r.round}: H:${r.counts.high} M:${r.counts.medium} L:${r.counts.low} → ${r.file}`);
  }
  console.log(`  Ledger: ${ledgerFile}`);
  console.log(`  Artifacts: ${outDir}/${sid}-*`);
}

main().catch(err => {
  console.error(`${R}Audit loop failed${X}: ${err.message}`);
  process.exit(1);
});

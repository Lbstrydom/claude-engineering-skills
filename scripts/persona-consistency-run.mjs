#!/usr/bin/env node
/**
 * @fileoverview Phase 4 CLI runner — deterministic consistency-mode driver.
 *
 * Plan: docs/plans/persona-test-consistency-mode.md.
 *
 * The runner owns the Playwright session directly (NOT through MCP), executes
 * the canary's `journeySteps[]` deterministically, captures DOM + network
 * synchronously per step, diffs against the manifest, and verifies the
 * canary's `expectedContradictions` rule.
 *
 * Exit codes (mandatory ledger persistence before every exit except 4):
 *   0 — healthy (canary expectations met)
 *   2 — canary-broken (rig found fewer/more than expected; rig is suspect)
 *   3 — fatal-rig (manifest missing, canary schema invalid, Playwright disconnected)
 *   4 — ledger-persist-failed (disk full / permission; the ONLY exit that
 *       skips ledger persistence — distinct from "rig found a problem")
 *   5 — playwright-missing (npm package or browser binary not installed)
 *   6 — app-error (a journey action threw — APP regression, not rig issue)
 *
 * @module scripts/persona-consistency-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import 'dotenv/config';

import { resolveManifest }       from './lib/persona-test/manifest-resolver.mjs';
import { loadCanary, verifyExpectations, canaryExpectsShape, candidateFingerprint }
  from './lib/persona-test/canary.mjs';
import { openLedger }            from './lib/persona-test/ledger.mjs';
import { diffClaims }            from './lib/persona-test/consistency.mjs';
import { attachNetworkListener, captureWitness }
  from './lib/ux-lock/capture.mjs';
import {
  initLearningStore,
  isCloudEnabled,
  recordRegressionSpec,
  getRepoIdByUuid,
} from './learning-store.mjs';

// Exit codes — also used by tests to assert behaviour without spawning.
export const EXIT = Object.freeze({
  HEALTHY:            0,
  CANARY_BROKEN:      2,
  FATAL_RIG:          3,
  LEDGER_PERSIST:     4,
  PLAYWRIGHT_MISSING: 5,
  APP_ERROR:          6,
});

// ────────────────────────────────────────────────────────────────────────────
// Argument parsing (kept dead simple — no yargs / commander dep).
// ────────────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const args = { canary: null, url: null, out: null, repoRoot: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--canary')   args.canary = argv[++i];
    else if (a === '--url') args.url    = argv[++i];
    else if (a === '--out') args.out    = argv[++i];
    else if (a === '--repo-root') args.repoRoot = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function usage() {
  return [
    'persona-consistency-run — deterministic consistency-mode runner',
    '',
    'Usage:',
    '  node scripts/persona-consistency-run.mjs --canary <name> --url <url> [--out <path>]',
    '',
    'Flags:',
    '  --canary <name>   Canary file (looked up at .persona-test/canaries/<name>.json)',
    '  --url <url>       Base URL to drive against',
    '  --out <path>      Override the session ledger path (default .persona-test/sessions/<SID>.json)',
    '  --repo-root <dir> Override repoRoot (defaults to process.cwd())',
  ].join('\n');
}

// ────────────────────────────────────────────────────────────────────────────
// Runner — exported for testing; main() at the bottom wires process.exit.
// ────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} RunResult
 * @property {number} exitCode
 * @property {string} ledgerPath
 * @property {object} ledger
 */

/**
 * @param {ReturnType<typeof parseArgs>} args
 * @param {{
 *   playwrightFactory?: () => Promise<object>,  // injection for tests; defaults to () => import('playwright')
 *   onWarning?: (s: string) => void,
 * }} [deps]
 * @returns {Promise<RunResult>}
 */
export async function runConsistency(args, deps = {}) {
  if (args.help) {
    process.stdout.write(usage() + '\n');
    return { exitCode: 0, ledgerPath: '', ledger: null };
  }
  if (!args.canary || !args.url) {
    process.stderr.write('Missing --canary or --url\n\n' + usage() + '\n');
    return { exitCode: EXIT.FATAL_RIG, ledgerPath: '', ledger: null };
  }

  const repoRoot  = args.repoRoot;
  const sessionId = `persona-consistency-${Date.now()}`;

  // ── 1. Open ledger first (write-once probe → exit 4 on failure) ──────────
  let ledger;
  try {
    ledger = openLedger(repoRoot, sessionId, {
      canaryName: args.canary,
      journeyKey: args.canary,
    });
  } catch (err) {
    process.stderr.write(`LEDGER_PERSIST_FAILED: ${err.message}\n`);
    return { exitCode: EXIT.LEDGER_PERSIST, ledgerPath: '', ledger: null };
  }

  // From here on, every exit path MUST close the ledger first.
  try {
    // ── 2. Probe Playwright (→ exit 5) ────────────────────────────────────
    let playwright;
    try {
      const factory = deps.playwrightFactory || (() => import('playwright'));
      playwright = await factory();
    } catch (err) {
      ledger.setVerdicts({
        rigVerdict: 'fatal',
        canaryVerdict: 'not-applicable',
        failureReason: 'playwright-missing',
        truncated: false,
      });
      ledger.close();
      process.stderr.write(
        `playwright-missing: ${err.message}\nFix: npm install playwright && npx playwright install chromium\n`,
      );
      return { exitCode: EXIT.PLAYWRIGHT_MISSING, ledgerPath: ledger.ledgerPath, ledger: ledger.state };
    }

    // ── 3. Resolve manifest (→ exit 3 on miss) ────────────────────────────
    let manifestResult;
    try {
      manifestResult = resolveManifest(repoRoot);
    } catch (err) {
      ledger.setVerdicts({
        rigVerdict: 'fatal', canaryVerdict: 'not-applicable',
        failureReason: `manifest-invalid: ${err.message}`, truncated: false,
      });
      ledger.close();
      process.stderr.write(`fatal-rig: ${err.message}\n`);
      return { exitCode: EXIT.FATAL_RIG, ledgerPath: ledger.ledgerPath, ledger: ledger.state };
    }
    if (!manifestResult) {
      ledger.setVerdicts({
        rigVerdict: 'fatal', canaryVerdict: 'not-applicable',
        failureReason: 'manifest-missing', truncated: false,
      });
      ledger.close();
      process.stderr.write(
        'fatal-rig: no surfaces.json resolved. Bootstrap: docs/consistency-contract.md\n',
      );
      return { exitCode: EXIT.FATAL_RIG, ledgerPath: ledger.ledgerPath, ledger: ledger.state };
    }

    // ── 4. Load canary ────────────────────────────────────────────────────
    let canary;
    try {
      canary = loadCanary(args.canary, repoRoot);
    } catch (err) {
      ledger.setVerdicts({
        rigVerdict: 'fatal', canaryVerdict: 'not-applicable',
        failureReason: err.failureReason || 'canary-load-failed',
        truncated: false,
      });
      ledger.close();
      process.stderr.write(`fatal-rig: ${err.message}\n`);
      return { exitCode: EXIT.FATAL_RIG, ledgerPath: ledger.ledgerPath, ledger: ledger.state };
    }
    ledger.state.fixtureSeed = canary.fixtureSeed || null;

    // ── 5. Resolve repo identity for candidate emission (soft) ────────────
    await initLearningStore();
    const cloudOn = isCloudEnabled();
    let repoId = null;
    let resolveErr = null;
    if (cloudOn) {
      try {
        const uuid = readLocalRepoUuid(repoRoot);
        if (uuid) repoId = await getRepoIdByUuid(uuid);
        else resolveErr = 'no .audit-loop/repo-identity.json present';
      } catch (err) {
        resolveErr = err.message || String(err);
      }
    } else {
      resolveErr = 'cloud store disabled (SUPABASE_AUDIT_* env vars unset)';
    }
    const candidateEnabled = cloudOn && !!repoId;
    // Resolves R1-M10 — make silent disablement audible. Without this the
    // runner appears to work fine but never emits candidates, which
    // misleads operators into thinking the rig is healthy when it's
    // running with degraded observability.
    if (!candidateEnabled) {
      process.stderr.write(
        `⚠ candidate emission DISABLED: ${resolveErr || 'unknown reason'}\n` +
        '  Contradictions will surface in the session ledger but no regression_specs candidates will be written.\n' +
        '  Fix: ensure SUPABASE_AUDIT_URL+ANON_KEY are set, then run\n' +
        '  `node scripts/cross-skill.mjs resolve-repo-identity --persist`\n',
      );
    }

    // ── 6. Launch browser + apply auth bootstrap ──────────────────────────
    const browser = await playwright.chromium.launch();
    const context = await newAuthedContext(browser, canary.authBootstrap);
    const page    = await context.newPage();
    const listener = attachNetworkListener(page, manifestResult.manifest);

    // ── 7. Execute journey steps deterministically ────────────────────────
    const allContradictions = [];
    const commitSha = safeGitSha(repoRoot);
    const ctx = { repoId, journeyKey: canary.name, commitSha };

    for (let i = 0; i < canary.journeySteps.length; i++) {
      const step = canary.journeySteps[i];
      const stepStart = Date.now();
      const warnings = [];

      try {
        await executeStep(page, step, canary.routes, args.url);
      } catch (err) {
        // Act-step error → exit 6 (APP regression, NOT rig issue).
        ledger.appendStep({
          stepIndex: i,
          plan: step.label || `step ${i}`,
          actionLabel: describeAction(step),
          witness: emptyWitness(i),
          contradictions: [],
          freshness: [],
          warnings,
          durationMs: Date.now() - stepStart,
        });
        ledger.setVerdicts({
          rigVerdict: 'app-error',
          canaryVerdict: 'not-applicable',
          failureReason: null,
          stepFailureReason: `${err.constructor.name}: ${err.message}`,
          truncated: true,
        });
        listener.removeListener();
        ledger.close();
        await safeBrowserClose(browser);
        process.stderr.write(`app-error: step ${i} (${step.label || '?'}) threw — ${err.message}\n`);
        return { exitCode: EXIT.APP_ERROR, ledgerPath: ledger.ledgerPath, ledger: ledger.state };
      }

      // Capture witness (sync wrt page).
      const witness = await captureWitness(page, manifestResult.manifest, listener, {
        stepIndex: i,
        warn: (w) => warnings.push(w),
      });

      // Diff. Semantic compare is off by default in the runner — wire when
      // Phase 4.1 (canary --enable-semantic) lands.
      const contradictions = await diffClaims(witness, manifestResult.manifest, {
        context: {
          currentRoute: safeCurrentRoute(page),
          currentStepLabel: step.label,
        },
      });

      // Candidate emission — for unexpected P0/P1 contradictions with a
      // resolved surfaceId. Suppress canary-expected shapes (Gemini-R3-G1).
      if (candidateEnabled) {
        for (const c of contradictions) {
          if (!candidateWorthy(c, canary)) continue;
          const fingerprint = candidateFingerprint({
            repoId, journeyKey: canary.name, contradiction: c,
          });
          const specId = await recordRegressionSpec(repoId, {
            sourceKind: 'persona-consistency-candidate',
            description: candidateDescription(c),
            commitSha,
            candidateFingerprint: fingerprint,
            witnessSnapshot: shrinkWitness(witness, c),
            contradictionPayload: c,
            journeyContext: {
              journeySteps: canary.journeySteps.slice(0, i + 1),
              // Resolves R3-H4: explicit replay boundary in the payload
              // contract. Consumers (renderCandidateSpec) validate that
              // journeySteps.length === contradictionStepIndex + 1 so the
              // producer/consumer agreement is enforced at promotion time,
              // not implicit in the slice call here.
              contradictionStepIndex: i,
              routes: canary.routes,
              authBootstrap: canary.authBootstrap,
              candidateFingerprint: fingerprint,
            },
          });
          if (specId) ledger.recordCandidate(specId);
        }
      }

      allContradictions.push(...contradictions);
      ledger.appendStep({
        stepIndex: i,
        plan: step.label || `step ${i}`,
        actionLabel: describeAction(step),
        witness,
        contradictions,
        freshness: contradictions
          .filter((c) => c.kind === 'stale-projection' || c.kind === 'absent-not-rendered')
          .map((c) => ({
            surfaceId: c.surfaceId || '',
            engineField: c.engineField || '',
            freshness: c.freshness === 'current' ? 'absent' : (c.freshness || 'absent'),
            severity: c.severity,
            detail: c.detail,
          })),
        warnings,
        durationMs: Date.now() - stepStart,
      });
    }

    // ── 8. Verify expectations ────────────────────────────────────────────
    const verdict = verifyExpectations(canary, allContradictions);
    ledger.setVerdicts(
      verdict.passed
        ? { rigVerdict: 'healthy', canaryVerdict: 'passed',
            failureReason: null, stepFailureReason: null, truncated: false }
        : { rigVerdict: 'broken',  canaryVerdict: 'broken',
            failureReason: verdict.reason, stepFailureReason: null, truncated: false },
    );

    listener.removeListener();
    ledger.close();
    await safeBrowserClose(browser);

    return {
      exitCode: verdict.passed ? EXIT.HEALTHY : EXIT.CANARY_BROKEN,
      ledgerPath: ledger.ledgerPath,
      ledger: ledger.state,
    };
  } catch (err) {
    // Catch-all → exit 3.
    try {
      ledger.setVerdicts({
        rigVerdict: 'fatal', canaryVerdict: 'not-applicable',
        failureReason: `fatal-rig: ${err.message}`, truncated: true,
      });
      ledger.close();
    } catch { /* if ledger close fails here, we've already failed exit 4 above */ }
    process.stderr.write(`fatal-rig: ${err.message}\n`);
    return { exitCode: EXIT.FATAL_RIG, ledgerPath: ledger.ledgerPath, ledger: ledger.state };
  }
}

// ── Step execution ────────────────────────────────────────────────────────

async function executeStep(page, step, routes, baseUrl) {
  switch (step.action) {
    case 'navigate': {
      const target = step.url || joinUrl(baseUrl, routes?.[step.routeKey] || '');
      await page.goto(target, { waitUntil: step.waitUntil || 'load' });
      return;
    }
    case 'click': {
      await locatorOf(page, step.locator).click();
      if (step.postWait) await applyWait(page, step.postWait);
      else await page.waitForTimeout(250);   // default 250ms tick (NOT networkidle, per Gemini-R3-G2)
      return;
    }
    case 'fill': {
      const loc = locatorOf(page, step.locator);
      await loc.fill(step.value);
      if (step.blurAfter !== false) {
        try { await loc.blur(); } catch { /* not all locators support .blur() */ }
      }
      return;
    }
    case 'wait':     return applyWait(page, step.condition);
    case 'evaluate':
      // v1 §11b — `evaluate` is a known limitation; emit a no-op so the
      // runner doesn't crash, the runner will continue and the step's
      // declared scriptId will appear in the ledger for traceability.
      return;
    default:
      throw new Error(`unknown journey action "${step.action}"`);
  }
}

function locatorOf(page, locator) {
  switch (locator.kind) {
    case 'role':   return locator.name
      ? page.getByRole(locator.role, { name: locator.name })
      : page.getByRole(locator.role);
    case 'label':  return page.getByLabel(locator.text);
    case 'testid': return page.getByTestId(locator.id);
    case 'css':    return page.locator(locator.selector);
    default:       throw new Error(`unknown locator kind "${locator.kind}"`);
  }
}

async function applyWait(page, cond) {
  switch (cond.kind) {
    case 'visible': return locatorOf(page, cond.locator).waitFor({ state: 'visible', timeout: cond.timeoutMs });
    case 'hidden':  return locatorOf(page, cond.locator).waitFor({ state: 'hidden',  timeout: cond.timeoutMs });
    case 'url':     return page.waitForURL(new RegExp(cond.urlPattern), { timeout: cond.timeoutMs });
    case 'network':
      return page.waitForResponse(
        (r) => new RegExp(cond.urlPattern).test(r.url()) && (!cond.method || r.request().method() === cond.method),
        { timeout: cond.timeoutMs },
      );
    case 'timeout': return page.waitForTimeout(cond.ms);
    default: throw new Error(`unknown wait kind "${cond.kind}"`);
  }
}

function describeAction(step) {
  switch (step.action) {
    case 'navigate': return step.url ? `navigate ${step.url}` : `navigate (routeKey=${step.routeKey})`;
    case 'click':    return `click ${locatorString(step.locator)}`;
    case 'fill':     return `fill ${locatorString(step.locator)}=${JSON.stringify(step.value)}`;
    case 'wait':     return `wait ${step.condition.kind}`;
    case 'evaluate': return `evaluate ${step.scriptId}`;
    default:         return `unknown ${step.action}`;
  }
}

function locatorString(locator) {
  if (!locator) return '?';
  switch (locator.kind) {
    case 'role':   return `role=${locator.role}${locator.name ? `[name="${locator.name}"]` : ''}`;
    case 'label':  return `label="${locator.text}"`;
    case 'testid': return `data-testid="${locator.id}"`;
    case 'css':    return locator.selector;
    default:       return '?';
  }
}

// ── Browser context with auth bootstrap ───────────────────────────────────

async function newAuthedContext(browser, auth) {
  if (!auth || auth.kind === 'none') return browser.newContext();
  if (auth.kind === 'storageState') {
    return browser.newContext({ storageState: auth.storageStatePath });
  }
  if (auth.kind === 'token') {
    const token = process.env[auth.tokenEnv];
    if (!token) throw new Error(`auth-bootstrap: env var "${auth.tokenEnv}" is not set`);
    const ctx = await browser.newContext();
    await ctx.setExtraHTTPHeaders({ Authorization: `Bearer ${token}` });
    return ctx;
  }
  throw new Error(`unknown authBootstrap.kind "${auth.kind}"`);
}

// ── Candidate emission helpers ────────────────────────────────────────────

function candidateWorthy(c, canary) {
  if (!c.surfaceId) return false;                           // negative-space without surfaceId — no candidate
  if (c.severity !== 'P0' && c.severity !== 'P1') return false;
  if (canaryExpectsShape(canary, c)) return false;          // canary-expected — suppress (Gemini-R3-G1)
  return true;
}

function candidateDescription(c) {
  return `${c.kind} on ${c.surfaceId}.${c.engineField || '(n/a)'} (${c.severity})`;
}

// Shrink the witness payload to just the relevant slice for this candidate.
// Saves bytes in the JSONB column and keeps the candidate row narrowly
// scoped to the contradiction it represents.
function shrinkWitness(witness, c) {
  const matches = (item) =>
    item.surfaceId === c.surfaceId &&
    (c.engineField ? item.engineField === c.engineField : true) &&
    (c.scope ?? null) === (item.scope ?? null) &&
    (c.key ?? null)   === (item.key   ?? null);
  return {
    stepIndex: witness.stepIndex,
    domClaims: witness.domClaims.filter(matches),
    networkClaims: witness.networkClaims.filter(matches),
    undeclaredDomClaims: [],
    partialCapture: witness.partialCapture,
    customClaims: {},
  };
}

// ── Misc helpers ──────────────────────────────────────────────────────────

function emptyWitness(stepIndex) {
  return {
    stepIndex,
    domClaims: [],
    networkClaims: [],
    undeclaredDomClaims: [],
    partialCapture: true,
    customClaims: {},
  };
}

function joinUrl(base, suffix) {
  if (!suffix) return base;
  if (/^https?:/.test(suffix)) return suffix;
  const trimmedBase = base.replace(/\/+$/, '');
  const trimmedSuf  = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return trimmedBase + trimmedSuf;
}

function safeCurrentRoute(page) {
  try { return new URL(page.url()).pathname; } catch { return null; }
}

function safeGitSha(repoRoot) {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch { return null; }
}

async function safeBrowserClose(browser) {
  try { await browser.close(); } catch { /* swallow */ }
}

function readLocalRepoUuid(repoRoot) {
  // Mirrors the convention in scripts/cross-skill.mjs — repo identity persists
  // to .audit-loop/repo-identity.json. If absent, candidate emission is off.
  try {
    const p = path.join(repoRoot, '.audit-loop', 'repo-identity.json');
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return raw?.uuid || null;
  } catch { return null; }
}

// ────────────────────────────────────────────────────────────────────────────
// Main entry (skipped when imported as a module).
// ────────────────────────────────────────────────────────────────────────────

const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
  } catch { return false; }
})();

if (isMain) {
  const result = await runConsistency(parseArgs(process.argv.slice(2)));
  process.exit(result.exitCode);
}

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
import { diffClaims, manifestQualityWarnings, appliesToCurrent } from './lib/persona-test/consistency.mjs';
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
  const args = {
    canary: null, url: null, out: null, repoRoot: process.cwd(),
    awaitMs: null,   // wine-cellar round-3 #1 — CLI override for the
                     // auto-await-before-capture window. Applies to ALL
                     // network sources this run. Takes precedence over
                     // per-source `awaitTimeoutMs` in the manifest.
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--canary')   args.canary = argv[++i];
    else if (a === '--url') args.url    = argv[++i];
    else if (a === '--out') args.out    = argv[++i];
    else if (a === '--repo-root') args.repoRoot = argv[++i];
    else if (a === '--await-ms') {
      const n = parseInt(argv[++i], 10);
      if (Number.isFinite(n) && n > 0) args.awaitMs = n;
    }
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function usage() {
  return [
    'persona-consistency-run — deterministic consistency-mode runner',
    '',
    'Usage:',
    '  node scripts/persona-consistency-run.mjs --canary <name> --url <url> [--out <path>] [--await-ms <N>]',
    '',
    'Flags:',
    '  --canary <name>   Canary file (looked up at .persona-test/canaries/<name>.json)',
    '  --url <url>       Base URL to drive against',
    '  --out <path>      Override the session ledger path (default .persona-test/sessions/<SID>.json)',
    '  --repo-root <dir> Override repoRoot (defaults to process.cwd())',
    '  --await-ms <N>    Override the auto-await-before-capture window in ms (default 3000;',
    '                    per-source `awaitTimeoutMs` in surfaces.json also overrides it).',
    '                    Use when SPA boot chains exceed the default — e.g. auth+context+fetch',
    '                    chains where /api/whatever doesn\'t fire until 2-4s after navigation.',
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
    ledger.state.authKind = canary.authBootstrap?.kind || 'none';

    // ── 5. Resolve repo identity for candidate emission (soft) ────────────
    await initLearningStore();
    const cloudOn = await isCloudEnabled();
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
    }
    const candidateEnabled = cloudOn && !!repoId;
    // Resolves R1-M10 + wine-cellar adoption #8: surface disablement
    // audibly, but with different messages depending on what's missing.
    // Cloud-off is "linkage off" (informational); cloud-on-but-no-repo-id
    // is "DISABLED" (actionable). Don't conflate the two — operators
    // who haven't configured Supabase shouldn't see a "fix this" warning;
    // operators who configured Supabase but didn't run identity-resolve
    // should.
    if (!cloudOn) {
      process.stderr.write(
        'ℹ audit-loop linkage off (cloud off) — contradictions ' +
        'will be logged to the session ledger only; no regression_specs ' +
        'candidates written. This is fine for first-run adoption.\n',
      );
    } else if (!candidateEnabled) {
      process.stderr.write(
        `⚠ candidate emission DISABLED: ${resolveErr || 'unknown reason'}\n` +
        '  Cloud is configured but no repo identity is registered. To enable\n' +
        '  candidate persistence, run from this repo root:\n' +
        '    node scripts/cross-skill.mjs resolve-repo-identity --persist\n' +
        '  Contradictions will still appear in the session ledger.\n',
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

    // Manifest-quality warnings (CSS-locator nudges, etc.) — surface ONCE
    // at the start of the run so they appear in the first step's warnings
    // and aren't repeated per-step. Resolves wine-cellar adoption #2/#3.
    const startupWarnings = manifestQualityWarnings(manifestResult.manifest);

    for (let i = 0; i < canary.journeySteps.length; i++) {
      const step = canary.journeySteps[i];
      const stepStart = Date.now();
      const warnings = [];

      let stepMeta;
      try {
        stepMeta = await executeStep(page, step, canary.routes, args.url);
      } catch (err) {
        // Act-step error → exit 6 (APP regression, NOT rig issue).
        ledger.appendStep({
          stepIndex: i,
          plan: step.label || `step ${i}`,
          actionLabel: describeAction(step),
          resolvedTarget: stepMeta?.resolvedTarget ?? null,
          navResponseStatus: stepMeta?.navResponseStatus ?? null,
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

      // Resolves wine-cellar round-2 #1: surface non-2xx navigation as a
      // warning. Playwright's waitUntil resolves on error bodies, so the
      // rig has no other way to flag "URL is wrong".
      if (stepMeta?.navResponseStatus != null
          && (stepMeta.navResponseStatus < 200 || stepMeta.navResponseStatus >= 300)) {
        warnings.push({
          kind: 'navigated-to-non-2xx',
          surfaceId: null,
          detail: `Step ${i} navigated to ${stepMeta.resolvedTarget} but got HTTP ${stepMeta.navResponseStatus}; subsequent surface findings are likely caused by being on the wrong page`,
        });
      }

      // Resolves wine-cellar round-2 #2 + round-3 #1: auto-await
      // manifest-declared networkSource URL patterns before capture.
      // Async-rendered surfaces populate their data-engine-* attributes
      // only after the relevant API response lands; capturing before that
      // just emits unresolved-ground-truth for every async surface.
      // Per-pattern timeout resolution: --await-ms CLI > surfaces.json
      // per-source awaitTimeoutMs > DEFAULT_AWAIT_MS (3000ms).
      await awaitManifestNetworkSources(page, manifestResult.manifest, listener, {
        cliOverrideMs: args.awaitMs,
        warn: (w) => warnings.push(w),
      });

      // Capture witness (sync wrt page).
      const witness = await captureWitness(page, manifestResult.manifest, listener, {
        stepIndex: i,
        warn: (w) => warnings.push(w),
      });

      // Resolves wine-cellar round-2 #3: distinguish "locator matched
      // but element has no data-engine-claim" from "locator matched
      // nothing at all". Both previously rolled into missing-surface;
      // the former is "you haven't annotated yet" (common during staged
      // rollout) and the latter is "the route/state is wrong".
      // Derive activeStateTags from any chip-style domClaim that projects
      // a state-shaped enum field (closes wine-cellar issue #40 partial
      // gating — without this, `appliesTo.requiresState` is dead code).
      // The chip + any explicit state-projecting surface (e.g. stateV2,
      // mode, status fields) contributes its captured value as a tag.
      const STATE_FIELDS = new Set(['stateV2', 'state', 'mode', 'status']);
      const activeStateTags = (witness?.domClaims || [])
        .filter((c) => STATE_FIELDS.has(c.engineField) && c.visible && c.domValueRaw)
        .map((c) => c.domValueRaw);

      const stepContext = {
        currentRoute: safeCurrentRoute(page),
        currentStepLabel: step.label,
        activeStateTags,
      };

      const unannotatedFindings = await detectUnannotatedSurfaces(
        page,
        manifestResult.manifest,
        witness,
        stepContext,
      );

      // Diff. Semantic compare is off by default in the runner — wire when
      // Phase 4.1 (canary --enable-semantic) lands.
      const rawContradictions = await diffClaims(witness, manifestResult.manifest, {
        context: stepContext,
      });
      // Strip missing-surface findings for surfaces that detectUnannotatedSurfaces
      // already classified as `unannotated-surface` — same root surface,
      // more actionable kind wins.
      const unannotatedSurfaceIds = new Set(unannotatedFindings.map((f) => f.surfaceId));
      const contradictions = [
        ...rawContradictions.filter(
          (c) => !(c.kind === 'missing-surface' && unannotatedSurfaceIds.has(c.surfaceId)),
        ),
        ...unannotatedFindings,
      ];

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
      // First step also carries the startup warnings (manifest-quality
      // nudges) so the operator sees them once. Later steps only carry
      // their own capture/diff warnings.
      const stepWarnings = i === 0 ? [...startupWarnings, ...warnings] : warnings;
      // step.freshness[] used to mirror contradictions filtered by
      // freshness kinds (wine-cellar round-4 #3 — duplication). Same
      // rows appeared in both arrays, doubling triage cost. As of
      // round-4, freshness[] is left empty: stale-projection +
      // absent-not-rendered findings live in contradictions[] under
      // their kind, and the schema field is retained only for
      // backwards-compat with previously-written ledgers.
      ledger.appendStep({
        stepIndex: i,
        plan: step.label || `step ${i}`,
        actionLabel: describeAction(step),
        resolvedTarget: stepMeta?.resolvedTarget ?? null,
        navResponseStatus: stepMeta?.navResponseStatus ?? null,
        witness,
        contradictions,
        freshness: [],
        warnings: stepWarnings,
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

/**
 * @returns {Promise<{ resolvedTarget: string|null, navResponseStatus: number|null }>}
 */
async function executeStep(page, step, routes, baseUrl) {
  switch (step.action) {
    case 'navigate': {
      const target = step.url || joinUrl(baseUrl, routes?.[step.routeKey] || '');
      // Resolves wine-cellar adoption round-2 #1 + #7: capture the navigation
      // response so we can surface non-2xx outcomes (Playwright's waitUntil
      // resolves on the error body, hiding 404s/5xx) and so the ledger
      // records the resolved URL (not just the routeKey intent).
      const response = await page.goto(target, { waitUntil: step.waitUntil || 'load' });
      return {
        resolvedTarget: target,
        navResponseStatus: response ? response.status() : null,
      };
    }
    case 'click': {
      await locatorOf(page, step.locator).click();
      if (step.postWait) await applyWait(page, step.postWait);
      else await page.waitForTimeout(250);   // default 250ms tick (NOT networkidle, per Gemini-R3-G2)
      return { resolvedTarget: safeCurrentRoute(page), navResponseStatus: null };
    }
    case 'fill': {
      const loc = locatorOf(page, step.locator);
      await loc.fill(step.value);
      if (step.blurAfter !== false) {
        try { await loc.blur(); } catch { /* not all locators support .blur() */ }
      }
      return { resolvedTarget: safeCurrentRoute(page), navResponseStatus: null };
    }
    case 'wait':
      await applyWait(page, step.condition);
      return { resolvedTarget: safeCurrentRoute(page), navResponseStatus: null };
    case 'evaluate':
      // v1 §11b — `evaluate` is a known limitation; emit a no-op so the
      // runner doesn't crash, the runner will continue and the step's
      // declared scriptId will appear in the ledger for traceability.
      return { resolvedTarget: safeCurrentRoute(page), navResponseStatus: null };
    default:
      throw new Error(`unknown journey action "${step.action}"`);
  }
}

// ── Auto-wait for manifest-declared network sources (round-2 #2) ───────────

/**
 * Briefly await any manifest networkSource.urlPattern that the cumulative
 * store hasn't yet seen in this run. Async-rendered surfaces populate
 * their attributes only after the API response lands; without this wait
 * the rig captures during the loading shell and emits
 * unresolved-ground-truth for every async surface (the wine-cellar round
 * 2 finding).
 *
 * Total wait capped at opts.timeoutMs across all patterns (parallel via
 * Promise.race against a single timeout). Misses emit
 * `manifest-network-await-timeout` so the operator knows which pattern
 * wasn't satisfied.
 *
 * @param {object} page
 * @param {import('./lib/persona-test/schemas.mjs').SurfaceManifest} manifest
 * @param {{ store: object }} listener
 * @param {{ timeoutMs?: number, warn?: (w: object) => void }} opts
 */
// Resolves wine-cellar round-3 #1 — default bumped from 1500ms to 3000ms
// based on real-world SPA boot chains. Auth → context → mount → fetch
// chains routinely take 1.5-2.5s on prod; the old default consistently
// fired manifest-network-await-timeout for any auth-gated surface.
// 3000ms covers the 95th percentile; adopters with slower chains
// declare `awaitTimeoutMs` per source in surfaces.json (caps at 30s).
const DEFAULT_AWAIT_MS = 3000;

async function awaitManifestNetworkSources(page, manifest, listener, opts = {}) {
  const cliOverride = Number.isInteger(opts.cliOverrideMs) && opts.cliOverrideMs > 0
    ? opts.cliOverrideMs : null;

  // Build pattern → resolved-timeout map. Precedence (highest wins):
  // 1. --await-ms CLI flag (applies to ALL patterns this run)
  // 2. surfaces.json engineFields[*].networkSource.awaitTimeoutMs (per-source)
  // 3. DEFAULT_AWAIT_MS
  const patternTimeouts = new Map();
  for (const surface of (manifest?.surfaces || [])) {
    for (const f of (surface.engineFields || [])) {
      const urlPat = f?.networkSource?.urlPattern;
      if (!urlPat) continue;
      const sourceOverride = f.networkSource.awaitTimeoutMs;
      const resolved = cliOverride
        || (Number.isInteger(sourceOverride) && sourceOverride > 0 ? sourceOverride : null)
        || DEFAULT_AWAIT_MS;
      // If the same pattern appears on multiple surfaces with different
      // overrides, the more generous wins (we'd rather over-wait than miss).
      const existing = patternTimeouts.get(urlPat);
      if (!existing || resolved > existing) patternTimeouts.set(urlPat, resolved);
    }
  }
  if (patternTimeouts.size === 0) return;

  // Filter to patterns NOT yet seen via the listener's store this run.
  const seenKeys = listener.store.keys();
  const unseen = [...patternTimeouts.entries()].filter(([urlPat]) => {
    const patternStr = String(urlPat);
    return !seenKeys.some((k) => {
      const surfaceId = k.split('::')[0];
      const surface = manifest.surfaces.find((s) => s.id === surfaceId);
      if (!surface) return false;
      return surface.engineFields.some((f) => f.networkSource?.urlPattern === patternStr);
    });
  });
  if (unseen.length === 0) return;

  // Wait in parallel — each pattern uses its own resolved timeout.
  const waiters = unseen.map(([urlPat, timeoutMs]) => {
    try {
      const re = new RegExp(urlPat);
      return page.waitForResponse(
        (r) => re.test(r.url()) && r.status() >= 200 && r.status() < 300,
        { timeout: timeoutMs },
      )
        .then(() => ({ ok: true, pattern: urlPat, timeoutMs }))
        .catch(() => ({ ok: false, pattern: urlPat, timeoutMs }));
    } catch {
      return Promise.resolve({ ok: false, pattern: urlPat, timeoutMs });
    }
  });
  const results = await Promise.all(waiters);
  for (const r of results) {
    if (!r.ok && typeof opts.warn === 'function') {
      // Resolves wine-cellar round-3 #2 — the warning previously claimed
      // "downstream unresolved-ground-truth expected" unconditionally,
      // but unannotated surfaces short-circuit to `unannotated-surface`
      // before the ground-truth diff. Reworded to be accurate.
      opts.warn({
        kind: 'manifest-network-await-timeout',
        surfaceId: null,
        detail:
          `Waited ${r.timeoutMs}ms for response matching ${r.pattern} but none arrived. ` +
          'Capture proceeds. For surfaces that ARE annotated, expect ' +
          '`unresolved-ground-truth` findings next. For UNannotated surfaces, expect ' +
          '`unannotated-surface` instead (the unannotated check short-circuits ' +
          'before the ground-truth diff runs). ' +
          'Bump per-source via `awaitTimeoutMs` in surfaces.json, ' +
          'or globally via `--await-ms <N>`',
      });
    }
  }
}

// ── Unannotated-surface detection (round-2 #3) ────────────────────────────

/**
 * For each manifest surface NOT represented in witness.domClaims (i.e. no
 * annotated element was captured for it), probe the live DOM via the
 * surface's declared locator. If the locator matches an element, the
 * surface IS present but unannotated — emit `unannotated-surface`. If
 * the locator matches nothing, leave the diff engine's `missing-surface`
 * to fire normally.
 *
 * Resolves wine-cellar round-2 #3 — semantic distinction between "didn't
 * annotate yet" (common during staged rollout) and "surface really
 * absent from DOM in this context".
 *
 * @param {object} page
 * @param {import('./lib/persona-test/schemas.mjs').SurfaceManifest} manifest
 * @param {import('./lib/persona-test/schemas.mjs').WitnessRecord} witness
 * @param {{ currentRoute?: string, currentStepLabel?: string, activeStateTags?: string[] }} ctx
 * @returns {Promise<import('./lib/persona-test/schemas.mjs').Contradiction[]>}
 */
async function detectUnannotatedSurfaces(page, manifest, witness, ctx = {}) {
  const out = [];
  const seenSurfaceIds = new Set((witness?.domClaims || []).map((c) => c.surfaceId));
  for (const surface of (manifest?.surfaces || [])) {
    if (seenSurfaceIds.has(surface.id)) continue;   // annotated — diff handled it
    // Gate by appliesTo — mirror the missing-surface path (line ~378 of
    // consistency.mjs). Closes the partial-gating gap from wine-cellar
    // issue #40: previously this scan iterated ALL surfaces, so an
    // analysis-view surface declaring `routePattern: 'view=analysis'`
    // would still false-positive `unannotated-surface` on the grid view.
    if (!appliesToCurrent(surface.appliesTo, ctx)) continue;
    // Quick locator probe — uses Playwright's locator API in the runner
    // (not the browser context) so we get the same kind-resolution rules
    // as the runner's executeStep.
    let count = 0;
    try {
      count = await locatorOf(page, surface.locator).count();
    } catch { count = 0; }
    if (count > 0) {
      out.push({
        kind: 'unannotated-surface',
        severity: 'P2',
        surfaceId: surface.id,
        engineField: null,
        scope: null,
        key: null,
        domValue: null,
        engineValue: null,
        freshness: null,
        selector: locatorToStringLite(surface.locator),
        detail: `Surface "${surface.id}" — locator matched ${count} element(s) in the live DOM but no data-engine-claim attribute. Three root causes (in likelihood order): (a) annotation not added yet — write data-engine-claim/-value/-freshness on the element; (b) annotation added in a branch not yet deployed to the URL the canary points at; (c) typo in the attribute name (must be exactly "data-engine-claim", not "data-engine-clams" / "data-claim-engine" / etc — case-sensitive, hyphenated)`,
        suppressedByLockedSpec: null,
      });
    }
    // If count === 0, leave to diffClaims' missing-surface scan (it
    // already gates by appliesTo so we don't duplicate that logic).
  }
  return out;
}

function locatorToStringLite(locator) {
  if (!locator) return null;
  switch (locator.kind) {
    case 'role':   return `role=${locator.role}${locator.name ? `[name="${locator.name}"]` : ''}`;
    case 'label':  return `label="${locator.text}"`;
    case 'testid': return `[data-testid="${locator.id}"]`;
    case 'id':     return `#${locator.id}`;
    case 'css':    return locator.selector;
    default:       return JSON.stringify(locator);
  }
}

function locatorOf(page, locator) {
  switch (locator.kind) {
    case 'role':   return locator.name
      ? page.getByRole(locator.role, { name: locator.name })
      : page.getByRole(locator.role);
    case 'label':  return page.getByLabel(locator.text);
    case 'testid': return page.getByTestId(locator.id);
    case 'id':     return page.locator(`#${cssEscape(locator.id)}`);
    case 'css':    return page.locator(locator.selector);
    default:       throw new Error(`unknown locator kind "${locator.kind}"`);
  }
}

// Minimal CSS-escape for the `id` locator path — handles digit-leading +
// special-char ids without pulling in a dep. The schema regex already
// rejects most pathological ids; this is belt-and-braces for the rare
// hyphenated/numeric-prefix case.
function cssEscape(s) {
  return String(s).replace(/(^\d)|([^\w-])/g, '\\$1$2');
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
    case 'id':     return `#${locator.id}`;
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
  const startedAt = Date.now();
  const result = await runConsistency(parseArgs(process.argv.slice(2)));
  const durationMs = Date.now() - startedAt;
  // CI-scannable trailing summary line. Stdout (not stderr) so log
  // scrapers can grep `consistency:` on its own line.
  //
  // Format evolution:
  //   round-1: simple count + ledger path
  //   round-2: + canary + auth + duration
  //   round-3 (this): + kinds per severity (actionable axis), `BROKEN`
  //                   lead-in on non-zero exit (CI greppable), `(slow)`
  //                   marker for unusually-long runs
  if (result.ledger) {
    const allContradictions = (result.ledger.steps || [])
      .flatMap((s) => s.contradictions || []);
    // Group: severity → { kind → count }
    const groups = { P0: {}, P1: {}, P2: {}, P3: {} };
    for (const c of allContradictions) {
      if (groups[c.severity] === undefined) continue;
      groups[c.severity][c.kind] = (groups[c.severity][c.kind] || 0) + 1;
    }
    const total = allContradictions.length;
    // Render as: [P2:1 unannotated-surface] for one-kind,
    //            [P0:2 value-mismatch,absent-not-rendered P3:1 missing-surface] for many
    const sevSummary = ['P0','P1','P2','P3']
      .filter((sev) => Object.keys(groups[sev]).length > 0)
      .map((sev) => {
        const kindSummary = Object.entries(groups[sev])
          .map(([k, n]) => n > 1 ? `${k}×${n}` : k)
          .join(',');
        const total = Object.values(groups[sev]).reduce((a, b) => a + b, 0);
        return `${sev}:${total} ${kindSummary}`;
      })
      .join(' ') || '';
    const canaryName = result.ledger.canaryName || '(none)';
    const authKind = result.ledger.authKind || 'none';
    const SLOW_THRESHOLD_MS = 10_000;
    const slowMarker = durationMs > SLOW_THRESHOLD_MS ? ' (slow)' : '';
    const exitMarker = result.exitCode !== 0 ? 'BROKEN ' : '';
    const sevPart = sevSummary ? ` [${sevSummary}]` : '';
    process.stdout.write(
      `consistency: ${exitMarker}canary=${canaryName} auth=${authKind} ${total} contradiction(s)${sevPart} duration=${durationMs}ms${slowMarker} ledger=${result.ledgerPath} exit=${result.exitCode}\n`,
    );
  } else {
    const exitMarker = result.exitCode !== 0 ? 'BROKEN ' : '';
    process.stdout.write(
      `consistency: ${exitMarker}no ledger written duration=${durationMs}ms exit=${result.exitCode}\n`,
    );
  }
  process.exit(result.exitCode);
}

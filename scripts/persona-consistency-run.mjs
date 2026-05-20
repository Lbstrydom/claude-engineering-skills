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
import { diffClaims, manifestQualityWarnings } from './lib/persona-test/consistency.mjs';
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
    ledger.state.authKind = canary.authBootstrap?.kind || 'none';

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
        'ℹ audit-loop linkage off (no SUPABASE_AUDIT_URL) — contradictions ' +
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

      // Resolves wine-cellar round-2 #2: auto-await manifest-declared
      // networkSource URL patterns before capture. Async-rendered surfaces
      // populate their data-engine-* attributes only after the relevant
      // API response lands; capturing before that just emits
      // unresolved-ground-truth for every async surface. We briefly wait
      // for each unique urlPattern not yet seen in the store this step.
      await awaitManifestNetworkSources(page, manifestResult.manifest, listener, {
        timeoutMs: 1500,
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
      const unannotatedFindings = await detectUnannotatedSurfaces(
        page,
        manifestResult.manifest,
        witness,
        { currentRoute: safeCurrentRoute(page), currentStepLabel: step.label },
      );

      // Diff. Semantic compare is off by default in the runner — wire when
      // Phase 4.1 (canary --enable-semantic) lands.
      const rawContradictions = await diffClaims(witness, manifestResult.manifest, {
        context: {
          currentRoute: safeCurrentRoute(page),
          currentStepLabel: step.label,
        },
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
      ledger.appendStep({
        stepIndex: i,
        plan: step.label || `step ${i}`,
        actionLabel: describeAction(step),
        resolvedTarget: stepMeta?.resolvedTarget ?? null,
        navResponseStatus: stepMeta?.navResponseStatus ?? null,
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
async function awaitManifestNetworkSources(page, manifest, listener, opts = {}) {
  const timeoutMs = Number.isInteger(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 1500;
  const patterns = new Set();
  for (const surface of (manifest?.surfaces || [])) {
    for (const f of (surface.engineFields || [])) {
      if (f?.networkSource?.urlPattern) patterns.add(f.networkSource.urlPattern);
    }
  }
  if (patterns.size === 0) return;

  // Check what we've already seen this run via the store keys.
  const seenKeys = listener.store.keys();
  const seenUrls = new Set(seenKeys.map((k) => k));   // tuple keys; loose match below
  const unseen = [...patterns].filter((urlPat) => {
    // The store stores by tuple `surfaceId::engineField::scope::key`, not
    // by URL. We can't easily probe "did any response of pattern X arrive"
    // from the store alone — so the simpler check is: are there ANY entries
    // for surfaces using this pattern? If not, we haven't seen the response.
    const patternStr = String(urlPat);
    return !seenKeys.some((k) => {
      const surfaceId = k.split('::')[0];
      const surface = manifest.surfaces.find((s) => s.id === surfaceId);
      if (!surface) return false;
      return surface.engineFields.some((f) => f.networkSource?.urlPattern === patternStr);
    });
  });
  if (unseen.length === 0) return;

  // Wait in parallel up to the total cap.
  const waiters = unseen.map((urlPat) => {
    try {
      const re = new RegExp(urlPat);
      return page.waitForResponse((r) => re.test(r.url()) && r.status() >= 200 && r.status() < 300, { timeout: timeoutMs })
        .then(() => ({ ok: true, pattern: urlPat }))
        .catch(() => ({ ok: false, pattern: urlPat }));
    } catch {
      return Promise.resolve({ ok: false, pattern: urlPat });
    }
  });
  const results = await Promise.all(waiters);
  for (const r of results) {
    if (!r.ok && typeof opts.warn === 'function') {
      opts.warn({
        kind: 'manifest-network-await-timeout',
        surfaceId: null,
        detail: `Waited ${timeoutMs}ms for response matching ${r.pattern} but none arrived; capture proceeds — downstream unresolved-ground-truth findings expected for surfaces using this pattern`,
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
 * @param {{ currentRoute?: string }} ctx
 * @returns {Promise<import('./lib/persona-test/schemas.mjs').Contradiction[]>}
 */
async function detectUnannotatedSurfaces(page, manifest, witness, ctx = {}) {
  const out = [];
  const seenSurfaceIds = new Set((witness?.domClaims || []).map((c) => c.surfaceId));
  for (const surface of (manifest?.surfaces || [])) {
    if (seenSurfaceIds.has(surface.id)) continue;   // annotated — diff handled it
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
        detail: `Surface "${surface.id}" — locator matched ${count} element(s) in the live DOM but no data-engine-claim attribute. Annotate the element with data-engine-claim/-value/-freshness, OR re-deploy if the annotation lives in a branch not yet shipped`,
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
  // Resolves wine-cellar adoption #6 + round-2 ask: CI-scannable trailing
  // summary line. Stdout (not stderr) so log scrapers can grep
  // `consistency:` on its own line. Compact + machine-parseable:
  //   - canary= so multi-canary jobs can grep
  //   - counts per severity (omits 0s)
  //   - duration so flakes show
  //   - auth= so adopters notice `none` when it shouldn't be
  //   - ledger path + exit code
  if (result.ledger) {
    const allContradictions = (result.ledger.steps || [])
      .flatMap((s) => s.contradictions || []);
    const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
    for (const c of allContradictions) {
      if (counts[c.severity] !== undefined) counts[c.severity] += 1;
    }
    const total = allContradictions.length;
    const sevSummary = ['P0','P1','P2','P3']
      .filter((k) => counts[k] > 0)
      .map((k) => `${k}:${counts[k]}`)
      .join(' ') || '—';
    const canaryName = result.ledger.canaryName || '(none)';
    const authKind = result.ledger.authKind || 'none';
    process.stdout.write(
      `consistency: canary=${canaryName} auth=${authKind} ${total} contradiction(s) [${sevSummary}] duration=${durationMs}ms ledger=${result.ledgerPath} exit=${result.exitCode}\n`,
    );
  } else {
    process.stdout.write(
      `consistency: no ledger written duration=${durationMs}ms exit=${result.exitCode}\n`,
    );
  }
  process.exit(result.exitCode);
}

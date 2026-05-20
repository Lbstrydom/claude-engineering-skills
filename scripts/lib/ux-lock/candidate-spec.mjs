/**
 * @fileoverview Phase 2 candidate-spec renderer — produces a runnable
 * Playwright spec from a WitnessRecord + Contradiction + JourneyContext.
 *
 * Plan: docs/plans/persona-test-consistency-mode.md.
 *
 * Lifecycle: candidate rows live in the DB only; this renderer fires
 * exclusively at /ship promotion time. The spec body has three sections
 * (resolves Gemini-R4-G1 — needs journey context to navigate, not just
 * the witness):
 *
 *   1. Setup     — auth bootstrap (storageState load or bearer-token env)
 *                  + routes resolution
 *   2. Navigate  — replay journeyContext.journeySteps[] up to the
 *                  contradiction step
 *   3. Assert    — emit the DOM-contract assertion using the matched
 *                  locator + the engineField value the engine produced
 *
 * Deterministic output: same `(witness, contradiction, journeyContext)`
 * input must produce byte-identical spec text. No timestamps, no random
 * ids; the filename is derived from `candidate_fingerprint` short-hash.
 *
 * @module scripts/lib/ux-lock/candidate-spec
 */

/**
 * @param {import('../persona-test/schemas.mjs').WitnessRecord}   witness
 * @param {import('../persona-test/schemas.mjs').Contradiction}   contradiction
 * @param {{
 *   journeySteps: Array<object>,
 *   routes?: Record<string, string>,
 *   authBootstrap?: {kind: 'none'|'token'|'storageState', tokenEnv?: string, storageStatePath?: string},
 *   candidateFingerprint?: string,
 * }} journeyContext
 * @returns {{ filename: string, body: string }}
 */
export function renderCandidateSpec(witness, contradiction, journeyContext) {
  if (!contradiction || !contradiction.surfaceId) {
    throw new Error('renderCandidateSpec: contradiction must carry a resolved surfaceId');
  }
  if (!journeyContext || !Array.isArray(journeyContext.journeySteps)) {
    throw new Error('renderCandidateSpec: journeyContext.journeySteps[] is required');
  }

  const auth   = journeyContext.authBootstrap ?? { kind: 'none' };
  const routes = journeyContext.routes ?? {};
  const fpShort = (journeyContext.candidateFingerprint || 'unknown')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 10);

  const filename = `consistency-${slug(contradiction.surfaceId)}-${fpShort}.spec.js`;
  const body = [
    renderHeader(witness, contradiction, fpShort),
    renderImports(),
    renderRoutes(routes),
    renderTest(auth, journeyContext.journeySteps, contradiction),
    '',
  ].join('\n');

  return { filename, body };
}

// ── Renderer sections ──────────────────────────────────────────────────────

function renderHeader(witness, contradiction, fpShort) {
  return [
    '// Auto-generated regression lock from persona-consistency-mode.',
    '// Plan: docs/plans/persona-test-consistency-mode.md.',
    `// Surface: ${contradiction.surfaceId} · engineField: ${contradiction.engineField ?? '(n/a)'} · kind: ${contradiction.kind}`,
    `// Candidate fingerprint (short): ${fpShort}`,
    '//',
    '// DO NOT hand-edit selectors here — re-run /ship promotion to regenerate',
    '// from the witness snapshot if the surface contract changes.',
  ].join('\n');
}

function renderImports() {
  return [
    '',
    "import { test, expect } from '@playwright/test';",
  ].join('\n');
}

function renderRoutes(routes) {
  if (!routes || Object.keys(routes).length === 0) return '';
  const entries = Object.entries(routes).map(([k, v]) => `  ${js(k)}: ${js(v)}`).join(',\n');
  return `\nconst ROUTES = {\n${entries},\n};`;
}

function renderTest(auth, steps, contradiction) {
  const indent = '  ';
  const bodyLines = [];

  // Auth setup — Playwright supports test.use({storageState: ...}) at file
  // scope. We emit a `test.beforeEach` to keep the spec self-contained.
  if (auth.kind === 'storageState' && auth.storageStatePath) {
    bodyLines.push(`test.use({ storageState: ${js(auth.storageStatePath)} });`);
  } else if (auth.kind === 'token' && auth.tokenEnv) {
    bodyLines.push(
      `test.beforeEach(async ({ context }) => {`,
      `${indent}const token = process.env[${js(auth.tokenEnv)}];`,
      `${indent}if (!token) throw new Error('${auth.tokenEnv} must be set for this spec');`,
      `${indent}await context.setExtraHTTPHeaders({ Authorization: \`Bearer \${token}\` });`,
      `});`,
    );
  }

  bodyLines.push(
    '',
    `test(${js(`consistency lock — ${contradiction.surfaceId} (${contradiction.kind})`)}, async ({ page }) => {`,
  );

  // Replay journey steps that lead to the contradicted state.
  for (const step of steps) {
    bodyLines.push(...renderStepCalls(step, indent));
  }

  // Final assertion — built from the contradiction's selector + expected value.
  bodyLines.push(...renderAssertion(contradiction, indent));

  bodyLines.push('});');

  return ['', ...bodyLines].join('\n');
}

function renderStepCalls(step, indent) {
  const lines = [];
  const label = step.label ? ` // ${step.label}` : '';
  switch (step.action) {
    case 'navigate': {
      const target = step.url
        ? js(step.url)
        : `ROUTES[${js(step.routeKey)}]`;
      const waitUntil = step.waitUntil || 'load';
      lines.push(`${indent}await page.goto(${target}, { waitUntil: ${js(waitUntil)} });${label}`);
      break;
    }
    case 'click': {
      lines.push(`${indent}await ${locatorCall(step.locator)}.click();${label}`);
      if (step.postWait) lines.push(...renderWait(step.postWait, indent));
      break;
    }
    case 'fill': {
      const blur = step.blurAfter === false ? '' : `\n${indent}await ${locatorCall(step.locator)}.blur();`;
      lines.push(`${indent}await ${locatorCall(step.locator)}.fill(${js(step.value)});${blur}${label}`);
      break;
    }
    case 'wait': {
      lines.push(...renderWait(step.condition, indent));
      break;
    }
    case 'evaluate': {
      // `evaluate` steps replay as TODO (per §11b Known Limitations — `evaluate`
      // is rarely used and bundling scripts paths is out of v1 scope).
      lines.push(`${indent}// TODO: replay evaluate step "${step.scriptId}" (out of v1 scope, see plan §11b)`);
      break;
    }
    default:
      lines.push(`${indent}// (unknown action: ${step.action})`);
  }
  return lines;
}

function renderWait(cond, indent) {
  if (!cond) return [];
  switch (cond.kind) {
    case 'visible':
      return [`${indent}await ${locatorCall(cond.locator)}.waitFor({ state: 'visible', timeout: ${cond.timeoutMs} });`];
    case 'hidden':
      return [`${indent}await ${locatorCall(cond.locator)}.waitFor({ state: 'hidden',  timeout: ${cond.timeoutMs} });`];
    case 'url':
      return [`${indent}await page.waitForURL(new RegExp(${js(cond.urlPattern)}), { timeout: ${cond.timeoutMs} });`];
    case 'network':
      return [`${indent}await page.waitForResponse((r) => new RegExp(${js(cond.urlPattern)}).test(r.url())${cond.method ? ` && r.request().method() === ${js(cond.method)}` : ''}, { timeout: ${cond.timeoutMs} });`];
    case 'timeout':
      return [`${indent}await page.waitForTimeout(${cond.ms});`];
    default:
      return [`${indent}// (unknown wait kind: ${cond.kind})`];
  }
}

function renderAssertion(contradiction, indent) {
  // The locked spec asserts what the engine produced for the contradicted
  // surface+field — the rendered DOM must match that going forward.
  const sel = contradiction.selector || '[data-engine-claim]';
  const expectedValueLiteral = contradiction.engineValue == null
    ? 'null'
    : (typeof contradiction.engineValue === 'string'
        ? js(String(contradiction.engineValue))
        : JSON.stringify(contradiction.engineValue));
  return [
    '',
    `${indent}// Lock the contract: ${contradiction.surfaceId}.${contradiction.engineField ?? '(n/a)'} must match engine.`,
    `${indent}const el = page.locator(${js(sel)});`,
    `${indent}await expect(el).toBeVisible();`,
    `${indent}const observed = await el.getAttribute('data-engine-value');`,
    `${indent}expect(observed).toBe(String(${expectedValueLiteral}));`,
    `${indent}const freshness = await el.getAttribute('data-freshness');`,
    `${indent}expect(freshness).not.toBe('stale');`,
  ];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function locatorCall(locator) {
  if (!locator) return 'page';
  switch (locator.kind) {
    case 'role':   return locator.name
      ? `page.getByRole(${js(locator.role)}, { name: ${js(locator.name)} })`
      : `page.getByRole(${js(locator.role)})`;
    case 'label':  return `page.getByLabel(${js(locator.text)})`;
    case 'testid': return `page.getByTestId(${js(locator.id)})`;
    case 'css':    return `page.locator(${js(locator.selector)})`;
    default:       return `page.locator('[data-engine-claim]')`;
  }
}

function js(value) {
  return JSON.stringify(value);
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// Test-internal exports.
export const _internals = Object.freeze({
  renderStepCalls,
  renderAssertion,
  renderWait,
  locatorCall,
  slug,
});

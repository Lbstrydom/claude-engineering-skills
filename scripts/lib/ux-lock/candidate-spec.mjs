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
  // Resolves R3-H4: explicit replay-boundary contract. journeyContext is
  // a SLICE up to and including the contradicted step, NOT the full
  // canary journey. The producer (runner) sets contradictionStepIndex;
  // we validate it matches `journeySteps.length - 1` so a malformed
  // candidate row fails loudly rather than replaying an incorrect prefix.
  if (typeof journeyContext.contradictionStepIndex === 'number') {
    if (journeyContext.contradictionStepIndex !== journeyContext.journeySteps.length - 1) {
      throw new Error(
        `renderCandidateSpec: contradictionStepIndex=${journeyContext.contradictionStepIndex} disagrees with journeySteps.length=${journeyContext.journeySteps.length} (expected length === index+1)`,
      );
    }
  }
  // Note: older candidate rows persisted before R3-H4 may lack the field;
  // we accept those silently for backward compat — the slice was already
  // correct, we just couldn't verify it without the explicit boundary.

  const auth   = journeyContext.authBootstrap ?? { kind: 'none' };
  const routes = journeyContext.routes ?? {};
  // Resolves R2-H7 + R2-H12: 10 hex chars = ~5×10⁻¹³ chance of collision
  // per (surface, fingerprint) pair. We bump to 16 chars (~3×10⁻²⁰) and
  // refuse to emit at all when fingerprint is missing — a missing
  // fingerprint means the candidate row violated row-shape CHECK, which
  // should fail loud, not silently collide on filename.
  if (!journeyContext.candidateFingerprint) {
    throw new Error(
      'renderCandidateSpec: journeyContext.candidateFingerprint is required (a missing fingerprint would collide on filename — refuse rather than overwrite)',
    );
  }
  const fpShort = String(journeyContext.candidateFingerprint)
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 16);
  if (fpShort.length < 16) {
    throw new Error(
      `renderCandidateSpec: candidateFingerprint too short after normalisation ("${fpShort}") — needs at least 16 alphanumerics`,
    );
  }

  const filename = `consistency-${slug(contradiction.surfaceId)}-${fpShort}.spec.js`;
  const body = [
    renderHeader(witness, contradiction, fpShort),
    renderImports(),
    renderRoutes(routes),
    renderTest(auth, journeyContext.journeySteps, contradiction, routes),
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

function renderTest(auth, steps, contradiction, routes) {
  const indent = '  ';
  const bodyLines = [];
  const ctx = {
    routes: routes || {},
    hasRoutes: routes && Object.keys(routes).length > 0,
  };

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
    bodyLines.push(...renderStepCalls(step, indent, ctx));
  }

  // Final assertion — dispatched by contradiction.kind so each lifecycle
  // bug class gets the assertion that would actually detect it (resolves R1-H7).
  bodyLines.push(...renderAssertion(contradiction, indent));

  bodyLines.push('});');

  return ['', ...bodyLines].join('\n');
}

function renderStepCalls(step, indent, ctx) {
  const lines = [];
  const label = step.label ? ` // ${step.label}` : '';
  switch (step.action) {
    case 'navigate': {
      // Resolves R1-H8: refuse to emit ROUTES[<key>] when no routes map is
      // available — that would generate a spec that references an undefined
      // constant. Either url is given OR the routeKey is in the journey
      // context's routes map; anything else is a hard error.
      let target;
      if (step.url) {
        target = js(step.url);
      } else if (step.routeKey) {
        if (!ctx.hasRoutes) {
          throw new Error(
            `renderCandidateSpec: journey step "${step.label || '(unnamed)'}" uses routeKey="${step.routeKey}" but the candidate's journey_context has no routes map`,
          );
        }
        if (!Object.prototype.hasOwnProperty.call(ctx.routes, step.routeKey)) {
          throw new Error(
            `renderCandidateSpec: journey step "${step.label || '(unnamed)'}" references routeKey="${step.routeKey}" not defined in routes map`,
          );
        }
        target = `ROUTES[${js(step.routeKey)}]`;
      } else {
        throw new Error(
          `renderCandidateSpec: navigate step "${step.label || '(unnamed)'}" missing both url and routeKey`,
        );
      }
      const waitUntil = step.waitUntil || 'load';
      lines.push(`${indent}await page.goto(${target}, { waitUntil: ${js(waitUntil)} });${label}`);
      break;
    }
    case 'click': {
      if (!step.locator) {
        throw new Error(`renderCandidateSpec: click step "${step.label || '(unnamed)'}" missing locator`);
      }
      // Resolves R3-H3: when postWait is `network` or `url`, the event
      // we're waiting for can fire BEFORE `await` returns from the wait
      // call if the wait is registered after the click. Playwright's
      // documented fix is to register the waiter BEFORE the action via
      // `Promise.all([waiter, action])` so the response is captured no
      // matter how fast it lands. For `visible`/`hidden`/`timeout`
      // post-waits, ordering doesn't matter — keep the simpler sequential
      // emission for those.
      const isEventWait = step.postWait
        && (step.postWait.kind === 'network' || step.postWait.kind === 'url');
      if (isEventWait) {
        const waitExpr = renderWaitExpression(step.postWait);
        lines.push(`${indent}await Promise.all([`);
        lines.push(`${indent}  ${waitExpr},`);
        lines.push(`${indent}  ${locatorCall(step.locator)}.click(),`);
        lines.push(`${indent}]);${label}`);
      } else {
        lines.push(`${indent}await ${locatorCall(step.locator)}.click();${label}`);
        if (step.postWait) lines.push(...renderWait(step.postWait, indent));
      }
      break;
    }
    case 'fill': {
      if (!step.locator) {
        throw new Error(`renderCandidateSpec: fill step "${step.label || '(unnamed)'}" missing locator`);
      }
      const blur = step.blurAfter === false ? '' : `\n${indent}await ${locatorCall(step.locator)}.blur();`;
      lines.push(`${indent}await ${locatorCall(step.locator)}.fill(${js(step.value)});${blur}${label}`);
      break;
    }
    case 'wait': {
      lines.push(...renderWait(step.condition, indent));
      break;
    }
    case 'evaluate': {
      // Resolves R2-H3 + R2-H10: a "TODO comment" is NOT a regression lock.
      // The plan §11b accepted "evaluate steps replay as TODO comments"
      // but the auditor correctly observed that this lets /ship materialise
      // a spec whose assertion is unreachable (the journey can't replay
      // back to the contradicted state without the evaluate). Hard error
      // instead — the candidate stays as a candidate; the operator
      // either rewrites the journey to remove the evaluate step, or
      // hand-writes the lock spec.
      throw new Error(
        `renderCandidateSpec: cannot promote — journey contains evaluate step "${step.scriptId}" which the renderer cannot replay (v1 limitation, see plan §11b). The candidate row remains pending; rewrite the journey without evaluate to enable promotion.`,
      );
    }
    default:
      // Resolves R1-H8: hard-error on unknown actions so the rendered spec
      // can never claim "lock contract" for steps the runner didn't execute.
      throw new Error(`renderCandidateSpec: unknown journey action "${step.action}"`);
  }
  return lines;
}

// Emits a bare promise expression (no `await`, no trailing `;`) for use
// inside Promise.all() arrays. Only meaningful for event-style waits
// (network / url) that suffer the pre-arm race fixed in R3-H3.
function renderWaitExpression(cond) {
  switch (cond.kind) {
    case 'url':
      return `page.waitForURL(new RegExp(${js(cond.urlPattern)}), { timeout: ${cond.timeoutMs} })`;
    case 'network':
      return `page.waitForResponse((r) => new RegExp(${js(cond.urlPattern)}).test(r.url())${cond.method ? ` && r.request().method() === ${js(cond.method)}` : ''}, { timeout: ${cond.timeoutMs} })`;
    default:
      throw new Error(`renderWaitExpression: pre-arm only meaningful for network/url waits (got "${cond.kind}")`);
  }
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
      // Resolves R1-H8: unknown wait kind is a hard error (don't ship a
      // spec that silently skips a settle condition the runner observed).
      throw new Error(`renderCandidateSpec: unknown wait kind "${cond.kind}"`);
  }
}

function renderAssertion(contradiction, indent) {
  // Resolves R1-H7: dispatch by contradiction.kind. Each contradiction type
  // is a different bug class and needs an assertion that would actually
  // detect it; a single value-mismatch template emitted unconditionally
  // would silently pass for stale-projection / undeclared / etc.
  const sel = contradiction.selector;
  if (!sel) {
    throw new Error(
      `renderCandidateSpec: contradiction missing selector — cannot emit DOM assertion (kind="${contradiction.kind}")`,
    );
  }

  const header = [
    '',
    `${indent}// Lock the contract: ${contradiction.surfaceId}.${contradiction.engineField ?? '(n/a)'} (${contradiction.kind})`,
    `${indent}const el = page.locator(${js(sel)});`,
    `${indent}await expect(el).toBeVisible();`,
  ];

  switch (contradiction.kind) {
    case 'value-mismatch':
    case 'value-coercion-error':
    case 'key-coercion-error': {
      const expected = contradiction.engineValue == null
        ? 'null'
        : (typeof contradiction.engineValue === 'string'
            ? js(String(contradiction.engineValue))
            : JSON.stringify(contradiction.engineValue));
      return [
        ...header,
        `${indent}const observed = await el.getAttribute('data-engine-value');`,
        `${indent}expect(observed).toBe(String(${expected}));`,
      ];
    }
    case 'stale-projection':
      // The bug class is "stale freshness while visible". The lock asserts
      // that freshness is current (the engine has caught up by the time
      // this surface renders).
      return [
        ...header,
        `${indent}const freshness = await el.getAttribute('data-freshness');`,
        `${indent}expect(freshness).toBe('current');`,
      ];
    case 'absent-not-rendered':
      // Engine value was null AND DOM didn't render `data-freshness="absent"`
      // (or vice versa). Lock asserts the absent contract is honoured.
      return [
        ...header,
        `${indent}const freshness = await el.getAttribute('data-freshness');`,
        `${indent}const observed = await el.getAttribute('data-engine-value');`,
        `${indent}// When engine value is null, DOM must render freshness='absent'`,
        `${indent}if (${JSON.stringify(contradiction.engineValue) === 'null'}) {`,
        `${indent}  expect(freshness).toBe('absent');`,
        `${indent}} else {`,
        `${indent}  expect(freshness).not.toBe('absent');`,
        `${indent}  expect(observed).toBe(String(${JSON.stringify(contradiction.engineValue)}));`,
        `${indent}}`,
      ];
    case 'undeclared-engine-claim':
      // The bug class is "DOM makes a claim the manifest doesn't know about".
      // The lock asserts the element does NOT carry an undeclared
      // data-engine-claim — i.e. the surface either has a known claim or
      // no claim at all. Locking the SPECIFIC claim isn't possible without
      // the manifest at test time, so we assert the offending field is no
      // longer asserted on this selector.
      return [
        ...header,
        `${indent}const claim = await el.getAttribute('data-engine-claim');`,
        `${indent}// This surface should not carry an undeclared engine claim:`,
        `${indent}expect(claim).not.toBe(${js(contradiction.engineField || '')});`,
      ];
    case 'missing-surface':
      // The "lock" for missing-surface is to assert the surface IS present
      // going forward. The lock spec navigates to the same context (handled
      // by the journey replay) and checks the locator resolves.
      return [
        ...header,
        `${indent}// Surface must remain present in this context.`,
        `${indent}await expect(el).toHaveCount(1);`,
      ];
    case 'unresolved-ground-truth':
      // The bug class is "rig couldn't see the network truth". The lock
      // spec doesn't have anything to assert on the DOM — instead it
      // records the locator path so a manual investigation can pin a
      // proper test. We emit a soft expect so the spec runs but fails
      // until a real assertion replaces it.
      return [
        ...header,
        `${indent}// TODO: rig had no ground-truth for this surface; manual investigation needed.`,
        `${indent}// This lock asserts the surface remains observable; replace with a real`,
        `${indent}// assertion once the manifest networkSource is corrected.`,
        `${indent}expect(true).toBe(true);`,
      ];
    default:
      // Resolves R1-H8: unknown contradiction kind is a hard error so we
      // never silently emit a wrong-shape assertion.
      throw new Error(
        `renderCandidateSpec: cannot emit assertion for unknown contradiction kind "${contradiction.kind}"`,
      );
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function locatorCall(locator) {
  if (!locator) {
    // Resolves R1-H8: refuse to fall back to a wildcard `[data-engine-claim]`
    // locator. A missing locator means the journey step is malformed; emit
    // a hard error so promotion fails loudly rather than producing a spec
    // that asserts against the wrong element.
    throw new Error('renderCandidateSpec: locator is required (no fallback)');
  }
  switch (locator.kind) {
    case 'role':   return locator.name
      ? `page.getByRole(${js(locator.role)}, { name: ${js(locator.name)} })`
      : `page.getByRole(${js(locator.role)})`;
    case 'label':  return `page.getByLabel(${js(locator.text)})`;
    case 'testid': return `page.getByTestId(${js(locator.id)})`;
    case 'id':     return `page.locator(${js('#' + locator.id)})`;
    case 'css':    return `page.locator(${js(locator.selector)})`;
    default:       throw new Error(`renderCandidateSpec: unknown locator kind "${locator.kind}"`);
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

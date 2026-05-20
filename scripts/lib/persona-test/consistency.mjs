/**
 * @fileoverview Pure diff engine — given a WitnessRecord and a manifest,
 * emit Contradiction[] applying the consistency grammar.
 *
 * Phase 1 of docs/plans/persona-test-consistency-mode.md.
 *
 * Rules implemented:
 *   - Exact match for typed fields (boolean/integer/count/enum/id/freshness)
 *   - Semantic match ONLY for `prose` fields with `llmSafe: true`
 *   - CROSS_STREAM_VIOLATION is enforced in semantic-compare itself
 *     (this module never invokes it for non-prose fields)
 *   - Type coercion (Gemini-R3-G3): DOM strings → declared type before compare
 *   - Key coercion (Gemini-R4-G2): same coercion for data-engine-key
 *   - Null ground-truth handling (Gemini-R4-G3): null engine → must be
 *     data-freshness="absent" in DOM; else absent-not-rendered
 *   - Stale-projection (Gemini-R2-G4): severity from surface's
 *     severityFloor, NOT hardcoded P0
 *   - Negative-space (R1-Phase 5): undeclared data-engine-claim → P0
 *   - Missing-surface: declared surface absent from DOM → P3 if appliesTo
 *     context matches the current page; suppressed otherwise (R1-M4)
 *
 * No side effects. No LLM call directly. No file I/O. The caller injects
 * `semanticCompare` (an optional async function) for prose fields. When
 * absent, prose fields with mismatched DOM/engine values emit a
 * `value-mismatch` at LOW confidence with reason `semantic-compare-unavailable`.
 *
 * @module scripts/lib/persona-test/consistency
 */

/**
 * Coerce a raw DOM string to the manifest's declared engine-field type.
 *
 * @param {string} rawString
 * @param {'boolean'|'enum'|'integer'|'count'|'id'|'freshness'|'prose'} declaredType
 * @param {string[]} [semanticValues] - for `enum`
 * @returns {{ok: true, value: unknown} | {ok: false, error: string}}
 */
export function coerceDomValue(rawString, declaredType, semanticValues) {
  if (typeof rawString !== 'string') {
    return { ok: false, error: 'dom-value-not-string' };
  }
  switch (declaredType) {
    case 'boolean':
      if (rawString === 'true')  return { ok: true, value: true };
      if (rawString === 'false') return { ok: true, value: false };
      return { ok: false, error: `expected "true"/"false", got "${rawString}"` };

    case 'integer':
    case 'count': {
      const trimmed = rawString.trim();
      if (trimmed === '') return { ok: false, error: 'empty integer string' };
      const parsed = parseInt(trimmed, 10);
      if (Number.isNaN(parsed)) return { ok: false, error: `non-integer "${rawString}"` };
      // Reject "12abc" — parseInt silently truncates. Require round-trip equality.
      if (String(parsed) !== trimmed) {
        return { ok: false, error: `non-integer trailing chars in "${rawString}"` };
      }
      return { ok: true, value: parsed };
    }

    case 'enum':
      if (Array.isArray(semanticValues) && semanticValues.length > 0) {
        if (!semanticValues.includes(rawString)) {
          return {
            ok: false,
            error: `value "${rawString}" not in declared enum [${semanticValues.join(', ')}]`,
          };
        }
      }
      return { ok: true, value: rawString };

    case 'id':
    case 'prose':
    case 'freshness':
      return { ok: true, value: rawString };

    default:
      return { ok: false, error: `unknown declared type "${declaredType}"` };
  }
}

/**
 * Coerce a DOM key string to the type of the JSON keyField value.
 * `inferredType` is sampled from the first network response at runtime
 * (number / string / boolean). Resolves Gemini-R4-G2.
 *
 * @param {string} rawKey
 * @param {'number'|'string'|'boolean'} inferredType
 * @returns {{ok: true, value: unknown} | {ok: false, error: string}}
 */
export function coerceDomKey(rawKey, inferredType) {
  if (typeof rawKey !== 'string') {
    return { ok: false, error: 'dom-key-not-string' };
  }
  switch (inferredType) {
    case 'string':
      return { ok: true, value: rawKey };
    case 'number': {
      const trimmed = rawKey.trim();
      const parsed = Number(trimmed);
      if (Number.isNaN(parsed) || trimmed === '') {
        return { ok: false, error: `key "${rawKey}" cannot be coerced to number` };
      }
      return { ok: true, value: parsed };
    }
    case 'boolean':
      if (rawKey === 'true')  return { ok: true, value: true };
      if (rawKey === 'false') return { ok: true, value: false };
      return { ok: false, error: `key "${rawKey}" cannot be coerced to boolean` };
    default:
      return { ok: false, error: `unknown inferred key type "${inferredType}"` };
  }
}

// Severity ordering for "raise to floor" logic. P0 is highest.
const SEVERITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };

function clampToFloor(proposed, floor) {
  // Raise (numerically lower) toward floor only if proposed is below floor.
  if (SEVERITY_RANK[proposed] > SEVERITY_RANK[floor]) return floor;
  return proposed;
}

/**
 * Walk the manifest + witness and emit Contradiction[].
 *
 * @param {import('./schemas.mjs').WitnessRecord} witness
 * @param {import('./schemas.mjs').SurfaceManifest} manifest
 * @param {object} [opts]
 * @param {(textA: string, textB: string, fieldType: string, callerOpts?: object) => Promise<{result: {matched: 'yes'|'no'|'uncertain'}}>} [opts.semanticCompare]
 *        — async function. The diff engine batches and awaits all prose
 *        comparisons before returning. When omitted, prose fields with
 *        mismatched DOM/engine values emit a `value-mismatch` finding with
 *        reason `semantic-compare-unavailable`.
 * @param {{ currentRoute?: string, currentStepLabel?: string, activeStateTags?: string[] }} [opts.context]
 *        — used to gate appliesTo / negative-space checks.
 * @returns {Promise<import('./schemas.mjs').Contradiction[]>}
 */
export async function diffClaims(witness, manifest, opts = {}) {
  const semanticCompare = typeof opts.semanticCompare === 'function' ? opts.semanticCompare : null;
  const context = opts.context || {};
  const findings = [];

  // Build index of declared surfaces + engine fields for O(1) lookup.
  const surfaceById = new Map();
  for (const surface of manifest.surfaces) {
    surfaceById.set(surface.id, surface);
  }

  // ── 1. Per-DOM-claim diff ──────────────────────────────────────────────
  // Track which (surfaceId, scope, key) pairs we've seen so the
  // negative-space check below knows what existed.
  const seenSurfaceClaims = new Set();
  const pendingProse = [];  // batched semantic compares

  for (const dom of witness.domClaims) {
    const surface = surfaceById.get(dom.surfaceId);
    const floor = surface ? surface.severityFloor : 'P0';

    // Skip non-visible elements for value-mismatch — but still let the
    // stale/absent rules fire (those care about visibility explicitly).
    if (!surface) {
      // Undeclared engine claim — surfaceId in DOM but not in manifest.
      findings.push(make('undeclared-engine-claim', 'P0', dom, null, null,
        `Surface "${dom.surfaceId}" not declared in surfaces.json`));
      continue;
    }

    // Mark the surface as seen as soon as the DOM matched its id — even if
    // the specific field turns out to be undeclared. Otherwise the missing-
    // surface check below would double-flag (undeclared-engine-claim AND
    // missing-surface) when the DOM names a real surface but a bad field.
    seenSurfaceClaims.add(`${dom.surfaceId}::${dom.scope ?? ''}::${dom.key ?? ''}`);

    const engineFieldDecl = surface.engineFields.find((f) => f.field === dom.engineField);
    if (!engineFieldDecl) {
      findings.push(make('undeclared-engine-claim', 'P0', dom, null, null,
        `engineField "${dom.engineField}" not declared on surface "${dom.surfaceId}"`));
      continue;
    }

    // Stale-projection — severity from manifest floor (Gemini-R2-G4).
    // Fire regardless of value match (the point is to surface the projection bug class).
    if (dom.freshness === 'stale' && dom.visible) {
      findings.push(make(
        'stale-projection', floor, dom, dom.domValueRaw, null,
        `Surface renders stale value while visible (data-freshness="stale")`,
      ));
      // Continue to value compare — stale is its own finding, but a stale value
      // that ALSO doesn't match should not be silently absorbed.
    }

    // Find the matching network claim (same surface + field + scope + key).
    const net = witness.networkClaims.find((n) =>
      n.surfaceId === dom.surfaceId &&
      n.engineField === dom.engineField &&
      (n.scope ?? null) === (dom.scope ?? null) &&
      (n.key   ?? null) === (dom.key   ?? null),
    );

    // Null ground-truth handling (Gemini-R4-G3).
    if (net && net.value === null) {
      if (dom.freshness !== 'absent') {
        findings.push(make(
          'absent-not-rendered', clampToFloor('P1', floor), dom, dom.domValueRaw, null,
          `Engine value is null but DOM does not render data-freshness="absent" (got "${dom.freshness}")`,
        ));
      }
      continue;   // value compare doesn't apply when engine has no value
    }
    if (dom.freshness === 'absent') {
      // freshness=absent + engine has a value → engine knows; DOM falsely claims unknown.
      if (net) {
        findings.push(make(
          'absent-not-rendered', clampToFloor('P1', floor), dom, dom.domValueRaw, net.value,
          `DOM renders data-freshness="absent" but engine has value ${JSON.stringify(net.value)}`,
        ));
      }
      continue;
    }

    if (!net) {
      // No matching network response was captured for this DOM claim.
      // The capture library should have marked partialCapture=true; this is
      // observability, not a contradiction. Skip silently — the surface is
      // simply uncorrelated for this step.
      continue;
    }

    // Coerce DOM value to declared type (Gemini-R3-G3 + R4-G2/G3).
    const coerced = coerceDomValue(dom.domValueRaw, engineFieldDecl.type, engineFieldDecl.semanticValues);
    if (!coerced.ok) {
      findings.push(make(
        'value-coercion-error', clampToFloor('P1', floor), dom, dom.domValueRaw, net.value,
        `Could not coerce DOM value: ${coerced.error}`,
      ));
      continue;
    }

    // Prose path — semantic compare (gated by llmSafe + presence of comparator).
    if (engineFieldDecl.type === 'prose') {
      if (!engineFieldDecl.llmSafe) {
        // llm-unsafe prose — comparison skipped; recorded as uncertain
        // (NOT a contradiction). The surface is just not auditable for value
        // equality in this build.
        continue;
      }
      if (!semanticCompare) {
        // Comparator unavailable — fall back to LOW-confidence string compare.
        if (typeof net.value === 'string' && net.value !== coerced.value) {
          findings.push(make(
            'value-mismatch', clampToFloor('P2', floor), dom, dom.domValueRaw, net.value,
            'Prose mismatch (semantic comparator unavailable — string compare)',
          ));
        }
        continue;
      }
      pendingProse.push({ dom, net, engineFieldDecl, floor, coercedValue: coerced.value });
      continue;
    }

    // Typed path — exact match.
    if (!deepEqual(coerced.value, net.value)) {
      findings.push(make(
        'value-mismatch', floor, dom, dom.domValueRaw, net.value,
        `DOM ${JSON.stringify(coerced.value)} (raw "${dom.domValueRaw}") ≠ engine ${JSON.stringify(net.value)}`,
      ));
    }
  }

  // ── 2. Resolve pending prose compares (parallel) ───────────────────────
  if (pendingProse.length > 0 && semanticCompare) {
    const results = await Promise.all(pendingProse.map(async (p) => {
      try {
        const r = await semanticCompare(String(p.coercedValue), String(p.net.value), 'prose');
        return { ok: true, verdict: r?.result, p };
      } catch (err) {
        return { ok: false, error: err?.message || String(err), p };
      }
    }));
    for (const r of results) {
      if (!r.ok) {
        findings.push(make(
          'value-mismatch', clampToFloor('P2', r.p.floor), r.p.dom, r.p.dom.domValueRaw, r.p.net.value,
          `Semantic comparator errored: ${r.error}`,
        ));
        continue;
      }
      if (r.verdict?.matched === 'no') {
        findings.push(make(
          'value-mismatch', r.p.floor, r.p.dom, r.p.dom.domValueRaw, r.p.net.value,
          r.verdict?.reason ? `Prose mismatch — ${r.verdict.reason}` : 'Prose mismatch',
        ));
      }
      // matched === 'yes' or 'uncertain' → no finding (uncertain is observability, not a verdict)
    }
  }

  // ── 3. Negative-space: undeclared DOM claims (carried in witness) ──────
  for (const u of witness.undeclaredDomClaims) {
    findings.push({
      kind: 'undeclared-engine-claim',
      severity: 'P0',
      surfaceId: null,
      engineField: u.engineField,
      scope: null,
      key: null,
      domValue: null,
      engineValue: null,
      freshness: null,
      selector: u.selector,
      detail: `DOM element makes engine claim "${u.engineField}" not declared in surfaces.json`,
      suppressedByLockedSpec: null,
    });
  }

  // ── 4. Missing-surface: declared surface absent (gated by appliesTo) ───
  for (const surface of manifest.surfaces) {
    if (!appliesToCurrent(surface.appliesTo, context)) continue;   // R1-M4 gate
    const anySeen = [...seenSurfaceClaims].some((k) => k.startsWith(`${surface.id}::`));
    if (!anySeen) {
      findings.push({
        kind: 'missing-surface',
        severity: 'P3',
        surfaceId: surface.id,
        engineField: null,
        scope: null,
        key: null,
        domValue: null,
        engineValue: null,
        freshness: null,
        selector: locatorToString(surface.locator),
        detail: `Declared surface "${surface.id}" absent from DOM in current context`,
        suppressedByLockedSpec: null,
      });
    }
  }

  // ── 5. CSS-locator nudge — emit P2 per surface using a `css` locator
  //      with `warn:true`. Once-per-surface across the diff (not once per
  //      DOM claim, which would be noisy).
  const cssWarned = new Set();
  for (const surface of manifest.surfaces) {
    if (surface.locator.kind === 'css' && surface.locator.warn && !cssWarned.has(surface.id)) {
      cssWarned.add(surface.id);
      findings.push({
        kind: 'value-mismatch',  // borrowed kind; in v1 we don't have a `locator-nudge` kind
        severity: clampToFloor('P2', surface.severityFloor),
        surfaceId: surface.id,
        engineField: null,
        scope: null,
        key: null,
        domValue: null,
        engineValue: null,
        freshness: null,
        selector: surface.locator.selector,
        detail: `Surface "${surface.id}" uses CSS-class locator (".${surface.locator.selector}"); prefer role/label/testid`,
        suppressedByLockedSpec: null,
      });
    }
  }

  return findings;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function make(kind, severity, dom, domValue, engineValue, detail) {
  return {
    kind,
    severity,
    surfaceId: dom.surfaceId,
    engineField: dom.engineField,
    scope: dom.scope ?? null,
    key: dom.key ?? null,
    domValue,
    engineValue,
    freshness: dom.freshness,
    selector: locatorToString(dom.locator),
    detail,
    suppressedByLockedSpec: null,
  };
}

function locatorToString(locator) {
  if (!locator) return null;
  switch (locator.kind) {
    case 'role':   return `role=${locator.role}${locator.name ? `[name="${locator.name}"]` : ''}`;
    case 'label':  return `label="${locator.text}"`;
    case 'testid': return `[data-testid="${locator.id}"]`;
    case 'css':    return locator.selector;
    default:       return JSON.stringify(locator);
  }
}

function appliesToCurrent(appliesTo, context) {
  if (!appliesTo) return true;   // unrestricted surfaces always apply
  if (appliesTo.routePattern && context.currentRoute) {
    let re;
    try { re = new RegExp(appliesTo.routePattern); }
    catch { re = null; }
    if (re && !re.test(context.currentRoute)) return false;
  }
  if (Array.isArray(appliesTo.journeyStepLabels) && context.currentStepLabel) {
    if (!appliesTo.journeyStepLabels.includes(context.currentStepLabel)) return false;
  }
  if (Array.isArray(appliesTo.requiresState) && Array.isArray(context.activeStateTags)) {
    const active = new Set(context.activeStateTags);
    for (const t of appliesTo.requiresState) {
      if (!active.has(t)) return false;
    }
  }
  return true;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

// Test-internal exports.
export const _internals = Object.freeze({
  SEVERITY_RANK,
  clampToFloor,
  locatorToString,
  appliesToCurrent,
  deepEqual,
});

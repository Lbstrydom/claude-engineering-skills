/**
 * @fileoverview Pure bootstrap drafter (plan v1.2 §4a). Given the live nav
 * evidence (each occurrence carries `containerCandidates` from the collector),
 * draft a `navLayers` map + `observedTargets` so a new user edits a smart
 * baseline instead of a blank page. v1.2: propose CONTAINERS holding ≥2 distinct
 * nav targets — never single-button ids — classified sticky-aware. Deterministic;
 * NO LLM (cut for egress safety — §2.4). Zero browser.
 *
 * @module scripts/lib/nav/bootstrap-draft
 */

// drawer/hamburger are NOT force-classified secondary (R2-M3) — a hamburger
// drawer can be the primary nav on mobile; let the prominence rule decide.
const SECONDARY_RE = /sub-?tabs?|secondary|breadcrumb/i;
const PRIMARY_RE = /primary|bottom-?nav|main-?nav|navbar|tabbar/i;
// A disclosure (hamburger/drawer/off-canvas menu) is a TOGGLE, not the
// always-visible bar — it loses to a sticky/fixed multi-target bar for `primary`
// (#5: a role-less JS-built sticky bottom bar must outrank a hamburger toggle), but
// can still be primary when it's the ONLY nav (mobile-only hamburger).
const DISCLOSURE_RE = /hamburger|drawer|burger|menu-?toggle|off-?canvas/i;

/**
 * Choose the capture-honesty warning for a `--bootstrap --from-url` draft (field-test
 * #3/#4). An EMPTY visible nav-ish container is the precise auth-gated fingerprint —
 * warn specifically, and do so REGARDLESS of `--storage-state` (an expired/invalid
 * auth.json yields the same empty shell, which the bare `!storageState` check misses).
 * Otherwise, if no auth state was supplied at all, warn generically. Else stay silent.
 * @param {{emptyNavShells?: string[], hasStorageState?: boolean}} args
 * @returns {string|null} the warning body (caller prefixes/streams it), or null
 */
export function buildDraftCaptureWarning({ emptyNavShells = [], hasStorageState = false, mode = 'bootstrap' } = {}) {
  // `mode` selects the REMEDY, never the decision. Both callers share one
  // empty-shell judgement; only the command you'd re-run differs, and emitting
  // `--bootstrap --from-url` advice on a `--verify` run would send the operator
  // to redraft a contract they did not ask to change.
  const reRun = mode === 'verify'
    ? '--verify <url> --storage-state <auth.json>'
    : '--bootstrap --from-url <url> --storage-state <auth.json> --force';
  if (Array.isArray(emptyNavShells) && emptyNavShells.length) {
    return `nav container(s) rendered EMPTY (0 items): ${emptyNavShells.join(', ')} — likely auth-gated or not-yet-engaged, `
      + `so the primary nav layer may be mis-detected. Re-run authenticated with `
      + `\`${reRun}\` (refresh the token if one was already passed).`;
  }
  if (!hasStorageState) {
    return mode === 'verify'
      ? `ran WITHOUT --storage-state: if this app is auth-gated, only its logged-out shell was `
        + `reconciled, so the scorecard describes the wrong surface. Re-run \`${reRun}\` authenticated.`
      : `drafted WITHOUT --storage-state: if this app is auth-gated, its primary nav `
        + `may not have rendered, so the drafted navLayers can be wrong (review before committing). `
        + `Re-run \`${reRun}\` authenticated.`;
  }
  return null;
}

/**
 * Compose the single capture verdict for a `--verify` run.
 *
 * `authLiveness` and `emptyNavShells` are INDEPENDENT signals that can fire
 * together and contradict each other, so there is exactly one place that ranks
 * them. Precedence: **dead > unverified > empty-shells > no-auth-state**, and
 * at most ONE primary warning is emitted — a dead session *explains* empty
 * shells, so presenting both as co-equal causes sends the operator after the
 * wrong one.
 *
 * **`degrade` is the only field that gates suppression — never `status !==
 * 'live'`.** Only `auth-dead` and `auth-unverified` degrade: those are the two
 * states where authentication was ATTEMPTED and cannot be vouched for. An
 * ordinary unauthenticated run is *honestly unauthenticated*, not unverified,
 * so it keeps authoritative verdicts and gets an advisory line only. (An
 * earlier design degraded on `status !== 'live'`, which would have suppressed
 * findings on every normal no-auth run.)
 *
 * @param {{authLiveness?: 'live'|'dead'|'unverified'|'n/a', emptyNavShells?: string[], hasStorageState?: boolean}} a
 * @returns {{status: string, degrade: boolean, warnings: string[]}}
 */
export function composeCaptureVerdict({ authLiveness = 'n/a', emptyNavShells = [], hasStorageState = false } = {}) {
  const shells = Array.isArray(emptyNavShells) ? emptyNavShells : [];
  // Domain invariant: `n/a` ⟺ no --storage-state was supplied. Enforced here
  // rather than trusted, because the failure it prevents is exactly the one
  // this feature exists to stop — an implementation that leaves liveness at its
  // `n/a` initial value on the no-sentinel path would emit AUTHORITATIVE
  // findings from a capture it never verified. Loud beats silently `live`.
  if (authLiveness === 'n/a' && hasStorageState) {
    throw new Error(
      'composeCaptureVerdict: authLiveness "n/a" is impossible with --storage-state — ' +
      'an authenticated run must resolve to live | dead | unverified. This is a wiring bug ' +
      'in the caller, not a user error.',
    );
  }

  const detail = shells.length ? [`empty nav container(s): ${shells.join(', ')}`] : [];

  if (authLiveness === 'dead') {
    return {
      status: 'auth-dead', degrade: true,
      warnings: [
        'AUTH SESSION DEAD — the declared authSentinel was not observed in any captured state. '
        + 'The run reconciled the LOGGED-OUT shell; scorecard and live findings are degraded to '
        + '`unverified`. Refresh the token in your --storage-state file and re-run.',
        ...detail,
      ],
    };
  }
  if (authLiveness === 'unverified') {
    return {
      status: 'auth-unverified', degrade: true,
      warnings: [
        'AUTH UNVERIFIED — --storage-state was supplied but the session could not be confirmed '
        + '(no authSentinel declared in nav-contract.json, or its selector failed to evaluate). '
        + 'Verdicts are degraded to `unverified`: declare an authSentinel to upgrade this run '
        + 'from "we do not know" to "we checked".',
        ...detail,
      ],
    };
  }
  if (shells.length) {
    return {
      status: authLiveness === 'live' ? 'live-empty-shells' : 'shells-empty',
      degrade: false,
      warnings: [buildDraftCaptureWarning({ emptyNavShells: shells, hasStorageState, mode: 'verify' })].filter(Boolean),
    };
  }
  if (!hasStorageState) {
    return {
      status: 'no-auth-state', degrade: false,
      warnings: [buildDraftCaptureWarning({ emptyNavShells: [], hasStorageState, mode: 'verify' })].filter(Boolean),
    };
  }
  return { status: 'live', degrade: false, warnings: [] };
}

/** Prominence sort: sticky/fixed first, then more distinct targets, then earliest
 *  document order. The always-visible bar with the most links wins. */
function byProminence(a, b) {
  return (Number(b.sticky) - Number(a.sticky)) || (b.targets.size - a.targets.size) || (a.order - b.order);
}

/**
 * Draft a navLayers contract from live evidence (plan §4a prominence). Groups
 * occurrences by their `containerCandidates`, keeps only containers holding ≥2
 * distinct nav targets, then classifies: sticky/fixed OR primary-word →
 * `primary`; secondary-word → `secondary`; otherwise the earliest-document-order
 * remaining container → `primary`, the rest → `secondary`.
 *
 * @param {Array<{target, containerCandidates?: Array<{selector,sticky}>}>} liveEvidence
 * @returns {{navLayers: {primary: string[], secondary: string[]}, observedTargets: string[]}}
 */
export function draftContractFromLive(liveEvidence) {
  // selector → {selector, sticky, targets:Set<string>, order}
  const containers = new Map();
  const observed = new Set();
  let order = 0;
  for (const e of liveEvidence || []) {
    if (e?.target) observed.add(e.target);
    for (const cand of e?.containerCandidates || []) {
      const sel = cand?.selector;
      if (!sel) continue;
      let c = containers.get(sel);
      if (!c) { c = { selector: sel, sticky: false, targets: new Set(), order: order++ }; containers.set(sel, c); }
      if (cand.sticky) c.sticky = true;
      // `<dynamic>` is an unresolved placeholder, not a distinct nav child — it
      // must NOT count toward the ≥2-targets gate (R1-M).
      if (e.target && e.target !== '<dynamic>') c.targets.add(e.target);
    }
  }
  // Keep only containers holding ≥2 distinct nav targets (drop single-button selectors).
  const multi = [...containers.values()].filter((c) => c.targets.size >= 2).sort((a, b) => a.order - b.order);
  // Bars (always-visible nav) vs disclosures (hamburger/drawer toggles). A bar
  // outranks a disclosure for `primary` (#5).
  const bars = multi.filter((c) => !DISCLOSURE_RE.test(c.selector));
  const disclosures = multi.filter((c) => DISCLOSURE_RE.test(c.selector));

  const primary = [];
  const secondary = [];
  const undecided = [];
  for (const c of bars) {
    if (c.sticky || PRIMARY_RE.test(c.selector)) primary.push(c.selector);
    else if (SECONDARY_RE.test(c.selector)) secondary.push(c.selector);
    else undecided.push(c);
  }
  // No explicit primary bar → promote the MOST PROMINENT bar (sticky beats
  // non-sticky, then most targets, then earliest order) — so a role-less sticky
  // bottom bar becomes primary over a hamburger (#5).
  if (primary.length === 0) {
    const pool = (undecided.length ? undecided : bars).slice().sort(byProminence);
    const best = pool[0];
    if (best) {
      primary.push(best.selector);
      const i = undecided.indexOf(best);
      if (i >= 0) undecided.splice(i, 1);
    }
  }
  for (const c of undecided) secondary.push(c.selector);
  // Disclosures → secondary, UNLESS there is no bar-primary at all (mobile-only
  // hamburger nav) — then the most-prominent disclosure becomes primary.
  if (primary.length === 0 && disclosures.length) {
    const best = disclosures.slice().sort(byProminence)[0];
    primary.push(best.selector);
    for (const c of disclosures) if (c.selector !== best.selector) secondary.push(c.selector);
  } else {
    for (const c of disclosures) secondary.push(c.selector);
  }

  // A bar promoted from `bars` (the all-secondary fallback) may already sit in
  // `secondary` — a container must never appear in BOTH layers (audit MED), so
  // primary wins and secondary excludes it.
  const primaryFinal = dedupe(primary);
  return {
    navLayers: {
      primary: primaryFinal,
      secondary: dedupe(secondary).filter((s) => !primaryFinal.includes(s)),
    },
    observedTargets: [...observed].filter((t) => t && t !== '<dynamic>').sort(),
  };
}

function dedupe(a) { return [...new Set(a)]; }

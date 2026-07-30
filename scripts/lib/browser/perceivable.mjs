/**
 * @fileoverview Canonical `isPerceivable` predicate — the single definition of
 * "is this element RENDERED in the currently captured state?".
 *
 * WHY THIS MODULE EXISTS (plan D20, `docs/plans/skill-shadow-and-capture-honesty.md`).
 * Two skills in two domains need the same answer:
 *
 * - **`/click-test`** caps a finding's severity when its element is not
 *   perceivable, so a `<input type="file" hidden>` stops being reported P0.
 * - **`/nav-audit --verify`** qualifies an `authSentinel` match, so a stale
 *   `opacity:0` account-menu template cannot certify an expired session as live.
 *
 * The nav-audit consumer is the reason this is a module at all. Before it
 * existed the predicate lived only inside the fenced scanner block in
 * `skills/click-test/references/dom-scanner.md`, and `scripts/lib/nav/verify.mjs`
 * had no way to reach a function that exists only inside a Markdown fence — the
 * two options were copy-pasting the source (two definitions of "rendered",
 * guaranteed to drift) or parsing Markdown at runtime (absurd). Hence one
 * canonical string, injected into the page by both consumers.
 *
 * **The SCANNER is deliberately NOT extracted.** `/click-test`'s scanner *is*
 * its reference document — that is the skill's progressive-disclosure design.
 * Only this ~20-line predicate moved, because only it gained a second consumer.
 *
 * ## Why a source STRING and not a function
 *
 * Both consumers run the predicate **inside the browser**, via
 * `page.evaluate` / `browser_evaluate`. A function value cannot cross that
 * boundary with its body intact, so the transportable form is source text.
 * There is deliberately **no Node-callable export**: it would need a DOM
 * (`getComputedStyle`, `getBoundingClientRect`), this repo has no jsdom /
 * linkedom / happy-dom dependency, and an export that cannot run is dead code
 * that reads like coverage. The predicate is exercised in a real browser by
 * `tests/click-test-perceivability.test.mjs`.
 *
 * ## Semantics (plan D10) — read before editing
 *
 * Answers exactly one question: *is this element rendered in the current
 * captured state?* It is NOT a user-perceivability or accessibility-tree oracle.
 *
 * - **State-relative.** An element behind a closed modal is "not perceivable in
 *   THIS captured state", not "never perceivable" — `/click-test --with-modals`
 *   re-scans after opening, and `/nav-audit`'s activation pass opens collapsed
 *   menus. Callers must phrase findings accordingly.
 * - **Clipped-but-rendered is TRUE.** Scrolled out of the viewport, or clipped
 *   by `overflow:hidden`, still counts as rendered. This is why
 *   `contentVisibilityAuto` is NOT passed to `checkVisibility()`: it reports an
 *   offscreen `content-visibility:auto` subtree as invisible because rendering
 *   is *skipped*, which is a viewport-state answer and would contradict this
 *   rule. `content-visibility:hidden` (an authored intent to hide) IS honoured.
 * - **`[inert]` is deliberately NOT considered — corrected 2026-07-30 by a live
 *   run.** `inert` is an *interactivity* property, not a visibility one: an
 *   inert element is still painted and the user can still see it. Treating it as
 *   non-perceivable suppressed **329 of 331** findings on a real app, because the
 *   app had a modal open and marked `<header>`/`<main>` inert — the standard
 *   background-inerting pattern. Both were `display:flex`/`block`,
 *   `visibility:visible`, `opacity:1`, with 1248x90 and 1248x662 rects.
 *
 *   That is a far worse failure than the noise this predicate was written to
 *   remove: it silently hides real, visible defects. A reviewer correctly noted
 *   that `checkVisibility()` ignores `inert` while the fallback walk honoured it,
 *   so the branches disagreed — but the right way to agree was to drop the check,
 *   not to add it. Both branches now answer exactly "is this painted?".
 * - **Tri-state, because "unknown" is not "perceivable".** Returns `true`
 *   (rendered), `false` (not rendered) or **`null` (could not establish)**.
 *   An earlier version returned `true` on any thrown exception, which converted
 *   an inability to evaluate into a positive verdict — a finding then kept its
 *   P0 on the strength of an assertion that never ran. Callers must treat `null`
 *   as *unknown*: do NOT cap severity (that would fail closed and disable the
 *   signal), but DO surface it, so a broken predicate is visible instead of
 *   silently green. This is the same distinction the rest of this bundle draws
 *   between `clean` and `unverifiable`.
 *
 * @module scripts/lib/browser/perceivable
 */

/** The identifier the injected function binds to, in both consumers. */
export const PERCEIVABLE_FN_NAME = '__isPerceivable';

/**
 * The canonical predicate, as injectable source text.
 *
 * **This string is the single source of truth.** `skills/click-test/references/dom-scanner.md`
 * embeds it verbatim inside its fenced scanner block (it must stay one
 * self-contained pasteable block), and `tests/click-test-perceivability.test.mjs`
 * asserts the fence still contains it — so an edit here that is not mirrored
 * there fails the suite. Compare after whitespace normalisation, never raw: the
 * fence carries the block's own indentation, and `.gitattributes` pins LF while
 * checkouts may hold CRLF.
 *
 * @type {string}
 */
export const PERCEIVABLE_SOURCE = `function ${PERCEIVABLE_FN_NAME}(el) {
  // Tri-state: true = rendered, false = not rendered, null = could not establish.
  // null is NOT "perceivable" — see the module docs.
  if (!el || el.nodeType !== 1 || !el.isConnected) return false;
  try {
    // Zero-size subsumes the old rect.width===0 guard. NOTE: visibility:hidden
    // and opacity:0 keep a real box, so this alone is not sufficient.
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    if (typeof el.checkVisibility === 'function') {
      // contentVisibilityAuto deliberately NOT passed — see module docs.
      return el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true });
    }
    // Fallback for engines without checkVisibility: walk self + ancestors.
    // Required — a visible child of a hidden parent is not rendered, and
    // offsetParent gets this wrong for position:fixed.
    let node = el;
    while (node && node.nodeType === 1) {
      const cs = getComputedStyle(node);
      if (cs.display === 'none') return false;
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
      if (parseFloat(cs.opacity) === 0) return false;
      if (cs.contentVisibility === 'hidden') return false;
      if (node.hasAttribute('hidden')) return false;   // maps to display:none
      node = node.parentElement;
    }
    return true;
  } catch (e) {
    // Could not establish rendered state. Returning true here would assert a
    // verdict we did not earn; returning false would cap every severity and
    // disable the signal. Report UNKNOWN and let the caller surface it.
    return null;
  }
}`;

/**
 * Normalise source text for drift comparison: LF line endings, and every line
 * stripped of leading/trailing whitespace.
 *
 * Exact byte-comparison is not usable here, and the reason is structural rather
 * than cosmetic: the Markdown fence embeds this predicate **indented inside**
 * the scanner's arrow-function body, so the embedded text can never be
 * byte-equal to the canonical string that starts at column 0.
 *
 * A *common-prefix dedent* is also not enough — tried first, and it fails:
 * dedenting the whole scanner fence strips by the minimum indent across the
 * WHOLE block, which is 0 (its `() => {` line), leaving the embedded predicate
 * at depth 2 while the needle sits at depth 0. So normalisation must be
 * indentation-**agnostic**, not indentation-relative.
 *
 * Trade-off, accepted deliberately: this cannot detect an indentation-only
 * change. That is the point — indentation carries no meaning here, while any
 * changed, added or removed *statement* still fails the check, which is the
 * drift worth catching. CRLF normalisation is load-bearing on Windows:
 * `.gitattributes` pins LF, but a working tree may hold CRLF.
 *
 * @param {string} src
 * @returns {string}
 */
export function normaliseForDriftCheck(src) {
  return String(src)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .join('\n')
    .trim();
}

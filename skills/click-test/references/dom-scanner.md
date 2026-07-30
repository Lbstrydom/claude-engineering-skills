---
summary: The full browser_evaluate scanner JS — every assertion's implementation, selector-stringifier helpers, severity mapping.
---

# DOM Scanner — Full Implementation

Paste this into `browser_evaluate` as the function body. Returns a single
`ClickTestScanResult` object (schema in SKILL.md Phase 4).

```js
() => {
  const findings = [];
  const INTERACTIVE_SEL = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="link"]';

  // ---------------------------------------------------------------------
  // selector stringifier — best-effort stable CSS path
  // ---------------------------------------------------------------------
  const sel = (el) => {
    if (!el) return null;
    if (el.id && !/\s/.test(el.id)) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let s = node.localName;
      if (node.classList && node.classList.length) {
        s += '.' + [...node.classList].slice(0, 2).map(CSS.escape).join('.');
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(c => c.localName === node.localName);
        if (siblings.length > 1) {
          s += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
      }
      parts.unshift(s);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  const snippet = (el) => {
    const s = el.outerHTML || '';
    return s.length > 200 ? s.slice(0, 197) + '...' : s;
  };

  // ---------------------------------------------------------------------
  // perceivability — "is this element RENDERED in the state we captured?"
  //
  // CANONICAL SOURCE: scripts/lib/browser/perceivable.mjs (PERCEIVABLE_SOURCE).
  // /nav-audit --verify injects the SAME function to qualify its authSentinel,
  // so this copy is drift-checked by tests/click-test-perceivability.test.mjs.
  // Edit the module, then mirror here — never the other way round.
  // ---------------------------------------------------------------------
  function __isPerceivable(el) {
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
  }

  // Severity cap for non-perceivable elements. DEMOTE, never drop: a hidden
  // element may become visible (--with-modals re-scans opened surfaces), so
  // dropping destroys signal. Capping stops a `<input type="file" hidden>`
  // from being reported P0 while keeping the finding available.
  const NON_PERCEIVABLE_CAP = 'P3';

  const push = (kind, severity, el, detail) => {
    // ONE call site — every kind gets the tag, and no future check can forget it.
    const perceivable = __isPerceivable(el);
    // Only a DEFINITE false caps. `null` (could not establish) keeps the
    // declared severity but is flagged, so an unevaluated predicate surfaces
    // instead of silently reading as "perceivable".
    const capped = perceivable === false;
    const unknown = perceivable === null;
    let note = '';
    if (capped) {
      note = ` [not perceivable in the captured state — severity capped from ${severity} to ${NON_PERCEIVABLE_CAP}; re-scan with --with-modals if this lives behind a modal/menu]`;
    } else if (unknown) {
      note = ' [perceivability UNKNOWN — the predicate could not evaluate this element; severity is NOT capped, verify manually]';
    }
    findings.push({
      kind,
      severity: capped ? NON_PERCEIVABLE_CAP : severity,
      declaredSeverity: severity,
      perceivable,                 // true | false | null(unknown)
      perceivabilityUnknown: unknown,
      selector: sel(el),
      snippet: snippet(el),
      detail: detail + note,
    });
  };

  // ---------------------------------------------------------------------
  // accessible name computation (subset of WAI-ARIA naming spec)
  // ---------------------------------------------------------------------
  const accessibleName = (el) => {
    if (el.getAttribute('aria-label')?.trim()) return el.getAttribute('aria-label').trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const refs = labelledBy.split(/\s+/).map(id => document.getElementById(id));
      const text = refs.filter(Boolean).map(r => r.textContent.trim()).join(' ');
      if (text) return text;
    }
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label?.textContent.trim()) return label.textContent.trim();
    }
    const wrappingLabel = el.closest('label');
    if (wrappingLabel?.textContent.trim()) return wrappingLabel.textContent.trim();
    if (el.localName === 'button' && el.textContent.trim()) return el.textContent.trim();
    if (el.localName === 'a' && el.textContent.trim()) return el.textContent.trim();
    const title = el.getAttribute('title');
    if (title?.trim()) return title.trim();
    const placeholder = el.getAttribute('placeholder');
    if (placeholder?.trim()) return `[placeholder] ${placeholder.trim()}`;
    return null;
  };

  // ---------------------------------------------------------------------
  // 1. duplicate IDs (P0) — breaks form association + React reconciliation
  // ---------------------------------------------------------------------
  const idMap = new Map();
  for (const el of document.querySelectorAll('[id]')) {
    const id = el.id;
    if (!id) continue;
    if (!idMap.has(id)) idMap.set(id, []);
    idMap.get(id).push(el);
  }
  for (const [id, els] of idMap) {
    if (els.length > 1) {
      for (const el of els) {
        push('duplicate-id', 'P0', el,
          `id="${id}" repeats ${els.length}x — first occurrence at ${sel(els[0])}`);
      }
    }
  }

  // ---------------------------------------------------------------------
  // 2. orphan <label for="X"> (P0)
  // ---------------------------------------------------------------------
  for (const label of document.querySelectorAll('label[for]')) {
    const forId = label.getAttribute('for');
    if (!forId) continue;
    const target = document.getElementById(forId);
    if (!target) {
      push('orphan-label', 'P0', label,
        `label[for="${forId}"] has no matching input — clicking the label does nothing`);
    }
  }

  // ---------------------------------------------------------------------
  // 3. inputs / textareas / selects with no accessible name (P0)
  // ---------------------------------------------------------------------
  for (const el of document.querySelectorAll('input, textarea, select')) {
    if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') continue;
    if (!accessibleName(el)) {
      push('input-no-name', 'P0', el,
        `<${el.localName}${el.type ? ` type="${el.type}"` : ''}> has no label, aria-label, aria-labelledby, wrapping <label>, or placeholder`);
    }
  }

  // ---------------------------------------------------------------------
  // 4a. buttons with no accessible name (P0) — separate kind from links
  // ---------------------------------------------------------------------
  for (const el of document.querySelectorAll('button, [role="button"]')) {
    if (!accessibleName(el)) {
      push('button-no-name', 'P0', el,
        'Button has no text content, aria-label, or aria-labelledby — screen readers announce as "button" with no context');
    }
  }

  // ---------------------------------------------------------------------
  // 4b. links — empty href (P1) AND missing accessible name (P1 — own kind)
  // ---------------------------------------------------------------------
  for (const el of document.querySelectorAll('a[href]')) {
    const href = el.getAttribute('href');
    if (href === '#' || href === '' || /^javascript:/i.test(href)) {
      push('empty-link', 'P1', el,
        `<a href="${href}"> is non-functional — use a <button> if it triggers JS, or fix the href`);
    }
    if (!accessibleName(el)) {
      push('link-no-name', 'P1', el,
        'Link has no text content or aria-label');
    }
  }

  // ---------------------------------------------------------------------
  // 5. duplicate aria-label within same component region (P2 — high FP rate)
  //    Only fires when duplicates share role AND closest list/grid/table/form ancestor.
  //    Card/grid layouts legitimately share labels disambiguated by surrounding text;
  //    the region-scoping kills most of those false positives while keeping the
  //    real signal (e.g. two "Submit" buttons in the same <form>).
  // ---------------------------------------------------------------------
  const REGION_SELECTOR = '[role="list"], [role="grid"], [role="listbox"], [role="menu"], table, form, [role="dialog"], main';
  const regionOf = (el) => el.closest(REGION_SELECTOR) || document.body;
  const roleOf = (el) => el.getAttribute('role') || el.localName;

  const labelRegionMap = new Map(); // key = `${label}|${role}|${regionId}` → [els]
  let regionCounter = 0;
  const regionIds = new WeakMap();
  const regionId = (region) => {
    if (!regionIds.has(region)) regionIds.set(region, ++regionCounter);
    return regionIds.get(region);
  };

  for (const el of document.querySelectorAll('[aria-label]')) {
    if (!el.matches('button, a, input, select, textarea, [role="button"], [role="link"], [tabindex]')) continue;
    const label = el.getAttribute('aria-label').trim();
    if (!label) continue;
    const key = `${label}|${roleOf(el)}|${regionId(regionOf(el))}`;
    if (!labelRegionMap.has(key)) labelRegionMap.set(key, []);
    labelRegionMap.get(key).push(el);
  }
  for (const [key, els] of labelRegionMap) {
    if (els.length > 1) {
      const [label, role] = key.split('|');
      for (const el of els) {
        push('duplicate-aria-label', 'P2', el,
          `aria-label="${label}" used ${els.length}x on <${role}> within the same component region — screen reader users can't distinguish them. (Note: this rule has high false-positive rate; region-scoped to reduce noise — verify the duplicates are genuinely ambiguous before fixing.)`);
      }
    }
  }

  // ---------------------------------------------------------------------
  // 6. aria-hidden on focusable element (P1) — focus into a hidden region
  // ---------------------------------------------------------------------
  for (const hidden of document.querySelectorAll('[aria-hidden="true"]')) {
    const focusable = hidden.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
    for (const el of focusable) {
      push('aria-hidden-focusable', 'P1', el,
        'Focusable element inside aria-hidden="true" subtree — keyboard users land in an "invisible" region');
    }
  }

  // ---------------------------------------------------------------------
  // 7. heading hierarchy skips (P2)
  // ---------------------------------------------------------------------
  const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')];
  let lastLevel = 0;
  for (const h of headings) {
    const level = parseInt(h.localName.slice(1), 10);
    if (lastLevel && level > lastLevel + 1) {
      push('heading-skip', 'P2', h,
        `Heading jumps from h${lastLevel} to h${level} — skip one or more levels`);
    }
    lastLevel = level;
  }
  const h1Count = document.querySelectorAll('h1').length;
  if (h1Count > 1) {
    for (const h of document.querySelectorAll('h1')) {
      push('heading-skip', 'P2', h,
        `Page has ${h1Count} <h1> elements — should be exactly one`);
    }
  }

  // ---------------------------------------------------------------------
  // 8. img without alt (P2) — decorative needs alt=""
  // ---------------------------------------------------------------------
  for (const img of document.querySelectorAll('img')) {
    if (!img.hasAttribute('alt')) {
      push('img-no-alt', 'P2', img,
        '<img> missing alt attribute — decorative images need alt="", meaningful ones need descriptive text');
    }
  }

  // ---------------------------------------------------------------------
  // 9. small touch targets (P2) — interactive < 24x24 CSS px (WCAG 2.5.8)
  // ---------------------------------------------------------------------
  for (const el of document.querySelectorAll('button, a[href], input:not([type="hidden"]), [role="button"], [role="link"]')) {
    const rect = el.getBoundingClientRect();
    // Zero-size is handled by __isPerceivable (which push() applies to every
    // finding), but it is still skipped HERE rather than emitted-and-capped:
    // a 0×0 element is not a *small* touch target, it is an absent one, so the
    // finding would be wrong rather than merely low-severity.
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.width < 24 || rect.height < 24) {
      push('small-touch-target', 'P2', el,
        `Interactive element is ${Math.round(rect.width)}×${Math.round(rect.height)}px — WCAG 2.5.8 minimum is 24×24`);
    }
  }

  // ---------------------------------------------------------------------
  // 10. form fields without name attribute (P1) — won't submit
  // ---------------------------------------------------------------------
  for (const el of document.querySelectorAll('form input, form textarea, form select')) {
    if (el.type === 'submit' || el.type === 'button' || el.type === 'reset') continue;
    if (!el.hasAttribute('name') || !el.getAttribute('name')) {
      push('form-field-no-name', 'P1', el,
        `<${el.localName}> in <form> has no name attribute — value won't be submitted`);
    }
  }

  // ---------------------------------------------------------------------
  // 11. tabindex > 0 (P2) — breaks natural tab order
  // ---------------------------------------------------------------------
  for (const el of document.querySelectorAll('[tabindex]')) {
    const ti = parseInt(el.getAttribute('tabindex'), 10);
    if (ti > 0) {
      push('positive-tabindex', 'P2', el,
        `tabindex="${ti}" — positive values break natural tab order. Use tabindex="0" or restructure DOM`);
    }
  }

  // ---------------------------------------------------------------------
  // Coverage gaps — shadow roots + iframes the scanner can't traverse in v1
  // ---------------------------------------------------------------------
  let shadowGapCount = 0;
  for (const el of document.querySelectorAll('*')) {
    if (el.shadowRoot) shadowGapCount++;
  }
  const iframeGapCount = document.querySelectorAll('iframe').length;

  // ---------------------------------------------------------------------
  // Return the canonical ClickTestScanResult shape
  // ---------------------------------------------------------------------
  return {
    schemaVersion: 1,
    routeUrl: location.href,
    elementsScanned: document.querySelectorAll('*').length,
    interactiveElementsScanned: document.querySelectorAll(INTERACTIVE_SEL).length,
    findings,
    shadowGapCount,
    iframeGapCount,
  };
};
```

## Scanner output

Returns one `ClickTestScanResult` object — see SKILL.md Phase 4 for the
canonical schema. The runner validates the shape (Zod) before consuming.
Caller adds `route`, `coverageStatus`, and `via` fields to each finding
when aggregating across routes / dynamic surfaces.

## Performance notes

- Whole-doc query selectors are O(n) per assertion; total scan cost is
  ~O(n × assertions) ≈ <50ms even for 5000-node DOMs.
- The accessible-name function does multiple DOM lookups per element —
  cache it if you extend the scanner to run repeatedly on the same DOM.
- `getBoundingClientRect()` forces layout — kept to the touch-target check
  only. Don't add layout-reading assertions casually.

## What this scanner does NOT cover (deliberate gaps)

| Gap | Why omitted | Where to catch it |
|---|---|---|
| Colour contrast | Requires computed-style colour math; better handled by axe-core | `/persona-test` (visual judgement) or dedicated axe run |
| Keyboard trap detection | Requires actual tab traversal, not static scan | `/persona-test` with focus journey, or a Playwright tab-walker |
| Focus visible | Requires `:focus-visible` style probe per element | `/persona-test` (persona uses keyboard) |
| Reading order | Requires AT simulator | Out of scope for any static skill |
| Live-region politeness | Requires mutation observation over time | `/persona-test` consistency mode |
| **Open shadow DOM** | Traversal is feasible but requires recursive descent into `el.shadowRoot`; deferred to v2 | Mark as coverage gap: any element with `shadowRoot` increments `shadowGapCount` in the report |
| **Closed shadow DOM** | Not accessible from JS by design | Cannot scan; report as coverage gap |
| **Same-origin iframes** | Traversal feasible via `iframe.contentDocument`; deferred to v2 | Mark `iframeGapCount` per route |
| **Cross-origin iframes** | Browser security blocks DOM access | Cannot scan; report as coverage gap |
| ~~Inert / `hidden` subtrees~~ | **CLOSED 2026-07-30** — no longer a gap. `__isPerceivable` (applied in `push()` to every finding) detects `display:none`, `visibility:hidden`, `opacity:0`, `content-visibility:hidden`, `[inert]`, detached and zero-size elements. | Such findings are **demoted to P3** and tagged `perceivable:false`, not dropped — they may become perceivable (re-scan with `--with-modals`). |

When the gap matters, run the appropriate sibling skill alongside.

**Reporting coverage gaps**: `shadowGapCount` and `iframeGapCount` are always
populated on every scan result. The runner surfaces them in the Phase 6
report's per-route line when non-zero:

```
/cellar — scanned — 312 elements — 8 findings — coverage gaps: 2 shadow / 1 iframe
```

No separate meta-finding `kind` is emitted — the counts are part of the
canonical result schema, not the findings array.

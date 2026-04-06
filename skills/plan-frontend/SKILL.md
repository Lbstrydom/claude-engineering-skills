---
name: plan-frontend
description: |
  Frontend UX and implementation planning with design and engineering principles. Use when the
  user asks to plan, design, or build frontend features — including UI components, pages, layouts,
  user flows, modals, forms, or visual changes. Also auto-invoke when detecting frontend planning
  context such as: "design the UI for", "plan the user flow", "add a new view", "build a component",
  "improve the UX of", "create a form for", or "redesign the layout".
  Accepts arguments describing the task: /plan-frontend redesign the cellar grid view
---

# Frontend UX & Implementation Planner

You are entering frontend planning mode. This process ensures every UI decision is grounded
in UX principles AND technically sound. Do not skip phases — good UI requires both design
thinking and implementation rigour.

## Phase 0 — Repo Stack Detection

Before Phase 1, detect the repo's primary language(s):

- **JS/TS**: `package.json` present with `dependencies` or `devDependencies`
- **Python**: `pyproject.toml`, `requirements.txt`, `Pipfile`, `setup.py`, or `uv.lock` present
- **Mixed**: both present (e.g. Python backend + TS frontend)
- **Unknown**: neither -- proceed with universal principles only, skip stack-specific sections

**Mixed-stack handling**: when mixed, apply the profile matching the **files involved in the current task**:

- Task's cited files are `.py` / `.html` (Jinja/Django templates) -- apply Python FE profile
- Task's cited files are `.ts`/`.js`/`.tsx`/`.jsx`/`.vue`/`.svelte` -- apply JS/TS profile
- Task's cited files span both -- apply BOTH, each principle scoped to its language

When Python is detected, also identify the **framework**:

- **Django**: `django` in deps, or `DJANGO_SETTINGS_MODULE`, or `manage.py` present
- **Flask**: `flask` in deps, or `Flask()` import
- **FastAPI**: `fastapi` in deps (typically API-only, but may have Jinja templates)
- **None/custom**: no framework detected -- apply only universal Python FE principles

Based on detection, reference the appropriate stack profile below.

---

### Python Frontend Profile

Focus on server-rendered frontends (Jinja, Django templates, HTMX) -- the dominant Python "frontend" pattern.

**File-layout expectations**: `templates/`, `static/`, optional `frontend/` for separate JS build

**Python FE principle checks**:

- `[generic]` Template inheritance -- base template with blocks, child templates extend
- `[generic]` Static asset versioning -- cache-busting via hashed filenames or query params
- `[generic]` Server-side form validation -- never trust client-only validation
- `[generic]` Context data discipline -- explicit context dicts, no global state leaking into templates
- `[django]` CSRF on all mutation forms (`{% csrf_token %}`)
- `[django]` Use Django template tags and filters instead of logic in templates
- `[django]` `{% static %}` tag for all asset references (not hardcoded paths)
- `[django,flask]` HTMX progressive enhancement -- server returns HTML fragments, not JSON
- `[django,flask]` No direct ORM access from templates (pass pre-computed data from views)
- `[flask]` Jinja2 autoescaping enabled by default; `|safe` filter requires explicit justification

**Python FE anti-patterns**:
- Logic in templates (conditionals/loops that should be in views/services)
- `|safe` filter without justification (XSS risk)
- Direct ORM access from templates (N+1 queries, separation of concerns)
- Hardcoded asset paths instead of `{% static %}` or `url_for('static', ...)`
- Missing CSRF tokens on POST/PUT/DELETE forms

---

## Phase 1 — Explore the Existing UI

**Understand what exists BEFORE designing anything new.** Study the current frontend
to ensure consistency and reuse.

1. **Audit the current UI**: Read relevant HTML, CSS, and JS files for the area being changed
2. **Map the component landscape**: What UI patterns already exist? (modals, cards, grids, forms, toasts)
3. **Identify the design language**: Current colour palette, typography, spacing, button styles
4. **Trace user flows**: How does the user currently navigate to and through related features?
5. **Find reusable elements**: Existing CSS classes, JS utilities, shared components
6. **Check responsive behaviour**: How does the existing UI handle different screen sizes?
7. **Note pain points**: What feels clunky, inconsistent, or confusing in the current UX?

Do NOT propose designs until you have completed this exploration.

## Phase 2 — Apply UX & Design Principles

Every design decision must be evaluated against these principles. Explicitly cite which
principles drive each choice.

### Gestalt Principles

| # | Principle | Design Question |
|---|-----------|-----------------|
| 1 | **Proximity** | Are related items grouped together? Is whitespace creating clear clusters? |
| 2 | **Similarity** | Do elements that function alike look alike? (Same colour, size, shape) |
| 3 | **Continuity** | Does the eye follow a natural path through the layout? Are alignments clean? |
| 4 | **Closure** | Can the user brain complete implied shapes/groups? Are containers clear? |
| 5 | **Figure-Ground** | Is the focal content clearly distinguishable from the background? |
| 6 | **Common Region** | Are grouped items enclosed in a shared visual boundary? |
| 7 | **Common Fate** | Do elements that change together move/animate together? |

### Interaction & Usability Principles

| # | Principle | Design Question |
|---|-----------|-----------------|
| 8 | **Clear Affordances** | Does each interactive element look clickable/draggable/editable? Can the user tell what to do without instructions? |
| 9 | **User Logic & Flow** | Does the sequence of steps match how the user thinks about the task, not how the code is structured? |
| 10 | **Consistency** | Do similar actions behave the same way everywhere? Same terms, same patterns, same positions? |
| 11 | **Feedback & System Status** | Does the user always know what is happening? Loading indicators, success confirmations, error messages? |
| 12 | **Error Prevention & Recovery** | Can users undo mistakes? Are destructive actions confirmed? Is inline validation present? |
| 13 | **Progressive Disclosure** | Is complexity hidden until needed? Does the UI start simple and reveal depth on demand? |
| 14 | **Recognition Over Recall** | Can users see their options rather than having to remember them? Are hints and labels visible? |

### Cognitive Load & Decision Science

| # | Principle | Design Question |
|---|-----------|-----------------|
| 15 | **Hick's Law** | Are choices kept minimal? Can options be chunked or categorised to reduce overwhelm? |
| 16 | **Fitts's Law** | Are primary actions large and easy to reach? Are destructive actions small and distant from primary paths? |
| 17 | **Visual Hierarchy** | Does typography scale, colour weight, and spacing guide the eye to what matters most first? |
| 18 | **Whitespace & Breathing Room** | Does the layout feel spacious or cramped? Is there enough negative space to reduce cognitive load? |

### Accessibility & Inclusion

| # | Principle | Design Question |
|---|-----------|-----------------|
| 19 | **Keyboard Navigation** | Can every interactive element be reached and operated via keyboard alone? |
| 20 | **Screen Reader Support** | Are ARIA labels, roles, and live regions properly set? Do dynamic updates announce themselves? |
| 21 | **Colour Contrast** | Does text meet WCAG AA contrast ratios (4.5:1 body, 3:1 large)? Is colour never the only indicator? |
| 22 | **Focus Management** | When modals open, does focus move in? When they close, does focus return? Are focus traps correct? |

### State & Resilience

| # | Principle | Design Question |
|---|-----------|-----------------|
| 23 | **State Coverage** | Does every component handle: empty, loading, error, success, and partial states? |
| 24 | **Performance Perception** | Are skeleton screens, optimistic updates, or transitions used to make waits feel shorter? |
| 25 | **Responsive Design** | Does the layout adapt gracefully from mobile to desktop? Are touch targets 44px minimum? |
| 26 | **Dark Pattern Avoidance** | Is the UI honest? No tricks, hidden costs, forced actions, or misleading defaults? |

### Nielsen's 10 Usability Heuristics (Cross-Check)

Use these as a final validation pass on your design:

1. Visibility of system status
2. Match between system and real world
3. User control and freedom
4. Consistency and standards
5. Error prevention
6. Recognition rather than recall
7. Flexibility and efficiency of use
8. Aesthetic and minimalist design
9. Help users recognise, diagnose, and recover from errors
10. Help and documentation

If your design fails any of these, revisit before proceeding.

## Phase 3 — Technical Implementation Principles

UX only works if the implementation is solid. Evaluate the technical approach against
these principles.

### Component Architecture

| # | Principle | Technical Question |
|---|-----------|-------------------|
| 27 | **Single Responsibility** | Does each JS module/function handle one concern? (rendering, state, events, API calls) |
| 28 | **Modularity** | Are components self-contained? Can they be tested and reasoned about independently? |
| 29 | **DRY** | Are shared patterns extracted into utilities? (formatters, validators, DOM helpers) |
| 30 | **No Dead Code** | Are unused event handlers, CSS classes, or DOM builders removed? |
| 31 | **No Hardcoding** | Are strings, selectors, magic numbers, and breakpoints in constants or CSS variables? |

### State Management

| # | Principle | Technical Question |
|---|-----------|-------------------|
| 32 | **State Locality** | Is state owned by the narrowest scope possible? Not everything belongs in global state. |
| 33 | **State Synchronisation** | When data changes, do all views reflecting that data update? No stale displays? |
| 34 | **Optimistic Updates** | Can the UI update immediately and reconcile with the server response? |
| 35 | **URL State** | Should filters, views, or selections be reflected in the URL for shareability and back-button support? |

### Event Handling & DOM

| # | Principle | Technical Question |
|---|-----------|-------------------|
| 36 | **Event Delegation** | Are events on dynamic content delegated to stable parent elements? |
| 37 | **CSP Compliance** | Zero inline handlers (onclick, onchange). All events wired in JS. |
| 38 | **Memory Hygiene** | Are event listeners cleaned up when components are destroyed or replaced? |
| 39 | **Debounce & Throttle** | Are high-frequency events (scroll, resize, input) rate-limited? |

### CSS & Styling

| # | Principle | Technical Question |
|---|-----------|-------------------|
| 40 | **CSS Variables** | Are colours, spacing, and typography in CSS custom properties for consistency? |
| 41 | **BEM or Consistent Naming** | Do class names follow a predictable, collision-free convention? |
| 42 | **No Inline Styles** | Are all styles in CSS files, not element.style or style attributes? |
| 43 | **Specificity Control** | Are selectors flat and predictable? No !important arms races? |

## Phase 4 — Long-Term Sustainability

### UI-Specific Sustainability Questions

- **What if the design system changes?** Are we using CSS variables and reusable classes that
  can be themed or swapped, or are colours/sizes hardcoded throughout?
- **What if we add more items/views?** Does the layout scale gracefully from 5 items to 500?
  From 3 tabs to 12?
- **What if we need to support mobile properly?** Is the component architecture responsive-ready
  or would it require a rewrite?
- **What if accessibility requirements tighten?** Are ARIA attributes, keyboard flows, and
  focus management already in place?
- **Are we creating a reusable pattern?** If this is the first of its kind (e.g., first
  filterable list, first wizard flow), design it as a template other features can follow.

### Anti-Patterns to Flag

- **CSS soup**: Hundreds of one-off classes with no naming convention
- **DOM spaghetti**: innerHTML rebuilding entire sections when one element changed
- **Event listener leaks**: Listeners attached on every render without cleanup
- **God component**: One JS file handling rendering, state, events, API, and validation
- **Design inconsistency**: Same action looks different in different places
- **Invisible state**: Component behaves differently but gives no visual cue about its state

## Phase 5 — Present the Plan

Structure your plan output as follows:

### 1. Current UI Audit
- What exists today (from Phase 1 exploration)
- Existing patterns and design language
- Pain points and inconsistencies identified
- Components and CSS that can be reused

### 2. User Flow & Wireframe
- Step-by-step user journey through the feature
- ASCII wireframe or layout description for key screens/states
- Transitions between states (what triggers the change, what the user sees)

### 3. UX Design Decisions
- Key design choices and **which UX principles drove them**
- How Gestalt principles shaped the layout
- How cognitive load was managed
- Accessibility approach

### 4. Technical Architecture
- Component diagram (which JS modules, how they interact)
- State management approach
- Event handling strategy
- CSS architecture (new classes, variables, responsive approach)

### 5. State Map
For every component, document these states:
- **Empty**: What the user sees with no data
- **Loading**: What the user sees while waiting
- **Error**: What the user sees when something fails
- **Success**: The normal populated view
- **Edge cases**: Overflow, single item, maximum items, long text

### 6. File-Level Plan
For each file to be created or modified:
- **File path** and purpose
- **Key functions/exports** with brief descriptions
- **Dependencies** (what it imports, what imports it)
- **Why this file** (which principle justifies its existence)

### 7. Risk & Trade-off Register
- What trade-offs were made and why
- What could go wrong (browser compat, performance, accessibility gaps)
- What was deliberately deferred

### 8. Testing Strategy
- Visual/manual testing checklist
- Accessibility testing approach (keyboard walkthrough, screen reader, contrast)
- Responsive breakpoints to verify
- Edge case scenarios

## Phase 6 — Persist the Plan

**Save the plan to the repository's `docs/` folder.**

- **File path**: `docs/plans/<descriptive-name>.md` (e.g., `docs/plans/cellar-grid-redesign.md`)
- **Create the `docs/plans/` directory** if it does not exist
- **Include all sections** from Phase 5 in the saved document
- **Add a metadata header** at the top:

```markdown
# Plan: <Feature Name>
- **Date**: <today's date>
- **Status**: Draft | Approved | In Progress | Complete
- **Author**: Claude + <user>
```

- The saved plan becomes the source of truth — refer back to it during implementation

---

## Reminders

- **Explore before designing** — The existing UI is the ground truth
- **Name the principles** — Every design choice should cite which principle(s) it serves
- **Think like the user** — Not like the developer. User mental models differ from code structure
- **Show every state** — Empty, loading, error, success. If you cannot describe all four, the design is incomplete
- **Wireframe before code** — ASCII layouts in the plan prevent expensive rework
- **Consistency beats novelty** — Match existing patterns unless there is a strong UX reason not to
- **Accessibility is not optional** — It is a baseline, not a nice-to-have

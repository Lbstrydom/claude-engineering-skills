---
summary: 17 technical implementation principles — component architecture, state, events, CSS/styling.
---

# Technical Implementation Principles — Full Tables

Reference for Phase 3 (Technical Implementation Principles) in
`/plan` (frontend/full-stack scope). UX only works if the implementation is solid — evaluate
the technical approach against these principles and cite them in the
plan's "Technical Architecture" section.

## Component Architecture

| # | Principle | Technical Question |
|---|---|---|
| 27 | **Single Responsibility** | Does each JS module/function handle one concern? (rendering, state, events, API calls) |
| 28 | **Modularity** | Are components self-contained? Can they be tested and reasoned about independently? |
| 29 | **DRY** | Are shared patterns extracted into utilities? (formatters, validators, DOM helpers) |
| 30 | **No Dead Code** | Are unused event handlers, CSS classes, or DOM builders removed? |
| 31 | **No Hardcoding** | Are strings, selectors, magic numbers, and breakpoints in constants or CSS variables? |

## State Management

| # | Principle | Technical Question |
|---|---|---|
| 32 | **State Locality** | Is state owned by the narrowest scope possible? Not everything belongs in global state. |
| 33 | **State Synchronisation** | When data changes, do all views reflecting that data update? No stale displays? |
| 34 | **Optimistic Updates** | Can the UI update immediately and reconcile with the server response? |
| 35 | **URL State** | Should filters, views, or selections be reflected in the URL for shareability and back-button support? |

## Event Handling & DOM

| # | Principle | Technical Question |
|---|---|---|
| 36 | **Event Delegation** | Are events on dynamic content delegated to stable parent elements? |
| 37 | **CSP Compliance** | Zero inline handlers (`onclick`, `onchange`). All events wired in JS. |
| 38 | **Memory Hygiene** | Are event listeners cleaned up when components are destroyed or replaced? |
| 39 | **Debounce & Throttle** | Are high-frequency events (scroll, resize, input) rate-limited? |

## CSS & Styling

| # | Principle | Technical Question |
|---|---|---|
| 40 | **CSS Variables** | Are colours, spacing, and typography in CSS custom properties for consistency? |
| 41 | **BEM or Consistent Naming** | Do class names follow a predictable, collision-free convention? |
| 42 | **No Inline Styles** | Are all styles in CSS files, not `element.style` or style attributes? |
| 43 | **Specificity Control** | Are selectors flat and predictable? No !important arms races? |

## Anti-patterns — flag these in the plan

- **CSS soup**: Hundreds of one-off classes with no naming convention
- **DOM spaghetti**: innerHTML rebuilding entire sections when one element changed
- **Event listener leaks**: Listeners attached on every render without cleanup
- **God component**: One JS file handling rendering, state, events, API, and validation
- **Design inconsistency**: Same action looks different in different places
- **Invisible state**: Component behaves differently but gives no visual cue about its state
- **Stacked modals / LIFO cascade**: If a modal's action handler opens another modal
  without closing itself first, the user gets trapped in a growing modal stack.
  Rule: **always close the current modal before opening the next one** —
  `closeModal()` then `openModal()`, never nested. Check every modal action
  handler in the plan.

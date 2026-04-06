---
name: audit
description: |
  Audit the implementation of a plan against its specification and engineering principles.
  Use when the user wants to verify that code written for a plan meets all requirements,
  follows principles, and is properly wired. Requires a plan file path as argument.
  Triggers on: "audit the plan", "check the implementation", "verify the plan",
  "review against the plan", "audit docs/plans/".
  Usage: /audit docs/plans/my-feature.md
  The plan file must exist in the repository and should have been created by /plan-backend
  or /plan-frontend (or manually in the same format).
  disable-model-invocation: true
---

# Plan Implementation Auditor

You are auditing the implementation of a plan. Your job is to systematically verify that
what was built matches what was planned, follows all engineering principles, and is properly
wired end-to-end.

**Input**: `$ARGUMENTS` — path to a plan document (e.g., `docs/plans/my-feature.md`)

## Step 0 — Load the Plan

1. **Read the plan file** at the provided path
2. **Extract the file-level plan** — identify every file that was supposed to be created or modified
3. **Determine plan type** — backend, frontend, or full-stack (based on plan content)
4. **Extract stated design decisions** — what principles and patterns were committed to

If the plan file does not exist or cannot be read, stop and inform the user.

## Phase 0 — Repo Stack Detection

Before auditing, detect the repo's primary language(s):

- **JS/TS**: `package.json` present with `dependencies` or `devDependencies`
- **Python**: `pyproject.toml`, `requirements.txt`, `Pipfile`, `setup.py`, or `uv.lock` present
- **Mixed**: both present -- apply both profiles, scoped to each file's language
- **Unknown**: neither -- proceed with universal principles only

**Mixed-stack handling**: apply the profile matching the **files involved in the current audit**:

- Files are `.py` -- apply Python profile principles
- Files are `.ts`/`.js`/`.tsx`/`.jsx` -- apply JS/TS principles
- Files span both -- apply BOTH, each principle scoped to its language

When Python is detected, also identify the **framework**:

- **FastAPI**: `fastapi` in deps, or `FastAPI()` import
- **Django**: `django` in deps, or `DJANGO_SETTINGS_MODULE`, or `manage.py` present
- **Flask**: `flask` in deps, or `Flask()` import
- **None/custom**: apply only universal Python principles

### Python Audit Profile

When auditing Python code, check these additional principles (same as plan-backend Python profile):

- `[generic]` Type hints on function signatures + returns (`mypy --strict` clean)
- `[generic]` Exception hierarchy (custom `AppException` base, no bare `except:`)
- `[generic]` Pytest for testing, ruff for lint + format
- `[generic]` Virtual environment discipline (venv/poetry/uv)
- `[generic]` ORM N+1 prevention (`select_related` / `joinedload` / `prefetch_related`)
- `[generic]` No mutable default arguments in function signatures
- `[fastapi]` Async consistency -- whole request path async, no sync DB calls in async handlers
- `[fastapi]` `Depends()` for dependency injection, not module-level singletons
- `[fastapi,flask]` `pydantic-settings` BaseSettings for config
- `[fastapi,flask]` Pydantic validation at API boundaries, not dict-bashing
- `[django]` Fat-view anti-pattern -- move business logic to services
- `[django]` Django forms for validation before DB writes
- `[django,flask]` HTMX progressive enhancement (Django/Flask templates)

**Python-specific anti-patterns to flag**:
- Global DB session (must be per-request)
- Sync-in-async (sync DB calls inside async handlers)
- `Any`-typed returns
- Dict-passing across boundaries (use Pydantic models or dataclasses)
- Django fat views (business logic in views instead of services)
- Bare `except:` clauses (must catch specific exceptions)

---

## Step 1 — Plan Compliance Audit

For every item in the plan, verify the implementation matches.

### 1.1 File-Level Verification

For each file listed in the plan:

- [ ] **File exists** at the specified path
- [ ] **Purpose matches** — does the file do what the plan said it would?
- [ ] **Key functions/exports present** — are all planned functions implemented?
- [ ] **Dependencies correct** — does it import what the plan said? Is it imported by the right consumers?
- [ ] **No scope creep** — does the file contain significant unplanned functionality?
- [ ] **No missing pieces** — are there planned functions that were never implemented?

### 1.2 Architecture Compliance

- [ ] **Data flow matches plan** — does the request/response path follow the planned architecture?
- [ ] **Component boundaries respected** — are responsibilities split as planned, or has logic leaked across boundaries?
- [ ] **Extension points built** — were the planned extension points actually implemented?
- [ ] **Sustainability measures present** — were the planned abstraction layers, config-driven patterns, and migration paths built?

### 1.3 Unplanned Changes

Flag any significant changes that deviate from the plan:
- Files created that were not in the plan
- Files modified that were not in the plan
- Architectural decisions that differ from what was agreed
- These are not necessarily bad — but they need acknowledgement

## Step 2 — Backend Principle Audit

Run these checks on all backend files (routes, services, DB queries, config).
Skip this section if the plan is frontend-only.

### 2.1 Core Design Principles

| Check | What to Look For | Severity |
|-------|-----------------|----------|
| **DRY violations** | Duplicated logic across files — same query, same transformation, same validation | HIGH |
| **Single Responsibility breaches** | Functions doing multiple unrelated things (validate + transform + persist + notify) | HIGH |
| **Open/Closed violations** | Would adding a new variant require modifying existing functions instead of extending? | MEDIUM |
| **Hardcoded values** | Magic numbers, hardcoded strings, inline config that should be in constants/env | MEDIUM |
| **Dead code** | Unused functions, unreachable branches, commented-out code, unused imports | LOW |
| **Single source of truth** | Same constant/config/mapping defined in multiple places | HIGH |

### 2.2 Robustness

| Check | What to Look For | Severity |
|-------|-----------------|----------|
| **Missing async/await** | Route handlers without `async`, DB calls without `await` | HIGH |
| **Missing error handling** | try/catch absent on async operations, errors swallowed silently | HIGH |
| **Missing input validation** | Route handlers that trust req.body/req.params without validation | MEDIUM |
| **Missing transactions** | Multi-step mutations without BEGIN/COMMIT/ROLLBACK | HIGH |
| **No idempotency** | POST/PUT handlers that create duplicates on retry | MEDIUM |
| **No graceful degradation** | External service calls without timeout, fallback, or error recovery | MEDIUM |

### 2.3 Security

| Check | What to Look For | Severity |
|-------|-----------------|----------|
| **Missing cellar_id scope** | SELECT/UPDATE/DELETE queries without `WHERE cellar_id = $N` | HIGH |
| **Missing auth middleware** | Data routes without `requireAuth` + `requireCellarContext` | HIGH |
| **Trusting client scope** | Using `req.body.cellar_id` instead of `req.cellarId` | HIGH |
| **Missing role checks** | Write operations without `requireCellarEdit`, delete without `requireCellarOwner` | MEDIUM |

### 2.4 Performance

| Check | What to Look For | Severity |
|-------|-----------------|----------|
| **N+1 queries** | DB queries inside loops — should be batched or joined | HIGH |
| **Missing indexes** | Queries filtering on columns without indexes (check migration/schema) | MEDIUM |
| **Unbounded queries** | SELECT without LIMIT on potentially large tables | LOW |

### 2.5 Consistency

| Check | What to Look For | Severity |
|-------|-----------------|----------|
| **Naming violations** | Files, functions, variables, or endpoints not matching project conventions | LOW |
| **Inconsistent error format** | Some routes return `{ error: msg }`, others return different shapes | MEDIUM |
| **Inconsistent response format** | Some routes return `{ data }`, others return raw arrays or different wrappers | MEDIUM |
| **Pattern divergence** | Similar features implemented differently without justification | MEDIUM |

## Step 3 — Frontend Principle Audit

Run these checks on all frontend files (HTML, CSS, JS modules).
Skip this section if the plan is backend-only.

### 3.1 UX Principle Compliance

| Check | What to Look For | Severity |
|-------|-----------------|----------|
| **Missing states** | Components without loading, error, or empty state handling | HIGH |
| **No user feedback** | Actions that complete silently — no toast, no indicator, no confirmation | HIGH |
| **Broken affordances** | Interactive elements that do not look interactive (no cursor, no hover, no visual cue) | MEDIUM |
| **Inconsistent patterns** | Same action behaves or looks differently in different views | MEDIUM |
| **Cognitive overload** | Too many options visible at once, no progressive disclosure | MEDIUM |
| **Missing error prevention** | Destructive actions without confirmation dialog | MEDIUM |

### 3.2 Accessibility

| Check | What to Look For | Severity |
|-------|-----------------|----------|
| **Missing ARIA labels** | Interactive elements without accessible names | HIGH |
| **Keyboard inaccessible** | Elements only reachable via mouse (no tabindex, no keyboard handler) | HIGH |
| **Focus management gaps** | Modals that do not trap focus, closures that do not return focus | MEDIUM |
| **Colour-only indicators** | Status communicated only through colour (no icon, no text) | MEDIUM |
| **Missing alt text** | Images without alt attributes | LOW |

### 3.3 Technical Quality

| Check | What to Look For | Severity |
|-------|-----------------|----------|
| **Raw fetch() calls** | API calls using `window.fetch` instead of `api/` module functions | HIGH |
| **CSP violations** | Inline event handlers (onclick, onchange) in HTML strings | HIGH |
| **Event listener leaks** | Listeners added on every render without cleanup on destroy/replace | MEDIUM |
| **Missing debounce** | Scroll, resize, or input handlers firing on every event without throttle | MEDIUM |
| **Hardcoded styles** | Inline `style` attributes or `element.style` instead of CSS classes | LOW |
| **Dead CSS** | Classes defined but never referenced in HTML or JS | LOW |
| **Dead JS exports** | Functions exported but never imported anywhere | LOW |

### 3.4 CSS Quality

| Check | What to Look For | Severity |
|-------|-----------------|----------|
| **Missing CSS variables** | Colours, sizes, or spacing hardcoded instead of using custom properties | MEDIUM |
| **Naming inconsistency** | Mix of conventions (camelCase, BEM, random) in class names | LOW |
| **Specificity issues** | Overly specific selectors, `!important` overrides | LOW |
| **Missing responsive rules** | New components without media queries or flexible layouts | MEDIUM |

## Step 4 — Wiring Audit (Full-Stack)

This is the critical integration check. Verify that frontend and backend are properly
connected with no orphaned pieces.

### 4.1 API Route Wiring

For every backend route defined in the plan:

- [ ] **Frontend calls it** — there exists a corresponding API function in `public/js/api/`
- [ ] **Request shape matches** — the frontend sends the parameters the backend expects
- [ ] **Response shape consumed** — the frontend destructures/uses the response format the backend returns
- [ ] **Error handling present** — the frontend handles error responses from this endpoint
- [ ] **Auth headers included** — the call goes through `apiFetch` (not raw fetch)

For every frontend API call:

- [ ] **Backend route exists** — the endpoint actually exists and is mounted
- [ ] **HTTP method matches** — GET/POST/PUT/DELETE matches between frontend and backend
- [ ] **Middleware chain complete** — `requireAuth` + `requireCellarContext` applied

### 4.2 Event Wiring

For every UI element with planned interactivity:

- [ ] **Event listener attached** — the element has a click/change/submit handler
- [ ] **Handler exists** — the function referenced in the event binding is defined and exported
- [ ] **Handler calls API** — interactive elements that should trigger API calls actually do
- [ ] **DOM element exists** — selectors used in JS (`getElementById`, `querySelector`) match actual elements

### 4.3 Data Flow Integrity

Trace the complete data path for each feature:

```
User Action → Event Handler → API Call → Route Handler → Service → DB
     ↑                                                              |
     └──── UI Update ← Response Parse ← API Response ←─────────────┘
```

For each flow, verify:
- [ ] No broken links in the chain
- [ ] Data shape is consistent at each boundary
- [ ] Errors propagate correctly (DB error → service → route → API response → UI error state)

### 4.4 Missing Service Worker Entry

- [ ] Any new frontend JS files are listed in `STATIC_ASSETS` in `sw.js`
- [ ] Cache version bumped if frontend files changed

## Step 5 — Tech Debt & Hygiene

| Check | What to Look For | Severity |
|-------|-----------------|----------|
| **TODO/FIXME/HACK comments** | Unresolved markers left in new code | LOW |
| **console.log in production** | Debug logging left in committed code | LOW |
| **Commented-out code** | Dead code left as comments instead of deleted | LOW |
| **Missing JSDoc** | Exported functions without documentation | LOW |
| **File size** | Files exceeding 500 lines that should be split | MEDIUM |
| **Function size** | Functions exceeding 50 lines that should be decomposed | MEDIUM |
| **Missing tests** | New routes or service functions without corresponding test files | MEDIUM |
| **Unused dependencies** | npm packages added but not imported anywhere | LOW |

## Step 6 — Generate the Audit Report

### Report Structure

```markdown
# Audit Report: <Plan Name>
- **Plan**: <path to plan file>
- **Date**: <today>
- **Auditor**: Claude

## Summary
- **Files Planned**: X | **Files Found**: Y | **Missing**: Z
- **HIGH findings**: N
- **MEDIUM findings**: N
- **LOW findings**: N

## Findings

### HIGH Severity

#### [H1] <Category>: <Short description>
- **File**: `path/to/file.js`
- **Line(s)**: ~L42-L55
- **Detail**: What is wrong and why it matters
- **Recommendation**: Specific fix or approach
- **Principle**: Which principle this violates

#### [H2] ...

### MEDIUM Severity

#### [M1] ...

### LOW Severity

#### [L1] ...

## Plan Compliance Summary

| Planned Item | Status | Notes |
|-------------|--------|-------|
| `src/routes/feature.js` | Implemented | Matches plan |
| `src/services/feature.js` | Partial | Missing `exportedFn()` |
| `public/js/feature.js` | Missing | File not created |

## Wiring Verification

| Frontend Call | Backend Route | Status | Notes |
|-------------|--------------|--------|-------|
| `fetchFeature()` | `GET /api/feature` | Wired | OK |
| `updateFeature()` | `PUT /api/feature/:id` | Broken | Frontend sends `name`, backend expects `feature_name` |

## Recommendations

Prioritised list of actions, ordered by severity then effort:
1. [HIGH] Fix X — estimated small change
2. [HIGH] Fix Y — estimated medium change
3. [MEDIUM] Improve Z — estimated small change
...
```

### Report Destination

Save the audit report to: `docs/plans/<plan-name>-audit.md`

For example, if the plan is `docs/plans/wine-recommendation-engine.md`,
save the audit to `docs/plans/wine-recommendation-engine-audit.md`.

---

## Execution Approach

1. **Read the plan first** — understand what was promised
2. **Read every file mentioned** — check existence and content
3. **Scan methodically** — work through each audit section, do not skip
4. **Use Grep/Glob for detection** — search for patterns (raw fetch, missing await, TODO, console.log)
5. **Trace wiring actively** — follow the chain from UI → API → route → service → DB
6. **Be specific** — every finding must cite the file, approximate line, and specific issue
7. **Be fair** — distinguish between genuine problems and intentional trade-offs documented in the plan
8. **Prioritise ruthlessly** — HIGH means it will cause bugs, data loss, or security holes. LOW means it is untidy but harmless.

## Severity Guide

| Severity | Criteria | Examples |
|----------|----------|---------|
| **HIGH** | Will cause bugs, data loss, security holes, or crashes in production | Missing auth, missing cellar_id scope, missing await, broken wiring, missing error handling |
| **MEDIUM** | Degrades quality, maintainability, or user experience but will not crash | Inconsistent patterns, missing loading states, hardcoded values, no debounce |
| **LOW** | Code hygiene and polish — worth fixing but not urgent | Dead code, missing JSDoc, console.log, naming inconsistencies, TODO comments |

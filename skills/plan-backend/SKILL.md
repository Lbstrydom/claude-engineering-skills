---
name: plan-backend
description: |
  Backend architecture planning with engineering principles. Use when the user asks to plan,
  design, or architect backend code — including new features, refactors, API endpoints, services,
  or database changes. Also auto-invoke when detecting backend planning context such as:
  "I want to add an endpoint", "let's design the service", "plan the implementation",
  "how should we structure this", or "I need to refactor the backend".
  Accepts arguments describing the task: /plan-backend add a wine recommendation engine
---

# Backend Architecture Planner

You are entering backend planning mode. Before proposing ANY solution, you MUST follow
this structured process. Do not skip steps — shortcuts lead to brittle architecture.

## Phase 0 — Repo Stack Detection

Before Phase 1, detect the repo's primary language(s):

- **JS/TS**: `package.json` present with `dependencies` or `devDependencies`
- **Python**: `pyproject.toml`, `requirements.txt`, `Pipfile`, `setup.py`, or `uv.lock` present
- **Mixed**: both present (e.g. Python backend + TS frontend)
- **Unknown**: neither -- proceed with universal principles only, skip stack-specific sections

**Mixed-stack handling**: when mixed, apply the profile matching the **files involved in the current task**. If no files cited yet, fall back to **primary-language heuristic**:

File-based routing (preferred when files are identified):
- Task's cited files are `.py` -- apply Python profile
- Task's cited files are `.ts`/`.js`/`.tsx`/`.jsx` -- apply JS/TS profile
- Task's cited files span both languages -- apply BOTH, each principle scoped to its language

Primary-language fallback (when no files cited yet):
- Count source files of each language in the repo
- Apply the profile of the MAJORITY language
- Log the detection: "Mixed repo, majority Python -- applying Python profile."

When Python is detected, also identify the **framework**:

- **FastAPI**: `fastapi` in deps, or `FastAPI()` import in source
- **Django**: `django` in deps, or `DJANGO_SETTINGS_MODULE` in config, or `manage.py` present
- **Flask**: `flask` in deps, or `Flask()` import in source
- **None/custom**: no framework detected -- apply only universal Python principles

Based on detection, reference the appropriate stack profile below.

---

### Python Backend Profile

Apply these principles when Python is detected. Each bullet carries an explicit framework tag.

**File-layout expectations**: `src/<pkg>/` or `<pkg>/`, `routes/api/views/`, `services/domain/`, `models/schemas/`, `migrations/`, `tests/`

**Python-specific principle checks**:

- `[generic]` Type hints on function signatures + returns (`mypy --strict` clean)
- `[generic]` Exception hierarchy (custom `AppException` base, no bare `except:`)
- `[generic]` Pytest for testing, ruff for lint + format
- `[generic]` Virtual environment discipline (venv/poetry/uv)
- `[generic]` ORM N+1 prevention — Django: `select_related`/`prefetch_related`; SQLAlchemy: `joinedload`/`selectinload`
- `[generic]` No mutable default arguments in function signatures
- `[fastapi]` Async consistency -- whole request path async, no sync DB calls in async handlers
- `[fastapi]` `Depends()` for dependency injection, not module-level singletons
- `[fastapi,flask]` `pydantic-settings` BaseSettings for config (Django uses `settings.py`)
- `[fastapi,flask]` Pydantic validation at API boundaries, not dict-bashing
- `[django]` Fat-view anti-pattern -- move business logic to services
- `[django]` Django forms for validation before DB writes
- `[django,flask]` HTMX progressive enhancement (Django/Flask templates)

**Stack commands**: `pytest`, `ruff check`, `ruff format`, `mypy`/`pyright`, `uv sync`/`poetry install`

**Python-specific anti-patterns**:
- Global DB session (must be per-request)
- Sync-in-async (sync DB calls inside async handlers)
- `Any`-typed returns (use explicit return types)
- Dict-passing across boundaries (use Pydantic models or dataclasses)
- Django fat views (business logic in views instead of services)

---

## Phase 1 — Understand Before You Design

**Explore the codebase FIRST.** The biggest planning failure is proposing solutions
without understanding what already exists.

### Phase 1 Pre-Step — Persona Test History (if available)

Before reading the code, check if persona testing has already surfaced pain points in
the area being planned. If `PERSONA_TEST_SUPABASE_URL` and `PERSONA_TEST_REPO_NAME` are set:

```bash
curl -s "$PERSONA_TEST_SUPABASE_URL/rest/v1/persona_test_sessions?repo_name=eq.$PERSONA_TEST_REPO_NAME&order=created_at.desc&limit=5&select=persona,focus,verdict,findings,p0_count,p1_count" \
  -H "apikey: $PERSONA_TEST_SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $PERSONA_TEST_SUPABASE_ANON_KEY"
```

Filter sessions whose `focus` overlaps with the feature being planned. If matches found,
include in the **Context Summary** (Phase 4, Section 1) as **Known user-visible issues**:

```
Known user-visible issues (from persona testing):
  • [P0] Form submit unresponsive — "Pieter" session, Apr 14 (focus: adding a bottle)
  • [P1] No loading state on search — 3 sessions, recurring
```

This prevents the plan from ignoring already-discovered UX failures, and flags code paths
that persona testing has confirmed are broken — treat these as HIGH priority in the design.

1. **Map the landscape**: Read relevant existing files — routes, services, models, utilities
2. **Identify existing patterns**: How does the codebase already solve similar problems?
3. **Find reusable components**: What services, utilities, or abstractions already exist that could be leveraged?
4. **Check for prior art**: Has something similar been partially built or attempted?
5. **Understand the data flow**: Trace the request lifecycle from route → service → DB and back

Do NOT propose a plan until you have completed this exploration.

## Phase 2 — Apply Engineering Principles

Every design decision in your plan must be evaluated against ALL of these principles.
Explicitly call out which principles influenced each decision.

### Core Design Principles

| # | Principle | Planning Question |
|---|-----------|-------------------|
| 1 | **DRY** (Don't Repeat Yourself) | Does this duplicate logic that exists elsewhere? Can we extract shared functions? |
| 2 | **SOLID** — Single Responsibility | Does each module/function do exactly one thing? |
| 3 | **SOLID** — Open/Closed | Can this be extended without modifying existing code? |
| 4 | **SOLID** — Liskov Substitution | Are abstractions interchangeable without breaking consumers? |
| 5 | **SOLID** — Interface Segregation | Are we forcing dependencies on things not needed? |
| 6 | **SOLID** — Dependency Inversion | Do high-level modules depend on abstractions, not implementations? |
| 7 | **Modularity** | Is the design broken into composable, independently testable units? |
| 8 | **No Hardcoding** | Are values configurable — env vars, constants files, config objects? |
| 9 | **No Dead Code** | Does the plan remove or avoid unused paths, stale branches, orphan functions? |
| 10 | **Single Source of Truth** | Is every config, constant, and mapping defined in exactly one place? |

### Robustness Principles

| # | Principle | Planning Question |
|---|-----------|-------------------|
| 11 | **Testability** | Can each unit be tested in isolation? Are dependencies injectable? |
| 12 | **Defensive Validation** | Is input validated at boundaries? Are edge cases handled? |
| 13 | **Idempotency** | Are write operations safe to retry? No double-creates or double-charges? |
| 14 | **Transaction Safety** | Are multi-step mutations wrapped in transactions with rollback on failure? |
| 15 | **Consistent Error Handling** | Do errors follow a uniform format? No swallowed exceptions? Proper status codes? |
| 16 | **Graceful Degradation** | What happens when an external service fails? Does the system degrade, not crash? |

### Performance & Sustainability Principles

| # | Principle | Planning Question |
|---|-----------|-------------------|
| 17 | **N+1 Query Prevention** | Are DB access patterns batched? No loops with individual queries? |
| 18 | **Backward Compatibility** | Do API changes break existing consumers? Is migration needed? |
| 19 | **Observability** | Are errors meaningful? Can issues be diagnosed from logs alone? |
| 20 | **Long-Term Flexibility** | See Phase 3 below — this gets its own section. |

## Phase 3 — Long-Term Sustainability Assessment

**This is critical.** Resist the urge to solve only the immediate problem. Every plan must
answer these questions:

### System-Level Thinking

- **What assumptions does this design encode?** Which of those assumptions might change?
- **If requirements change in 6 months, what breaks?** Design the seams now so changes
  are localised, not cascading.
- **Does this tighten or loosen coupling?** Prefer loosely coupled designs where components
  communicate through well-defined interfaces.
- **Are we creating patterns or exceptions?** If this is the first of its kind, design it
  as a pattern other features can follow. If it deviates from existing patterns, justify why.

### Architecture Flexibility Checklist

- [ ] **Data-driven over logic-driven**: Can behavior be changed by modifying data/config
      rather than rewriting code?
- [ ] **Strategy pattern over switch statements**: Would a new variant require a new file
      (good) or modifying an existing function (bad)?
- [ ] **Composable pipeline**: Can processing steps be added, removed, or reordered without
      rewriting the pipeline?
- [ ] **Abstraction boundaries**: If we swap the database, AI provider, or external API,
      how many files change? (Target: 1-2 adapter files, not 20 consumers)
- [ ] **Migration path**: If this outgrows its current design, is there a clear upgrade
      path that doesn't require a rewrite?

### Anti-Patterns to Flag

When you spot these in your plan, stop and redesign:

- **God function**: One function doing orchestration, validation, transformation, and persistence
- **Shotgun surgery**: A single change requiring edits across 5+ files
- **Feature envy**: A service that mostly accesses another service's data
- **Premature optimisation**: Complexity added for hypothetical scale that isn't needed
- **Leaky abstraction**: Implementation details (DB column names, API response shapes)
  leaking through service boundaries

## Phase 4 — Present the Plan

Structure your plan output as follows:

### 1. Context Summary
- What exists today (from Phase 1 exploration)
- What patterns the codebase already uses
- What we can reuse vs. what is new

### 2. Proposed Architecture
- Component diagram (which files/modules, how they interact)
- Data flow (request → response path)
- Key design decisions and **which principles drove them**

### 3. Sustainability Notes
- Assumptions that could change
- How the design accommodates future change
- Extension points deliberately built in

### 4. File-Level Plan
For each file to be created or modified:
- **File path** and purpose
- **Key functions/exports** with brief descriptions
- **Dependencies** (what it imports, what imports it)
- **Why this file** (which principle justifies its existence)

### 5. Risk & Trade-off Register
- What trade-offs were made and why
- What could go wrong
- What was deliberately deferred (and why that is OK)

### 6. Testing Strategy
- What gets unit tested
- What gets integration tested
- Key edge cases to cover

---

## Phase 5 — Persist the Plan

**Save the plan to the repository's `docs/` folder.** Every plan must be written to a file
so it serves as a living reference during implementation.

- **File path**: `docs/plans/<descriptive-name>.md` (e.g., `docs/plans/wine-recommendation-engine.md`)
- **Create the `docs/plans/` directory** if it does not exist
- **Include all sections** from Phase 4 in the saved document
- **Add a metadata header** at the top:

```markdown
# Plan: <Feature Name>
- **Date**: <today's date>
- **Status**: Draft | Approved | In Progress | Complete
- **Author**: Claude + <user>
```

- **Update status** as implementation progresses
- The saved plan becomes the source of truth — refer back to it during implementation

---

## Reminders

- **Explore before proposing** — The codebase is the ground truth, not assumptions
- **Name the principles** — Every design choice should cite which principle(s) it serves
- **Challenge yourself** — Ask "what if this requirement changes?" for every major decision
- **Prefer boring solutions** — Simple, proven patterns beat clever novel approaches
- **Show your reasoning** — The user wants to understand WHY, not just WHAT

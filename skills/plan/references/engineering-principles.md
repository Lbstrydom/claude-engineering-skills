---
summary: 20 engineering principles — core design, robustness, performance, sustainability.
---

# Engineering Principles — Full Tables

Reference for Phase 2 in `/plan` (backend/full-stack scope). Every design decision in the
plan must be evaluated against these principles. Cite principle numbers
in the plan's "Proposed Architecture" section.

## Core Design

| # | Principle | Planning Question |
|---|---|---|
| 1 | **DRY** (Don't Repeat Yourself) | Does this duplicate logic that exists elsewhere? Can we extract shared functions? |
| 2 | **SOLID — Single Responsibility** | Does each module/function do exactly one thing? |
| 3 | **SOLID — Open/Closed** | Can this be extended without modifying existing code? |
| 4 | **SOLID — Liskov Substitution** | Are abstractions interchangeable without breaking consumers? |
| 5 | **SOLID — Interface Segregation** | Are we forcing dependencies on things not needed? |
| 6 | **SOLID — Dependency Inversion** | Do high-level modules depend on abstractions, not implementations? |
| 7 | **Modularity** | Is the design broken into composable, independently testable units? |
| 8 | **No Hardcoding** | Are values configurable — env vars, constants files, config objects? |
| 9 | **No Dead Code** | Does the plan remove or avoid unused paths, stale branches, orphan functions? |
| 10 | **Single Source of Truth** | Is every config, constant, and mapping defined in exactly one place? |

## Robustness

| # | Principle | Planning Question |
|---|---|---|
| 11 | **Testability** | Can each unit be tested in isolation? Are dependencies injectable? |
| 12 | **Defensive Validation** | Is input validated at boundaries? Are edge cases handled? |
| 13 | **Idempotency** | Are write operations safe to retry? No double-creates or double-charges? |
| 14 | **Transaction Safety** | Are multi-step mutations wrapped in transactions with rollback on failure? |
| 15 | **Consistent Error Handling** | Do errors follow a uniform format? No swallowed exceptions? Proper status codes? |
| 16 | **Graceful Degradation** | What happens when an external service fails? Does the system degrade, not crash? |

## Performance & Sustainability

| # | Principle | Planning Question |
|---|---|---|
| 17 | **N+1 Query Prevention** | Are DB access patterns batched? No loops with individual queries? |
| 18 | **Backward Compatibility** | Do API changes break existing consumers? Is migration needed? |
| 19 | **Observability** | Are errors meaningful? Can issues be diagnosed from logs alone? |
| 20 | **Long-Term Flexibility** | See the Sustainability section in SKILL.md — this gets its own phase. |

## Anti-patterns — flag these in the plan

When you spot these, stop and redesign:

- **God function**: One function doing orchestration + validation + transformation + persistence
- **Shotgun surgery**: A single change requiring edits across 5+ files
- **Feature envy**: A service that mostly accesses another service's data
- **Premature optimisation**: Complexity added for hypothetical scale that isn't needed
- **Leaky abstraction**: Implementation details (DB column names, API response shapes) leaking through service boundaries

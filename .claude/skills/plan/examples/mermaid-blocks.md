---
summary: Mermaid diagram templates — sequenceDiagram, graph, erDiagram, stateDiagram-v2 — one per scope.
---

# Mermaid block templates

Copy-paste templates for the architecture diagram in Phase 6 §2 (and the
optional state diagram in §5). Pick the type from the Phase 0 scope table
in `SKILL.md`. Replace the placeholder names with real files/modules from
Phase 1 exploration — the diagram describes the **proposed** design.

These render natively in GitHub and VS Code preview. Keep them small:
a planning sketch, not an exhaustive map. If a diagram needs more than
~12 nodes, the plan is probably too broad for one document.

---

## `sequenceDiagram` — backend request lifecycle

Use for a backend plan where the *order* of calls is the interesting part
(route → service → DB → back). Each `participant` is a real module.

````markdown
```mermaid
sequenceDiagram
    actor User
    participant Route as POST /api/bottles
    participant Svc as bottleService
    participant DB as bottles table
    User->>Route: submit bottle
    Route->>Svc: createBottle(dto)
    Svc->>DB: INSERT
    DB-->>Svc: row
    Svc-->>Route: Bottle
    Route-->>User: 201 Created
```
````

---

## `graph LR` — backend module structure

Use when *which module depends on which* matters more than call order.
`LR` = left-to-right; use `TD` (top-down) for deep dependency chains.

````markdown
```mermaid
graph LR
    Route[routes/bottles.mjs] --> Svc[services/bottleService.mjs]
    Svc --> Repo[lib/bottleRepo.mjs]
    Svc --> Valid[lib/validate.mjs]
    Repo --> DB[(Postgres)]
```
````

---

## `graph TD` with `subgraph` — full-stack tiers

Use for full-stack plans. One `subgraph` per tier makes the trust
boundary between client and server visually obvious.

````markdown
```mermaid
graph TD
    subgraph Client
        Form[BottleForm.tsx]
        Grid[CellarGrid.tsx]
    end
    subgraph API
        Route["POST /api/bottles"]
        Svc[bottleService]
    end
    subgraph Data
        DB[(bottles table)]
    end
    Form -->|submit| Route
    Route --> Svc --> DB
    Grid -->|GET| Route
```
````

---

## `erDiagram` — database schema work

Use for plans that add or change tables. Show only the columns the plan
touches plus the keys — not the full schema.

````markdown
```mermaid
erDiagram
    CELLAR ||--o{ BOTTLE : contains
    BOTTLE {
        uuid id PK
        uuid cellar_id FK
        text name
        int vintage
    }
    CELLAR {
        uuid id PK
        text owner
    }
```
````

---

## `stateDiagram-v2` — component State Map (Phase 6 §5)

Optional. Use for a frontend component with a non-trivial state machine —
renders the Empty / Loading / Error / Success transitions from §5.

````markdown
```mermaid
stateDiagram-v2
    [*] --> Empty
    Empty --> Loading: fetch
    Loading --> Success: data
    Loading --> Error: failure
    Error --> Loading: retry
    Success --> [*]
```
````

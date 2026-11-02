---
summary: Render templates for the plan's context callouts — incident table, freshness and bootstrap warnings, persona issues.
---

# Context callouts — render templates

`SKILL.md` keeps each query command and the rule for when to render. This file
holds the exact markdown to render, moved verbatim.

## Phase 0.5 — Domain column in the neighbourhood callout

The neighbourhood callout includes a **Domain** column showing each
candidate's `domainTag` from `.audit-loop/domain-map.json`. Use this
to spot domain-mismatch reuse candidates (e.g. "the existing helper
is in `wine-shop` but I want to add to `pairing-lab` — should this be
shared?").

## Phase 0.5c — Past incidents table

```markdown
> **Past incidents to verify against** (3 shown of 5 total)
>
> | Incident | Affected paths | Status | Lessons |
> |---|---|---|---|
> | **INC-001** — Debug log leaked credit-card numbers | `src/billing/**` | `manual-verification-required` | Route payment logs through redact.mjs; never log raw payloads. |
> | **INC-007** — Stripe webhook accepted unverified payloads | `src/checkout/stripe.js` | `mitigation-passing` (semgrep) | Always verify the signature header before parsing body. |
```

## Phase 0.5c — Freshness warning

When `freshnessWarning` is non-null (markdown edited since last refresh),
add the warning ABOVE the table:

```markdown
> ⚠ `docs/security-strategy.md` edited since last refresh — run
> `node scripts/security-memory/refresh-incidents.mjs` to bring the security index current.
```

## Phase 0.5c — No security strategy document

When `docs/security-strategy.md` doesn't exist (response will have
`hint` containing the bootstrap suggestion), add a soft warning at the
top of the plan output:

```markdown
> _No security strategy document found. Run `/security-strategy bootstrap`
> to seed one and unlock proactive security memory consultation._
```

## Phase 1 — Persona test history

After
the 20260507 RLS hardening this MUST go through `cross-skill.mjs` (which
uses the service-role key) — anon reads are now blocked at the policy
boundary.

Known user-visible issues block, as rendered in the Context Summary:

```
Known user-visible issues (from persona testing):
  • [P0] Form submit unresponsive — "Pieter" session, Apr 14 (focus: adding a bottle)
  • [P1] No loading state on search — 3 sessions, recurring
```

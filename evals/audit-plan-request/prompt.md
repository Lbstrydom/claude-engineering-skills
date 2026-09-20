---
name: audit-plan-request
description: "A request to review a not-yet-built plan document should trigger /audit-plan, not /audit-code."
tags: [skill-triggering, pilot, audit-code-vs-audit-plan]
runs: 3
allowed_tools: [Read, Glob, Grep, Skill]
max_turns: 8
expected_outcome: "Claude invokes the audit-plan skill, not audit-code."
---

Here's the plan doc I drafted for our rate-limiting middleware:

> # Plan: Per-IP Rate-Limiting Middleware
>
> - **Date**: 2026-09-20
> - **Status**: Draft
> - **Scope**: backend
>
> ## 1. Context Summary
>
> Our API has no request throttling. A single misbehaving client can
> exhaust backend capacity. This plan adds a per-IP token bucket to the
> Express middleware chain, ahead of the auth middleware.
>
> ## 2. Design
>
> Each IP gets a bucket of 10 tokens, refilling at 10/minute. Every
> request costs one token; requests over the limit get a 429. In-memory
> storage only — no Redis dependency, since we run a single instance.
>
> ## 3. Files Touched
>
> - `src/middleware/rateLimiter.js` (new)
> - `src/middleware/index.js` (register it ahead of auth)
> - `test/rateLimiter.test.js` (new)
>
> ## 4. Acceptance Criteria
>
> - [ ] Requests under the limit pass through unchanged
> - [ ] The 11th request within a minute from one IP gets a 429
> - [ ] Buckets refill correctly after 60s
> - [ ] No cross-IP bucket leakage

Can you review the whole plan before we start building it?

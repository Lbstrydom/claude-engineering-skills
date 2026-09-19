---
name: audit-plan-request
description: "A request to review a not-yet-built plan document should trigger /audit-plan, not /audit-code."
tags: [skill-triggering, pilot, audit-code-vs-audit-plan]
runs: 3
allowed_tools: [Read, Glob, Grep, Skill]
max_turns: 8
expected_outcome: "Claude invokes the audit-plan skill, not audit-code."
---

Here's a plan I drafted:

> ## Rate-limiting middleware
> Add a per-IP token bucket to the request pipeline. Each request costs
> one token; buckets refill at 10/minute. Requests over the limit get a
> 429. No persistence needed — in-memory is fine for a single instance.

Can you review this before we start building it?

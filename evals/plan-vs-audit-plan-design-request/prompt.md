---
name: plan-vs-audit-plan-design-request
description: "A greenfield design request should trigger /plan, not /audit-plan."
tags: [skill-triggering, pilot, plan-vs-audit-plan]
runs: 3
allowed_tools: [Read, Glob, Grep, Skill]
max_turns: 8
expected_outcome: "Claude invokes the plan skill, not audit-plan."
---

I want to add a small feature that lets a user export their dashboard as
a PDF. How should I structure this?

---
name: plan-vs-audit-plan-design-request
description: "A greenfield design request should trigger /plan, not /audit-plan."
tags: [skill-triggering, pilot, plan-vs-audit-plan]
runs: 3
allowed_tools: [Read, Glob, Grep, Skill]
max_turns: 5
expected_outcome: "Claude invokes the plan skill, not audit-plan."
---

I want to add a small CLI subcommand that lets a user re-run just the
memory-health gate's Metric 2 check in isolation, without running the
other two metrics. How should I structure this addition?

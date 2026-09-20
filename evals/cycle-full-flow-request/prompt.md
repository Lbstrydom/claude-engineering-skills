---
name: cycle-full-flow-request
description: "A request for the whole plan-to-ship workflow on autopilot should trigger /cycle, the orchestrator, not a single step like /plan directly."
tags: [skill-triggering, pilot, cycle-vs-plan]
runs: 3
allowed_tools: [Read, Glob, Grep, Skill]
max_turns: 8
expected_outcome: "Claude invokes the cycle skill, not plan."
---

I want to add a small feature that lets a user export their dashboard as
a PDF. Can you run the whole thing end to end — plan it, audit the plan,
and once it's built, audit and ship it — instead of me driving each step
by hand?

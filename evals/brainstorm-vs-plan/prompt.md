---
name: brainstorm-vs-plan
description: "Wanting another LLM's independent perspective before committing to an approach should trigger /brainstorm, not /plan."
tags: [skill-triggering, pilot, brainstorm-vs-plan]
runs: 3
allowed_tools: [Read, Glob, Grep, Skill]
max_turns: 8
expected_outcome: "Claude invokes the brainstorm skill, not plan."
---

Before I commit to an approach for our rate-limiting middleware, I want
to get GPT's independent take on it too, so I can compare perspectives
with yours.

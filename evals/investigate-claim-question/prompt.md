---
name: investigate-claim-question
description: "A claim needing measurement should trigger /investigate, not /explain."
tags: [skill-triggering, pilot, explain-vs-investigate]
runs: 3
allowed_tools: [Read, Glob, Grep, Skill]
max_turns: 5
expected_outcome: "Claude invokes the investigate skill, not explain."
---

Someone on the team claims the R2+ audit mode's post-output suppression
layer cut finding churn by 40% between rounds. Can you check whether
that number is actually right?

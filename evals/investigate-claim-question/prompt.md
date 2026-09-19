---
name: investigate-claim-question
description: "A claim needing measurement should trigger /investigate, not /explain."
tags: [skill-triggering, pilot, explain-vs-investigate]
runs: 3
allowed_tools: [Read, Glob, Grep, Skill]
max_turns: 8
expected_outcome: "Claude invokes the investigate skill, not explain."
---

A teammate told me our new caching layer cut checkout page load times by
40%. Can you check whether that number actually holds up?

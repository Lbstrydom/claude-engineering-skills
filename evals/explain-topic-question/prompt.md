---
name: explain-topic-question
description: "A WHY/topic question about existing code should trigger /explain, not /investigate."
tags: [skill-triggering, pilot, explain-vs-investigate]
runs: 3
allowed_tools: [Read, Glob, Grep, Skill]
max_turns: 8
expected_outcome: "Claude invokes the explain skill, not investigate."
---

Why is the sensitive-path check in this codebase structured as one
shared classifier function that every caller goes through, instead of
each caller implementing its own version?

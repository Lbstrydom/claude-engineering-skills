---
name: explain-topic-question
description: "A WHY/topic question about existing code should trigger /explain, not /investigate."
tags: [skill-triggering, pilot, explain-vs-investigate]
runs: 3
allowed_tools: [Read, Glob, Grep, Skill]
max_turns: 5
expected_outcome: "Claude invokes the explain skill, not investigate."
---

Why does `scripts/lib/sensitive-paths.mjs` sit behind a single classifier
instead of letting each of its four consumers implement their own
path-sensitivity check?

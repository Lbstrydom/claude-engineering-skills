---
name: explain-topic-question
description: "A WHY/topic question about existing code should trigger /explain, not /investigate."
tags: [skill-triggering, pilot, explain-vs-investigate]
runs: 3
allowed_tools: [Read, Glob, Grep, Skill]
max_turns: 8
expected_outcome: "Claude invokes the explain skill, not investigate."
---

Why would a shared library expose one canonical validation function that
every caller goes through, instead of letting each caller re-implement
the same check on its own?

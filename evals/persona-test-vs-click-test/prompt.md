---
name: persona-test-vs-click-test
description: "A journey-level 'explore as a user' request should trigger /persona-test, not /click-test (structural DOM audit)."
tags: [skill-triggering, pilot, persona-test-vs-click-test]
runs: 3
allowed_tools: [Read, Glob, Grep, Skill]
max_turns: 8
expected_outcome: "Claude invokes the persona-test skill, not click-test."
---

Can you explore our checkout flow as a first-time user and tell me if
anything about the experience feels confusing or frustrating?

---
name: ai-context-management-drift-check
description: "Asking whether AGENTS.md and CLAUDE.md have drifted apart should trigger /ai-context-management, not /explain."
tags: [skill-triggering, pilot, ai-context-management-vs-explain]
runs: 3
allowed_tools: [Read, Glob, Grep, Skill]
max_turns: 8
expected_outcome: "Claude invokes the ai-context-management skill, not explain."
---

Can you check whether our AGENTS.md and CLAUDE.md have drifted apart —
like one of them documenting a rule the other doesn't mention?

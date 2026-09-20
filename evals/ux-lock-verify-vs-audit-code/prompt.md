---
name: ux-lock-verify-vs-audit-code
description: "Checking whether a plan was actually built (live app) should trigger /ux-lock verify, not /audit-code (which reads only source)."
tags: [skill-triggering, pilot, ux-lock-vs-audit-code]
runs: 3
allowed_tools: [Read, Glob, Grep, Skill]
max_turns: 8
expected_outcome: "Claude invokes the ux-lock skill, not audit-code."
---

The dashboard is running at http://localhost:3000. The plan called for
a "Export as PDF" button next to the chart. Can you verify the plan was
actually built — did we actually ship what it called for?

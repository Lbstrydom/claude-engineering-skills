---
name: audit-code-request
description: "A request to review just-written code before a PR should trigger /audit-code, not /audit-plan."
tags: [skill-triggering, pilot, audit-code-vs-audit-plan]
runs: 3
allowed_tools: [Read, Glob, Grep, Skill]
max_turns: 8
expected_outcome: "Claude invokes the audit-code skill, not audit-plan."
---

Here's a diff I just wrote:

```diff
+function rateLimiter(req, res, next) {
+  const key = req.ip;
+  if (!buckets.has(key)) buckets.set(key, { tokens: 10, last: Date.now() });
+  const b = buckets.get(key);
+  b.tokens -= 1;
+  next();
+}
```

Can you audit this for correctness issues before I open a PR?

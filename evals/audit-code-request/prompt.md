---
name: audit-code-request
description: "A request to review just-written code before a PR should trigger /audit-code, not /audit-plan."
tags: [skill-triggering, pilot, audit-code-vs-audit-plan]
runs: 3
allowed_tools: [Read, Glob, Grep, Skill]
max_turns: 8
expected_outcome: "Claude invokes the audit-code skill, not audit-plan."
---

Here's the diff for the rate-limiting feature I just finished:

```diff
--- a/src/middleware/rateLimiter.js
+++ b/src/middleware/rateLimiter.js
+const buckets = new Map();
+
+function rateLimiter(req, res, next) {
+  const key = req.ip;
+  if (!buckets.has(key)) buckets.set(key, { tokens: 10, last: Date.now() });
+  const b = buckets.get(key);
+  b.tokens -= 1;
+  next();
+}
+
+module.exports = { rateLimiter, buckets };

--- a/src/middleware/index.js
+++ b/src/middleware/index.js
+const { rateLimiter } = require('./rateLimiter');
+
 module.exports = function registerMiddleware(app) {
   app.use(express.json());
+  app.use(rateLimiter);
   app.use(authMiddleware);
 };

--- a/src/routes/api.js
+++ b/src/routes/api.js
@@ -12,6 +12,7 @@ router.get('/health', (req, res) => {
 router.post('/orders', async (req, res) => {
+  // rate limiter runs before this handler now
   const order = await createOrder(req.body);
   res.json(order);
 });

--- a/test/rateLimiter.test.js
+++ b/test/rateLimiter.test.js
+const { rateLimiter, buckets } = require('../src/middleware/rateLimiter');
+
+test('allows requests under the limit', () => {
+  const req = { ip: '1.2.3.4' };
+  rateLimiter(req, {}, () => {});
+  expect(buckets.get('1.2.3.4').tokens).toBe(9);
+});
```

Can you audit this for correctness issues across all four files before
I open a PR?

---
name: explain-topic-question
description: "A WHY/topic question about existing code should trigger /explain, not /investigate."
tags: [skill-triggering, pilot, explain-vs-investigate]
runs: 3
allowed_tools: [Read, Glob, Grep, Skill]
max_turns: 8
expected_outcome: "Claude invokes the explain skill, not investigate."
---

Here's a function from this codebase:

```js
function checkPath(p) {
  return classifySensitivePath(p);
}
```

Every caller goes through `classifySensitivePath` instead of writing its
own check. Why is this structured that way and not the other way?

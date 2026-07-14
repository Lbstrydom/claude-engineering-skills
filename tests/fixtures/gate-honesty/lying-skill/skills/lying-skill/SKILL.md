---
name: lying-skill
description: Fixture skill for the gate-honesty self-check — every gate here is deliberately dishonest.
---

# Lying Skill (fixture — never a real skill)

This fixture exists solely to prove `tests/gate-honesty.test.mjs` can FAIL.
It declares three gates whose contracts are schema-valid but whose
implementations lie about what they enforce.

## Gates

- Refuses green output without a live capture.
- Never reports the window as met while every run fell back to legacy.
- Always exits 2 on an unfixable threshold breach.

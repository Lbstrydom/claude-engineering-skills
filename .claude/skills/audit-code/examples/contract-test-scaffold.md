---
summary: Contract-test scaffold — subject probe, negative control, vacuous-pass guard, disposition, retirement.
---

# Contract-Test Scaffold

Copy-paste skeleton for promoting a one-off check into a permanent contract
test. Framework-neutral — the shape is the point, not the assertion library.

**Why it has three parts.** The subject probe alone is the fail-open trap: a
check that has never been seen to fail is indistinguishable from a check that
cannot fail. Measured cost of skipping this: a container health check that had
**never passed on any image**, then sat **three weeks** after repair with nothing
in the repository able to detect its reversion.

Full rationale: `references/verification-discipline.md` §3 and §5.

---

## The skeleton

```js
/**
 * Contract: <the invariant, stated so a reader can disagree with it>
 *
 * Trigger:      <what made this worth guarding — the incident, the near-miss>
 * Finding:      <audit finding id, when one exists — do NOT open a second
 *                promotion record; the ledger already carries the remediation>
 * Disposition:  temporary-guard | promoted-durable-contract | retired
 * Successor:    <path to the contract that replaces this, when promoted or
 *                replaced. Name it here even before it exists.>
 * Retires when: <REQUIRED for temporary-guard: the named test or command that
 *                goes RED once the condition passes — expiry expressed in the
 *                MECHANISM, never in a comment.>
 */
describe('contract: <invariant>', () => {
  // 1. SUBJECT PROBE — the assertion itself.
  it('<the invariant, as a sentence>', () => {
    expect(actual, '<what to do when this fails, not just what failed>')
      .toEqual(expected);
  });
});

describe('the detector is actually reading something (vacuous-pass guards)', () => {
  // 3. VACUOUS-PASS GUARD — MANDATORY when the real assertion is "expect empty".
  //    A silently broken search returns nothing, which is what passing looks
  //    like. Prove the probe can find something it MUST find.
  it('the probe works at all', () => {
    expect(probe(somethingItMustFind)).not.toHaveLength(0);
  });

  // Where the subject has several independent failure modes, prove the
  // classifier still DISCRIMINATES between them. If these ever agree, the
  // contract above is passing for free.
  it('classifies the two known cases in opposite directions', () => {
    expect(classify(knownGood)).toBe('ok');
    expect(classify(knownBad)).toBe('violation');
  });
});
```

### 2. Negative control — run it, then record it

Not a test file; a step you perform once and write down.

```
- Break the subject   → run → RED. Paste the failure text.
- Break HALF of it    → run → still RED, naming only the remaining defect.
- Restore             → run → GREEN.
```

**One defect at a time is not ceremony.** Two bugs on one line can mask each
other — that is exactly how the health check shipped broken for months, with
each defect making the other invisible, so a half-fix changed nothing
observable and read as no fix at all.

**A before/after observation is not a negative control.** Watching a
*pre-existing* defect go red→green says nothing about whether the *repaired*
check would go red again.

---

## Worked example — a shrinking allowlist that named its own successor

A ratchet guarding a coexistence window, written to be retired:

```js
/**
 * Contract: no NEW file may import the legacy implementation.
 *
 * Disposition:  temporary-guard
 * Successor:    tests/<subject>-retired.test.js
 * Retires when: the allowlist collapses to empty — i.e. the promotion PR
 *               deletes the legacy directory. At that point this file is
 *               CONVERTED, not deleted: a deleted test asserts nothing, and
 *               the live failure mode becomes RESURRECTION.
 */
```

It converted exactly as written when the window closed. The successor now
asserts the directory stays deleted.

Two more predicates from the same family, both expiry-in-mechanism:

- a pinned-certificate rotation alarm that **fails CI 180 days before** the
  certificate expires — the deadline cannot be forgotten because the build
  raises it;
- a sunset contract that fails CI if a surface reaches `migrated` while its
  legacy branch still exists — the deletion is forced by the phase flip.

---

## Before you commit it

- [ ] Subject probe asserts the invariant, and its failure message says what to **do**.
- [ ] Negative control **run**, one defect at a time, output recorded.
- [ ] Vacuous-pass guard present if the assertion is "expect empty".
- [ ] `Disposition` set. If `temporary-guard`, `Retires when` names a real test or command.
- [ ] Scope limits stated in the docblock — what this contract does **not** understand.
      (A healthcheck contract is not a general route-auth oracle; say so before
      someone reuses it as one.)

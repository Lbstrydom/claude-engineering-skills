# Plan: The five aged-out acceptances that are real, still live, and no longer surfaced

- **Date**: 2026-09-04
- **Status**: Draft — evidence gathered, no code written. Each item below was
  re-verified against the tree at `8178f062` and reproduced; none is a
  hypothesis carried over from its original audit.
- **Author**: Claude + Louis
- **Scope**: backend + one skill reference

---

## 1. Why this document exists

`unremediated_acceptances_all` stops surfacing a row 30 days after its audit
run. Seventeen rows crossed that ceiling in this repo, which means the only
thing that would ever happen to them is silence — they are accepted findings,
so nothing re-raises them, and they are past the ship gate's window, so nothing
nags about them.

Working that queue on 2026-09-04 closed twelve of the seventeen: nine were
already fixed and merely unlabelled, and three were written off against
measurements (recorded in `status.md` under this date). **These five were not.**
Each is a real defect that is still present in the tree, and each is now
invisible to every automated surface in the repo. A store row cannot express
"real, still open, no longer nagged about" — `remediation_state` runs
pending/planned/fixed/verified/regressed and adjudication offers only
accepted/dismissed — so this document is the durable home instead.

**Do not close these by dismissing them.** `dismissed` reads as "not a real
finding", and all five reproduce.

---

## 2. The debt ledger's persisted record has no enforced contract (3 findings)

Three findings, one subject. Measured against the **store**, which is the debt
ledger's durable home since `411b6bd5`, scoped to this repo (`debt_entries`,
222 rows) — and cross-checked against the local `.audit/tech-debt.json`
(106 entries), which agrees:

| Finding | Severity | Claim | Measurement 2026-09-04 |
|---|---|---|---|
| `75981b9b` | HIGH | semantic-hash and alias fields exist but are not applied consistently | **0 of 222** entries carry `content_aliases`; 222 distinct `semantic_hash`, 0 duplicate groups |
| `dd651e36` | HIGH | records persist an empty classification while newer ones use a structured object | **181 of 222** carry neither `sonar_type` nor `effort`; 41 classified. Locally: 65 of 106 have `classification: null` |
| `92fe5776` | MEDIUM | deferred records have no canonical/superseded link, review deadline, expiry, successor, or revalidation state | **10 of 222** carry any of `blocked_by`/`followup_pr`/`approver`/`policy_ref`; **no** review-deadline or expiry column exists at all |

The aliasing claim deserves care: `content_aliases` being applied to *nothing*
is not the same as duplicates being absent. `semantic_hash` is content-derived,
so it cannot see the duplication the finding actually described — six audit
units independently reporting the same defect in different words. A dedup
oracle keyed on a content hash is structurally unable to catch a re-worded
re-raise, which is the same reason pgvector was promoted for `audit_findings`
(AGENTS.md, "pgvector promoted"). Any fix here should reuse that machinery
rather than grow a second one.

Neither `phase-b-sonarqube-classification.md` nor `phase-d-tech-debt-memory.md`
covers this — both are marked Complete, and Phase D's status line still
describes the ledger as "a committed, repo-level debt ledger", the premise
`411b6bd5` proved false.

**Not attempted here** because a classification backfill across 181 entries is
a per-entry judgement, not a migration, and an aliasing pass needs a semantic
clustering decision. Both are larger than a queue-clearing session and would be
band-aided by a token fix.

## 3. `find-rmsync-sites` cannot see an alias derived from an fs namespace (`b091a8ab`, MEDIUM)

Reproduced directly against `findRmSyncCallSites`:

| Source shape | Sites found |
|---|---|
| `import * as fs …; fs.rmSync(…)` | 1 |
| `import fs …; fs.rmSync(…)` | 1 |
| `import { rmSync } …; rmSync(…)` | 1 |
| `import * as fs …; const { rmSync } = fs; rmSync(…)` | **0** |
| `import * as fs …; const rm = fs.rmSync; rm(…)` | **0** |
| `function f(fs) { fs.rmSync(…) }` (shadowed) | 0 — correct |

The shadowing case still resolving to 0 is the negative control: the resolver
is not simply broken, it is missing one shape.

**There is a live instance.** `scripts/regenerate-skill-copies.mjs` injects
`rmSyncFn = fs.rmSync` as a default parameter (line 93) and calls `rmSyncFn(…)`
at line 113. `findRmSyncCallSites` on that file returns exactly one site — at
line **246**, a different, direct call. The aliased call is invisible to
`tests/rmsync-retry-guard.test.mjs`.

That call happens to pass `maxRetries: 3, retryDelay: 50` today, so nothing is
broken right now. The defect is that it is compliant *by authorship* rather
than by enforcement: delete those options and the guard stays green.

**Fix shape**: teach `scripts/lib/import-binding.mjs` to trace a binding whose
initialiser is a member expression on, or a destructuring of, a resolved fs
namespace binding — including the default-parameter form, which is the one that
occurs here. The finding's own note that this "spans both the resolver
implementation and its test coverage" is right; the risk is false positives, so
the shadowing control above must stay at 0.

## 4. The visual-audit contract reference hand-reproduces `schema.mjs` (`e3da8d42`, MEDIUM)

`skills/visual-audit/references/contract-and-bootstrap.md` still carries a
field-level `Schema (v1)` block while `scripts/lib/visual/schema.mjs` is the
executable source of truth. The schema is strict, so a field documented but not
implemented (or vice versa) produces a contract that fails only at runtime.

**The obvious fix is the wrong one.** The doc is an *annotated* example — each
field carries an inline comment saying what it is FOR, which a Zod schema does
not encode and a generator would destroy. Deduplicating would lose the thing
that makes the reference useful.

**Fix shape**: a drift gate, not deduplication — assert that every key in the
doc's example appears in the emitted schema and vice versa, asked of
`z.toJSONSchema(...)` rather than the Zod source. That is exactly the discipline
AGENTS.md already states for the prose↔code seam ("a prompt that names a field
is a claim about a contract you have not checked"), applied to a reference doc
instead of a prompt.

---

## 5. Acceptance criteria

- [ ] §2: every `debt_entries` row for this repo either carries a
      classification or is explicitly recorded as unclassifiable, and the
      writer refuses a new row that is neither.
- [ ] §2: a decision recorded on whether `content_aliases` is load-bearing; if
      it is, it is populated by the same semantic machinery `audit_findings`
      uses, not a second one. If it is not, the field is removed.
- [ ] §2: deferred entries carry a revalidation trigger, or the concept is
      dropped and the doc says so.
- [ ] §3: the two alias shapes in the table resolve to 1; the shadowing control
      still resolves to 0; `regenerate-skill-copies.mjs` reports 2 sites.
- [ ] §4: a gate fails when a key exists in the doc example but not the emitted
      schema, and when one exists in the schema but not the doc.

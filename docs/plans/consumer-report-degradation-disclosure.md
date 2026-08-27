# Plan: Degradation Disclosure — Debate Skip + Audit Prerequisite Ladder

- **Date**: 2026-08-27
- **Status**: Complete — both changes shipped (`c2f9f068` brainstorm, `30445802`
  audit family) and audited over 6 GPT rounds plus the Gemini final gate.
- **Origin**: A consumer report batch. Five reports were described; **none of
  the five ids existed in `upstream_issues`**, and the `repo_id`
  `44ac33c3-…` matched no `audit_repos` row, so nothing was acked, fixed or
  closed. The technical claims were nonetheless checked on their merits and
  three held up. Two are implemented here; the third (the dead runbook pointer
  in the worktree-preflight marker) shipped separately as `13acf83e` and is out
  of scope for this document.
- **Audit trail**: *(to be filled by /audit-code)*

## Problem

Both changes are instances of one defect class: **a state the system enters and
does not disclose, where the undisclosed state is indistinguishable from a
benign one.**

### A — a cancelled `--debate` round looked like an unrequested one

`runDebateRound` returned a bare `[]` on every skip, and the caller emitted
`debate: []`. A run *without* `--debate` emits exactly that value. So an agent
following `skills/brainstorm/SKILL.md` rendered no debate block and no
explanation — after the user had already paid for round 1. The single-provider
case was worse than undisclosed in the envelope: the stderr WARN was itself
nested inside `if (providers.length === 2)`, so that path was silent on every
surface at once.

### B — the audit family had no defined behaviour for an absent prerequisite

`/audit-plan`, `/audit-code` and `/cycle` stated prerequisites ("Validate: plan
file exists, `OPENAI_API_KEY` is set") and said nothing about the other branch.
The flow died mid-run on a bare `MODULE_NOT_FOUND` or a one-line key error,
**after** the user had paid to produce the artifact being audited.

Two skills in this repo already modelled the answer and neither was applied:
`/ship` degrades and prints a one-line disclosure, and
`docs/audit/shared-references/gemini-gate.md` (synced to
`skills/{audit-plan,audit-code}/references/gemini-gate.md`) defines a ladder for
a missing final-reviewer key.
That ladder covers the *final reviewer* only — not the GPT legs, and not the
helper scripts themselves.

## Design

**Right-sizing.** The band-aid for A is a louder stderr line (invisible to the
agent reading the envelope). The over-built version is a general
"cancelled-step" framework across every skill. The correct size is one nullable
envelope field with a closed reason set, mirroring the `artifactContext`
precedent that already exists in the same schema for the same
not-requested-vs-requested-and-empty distinction.

For B the band-aid is a sentence per skill (three copies, guaranteed to drift);
the over-built version is a new machine-readable "gate outcome" table in the
store. The correct size is **one synced shared reference** plus **reuse of the
state vocabulary that already exists** — the Step 6 census words
(`completed`/`errored`/`unavailable`/`not-reached`),
`.audit/last-audit-run.json`, and `AI-Gate: not-run`.

### A — `debateSkipped`

- New pure module `scripts/lib/brainstorm/debate-outcome.mjs` exporting
  `classifyDebateOutcome({providers, round1})` and `DEBATE_SKIP_REASONS`.
  Extracted because `scripts/brainstorm-round.mjs` exports nothing, so the
  decision had no boundary a test could reach — which is why the defect
  survived. Same pure-decide / impure-shell split as
  `gate-honesty/verb-pattern.mjs`.
- Closed reason set: `not-a-pair` (a debate needs exactly two voices) and
  `round-1-incomplete` (no peer response to react to). `truncated` deliberately
  does **not** qualify as a peer response: the debate prompt quotes it verbatim
  as the thing to pressure-test.
- Envelope field `debateSkipped`: `null` when not requested or when the round
  ran; `{reason, detail}` when requested and cancelled.
- Required on `BrainstormEnvelopeWriteSchema` so a writer that omits the key
  fails at the boundary. `.optional()` on the V2 read schema for legacy rows.
- `session-store.mjs`'s read-side normaliser canonicalises it to `null`
  alongside the arch fields — a read-modify-write is a constructor as far as
  the write schema is concerned.
- `skills/brainstorm/SKILL.md` gains the render rule + a reason→message table.

### B — the prerequisite ladder

- `docs/audit/shared-references/prerequisite-ladder.md`, registered in
  `sync-shared-audit-refs.mjs`'s `EXPECTED_CONSUMERS` for `audit-plan` and
  `audit-code` (one canonical copy, not two hand-written paragraphs).
- Rung 0 resolve — hydrate an absent tooling tree; ask whether a **route**
  exists (`OPENAI_API_KEY` **or** an active Azure profile), never whether one
  public variable is set.
- Rung 1 no auditor route — disclose, offer the **labelled** adversarial-agent
  substitute, report `AUDIT_DEGRADED` with `unavailable` census rows.
- Rung 2 bundle absent and unhydratable — report `AUDIT_NOT_RUN` and stop.
- Rung 3 machine-visible outcome, reusing existing mechanisms only.
- `/cycle` resolves the same prerequisites at Step 0, before it spends on
  `/plan`.

## Files Changed

Recorded because round 6 (L2) flagged that the plan described the work without
naming what it touched, so no reader could check the two against each other.
Generated copies under `.claude/skills/` and `skills.manifest.json` are
regenerated artifacts, listed for completeness rather than hand-edited.

- `.claude/skills/audit-code/SKILL.md`
- `.claude/skills/audit-code/references/gemini-gate.md`
- `.claude/skills/audit-code/references/prerequisite-ladder.md`
- `.claude/skills/audit-plan/SKILL.md`
- `.claude/skills/audit-plan/references/gemini-gate.md`
- `.claude/skills/audit-plan/references/prerequisite-ladder.md`
- `.claude/skills/brainstorm/SKILL.md`
- `.claude/skills/cycle/SKILL.md`
- `docs/audit/shared-references/gemini-gate.md`
- `docs/audit/shared-references/ledger-format.md`
- `docs/audit/shared-references/prerequisite-ladder.md`
- `scripts/brainstorm-round.mjs`
- `scripts/lib/brainstorm/debate-outcome.mjs`
- `scripts/lib/brainstorm/schemas.mjs`
- `scripts/lib/brainstorm/session-store.mjs`
- `scripts/sync-shared-audit-refs.mjs`
- `skills.manifest.json`
- `skills/audit-code/SKILL.md`
- `skills/audit-code/references/gemini-gate.md`
- `skills/audit-code/references/ledger-format.md`
- `skills/audit-code/references/prerequisite-ladder.md`
- `skills/audit-plan/SKILL.md`
- `skills/audit-plan/references/gemini-gate.md`
- `skills/audit-plan/references/ledger-format.md`
- `skills/audit-plan/references/prerequisite-ladder.md`
- `skills/brainstorm/SKILL.md`
- `skills/cycle/SKILL.md`
- `tests/brainstorm-arch-context.test.mjs`
- `tests/brainstorm-debate-skip-disclosure.test.mjs`
- `tests/brainstorm-resume-context.test.mjs`
- `tests/brainstorm-session-sid-scope.test.mjs`
- `tests/brainstorm-session-store.test.mjs`

## Acceptance Criteria

- **AC1** — a `--debate` run with one provider emits `debateSkipped.reason ===
  'not-a-pair'`, and the detail names the actual voice count.
- **AC2** — a `--debate` run with two providers where one failed round 1 emits
  `debateSkipped.reason === 'round-1-incomplete'`, and the detail names both
  providers and their states.
- **AC3** — a successful two-provider debate emits `debateSkipped === null` and
  a non-empty `debate` array.
- **AC4** — `BrainstormEnvelopeWriteSchema` rejects an envelope with no
  `debateSkipped` key, and accepts both `null` and a well-formed skip object.
- **AC5** — `BrainstormEnvelopeV2Schema` still accepts a legacy row with no
  `debateSkipped` key, and `loadSession` normalises it to `null`.
- **AC6** — a reason outside `DEBATE_SKIP_REASONS` is rejected by the schema.
- **AC7** — `node scripts/sync-shared-audit-refs.mjs --check` reports the
  `prerequisite-ladder.md` pairs as **in sync**, and its `summary:` frontmatter
  byte-matches the reference-index row in both SKILL.md files
  (`npm run skills:check`).

  > Corrected after round-1 audit (M1), then corrected again after round-2 (L1).
  > The first draft required the three copies to be **byte-identical**, which is
  > explicitly **not** an invariant of the shared-reference mechanism:
  > `renderForTarget` rewrites `./`- and `../`-prefixed link targets per
  > destination directory and substitutes the canonical's self-description for a
  > **GENERATED COPY — do not edit** banner. Asserting byte-identity would have
  > made this plan's criterion contradict the synchronizer.
  >
  > The round-1 note then claimed the copies "currently are byte-identical —
  > measured", which was true when written and **false by the time the same
  > round-1 fix landed**: adding the self-description for AC7b is precisely what
  > triggers the banner substitution, so the copies diverged at that moment.
  > Round 2 caught the stale sentence. Measured now: `cmp` reports the canonical
  > and the `audit-code` copy DIFFER, by the banner, exactly as designed. The
  > criterion names the check `npm run check` actually runs.
- **AC7b** — the canonical carries the self-description sentence
  `renderForTarget` substitutes for its **GENERATED COPY — do not edit** banner,
  so a reader who opens a skill copy is told it is generated.
- **AC8** — no new SKILL.md line introduced by either change is an
  undispositioned enforcement-verb candidate (`npm run skills:check`'s D6).
- **AC9** — `npm run check` exits 0.

## Out of Scope

- The five upstream reports themselves: they do not exist in the store, so no
  `ack`/`fix`/`wont-fix` transition is possible or was attempted.
- The claim that an aborted `/brainstorm` provider call is classified
  `malformed`: **checked and false** — all three adapters map
  `AbortError`/`ABORT_ERR` to `timeout`. `malformed` is the catch-all for
  errors carrying neither a name nor a status (a network failure lands there);
  that is a separate, unreported naming question and is not addressed here.
- The claim that the audit family has no degradation ladder at all: **partly
  false** — `references/gemini-gate.md` is already a shared reference in both
  audit skills and defines a four-rung ladder including `FINAL_GATE_SKIPPED`.
  Only the GPT-leg and helper-bundle branches were genuinely undefined.
- The Azure-profile substitution warning in `/brainstorm`, which the reporter
  singled out as correct: deliberately untouched.

## Implementation Log

### 2026-08-27
- Completed: `debateSkipped` envelope field with a shared `isDebateEligible`
  oracle; `docs/audit/shared-references/prerequisite-ladder.md` synced into
  both audit skills and `/cycle`'s Step 0. Audited over 6 GPT rounds plus a
  two-pass Gemini final gate (CONCERNS_REMAINING → APPROVE after Step 7.1
  deliberation).
- Remaining: none against the stated ACs. Three unrelated pre-existing
  defects surfaced and deferred with independence stated (`/cycle` Step 3
  mode-table contradiction; `syncPairs` split-root coupling; `skills:hydrate`
  non-atomic bootstrap) — out of scope, not this change's obligation.
- Deviations: AC7 was rewritten mid-audit (round-1 M1) from "byte-identical
  copies" to "sync-shared-audit-refs --check reports in sync" — the original
  criterion contradicted the synchronizer's own designed behaviour. The round-6
  audit (M5) also found and fixed a validation-bypass and a silent-no-op defect
  neither introduced by this change's stated scope but load-bearing on it
  (the union schema, the provenance-banner substitution) — both in-scope by
  impact per AGENTS.md's triage rule.

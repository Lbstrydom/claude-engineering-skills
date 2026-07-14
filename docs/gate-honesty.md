# Gate-Honesty Suite

Executable binding between a skill's STATED gate/convergence rule and the
code + test that actually enforces it. Plan + full audit trail:
[`docs/plans/provenance-trailers-and-gate-honesty.md`](plans/provenance-trailers-and-gate-honesty.md)
§F2. Bug class this closes: a SKILL.md describes a gate that the scripts
don't enforce, or enforce differently (three documented past instances —
see the plan's §F2.1 before-state).

## Contract format

A skill opts in by adding `skills/<name>/gate-contract.json`:

```json
{
  "version": 1,
  "skill": "audit-code",
  "gates": [
    {
      "id": "convergence-threshold",
      "kind": "executable",
      "oracle": "convergence-threshold",
      "statedIn": "skills/audit-code/SKILL.md",
      "stated": "Quality threshold: `HIGH == 0 && MEDIUM <= 2 && quickFix == 0`",
      "implementation": "scripts/lib/audit/convergence.mjs",
      "tests": ["tests/gate-honesty.test.mjs"],
      "params": { "high": 0, "medium": 2, "quickFix": 0 },
      "proof": "unit-seam"
    },
    {
      "id": "mechanical-vs-architectural-label",
      "kind": "document-only",
      "reason": "is_mechanical is a GPT judgement call; no mechanical oracle exists"
    }
  ]
}
```

The file is repo-local test metadata — colocated with the skill for
visibility, but never packaged, never synced to consumers (`SKILL_LOCAL_FILES`
in [`scripts/lib/skill-packaging.mjs`](../scripts/lib/skill-packaging.mjs)
tolerates it at a skill's root and excludes it from the returned file list;
`enumerateSkillFiles` still rejects any OTHER non-markdown file). No contract
= that skill is `uncontracted` — reported, never a failure.

## Gate kinds

- **`kind: "executable"`** — mechanically checkable. Discriminated by
  `oracle` (a closed v1 registry, see below); each variant declares its own
  extra field (`params` / `fixture` / `scenario`). Validated: `implementation`
  and every `tests[]` entry exist and are repo-root-contained
  (realpath-resolved, fail-closed — INC-001); each `tests[]` file's text
  references the gate `id`; `stated` appears verbatim in the file named by
  `statedIn`; the oracle runs and its result must be `ok`.
- **`kind: "document-only"`** — a judgement call. Only `{id, kind, reason}`
  are required (optional `statedIn`/`stated` are unvalidated pointer
  metadata). **Schema-refuses** an `oracle`/`implementation`/`params` on a
  document-only gate — the fake-check guard: you cannot smuggle a mechanical
  claim onto a gate you've declared can't be mechanically checked.

## `statedIn` — the closed source-authority policy

Exactly `skills/<contract.skill>/SKILL.md` (the owning skill's own file) or
exactly `AGENTS.md`. A different skill's SKILL.md, an arbitrary docs path,
a traversal path, or a symlink escaping the repo are all schema/policy
invalid — never silently accepted. One shared `validateGateContract`
(`scripts/lib/gate-honesty/schema.mjs`) enforces this for the loader, the
test suite, and `check-gate-contracts.mjs` alike — no drift between callers.

## Oracle registry (v1, closed set)

A plain `Map` + four adapter functions
([`scripts/lib/gate-honesty/oracles.mjs`](../scripts/lib/gate-honesty/oracles.mjs)).
Each imports or spawns the REAL production seam named by `implementation` —
same-module identity, never a lookalike. An unknown `oracle` id fails schema
validation before any adapter runs.

| Oracle | Extra field | What it asserts |
|---|---|---|
| `convergence-threshold` | `params: {high, medium, quickFix}` | imports the module, asserts `CONVERGENCE_THRESHOLDS` equals `params` and `evaluateConvergence`'s truth table at the boundary |
| `tiered-shadow-window` | `fixture: {rows: [...]}` | imports `summarize`/`windowProgress`, asserts fallback_legacy rows never count toward `comparedRuns` |
| `visual-gate-unverified` | (none) | imports `gateUnverifiedReason`, asserts its truth table across a fixed internal scenario set |
| `cli-exit` | `scenario` (closed enum) | spawns the real CLI with a registry-owned fixture + args, asserts exit code + stderr pattern |

`proof: "process" | "unit-seam"` is printed per gate: `process` means the
oracle reached the real CLI's exit decision; `unit-seam` means it asserted
the production-owned decision function directly (the process-level wiring
wasn't independently forceable in v1 — see `partial-matrix-refusal` below
for the worked example of what happens when even that isn't true).

## Pinned v1 census

| Skill | Executable (oracle) | Document-only |
|---|---|---|
| audit-code | `convergence-threshold`, `tiered-shadow-window-honesty` | `mechanical-vs-architectural-label`, `rigor-pressure-stop` |
| visual-audit | `static-gate-refusal` (cli-exit), `empty-capture-unverified`, `gate-unverified-reasons` (both visual-gate-unverified) | `partial-matrix-refusal`, `vlm-advisory-only` |

`tests/gate-honesty.test.mjs` pins this exact set — an intentional coverage
change requires editing that test, not a silent drift.

**Recorded deviation** (2026-07-14, Cluster B implementation):
`partial-matrix-refusal` was moved from executable to document-only. The
plan's original table assigned it the `visual-gate-unverified` oracle, but
that check (`visual-audit.mjs`'s `ext.missingStates.length` partial-capture
refusal) is inline with no independently-importable pure predicate — unlike
`gateUnverifiedReason`, there's nothing to import and assert against.
Claiming a unit-seam oracle for it would have been exactly the fake-check
this suite exists to prevent. Extracting a dedicated predicate is out of
this plan's declared file scope (F2.8 never listed `visual-audit.mjs` or
`lib/visual/drift.mjs` as touched); tracked as a v2 follow-up.

## Self-honesty: the lying-skill fixture

`tests/fixtures/gate-honesty/lying-skill/` declares three schema-valid
executable gates against three different oracles, each backed by a fake
implementation that lies in an oracle-appropriate way (wrong exit code,
wrong exported convergence constants, fallback runs counted as compared).
The suite asserts all three are caught as `divergent` — if this count is
ever below 3, the suite has a blind spot. Three further fixtures under
`tests/fixtures/gate-honesty/negative/` isolate the remaining
loader/schema failure modes one at a time: a missing implementation path,
an absent `stated` string, and a document-only gate illegally carrying
`params`.

## Failure output

```text
[audit-code][convergence-threshold] stated "params {...}"; found "CONVERGENCE_THRESHOLDS {...} (path)"
```

## Passing-run report

Every count is derived at run time — no literal numbers in suite code:

```text
gate-honesty: CHECKED 5 executable gate(s) across 2 contracted skill(s):
  audit-code: convergence-threshold, tiered-shadow-window-honesty
  visual-audit: static-gate-refusal, empty-capture-unverified, gate-unverified-reasons
gate-honesty: NOT CHECKED — 4 document-only gate(s) (judgement, listed not verified):
  ...
gate-honesty: UNCONTRACTED skills (no gate-contract.json): ...
```

A green run never implies judgement-level verification or full skill
coverage — non-coverage is in the output, every run.

## Running it

```bash
node --test tests/gate-honesty.test.mjs   # the suite, standalone
npm run gates:check                        # scripts/check-gate-contracts.mjs, standalone
npm run skills:check                       # includes gates:check — pre-push gate
```

**`gates:check`/`skills:check` are schema-and-path-only — they do NOT run
the oracles.** They validate shape, the `statedIn` policy, path containment,
and the `tests[]`-references-id rule (fast, no browser/process spawns). The
*behavioral* check — does the oracle's real production seam actually match
what the contract claims — only runs inside `tests/gate-honesty.test.mjs`,
which `npm run check`'s final `test` step always executes. A contract can
therefore pass `gates:check` alone and still fail the full suite if its
`params`/`fixture` silently drifted from the code; that split is
deliberate (fast structural gate vs. the fuller behavioral gate), not a
gap — `npm run check` runs both.

## Contracting a new skill

1. Add `skills/<name>/gate-contract.json` (version 1, `skill` matching the
   directory name).
2. For each STATED gate: pick an oracle from the closed registry above (or
   file a plan to extend it — the registry is deliberately small; see the
   `partial-matrix-refusal` deviation for what "no real oracle exists yet"
   should look like instead of forcing one).
3. If no mechanical oracle fits, declare `kind: "document-only"` with an
   honest `reason` — never invent a `stated`/`oracle` pairing that doesn't
   independently prove anything.
4. `npm run gates:check` — it validates the shape, the `statedIn` policy,
   path containment, and the `tests[]`-references-id rule before you ever
   run the suite.

## Explicitly out of scope (v1)

Contracts for the other 6+ skills; nav-audit/ux-lock/persona-test gates;
mutation testing beyond the lying fixture; SKILL.md generation from the
contract (would touch `skills:regenerate`, the repo's highest-blast-radius
sync seam — v2, contingent on observed contract↔prose drift); CI service
integration beyond the existing local-first pre-push hook.

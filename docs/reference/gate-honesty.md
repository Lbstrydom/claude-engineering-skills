# Gate-Honesty Suite

Executable binding between a skill's STATED gate/convergence rule and the
code + test that actually enforces it. Plan + full audit trail:
[`docs/plans/provenance-trailers-and-gate-honesty.md`](../plans/provenance-trailers-and-gate-honesty.md)
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
in [`scripts/lib/skill-packaging.mjs`](../../scripts/lib/skill-packaging.mjs)
tolerates it at a skill's root and excludes it from the returned file list;
`enumerateSkillFiles` still rejects any OTHER non-markdown file). A skill with
no contract file is `uncontracted` — and, since Phase D, that is a **failure**
unless the skill is listed in the baseline (see "Net-new-skill ratchet" below).
All 16 skills are contracted today, so the baseline is empty. (`investigate`,
added 2026-08-04, was the first net-new skill to meet the Phase-D ratchet —
it shipped with a `gates: []` declaration rather than a baseline exemption,
which is the intended path.)

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

### `stated` is a VERBATIM quote — the mechanical do-not-condense list

`stated` must appear **character-for-character** in `statedIn` —
`fileTextContains` is an EOL-normalised plain substring test, with no fuzzy
match, no whitespace folding and no markdown awareness.
`check-gate-contracts.mjs` fails with "not found verbatim — prose/contract have
drifted" on any rewording, and it runs inside `npm run check`.

**The subtlest way to break one is markdown emphasis**, because the `*`
characters are part of the substring and are invisible when you read the
rendered file. A contract quoting

```text
generated copy — run `npm run skills:regenerate`
```

is NOT satisfied by prose that reads

```markdown
`.claude/skills/<name>/` is the **generated copy** — run `npm run skills:regenerate`
```

— the `**` sits between `generated copy` and the space, so the substring is
absent. Moving emphasis onto an adjacent phrase, or re-wrapping a line so a
quoted span breaks across two lines with different leading indentation, breaks a
quote just as surely as rewording it. This cost one of the 15 breakages below,
and it is the failure most likely to bite a prose reflow.

That makes every `statedIn: AGENTS.md` quote a **do-not-condense list the
always-loaded file does not advertise** — and unlike a judgement call about what
is a tripwire, a gate cannot forget. **Measured 2026-11-15: 26 gates quote
AGENTS.md, and a single condensation pass broke 15 of them** (the other 11
survived only because that pass happened not to reflow their lines) — so treat
the whole 26 as pinned, not the subset that failed last time. Rewording a pinned
sentence is a decision to re-word the contract too, not a copy-edit.

**List them before editing AGENTS.md** (prints `id` + the exact quoted text):

```bash
node -e "for (const p of require('fs').globSync('{skills/*,scripts/gate-contracts}/*.json')) for (const g of (require('./'+p).gates||[])) if (g.statedIn==='AGENTS.md') console.log(p, '|', g.id, '|', JSON.stringify(g.stated))"
```

**Do not pipe that through `head`, and do not truncate its output.** The list is
the whole point, and a short read of it under-reports what is pinned — on
2026-11-15 a reviewer piped it `| tee file | head -5`, `head` closed the pipe and
SIGPIPE'd the writer mid-stream, 11 of 26 lines reached the file, and a correct
count of 26 was nearly "corrected" to 11. Redirect to a file or read it whole,
then count.

Restore a broken quote to its exact prior wording (`git show HEAD~1:AGENTS.md`)
rather than editing the contract, unless the gate's meaning genuinely changed.

## Oracle registry (v1, closed set)

A plain `Map` + four adapter functions
([`scripts/lib/gate-honesty/oracles.mjs`](../../scripts/lib/gate-honesty/oracles.mjs)).
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

## Net-new-skill ratchet (Phase D)

Once every skill is contracted, the system must not silently regress the
moment someone adds a 16th skill. The ratchet
([`scripts/lib/gate-honesty/ratchet.mjs`](../../scripts/lib/gate-honesty/ratchet.mjs)
+ the `checkRatchet` shell in `check-gate-contracts.mjs`) makes **declaring a
gate-honesty status mandatory** for every skill root: a `gate-contract.json`,
or a baseline exemption. A skill that declares neither fails `npm run check`.

The set rules (pure, in `computeRatchetDivergences`), all emitted in
deterministic skill-root order, never a silent pass:

1. **Declare-or-fail** — a skill root whose `gate-contract.json` is *absent*
   AND which is not baselined → fail. (A *present-but-broken* contract is
   already a loader divergence, so the ratchet stays silent on it to avoid a
   double report.)
2. **Contract↔directory identity** — a contract's `skill` field must equal its
   directory name, or the loader's by-`skill` keying would silently
   misattribute it.
3. **Baseline integrity** — a stale exemption (root no longer exists), a
   duplicate exemption, or an exemption for a skill that *now* has a contract
   (redundant) each fail.

Fail-closed fs handling in the shell: the baseline path and every present
`gate-contract.json` must be a **regular file** — a symlink is rejected (it
could point the checker at attacker-chosen bytes). A malformed-JSON or
schema-invalid baseline fails before the set rules run (never adjudicate
garbage); an *absent* baseline is treated as empty exemptions — still strict,
because the ratchet forces a real contract regardless.

**The baseline** — [`.gate-contract-baseline.json`](../../.gate-contract-baseline.json),
`{version:1, exemptions:[{skill, reason}]}`, committed and empty in the release
state. An entry is a *declared, reasoned* deferral (a new skill with no CLI
seam yet), never a silent gap — and it must be removed once the skill earns a
contract.

The ratchet is proven non-opt-in by a worktree integration test
([`tests/gate-contract-ratchet.test.mjs`](../../tests/gate-contract-ratchet.test.mjs)):
it runs the **real** checker binary against an otherwise-valid synthetic skill
in a throwaway git worktree and asserts the checker fails and names the skill.

## Gate provenance (observe mode)

A PR is judged by the gates it carries, so a PR could loosen the gate that judges it: raise a ratchet cap, add an allowance,
weaken a contract, or edit the gate code. `scripts/gate-provenance.mjs` judges it from its BASE instead
(the verification-lessons plan, section 2.2, the plan this implements).

- **Registry**: `.gate-files.json` lists every gate-defining path (each ratchet baseline, `scripts/gate-contracts/**`,
  `skills/*/gate-contract.json`, the prompt seeds, the policy loaders, the gate evaluators named by a contract, `package.json`/lockfile/`.npmrc`,
  the runner, the workflow, the registry itself) with a classifier kind: `numeric-cap`, `set-of-allowances`, `contract-set` or `opaque`.
  `tests/gate-provenance-registry.test.mjs` derives the candidates from the tracked tree and fails on an unregistered
  `*-baseline.json` or contract file, on a gate entry point that does not exist, and on a contract `implementation` that is
  neither registered nor inside the protected closure.
- **One protected-set model** (`scripts/lib/gate-provenance/protected-set.mjs`): registry entries + the base import closure of
  each registered gate entry point + the **subprocess helpers** a closure module spawns (a string literal naming a repo script in a
  module that calls spawn/execFile/fork, followed recursively with its own closure) + install inputs. The snapshot, the
  classification and the registered-only authorization check all read this one set. A module in it that is not registered and
  that the PR changes classifies as `opaque`, so `unknown`, so loosening. Residual: a script path computed at runtime is not followed.
- **Classifier** (`scripts/lib/gate-provenance/classify.mjs`, `GATE_DIFF_CONTRACT_VERSION = 1`): every changed protected file
  reads `tightening`, `loosening`, `unknown` or `unchanged`; worst wins, in the order `loosening > unknown > tightening >
  unchanged`. `unknown` is treated as loosening. A raised cap, an added allowance, a removed entry or a deleted file loosens. A
  change to the registry compares the whole entry minus `note`, so a field added later is never ignored.
- **Verdict and shadow runs**: a detached worktree of the PR head with the protected set checked out from the base (a protected
  path the base lacked is removed from disk and index). `node_modules` is the dependency install of THE BASE (`npm ci
  --ignore-scripts` in a separate base worktree, or `--base-install-dir`). Each registered ratchet gate runs there (verdict) and
  in a second clean detached worktree of the resolved head with the same `node_modules` link (shadow), never in the caller
  working tree; a divergence is printed.
- **Unmeasured dominates**: any unmeasured input (a git read failure, an unparseable base registry, the snapshot, the base
  install, the gate runs, `--no-gate-runs`, unreadable PR facts) makes the overall state `unmeasured`, never `clean` or
  `authorized`; `unmeasuredParts` lists them. A measured `violation` still outranks it. A git read that FAILS is unmeasured;
  only a path the tree confirms absent reads as absent.
- **Observe mode** (the only mode CI runs): prints the report and a `::notice title=audit-loop-gate-provenance::` line and
  exits 0; a crash is printed as unmeasured and still exits 0. `--mode enforce` (or `--mode=enforce`) exits 1 on a violation and 3
  on unmeasured or a crash, and is not enabled in CI. In CI the step runs before the PR `npm ci`, from a worktree of the base
  sha, and a failed base install prints an unmeasured notice and lets the job continue.
- **Known limits**: the test-suite gates run PR code by design and are out of the registry; `knip:gate` is not re-run (cost). On a
  `numeric-cap` baseline, removing a per-site exception listed under the entry `allowanceKeys` (`files`, `ids`) restores
  the default cap and reads `tightening`; removing any other key reads `loosening`.

**Requesting a loosening**: a PR whose gate diff is `loosening` or `unknown` is allowed only when every changed file (both sides
of a rename) is inside the protected set, it carries the label `gate-loosening`, the PR base and head from the API equal the
analyzed ones, and the latest review state of `Lbstrydom` is APPROVED on the analyzed head commit (a later push needs a fresh
approval). Open it as its own PR; the alternative is to fix the cause so the baseline can shrink instead.

## Explicitly out of scope (v1)

All 16 skills are now contracted (Phase C) and the ratchet keeps them so
(Phase D). Still out of scope: mutation testing beyond the lying fixture;
SKILL.md generation from the contract (would touch `skills:regenerate`, the
repo's highest-blast-radius sync seam — v2, contingent on observed
contract↔prose drift); CI service integration beyond the existing local-first
pre-push hook.

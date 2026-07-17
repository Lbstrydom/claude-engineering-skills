# Plan: Domain-Map Reconciliation (architecture-intent backlog)

- **Date**: 2026-07-14 (refreshed 2026-07-17 against a live observed graph)
- **Status**: Complete — Phases A/B (`f94371c`) + C (`144be83`, `500f3aa`), 2026-07-17. Gemini final gate: APPROVE.
- **Author**: Claude + Louis
- **Scope**: backend (`.audit-loop/domain-map.json` + intent bookkeeping; one
  extractor line under item 3 — see its coupling note)

> **Done.** The original items 1-13 table is retained as the historical
> capture; Phase A reshaped most of it (see "Progress"). Items 1-8 were **never
> executed as written** — roughly half their edges were artifacts of missing
> rules and ceased to exist once Phase A fixed rule coverage. That is the single
> most important thing this plan learned about itself.

## Outcome (2026-07-17)

All §9 acceptance criteria pass: zero drift across 31 domains, zero
over-declaration, dead-intent guard green, all 36 rule domains carry a purpose,
debt named in-map, observed envelope fresh. **Item 3 closed: `tests` went 0 → 29
observed edges** — all 12 pre-existing declarations proved real (the hand-written
list was correct, just incomplete) and the inverse prohibition (production never
imports tests) is verified rather than assumed.

**Audit**: GPT `SIGNIFICANT_ISSUES` H:2 M:2 L:1 → **zero findings about this
change**. Three were false and two are pre-existing:

| Finding | Verdict |
|---|---|
| HIGH — "`scripts/setup-postgres.mjs` is absent from the repository" | **FALSE.** The file exists (33 KB). The audit was given a narrow `--changed` set, saw 7 files, and read *absent-from-scope* as *absent-from-repo*. It is also the **item-10 `compat-bootstrap` false positive re-raising** — hours after being struck from this very plan with evidence. |
| HIGH — "signature egress: param defaults unredacted" | **FALSE.** [extract.mjs:212-217](../../scripts/symbol-index/extract.mjs#L212-L217) already redacts signatures, with a comment naming this exact scenario and tagged `R1 H3` — i.e. a *prior* round found and fixed it. A second re-raise of a settled finding. |
| MEDIUM — "plan-to-repo path contract drift" | **FALSE.** The plan's `../../scripts/...` links are correct markdown relative paths from `docs/plans/`, not drift. |
| MEDIUM + LOW — `--files-from` manifest `split('\n').map(trim)` corrupts paths with leading/trailing spaces | **REAL, deferred by independence** (not authorship, per AGENTS.md): the manifest governs which files are *symbol-extracted*; this change governs which dirs are *import-cruised*. Different paths, no dependency — the diff contains zero `files-from`/`trim`/`split` matches. Worth its own fix at [extract.mjs:51](../../scripts/symbol-index/extract.mjs#L51). |

**Gemini final gate: APPROVE** (0 new, 0 wrongly dismissed).

> **The audit's honesty guards fired twice and were right both times** — worth
> recording, because both would have produced a confident wrong answer:
> (1) it refused `domain-map.json` outright — *"0 implementation files reached
> the prompt; refusing to emit a verdict over code that was never read"*;
> (2) with a dirty tree, `--scope diff` resolved the base to `HEAD` and saw only
> *unrelated in-flight work*, not this committed change — it needed
> `--base 144be83^`. Without that, the audit would have reported someone else's
> code as this plan's findings.
>
> **Two of five findings were re-raises of settled findings** (item 10's struck
> FP; the `R1 H3` already-fixed egress). That is the dismissed-FP churn pattern,
> reproduced live on a 13-line diff.

## Origin

The Cluster A code audit of
[provenance-trailers-and-gate-honesty](../completed/provenance-trailers-and-gate-honesty.md)
(run `839c7842`, 2026-07-14) surfaced the same ~9 pre-existing
architecture-intent findings in every round. All were adjudicated
out-of-scope for that cluster (deliberation precedent: independent of the
shipped path) — but they re-raised verbatim each round, and they are real
drift between `.audit-loop/domain-map.json` and the observed import graph.
This plan is the durable capture so the backlog stops being re-litigated
per-audit and gets one deliberate reconciliation pass.

> **2026-07-17 refresh.** Re-derived against a freshly-generated
> `.audit-loop/domain-deps-observed.json`. Items 1-8 all still reproduce;
> several have grown edges the original capture missed (marked **+** below).
> Item 9 is **done**. Item 10 was a **false premise** and is struck. Three
> new items (11-13) appeared. Edge lists below are now mechanically derived
> (observed-minus-declared), not hand-transcribed from audit prose.

## The backlog

Legend: **+** = edge not in the 2026-07-14 capture · ~~strike~~ = withdrawn.

| # | Drift (observed − declared) | Action |
|---|---|---|
| 1 | `learning-store → stores` | Map `scripts/lib/store/**` INTO `learning-store` (or declare `stores` a persistence subdomain with an explicit allow) — no per-module allowlist entries |
| 2 | `dashboard → stores, nav-audit, visual-audit, audit-orchestration, `**`+scripts`** | Declare `dashboard` a read-only aggregation domain with one-way `allowedDeps` on the producers' query/presenter surfaces |
| 3 | `tests → 20 domains / 512 edges` (**not** the 7/129 originally recorded) | **Read the coupling note below — this item owns a 1-line extractor fix, knowingly an INTERIM patch (see "the discovery architecture").** Declare `tests` a verification domain allowed one-way into everything; keep the inverse prohibition (prod never imports tests) |
| 4 | `shared-lib → learning-store, stores, brainstorm, audit-orchestration, arch-memory, nav-audit, claude-hooks` (7 — original capture exact) | Reclassify feature-specific coordinators out of `shared-lib` into owning domains; shared-lib keeps only domain-neutral primitives |
| 5 | `cross-skill-bridge → stores, findings, nav-audit, `**`+arch-memory, +scripts`** | Keep the bridge a thin façade; either allow the named narrow deps or move feature ops behind owner-domain APIs |
| 6 | `audit-orchestration → stores, `**`+arch-memory, +claude-hooks`** | Route through a learning-store API rather than `lib/store/*` imports |
| 7 | `persona-test → shared-lib, learning-store, ux-lock` — **no `allowedDeps` entry at all** | Add persona-test to the intent with named one-way deps |
| 8 | `scripts → persona-test, brainstorm, audit-orchestration, ux-lock` | Model top-level CLIs as an entry-point/composition-root domain with one-way deps |
| 9 | ~~**Dead intents**: `ship`, `skills-content`~~ | ✅ **DONE 2026-07-17** — see "Item 9, landed" below |
| 10 | ~~`supabase/migrations/*.sql → scripts/lib/db/compat-bootstrap.sql`~~ | ❌ **STRUCK — false premise.** See "Item 10, withdrawn" below |
| **11** | `claudemd-management → shared-lib` | **New.** Its `allowedDeps` is an explicit `[]` — someone deliberately declared "depends on nothing" and it now depends on something. Decide: allow, or restore the isolation |
| **12** | `memory-health → stores` | **New.** Same shape as item 1 — resolve the same way, whatever item 1 decides |
| **13** | `explain → shared-lib` — **no `allowedDeps` entry at all** | **New.** Same shape as item 7 |

Reproduce this table at any time:

```bash
node -e "
const fs=require('fs');
const map=JSON.parse(fs.readFileSync('.audit-loop/domain-map.json','utf8'));
const obs=JSON.parse(fs.readFileSync('.audit-loop/domain-deps-observed.json','utf8'));
for (const [d,deps] of Object.entries(obs.deps)) {
  const a=map.allowedDeps[d];
  if (a===undefined) { console.log(d,'NO ENTRY ->',deps.join(', ')); continue; }
  const extra=deps.filter(x=>!a.includes(x));
  if (extra.length) console.log(d,'undeclared ->',extra.join(', '));
}"
```

## Item 3 — the `tests` blindness (read before executing)

The original item 3 said *"tests → 7 production domains (129 edges)"*. Both
numbers were wrong, and the reason matters:

**The observed import graph is structurally blind to `tests/`.**
[extract.mjs:279-287](../../scripts/symbol-index/extract.mjs#L279-L287) hands
dep-cruiser a hardcoded `COMMON_SOURCE_DIRS` allowlist with no `tests` entry.
In this repo only `scripts/` matches, so `targets.length !== 0`, the
repo-root fallback at :287 never fires, and dep-cruiser walks **only
`scripts/`**. `tests` is fully symbol-indexed (473 symbols, 380 files — it's
the largest domain) but can never produce a single observed edge. The
original 7/129 came from the arch-intent inventory (a `git ls-files` walk),
not the import graph — two different layers, silently conflated.

**Measured 2026-07-17** by cruising `scripts` + `tests` directly:

| | Value |
|---|---|
| Cruise wall-clock, `scripts`+`tests` | **1.1 s** (no perf argument for staying blind) |
| `tests →` raw edges | **512** |
| `tests →` distinct domains | **20** |
| Currently declared in `allowedDeps.tests` | 12 |
| Undeclared (would become violations) | **8**: `audit-orchestration, dashboard, explain, memory-health, nav-audit, persona-test, ux-lock, visual-audit` |
| Declared-but-unobserved (over-declared) | **0** — every existing entry is real |

**Coupling — these two changes must land in the same commit:**

1. Add `'tests'` to `COMMON_SOURCE_DIRS` in `extract.mjs`.
2. Extend `allowedDeps.tests` from 12 → 20 domains.

Doing (1) alone adds **8 new violations** to every audit round — strictly
worse than today. Doing (2) alone declares intent the evidence layer can
never corroborate. This is why the extractor line lives inside item 3 rather
than being fixed separately: it is not a scope expansion, it is the only
honest way to make item 3 verifiable.

**Consumer blast radius** (this module syncs to consumer repos): a consumer
with no `tests/**` rule resolves its test files to a null domain, and null
domains are skipped when the observed graph is built — so their graph is
unchanged. A consumer that *does* declare a tests rule gets the same
correction we're making here. Symbol extraction is unaffected either way —
`enumerateFiles` already walks the whole repo; only dep-cruiser's targets change.

## The discovery architecture — item 3 is an interim patch, not the fix

> Origin: `/brainstorm --with-gemini` session `1784284437663`, 2026-07-17
> (GPT-5.6 + Gemini-pro + Claude). Recorded here because item 3's one-line
> extractor fix is **knowingly treating a symptom**, and a future reader who
> sees only that line will reasonably conclude the problem was solved.

**Adding `'tests'` to `COMMON_SOURCE_DIRS` fixes today's instance and leaves
the generator intact.** All three models agreed on this without prompting. The
allowlist is a *silent-blindness generator*: the same bug recurs for any repo
using `e2e/`, `spec/`, `cypress/`, `integration/`, singular `test/`, or a
monorepo layout — and it fails silently, producing a smaller graph that reads
as authoritative. The dead `if (targets.length === 0) targets = [repoRoot]`
fallback only fires in the case where it's least needed (a repo matching
*nothing* on the list), so it provides no backstop for the common case.

**The root cause is ownership, not the list.** Three separate mechanisms
privately answer "what is this repo made of?":

| Walker | Layer | Sees |
|---|---|---|
| `enumerateFiles` (extract.mjs) | symbol index | whole repo, minus `SKIP_DIRS` + extension allowlist |
| `listRepoPaths` (adapter-contract.mjs) | arch-intent inventory | whole repo via `git ls-files` ∪ untracked |
| `COMMON_SOURCE_DIRS` → dep-cruiser | **import graph** | an arbitrary convention allowlist |

Nothing reconciles them, and nothing ever put their numbers side by side —
which is exactly how this plan came to record "tests → 7 domains, 129 edges"
(from the inventory layer) while the import layer saw **zero**, for months.

### Options considered

| | Option | Verdict |
|---|---|---|
| (a) | Add `'tests'` to the allowlist | **Interim only** — item 3. Correct now, bounded, measured; not the fix |
| (b) | Invert to a denylist: cruise `repoRoot` with excludes | Directionally right (fail-open beats silent-blindness). GPT: primary. Gemini: an exhaustive denylist across unknown consumer repos is "just as brittle as an allowlist" |
| (c) | Derive cruise targets from `domain-map.json` | ❌ **Rejected unanimously — do not revisit.** Makes evidence contingent on intent: a domain the map forgets becomes a domain the graph *cannot see*. The observed graph exists to CONTRADICT declared intent; deriving its targets from that intent is circular in the harmful sense ("self-fulfilling prophecy"). This is the strongest consensus in the round |
| (d) | Keep the allowlist, make blindness LOUD | Splits on warning-vs-assertion — see below |
| (e) | **Unified discovery**: feed the symbol layer's file inventory to dep-cruiser as its target list | **Preferred direction**, both external models converged here independently. Layers cannot disagree about what exists; stays independent of `domain-map.json`, so (c)'s circularity is avoided |

### The load-bearing disagreement: (e) alone is unfalsifiable

Gemini wanted (e) as a complete answer and dismissed (d) as "log-spam
shifting burden to the consumer." **That argument works against a warning and
fails against an assertion** — and this repo has direct evidence: the dead
`ship` rule (item 9) survived precisely because its only signal was a
dashboard warning nobody read. It was fixed the day it became a *failing
test*. Warning ≠ gate; that distinction is the whole disagreement.

(e)'s "absolute parity" is a guarantee *by construction*, which sounds
strictly stronger than a check but isn't — it is **unfalsifiable**. If the
unified walker is itself wrong (a bad extension filter, a `.gitignore` rule
swallowing a real source dir), parity means both layers are *identically*
blind, and the cross-layer disagreement that would have exposed it is gone by
design. GPT half-saw this ("'included by default' is the policy; 'prove what
was covered' is the verification") and then still offered (e) as the stronger
variant.

**So the target design is (e) + (d)-as-assertion, never (e) alone**: unify the
walkers AND keep an independent, machine-checkable coverage invariant that can
falsify the unified walker — *"every indexable source file is either cruised
or has an explicit, recorded exclusion reason."* The invariant is the half
that would have caught this bug.

### Blocking unknowns — measure before building (e)

1. **Does dep-cruiser cleanly accept an explicit file list of ~3,000 paths?**
   Both models flagged this as make-or-break; **unverified**. If it doesn't,
   the practical equivalent is (b) with exclusions delegated to a real
   `.gitignore` parser rather than a hardcoded array. Answerable with a
   ~10-minute spike.
2. **What does a root cruise cost on a consumer monorepo?** The 1.1s above is
   measured on **this** repo — the one repo where the allowlist happens to
   work. A 40k-file `packages/` tree is not 1.1s. **Unmeasured**; needs a real
   consumer before (b) or (e) ships.
3. **Null-domain accounting — a live hole that (e) does NOT close.** Test
   files resolving to a null domain are currently *skipped silently* when the
   observed graph is built. A consumer with no `tests/**` rule therefore
   recreates this exact blindness one layer down, *after* we've fixed it here.
   They should be reported as **"observed but unclassified"**, not dropped.
   This is arguably a better first fix than (e) — it is small, it is
   independent of the discovery redesign, and it converts a silent skip into a
   signal.

### Decision

Ship item 3 as scoped — (a) + the 8 declarations, coupled — explicitly as a
migration patch. Do not let the one-line fix close the question.

**The follow-on now lives in its own plan:
[observed-graph-discovery-unification.md](observed-graph-discovery-unification.md)**
— carrying the target design, the rejected alternatives, the two blocking
measurements, and the independent null-domain first step.

> **Why a separate file, not a section here (load-bearing).** `/ship` archives
> any `Status: Complete` plan into `docs/completed/`. Had the follow-on stayed
> a section of THIS plan, completing the reconciliation would have filed the
> outstanding work away in the same move — the third instance today of the
> "signal nobody reads" failure (cf. item 9's dashboard warning, item 10's
> unchallenged plan prose). The gitignored `.audit/tech-debt.json` can't carry
> it either. A sibling plan in `docs/plans/` is the smallest carrier that
> survives this plan's own archival.

## Item 9 — landed 2026-07-17

All three sub-parts are done; the guard is in `npm test`, which `npm run check`
(pre-push) already runs. No new npm script.

- **`skills/**` → `skills-content`** — was already mapped before this plan's
  refresh; no action needed. (`.claude/skills/**` needs no explicit rule: it's
  markdown, so it can't be a dead intent or an unmapped *source* file.)
- **The dead `ship` rule — fixed.** The rule was a literal
  `{"pattern": "scripts/ship.mjs"}`, but the file had been renamed to
  `ship-commit.mjs`. It matched nothing; `ship-commit.mjs` fell through to the
  `scripts/**` catch-all and was silently absorbed into the generic `scripts`
  domain. Now `scripts/ship*.mjs` (a glob, matching the house style of
  `scripts/plan*.mjs` / `scripts/explain*.mjs` — a literal path is what broke),
  plus `allowedDeps.ship = ["shared-lib", "stores"]` for what
  `ship-commit.mjs` actually imports (`commit-trailers.mjs`, and dynamically
  `lib/store/{repo,runs-findings}.mjs`).
- **The zero-path guard — added.**
  [tests/domain-map-dead-intent.test.mjs](../../tests/domain-map-dead-intent.test.mjs)
  runs `computeDeadIntent` against the **real** `.audit-loop/domain-map.json`.
  Verified red on `ship` before the fix, green after.

**Two things this exposed, both fixed:**

- **`codelessDomains` was masking the bug.** `ship` was listed in it, and its
  only consumer ([collect-purposes.mjs:239-240](../../scripts/lib/dashboard/collect-purposes.mjs#L239-L240))
  uses the list to move a domain out of the dashboard's actionable ⚠ bucket
  into a neutral note — suppressing the one signal that would have surfaced the
  dead rule. Exactly what that key's own `_comment_codeless` warns against.
  `ship` is now out of the list, and the guard's second assertion enforces the
  distinction: **`codelessDomains` means "owns paths, but none with indexable
  code symbols" — it is not an exemption list for a rule that matches nothing.**
- **`deadIntent` was asking the wrong question.** `computeDeadIntent` was fed
  the *source-file* inventory, so it meant "owns no file the JS symbol indexer
  would parse" while reporting "declared but owns no paths". That's why
  `skills-content` (57 `.md` + 2 `.json` — a live rule) was reported dead
  alongside `ship` (genuinely dead), sending the operator hunting for a
  non-existent bug. `runArchIntentAnalysis` now computes it from the new
  `inventoryAllPaths()` — a rule is dead only when it matches **no path at
  all**. `computeDeadIntent` itself is unchanged (still pure in `mapped`), so
  the existing fixture tests cover it as-is; discovery was extracted to one
  private `listRepoPaths()` so the two inventories can't drift.

## Item 10 — withdrawn (false premise)

The item claimed `supabase/migrations/*.sql` references
`scripts/lib/db/compat-bootstrap.sql`. **No migration references it** —
`grep -r 'compat-bootstrap\|compat_bootstrap' supabase/` returns zero hits.
The "reference" exists only inside `.audit/` ledger artifacts
(`tech-debt.json`, `clusterA-provenance-ledger.json`, `session-ledger.json`).
It is a recurring LLM-audit false positive that got laundered into this plan
when the backlog was captured from audit prose.

The colocation contract it asked for already exists and is enforced:
[setup-postgres.mjs:59](../../scripts/setup-postgres.mjs#L59) documents it
("synced ALONGSIDE this script"), the file is a sync-surface entry in
`sync-inventory.mjs:187` + `sync-to-repos.mjs:232`, and its integrity is
hashed in `scripts/.sync-manifest.json`. Nothing to do.

> **Process note — this is the failure mode this plan exists to prevent, one
> level up.** A disproven finding escaped the ledger and became *plan prose*,
> where it reads as established fact and no longer carries its evidence. When
> capturing an audit backlog into a plan, record the **mechanical derivation**
> (like the repro command above), not the model's summary of it.

## Progress — Phases A & B landed 2026-07-17 (commit `f94371c`)

The reconciliation ran into a **phasing bug in this plan's own premise**: items
1-8 all said *"declare these edges"*, but a large share of those edges existed
only because of **missing rules**. Declaring them would have cemented a
measurement artifact into committed intent. Correct order is rules → re-derive
→ declare.

**Phase A — rule coverage (DONE).** `shared-lib` was not a domain, it was the
residue: `scripts/lib/**` is the second-to-last rule, so all 13 lib subsystems
added since the rules were written (`arch-intent`, `arm-eval`, `model-eval`,
`learning`, `requirements`, `solo-control`, `db`, `gate-honesty`, `friction`,
`fit-check`, `cycle`, `persona`, `security`) landed in it silently — 70 of its
156 files. Each now owns a rule. **shared-lib: 156 → 84 files, subdirectory
residue 70 → 0. Observed graph: 21 → 30 domains.**

**Phase A.2 — the trapped-primitive fix (DONE).** The mirror-image bug: the
tagger reads *location* as ownership, so a domain-neutral primitive sitting in
a feature directory forges edges. `lib/brainstorm/file-lock.mjs` (a sentinel
lock, 5 consumers across 5 domains) made `requirements → brainstorm` assert
that the requirements ledger depends on brainstorming. **Moved to `lib/` root**
rather than patched with a per-file rule — location was the thing that lied.
`friction → brainstorm` and `shared-lib → brainstorm` vanished;
`requirements → brainstorm` correctly **remains** (gap-challenge.mjs really
imports brainstorm's `openai-adapter`, which injects `BRAINSTORM_SYSTEM_PROMPT`).
Removing the false edge left the true one standing.

**Phase B — re-derive (DONE).** `arch:refresh` + `arch:render`.

**The trapped-primitive sweep (DONE — clean).** Enumerated every file living in
a `scripts/lib/<feature>/` directory that is imported from outside it: **92
candidates, exactly 1 trapped primitive** (`file-lock.mjs`, already fixed). The
mechanical shape is far too broad on its own — `store/repo.mjs` has 8 foreign
importer domains because `stores` is a *layer*, and that is healthy. The
distinguishing signal is **purpose, not import count**: every other candidate's
own `@fileoverview` scopes it to its owner (`glob-match.mjs` → "accept-v1
markers + audit scope checks"; `decision-logger.mjs` → "for the
adaptive-learning system"; `sarif-formatter.mjs` → "for CLAUDE.md hygiene
linter"). `file-lock.mjs` was the only file whose stated purpose had nothing to
do with its folder. **Do not re-run this as a mechanical gate** — it is 91/92
false-positive by construction.

## Phase C — declare the remainder (THE REMAINING WORK)

Everything below is derived from the post-Phase-A observed graph via the repro
command above. These edges have survived rule-coverage correction and the
trapped-primitive sweep, so they are **real**.

### 7b. Implementation phases

**Phase 1 — domains with no `allowedDeps` entry at all (11).** Add verbatim:

```
"arch-intent":  ["shared-lib"]
"arm-eval":     ["shared-lib","stores"]
"explain":      ["shared-lib"]
"fit-check":    ["shared-lib"]
"friction":     ["security","shared-lib","stores"]
"gate-honesty": ["shared-lib"]
"model-eval":   ["audit-orchestration","shared-lib","stores"]
"persona-test": ["findings","learning-store","shared-lib","stores","ux-lock"]
"requirements": ["brainstorm","plan","shared-lib"]
"security":     ["shared-lib"]
"solo-control": ["shared-lib"]
```

**Phase 2 — undeclared edges on existing entries (11).** Union in:

```
audit-orchestration += arch-intent, arch-memory, arm-eval, claude-hooks, model-eval, requirements, stores
brainstorm          += arm-eval
claudemd-management += shared-lib          # its entry is currently an explicit []
cross-skill-bridge  += arch-memory, arm-eval, audit-orchestration, findings, friction, nav-audit, persona-test, scripts, stores
dashboard           += audit-orchestration, learning-store, nav-audit, scripts, stores, visual-audit
install             += gate-honesty, stores
learning-store      += stores
memory-health       += stores
scripts             += arch-intent, arm-eval, audit-orchestration, fit-check, model-eval, persona-test, requirements, security, solo-control, ux-lock
shared-lib          += audit-orchestration, claude-hooks, model-eval, nav-audit, stores
stores              += model-eval, persona-test
```

**Phase 3 — annotate, don't hide, the known debt** (see the honesty note
below), and clear the one stale over-declaration: `root-scripts` declares
`install` but never observes it — drop it or justify it in prose.

**Phase 4 — `tests` (item 3).** `allowedDeps.tests` declares 12 domains and
observes **zero** — the blindness now shows up as pure over-declaration. Add
`'tests'` to `COMMON_SOURCE_DIRS` and extend the entry 12 → 20 (see item 3's
coupling note).

> **Phase C is a BASELINE (a ratchet), not an endorsement — say so in the map.**
> Setting `allowedDeps` = observed makes the violation check **vacuous**: it can
> never fail if whatever the code does is permitted. That is an acceptable and
> normal baseline — new edges still get flagged, which is the ratchet — but only
> if we are explicit that these three are *recorded debt*, not intent:
> - **`shared-lib → audit-orchestration, claude-hooks, model-eval, nav-audit,
>   stores`** — survives Phase A, so it is real: ~5 top-level lib files
>   (`efficacy-lints`, `config`, `repo-inventory`, `audit-shadow`,
>   `finalize-outcomes`, `audit-arms`) are feature coordinators, not primitives.
>   Retagging or moving them is follow-on work.
> - **`stores → model-eval, persona-test`** — a **layer inversion**: the
>   persistence layer reaching *up* into feature domains. Worth its own look.
> - **`cross-skill-bridge → 9 domains`** — AGENTS.md calls this a "thin façade".
>   Nine dependencies is not thin.

### 9. Acceptance Criteria

1. The repro command (above) prints **nothing** — zero undeclared edges, zero
   `NO ENTRY` domains.
2. `npm run check` passes (includes `npm test`, which carries the dead-intent guard).
3. `tests/domain-map-dead-intent.test.mjs` green — every declared domain owns ≥1 path.
4. Every domain in `rules` has a `domainPurposes` entry (dashboard hygiene).
5. **No over-declaration**: no `allowedDeps` value that the observed graph never
   shows, except where justified in prose. Guards against the check going
   vacuous in the *other* direction.
6. The three known-debt declarations above carry an inline `_comment` in
   `domain-map.json` naming them as baselined debt, not intent.
7. `npm run dashboard:setup` completes; the Architecture tab shows the declared
   edges as `both` (observed ∩ manual) — **except `tests → *`, which will be
   `manual`-only unless C3's extractor line lands.**

### 11. Execution Clustering

**Cluster A — Phases 1-3** — declare the intent baseline (map-only).
- Files: `.audit-loop/domain-map.json` (modify)
- fix-gate: yes
- Coupling: None. Pure declaration + comments; no runtime behaviour changes.

**Cluster B — Phase 4** — the `tests` blindness.
- Files: `scripts/symbol-index/extract.mjs` (modify), `.audit-loop/domain-map.json` (modify)
- fix-gate: final
- Coupling: **Internally coupled — both edits land together** (the extractor
  line alone adds 8 fresh violations; the declaration alone is uncorroborated
  by any evidence). Independent of Cluster A.

Final gate: consolidated Gemini review over the union diff (mandatory).

Close-out (outside the phase set): `npm run dashboard:setup`, then re-run the
repro command and `npm run check`.

> **Both clusters modify `domain-map.json`** — Cluster B touches
> `allowedDeps.tests` only, which Cluster A does not write. Run A before B; if
> B is re-run after A cleared, A's record goes `stale` by design (shared
> derived-scope file) and wants `--authorize-stale-reaudit`.

## Non-goals

- No runtime code moves in the first pass (items 4-6 name candidate
  *refactors*; the reconciliation pass only encodes current reality + intent.
  Actual module moves are separate, individually-audited changes). Item 3's
  one-line `COMMON_SOURCE_DIRS` addition is not an exception to this — it
  changes what the *evidence layer observes*, not what any module does, and
  item 3 is unverifiable without it.
- **The discovery-architecture redesign ((e) + coverage invariant) is NOT in
  this plan** — see "The discovery architecture" above. It's runtime code with
  consumer blast radius and two unmeasured unknowns; it needs its own plan and
  its own audit. This is a scope boundary by *independence* (the map edits
  don't depend on it), not by difficulty: item 3's interim patch is correct and
  self-contained at 1.1s, and the redesign changes no map entry item 3 writes.
- Not a blocker for the provenance/gate-honesty plan's Cluster B.

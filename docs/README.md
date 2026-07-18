# docs/ — layout & conventions

Every doc lands in exactly one bucket. Pick with the **decision rule** at the
bottom; if nothing fits, that's a signal the taxonomy needs a new bucket — not
that root is a fallback.

> **Root is not a bucket.** `docs/` root holds *only* generated artefacts and
> live ledgers — files a tool writes or reads by hardcoded path. Every
> hand-written doc lives in a subfolder. `npm run docs:check` (part of
> `npm run check`) enforces this against an explicit allowlist, because the
> prose version of this rule existed before and still drifted: root accumulated
> 23 files against a table that documented 8.

## `docs/` (root) — generated artefacts + live ledgers

Don't hand-edit the generated ones; re-run the command. Adding a file here means
adding it to `ROOT_ALLOWLIST` in `scripts/check-docs-placement.mjs` — only do
that for a new generated/tool-owned artefact.

| File | Source | Notes |
|------|--------|-------|
| `README.md` | hand-written | this file — the index |
| `SKILLS-INDEX.md` | generated — `npm run skills:index` | one-line summary of every skill |
| `architecture-map.md` | generated — `npm run arch:render` | per-symbol index (~900KB); grep it before writing a new function |
| `architecture-intent.md` | generated (from the template below) | C4-style intent doc for *this* repo |
| `architecture-intent.template.md` | hand-written | starter a consumer repo copies to produce its own `architecture-intent.md`; lives next to its output on purpose |
| `requirements-map.md` | generated — rendered from `.requirements/ledger.json` | human-readable invariant map |
| `security-strategy.md` | hand-curated **live ledger** | security incident memory; read by `npm run security:refresh` + the `/plan` incident consultation |

## `docs/reference/` — contracts & specs

Hand-written descriptions of how the system **is** — consulted *while coding*,
usually because something enforces them. Durable; no `Status:` line.

| File | Enforced by |
|------|-------------|
| `consistency-contract.md` | `scripts/lib/persona-test/schemas.mjs` (Zod) |
| `skill-reference-format.md` | `scripts/check-skill-refs.mjs` |
| `gate-honesty.md` | `scripts/check-gate-contracts.mjs` |
| `commit-provenance.md` | `scripts/ship-commit.mjs` (the `AI-*` trailers) |
| `model-resolution.md` | `scripts/lib/model-resolver.mjs` |
| `reference-integrity.md` | `scripts/check-docs-refs.mjs` (`npm run docs:refs`) |

## `docs/runbooks/` — operator how-to

How to **run / operate** a subsystem: setup recipes, env tables, CLI cookbooks,
failure playbooks. AGENTS.md points at these as its "**Operations:**" half — the
matching "**Design:**" half is the plan in `completed/`.

`postgres-parity.md` · `learning-system.md` · `consumer-adoption.md` ·
`azure-work-profile.md` · `local-maintenance-checks.md` ·
`model-eval-harness.md` · `pre-ship-empirical-verify.md`

> Named for the subsystem, not `<x>-runbook.md` — the folder already says
> "runbook".

## `docs/plans/` — ALL plans (status is metadata, never a path)

Every plan lives here for its **whole lifecycle** — `Draft` → `Approved` →
`In Progress` → `Complete`/`Superseded`. One file = one plan, with a `Status:`
line; each plan's paired `*-audit-summary.md` (the `/audit-code` convergence
record) sits beside it. **A plan does not move when it completes** — its `Status:`
line changes, and nothing else. This mirrors `research/`'s rule ("a status change
never means a file move") and exists because moving a completed plan silently
broke every reference to it — the failure `docs/plans/reference-integrity-gate.md`
was written to kill.

- **Selection**: the pre-push hook audits the one plan whose `Status:` is *active*
  (`Draft`/`Approved`/`In Progress`), via `scripts/lib/plan-status.mjs`
  (`npm run plans:status` lints the vocabulary). A `Complete` plan is never
  re-audited. A doc with **no** `Status:` line is not a plan (the documented
  "a plan is a unit of work with a Status line" rule) — not selectable, not linted.
- **`*-audit-summary.md` is exempt** from the vocabulary lint: its `Status:` is a
  free-text convergence sentence (`Audit-complete. N fixes applied.`), by design.

> **`docs/completed/` is retired.** Cluster B of the reference-integrity plan
> consolidated its 145 archived plans back into `docs/plans/` (git-rename, history
> preserved), and Cluster C deleted the `plans:archive` mover. External links to
> old `docs/completed/<name>.md` paths are broken once (symmetric with the stale
> `docs/plans/<name>.md` links they replace) — the `docs:refs` gate keeps new ones
> from accruing.

## `docs/research/` — the audit-effectiveness research arc

Consolidated, durable record of the 2026-06/07 research programme, plus its
operator runbooks. See [`research/README.md`](research/README.md) for the
read-in-order narrative.

- `experiment-{1,2,3}-*.md`, `analysis-*.md`, `*-synthesis*.md`, `next-steps.md` — the write-ups
- `runbooks/` — operator guides for the experiments themselves (`arm-eval.md` is
  live; `model-ab-experiment.md` + `solo-control-experiment.md` are concluded —
  each doc states which, so a status change never means a file move)
- `data/` — structured datasets backing the write-ups

> **`research/` is synthesis — prose.** Raw runtime artefacts deliberately stay
> where the tooling reads them; see the tool-owned dirs below.

## Tool-owned directories — **don't reorganise these**

These sit under `docs/` for historical reasons but are **code-coupled paths**,
not prose. Moving one is a code change with cross-repo blast radius, not a docs
tidy-up. Each is listed with the code that pins it:

| Dir | What it is | Pinned by |
|-----|-----------|-----------|
| `arm-eval/sessions/`, `arm-eval/worksheets/` | **Runtime export archive** (an *output*). Tracked here as the auditable experiment record; a *consumer's* copy is local-only (the authoritative capture is the cloud `arm_eval_*` tables). | `SESSIONS_DIR` in `scripts/lib/arm-eval/export.mjs`; 3 `existsSync` branches in `scripts/cross-skill.mjs`; `scripts/audit-clean.mjs`; **`AUDIT_RUNTIME_IGNORES` in `scripts/sync-to-repos.mjs`** — which writes `docs/arm-eval/**` globs into every consumer's managed `.gitignore` block and doubles as the post-sync untrack allow-list (`tests/sync-untrack.test.mjs`) |
| `experiments/audit-effectiveness/` | **Curated evidence corpus** (an *input*). `known-defects.json` is the oracle models are graded against. | `scripts/lib/model-eval/known-defect-corpus.mjs`; `scripts/solo-control-audit.mjs`; `scripts/defect-harvest.mjs`; `scripts/cheap-triager-validate.mjs`; `npm run audit-exp:ledger` |

They're different kinds — one an output, one an input — which is why they aren't
merged under a shared parent: that would file them by "neither is prose", the
same define-by-exclusion trap that made root a dumping ground.

If you ever *do* move `arm-eval/`: keep the old `docs/arm-eval/**` globs in
`AUDIT_RUNTIME_IGNORES` as a tombstone alongside the new ones, or existing
consumer exports lose their ignore and start nagging as untracked.

## `docs/audit/shared-references/` — shared skill references

Reference material shared across audit skills (`gemini-gate.md`,
`ledger-format.md`). Loaded on demand, not part of any single SKILL.md.
`scripts/sync-shared-audit-refs.mjs` keeps these byte-identical with
`skills/audit-{plan,code}/references/*.md` — edit one, run `npm run skills:check`.

## `docs/adopter-handoff/` — consumer-app onboarding

Adoption material for consumer apps integrating persona-test consistency mode.
Distilled from the wine-cellar-app Phase 1 adoption; lets the next adopter
(ai-organiser etc.) hit the same outcome in ≤2 hours.

| File | Purpose |
|------|---------|
| `migration-playbook.md` | 10-step linear adoption guide |
| `template-surfaces.json` | minimal `surfaces.json` template |
| `template-canary.json` | minimal canary-journey template |

## `docs/personal/` — not project documentation

Personal artefacts that cite this repo as evidence but aren't about building or
running it. Nothing in the repo reads these; no convention applies beyond "don't
put project docs here". Currently: the IBM Full Stack breadth-evidence dossier
for an MSc essay.

---

## Decision rule

Ask in order — first match wins:

1. Does a **tool write or read it by path**? → root (allowlist), or the tool-owned dir it already belongs to.
2. Is it a **unit of work with a `Status:`**? → `plans/`, then `completed/` on ship.
3. Is it **personal**, not about this project? → `personal/`.
4. Is it part of the **research arc**? → `research/` (write-up) or `research/runbooks/` (how to run it).
5. Is it **shared skill content**? → `audit/shared-references/`. **Consumer onboarding**? → `adopter-handoff/`.
6. Does it say how to **operate** something? → `runbooks/`.
7. Does it say how the system **is**, and something enforces it? → `reference/`.

Still nothing? Don't default to root — that's how this drifted last time. Add a
bucket, and add it here.

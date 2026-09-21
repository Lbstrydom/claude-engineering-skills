# Decision memo — Claude Design and the skill chain

- **Date**: 2026-09-21
- **Status**: Recommendation only — no skill changes in this pass
- **Subject**: Should [Claude Design](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)
  (canvas design/prototype generation; Claude Code commands `/design`, `/design-sync`)
  be integrated into plan → audit-plan → implement → audit-code → ux-lock → lenses → ship?
- **Evidence base**: skill source read at `3462a8d5` (this repo) and `35cfa574`
  (storyline); the `DesignSync` tool contract as loaded in Claude Code; Anthropic's
  Design docs. Figures are labelled `measured` / `derived` / `expected`.

## TL;DR

| # | Question | Recommendation | Effort | Defer until |
|---|---|---|---|---|
| 1 | `/plan --mockup` | **Yes, narrowly** — an optional *committed HTML* input to Phase 1 and §10; never a live URL; host-neutral (any HTML source — `/design` is Claude-Code-only acceleration, never invoked or gated on) | ~0.5 day, prose only | URL form: Design version history |
| 2 | Shared token extractor with `/design-sync` | **No** — different value spaces and direction; sharing is false economy | 0 | n/a (a `light-dark()` gap in `tokens.mjs` was found as a side effect — file separately) |
| 3 | Mockup step in `/cycle` | **Not now** — a mockup is an *input to* `/plan`, not a step *after* it; the autonomous scope guard cannot see a URL | 0 | Design version history + a stable element-id scheme |
| 4 | Redundancy | **None** — Design generates; every existing lens verifies a live app or grades a document | — | — |

Design's own limitation settles most of it: it **generates only; it never observes a
running app**. Every skill in the chain after `/plan` is a verifier of something
real (a plan file, a diff, a live DOM, computed styles). The only place a
generated artifact can add value is as **planning input**.

## Empirical `/design-sync` trial — BLOCKED, not skipped

The brief asked for one `/design-sync` run against storyline's
`apps/desktop/src/renderer` (strict declares-only `shared/tokens.css`, gated by
`scripts/ux/run-packaged-acceptance.mjs`). It could not run:

- `/design-sync` is not an enabled skill in this session (`ListSkills` → `[]`), and
  the `DesignSync` tool refuses every method until `/design-login` has been run
  **from an interactive Claude Code session on this machine** — a non-interactive
  session cannot complete the OAuth flow (`measured`: `list_projects` → "needs
  design-system authorization").
- **Concrete prerequisite for whoever re-runs this**: `/design-login` once,
  interactively; then `/design-sync` from `C:/GIT/storyline` with the renderer
  as the component root. Read-only inspection afterwards is `DesignSync
  list_files` / `get_file` — no reverse sync is possible or wanted (see §2).

What the tool contract itself establishes (this is the loaded schema, not prose):

- **Direction is local → cloud only.** Methods are `list_projects`, `get_project`,
  `list_files`, `get_file`, `create_project`, `finalize_plan`, `write_files`,
  `delete_files`, `register_assets`, `report_validate`. Nothing writes to disk.
  The feared "Design → tokens.css" overwrite is **unrepresentable** by this tool —
  the acceptance gate is safe by construction, not by discipline.
- **The unit is a per-component preview HTML** whose first line is
  `<!-- @dsCard group="…" -->`; the Design app compiles those into
  `_ds_manifest.json`. Validation is a `.render-check.json` with counts
  `{total, bad, thin, variantsIdentical, iterations}` — i.e. the bundle is
  *rendered component cards*, not a token table.
- Writes are gated by `finalize_plan` (exact path list, permission prompt) and
  are incremental — "never as a wholesale replace".

Anthropic's docs add: no local artifacts, first sync on a large repo "can take
hours", and no statement about what happens when source components change after
a sync ([commands](https://code.claude.com/docs/en/commands),
[design-system setup](https://support.claude.com/en/articles/14604397-set-up-your-design-system-in-claude-design)).

## 1. `/plan --mockup` — where the UX/DOM contract comes from today

Traced in [skills/plan/SKILL.md](../../skills/plan/SKILL.md) at `3462a8d5`:

| Source | Where it enters the plan | Mechanism |
|---|---|---|
| Persona **history** (not the registry) | Phase 1 pre-step → §1 "Known user-visible issues" | `cross-skill.mjs get-persona-sessions-by-repo` — past P0/P1 sessions filtered by `focus` |
| Existing screens | Phase 1 checklist items 6–11 | Read HTML/CSS/JS by hand: design language, component landscape, flows, responsive behaviour |
| Principles | Phase 3 (`references/ux-principles.md`, 26), Phase 4 (`technical-principles.md`, 17) | Cited by number in §3/§4 |
| Nothing visual | §2 "User flow + **ASCII wireframe**" | Model-drawn from the exploration above |
| States | §5 State Map | Empty/Loading/Error/Success per component |
| DOM contract | §10 Acceptance Criteria | `- [P0] [category] description` + `Setup:`/`Assert:`; **semantic DOM only** — `getByRole`/`getByLabel`/`getByTestId`, never class names |

The persona **registry** is consulted by `/nav-audit` (`scripts/lib/nav/contract.mjs`,
`persona-seed.mjs`), not by `/plan`. There is no visual acceptance target anywhere
in the plan today — the wireframe is ASCII and the criteria are role/name contracts.

### What a mockup could feed, section by section

| Plan section | Fed by a mockup? | How |
|---|---|---|
| §1 Context Summary | Yes | one line: `Mockup: docs/plans/mockups/<slug>/index.html (sha)` |
| §2 User flow + ASCII wireframe | Yes — **replaces** the ASCII wireframe when a mockup exists | link + a one-paragraph description of each artboard |
| §3 UX Design Decisions | Partly | the mockup is the *outcome* of Gestalt/cognitive-load decisions; the plan still has to state *why* |
| §5 State Map | Yes, if artboards exist per state | Empty/Loading/Error/Success artboards map 1:1 to the rows |
| §10 Acceptance Criteria | Yes, **by accessible name only** | see below |
| §7 File-Level Plan, §7b/§11 | No | Design produces no file-level intent |

### Can Acceptance Criteria reference mockup elements by name?

By **accessible name, yes; by mockup element id, no** — and the parser is the reason:

- [scripts/lib/plan-criteria-parser.mjs](../../scripts/lib/plan-criteria-parser.mjs)
  hashes a criterion on `SEVERITY|category|description` only; `Setup:`/`Assert:`
  are free text. There is no field for a mockup reference, and adding one changes
  every `criterion_hash` (the store's per-criterion time series, `plan_verification_items`).
- `/ux-lock verify`'s translation rules
  ([verify-mode-generation.md](../../skills/ux-lock/references/verify-mode-generation.md)
  "Translation rules") build every locator via the selector ladder `getByRole →
  getByLabel/Placeholder → getByText → getByTestId → justified-structural`. A mockup
  id is on no rung.
- A Design export is an HTML bundle ("Export → Hand off to Claude Code": HTML +
  README + prompt). Its button text, labels and headings **are** the accessible
  names `getByRole('button', { name: … })` matches on. So a criterion can say
  `Assert: getByRole('button', { name: 'Start a presentation' }) is visible` and that
  name traces to the mockup. Nothing else in the mockup (ids, layers, artboard
  names) is addressable — Anthropic documents no stable element-id scheme.

So the mockup gives `/ux-lock verify` a *vocabulary* (the names), not a target.
The target stays the live DOM, which is right: `/ux-lock verify` grades a running
app, and a mockup cannot be run.

### Does it give `/audit-plan` a concrete target?

Only if inlined as text. `openai-audit.mjs --mode plan` builds one text prompt —
`## Plan to Audit\n${planContent}` after the T0 file inventory
([openai-audit.mjs:1028](../../scripts/openai-audit.mjs)) — through
`responses.parse`; there is no image or attachment path, and GPT cannot fetch a
`claude.ai` URL. A committed HTML bundle *can* be pasted in, at the cost of
prompt size (a Design bundle is a full page with inline CSS). The
`PLAN_AUDIT_SYSTEM` rules 5 and 8 (Gestalt; error/loading/empty states) are the
ones a mockup would sharpen. Recommend: link the mockup from §2 and inline **only
the per-artboard descriptions**, not the HTML — the auditor grades the document,
and a description it can cite is worth more than markup it cannot render.

### Recommendation for Q1

Adopt `/plan --mockup <path>` as an **optional input**, path only:

1. The path must be a **committed** HTML export under `docs/plans/mockups/<plan-slug>/`.
   A committed file is hash-stable and diffable; a `claude.ai/design` URL is neither
   (no version history — the artifact can change under an audit with no trace).
   This is the plan-document rule applied to its attachment: the plan is a
   committed snapshot, and so is what it cites.
2. Prose changes only (no code): Phase 1 step 6a "read the mockup, list its
   artboards and their accessible names"; §2 replaces the ASCII wireframe with
   the link + per-artboard description; §10 guidance "derive accessible names
   from the mockup where one exists".
3. `--mockup <url>` is **deferred** until Design has version history. A URL form
   would need a pinned export anyway to be auditable, at which point it is the
   path form with an extra hop.

4. **Host-neutral by construction.** This bundle is read by Copilot, Cursor,
   Windsurf and Codex as well as Claude Code (AGENTS.md), and `/design` /
   `/design-sync` exist only in Claude Code: the `DesignSync` tool authenticates
   through a claude.ai login (`/design-login`), not `ANTHROPIC_API_KEY`, and
   Anthropic documents no public Design API — so a script cannot trigger it and
   a non-Claude host cannot reach it. Same shape as arch-memory and quickfix:
   **the rule is host-neutral; the Claude tool is acceleration.** The mockup
   input is a committed HTML file from *any* source (Claude Design, Figma
   export, hand-written). The SKILL.md must never invoke `/design`, never gate
   on it, and may mention it only as "one way to produce the file, when you are
   in Claude Code and `/design` is enabled". There is no availability probe to
   write: Design authorization is discoverable only by calling the tool, so an
   `isClaudeAvailable()`-style check would answer the wrong question (CLI
   present ≠ Design authorized) and a plain env check would be a fourth
   instance of the AGENTS.md "route exists vs public var set" defect.

Effort: ~half a day of SKILL.md edits plus `skills:regenerate`; no parser or
store change. Right-sizing: the band-aid is "paste a screenshot in chat"; the
over-build is a `mockup_ref` column on `plan_verification_items` and a mockup
diff gate. The path-only input is the smallest thing that is a true function of
the problem (a visual reference the plan can cite and the reader can open).

## 2. Shared token extractor — no

`scripts/lib/visual/tokens.mjs` (`extractAllowedSet`, adapters `css-vars` /
`json` / `tailwind`) produces a **normalised value-space membership set**: colours
canonicalised to `r,g,b`, lengths to px at a 16px base, keyed by
`family:value:theme`, with `varName` kept only as provenance so
`reconcile-tokens.mjs` can say *which* token a computed style matched. The name
is disposable; the value is the contract.

`/design-sync` needs the opposite: **names and component renders**, values raw.
Its unit is a rendered preview card per component, grouped by the source's own
categorisation; the Design canvas then applies `--color-accent` *by name*. A
normalised `63,92,110` is useless to it.

The only overlap is "find `--name: value` declarations in a `.css` file" — one
regex ([tokens.mjs:144](../../scripts/lib/visual/tokens.mjs)). Sharing that
would couple a public bundle module to a beta cloud tool for three lines.

**Side finding (measured, `3462a8d5` vs storyline `35cfa574`)** — running
`extractAllowedSet` on storyline's `shared/tokens.css` (38 custom properties,
22 of them `light-dark(a, b)` colours):

```
families: { spacing: 8, fontSize: 4, lineHeight: 1, radius: 2 }   colors: 0   warnings: []
```

`normalizeColor` rejects `light-dark(...)`, `familyForVar` then finds no family
keyword in `--color-canvas`, and the token is dropped **silently** — every
colour, no warning. `light-dark` appears nowhere in `scripts/lib/visual/` or
`tests/`; the theme model is per-*source* (`tokenSources[].theme`), which cannot
represent a single declaration carrying both themes. This has nothing to do with
Design, but it means visual-audit's declared-token spine is blind to the one
consumer with the strictest tokens file. File it as its own fix (parse
`light-dark(l, d)` into two theme-scoped tokens); it is not part of this
recommendation.

## 3. A mockup step in `/cycle` — not now

Two grounded reasons, both from
[skills/cycle/SKILL.md](../../skills/cycle/SKILL.md) Step 3C and
[scripts/cycle-cluster-scope.mjs](../../scripts/cycle-cluster-scope.mjs):

- **The autonomous scope guard sees files, not references.** It reconciles
  `git diff` + `ls-files --others --exclude-standard` against each cluster's
  derived scope (the intent-tagged `Files:` of its phases). A mockup at a
  `claude.ai` URL is invisible to it: not in-scope, not out-of-scope, and not
  in `auditedFileHashes`, so a change to it can never flip a `gate-clear`
  cluster to `stale`. That is exactly the "reference that changes under the
  audit" the brief worries about, and there is no hook to hang it on.
- **A mockup exported to disk is handled correctly today, as a plan input.**
  Committed under `docs/plans/mockups/…`, it is hash-tracked (edits mark the
  cluster stale — the right behaviour) and, if written *during* an autonomous
  run without a `(create)` tag in some phase, `cycle-cluster-scope.mjs` exits 1
  with `out-of-scope edit` — also right. Gitignored, it would be invisible again
  (`--exclude-standard`). So the only stable placement is *before* `/plan`, as a
  committed input, which is Q1 — not a new step between `/plan` and
  implementation.

A step there would also need `/audit-plan` to consume it (text-only, §1), and
would sit inside the one part of the chain that pauses for a human anyway. The
re-evaluation trigger is concrete: **Design ships version history (a pinnable
revision id) and a documented element-id scheme.** With both, a mockup becomes a
citable snapshot like a commit, and a `(mockup)` intent tag in §7b could enrol it
in the derived scope. Until then, any step is a reference the guard cannot hash.

## 4. Redundancy check — nothing is made redundant

| Skill | Why Design does not replace it (one line each, from source) |
|---|---|
| `/persona-test` | Drives a **live** URL as a persona in a Plan → Act → Reflect loop and scores what a user hits; Design has no runtime to hit. |
| `/click-test` | Walks the **rendered** DOM for duplicate IDs, orphan labels, unnamed inputs, ARIA misuse, touch targets — JS-rendered surfaces a static mockup never has. |
| `/nav-audit` | Builds the nav graph from **source** (`lib/nav/extract.mjs`) and reconciles offered-vs-needed against the persona registry; a mockup of one screen has no graph. |
| `/visual-audit` | Reconciles **computed styles** and bounding boxes (`theme-parity.mjs`, `layout-physics.mjs`, drift gate) against declared tokens; Design emits intent, never paint. |
| `/ux-lock` | LOCK pins a shipped fix's DOM contract; VERIFY runs Playwright against the live app per §10 criterion — both need something running. |
| `/audit-plan` | Grades the plan **document** for executability (`PLAN_AUDIT_SYSTEM`); a mockup is at most one more section it reads. |
| `/audit-code` | Grades the **diff** against the plan; Design writes no diff in this repo's flow. |

Design is upstream of all seven: it can make the plan's visual intent explicit;
it cannot verify that the intent shipped.

## What to defer until Design leaves beta

| Item | Blocked on |
|---|---|
| `/plan --mockup <url>` | version history (pinnable revision) |
| `(mockup)` intent tag in §7b / `/cycle` scope | version history **and** a stable element-id scheme |
| `/design-sync` on a consumer as a routine `/ship` close-out | large-repo performance ("hours" on first sync), no documented behaviour on post-sync source changes |
| Inline comments as an adjudication surface | comment persistence ("occasionally don't display") |
| The empirical storyline trial in this memo | `/design-login` from an interactive session (§"Empirical trial") |

## Non-goals confirmed

- No reverse sync Design → `tokens.css` — the `DesignSync` tool has no local
  write method, so `run-packaged-acceptance.mjs`'s gate cannot be reached.
- No change to visual-audit's judgement (theme parity, layout physics, drift
  gate) — explicitly out of scope and untouched.

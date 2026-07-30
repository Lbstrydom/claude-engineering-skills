# Plan: Global skill-surface shadow detection + capture-honesty and repo-scoping fixes

- **Date**: 2026-07-30
- **Status**: Complete — Clusters B, C, E implemented + audited; consolidated
  Gemini gate **APPROVE** (0 findings); **V1 and V2 both discharged** against a
  live app on 2026-07-30. V1 caught a real bug the unit suite could not (see
  below). Cluster A remains ceded (D17) and its owning plan has landed.
- **Author**: Claude + Louis
- **Scope**: backend
- **Stack**: `js-ts` (detected from `package.json`; `stackKinds: [js-ts, postgres]`)
- **Target domain(s)**: `install`, `nav-audit`, `skills-content`, `cross-skill`
- ⚠ **Cross-domain work** — touches 4 domains. Intentional: four independent
  defects sharing one theme (a surface that reports success it did not earn).
  They are clustered separately in §11 and share no code.

---

## 1. Context Summary

Four verified defects, all repo-owned. The common thread is this repo's own
**gate-honesty doctrine** — *"any branch that can emit pass/clean/0-findings/green
is where to be adversarial"*. Each emits a confident verdict without having
established the thing it asserts.

> **Issue 4 was added after the round-1 audit** (downstream field report,
> 2026-07-30) and has therefore **not been audited**. Round 2 must cover it.
> Issues 1-3 carry round-1 findings; Issue 4 carries only this session's
> verification.

### Live confirmation of Issue 1, this session

The `/plan` invocation that produced this document was served from
**`C:\Users\User\.claude\skills\plan`** — the global copy, not
`.claude/skills/plan`. Direct behavioural proof that the user-level surface wins
on a name collision **in Claude Code**. `plan` is one of the 9 currently-identical
skills, so no harm resulted; the 5 stale ones are where the cost lands.

### What exists today

**Issue 1 (P1) — global skill copy shadows the project copy.**
`install-skills.mjs --surface claude` writes all 56 files to `~/.claude/skills/`,
receipt `~/.audit-loop-install-receipt.json`, every `managedFile` tagged
`scope:"global"`. It is invoked **per consumer repo** but writes to **one global
location**, and is never path-rewritten. Measured on disk:

| Fact | Value |
|---|---|
| Receipt `installedAt` | 2026-07-23, `bundleVersion f4537a54d25fb3e3` |
| Current manifest | `bundleVersion df8629aef3785bbe` |
| Commits to `skills/` since | 16 |
| Stale skills | 5 of 14 — ship (116 changed lines), persona-test (71), audit-code (28), cycle (25), click-test (17) |
| Consumers' project copies | **current** — wine-cellar-app and ai-organiser both 701 lines / 20 rewrites |

Cost already paid: a session read the stale `ship/SKILL.md`, which lacks the
`byMode.code` guidance at `skills/ship/SKILL.md:106`, and reported an unlocked-fix
backlog of **207** instead of the correct **94**. It also produced live
`MODULE_NOT_FOUND` in a consumer, because the un-rewritten copy documents
`scripts/cross-skill.mjs` where the consumer needs `scripts/.claude-skills/`.

`scripts/check-stale-skill-surface.mjs` was built for exactly this bug class, and
its `@fileoverview` narrates an isomorphic incident — *"the reported cause was
helper-path drift… Both were wrong — the rewriter works fine."* It compares only
`.github/skills` against `.claude/skills` **within one root**.

**Issue 2 (P2) — click-test assigns P0 to non-perceivable elements.**
`dom-scanner.md:111-117` skips `el.type === 'hidden'` (the input *type*), but
`<input type="file" hidden>` has `type === 'file'` plus the `hidden` *attribute*,
so it passes the filter and is pushed as **P0 `input-no-name`**. Field run: 704
findings, ~6 real; all 31 `aria-hidden-focusable` sat inside a `visibility:hidden`
subtree; 4 of 5 P0s were hidden file inputs. `dom-scanner.md:310` already books
the noise as accepted v2 debt.

> **Corrected premise (round-1 audit, H3).** An earlier draft of this plan
> justified Issue 2 as a **false release gate** — "`/ship` gates on P0s, so a
> hidden file input can block a release" — and rated it P1. **That is false and
> has been removed.** Verified: `skills/click-test/SKILL.md:580-599` ("Phase 7 —
> Persistence (Out of Scope for v1)") states that persisting findings so `/ship`
> can surface P0s is **deferred to v2**, and that the required
> `cross-skill.mjs record-click-test` subcommand, payload schema, table mapping
> and `/ship` read path **do not exist**. Independently, `/ship`'s gate is
> persona-test-scoped: `skills/ship/SKILL.md:10` defines `--ignore-p0` as "push
> despite an unresolved **persona-test** P0", and Step 0.5a (`:53`) reads
> `cross-skill.mjs persona-outcomes summary`. No machine path carries a
> click-test P0 to a gate. The claim was inherited from an upstream report and
> repeated without verification.

The real, and smaller, harm: (a) report noise already booked as debt, and (b) a
**human** reading a P0 list treats it as blocking — a human gate, not a machine
one. The fix is therefore **preventive**: correct severity *before* the deferred
v2 persistence turns a cosmetic wrong into a real false gate. P2, not P1.

**Issue 3 (P2) — nav-audit `--verify` audits the logged-out shell.**
`scripts/lib/nav/verify.mjs:316` computes `emptyNavShells`;
`buildDraftCaptureWarning` exists at `scripts/lib/nav/bootstrap-draft.mjs:31`. The
CLI calls it **only on the bootstrap path** (`scripts/nav-audit.mjs:98`). The
verify path (`scripts/nav-audit.mjs:116-164`) consumes `unverifiableLayers`,
`statesRequested/Collected` and `liveAttribution` but **never reads
`emptyNavShells`** — the signal is computed and dropped. Worse, the only auth
message (`scripts/nav-audit.mjs:146`) fires when `--storage-state` **is** passed,
which is backwards for the expired-token case.

**Issue 4 (P1) — `list-unlocked-fixes` is globally scoped, so every consumer
records a foreign repo's backlog.** `cmdListUnlockedFixes`
(`scripts/cross-skill.mjs:691`) reads `argOption('repo-id')` and **nothing else**.
With no `--repo-id`, `repoId` is `undefined` and both store calls take their
unscoped branch — returning **every repo's** rows from the `unlocked_fixes` view.

Field-confirmed downstream, 2026-07-30: a consumer ran
`list-unlocked-fixes --repo "<slug>"` and got **byte-identical output** to the
un-flagged call. All 207 rows carried one foreign `repo_id`; the local repo's true
count was **0**. The reported number went 207 → 94 → 0, and *both* of the first two
were foreign — so the `byMode.code` guidance that shipped 2026-07-29
(`skills/ship/SKILL.md:106`) is correct but **insufficient**: it fixed the
code/plan split on a population that was the wrong repo to begin with.

Three findings, of which only the first was in the downstream report:

1. **`--repo` is accepted and silently ignored.** It is a globally-valid flag
   (`KNOWN_FLAGS`, `scripts/cross-skill.mjs:158`) because sibling subcommands read
   it, so `assertKnownFlags` passes it through. The guard's own docstring
   (`:141-145`) states it "only refuses a flag NO subcommand could ever read" —
   so accepted-but-inert-for-this-subcommand is **outside the guard's design
   scope**, not a guard bug. Nothing else validates it. Note the asymmetry inside
   one skill: Step 0.5a scopes correctly (`persona-outcomes summary --repo`,
   `skills/ship/SKILL.md:53`), Step 0.5b passes no repo at all.
2. **The store layer already scopes correctly — this is a caller bug.**
   `getUnlockedFixes` (`scripts/lib/store/plans-ship.mjs:463`) and
   `countUnlockedFixes` (`:500`) both apply `WHERE repo_id = $1` when given one.
   No view, schema or migration change is needed; the capability exists and the
   CLI declines to use it. That is what keeps the fix small.
3. **A second unscoped call site, not yet hit in the field.**
   `cmdLockWithTestWorksheet` (`:2241`) also calls
   `getUnlockedFixes(argOption('repo-id'))` bare. This is the command Step 0.5b
   *prints as its own remediation* (`skills/ship/SKILL.md:129`), so the nudge and
   its fix path are unscoped together: an operator following the printed advice
   gets a worksheet of another repo's findings, each paired with a suggested local
   test file. Acting on one records a `regression_specs` row that closes a foreign
   repo's obligation against an unrelated test — the one path here that writes
   wrong data to shared state rather than merely displaying it.

**The correct pattern already exists in the same file, in two variants.** Five
sibling handlers (`:1146`, `:1203`, `:1559`, `:1597`, `:1631`) use
`argOption('repo-id') || await resolveRepoIdentityQuiet()`. Better still,
`recommend-skills` (`:1777-1782`) resolves via `resolveRepoForStore({})` and
**skips the signal entirely** when there is no repo ref — fail-closed to "no
signal" rather than falling back to global. Three idioms coexist; the two
unscoped ones are the outliers.

> **Scope check on the impact claim** (applying the round-1 H3 lesson — do not
> inherit a downstream severity claim unverified). The downstream report called
> this a false release blocker. **It is not.** Step 0.5b's own banner reads
> `⚠ REGRESSION LOCK GATE (non-blocking)` (`skills/ship/SKILL.md:123`), and
> `--skip-ux-lock` appears only in the usage header (`:11`) and as an override
> recorded in Step 0.5f (`:199`) — there is no code path that blocks a push on
> this count. Equally, `missing_spec_count` is written to `ship_events`
> (`scripts/lib/store/plans-ship.mjs:939`; column at
> `supabase/migrations/20260419120000_cross_skill_data_loop.sql:141`) and has
> **no reader anywhere in the codebase** — so no live decision consumes the wrong
> number today.
>
> The harm is therefore *not* a blocked release. It is: (a) **cross-tenant output**
> — a consumer's terminal prints another repo's file paths and finding details;
> (b) **permanently corrupted history** in an append-only log, making any future
> analysis of `missing_spec_count` before the fix unusable; and (c) **misdirected
> remediation**, per finding 3 above, which can write wrong rows. P1 is justified
> by (a) and (c), not by a gate.

**This repo already has a doctrine for exactly this, and it fails closed.**
`runWeeklyReview` (`scripts/learning/weekly-review.mjs:356-363`) returns
`BAD_INPUT` when no repo scope is resolvable, and its docstring (`:8-10`) gives
the reason verbatim: *"without one it aborts to prevent cross-tenant data leakage
in the issue body."* Same class, same store, opposite handling — one aborts, the
other silently goes global. Issue 4 is adopting the existing doctrine, not
inventing one.

### Code Trace

- Issue 1: `.githooks/pre-push:168` → `scripts/check-stale-skill-surface.mjs` `main()`
  (`:156`) → sandbox-honesty guard (`:176-204`) → `listSurfaceNames(root, surface)`
  (`:80`, joins `root` + `surface`) → `compareSkillSurfaces()` (`:122`, `contentOf`
  supplied by caller at `:235` closing over ONE `root`) → `decideStaleSurfaceExit()`
  (`:151`) → inspection-failure policy (`:217-230`, exits 1 unconditionally).
  Receipt shape read live: `surface:"claude"`, 56 × `scope:"global"`.
- Issue 2: `skills/click-test/references/dom-scanner.md:47` (`push` signature —
  `el` required, `sel(el)`/`snippet(el)` dereference unconditionally), `:111-117`
  (`input-no-name` P0), `:182-188` (`aria-hidden-focusable` P1), `:226-228` (the
  one existing geometry guard, `rect.width===0` — the scanner already has a
  perceivability notion, applied to exactly one check), `:310` (booked debt).
  Gate reality: `skills/click-test/SKILL.md:580-599`, `skills/ship/SKILL.md:10,53`.
- Issue 3: `scripts/nav-audit.mjs:98` (bootstrap warning, wired) vs `:116-164`
  (verify path, unwired) → `scripts/lib/nav/verify.mjs:300-317` (return shape,
  `emptyNavShells` at `:316`) → `scripts/lib/nav/bootstrap-draft.mjs:31-43`.
- Issue 4: `skills/ship/SKILL.md:98-136` (Step 0.5b, banner `:123`, remediation
  `:129`) → `scripts/cross-skill.mjs:691` (`cmdListUnlockedFixes`,
  `argOption('repo-id')` only) → `scripts/lib/store/plans-ship.mjs:463`
  (`getUnlockedFixes`, unscoped branch) + `:500` (`countUnlockedFixes`, unscoped
  branch) → `:939` (`missing_spec_count` persisted, no reader). Second site:
  `scripts/cross-skill.mjs:2241` (`cmdLockWithTestWorksheet`). Correct patterns:
  `:1777-1782` (`resolveRepoForStore`, fail-closed) and `:1146`/`:1203`/`:1559`/
  `:1597`/`:1631` (`|| resolveRepoIdentityQuiet()`). Flag guard: `:141-145`
  (docstring), `:158` (`--repo` in `KNOWN_FLAGS`), `:2737` (`assertKnownFlags`
  call). Doctrine precedent: `scripts/learning/weekly-review.mjs:8-10, 356-363`.

### Patterns reused vs new

**Reused (no new modules):** `listSurfaceNames` / `compareSkillSurfaces` /
`decideStaleSurfaceExit` (Issue 1); `buildDraftCaptureWarning` (Issue 3); the
existing `push()` sink and `rect.width===0` guard (Issue 2); the v1.4
`unverifiableLayers` → `unverified` degradation contract (Issue 3);
`resolveRepoForStore` + the already-scoped `getUnlockedFixes` /
`countUnlockedFixes` branches, and `weekly-review`'s fail-closed `BAD_INPUT`
shape (Issue 4).
**New:** one optional `authSentinel` contract field (Issue 3, Phase 4). No new
scripts, no new npm entry points, no new persisted artifacts. **Issue 4 adds no
new abstraction at all** — it deletes a divergence between three existing repo-
resolution idioms.

### Neighbourhood considered

| Symbol | File | Band | Score |
|---|---|---|---|
| `main` | `scripts/check-stale-skill-surface.mjs:156` | **precedent** (above-floor-standout) | 0.856 |
| `compareSkillSurfaces` | `scripts/check-stale-skill-surface.mjs:122` | review | 0.830 |
| `decideStaleSurfaceExit` | `scripts/check-stale-skill-surface.mjs:151` | review | 0.815 |
| `runVerify` | `scripts/lib/nav/verify.mjs:119` | review | 0.762 |

**Decision on the `precedent` band — extend, not sibling.** The file already
models "surface A shadows surface B", already fails loud on an unreadable surface,
and already refuses to claim an unearned pass. A second script would duplicate all
three and drift. The extension required is larger than the first draft assumed —
see D1.

### Security Considerations

Incident neighbourhood returned INC-001 (lexical path classification bypassed by
symlinks) at cosine 0.596, `pathOverlap:false`. Weakly related, but the lesson
transfers because Issue 1 introduces this repo's first check reading a path
**outside `repoRoot`**:

- **Read-only, never transmitted.** Nothing enters an LLM payload; the egress gate
  is not on this path.
- **Do not print absolute HOME paths verbatim** in default output — they carry the
  OS username and land in CI logs. Print the tilde-relative form
  (`~/.claude/skills`); reserve absolute paths for `--format json`.
- **Fail-closed, per INC-001.** An unreadable global surface is `unverifiable`,
  never "clean" — the same `existsSync`-swallow trap the file's own `:45-79`
  docstring already fought twice.
- **Symlink containment (round-2 M2 — this is INC-001's actual lesson, not just
  its headline).** The first draft cited INC-001 but specified only
  *unreadability*, leaving the symlink dimension unaddressed — INC-001's whole
  point is that lexical containment under a directory does not establish where
  the resolved file lives. Policy for the global surface, which is
  attacker-adjacent in a way `repoRoot` is not (any process can drop a symlink
  in `$HOME`):
  - Enumerate with `readdirSync(..., {withFileTypes: true})` and treat an entry
    that `isSymbolicLink()` as **not a skill directory** — it is reported as
    `unverifiable` for that name, never traversed.
  - Before reading a `SKILL.md`, `lstatSync` it; a symlink is `unverifiable` for
    that name. Do **not** `realpath`-and-read: this check's only product is a
    line-count delta, which is not worth following a link out of the surface for.
  - **Never print or persist a resolved link target** — that is the
    information-disclosure half of INC-001, and a diagnostic that echoes the
    target would leak paths outside `$HOME/.claude/skills`.
  - `unverifiable` here composes exactly as in D5: loud, never `clean`.

---

## 2. Proposed Architecture

```mermaid
graph LR
  subgraph I1["Issue 1 — install domain"]
    HOOK["`.githooks/pre-push:168`<br/>(already wired — no hook change)"] --> CSS["check-stale-skill-surface.mjs"]
    CSS --> OP["operand: {root, surface, label}"]
    OP --> P1["pair 1: repo/.github/skills<br/>vs repo/.claude/skills<br/>(existing, blocking)"]
    OP --> P2["pair 2: HOME/.claude/skills<br/>vs repo/.claude/skills<br/>(new, advisory)"]
    P1 --> CMP["compareSkillSurfaces<br/>contentOf keyed on LABEL"]
    P2 --> CMP
    CMP --> VERD["verdict: clean / current /<br/>divergent / unverifiable"]
    RCPT["~/.audit-loop-install-receipt.json"] -.->|"provenance only,<br/>never the verdict"| P2
  end

  subgraph I2["Issue 2 — skills-content domain"]
    PUSH["push() — single sink, el always present"] --> PERC["isPerceivable(el)"]
    PERC --> CAP["not perceivable to P3 + tag"]
  end

  subgraph I3["Issue 3 — nav-audit domain"]
    RV["runVerify()"] --> ENS["emptyNavShells (:316)"]
    RV --> AL["authLiveness: live/dead/unverified"]
    SENT["contract.authSentinel (optional)"] --> AL
    AL --> COMP["composeCaptureVerdict<br/>(single precedence point)"]
    ENS --> COMP
    COMP --> DEG["degrade to unverified<br/>(v1.4 contract)"]
  end

  subgraph I4["Issue 4 — cross-skill domain"]
    CLI["cmdListUnlockedFixes<br/>cmdLockWithTestWorksheet"] --> RS["resolveScope()<br/>--repo-id / --repo / identity"]
    RS -->|"resolved"| SC["scoped: WHERE repo_id = $1<br/>(store branch already exists)"]
    RS -->|"unresolvable"| FC["fail closed: zeroed counts<br/>+ reason, never global"]
    RS -->|"--all-repos"| GL["explicit global<br/>(labelled in output)"]
  end
```

### Key design decisions

> **D1-D7 are SUPERSEDED design notes (D17), retained deliberately.** They design
> Issue 1's detector, which was ceded on 2026-07-30 to
> `repo-scoped-skill-surfaces-and-installer.md`. **Nothing in this plan implements
> them** — §7 marks both target files CEDED and §9 carries no test for them. They
> stay because round-1 findings H1, H2 and M3 produced them, and deleting them
> would erase why the design changed. Read them as history, not as work.
> Implementers: skip to D8.

**D1 — The operand is `{root, surface, label}`, not a surface constant
(#5 Single Source of Truth).** *Round-1 H1 overturned the first draft here.* The
draft claimed passing `root = os.homedir()` to `listSurfaceNames` was enough. It
is enough to **enumerate names**, but not to **compare content**:
`compareSkillSurfaces` receives `contentOf(surface, name)` from a caller closing
over ONE `root` (`:235`). For the global pair both sides have the *same* surface
subpath (`.claude/skills`) under *different* roots, so a surface-keyed callback
cannot disambiguate them.

Fix: `compareSkillSurfaces` takes `staleLabel` / `liveLabel` and invokes
`contentOf(label, name)`. Labels are distinct by construction
(`~/.claude/skills` vs `.claude/skills`), so the caller maps label → `(root,
surface)` unambiguously. Existing call site passes the current constants as
labels and is behaviour-identical. `listSurfaceNames` is reused verbatim.

**D2 — Compare global content against the LOCAL `.claude/skills` copy, not
against `skills/` source (#1 DRY).** One comparison catches both failure modes:
in this repo the local copy equals source, so a diff means *staleness*; in a
consumer the local copy is path-rewritten, so a diff also means *un-rewritten
paths*. No repo-type branching.

**D3 — Issue 1 verdict comes from the DIRECTORY, not the receipt (#15).**
*"No receipt"* ≠ *"no shadow"*: a copy installed by other means, or a deleted
receipt, would read clean — the same silent-swallow class the file already fixed
twice. Ground truth is the directory; `bundleVersion`/`installedAt` are printed
as **provenance only** and never decide the verdict or exit code.

**D4 — `divergent`, not `shadowed` (#19 Observability).** *Round-1 M3.* Directory
divergence proves a **name collision with differing content**. It does *not*
prove every client resolves the global copy first. We have one live observation
(Claude Code, this session). Naming the verdict `shadowed` would assert
resolution precedence the detector never measured — the exact overstatement this
plan exists to eliminate. The report states the collision as fact and the
precedence as observed-for-Claude-Code, citing the session; if a future client's
precedence is established, it is added as evidence, not assumed.

**D5 — Explicit verdict × exit contract (#15).** *Round-1 H2.* Every state is
enumerated; there is no default-through case:

| Global surface state | Verdict | Default exit | `--gate-global` exit |
|---|---|---|---|
| Directory absent (`ENOENT`) | `clean` | 0 | 0 |
| Present, no name collisions | `clean` | 0 | 0 |
| Present, collisions, all content identical | `current` | 0 | 0 |
| Present, collisions, any content differs | **`divergent`** | 0 (loud advisory) | **1** |
| Present but unreadable (`EACCES`/other) | **`unverifiable`** | 0 (loud) | **1** |
| `os.homedir()` unresolvable or empty | **`unverifiable`** | 0 (loud) | **1** |
| Receipt absent or unreadable | *(no effect)* | — | — |

`clean` is reserved for "we looked and there is nothing"; a state we could not
inspect is `unverifiable` and says so in both text and JSON `status`. Note the
deliberate asymmetry with the existing pair, whose inspection failure exits 1
**unconditionally** (`:217-230`): that surface is committed and tracked, so an
unreadable copy means the repo is broken. The global surface is optional
developer-machine state, so its exit code follows D6 while its *message* still
refuses to claim a pass.

**D6 — Issue 1 is ADVISORY by default (`--gate-global` opts in).** The shadow
lives in `$HOME`, is not part of the pushed commit, and cannot be fixed by
amending it. Hard-blocking a push on developer-machine state is exactly the
cried-wolf gate AGENTS.md warns gets `--no-verify`'d. Silence caused the
incident, so: loud advisory with the exact remediation command, plus an opt-in
flag. Sanctioned blocking home: `.githooks/pre-push.local`.

**D7 — Issue 1 does not depend on the parallel session's installer outcome
(#20).** The check reads whatever is on disk. If the parallel session stops
installing a global surface for consumers, the directory is absent and the check
reads `clean` — no shared constant, no version handshake. This is what makes
Phase 6 a *verification* step rather than a dependency.

**D8 — Issue 2 demotes rather than drops (#19).** Dropping destroys signal — a
hidden element may become visible, and `--with-modals` exists to re-scan opened
surfaces. Demoting caps severity at P3 and tags `perceivable:false`. The tag is
**state-relative** and must say so: an element behind a closed modal is *not
perceivable in this captured state*, not *never perceivable*.

**D9 — Issue 2 gates inside `push()`, the single sink (#1, #5).** Verified: `el`
is a required positional at `:47` and all 16 call sites pass a real element, so
there is no element-less path to specify (round-1 rebuttal sustained). One call
site means no future check can forget the tag — mirrors the adjacency wave's
"exactly one call site" invariant.

**D10 — `isPerceivable` is a narrow, named predicate (#4, #15).** *Round-1 M2.*
It answers exactly one question: **is this element rendered in the current
captured state?** It is explicitly NOT a user-perceivability or accessibility-tree
oracle. Contract:

- Primary: `el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
  && !el.closest('[inert]')`. **The `[inert]` term is not redundant** (Gemini
  gate): `checkVisibility()` evaluates CSS visibility only, and an `inert`
  element is still *rendered* — it is merely non-interactive and out of the
  accessibility tree. Without the explicit term the primary branch returns `true`
  for inert subtrees while the fallback returns `false`, so the two branches
  would disagree, and D11's "an `[inert]` match must not count" would hold only
  on the fallback path.
  **`contentVisibilityAuto` is deliberately NOT passed** (round-2 M1): it reports
  an offscreen `content-visibility:auto` subtree as not-visible because rendering
  is *skipped*, which is a viewport-state answer and would contradict the
  scrolled-out rule below. Omitting it keeps the primary branch on rendered-state.
- **Detached node** (`!el.isConnected`) → `false`, checked first. *Round-4 L1:* this
  branch is **not reachable through `scanDom()`** — a detached element is not in the
  document, so it can never be enumerated or reach `push()`. It is therefore asserted
  by a **direct predicate test** (inject `PERCEIVABLE_SOURCE`, build a detached
  element inside `page.evaluate`, assert `false`), not by a scanner fixture. The
  guard stays in the predicate because `nav-audit`'s sentinel path calls it on an
  element it holds a reference to, where detachment *is* reachable.
- Fallback when `checkVisibility` is absent or throws — **two different scopes, and
  the split is the contract** (Gemini gate, round-4 G1):
  - **On `el` only**: `getComputedStyle(el).visibility` ∈ `{hidden, collapse}` →
    `false`. `visibility` is an **inherited** property, so the computed value on the
    element *already* accounts for inheritance — and, critically, a descendant may
    override a hidden ancestor with `visibility: visible` and be fully rendered.
    Walking ancestors for `visibility` would therefore return `false` for an element
    `checkVisibility()` correctly calls `true`, breaking this decision's own
    one-policy rule. Reading it once on the target is both sufficient and correct.
  - **On `el` and every ancestor**: `display:none`, `opacity:0`,
    `content-visibility:hidden`. These are *not* overridable from below —
    an ancestor with `display:none` removes the whole subtree no matter what a
    descendant declares — so the walk is required for them.
  - **`[inert]` is NOT tested at all, in either branch.** *Superseded by a live run,
    commit `03bd0ad`.* Earlier text in this decision (and the round-4 M4 note below)
    argued `[inert]` must be an explicit term in both branches, on the reasoning that
    `checkVisibility()` ignores it. **That reasoning was right about the mechanism and
    wrong about the conclusion**: `inert` is an *interactivity* property, not a
    visibility one — an inert element is still painted and the user can still see it.
    A live run against a real app suppressed **329 of 331** elements, because the app
    had a modal open and marked `<header>`/`<main>` inert — the standard
    background-inerting pattern — while both were `display:flex`/`block`,
    `visibility:visible`, `opacity:1`, at 1248×90 and 1248×662. Excluding `inert`
    makes the two branches agree *by removing the term from both*, which is the same
    one-policy outcome by a simpler route. **Do not re-add it.**

  `content-visibility:hidden` is included so both branches implement the *same*
  rendered-state policy (round-2 M1); `content-visibility:auto` is ignored in both,
  matching the omission above. **The ancestor walk is still required** for the
  non-inherited properties, and the original draft's `offsetParent` shorthand gets
  this wrong for `position:fixed` (whose `offsetParent` is `null` while visible).
  That, plus the two-scope split, is why the fallback is not a one-liner.

  *The motivating field case is unaffected*: the ~31 `aria-hidden-focusable`
  findings sat inside a `visibility:hidden` subtree **without** overriding it, so
  their computed `visibility` is the inherited `hidden` and they still demote. A
  fixture pins the overriding case (`visibility:visible` child of a
  `visibility:hidden` parent → perceivable) so the two branches cannot diverge here
  again.
- **The `[hidden]` ATTRIBUTE is deliberately not tested in either branch**
  (round-4 M4). The fallback previously matched `[hidden]` as an attribute while
  the primary branch had no equivalent term, so a page whose CSS overrides the UA
  default `[hidden] { display: none }` would get `true` from the primary branch and
  `false` from the fallback — violating this decision's own requirement that both
  branches implement one policy. **Resolved toward effective CSS**, because the
  question this predicate answers is *rendered*, not *semantically marked*: with
  the UA default in force, `[hidden]` produces `display:none` and `getComputedStyle`
  catches it anyway, so nothing about the motivating case (`<input type="file"
  hidden>`) changes; and where CSS deliberately overrides the default, the element
  genuinely *is* rendered and calling it non-perceivable would be the wrong answer.
  A fixture pins the CSS-overridden `[hidden]` case so the two branches cannot drift
  apart again. *(This note originally also claimed `[inert]` must stay an explicit
  term in both branches — **falsified by a live run**; see the `[inert]` bullet
  above. It is excluded from both branches.)*
- Zero-size (`getBoundingClientRect()` w or h === 0) → `false`, subsuming the
  existing `:226-228` guard, which is then removed so there is one rule.
- Clipped-but-rendered (scrolled out of viewport, `overflow:hidden`) → `true`.
  Out of scope: this predicate answers *rendered*, not *on-screen*.
- Both paths unavailable → `true` (**fail-open to current behaviour**). Failing
  closed would silently demote every finding to P3 and disable the P0 signal
  entirely — a far worse honesty failure than the noise being fixed.

**D11 — Issue 3 auth-liveness is DECLARED, not guessed (#4).** *Round-1 H4.*
Heuristics ("is there a Sign-in link?") produce false verdicts on apps that show
sign-in affordances while authed. `authSentinel` is optional and fits the existing
two-artifact split (committed contract = intent; gitignored observation =
evidence). Contract:

```json
"authSentinel": { "selector": "[data-testid=\"account-menu\"]", "expectText": "optional substring" }
```

- **Representation**: object with required `selector` (CSS, non-empty string) and
  optional `expectText` (substring, case-insensitive). Rejected: a bare string —
  it cannot grow an assertion without a breaking change.
- **Schema validation**: Zod rejects an empty/non-string `selector` at contract
  load, failing the run with a contract error rather than silently disabling the
  assertion. An invalid *CSS* selector (syntactically legal string, illegal
  selector) throws inside the browser and is caught → `authLiveness: 'unverified'`
  with the selector echoed, never `dead` (an authoring bug must not masquerade as
  an expired session).
- **Observation timing**: after `storageState` is loaded, after navigation, and
  after the same settle the nav capture already awaits — **in every captured
  state, and after the activation pass**. `authLiveness` is `live` if the
  sentinel qualifies in **any** state; `dead` only if it qualifies in **none**.

  > **Gemini-gate fix (a real bug, not a nit).** The previous wording said "the
  > default (first) captured state only." The default breakpoints are
  > `['mobile', 'desktop']` (`scripts/nav-audit.mjs:287`), so the first state is
  > **mobile** — and on mobile the account menu, the canonical sentinel, is
  > usually inside a collapsed drawer. Combined with the rule that a sentinel
  > must be *perceivable* to qualify, a first-state-only check would have
  > reported `dead` for a perfectly live session on every responsive app, then
  > degraded the whole run to `unverified`. That is a false negative in the
  > direction that destroys the feature's value, and it would have looked like
  > "expired token" to the operator. Observing across all states also composes
  > correctly with the existing activation pass, which opens exactly the
  > collapsed menus the sentinel hides in.
- **"Observed" is defined operationally** (round-2 H2 — without this, a hidden
  account-menu template left in the DOM makes an expired session read `live`,
  which is the exact failure this assertion exists to catch):
  1. Evaluate `document.querySelectorAll(selector)` — **all** matches, not just
     the first, so a multi-match selector is deterministic.
  2. Discard any match that is not **rendered**. *Round-3 H8 corrected this:* an
     earlier draft said "the same rendered-state policy as D10" and then named
     **Playwright `locator.isVisible()`** as that policy. **They are not the same
     predicate**, and the gap is exactly load-bearing here — `isVisible()` counts
     an `opacity:0` element as visible (D10 treats it as non-perceivable via
     `checkOpacity: true`) and does not exclude an `[inert]` ancestor subtree,
     which D11 explicitly requires. A stale `opacity:0` account-menu would
     therefore have qualified as a live session: the precise hole step 2 exists
     to close.

     **Resolution — one predicate, one source, evaluated in-page (D20).** The
     sentinel check runs `page.evaluate()` over the *same* `isPerceivable(el)`
     implementation D10 specifies, applied to each match. `locator.isVisible()`
     is **not** used. A `<template>`-resident, detached, `display:none`,
     `visibility:hidden`, `opacity:0`, `content-visibility:hidden` or
     `[inert]`-subtree match **does not count**. See **D20** for how both
     consumers reach one implementation.
  3. If `expectText` is set, a surviving match qualifies when its
     `textContent`, **whitespace-collapsed, trimmed and lower-cased**, contains
     the likewise-normalised `expectText`. If `expectText` is unset, any
     surviving match qualifies.
  4. **Observed = at least one qualifying match.** Zero → not observed.
     Deliberately "any", not "all": a selector matching a desktop and a mobile
     copy of the same control is the normal responsive case, and requiring all
     would report `dead` for a live session.
- **Truth table** (complete — no default-through):

| `--storage-state` | `authSentinel` declared | Sentinel observed | `authLiveness` | Effect |
|---|---|---|---|---|
| no | no | — | `n/a` | Unauthenticated run; no degradation, no auth warning |
| no | yes | no | `n/a` | Same — a sentinel is only asserted when auth was attempted |
| no | yes | yes | `n/a` | Same; recorded as a note (app may not need auth) |
| yes | no | — | **`unverified`** | Cannot confirm the session; scorecard caveated |
| yes | yes | yes | **`live`** | Full authoritative verdicts |
| yes | yes | no | **`dead`** | Degrade: `unverified`, no authoritative findings |
| yes | yes | selector error | **`unverified`** | Authoring bug, reported as such |

**D12 — One composition point for capture verdicts (#5).** *Round-1 H5.*
`emptyNavShells` and `authLiveness` are independent signals that can fire
together and contradict. A single pure `composeCaptureVerdict({authLiveness,
emptyNavShells, hasStorageState})` returns `{status, degrade, warnings[]}`.

**Composed status is its own closed enum — it is NOT `authLiveness` reused**
(round-2 H1 fixed a real contradiction here: the first draft degraded on
`status !== 'live'`, which would have degraded every ordinary unauthenticated
run, directly contradicting D11's "no degradation" rows):

| `authLiveness` | Empty shells | Composed `status` | `degrade` | Primary warning |
|---|---|---|---|---|
| `dead` | any | `auth-dead` | **yes** | expired/invalid session |
| `unverified` | any | `auth-unverified` | **yes** | cannot confirm session |
| `n/a` | yes | `shells-empty` | **no** | empty nav container(s) |
| `n/a` | no, no storage-state | `no-auth-state` | **no** | advisory: app may be auth-gated |
| ~~`n/a`~~ | ~~no, storage-state given~~ | **UNREACHABLE** | — | *(see invariant below)* |
| `live` | yes | `live-empty-shells` | **no** | empty nav container(s) |
| `live` | no | `live` | no | *(none)* |

**Domain invariant (round-3 H7 — a real contradiction, now closed).** The row
above was struck because D11 and D12 described the *same* input differently: D11
maps (`--storage-state` given, no sentinel) to `authLiveness: 'unverified'`, while
D12 also carried a row mapping (`n/a`, storage-state given) to `live`. Both cannot
hold. D11 is authoritative, so the invariant is:

> **`authLiveness === 'n/a'` ⟺ no `--storage-state` was supplied.**

This is enforced at the boundary, not left to callers: `runVerify` computes
`authLiveness` in one place, and `composeCaptureVerdict` **throws** on the
impossible pair (`n/a` + `hasStorageState`) rather than defaulting it. The failure
mode H7 identified is exactly the one this prevents — an implementation that
initialises liveness to `n/a` and forgets to set it on the no-sentinel path would
otherwise emit authoritative findings from an unverified authenticated capture,
which is the defect this whole issue exists to fix. A thrown error is loud; a
silent `live` is the bug. A Tier-1 test asserts the throw.

**`degrade` is the single field that gates suppression — never a `status !==
'live'` comparison.** Only `auth-dead` and `auth-unverified` degrade: those are
the two states where we attempted authentication and cannot vouch for the
session. An unauthenticated run is *honestly unauthenticated*, not unverified,
so it keeps authoritative verdicts and gets an advisory line only — exactly what
D11's first three rows require.

Precedence — **`dead` > `unverified` > empty-shells > no-auth-state** — emits
**at most one primary warning** plus the empty-shell list as detail. A dead
session *explains* empty shells, so co-equal causes would send the operator
after the wrong one.

Propagation:

- `degrade === true` → `scorecard.status = 'unverified'`, live findings
  suppressed to `unverified` by reusing the v1.4 `unverifiableLayers` path — no
  parallel mechanism.
- **Persistence (round-2 M3).** `writeVerifyResult`
  (`scripts/lib/nav/verify-store.mjs:23-31`) runs `NavVerifyResultSchema.safeParse`
  and **throws** on failure, and Zod strips unknown keys by default — so returning
  `authLiveness`/`status` from `runVerify` does **not** get them persisted.
  `NavVerifyResultSchema` in `scripts/lib/nav/schema.mjs` must gain both fields
  (optional, for backward-readability); `verify-store.mjs` itself needs no change,
  which is why it is not in §7. The reader's existing tool-version binding
  (`verify-store.mjs:54`) rejects pre-bump results with "re-run --verify", so the
  bump below *is* the invalidation mechanism — no migration needed.
  `tests/nav-verify-store.test.mjs` covers the round-trip.
- Exit code is **unchanged** (verify already owns its exit contract at `:124-130`);
  degradation changes verdicts, not exit status. `--verify` was never a blocking
  gate and this plan does not make it one.
- `NAV_VERIFY_TOOL_VERSION` is bumped because live-result *semantics* change; the
  contract digest changes independently via the new field. Both are intended.

**D13 — Issue 4 fails CLOSED; unresolvable scope never means global (#15).** The
defect is not "scoping is unavailable" — the store branch exists — it is that the
*absence* of a scope silently selects the widest possible query. So the fix is a
precedence chain with no global default:

**The chain is evaluated top-down and short-circuits, so order is the contract:**

| # | Input | Behaviour |
|---|---|---|
| 1 | `--all-repos` | Explicit global, and the output says so — **read-only commands only, see D21** |
| 2 | `--repo-id <uuid>` | **Resolve the id to a repo record**, then scope to it; unknown id → error, never global (round-4 M5) |
| 3 | `--repo <slug>` | Resolve slug → repo record; unknown slug → error, never global |
| 4 | Neither, identity resolvable | Scope to this repo (**new default**) |
| 5 | Neither, identity unresolvable | **Zeroed counts + `reason`**, exit 0, never global |

> **Round-4 M5 — an explicit `--repo-id` must be resolved, not trusted.** An
> earlier version of row 2 read *"scope to it (current behaviour, preserved)"* —
> i.e. the uuid went straight into `WHERE repo_id = $1` unvalidated. A
> syntactically valid but nonexistent uuid then returns zero rows, which D19
> stamps `measured: true` — meaning **"this repo genuinely has no obligations"**
> for a repo that does not exist. That is the *exact* zero-versus-unmeasured
> conflation Issue 4 was reported through, surviving in the explicit-input path of
> its own fix (the same shape as the `--all-repos` ordering bug below: a hole left
> in the fix for the bug the fix is about). Both explicit forms now resolve to a
> repo **record** before any read or write; only a verified record may yield
> `scope.mode:'repo'` + `measured:true`. Unknown, malformed or inaccessible
> explicit identity → error before store access. §9 asserts the unknown-slug and
> unknown-id cases symmetrically, so neither path can regress alone.

> **Gemini-gate fix — `--all-repos` was unreachable.** It previously sat at the
> *bottom* of this table, below "identity resolvable → scope to this repo". Since
> the chain short-circuits, running `list-unlocked-fixes --all-repos` from inside
> any git repo would have resolved ambient identity at row 4 and terminated —
> **silently ignoring the flag** and scoping to the local repo. That is the same
> class of defect as Issue 4 itself (a flag accepted and quietly not honoured),
> reproduced inside its own fix. The ordering rule: **explicit operator intent is
> evaluated before ambient inference**, always. `--all-repos` combined with
> `--repo`/`--repo-id` is a contradiction → error, not a silent precedence win.

The unresolvable row copies `recommend-skills` (`:1777-1782`), which already
skips its signal rather than widening it, and matches `runWeeklyReview`'s
`BAD_INPUT` doctrine. Rejected alternative: keeping global as the fallback and
merely *labelling* it. A label does not stop `missing_spec_count` from being
recorded, and the whole failure was a number nobody questioned.

**D14 — reuse `--all-repos`, do not invent a flag (#4 No Hardcoding).** It is
already in `KNOWN_FLAGS` (`:172`) and the exact idiom being proposed already ships
in this file: `hasFlag('all-repos')` at `:1074` and `:1093`, under a docstring
that reads *"Leaderboard aggregate rows (**repo-scoped unless `--all-repos`**)"*
(`:1087`). So "scoped by default, global on explicit opt-in" is this file's
established convention — the two unlocked-fixes handlers are simply the ones that
never adopted it. A new `--global`/`--unscoped` synonym would give the codebase two
names for one concept, and since `assertKnownFlags` is global, the new name would
silently become valid for every other subcommand too.

**D19 — the scoped CLI result schema is explicit (#15, #19).** *Round-3 M6.*
"Zeroed counts + `reason`" left it undefined whether zero means *measured and
empty* or *not measured* — the exact conflation Issue 4 was reported through, so
leaving it implicit would reproduce the bug in the fix. Both handlers return:

```
{ ok, cloud, scope: { mode: 'repo'|'all-repos'|'unresolved',
                      repoId: string|null, slug: string|null },
  measured: boolean, reason: string|null,
  rows, shown, total, byMode: { total, code, plan } }
```

- `measured: true` + `total: 0` = **this repo genuinely has no obligations**.
  `measured: false` + `reason` = **nothing was measured**; counts are `0` only
  because they are not applicable, and callers must not render them as a backlog.
  One boolean separates the two readings that Issue 4 conflated.
- `scope.mode: 'all-repos'` is **printed in the human output** (`across all
  repositories`), so a global run is never mistakable for a scoped one — the
  self-labelling requirement in §9.
- An **unknown `--repo <slug>`** is an *error* (`ok: false`, non-zero exit): the
  operator asserted a specific repo and it does not exist. An **unresolvable
  ambient identity** (no flag, no git origin) is a *non-error*
  `measured: false` — nothing was asserted, so there is nothing to contradict.
  Distinguishing these is why `reason` is a field rather than prose.
- The worksheet additionally filters rows to the resolved repo **before
  rendering**, so no foreign row is ever presented as actionable (the read half
  of D18). Per D21 the worksheet can never return `scope.mode:'all-repos'` — that
  member of the union is reachable only by `list-unlocked-fixes`.

**D21 — scope capability is per-COMMAND, not one chain for all (#15, #5).**
*Round-4 H1.* D13 offered `--all-repos` to both handlers while D18 required the
worksheet to perform an ownership-safe targeted lookup and write scoped to **one
resolved repo**. Those cannot both hold: a command that may legitimately run
unscoped has no single repo identity to scope a write to. D18 also contradicted
itself internally — it said `:2211` "becomes an explicit `{allRepos: true}`" and
then, in the Gemini-gate correction below it, that the fix "removes the last
`{allRepos: true}` from a write path."

The chain in D13 is the **shared mechanism**; permitted scope modes are a
**per-command declaration** on top of it:

| Command | `--all-repos` | Required scope | Why |
|---|---|---|---|
| `list-unlocked-fixes` | **allowed** (self-labelled) | any chain outcome | Read-only reporting; a global view is a legitimate operator question |
| `cmdLockWithTestWorksheet` | **rejected before store access** | exactly one resolved repo | Renders a per-repo actionable queue; a global queue has no coherent meaning |
| the recorder at `:2211-2213` | **rejected before store access** | exactly one resolved repo | It *writes*; cross-tenant mutation is the worst case in this issue |

- Rejection is an **error before any store call**, not a filtered result — so an
  unscoped write can never be attempted and then cleaned up. Combining
  `--all-repos` with `--repo`/`--repo-id` is likewise a contradiction → error.
- **New store operation**: `getUnlockedFixById({ repoId, findingId })`, querying on
  **both** predicates. This replaces the `LIMIT 20` list-scan D18 identified, and
  it accepts no `allRepos` variant at all — the capability is absent from the
  signature rather than merely unused, so no future caller can pass it.
- The written `repo_id` comes from the **resolved scope**, never from the fetched
  row (D18's rule, now structurally enforced: the row is only reachable *via* the
  resolved `repoId`).
- §9 asserts `--all-repos` is refused by both write-adjacent paths and accepted by
  `list-unlocked-fixes`, so the asymmetry is pinned rather than conventional.

**D15 — the nudge is non-blocking and stays that way (#20).** Fixing the scope
makes the count *correct*; it does not make it a gate. Turning a newly-trustworthy
number into a blocker in the same change would couple a data-correctness fix to a
policy change, and this repo's own cried-wolf rule (D6) argues against blocking on
a backlog metric at all. Out of scope, stated so the omission reads as a decision
rather than an oversight.

**D20 — the shared predicate gets one canonical source; the SCANNER stays in
Markdown (#1 DRY, #5).** *Gemini gate — a genuine Catch-22 in my own design.* H8
requires `nav-audit` to run the *exact same* `isPerceivable` as `click-test`,
explicitly on DRY grounds. D16 simultaneously kept the predicate inside the
fenced block in `skills/click-test/references/dom-scanner.md`. `verify.mjs` has
no way to reach a function that exists only inside a Markdown fence, so the two
decisions as written were unsatisfiable together — the only ways out were
copy-pasting the source (violating the DRY rule H8 invoked) or parsing Markdown
at runtime from `verify.mjs` (absurd).

**The distinction D16 actually needs is predicate vs scanner.** D16 rejected
extracting the **scanner**, because the scanner *is* the reference document —
that reasoning stands and is unchanged. It says nothing about a ~15-line
predicate that now has two consumers in two domains. Extracting *that* is not the
restructuring D16 refused; it is the ordinary response to a second consumer
appearing.

- **Canonical source**: `scripts/lib/browser/perceivable.mjs`, exporting
  `PERCEIVABLE_SOURCE` (the function as a string, for `page.evaluate` injection),
  `PERCEIVABLE_FN_NAME` and `normaliseForDriftCheck`.
  **Correction applied during implementation (cluster-B audit):** an earlier
  draft also specified a Node-callable `isPerceivable` export "for Node-side unit
  tests". It was not built, deliberately — it needs a DOM (`getComputedStyle`,
  `getBoundingClientRect`), this repo has no jsdom/linkedom/happy-dom, so the
  export could never run. Shipping it would be dead code that reads like
  coverage. The predicate is exercised in a real browser by
  `tests/click-test-perceivability.test.mjs`.
- **`nav-audit`** injects `PERCEIVABLE_SOURCE` in its sentinel `page.evaluate`.
- **`click-test`'s Markdown fence keeps the predicate inline verbatim** — it must
  stay one self-contained pasteable block, since the agent pastes it into the
  browser.
- **Drift is caught by the test D16 already adds, not by new tooling.**
  `tests/click-test-perceivability.test.mjs` extracts the fence anyway, so it
  additionally asserts the fence **contains `PERCEIVABLE_SOURCE` as an exact
  substring**. *Gemini-gate correction:* an earlier draft said "byte-identical",
  which is impossible — D16 requires the same extracted string to evaluate to
  `scanDom()`, so it necessarily contains the whole scanner, of which the
  predicate is one part. Substring containment is the assertion that actually
  expresses "the fence embeds this exact predicate"; equality could never pass.
  Zero new scripts, zero new npm entries. (The existing
  `sync-shared-audit-refs.mjs` was considered and rejected: it syncs whole
  **files** from `docs/audit/shared-references/` into `skills/*/references/`, so
  it cannot own a fragment inside a larger document.)

**D18 — the unsafe default moves to the DATA-ACCESS boundary, not just the two
callers (#15 Error Handling, #5).** *Round-3 H9.* D13 fixes `cmdListUnlockedFixes`
and `cmdLockWithTestWorksheet`, but `getUnlockedFixes(undefined)` /
`countUnlockedFixes(undefined)` would still mean "every repo". Patching the two
known callers while leaving the footgun armed is the band-aid: the next caller
re-introduces the bug, which is precisely how the second unscoped site
(`:2241`) came to exist unnoticed. This is INC-002's lesson restated — *an
omitted argument is not a safety gate* — and this repo already paid for that
once.

**Chosen (root cause, and it is small because the blast radius is small).**
`getUnlockedFixes` / `countUnlockedFixes` take an explicit scope argument:
`{repoId}` or `{allRepos: true}`. Anything else — `undefined`, `null`, `{}` —
**throws**. Verified call sites, all in `scripts/cross-skill.mjs`: `:695`, `:701`
and `:2243` are already Phase 5's targets; `:1780` (`recommend-skills`) already
passes a real `ref.repoRowId` and just gains the wrapper; `:2211` **stops calling
the list function entirely** and moves to the targeted
`getUnlockedFixById({repoId, findingId})` under a resolved repo scope (D21). Five
edits plus three signatures — the whole reason the root-cause fix is affordable
here rather than deferred.

> **Round-4 H1 — superseded sentence.** This paragraph previously ended *"`:2211`
> becomes an explicit `{allRepos: true}`"*, which contradicted the Gemini-gate
> correction further down this same decision (and D21): the write path ends with
> **no** `allRepos` variant reachable. The `{allRepos: true}` form survives only
> on `list-unlocked-fixes`.

**Second half of H9 — the worksheet's cross-tenant WRITE.** `:2211-2213` calls
`getUnlockedFixes(null)`, finds the row by `findingId`, and then adopts
**`finding.repo_id` from whatever row matched**. A `findingId` belonging to
another repo is therefore looked up globally and its foreign `repo_id` written
straight into `recordRegressionSpec`. That is a cross-tenant *mutation*, strictly
worse than Issue 4's cross-tenant *read*.

**Do not use the list function for a single-finding lookup at all**
(Gemini-gate). An earlier draft kept `{allRepos: true}` here so the error could
distinguish "no such finding" from "another repo's finding". Gemini flagged that
as an unbounded global scan; **the mechanism is different and the consequence is
worse.** `getUnlockedFixes` is `LIMIT 20` (`plans-ship.mjs:467`), so it is not a
memory risk — it is a **correctness** one: the unscoped branch returns an
arbitrary 20 rows out of 232+ across all repos, so
`rows.find(r => r.audit_finding_id === findingId)` will usually **miss a finding
that genuinely exists**, fall through to `resolveRepoForStore({})`, and record
the spec anyway. That defect is **pre-existing**, not introduced here — and it is
in-scope by the impact test, because Phase 5's correctness rides directly on this
lookup.

Fix: replace the list-scan with a **targeted lookup by `audit_finding_id`,
scoped to the resolved repo**. Then:
- found → proceed;
- not found → error distinguishing "no such unlocked finding **in this repo**"
  from a bare miss, without ever reading another tenant's rows;
- the `repo_id` is taken from the **resolved identity**, never adopted from the
  fetched row.

This is smaller than the version it replaces (one indexed query instead of a
20-row scan plus an ownership assertion) and removes the last `{allRepos: true}`
from a write path. A test covers the foreign-`findingId` refusal.

**D17 — Issue 1's implementation is CEDED to
[`repo-scoped-skill-surfaces-and-installer.md`](repo-scoped-skill-surfaces-and-installer.md)
(#1 DRY, #5 Single Source of Truth).** Discovered 2026-07-30, after round 2: that
plan's file table claims the *same two files* for the *same feature* (its rows 14
and 15 — "extend the drift backstop to detect a stranded bundle copy in
`~/.claude/skills/`" + "cover the new global-tree detection"). Two sessions were
about to write competing detectors into one file.

Ceded rather than contested, on three grounds — and note that the second and
third are the load-bearing ones; mere ownership would not be enough:

1. **Coherence.** That plan owns `install-skills.mjs`, `surface-paths.mjs`,
   `setup.mjs` and the uninstaller. Retiring a surface and detecting its leftovers
   is one change; splitting it across two plans puts the detector and the thing it
   detects under different gates.
2. **My design was built for a world that plan abolishes.** D1-D6 model an
   *ongoing* global surface that drifts, so they compare content and grade it
   `current` vs `divergent`. That plan **retires** the surface (`resolveSkillTargets`
   throws for `claude`), after which any global tree is stranded debris **regardless
   of content** — making my content comparison largely moot and my `current` verdict
   actively wrong (it would report a byte-identical stranded tree as fine).
3. **Their primitive is already built and strictly better.**
   `scripts/lib/install/legacy-surfaces.mjs::inspectLegacySurfaces({homeRoot,
   repoRoot})` exists in the working tree with tests. It covers **two** retired
   surfaces — `~/.claude/skills/` *and* repo-scoped `.agents/skills/` — where my
   design saw only the global one; its own docstring names that omission *"a **false
   clean**, which is exactly the success-path failure class this bundle's own
   doctrine forbids."* It also classifies per-member and folds to a surface state,
   handling the partially-cleaned tree my design would have mis-graded, and injects
   its roots for hermetic testing.

**What this plan keeps**: Issue 1's *evidence* (§1 — the measurements, the receipt
data, and the live proof that the global copy won this session), because it is the
field report motivating that plan, and the Phase 6 verification. **What it drops**:
Phase 1, Cluster A, and any edit to `scripts/check-stale-skill-surface.mjs`.
D1-D6 are retained as **superseded design notes**, marked as such, because the
round-1 findings that produced them (H1, H2, M3) are part of this plan's audit
trail and deleting them would erase why the design changed.

**D16 — the click-test predicate gets a real executable test home (#11
Testability).** *Round-2 M4.* §9 promised deterministic assertions for severity
capping and the `position:fixed` regression while §7 listed no test file that
could run them — a "GREEN ≠ REALIZED" gap in this plan's own testing section.
Right-sizing:

- **Band-aid** — delete the deterministic claims and rely on the Phase 5
  empirical run alone. Rejected: it removes all regression protection from a
  predicate whose whole purpose is to stop a recurring false severity.
- **Over-built** — extract the scanner into a `scripts/lib/click-test/*.mjs`
  module with a jsdom harness. Rejected twice over: it adds a dependency the repo
  does not have (verified — no jsdom/linkedom/happy-dom), and it restructures the
  skill's progressive-disclosure architecture, in which the scanner *is* the
  reference document. **Scope note (D20):** this rejection covers the **scanner**.
  The `isPerceivable` **predicate** IS extracted to
  `scripts/lib/browser/perceivable.mjs`, because `nav-audit` became a second
  consumer of it — see D20 for why that is a different decision, not a reversal.
- **Chosen** — one test that reads the fenced JS block out of `dom-scanner.md`
  and evaluates it in Playwright (`^1.60.0`, already a dependency) via
  `page.setContent()` against small HTML fixtures. The Markdown stays the single
  source of truth, so the test cannot drift from the shipped snippet, and it
  exercises the *real* browser semantics `checkVisibility` depends on — which
  jsdom would only have simulated.

**Skip-vs-fail:** if Chromium is unavailable the test **fails**, it does not skip.
A skipping test reads green having verified nothing, which is the precise
sandbox-honesty failure this plan exists to correct; and `/click-test` itself
already requires a browser, so the dependency is not new to the skill.

**Extraction contract (round-3 M5).** "Extract the fenced JS block" is ambiguous
the moment the reference grows a second `js` fence — an incidental docs edit could
silently make the test evaluate the wrong block, or fail for parser reasons
unrelated to the scanner. Pinned:

- **Marker, not ordinal.** The scanner fence is delimited by an HTML-comment
  sentinel pair in `dom-scanner.md` — `<!-- scanner:begin -->` / `<!-- scanner:end -->`
  — and the test extracts the single ```` ```js ```` fence between them. Selecting
  "the first fence" or "the longest fence" would be position-dependent; the
  sentinel is edit-order-independent.
- **Zero or ≥2 matches is a test FAILURE** with a message naming the sentinel, not
  a fallback to another fence. Same reasoning as skip-vs-fail: a silent fallback
  reads green having tested something else.
- **Entry point.** The block evaluates to a function `scanDom()` returning
  `{findings, shadowGapCount, iframeGapCount}` — already its shape today, so no
  restructuring. The test does
  `page.evaluate(new Function(src + '; return scanDom();'))`.
- **Observation protocol.** Each fixture is a small HTML string via
  `page.setContent()`; assertions read `findings[]` and check `(kind, severity,
  perceivable)` triples. Fixtures cover the D10 matrix: hidden file input,
  `visibility:hidden` ancestor, `opacity:0`, `position:fixed` visible,
  `content-visibility:hidden`, detached node, zero-size, and a plain visible
  control as the positive case.
- **Provisioning.** Chromium comes from the repo's existing
  `npx playwright install chromium` step (already required by `/click-test`,
  `/nav-audit --verify` and `/visual-audit`); the test adds no new setup.

*Note on ordering (not a decision, a consequence):* Issue 4 must land before any
re-measurement of the unlocked-fix backlog, because every historical figure —
including the corrected 94 — was drawn from the wrong population.

---

## 6. Sustainability Notes

**Assumptions that could change.**
- *`~/.claude/skills` is the only global surface.* Copilot also reads
  `~/.copilot/skills` and `~/.agents/skills` (AGENTS.md). D1's `{root, surface,
  label}` operand makes a second pair a data addition, not a code change.
- *`Element.checkVisibility()` is available.* Chromium 105+; Playwright ships
  Chromium. The ancestor-walk fallback (D10) covers a non-Chromium driver.
- *A contract digest change is acceptable.* Adding `authSentinel` invalidates
  persisted verify results once. That is the digest working as designed.

**Seams built in.** The surface-pair operand list (Issue 1) and the `mode`
parameter on `buildDraftCaptureWarning` (Issue 3). Neither is speculative: the
first is *required now* because the global root is outside `repoRoot`, the second
*required now* because bootstrap and verify need different remediation text.

**Deliberately NOT built.** No auto-refresh of the global copy (installer's job,
parallel session owns it). No axe-core dependency. No login-flow automation. No
`authSentinel` auto-inference. No accessibility-tree oracle (D10).

---

## 7. File-Level Plan

| File | Intent | Purpose |
|---|---|---|
| ~~`scripts/check-stale-skill-surface.mjs`~~ | **CEDED** | D17 — owned by `repo-scoped-skill-surfaces-and-installer.md` (its rows 14-15). This plan must not touch it. |
| ~~`tests/stale-skill-surface.test.mjs`~~ | **CEDED** | D17 — same. |
| `skills/click-test/references/dom-scanner.md` | modify | `isPerceivable()` per D10; call inside `push()`; severity cap; remove the `:226-228` duplicate guard; retire the `:310` debt row. |
| `skills/click-test/SKILL.md` | modify | Severity table + report shape gain `perceivable`; correct the `/ship`-gate premise; note the v2-persistence interaction. |
| `scripts/lib/browser/perceivable.mjs` | **create** | D20 — canonical predicate source. Exports **exactly** `PERCEIVABLE_SOURCE` (the function as a string, for `page.evaluate` injection), `PERCEIVABLE_FN_NAME` and `normaliseForDriftCheck`. **No Node-callable `isPerceivable`** — it needs a DOM this repo cannot provide (round-4 M3). Resolves the H8/D16 Catch-22; consumed by both `nav-audit` and the click-test fence. |
| `tests/click-test-perceivability.test.mjs` | **create** | Round-2 M4 — the executable home §9 previously promised but did not provide. Extracts the scanner's fenced JS block from `dom-scanner.md` (keeping the Markdown authoritative — no copy-paste fork), evaluates it via Playwright `page.setContent()` against DOM fixtures, and asserts the D10 matrix + severity capping. |
| `scripts/lib/nav/bootstrap-draft.mjs` | modify | `buildDraftCaptureWarning({mode})`; add pure `composeCaptureVerdict()` (D12). |
| `scripts/nav-audit.mjs` | modify | Wire the verify-path warning; render the composed verdict; fix the backwards `:146` message. |
| `scripts/lib/nav/verify.mjs` | modify | Observe `authSentinel`; return `authLiveness`; bump `NAV_VERIFY_TOOL_VERSION`. |
| `scripts/lib/nav/schema.mjs` | modify | **Two distinct schema changes (round-4 M2), both required:** (a) the *contract input* schema gains the optional `authSentinel` object with Zod validation (D11); (b) `NavVerifyResultSchema` — the *persisted result* schema — gains optional `authLiveness` and the composed capture `status`/`warnings`. (b) is not optional polish: `writeVerifyResult` runs `safeParse` and Zod strips unknown keys, so without it the new fields render in-process and are silently dropped from disk (D12). |
| `tests/nav-verify-store.test.mjs` | modify | Round-4 M2 — persistence round-trip for `live`, `dead`, `unverified`, **and** a pre-bump stored fixture that must be rejected with "re-run --verify". Cited by D12 but previously absent from this table, so the round-trip was an unowned requirement. |
| `skills/nav-audit/SKILL.md` | modify | `authSentinel` authoring recipe + worked example (M1 — JSON forbids comments, so the recipe lives here, not as a stub comment). |
| `tests/nav-verify.test.mjs` | modify | Verify-path warning, `mode` text, all 7 D11 truth-table rows, D12 precedence. |
| `scripts/cross-skill.mjs` | modify | D13 precedence chain in `cmdListUnlockedFixes` (`:691`) **and** `cmdLockWithTestWorksheet` (`:2241`); `--all-repos` opt-in; D19 result schema; D18 explicit scope at all 5 call sites (`:695`, `:701`, `:1780`, `:2211`, `:2243`) + the foreign-`repo_id` write fence at `:2211-2213`. ⚠ **concurrently edited — see below.** |
| `scripts/lib/store/plans-ship.mjs` | modify | D18 + D21. `getUnlockedFixes` / `countUnlockedFixes` take `{repoId}` \| `{allRepos:true}` and **throw** on an omitted/ambiguous scope (`undefined`/`null`/`{}`/both), moving the unsafe default off the data-access boundary. **New**: `getUnlockedFixById({repoId, findingId})` — queries on both predicates, and takes **no** `allRepos` variant, so the write path structurally cannot go global. Every direct importer of these three is migrated in the same change; no legacy positional call survives. Not under concurrent edit. |
| `skills/ship/SKILL.md` | modify | Step 0.5b: pass repo scope; state that the count is repo-scoped; note that a `reason` means "not measured", not "zero obligations". |
| `tests/cross-skill-unlocked-scope.test.mjs` | create | Tier-1 tests for the D13 chain on both handlers (no existing test file covers these two). |
| `docs/plans/skill-shadow-and-capture-honesty.md` | create | This plan. |

**Not touched (parallel session owns):** `scripts/install-skills.mjs`,
`tests/fixtures/expected-schema.json` — the latter is the **PostgreSQL
`public`-schema snapshot** regenerated by `npm run db:local:regen` after a SQL
migration, unrelated to the nav-contract Zod schema (round-1 M1 rebuttal
sustained).

> ⚠ **Concurrency hazard (Issue 4 only).** At the time of writing, another
> session has **uncommitted** changes to `scripts/cross-skill.mjs`,
> `scripts/lib/store/runs-findings.mjs` and both copies of `skills/ship/SKILL.md`
> (the final-review-credit workstream, adding Step 6.7). Issue 4 edits two of
> those four files. Per the shared-working-tree rule: stage by name only, never
> `git add -A`, and re-read both files immediately before editing rather than
> relying on line numbers in this plan. Cluster E is deliberately last (§11) so
> that work lands first. `scripts/lib/store/plans-ship.mjs` is *not* under
> concurrent edit, so it can be changed freely.
>
> **Round-4 M1 correction.** This note previously said Issue 4 "needs no change to
> `scripts/lib/store/plans-ship.mjs` — the scoped branches it needs already exist
> there." That was true of the *original* Issue-4 design and became false when D18
> moved the unsafe default to the data-access boundary. The two are materially
> different: reusing the existing scoped branches leaves `undefined`/`null` armed
> as a future global-query footgun, which is the very thing D18 exists to
> disarm. **D18 is the sole authoritative contract for that file**; this note now
> speaks only to concurrency, not to scope of change.

### 7b. Implementation Phases

*(Gate 1 fires: 14 files, 3 subsystems.)*

> **Phase 1 (global surface detection) was CEDED to
> [`repo-scoped-skill-surfaces-and-installer.md`](repo-scoped-skill-surfaces-and-installer.md)
> on 2026-07-30 — see D17. Phases are numbered from 2 to keep the round-1/2
> finding references (D1-D6) readable; there is no Phase 1.**

**Phase 2 — click-test perceivability.** Add `isPerceivable(el)` per D10; call it
once inside `push()`; cap non-perceivable findings at P3 and tag
`perceivable:false` with state-relative wording; delete the now-redundant
`:226-228` guard; replace the `:310` debt row; correct the `/ship`-gate premise in
`SKILL.md`; add the Playwright-backed fixture test (D16) including its
fence-vs-`PERCEIVABLE_SOURCE` drift assertion (D20). Establishes the canonical
predicate that Phase 4's sentinel consumes, which is why it precedes Cluster C.
Files: `scripts/lib/browser/perceivable.mjs` (create),
`skills/click-test/references/dom-scanner.md` (modify),
`skills/click-test/SKILL.md` (modify),
`tests/click-test-perceivability.test.mjs` (create).
**All behaviour tests for the predicate execute in a real browser** — no
Node-callable export exists to unit-test (round-4 M3, D20).

**Phase 3 — nav-audit verify capture-honesty wiring.** Add `mode` to
`buildDraftCaptureWarning`; add pure `composeCaptureVerdict` (D12); call it on the
verify path with `report.emptyNavShells`; correct the backwards `--storage-state`
message. Files: `scripts/lib/nav/bootstrap-draft.mjs` (modify),
`scripts/nav-audit.mjs` (modify), `tests/nav-verify.test.mjs` (modify).

**Phase 4 — nav-audit auth-liveness assertion.** `authSentinel` on the contract
schema with Zod validation; **and `NavVerifyResultSchema` gains optional
`authLiveness` + composed `status`/`warnings`** (round-4 M2 — without this the new
fields never reach disk); observe the sentinel in `runVerify` at the D11 timing;
return `authLiveness`; feed `composeCaptureVerdict`; degrade via the existing
`unverifiableLayers` path; bump `NAV_VERIFY_TOOL_VERSION`; document the authoring
recipe. Files: `scripts/lib/nav/schema.mjs` (modify),
`scripts/lib/nav/verify.mjs` (modify), `scripts/nav-audit.mjs` (modify),
`skills/nav-audit/SKILL.md` (modify), `tests/nav-verify.test.mjs` (modify),
`tests/nav-verify-store.test.mjs` (modify).

**Phase 5 — Repo-scoping for the unlocked-fix backlog.** Implement the D13
precedence chain in `cmdListUnlockedFixes` and `cmdLockWithTestWorksheet`, with
**both explicit identity forms resolved to a repo record** before any store access
(round-4 M5); apply the **per-command scope capabilities** of D21 — `--all-repos`
allowed only on `list-unlocked-fixes`, refused before store access on the
worksheet and the recorder; add `--all-repos` as that command's explicit global
opt-in (D14); return `reason` on the unresolvable path and never widen to global;
update Step 0.5b to pass scope and to distinguish "0 obligations" from "not
measured". Apply D18 (explicit store scope at all 5 call sites) and add
`getUnlockedFixById({repoId, findingId})`, replacing the `LIMIT 20` list-scan on
the write path so no `allRepos` variant is reachable there. Apply the D19 result
schema. Re-read both concurrently-edited source files immediately before editing
(§7). Files: `scripts/cross-skill.mjs` (modify),
`scripts/lib/store/plans-ship.mjs` (modify), `skills/ship/SKILL.md` (modify),
`tests/cross-skill-unlocked-scope.test.mjs` (create).

**Phase 6 — Backlog re-measurement.** Only after Phase 5. Re-run
`list-unlocked-fixes` scoped to this repo and record the true figure; confirm it
matches the independent evidence that this repo's obligations were cleared (PR
#204's "repo count 0"). Explicitly **do not** backfill historical
`ship_events.missing_spec_count` rows — see the risk register. No source files.

> **Phases 7-8 were RECLASSIFIED out of §7b (2026-07-30, `/cycle` Step 0.7
> preflight).** Both declare "No source files", which left Cluster D with an
> **empty derived scope** — structurally un-auditable, since `/audit-code
> --scope=diff` has no diff to read. The §7b grammar is explicit that
> *verify* work "is NOT a phase"; these are verification gates, not
> implementation. They are listed below as **Verification (not phases)**,
> excluded from the §11 partition, and **Cluster D is removed**. This does not
> weaken them: Phase V1 remains a hard gate under the pre-ship-empirical-verify
> doctrine, and V2 was always blocked on another plan landing.

### Verification (not phases — excluded from the §11 partition)

**V1 — Empirical verification against a live app.** Required by the
pre-ship-empirical-verify doctrine for Phases 2 and 4 (both assert on a live
runtime). Run `/click-test` against wine-cellar-app and confirm the 4
hidden-file-input findings demote to P3 and the ~31 `aria-hidden-focusable`
findings leave the headline; run `/nav-audit --verify` three times — valid
`authed.json` + declared sentinel (expect `live`), deliberately expired
`authed.json` (expect `dead` + `unverified`, zero authoritative findings), and no
sentinel declared (expect `unverified`). No source files.

**V2 — Cross-plan verification of the ceded Issue 1 (D17).** After
`repo-scoped-skill-surfaces-and-installer.md` lands, verify **as a consumer of
its behaviour, writing no code**: (a) `node scripts/install-skills.mjs --surface
claude` throws rather than writing to `~/.claude/skills/`; (b) after its
`--uninstall-legacy`, `~/.claude/skills/` no longer intercepts — re-run the
`/plan` invocation that opened this plan and confirm the Skill tool resolves
`<repo>/.claude/skills/plan`, not the global copy (this is the reproducer that
started this work, so it is the correct acceptance test); (c) `npm run
skills:check-surface` reports the stranded tree while it exists and `clean`
after cleanup. Any disagreement is reported to that plan's owner — this plan
does not patch it. No source files.

**Close-out (not a phase)**: `npm run skills:regenerate` (Phases 2, 4 and 5 edit
`skills/**`, so `.claude/skills/**` must be regenerated for the Category-B
byte-identical contract) then `npm run check`. Phase 5 also touches a CLI, so
`npm run cli:flags:gate` must pass.

---

## 8. Risk & Trade-off Register

| Risk | Likelihood | Mitigation |
|---|---|---|
| ~~`--gate-global` advisory is ignored~~ | — | **Removed (round-3 H6)** — belongs to the ceded Issue 1; risk is now `repo-scoped-skill-surfaces-and-installer.md`'s to carry. |
| **Contract-digest change invalidates persisted verify results** | Certain, once | Accepted and documented. `authSentinel` is optional, so existing contracts keep working. |
| **`checkVisibility` absent AND fallback throws** | Low | Fail-open to current behaviour (D10) — failing closed would demote everything to P3 and disable the signal. |
| **Demote-not-drop leaves the 704-finding noise in the report** | High | Intended (D8). The headline filters on perceivable; the full set stays available. |
| **`authSentinel` undeclared everywhere, so Phase 4 is inert** | Medium | The `unverified` state fires *without* a sentinel (D11 row 4) and is itself the honest answer. The recipe in `skills/nav-audit/SKILL.md` is the adoption path. |
| **`divergent` under-states a real shadow and gets ignored** | Medium | Accepted (D4). Over-claiming precedence we never measured is the worse error; the report cites the Claude Code observation as evidence. |
| **Parallel session's installer change conflicts** | Low | D7 — no shared constant. Phase 6 verifies rather than integrates. |
| **Historical `ship_events.missing_spec_count` stays wrong** | Certain | **Accepted, not fixed.** `ship_events` is append-only; the rows were written from a foreign population and the correct per-ship value is not recoverable after the fact (the view is a live 14-day window, not a snapshot). Any analysis of this column for events before Phase 7 is unusable — recorded here so a future reader does not mistake the data for signal. No reader exists today, which is what keeps this accepted rather than blocking. |
| **Phase 7 collides with the concurrent `cross-skill.mjs` edit** | Medium | Cluster E runs last; re-read before editing; stage by name only. The two workstreams touch different functions (`cmdListUnlockedFixes`/`cmdLockWithTestWorksheet` vs the Step 6.7 final-review-credit path), so the conflict risk is textual, not semantic. |
| **`--repo` slug resolution adds a failure mode Step 0.5b did not have** | Low | An unknown slug errors instead of silently returning global (D13) — louder than today, and the identity-resolved default means the common path passes no flag at all. |

### Deliberately deferred

- **Auto-refreshing the global copy** — installer's job; parallel session owns it.
- **`~/.copilot/skills` / `~/.agents/skills` pairs** — the operand seam exists; no
  evidence either is populated here, so adding them now is the over-built cliff.
- **click-test v2 store persistence** — tracked separately at
  `skills/click-test/SKILL.md:594-599`. This plan makes that future integration
  *safe to build*; it does not build it.
- **Shadow-DOM / iframe traversal** — unrelated pre-existing v2 debt at
  `dom-scanner.md:306-309`. Independence: `isPerceivable` operates on already-
  traversed light-DOM elements and neither reads nor alters traversal, so nothing
  in this plan rides on those paths.
- **Auditing every other `cross-skill.mjs` subcommand for the same scoping bug** —
  Issue 4 fixes the two `getUnlockedFixes` call sites it has evidence for, and
  five siblings were verified correct in passing. A full census of all ~60
  subcommands is a separate, larger task. **Flagged rather than silently skipped**,
  because this repo's own rule is that hand-counting undercounts a mechanical bug
  class — the honest position is "two fixed, five verified, the rest unexamined",
  not "the class is closed".
- **Making the corrected count blocking** — D15. Scope fix now, policy later if
  ever.
- **Backfilling historical `missing_spec_count`** — not recoverable; see the risk
  register.

---

## 9. Testing Strategy

> **Round-3 H6 — ceded-scope residue removed.** This section previously required
> Tier-1 tests for `compareSkillSurfaces` / `decideStaleSurfaceExit`, the D5 state
> matrix, `--gate-global`, and global-surface sandbox honesty. All of those are
> only satisfiable by editing the two files §7 marks **CEDED**, so as written they
> were unowned requirements that would have recreated the very concurrent-detector
> conflict D17 exists to prevent. They are deleted here and are the other plan's
> to specify. The **only** Issue-1 obligation this plan retains is the black-box
> Phase 8 verification, which writes no code.

**Tier 1 (test-first — deterministic seams).**
`buildDraftCaptureWarning({mode})` text selection; `composeCaptureVerdict`
precedence including the contradictory `dead` + empty-shells case; the pure
auth-liveness decision across all 7 D11 rows; the D13 scope-precedence chain.

**Fail-closed / success-path adversarial tests** (*"audit your success paths"*):
- `authLiveness: 'dead'` → scorecard `unverified` and **zero** authoritative
  `misplaced`/`missing` findings.
- Invalid CSS selector → `unverified`, never `dead`.
- Non-perceivable element → severity P3 and never P0, asserted per-kind; a
  `position:fixed` visible element → perceivable (the `offsetParent` regression).
- **No flag, identity unresolvable → zeroed counts + `reason`, and the store's
  unscoped branch is never reached** (the Issue 4 defect, asserted directly rather
  than via the returned number — a zero could otherwise mean either outcome).
- **`--repo <slug>` changes the result** — the regression test for the observed
  field symptom: scoped and unscoped output must NOT be byte-identical when the
  store holds rows for more than one repo.
- **`--all-repos` reaches the global branch and the output says it is global** — so
  the opt-in remains genuinely available and self-labelling.
- **Both handlers are asserted, not just the reported one** —
  `cmdLockWithTestWorksheet` gets the same matrix, since it was found unscoped by
  inspection rather than by field failure and has no test today.
- **`--all-repos` is REFUSED by the worksheet and the recorder, before any store
  call** (D21), and accepted by `list-unlocked-fixes` — the asymmetry is pinned in
  both directions, so neither a lost capability nor a leaked one regresses silently.
- **Unknown `--repo-id <uuid>` errors exactly like an unknown `--repo <slug>`**
  (round-4 M5) — asserted as a *pair*, since the whole defect was one explicit
  form being validated and the other trusted. A well-formed-but-nonexistent uuid
  must never produce `measured: true`.
- **A foreign `findingId` is refused** — `getUnlockedFixById({repoId, findingId})`
  with a finding belonging to another repo returns not-found and **no**
  `regression_specs` row is written; the assertion is on the absence of the write,
  not merely on the error text.
- **Persisted nav results round-trip** (round-4 M2) — `authLiveness` and the
  composed `status` survive `writeVerifyResult` → read, for `live` / `dead` /
  `unverified`; a pre-bump stored fixture is rejected with "re-run --verify".
  Asserted through the store, because Zod's key-stripping means an in-process
  assertion would pass while disk silently lost the fields.
- **Detached-node perceivability is asserted directly, not via `scanDom()`**
  (round-4 L1) — scanner fixtures cover only DOM-connected elements that can
  actually reach `push()`.
- **CSS-overridden `[hidden]` agrees across both branches** (round-4 M4) — the
  primary and fallback paths return the same verdict for an element whose CSS
  restores `display:block` over the UA default.

**Sandbox honesty.** With Issue 1 ceded, this plan adds **no pre-push check**, so
the "can it go green in a clean checkout having read nothing?" question applies
only to the new tests. `tests/click-test-perceivability.test.mjs` is the one at
risk, and D16 answers it: missing Chromium **fails**, never skips. The
global-surface sandbox analysis that lived here moved with the cession (D17) —
`repo-scoped-skill-surfaces-and-installer.md` owns it, and its inspector already
injects `homeRoot`/`repoRoot` precisely so a hermetic fixture drives it.

**Empirical (Phase 7).** Live-app runs gate Phases 2 and 4; a green unit suite
does not discharge them.

---

## 11. Execution Clustering

> **Cluster A was removed with Phase 1 (D17)** — ceded to
> `repo-scoped-skill-surfaces-and-installer.md`. Cluster letters are unchanged so
> the audit trail stays readable; the partition below covers every remaining §7b
> implementation phase (2-6) exactly once, with 7-8 as the verification cluster.

- **Cluster B** — Phases 2 — fix-gate: yes
  - Coupling: `SKILL.md` and its `references/dom-scanner.md` are one
    progressive-disclosure unit — the severity table in the parent must match the
    scanner's emitted shape, and `skills:check` enforces the reference-index
    byte-match, so they cannot land separately.
  - author-tier: standard
- **Cluster C** — Phases 3-4 — fix-gate: yes
  - Coupling: both rewrite the same seam — the verify path in
    `scripts/nav-audit.mjs` and the `runVerify` return contract. Phase 4's
    `authLiveness` is an input to Phase 3's `composeCaptureVerdict`, so splitting
    them would land a composition function with one of its two signals missing.
  - **Depends on Cluster B** (new, from D20): Phase 4's sentinel check consumes
    `PERCEIVABLE_SOURCE` from `scripts/lib/browser/perceivable.mjs`, which Phase 2
    creates. This is why B carries `fix-gate: yes` and precedes C — the ordering
    was already correct, but it was previously incidental and is now load-bearing.
    B and C are still separate clusters: they share one small module, not a seam,
    and C's nav-audit changes are independently auditable.
  - author-tier: frontier
- **Cluster E** — Phases 5-6 — fix-gate: yes
  - Coupling: one precedence chain (D13) applied to two handlers in one file, plus
    the `SKILL.md` step that consumes their output. Phase 6 is the re-measurement
    Phase 5 makes meaningful, and is worthless before it.
  - **Ordering**: phases were renumbered so that ascending order *is* execution
    order (grammar rule 1 — contiguous ascending ranges give a valid topological
    order without a separate dependency graph). E runs **last among the source
    clusters** not for a code dependency — it shares nothing with B or C — but
    because another session holds uncommitted edits to two of its three files
    (§7). A working-tree-conflict decision, not an architectural one.
  - author-tier: standard
> **Cluster D removed** (`/cycle` Step 0.7 preflight, 2026-07-30) — its members
> were Phases 7-8, both file-less, giving it an empty derived scope. They are now
> **V1/V2 under "Verification (not phases)"** and run after the final gate. The
> partition below covers §7b implementation phases **2-6** exactly once.

- **Final gate**: consolidated Gemini review over the union diff of Clusters B, C and E.

---

## Audit Trail

**Round 1** (`gpt-5.6-terra`, 74.5s, ~$0.49) — `SIGNIFICANT_GAPS`, H:5 M:3 L:0.
All 5 HIGH and 3 MEDIUM addressed above (D1←H1, D5←H2, corrected-premise←H3,
D11←H4, D12←H5, authoring recipe←M1, D10←M2, D4←M3).

**Deliberation** — 2 rebuttals, both **sustained**:
1. *H3 element-less findings* — overruled; `push()` requires `el` at `:47` and all
   16 call sites pass one. GPT: *"the element-less sub-point does not stand."*
2. *M1 `expected-schema.json`* — overruled as a category error (PostgreSQL schema
   snapshot vs nav-contract Zod schema). GPT: *"updating the database fixture
   would be noise."* New constraint accepted from the same resolution: JSON
   forbids comments, so the `authSentinel` authoring path is documented in
   `skills/nav-audit/SKILL.md` rather than as a commented stub.

**Most valuable outcome**: H3 exposed that this plan's own P1 justification for
Issue 2 — a false `/ship` release gate — did not exist. Issue 2 is downgraded to
P2 and reframed as preventive work ahead of the deferred v2 persistence.

**Post-round-1 addition — Issue 4 (2026-07-30).** Added from a downstream field
report after round 1 concluded. **Now audited**: it was in scope for round 3
(H9 → D18) and both Gemini rounds (the `--all-repos` precedence flaw → D13).

Verified this session (not inherited): the two unscoped call sites, the
already-scoped store branches, `--repo` in `KNOWN_FLAGS`, the three coexisting
repo-resolution idioms, the `missing_spec_count` write path and its absence of
readers, and the `weekly-review` fail-closed precedent.

Three corrections applied to the downstream report rather than repeating it —
the same discipline round-1 H3 forced:

1. **"The command cannot scope" → it can.** The store already implements
   `WHERE repo_id = $1`; only the CLI declines to pass a value. This is a caller
   bug, which is why Phase 7 is small and needs no migration.
2. **"A false release blocker" → it is not.** Step 0.5b is explicitly
   `(non-blocking)` and `missing_spec_count` has no reader. The real harm is
   cross-tenant output, corrupted history and misdirected remediation. Severity
   held at P1 on those grounds, not on a gate that does not exist.
3. **One unscoped site reported → two exist.** `cmdLockWithTestWorksheet` is
   also unscoped, and it is the very command Step 0.5b prints as its remediation —
   making it the only path here that can write wrong rows rather than just display
   them.

**Why this issue is the sharpest of the four**: Issues 1-3 are surfaces that
report success they did not earn. Issue 4 is a surface that reports *someone
else's* state as this repo's, and the `byMode` fix that shipped 2026-07-29
corrected the arithmetic on the wrong population — a reminder that a verified
fix to a derived number does not validate its source.

---

**Round 2** (`gpt-5.6-terra`, 86.2s) — `NEEDS_REVISION`, H:2 M:4 L:0 (HIGH −60%).
All 6 fixed: D10 dropped `contentVisibilityAuto` and added `content-visibility:hidden`
so both branches share one policy (M1); D11 gained operational "observed"
semantics closing the stale-template hole (H2); D12 gained a closed composed-status
enum, fixing a contradiction that would have degraded every unauthenticated run
(H1); symlink containment added, which is INC-001's actual lesson rather than its
headline (M2); persistence traced through `NavVerifyResultSchema`, since Zod
would otherwise have silently stripped the new fields (M3); D16 gave the
click-test predicate a real executable test home (M4).

**Round 3** (`gpt-5.6-terra`, 92.0s) — `SIGNIFICANT_GAPS`, H:4 M:2 L:0.
HIGH rose 2→4, but from **new material**, not rigor pressure: Issue 4 arrived
after round 2, and D17's cession restructured the plan between rounds. All 6
were concrete design defects and all are fixed — H6 (ceded-scope residue still
demanding tests on CEDED files), H7 (a genuine D11/D12 contradiction, now closed
by a throwing domain invariant), H8 (`locator.isVisible()` ≠ `checkVisibility`,
so the sentinel could have accepted an `opacity:0` stale template), H9 (the
unsafe default left armed at the data-access boundary, plus a cross-tenant
**write** at `cross-skill.mjs:2211`), M5 (Markdown extraction contract), M6
(D19 result schema).

**Structural change between rounds 2 and 3 — Issue 1 CEDED (D17).** Discovered
that `repo-scoped-skill-surfaces-and-installer.md` claimed the same two files for
the same feature, *and* had already built a better primitive
(`scripts/lib/install/legacy-surfaces.mjs`, covering two retired surfaces where
this plan saw one). Phase 1 and Cluster A were removed; D1-D7 are retained as
superseded design notes so the round-1 audit trail survives.

**Gemini gate — round 1 of 2** (`claude-opus-5` fallback, 82.4s) — `CONCERNS`, 3
new. All accepted, all real, one a bug this plan introduced: observing the
`authSentinel` in the first captured state only meant observing on **mobile**
(`nav-audit.mjs:287`), where the sentinel hides in a collapsed drawer — a false
`dead` on every responsive app. Also: `checkVisibility()` does not evaluate
`inert`, so D10's branches disagreed; and H8-vs-D16 was a genuine Catch-22,
resolved by D20 (extract the ~15-line **predicate**, keep the **scanner** in
Markdown — the distinction D16 actually needed).

**Gemini gate — round 2 of 2** (`claude-opus-5` fallback, 110s) — `CONCERNS`, 3
new. All accepted and fixed: `--all-repos` sat at the bottom of a short-circuiting
precedence chain and was therefore **unreachable** from inside any git repo —
Issue 4's own defect reproduced inside its fix; the `PERCEIVABLE_SOURCE` drift
assertion demanded an impossible byte-equality against the whole scanner
(corrected to substring containment); and the worksheet's ownership lookup was
wrong. On that last one the finding was **directionally right with the wrong
mechanism**, corrected against source rather than accepted as stated:
`getUnlockedFixes` is `LIMIT 20` (`plans-ship.mjs:467`), so it is not the OOM
risk described — it is worse, an arbitrary 20-row slice of 232+ cross-repo rows
in which a genuinely-existing finding usually will **not** appear. Replaced with
a targeted repo-scoped lookup.

**STOP DECISION — GPT 3 rounds (cap), Gemini 2 rounds (cap). No round 3 of
either.** The GPT cap is reached; the Gemini cap is reached and the
genuine-net-new-design-bug exception is deliberately **not** invoked. Its three
round-2 findings were unambiguous and cheap — reorder a table row, change equality
to containment, swap a list-scan for an indexed lookup — leaving no design
uncertainty a third reviewer could resolve. Continuing would be rigor-chasing
against an infinite refinement surface, which is exactly what both caps exist to
prevent. Residual risk is carried into implementation, where `/audit-code`
verifies against real code — the right artifact for what remains.

---

**Round 4 — post-cap, triggered by a scope change, not by rigor-chasing**
(`gpt-5.6-terra`, 152.5s, 32.3K in / 7.3K out) — `NEEDS_REVISION`, H:1 M:5 L:1.

**Why a 4th round at all, when round 3 recorded a STOP.** The stop decision above
was correct *for the document it was made on*. Issue 4 was then **added after that
decision** (downstream field report, 2026-07-30) and D17-D21 restructured Issues 1
and 4 substantially — so the plan the caps were spent on is not the plan on disk.
A cap protects against re-auditing the *same* artifact for diminishing returns; it
is not a licence to ship an unaudited section. No prior ledger existed on disk, so
this ran fresh (no R2+ suppression) — an accepted cost, since suppression would
have been keyed to the pre-Issue-4 document anyway.

**The findings vindicate the decision to re-run**: all 7 are **internal
self-contradictions introduced by accumulated editing**, not rigor pressure. Every
one names two places in the plan that cannot both be true. That is the failure mode
of a document edited across four sessions, and it is exactly what a fresh reader
catches and an incremental one does not.

All 7 accepted and fixed; none rebutted, deliberately — a rebuttal argues about
*validity*, and each finding was confirmed by reading the two conflicting passages
side by side, which leaves nothing to deliberate:

| # | Contradiction | Resolution |
|---|---|---|
| H1 | D13/D19 gave `--all-repos` to the worksheet; D18 required one resolved repo for its ownership-safe lookup **and write**. D18 also contradicted *itself* (`:2211` "becomes `{allRepos:true}`" vs "removes the last `{allRepos:true}` from a write path"). | **D21** — scope capability is per-command. `--all-repos` is read-only-command-only, refused before store access on the worksheet and recorder. New `getUnlockedFixById({repoId, findingId})` has no `allRepos` variant *in its signature*. |
| M1 | §7 required changing `plans-ship.mjs` (D18); the concurrency note said Issue 4 "needs no change" to it. | Stale sentence removed; **D18 is the sole authority** for that file. The note now speaks only to concurrency. |
| M2 | D12 required `NavVerifyResultSchema` to gain the new fields and cited `tests/nav-verify-store.test.mjs`; §7 listed neither. | Schema row split into contract-input vs persisted-result; test file added to §7, Phase 4 and §9 with a pre-bump-fixture case. |
| M3 | §7 still promised a Node-callable `isPerceivable` "for Node-side tests"; D20 records that it was deliberately **not built** (no DOM available). | §7 and Phase 2 now list the three real exports; all predicate tests run in-browser. |
| M4 | Fallback treated `[hidden]` as non-perceivable; primary branch had no such term — so CSS overriding the UA default made the branches disagree, violating D10's own one-policy rule. | Resolved toward **effective CSS**: attribute check dropped from the fallback. `[inert]` stays explicit in both (not a CSS concept). Fixture pins it. |
| M5 | `--repo <slug>` was validated but `--repo-id <uuid>` was trusted, so a nonexistent-but-well-formed uuid returned `measured:true` — "genuinely no obligations" for a repo that does not exist. | Both explicit forms resolve to a repo **record** before any access; symmetric tests. |
| L1 | D10 required a detached-node case, but the prescribed test reaches the predicate only via `scanDom()`, which cannot enumerate a detached element. | Case moved to a direct in-page predicate test; scanner fixtures cover connected elements only. |

**Pattern worth recording**: M5 and the round-2 `--all-repos` ordering bug are the
same shape — *the fix for a silently-ignored input silently ignored a different
input of the same kind*. Twice in one plan. When fixing an input-validation defect,
enumerate **every** input on that path, not the one that was reported.

**STOP — no round 5, and no third Gemini round.** The GPT surface is now genuinely
converged on this artifact: round 4 found contradictions rather than design gaps,
and the fixes were mechanical reconciliations of text that already agreed on
intent. Remaining risk is implementation-shaped (do the signatures actually get
migrated at every call site? does the fence really embed the predicate?) and
belongs to `/audit-code` against real code — the right artifact, per the same
reasoning round 3 used.

---

## V1 / V2 — empirical verification results (2026-07-30)

Run against a live deployed instance of the wine-cellar app.

### V1 found a real bug that the unit suite could not

First live run: **331 findings, only 2 perceivable** — 329 capped to P3. The
probe showed `<header>` and `<main>` were `display:flex`/`block`,
`visibility:visible`, `opacity:1`, with 1248×90 and 1248×662 rects — plainly
visible — yet the predicate returned `false`. Both carried **`[inert]`**: the app
had a modal open and inerted the background, which is the standard pattern.

One attribute suppressed almost an entire page. That is the **inverse** of the
defect this work targeted, and strictly worse: noise merely annoys, but silent
suppression hides real, visible violations.

**Root cause was a design error, not a slip.** `inert` is an *interactivity*
property, not a visibility one — an inert element is still painted. The Gemini
gate had correctly observed that `checkVisibility()` ignores `inert` while the
fallback walk honoured it, so the branches disagreed; that finding was accepted
and "fixed" by **adding** the check to the primary branch. The correct resolution
was to **remove** it from the fallback. Both branches now answer only "is this
painted?".

The lesson generalises: a reviewer flagging an *inconsistency* tells you two
things disagree, not which one is right. Aligning on the wrong side is a way to
close a finding while making the code worse.

Post-fix live re-run: **29 perceivable, 302 capped, 0 unknown** (from 2/329).

**Honest limits of the V1 click-test leg:**
- The original field report's *"4 of 5 P0 `input-no-name` were hidden file
  inputs"* is **NOT reproducible** on the current app state — there are **zero**
  `input-no-name` findings and `P0_effective: 0`. That specific count is
  therefore *unconfirmed*, not verified. What is verified is the cap mechanism
  itself on a real page, and the `aria-hidden-focusable` split (271
  non-perceivable vs 24 perceivable) which matches the reported pattern in kind.
- The tri-state never returned `null` on this app, so the unknown path is
  covered only by the fixture suite.

### V1 — nav-audit auth-liveness: four legs, all as designed

| Leg | `authLiveness` | status | `degrade` |
|---|---|---|---|
| no `--storage-state` | `n/a` | `shells-empty` | **false** |
| `--storage-state`, no sentinel | `unverified` | `auth-unverified` | true |
| `--storage-state` + sentinel observed | `live` | `live-empty-shells` | false |
| `--storage-state` + sentinel absent | `dead` | `auth-dead` | true |

Row 1 is the important one: an ordinary unauthenticated run does **not** degrade.
An earlier draft degraded on `status !== 'live'`, which would have suppressed
findings on every no-auth run — the D12/H7 contradiction, confirmed fixed live.

`AUTH SESSION DEAD` reaches stderr as the **primary** warning with the
empty-shell list demoted to detail, per the D12 precedence rule.

**Synthetic leg, disclosed:** the `live` row points the sentinel at an element
that is present on the served page. A genuinely authenticated session was not
established — that needs credentials, which is out of bounds — so the
observed→`live` branch is verified *mechanically*, not end-to-end.

### V2 — the ceded Issue 1, verified as a consumer

Its owning plan landed as `0965d54` + `b7efb9e`.

- `install-skills.mjs --surface claude` now **refuses** with a migration message
  pointing at `--uninstall-legacy`.
- `~/.claude/skills/` is **empty (0 entries)** and the global receipt is absent —
  the stranded tree that opened this whole investigation is gone, so the
  precedence hazard is closed at the root.
- `check-stale-skill-surface.mjs` still covers the global + `.agents` surfaces
  (it imports `inspectLegacySurfaces`) and correctly reports clean now that
  there is nothing to find — verified as *detection intact*, not as detection
  removed.

**Gemini gate — round 3, invoked under the genuine-net-new-design-bug exception**
(`claude-opus-5` fallback, 109s) — `CONCERNS`, 1 new (MEDIUM), 0 wrongly dismissed.
Accepted and fixed.

**G1 — the `visibility` ancestor walk was CSS-incorrect.** D10's fallback walked
`el` and every ancestor returning `false` on `visibility:hidden|collapse`. But
`visibility` is an **inherited** property, so a descendant can declare
`visibility: visible` inside a hidden subtree and be fully rendered.
`checkVisibility()` (primary branch) evaluates that as `true` while the walk would
say `false` — the same branch-disagreement class as round-4 M4, in the same
decision, found one edit later. Fixed by splitting the fallback into two scopes:
`visibility` is read **once on the target** (its computed value already carries
inheritance), while `display:none` / `opacity:0` / `content-visibility:hidden` /
`[inert]` — none of which a descendant can override — keep the ancestor walk. The
field-motivating case is unaffected, since those elements inherited `hidden`
without overriding it.

**Why this exceeded the 2-round Gemini cap, and why it stops here.** The cap's
exception is a *concrete net-new design bug*, and G1 is exactly that: a wrong CSS
semantic that would have shipped a predicate whose two branches disagree — not a
completeness nit, not "specify X". The fix is one paragraph with no design
uncertainty left, so a 4th gate round would resolve nothing and would be the
rigor-chasing the cap exists to prevent. **Gate closed at CONCERNS-then-fixed.**

**Note on the shadow reviewer** (observation-only, never gates): buckets were
`both:0, primary-only:1, shadow-only:3`. Zero overlap between primary and shadow on
this artifact. Per the standing finding that *"found it" ≠ "found it first"*, the
three shadow-only items are **not** adopted here — the shadow is not a second gate,
and adopting its output would silently convert an A/B instrument into one.

**Convergence, stated plainly.** Round 4 + gate round 3 found **two instances of
one bug class** in D10 (M4's `[hidden]` attribute check, G1's `visibility` walk):
both were the fallback branch disagreeing with the primary branch. Two independent
reviewers found two different instances, which is evidence the *class* was
under-specified rather than that either instance was unlucky. D10 now states, for
every property it tests, **which scope it is tested at and why** — the structural
fix, rather than a third patch. If a third instance appears during implementation,
that is a signal to replace the hand-written fallback with a single documented
policy table, not to patch again.

---

## Round-4 implementation delta (verified against committed code, 2026-07-30)

Round 4 + gate round 3 were run **after** Clusters B/C/E had already landed, so
most of their findings describe code that was written in parallel. Each was checked
against the working tree rather than assumed open. **Do not re-implement the rows
marked DONE.**

| # | State in code | Evidence |
|---|---|---|
| M5 (`--repo-id` unvalidated) | **DONE — and better than this plan specified.** `resolveShipNudgeScope` (`cross-skill.mjs:713-772`) validates against `listRepoIds()`, *translates* an arch-memory `repo_uuid` to the `audit_repos.id` the views key on, and refuses with `repo-id-unverifiable` when the store cannot be read rather than reporting a number. | commit `8d9c2e8` |
| M2 (result schema + store test) | **DONE.** `NavVerifyResultSchema` carries `authLiveness` and `captureVerdict{status,degrade,warnings}` (`nav/schema.mjs:184-190`); `tests/nav-verify-store.test.mjs` exists. | — |
| M3 (no Node-callable predicate) | **DONE.** `perceivable.mjs` exports exactly `PERCEIVABLE_FN_NAME`, `PERCEIVABLE_SOURCE`, `normaliseForDriftCheck`. | — |
| H1 — cross-tenant **write** fence | **DONE, under a different name.** The targeted lookup shipped as `findUnlockedFixInRepo({repoId, findingId})` (`plans-ship.mjs:542`) — both predicates, throws on either missing, **no `allRepos` variant in the signature**. The recorder resolves identity first and takes `repo_id` from the resolved scope (`cross-skill.mjs:2333-2352`). **D21's `getUnlockedFixById` is that function; the code name is authoritative and this plan's name is the stale one.** | — |
| **G1 — `visibility` inside the ancestor walk** | **OPEN.** `perceivable.mjs:113` tests `cs.visibility` on every ancestor. `visibility` is inherited, so a `visibility:visible` descendant of a hidden parent is rendered — the walk returns `false` where `checkVisibility()` returns `true`. Fix: read it **once on `el`**. | `perceivable.mjs:110-117` |
| **M4 — `[hidden]` attribute in the walk** | **OPEN, narrow.** `perceivable.mjs:116` returns `false` on any `[hidden]` ancestor. Correct under the UA default (it *is* `display:none`, already caught by computed style) but wrong when CSS overrides it, which is the same branch-disagreement class as G1. Fix: drop the attribute test. | `perceivable.mjs:116` |
| **H1 residual — worksheet accepts `--all-repos`** | **OPEN, narrow.** `cmdLockWithTestWorksheet` (`cross-skill.mjs:2390`) passes the generic `storeScopeFor(scope)`, so `--all-repos` still renders a *global* queue of pasteable `lock-with-test` commands. Consequence is bounded to a misleading worksheet — the recorder refuses foreign findings — but D21 requires refusal **before store access**. | `cross-skill.mjs:2390` |
| **L1 — detached-node case untested** | **OPEN, minor.** The `!el.isConnected` guard exists (`perceivable.mjs:96`); no test covers it, and it is unreachable via `scanDom()`. Add the direct in-page predicate assertion. | — |

**One plan claim was falsified by the implementation, not the reverse.** Round-4 M4
asserted `[inert]` must be an explicit term in both branches. A live run
(commit `03bd0ad`) removed it: `inert` is an interactivity property, an inert element
is still painted, and the term suppressed **329 of 331** elements on a real app whose
open modal inerted a fully-visible `<header>`/`<main>`. D10 now records the exclusion
and says *do not re-add it*. This is the pre-ship-empirical-verify doctrine paying
out exactly as intended — a live run beat four rounds of static review, and the
correction flows plan-ward.

**Net remaining work: two one-line predicate corrections, one guard, one test.** Both
predicate fixes are the *same bug class* (a property tested at the wrong scope in the
fallback branch), which is why D10 now states the scope for every property it tests.

---

## Round-4 delta — implemented, gated, and the stop decision

All four open rows above are closed. Verified: full suite **9529 pass / 0 fail /
22 skipped**; `tests/click-test-perceivability.test.mjs` **16/16 in real headless
Chromium** (running, not skipped); `tests/cross-skill-unlocked-scope.test.mjs` 37/37.

| Item | Change |
|---|---|
| G1 | `visibility` moved out of the ancestor walk, read once on the target (inherited property). Regression test: `visibility:visible` child of a `visibility:hidden` parent keeps P0. |
| M4 | `[hidden]` attribute test removed from the fallback. Regression test: with `[hidden]{display:block}` the element is perceivable; the `<input type="file" hidden>` demotion still passes. |
| L1 | Detached-node case asserted directly against the injected predicate inside `page.evaluate`, not via a scanner fixture that could never fail. |
| H1 residual | `lock-with-test --worksheet` refuses `--all-repos` with `all-repos-unsupported` **before any store call**; `list-unlocked-fixes` keeps it. Test pins the asymmetry in **both** directions and asserts the guard precedes the store call. |

**A HEAD-level break closed in passing.** A concurrent session swept the
`dom-scanner.md` fence edit into commits `dd677848`/`dd1b4b5a` **without** its
canonical source module, so at those commits the fence carried the new predicate
while `perceivable.mjs` carried the old one — and the drift test asserts
containment, so `main` was red until this delta landed. Cause: a shared working
tree, which §7's concurrency note anticipated; the mitigation that mattered was
staging by name and re-reading before editing.

### Consolidated Gemini gate — 2 rounds, then STOP at CONCERNS-then-fixed

| Round | Verdict | Finding | Disposition |
|---|---|---|---|
| 1 | `CONCERNS` | **G1** the walk used `parentElement`, which is `null` for a shadow root's direct child → an invisible *host* was missed. **G2** the new test bounded its slices with hardcoded `+2400`/`+1200` offsets. | Both fixed. G2 was a false-**pass** risk, not untidiness: a test whose bound depends on the length of what it measures cannot be trusted to fail. Replaced with `fnBody()`, bounded at the next top-level declaration. |
| 2 | `CONCERNS` | **G1** slotted light-DOM elements bypass the shadow tree where their `<slot>` lives; follow `assignedSlot` first. | Fixed (one line), **gate closed without a round 3**. |

**Why stop.** Rounds 1 and 2 produced the *third and fourth* correction to one
code path, all of the same class — "the fallback disagrees with
`checkVisibility()`" — at ~1 per round. That is the cap's explicit stop signal
(rising nit-per-round on an infinite refinement surface), and a third round would
predictably surface a fifth composed-tree edge case.

**The trend is the finding, and it is recorded in the module rather than patched
again.** Each fix was correct in isolation, but the branch **only executes when
`checkVisibility` is absent**, and both consumers drive Playwright's Chromium 105+
where it is always present — so none of the four corrections changed observable
behaviour for any shipped caller. `perceivable.mjs` now carries an explicit
**revisit trigger**: on a fifth instance, delete the fallback and return `null`
(UNKNOWN — which the tri-state contract already handles honestly), or take a real
composed-tree dependency. Continuing to hand-maintain a shadow implementation of a
browser API for a path that never runs is the over-engineering cliff, named so the
next reader does not walk into it.

**Shadow reviewer** (observation-only): round 1 `both:0 / primary-only:2 /
shadow-only:3`. Not adopted — the shadow is an A/B instrument, not a second gate.

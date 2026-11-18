# Plan: prior-upstream recognition for REWRITTEN destinations
- **Date**: 2026-11-18
- **Status**: Approved
- **Author**: Claude + Louis
- **Scope**: backend (Node ESM CLI lib `scripts/lib/sync-divergence.mjs`, `scripts/lib/sync-outbound.mjs`, wiring in `scripts/sync-to-repos.mjs`; stack `js-ts`)
- **Target domain(s)**: `install`
- **Tier-3 seam**: the consumer sync / relocation contract (AGENTS.md §Testing doctrine). The fix and its tests land in the SAME commit.
- **Fleet**: proposal `p-20261118050838-b759`. Follows PR #390 (`e93ccd78`), which stopped NEW false divergences but did not unstick existing ones.

**Neighbourhood considered**: `get-neighbourhood` (intent: "render each earlier upstream source blob through the sync outbound
renderer so prior-upstream recognition matches rewritten destinations") returned only `sync-divergence.mjs`'s own exports
(`classifyAgainstBase`, `decideAction`, `describeReason`, ...) and two unrelated symbols. No new exported symbol is planned: the
change extends `createPriorUpstreamResolver().matches` and reuses `renderOutbound`, the one outbound renderer (#388).

## 1. Context: why storyline stays stuck, and the mechanism measured

Storyline holds `.claude/skills/fleet/references/chip-preamble.md` and `participant-rules.md` COMMITTED at bytes the sync
itself wrote at CES `f3b37321` (storyline commit `9f63870d`, "bundle sync from ... f3b37321 (#603)"). Its manifest records the
NEXT render (base `7c7aa973` / `d6cf0e45`), so the disk differs from the base: `classifyAgainstBase` says DIVERGED, git says
tracked and committed, and `decideAction` refuses. Prior-upstream recognition (2221), the rule that exists for exactly this
"stale snapshot, not an edit" case, is never asked:

- `scripts/sync-to-repos.mjs:1322` (`e93ccd78`): `if (vcs && !rewriteResult.hits) vcs.priorUpstream = ...`
- `scripts/lib/sync-outbound.mjs:116` (`e93ccd78`): `... && !hits && ... priorUpstreamMatches?.() === true`

The skip exists because the resolver hashes RAW source blobs, and a rewritten destination never holds raw bytes
(`node scripts/x.mjs` becomes `node scripts/.claude-skills/x.mjs`). The resolver's own docstring says earlier versions "cannot
be reconstructed from the source blob". **That is false for the current pipeline, measured** (read-only, 2026-11-18, scratch
script rendering each historical blob of the two files through today's `renderOutbound` with the `ownedSourceTails` derived
from storyline's own manifest by `buildOwnedSourceTailsFromConsumerManifest`):

| File | storyline disk | render of CES blob at `4c8458d0` (the version `f3b37321` shipped) | render of HEAD blob | manifest base |
|------|----------------|------|------|------|
| chip-preamble.md | `9d62e1da` | `9d62e1da` (3 rewrites) | `7c7aa973` | `7c7aa973` |
| participant-rules.md | `7da3cf3b` | `7da3cf3b` (10 rewrites) | `d6cf0e45` | `d6cf0e45` |

So rendering earlier blobs through the CURRENT renderer reproduces the stale bytes exactly. Raw-blob hashes (`73942340`,
`eb9cf918`) do not, which is the bug.

## 2. Design

### 2.1 How earlier renders are enumerated: bounded source history, rendered on demand

`createPriorUpstreamResolver` keeps its existing enumeration and bounds unchanged: one `git log --raw -n perPathMax` per source
path (default 100), ONE `git cat-file --batch` per path for uncached blobs, a run-wide blob budget (default 2000), and the
shallow-repository refusal. What changes is what is compared:

- `load()` keeps each blob's BODY (a `Buffer`) alongside its two raw hashes, under two BYTE caps (R1 H3): a body larger than
  `maxRenderBlobBytes` (default 2 MiB) is not retained, and once the retained total reaches `maxRetainedBytes` (default 64 MiB)
  no further body is retained: a body is admitted only if `retained + body.length <= maxRetainedBytes`, so the last one cannot
  overshoot. A retained body is COPIED into its own buffer (`Buffer.from(body)`), never kept as the `subarray` view the parser
  holds today (`sync-divergence.mjs:624`), which would pin the whole batch's stdout allocation (R3 H1); the batch buffer is
  then unreferenced when `load()` returns. A blob whose body was not retained keeps its raw hashes but has no rendered hash, and counts as
  "not fully answered" (§2.3). The bodies a `cat-file --batch` returns are already in memory today (the hash is computed from
  them), so the caps bound what is KEPT, not what is read. The read is unchanged and already bounded twice: by the blob-count
  budget and by `spawnSync`'s `maxBuffer: 256 MiB` (`sync-divergence.mjs:566-567`, `e93ccd78`); a batch over it errors, `load()`
  returns false and `matches` returns `null` (fail closed). Those are per-allocation bounds, not a total-process bound: a batch
  buffer, the retained bodies (≤ 64 MiB) and one render can coexist (R2 H1, GPT deliberation: no streaming redesign).
- `matches(srcRel, diskHash, { render, acceptRaw = true } = {})`:
  - `render(text) => string`, optional. Each retained body is decoded as UTF-8 (the sync reads source with
    `readFileSync(..., 'utf-8')`) and rendered; the RENDERED hashes (LF form and CRLF form, mirroring the raw pair) are compared.
  - `acceptRaw`: whether RAW historical hashes count as evidence (R1 H2). The callers pass exactly today's rule: raw is accepted
    only when the CURRENT outbound for this destination has no rewrite hits. A rewritten destination therefore matches ONLY a
    rendered earlier version, so a consumer who committed an old RAW source blob there (for example by deliberately removing the
    relocation rewrites) is still refused. A non-rewritten destination keeps today's raw match, plus the rendered one (which
    additionally covers banner-injected and re-serialised JSON destinations whose raw bytes never equalled the disk).
- Rendered hashes are memoised per call only, never across calls or consumers: a render depends on the destination and on the
  consumer's `rewriteConfig` (`ownedSourceTails` is per consumer), and the resolver is shared across consumers. Render work per
  call is at most one pass per blob of that path (at most `perPathMax`, 100), a regex/JSON pass over at most 2 MiB each, and is
  incurred only for a DIVERGED or unmanifested destination (a handful per run in steady state). The git work, which is the cost
  the blob budget exists for, is unchanged.

**Why not the manifest's recorded hashes.** The manifest holds ONE hash per destination, the current base, which
`classifyAgainstBase` already compares. Storyline's stale bytes are the base from a sync BEFORE that one; no committed or
gitignored artifact records the per-file history of written hashes (`.sync-receipt.json` records runs and held paths, not
every written hash). Adding such a history would be a new persisted artifact for one question that the source history
already answers, and it would not help any consumer synced before it existed (storyline included). Rejected as
over-engineering.

**Why the current renderer and not the renderer as it was at that commit.** Running historical code is not on the table (the
sync runs one revision of its own code). The current renderer is a pure function of (blob, dstRel, rewriteConfig); when it
reproduces the disk bytes, those bytes are by construction derived from a genuine upstream blob. When the renderer or the
consumer's `ownedSourceTails` changed since that sync, either the render does not reproduce the stale bytes (refused as today,
fail closed) or it matches a render that was never actually deployed to this consumer. The second is still upstream-derived
content (§2.2), so it is within the safety contract; it is not proof the sync wrote those bytes, and the plan does not claim it is.

### 2.2 Why a match is safe (the invariant the refusal protects)

The refusal exists so a consumer's EDIT is never overwritten. Disk bytes equal to `render(blob)` for a blob upstream once held
at this source path contain nothing the consumer authored: they are a deterministic function of upstream content and of the
consumer's own bundle inventory. Replacing them loses nothing. The raw-hash comparison keeps the same argument it has today.
The match still goes through `decideAction`'s existing `diverged-prior-upstream` row (`WRITE_LOUD`, never silent, and never
when `staleSyncRef` is set), so the decision table does not change.

**The safety contract, stated (unchanged from 2221; R1 H1, GPT deliberation ruled the contract stands):** evidence is equality
with an upstream-derived version, never proof of deployment (the shipped raw-blob rule never checked deployment either: a blob
upstream held for one commit between two syncs matches too). **Accepted limitation**: equality cannot tell a stale snapshot from
a consumer's DELIBERATE rollback to an earlier upstream-derived version; such a rollback is replaced, loudly, with the
`equals an earlier upstream version` line naming the path. A consumer who wants to keep it declares an override, which is
decided before this question is asked (`override` short-circuits `vcs` at `sync-to-repos.mjs:1317`).

### 2.3 Fail-closed rules

`matches` returns `true | false | null`, and only `true` is evidence (`decideAction` and `decideUnmanifested` test `=== true`).

- A blob whose body contains NUL is not rendered (binary; the raw hashes still apply where `acceptRaw`).
- A `render` that THROWS for a blob (an old JSON that does not parse, a pin-guard throw) gives that blob no rendered hash; it
  never matches through rendering.
- `true` when any blob's rendered hash, or (only where `acceptRaw`) raw hash, equals the disk hash. A positive match is decided
  per blob and stands even if another blob of the same path failed: it is a proof by one genuine upstream blob.
- Otherwise `null` when the question was not fully answered: any blob unreadable, or (with `render`) any blob that got no
  rendered hash for ANY reason: its render threw, its body was not retained under the byte caps, or it is binary (NUL) and was
  therefore not rendered (R2 M1). Else `false`. This keeps the existing "never `false` for could-not-look" rule.
- Unchanged: budget exhausted, git failure, shallow history -> `null`; an empty or unreadable destination is never rehabilitated
  (`decideUnmanifested` checks that before asking).

### 2.4 Wiring

- `scripts/sync-to-repos.mjs:1322`: drop the `!rewriteResult.hits` guard; pass `acceptRaw: !rewriteResult.hits` and
  `render: (text) => renderOutbound({ srcRel, dstRel, srcContent: text, existingContent: null, rewriteConfig }).content`.
  `existingContent: null` on purpose: for a co-owned JSON surface the outbound depends on the disk, and rendering an old blob
  merged with today's disk would make the "earlier version" partly the consumer's content. Such a surface therefore matches only
  a pure upstream render, which is still safe (§2.2), and otherwise is refused as today.
- `scripts/sync-to-repos.mjs:1102` (unmanifested-orphan scan): `priorUpstreamMatches` becomes
  `({ acceptRaw }) => ... priorUpstream.matches(srcRel, hash, { acceptRaw, render })` with the same `render` closure.
- `scripts/lib/sync-outbound.mjs:116`: drop the `!hits` guard and call `priorUpstreamMatches({ acceptRaw: hits === 0 })`;
  `decideUnmanifested` already computes `hits` from the one renderer, so the raw-vs-rendered rule is decided in one place per
  call site from the same render the write would use. An oracle that ignores its argument (the existing tests' `() => true`)
  keeps working.
- Docstrings that state the old limitation are corrected: `sync-divergence.mjs:556-557`, `sync-outbound.mjs:92,114`,
  `sync-to-repos.mjs:1320-1321`.

No change to `decideAction`, `classifyAgainstBase`, the manifest writer, `selectManifestBases` or the reporting strings.

## 3. Tests: one new file, `tests/sync-prior-upstream-rewritten.test.mjs`

The coordinator's claim covers `tests/sync-prior-upstream*.test.mjs` only; no existing `tests/sync-*.test.mjs` is edited (the
existing title in `tests/sync-outbound.test.mjs:104` "only when nothing was rewritten" becomes stale wording but does not
assert the rewritten case, so it stays green; flagged to the coordinator, not edited).

1. **Resolver on a deterministic disposable git repo (unit; R1 M2: the mechanism does not depend on CES history)**: a temp
   source repo with three versions of `a.md`, each containing `node scripts/x.mjs`; `render` = the real `renderOutbound` with
   `ownedSourceTails: {'x.mjs'}` (so it rewrites), `acceptRaw: false`.
   - disk = `render(v1)`: without `render` (the OLD behaviour, the mechanism's negative control) `false`; with `render` `true`.
   - disk = `render(v1)` with CRLF line endings: `true`.
   - disk = a hand edit of `render(v1)`: `false`.
   - disk = RAW `v1` (rewrites removed by hand), `acceptRaw: false`: `false` (R1 H2); the same with `acceptRaw: true`: `true`
     (today's raw rule, unchanged for non-rewritten destinations).
   - two consumers' `render` closures with different `ownedSourceTails` over ONE resolver instance: each disk matches only under
     its own closure (no cross-consumer reuse; R1 M1).
   - a `render` that throws for v2 only, disk = `render(v1)`: `true` (one genuine blob proves it); disk = a hand edit: `null`,
     never `false` or `true`.
   - a `render` that throws for every blob: `null`.
   - `maxRenderBlobBytes` below v1's size, disk = `render(v1)`: `null`; `maxRetainedBytes` exhausted by an earlier path, the
     same; the existing blob-count budget exhaustion with `render` given: `null` (R1 H3, M1).
   - a binary (NUL) blob with `acceptRaw: true`: raw match `true`; with `acceptRaw: false`: `null` (not renderable, not answered).
   - retention (R3 H1), through a test-only `stats.retainedBytes` and the injected `git` seam returning a large batch: every
     retained body's `buffer.byteLength` equals its own length (not the batch's), and `retainedBytes <= maxRetainedBytes` after a
     body that would have crossed the cap was offered last.
2. **Rewritten stale snapshot, end to end through the real CLI (the mandatory regression; R2 M2 GPT compromise)**. Shape of
   `tests/sync-stale-snapshot-e2e.test.mjs`. The CLI syncs FROM this repository (`SOURCE_ROOT` is the script's own repo,
   `sync-to-repos.mjs:242`), so the earlier version comes from this repo's history, chosen to be robust to history growth:
   the MOST RECENT older version of `.claude/skills/fleet/references/chip-preamble.md` (walking `git log -n 40`, the first rev
   whose render differs from the current outbound and has `hits > 0`). The most recent older version is always far inside the
   resolver's 100-version bound. A disposable git consumer, first sync, commit; write `renderOutbound` of that blob with the
   `ownedSourceTails` read from the fixture consumer's own manifest; commit; the next sync exits 0, no `REFUSED`, the file
   equals the current outbound, the output shows `equals an earlier upstream version`. Positive control: such a rev exists
   (assert with a message naming the cause). Skipped visibly only on a shallow source, as its sibling suite is; the one
   mandatory runner, `full-suite.yml`, checks out with `fetch-depth: 0` (line 45), so it never skips there.
3. **Negative cases, same fixture**: a hand-edited version of that rewritten file, committed: `REFUSED`, bytes intact. The RAW
   blob of that rev committed there: `REFUSED` (R1 H2 end to end).
3a. **Storyline reproduction (labelled diagnostic, history-dependent by design)**: a separate `describe` in the same file reads
   the IMMUTABLE blob `f3b37321:.claude/skills/fleet/references/chip-preamble.md` (storyline's exact case, which the task
   requires) and runs the same refuse-at-parent / update-after flow. It asserts first that this blob is among the last
   `perPathMax` (100) blob oids of the path and, if not, FAILS with "storyline's f3b37321 version is now beyond the resolver's
   history bound": an operational signal that production would no longer recognise storyline's case, not a regression in
   this change.
4. **Unmanifested orphan path, end to end** (R1 M1: through the real scan and resolver, not a stub oracle): same fixture; the
   f3b37321-era render on disk and the path's entry removed from the consumer's gitignored `scripts/.sync-manifest.json`, so the
   ownership scan meets it as an unmanifested orphan. Expected: no collision abort, reported as owned by `prior-upstream`, file
   updated. Plus a unit case: `decideUnmanifested` with a rewriting `rewriteConfig` and an oracle recording its argument is
   `owned`/`prior-upstream` and was asked `{acceptRaw: false}` (red on `e93ccd78`, where `!hits` returns `collision`).

Unchanged and already covered by existing suites (run, not edited): `staleSyncRef` precedence and the decision table
(`tests/sync-divergence-prior-upstream.test.mjs`), empty or unreadable destinations (`tests/sync-d-hardening.test.mjs:89`,
`tests/sync-outbound.test.mjs:119`).

**Red evidence (negative control the task asks for)**: tests 2, 3a and 4 (e2e) run against the parent `e93ccd78` (a pinned
worktree via `npm run fixture:create` is NOT needed: no spend; a plain `git worktree add` at `e93ccd78` with the new test file
copied in; the CLI there syncs from that worktree, so it is the parent's code) and fail: 2 and 3a with `REFUSED` on the stale
file, 4 with a collision. Then, on the fix branch, re-inserting `!rewriteResult.hits` at the wiring site turns 2 and 3a red
again; removed, green. Both runs are recorded in the code-audit trail below with their output lines.

Targeted runs: the new file plus the existing `tests/sync-outbound.test.mjs`, `tests/sync-divergence-prior-upstream.test.mjs`,
`tests/sync-stale-snapshot-e2e.test.mjs`, `tests/sync-d-hardening.test.mjs`. Then `npm run guards:preflight`. Full suite: per
the coordinator, CES feature branches are pushed by the coordinator under the standing preflight + `--no-verify` rule; this
chip runs no local full suite (the `full-suite.yml` Actions run is the full run).

## 4. Residuals (documented, not fixed here)

- **Renderer or inventory drift.** If `renderOutbound` or a consumer's `ownedSourceTails` changed since the sync that wrote the
  stale bytes, usually no current render reproduces them and the file is refused as today (fail closed; operator remedy
  unchanged: adopt upstream or declare an override). Drift can also make a current render match bytes that were never deployed
  to this consumer; that is still upstream-derived content and replaced loudly (§2.2). Reconstructing the historical pipeline is
  out of scope.
- **Deliberate rollback** to an earlier upstream-derived version is replaced, loudly (§2.2), as under 2221 today.
- **History bound.** Only the last `perPathMax` (100) versions of a source path are considered; older snapshots are refused.
- **Co-owned JSON surfaces** match only a pure upstream render (§2.4).
- **Base-lag restore residual** (`p-20261118060147-1077`, snapshot-to-restore race) is independent of this change: the resolver
  reads only the source repo.

## 5. Acceptance

- Tests 2, 3a and 4 red on `e93ccd78`, green after; 1 and 3 green; the re-inserted-skip negative control reproduced.
- Existing prior-upstream, outbound, d-hardening and stale-snapshot suites green unchanged.
- `/audit-code` converged with the final-review gate.
- No consumer repo is written. Storyline is re-synced by the coordinator after merge, with Louis's ok.

## Audit trail

- `/audit-plan` SID `audit-plan-1795000694442-77076`, 2026-11-18.
- R1 GPT: SIGNIFICANT_GAPS H:3 M:2. H1 (ownership needs deployment provenance) rebutted, GPT deliberation OVERRULED it (the
  2221 contract is content equality; wording of drift and the rollback limitation fixed). H2 (raw hashes on a rewritten
  destination: `acceptRaw`), H3 (byte caps on retained bodies), M1 (orphan e2e through the real resolver, isolation, partial
  failure, exhaustion), M2 (deterministic mechanism test; storyline e2e pinned and controlled) accepted. Acceptance 80%.
- R2 GPT: NEEDS_REVISION H:1 M:2. H1 (cat-file batch read unbounded) rebutted, GPT OVERRULED it (already bounded by `maxBuffer`
  with a null, unchanged here; the bound is now documented). M1 (binary blob null vs false) accepted. M2 (history-dependent
  e2e) rebutted, GPT COMPROMISE: mandatory e2e uses the most recent older rewritten version; the exact f3b37321 bytes are a
  labelled diagnostic. Acceptance 67%.
- R3 GPT: NEEDS_REVISION H:1 (a retained `subarray` pins the batch allocation) accepted and folded (copy + admit-before-add +
  test). Acceptance 100%. Structural-or-stop card at the 3-round cap: 0 structural, 1 local (the resource-bound cluster, now
  fixed), 2 unclassifiable (both resolved in R2). Call: **STOP**: no finding deferred, nothing left open; no round 4. No GPT
  round came back clean (H 3 -> 1 -> 1, each accepted or overruled in deliberation).
- Final gate round 1 (`--mode plan`, run `3800874b`): **APPROVE** (gemini-4-argon), gate `approve`, blocking 0, debt 0, wrongly
  dismissed 0. Converged; no further rounds.

## Code audit trail (`/audit-code --scope diff`, SID `audit-code-1795001812266-97592`)

- R1 H:3 M:7: raw acceptance decided per HISTORICAL blob (`render` returns `{content, hits}`; a raw copy of a blob the pipeline
  would rewrite is a divergence whatever the current file looks like), retained bodies use `allocUnsafeSlow`, render failures are
  counted and warned, and the mandatory e2e moved to a controlled source history. GPT deliberation OVERRULED M2 (retention policy)
  and M7 (one-line `stripAnsi`) and ruled a COMPROMISE on M3/M6 (taken). Acceptance 80%.
- R2 H:3 M:2: a raw match is NOT accepted when a render was requested but the blob could not be rendered (threw, binary, over a
  cap): fail closed. The mandatory e2e builds a fresh source repository from the tracked files plus a synthetic history (no
  shallow skip, no dependence on this repo's history). Acceptance 80%.
- R3 PASS L:1 (warning wording) fixed. R4 PASS H:0 M:0 L:0, stable 2/2.
- Final gate round 1: **APPROVE** (gemini-4-argon), blocking 0, debt 0.
- Negative controls (each seen red, then restored green): the parent sources `e93ccd78` (5 e2e/unit cases red); the skip re-inserted
  at the wiring site (storyline and mandatory e2e red); `Buffer.from` view retained (copy test red); per-blob hits check removed
  (unit + controlled e2e red); fail-closed raw rule reverted (2 unit cases red).
- Design deltas from the audited plan: `acceptRaw` is now a necessary, not sufficient, condition for raw acceptance (the blob's own
  render must succeed with zero hits); `render` may return `{content, hits}`; a controlled fresh-repo e2e is the mandatory
  regression and the f3b37321 case is a labelled diagnostic plus a supplementary flow.

# Plan: Harness Retro — promote recurring session failures into enforcement

- **Date**: 2026-11-16
- **Status**: In Progress
- **Author**: Claude + Louis
- **Scope**: backend (CLI + pure libs + one migration + one new skill — no UI)

> **Detected**: scope `backend`, stack `js-ts` (+ postgres). Principle set: engineering principles #1–#20.
> - **Target domain(s)**: `friction`, `scripts`, `shared-lib`, `skills-content`, `stores`, `supabase`
> - ⚠ **Cross-domain work** — a horizontal feature (scan → judge → record → enforce → measure), each step in its owning subsystem. No new domain: the core lives under `scripts/lib/friction/retro/`, which the `scripts/lib/friction/**` rule already tags `friction`.
> - ⚠ **MIGRATION** — this plan adds `supabase/migrations/20261116120000_harness_retro.sql` (three new tables, no change to existing ones). **It must be applied to EVERY store (NAS + storyline's Azure store) before CES `main` is fast-forwarded** — the 10-25 / 10-27 class. The tables are written only by the new CLI, so a store that is behind fails loudly on `--persist` (schema-fault, never an empty result) and nothing else in the toolchain touches them.

## 1. Context Summary

### Origin

The "self-improving harness" argument: agents repeat mistakes because the harness never updates
itself; add a post-session retro that **proposes** harness changes a human approves. Two rules —
*enforce before you instruct*, *load only when needed* — plus a commenter's: every change names the
failure it prevents and ships with a check proving it fires.

CES already has enforcement-over-instruction, the AGENTS.md size cap, gate contracts with positive
controls, and human-gated changes. **The gap**: lessons accumulate as prose memory tripwires
(`MEMORY.md`) instead of checks, and nothing mines past sessions for repeats or promotes a tripwire
into enforcement.

### What exists today (Code Trace, pinned to `88bf43ee`)

- **Friction-feedback loop** (`docs/plans/friction-feedback-loop.md`, Complete): `quality add|mirror|digest|link|session-review`
  dispatched by `scripts/cross-skill.mjs:224 (88bf43ee)` → implementations in
  `scripts/lib/friction/commands.mjs (88bf43ee)`: `frictionAdd` :258, `frictionMirror` :321 (tombstones
  absent names on a complete scan), `frictionLink` :416 (appends `{kind,ref}` to a `type: friction`
  memory file's `mitigation_refs`, then mirrors), `frictionSessionReview` :483 (breadcrumb-driven,
  lists recently *injected* notes — it does not read transcripts). Store seam
  `scripts/lib/store/friction.mjs:93 upsertFrictionRow`, `:136 reconcileTombstones`, `:155 appendMitigationRef`.
- **`memory_friction`** (`supabase/migrations/20260628120000_memory_friction.sql (88bf43ee)`):
  `mitigation_refs JSONB` :39, `resolved GENERATED … (jsonb_array_length(mitigation_refs) > 0)` :40,
  `UNIQUE (repo_id, memory_name)` :44 — a **mirror of `type: friction` memory files**; the file is the
  source of truth.
- **`friction_log`** (`supabase/migrations/20260509120000_friction_log.sql`): free-text `message`,
  `severity`, append-only, no fingerprint, no uniqueness.
- **Harness paths**: `scripts/lib/harness-paths.mjs:22 claudeConfigDir (88bf43ee)` honours
  `CLAUDE_CONFIG_DIR` (per-ACCOUNT config root); `:29 harnessProjectSlug`. Memory dir resolution:
  `scripts/lib/memory-paths.mjs:50 resolveHarnessMemoryDir`.
- **Egress redaction**: `scripts/lib/secret-patterns.mjs:230 redactSecrets` (the gentle redactor —
  NOT `sanitizer.mjs`), `preWriteSecretGate` in `scripts/lib/security/secret-classifier.mjs`.
- **Repo identity**: `scripts/lib/repo-identity.mjs:122 resolveRepoIdentity`.
- **Store-writer registry**: `scripts/lib/audit-store-writers.mjs (88bf43ee)` — every write-shaped
  export under `scripts/lib/store/**` must be registered or exempted with a reason
  (`tests/audit-store-durability-call-site.test.mjs`).
- **Skill roster count**: `tests/skill-census.test.mjs:65 'lists exactly 17 skills'` over
  `scripts/lib/store/skill-census.mjs` `ALL_SKILLS`; `AGENTS.md` §Project Overview ("17 AI-pair-programming
  skills") and §Skill Chain ("17 skills; 16 run in this order").
- **Skill size**: `skills/fleet/SKILL.md` is 13,102 chars — over the 12,000 ratchet, so it **may not grow**.
- **Nothing reads Claude Code transcripts today**: no module under `scripts/` parses
  `~/.claude/projects/<slug>/*.jsonl` (searched for `tool_result`/`is_error`: only
  `scripts/lib/anthropic-client.mjs`, which parses API responses). Architectural-memory neighbourhood
  returned `frictionDigest` / `frictionSessionReview` at band **`review`** (below the noise floor) —
  proceed greenfield in the friction domain, reusing its seams.

### Transcript format — measured, not assumed (2026-11-16, prototype in the scratchpad, not committed)

One prototype pass over `<configDir>/projects/*/*.jsonl` modified in the last 7 days:
**1,129 files, 1,911 MB, 1,128 sessions, 612 distinct fingerprints, 531 of them one-offs, 9.1 s wall.**
Record shapes relied on (all observed in `claude-desktop` entrypoint, CLI `version` 2.1.x):

| Signal | Record | Field |
|---|---|---|
| tool error | `type:"user"`, `message.content[].type:"tool_result"` | `is_error: true`; joined to the preceding `assistant` `tool_use` by `tool_use_id` |
| permission/classifier denial | same `user` record | `permissionDecision.decision:"reject"` + `source`/`reasonType`; `toolDenialKind` |
| hook error / cancel | `type:"attachment"` | `attachment.type` ∈ `hook_non_blocking_error`, `hook_cancelled`, `hook_blocking_error`; `hookName`, `stderr` |
| hook-rewrite retry | tool error text | "a hook changed this call's input" |
| human turn | `type:"user"` text | `origin.kind:"human"` (absent on tool results / meta) |
| session / repo | every record | `sessionId`, `cwd`, `gitBranch`, `timestamp` |
| subagents | `<sessionId>/subagents/agent-*.jsonl` | attributed to the parent session |

Worktree sessions live in their **own** slug dirs (`C--GIT-<repo>--claude-worktrees-<name>`), so
"this repo's transcripts" is NOT one slug dir — the session's repo is derived from its first `cwd`.

**Top recurring candidates the prototype already surfaced** (proof the detector earns its keep):
1. Hooks invoked by a **relative path** fail when the session cwd is not the repo root —
   `.claude/settings.json:58 (88bf43ee)` `.claude/hooks/arch-memory-check.sh` and `:78`
   `node .claude/hooks/bash-grep-nudge.mjs` (`:47` already uses `"$CLAUDE_PROJECT_DIR"`). Seen as
   `hook_non_blocking_error` in **487 sessions** (UserPromptSubmit) and 7+ (PreToolUse). Mostly
   `claude -p` sessions spawned in temp dirs by the `cli` backend — a real defect, not noise.
2. The Bash `grep`/`rg` nudge hook firing: **69 + 28 sessions / week** — enforcement working but
   costing a round trip each time (a "rewrite, don't block" judgment, not a new rule).
3. `archive_session` "a hook changed this call's input" (hook-rewrite) — 5 sessions, 85 occurrences.
4. Classifier denials by reason class (`[Git Destructive]`, `[Undermining Oversight]`, …).

These are **retro outputs** — this plan builds the instrument; fixing them is what its proposals are
for (see §8 Deferred).

## 2. Proposed Architecture

**Detect mechanically, judge with the LLM, enforce in the repo, measure with the store.**

```mermaid
sequenceDiagram
    participant Op as Operator or coordinator session
    participant CLI as scripts/harness-retro.mjs
    participant Rd as retro/transcripts.mjs and repo-resolve.mjs
    participant Sig as retro/signals.mjs and fingerprint.mjs
    participant Inv as retro/inventory.mjs and memory-tripwires.mjs
    participant Art as .audit/harness-retro scan and proposal artifacts
    participant Reg as .harness-retro/decisions.json
    participant DB as audit store
    Op->>CLI: scan --since 14d
    CLI->>Rd: enumerate and stream jsonl (local disk only)
    Rd->>Sig: records per file, attributed to a session
    Sig-->>CLI: per-session occurrence counts
    CLI->>Inv: rank candidates, check existing harness and tripwires
    CLI->>Reg: read decided fingerprints
    CLI->>Art: write scan artifact (versioned, derived only)
    CLI->>DB: --persist: one transactional snapshot per session plus the scan row
    Op->>Op: skill step - the session model judges the top-N candidates
    Op->>CLI: record --scan id --stdin (Zod-validated against the scan)
    CLI->>Art: write proposals artifact + markdown
    Note over Op: human approves one; the fix PR also runs enforce, adding the registry entry
    Op->>CLI: effect
    CLI->>Reg: activation = first-parent main commit that introduced the entry
    CLI->>DB: before vs after recurrence over covered windows
```

### Egress policy — what may leave the reader, per destination (H1)

| Destination | Fields | Free text? | Why safe |
|---|---|---|---|
| **Audit store** (private DB) | `fingerprint`, `fingerprint_version`, `kind`, `tool` (normalised), counts, timestamps, `session_key` (sha256 of the session id), `repo_uuid`, `origin`, account key (sha256 of the config dir) | **No** | No transcript text is persisted at all; a label is reproducible locally from the fingerprint. |
| **Committed registry** (`.harness-retro/decisions.json`, PUBLIC repo) | `fingerprint`, version, `kind`, `tool`, `layer`, `test`, `summary`, `decision`, `memory?` | Only `summary`, **human-written** in the fix PR and reviewed there | Never copied from a transcript; the registry test refuses an entry whose `summary` contains a path, an email or a secret shape. |
| **Local artifacts** (`.audit/harness-retro/*.json`, gitignored, this machine) | the above + `label` (normalised: no absolute paths, ids, emails, numbers; `redactSecrets`; refused to `[REDACTED:secret]` on a high-confidence shape; ≤160 chars) | Yes, bounded | Same disk as the transcripts it came from; never synced, never committed. |
| **The judging model** (the session running `/harness-retro`) | the local artifact's candidate list | Yes, bounded | The same provider and account that already received the original text in the original session — no new destination. Recorded here rather than claimed as "zero egress". |
| Anything else (third-party API, consumer repo, upstream report) | nothing | — | The scanner has no network code path. |

User text is never kept in any destination: `user_correction` carries only the kind and the preceding tool name.

### Components and decisions

1. **`retro/transcripts.mjs` — enumeration + streaming read (local only, H10).** Walks
   `<claudeConfigDir()>/projects/*/` for `*.jsonl` and `<slug>/<sessionId>/subagents/agent-*.jsonl`
   with mtime ≥ `since`; deduplicates by real path; streams line-by-line (`readline`) and never
   holds a file's records. Unparseable lines and read errors are **counted per file** and surface in
   the scan artifact. Never writes, copies or uploads (#11, #16).
2. **Session assembly — an incremental state machine (H10).** Sessions are **selected** by mtime (a
   session is in scope when ANY of its main/subagent files was modified at or after `since`) and then
   **assembled from ALL of their files**, whatever each file's own mtime — so a rescan where only the
   main file or only one subagent changed still reads the whole session (R3-H1). A snapshot is
   `complete` only when every constituent file was read without error; an incomplete snapshot is
   reported and **never persisted**, so it can never replace a complete one. One
   `createSessionExtractor()` per `sessionId`, fed files in this order: a session's main file, then its subagent files (sorted).
   Tool-use joins are **per file** (a subagent's `tool_use_id`s live in its own file), so the join
   map is cleared at each file boundary — bounded state. A `tool_result` whose `tool_use` is not in
   the same file is counted `unjoined` (classified with `tool: ''`, never dropped). Records with no
   `sessionId` are attributed to the file's stem. A session's identity across slug dirs is its
   `sessionId`, so the same session seen twice (a moved file) is one session.
3. **`retro/repo-resolve.mjs` — canonical repo identity (H4).** For each distinct first `cwd`
   (cached): if the directory exists, `git -C <cwd> rev-parse --path-format=absolute
   --git-common-dir` → main root = its parent (handles subdirectories AND linked worktrees of any
   path shape); else the path heuristic (`/.claude/worktrees/<name>`, `/.fleet-wt/<repo>/…` → main
   root) and, if THAT root exists, the git step on it. The root is then passed to
   `resolveRepoIdentity` (`scripts/lib/repo-identity.mjs:122`) → stable `repo_uuid` (uuidv5 of the
   canonical remote) + display name. No root, or no identity → `repo: unresolved`, counted and
   reported, never persisted and never guessed. "This repo" = the identity of the running checkout,
   compared by `repo_uuid` (two repos with one basename never collide).
4. **`retro/signals.mjs` — pure extractors, one per kind** (data-driven table, #4):
   `hook_rewrite`, `hook_block` (a hook refusing by design — enforcement that FIRED), `denial`
   (structured `permissionDecision.decision === 'reject'` / `toolDenialKind` first, text fallback),
   `refusal` (refusal phrase in any tool result — "must be owner", "is behind", "refused"),
   `tool_error`, `hook_error` (hook attachment failed/cancelled), `retry` (same tool + same input
   re-issued after that call errored, chain ended by a success), `user_correction` (human-origin
   turn opening with a correction phrase; kind + preceding tool only). Each result is classified
   ONCE, most specific first. Patterns are frozen data in `retro/patterns.mjs`.
5. **`retro/fingerprint.mjs` — versioned normalise-then-hash (M1).** `FINGERPRINT_VERSION = 1`.
   Normalisation: URLs, emails, MCP server uuids, uuids, `toolu_`/`local_`/`req_`/`agent-` ids,
   absolute Windows/POSIX/`~` paths, mixed hex shas, numbers, whitespace. Meaningful line = the
   first informative line (error/denied/refused/not found/cannot/…) in the first 20, else the first
   non-noise line. Fingerprint = `sha256(version|kind|tool|line)` hex-16. A version bump changes
   every fingerprint: registry entries and occurrences carry `fingerprint_version`, and an effect
   comparison across versions is `unmeasured: fingerprint-version-changed` (re-baseline, never
   remap). Collision fixtures pin that distinct failures stay distinct and equivalence fixtures
   that path/sha/count variants merge.
6. **`retro/aggregate.mjs` — recurrence ranking (M2).** Per fingerprint: occurrences, distinct
   sessions, distinct repos, distinct days, first/last seen, origin split. Strength: `strong` ≥ 3
   sessions, `weak` = 2, `one-off` = 1 (counted in totals, never ranked). Kind weight: `tool_error`,
   `refusal`, `denial`, `hook_error`, `hook_rewrite` = 1.0; `retry` = 0.8; `hook_block` = 0.5;
   `user_correction` = 0.3. `rank = sessions × weight × (1 + 0.5 × (repos − 1))`. Tie-break:
   sessions desc, then fingerprint asc (deterministic). `previouslyRejected` and `enforced`
   fingerprints are listed separately, never in the top-N.
7. **`retro/inventory.mjs` — check what exists before proposing (M2).** Token index (lower-case,
   `[a-z0-9_-]{4,}`, a fixed stop list) over: `MEMORY.md` lines + each linked memory file's
   `description`, `AGENTS.md`, `.claude/hooks/*` source, `package.json` scripts named `*:gate`,
   `skills/*/SKILL.md`. Score = Σ idf(t) over shared tokens / Σ idf(t) over the label's tokens
   (weighted containment — the label is the short side); `coveredBy` lists surfaces with score ≥
   **0.35**, best 3. A **hint for the judge**, never a suppressor.
8. **`retro/memory-tripwires.mjs` — memory → enforcement promotion.** Parses every
   `[Title](file.md)` link in `MEMORY.md` (lines carry several), reads each file's frontmatter
   (`name`, `description`, optional `metadata.enforced_by`), scores it against every fingerprint
   label with the same containment score (≥ 0.35). Output per tripwire: `firedSessions`,
   `matchedFingerprints`, `enforced`. `firedSessions ≥ 2` and not enforced → **promotion
   candidate**; zero matches → `no-evidence`, never "dead".
9. **Local artifacts (H8)** under `.audit/harness-retro/` (gitignored):
   - `scan-<scanId>.json` — `ScanArtifactSchema` v1: `{schemaVersion, scanId, fingerprintVersion,
     accountKey, requested:{since, until}, files:{listed, read, readErrors, unparseableLines},
     measured, reason?, sessions:[{sessionKey, repoUuid|null, origin, startedAt, counts:{fp:n}}],
     fingerprints:{fp:{kind, tool, label}}, candidates[], tripwires[], persisted, persistReason?}`.
   - `proposals-<scanId>.json` + `.md` — written by `record`.
   - `heartbeat.json` — `{lastRunAt, scanId, measured}`.
   `scanId` = UTC timestamp + 6 random hex. Scan artifacts older than 60 days are pruned by `scan`.
10. **The LLM step = the session's own model, driven by the skill.** The skill reads the latest
    scan artifact's top-N candidates and promotion candidates, judges each, and pipes proposals to
    `record --scan <scanId> --stdin`. `record` validates against `ProposalSchema` (Zod `.strict()`)
    **and against the scan**. A proposal targets exactly one **identity**: `fingerprint:<fp>` (must be
    a ranked candidate of that scan) or `tripwire:<memory name>` (must be a promotion candidate of that
    scan — this is how a tripwire whose evidence is several one-off fingerprints is recorded). The
    claimed `failurePrevented.sessions/occurrences` must equal the scan's counts for that identity
    (for a tripwire: distinct sessions / summed occurrences over its matched fingerprints) — refused
    on mismatch, so the model cannot inflate evidence. No API call: no new provider seam, no spend (right-sizing).
11. **`ProposalSchema` — the three-things contract** (`retro/proposal-schema.mjs`): for
    `verdict: 'propose'`: `{identity, verdict, failurePrevented:{summary, sessions, occurrences},
    layer: 'hook'|'gate'|'script'|'reference-doc'|'agents-md', change:{files[≥1], description},
    positiveControl:{test, assertion}, coordinatorChore: boolean, ladderJustification?}`;
    `layer: 'agents-md'` requires `ladderJustification` (why every lower layer cannot enforce it).
    Other verdicts (`already-covered`, `judgment-only`, `not-actionable`) require only
    `{identity, verdict, reason}` (+ `coveredBy` ref for `already-covered`). The SKILL.md field
    list is pinned to `z.toJSONSchema(ProposalSchema)` keys by a test (prose↔code seam).
12. **`.harness-retro/decisions.json` — committed decision registry (H6, H9).**
    `{version:1, decisions:[{identity, evidenceFingerprints[≥1], fingerprintVersion, kind, tool,
    decision:'enforced'|'rejected', layer?, test?, summary, memory?, decidedAt}]}` — **no commit sha in
    the entry**. `identity` is `fingerprint:<fp>` (evidence = `[fp]`) or `tripwire:<memory name>`
    (evidence = every fingerprint the scan matched to that tripwire, one-offs included). Ranking
    suppresses EVERY evidence fingerprint of a decided identity; the effect metric counts a session
    as a hit when ANY evidence fingerprint occurs in it; a `fingerprintVersion` mismatch makes the
    whole identity `unmeasured` (R3-M1).
    - **Workflow**: the human approves a proposal → the fix is built on its own branch → in that same
      branch `harness-retro.mjs enforce …` appends the entry (and retires the tripwire locally) →
      the PR carries fix + test + entry, reviewed together.
    - **Activation** (derived, never stored) — a commit date is when a commit was CREATED, not when
      it landed, so it is accepted only from a landing-time source. First find the **first-parent
      commit on `origin/main`** that introduced the entry's `identity` string into the registry
      (`git log --first-parent --reverse --format=%H%x09%cI%x09%ce -S<identity> origin/main --
      .harness-retro/decisions.json`, first line). Then, in order: (a) its committer is GitHub itself
      (`noreply@github.com` — GitHub creates squash and merge commits AT merge time, and this repo
      squash-merges) → its committer date, provenance `github-merge-commit`; (b) else the `merged_at`
      of the merged PR associated with that commit (`gh api repos/<owner>/<repo>/commits/<sha>/pulls`),
      provenance `pr-merged-at`; (c) else `activation-unknown`. Not on `origin/main` yet →
      `pending-merge`; shallow history or no `gh` → `activation-unknown`. `effect` prints the
      provenance with every verdict.
    - **Registry test** (`tests/harness-retro-registry.test.mjs`, in `npm test`): validates the
      committed file with `RegistrySchema`; each `enforced` entry's `test` exists under `tests/`,
      matches the runner's collection glob, and contains the entry's `identity` string (the fp id, or `tripwire:<name>`); `summary` passes the
      no-path/no-email/no-secret check. **Scope note**: proving the control *fails without the
      enforcement* (a mutation run) is deliberately not automated — it would need per-fix revert
      machinery; the positive-control assertion is part of the reviewed PR, and the effect metric is
      the after-the-fact proof.
    - `reject --identity <id> --scan <id|latest> --summary` appends `decision:'rejected'`; a rejected identity is
      shown `previouslyRejected` and never re-ranked into the top-N.
13. **`enforce` — idempotent, ordered closure (H7).** Locks, always in this order: the
    **registry's own lock** (`withFileLock` on `.harness-retro/decisions.json.lock` — every registry
    mutation, `enforce` and `reject` alike, from any account, takes it), then, when `--memory` is
    given, `<memoryDir>/.harness-retro.lock`. The registry is rewritten with `atomicWriteFileSync`.
    After a **preflight** that validates every input (test path,
    fingerprint in the latest scan or `--force-unscanned`, memory file exists, frontmatter parses)
    and writes nothing on failure: (1) registry append — no-op if the fingerprint is already
    `enforced`; (2) memory frontmatter `metadata.enforced_by: {fingerprint, test, date}` — no-op if
    present; (3) the index: `MEMORY.md` lines are parsed into individual `[Title](file.md)` links;
    a line whose ONLY link is this memory is moved verbatim to `index-enforced.md` (created on first
    use, linked once from `MEMORY.md`); a line that also links other memories is **never edited** —
    the entry is still appended to `index-enforced.md` and `status` reports `needs-manual-reflow`
    for it (rewriting a shared prose line mechanically would garble the other tripwires). Each step
    is a no-op if already done; (4) for a
    `type: friction` memory, `frictionLink(kind:'test', ref: <test path>)` — already idempotent, so
    `memory_friction.resolved` flips through the existing seam. Every step is idempotent, so a run
    that died mid-way is completed by re-running it; `status` reports an **incomplete retirement**
    (frontmatter says enforced but `MEMORY.md` still lists it, or the reverse). No rollback journal:
    nothing here needs undoing, only finishing.
14. **Store — three derived tables, one transactional writer (H2, H3, H5).** See §7 for DDL.
    - `harness_retro_scans` — one row per `scan --persist`: `scan_id`, `account_key`, `repo_uuid`,
      `requested_since`, `requested_until`, `files_listed/read`, `read_errors`, `completed`
      (true only when every listed file was read without error), `fingerprint_version`.
    - `harness_retro_sessions` — denominator; `harness_retro_occurrences` — numerator per
      `(session_key, fingerprint)`.
    - **One writer, one transaction per session**: `retro.sessionSnapshot` (registered in
      `scripts/lib/audit-store-writers.mjs` via `durableWrite`, `rowKey: session_key`, backed by the
      sessions PK). Its replay = `withTx`: `INSERT … ON CONFLICT (session_key) DO UPDATE SET … WHERE
      harness_retro_sessions.observed_until <= EXCLUDED.observed_until RETURNING session_key`; only
      when a row comes back does it `DELETE` the session's occurrences and insert the current set.
      `observed_until` is the scan's `requested.until`, so a delayed replay of an OLDER spilled
      snapshot, or the loser of two concurrent scans, cannot overwrite a newer one (the conflicting
      row is locked by the upsert for the rest of the transaction). A superseded snapshot is a
      **successful idempotent outcome** — receipt `{applied: true, rows: 0, reason: 'superseded'}` —
      not a decline: the durable-writer receipt contract keeps its decline set unchanged (R3-H2),
      and `cloud-off` is the only decline this writer returns. Replace-semantics make it idempotent AND reconcile removed or reclassified
      occurrences; a denominator can never land without its numerator.
    - **Schema faults are failures, never declines**: a `42P01`/`42703` (store not migrated) is
      rethrown as the ORIGINAL error, so `durableWrite` spills it (a drain after migrating recovers
      it) and `scan --persist` exits non-zero with `describeSchemaFault`'s diagnostic naming
      `20261116120000_harness_retro.sql`. Only `cloud-off` is a decline.
    - **Scan completion protocol (R3-H3)**: the scan row is ALWAYS written, last, by
      `retro.scanComplete`, with `completed = (every listed file read cleanly) AND (every persisted
      session snapshot returned written or superseded)` — the CLI holds the per-session outcomes in
      memory for that one run. A `spilled` or `lost` snapshot makes that scan `completed: false`:
      its range is not coverage evidence. A later drain of the spill does **not** upgrade the scan
      row — by design: the next complete scan of the range restores coverage. Coverage can therefore
      only be under-claimed (→ `unmeasured`), never over-claimed. A failed write
      spills through the existing seam and is drained by the existing `write-spill drain`, so
      recovery does not depend on the transcript still existing. The scan row is written by the
      second registered writer `retro.scanComplete` (`rowKey: scan_id`) per the completion
      protocol above.
    - Only sessions whose `repo_uuid` equals the running repo's are persisted; others are
      `persisted:false, reason:'other-repo'` (consumers are not on one store). Cloud off →
      `persisted:false, reason:'cloud-off'`, everything else still runs (#16).

### Why the existing friction tables are NOT the persistence layer (evaluated, not dismissed)

- `memory_friction` mirrors `type: friction` memory files keyed `UNIQUE (repo_id, memory_name)`;
  `frictionMirror` (`commands.mjs:321`) tombstones every row whose memory file is absent on a complete
  scan — a retro fingerprint has no memory file, so the next `quality mirror` would deactivate it.
  It also holds no per-occurrence timestamps, so the effect metric cannot be computed from it.
- `friction_log` is free-text, append-only and unkeyed — a rescan would double-count and there is no
  uniqueness constraint to make a replay idempotent.
- **Reused instead**: `frictionLink` (tripwire closure for friction-typed memories),
  `resolveHarnessMemoryDir`, `claudeConfigDir`, `redactSecrets` / `preWriteSecretGate`,
  `withFileLock` / `atomicWriteFileSync`, `resolveRepoIdentity`, `durableWrite` + `withTx`,
  `isCloudEnabled`.

### Telemetry — the effect metric, computable (H3, H9)

For an `enforced` registry entry with fingerprint `f` (version `v`), activation `t` (component 12),
window `W` (default 14 d), repo `R` = the running repo:

```
A  = accounts with completed scans of R whose requested ranges, unioned, cover [t − W, t + W)
P  = sessions of R, of an account in A, with fingerprint_version = v
before = { s ∈ P : started_at ∈ [t − W, t) }      after = { s ∈ P : started_at ∈ [t, t + W) }
hitsB = |{ s ∈ before : occurrences(s, f) ≥ 1 }|  rateB = hitsB / |before|
hitsA = |{ s ∈ after  : occurrences(s, f) ≥ 1 }|  rateA = hitsA / |after|
verdict:
  pending-merge  activation not on origin/main yet
  pending        now < t + W
  unmeasured     activation-unknown | fingerprint-version-changed | A empty (no-covered-account)
                 | |before| < 10 or |after| < 10 (reason names the short window)
  reduced        hitsB ≥ 3 and rateA ≤ 0.5 × rateB
  regressed      rateA > rateB and hitsA ≥ 3
  unchanged      otherwise
```

Coverage is evidence of reading, not of session existence: a session started in `[since, until]`
of a completed scan was necessarily modified at or after `since`, so the scan listed it if it still
existed. Restricting `P` to accounts in `A` keeps the population the same on both sides of `t`
(AGENTS.md: a figure compared over time is a trend only if the population is stable). Output
carries `window`, `accounts`, counts, both rates and the thresholds. Source: the store when cloud is
on; otherwise the union of local scan artifacts (`source:'local-scan'`), same function, same rules.

### Cadence

- **Skill**: `/harness-retro`, at the end of a coordinator (or any) session.
  `skills/fleet/references/ending-a-session.md` gains one step pointing at it — the fleet SKILL.md
  cannot grow (over the size ratchet).
- **Periodic**: `scan --persist` is the scan-only mode a periodic runner would call; it writes
  `heartbeat.json`, and `status` reports a heartbeat older than 8 days loudly. Registering it with
  the local weekly maintenance runner is **deferred** (§8) — no silent cron is added here.

### Right-sizing gate

- **Band-aid extreme**: a grep script printing top error strings — no fingerprint identity, no
  "already exists" check, no closure, no effect; lessons stay prose.
- **Over-engineered extreme**: an always-on daemon tailing transcripts, an LLM API judge with its own
  provider seam, embedding clusters, a proposals workflow table, auto-PRs, mutation-testing every fix.
- **Chosen**: a deterministic batch scanner + the session's own model as judge + a committed decision
  registry + three derived tables. Each piece serves a stated requirement: cross-session recurrence
  (fingerprint + aggregate), no duplication (inventory), propose-never-apply (registry is appended in
  a human-approved PR), "names the failure and ships a check" (Zod contract + registry test), the
  before/after metric (scans for coverage, sessions for the denominator, occurrences for the
  numerator; transcripts expire, so the store is what keeps the before-window; `CLAUDE_CONFIG_DIR`
  is per-account, so one store aggregates accounts).

**Manual vs scripted**: scripted — the only manual steps are the judgment and the human approval.

## 6. Sustainability Notes

- **Transcript format** is undocumented and versioned by Claude Code. The reader keys on the small
  field set in §1, records the `version`s it saw, and the scan is **UNMEASURED**
  (`reason:'format-unrecognised'`) when it read lines but assembled zero sessions with a
  `user`/`assistant` record — the instrument checks itself. `reason:'no-transcripts'` when the
  projects dir is absent or empty in the window; `reason:'read-errors'` when every file failed.
- **Phrasing** of corrections and refusals is data (`retro/patterns.mjs`) — extend without touching
  extractors (#4). A new kind = one extractor entry + a weight; a new inventory surface = one list
  entry; a new layer = one enum value.
- **Fingerprint evolution** is explicit (`FINGERPRINT_VERSION`, component 5).
- **Fleet scope**: `--fleet` reports every resolved repo; persistence stays repo-local, so a consumer
  moving store needs no change here.

## 7. File-Level Plan

**New library (all under `scripts/lib/friction/retro/`, domain `friction`)**

- `scripts/lib/friction/retro/patterns.mjs` (create) — frozen pattern data.
- `scripts/lib/friction/retro/fingerprint.mjs` (create) — `FINGERPRINT_VERSION`, `meaningfulLine`,
  `normaliseSignalText`, `safeLabel`, `fingerprintOf`.
- `scripts/lib/friction/retro/transcripts.mjs` (create) — `listTranscriptFiles`, `streamTranscript`,
  `isHumanTurn`.
- `scripts/lib/friction/retro/repo-resolve.mjs` (create) — `createRepoResolver({runGit, resolveIdentity})`
  → `resolve(cwd)` → `{repoUuid, name, root} | null` (cached; injectable for tests).
- `scripts/lib/friction/retro/signals.mjs` (create) — `SIGNAL_KINDS`, `classifyToolResult`,
  `isCorrection`, `createSessionExtractor()` (`push`/`endFile`/`finish`).
- `scripts/lib/friction/retro/scan.mjs` (create) — `runScan({configDir, sinceMs, untilMs, resolver})`:
  orchestrates enumeration → per-session extraction → repo resolution → result (no persistence).
- `scripts/lib/friction/retro/aggregate.mjs` (create) — `KIND_WEIGHTS`, `aggregateSessions`, `rankCandidates`.
- `scripts/lib/friction/retro/inventory.mjs` (create) — `tokenise`, `buildIdf`, `containmentScore`,
  `chunkText`, `collectHarnessDocs` (→ `{docs, errors}`), `buildHarnessInventory` (→ `{coverageFor, idf}`) (`COVERAGE_FLOOR = 0.35`).
- `scripts/lib/friction/retro/memory-tripwires.mjs` (create) — `parseMemoryIndex`, `scanTripwires`,
  `markEnforced`, `retireFromIndex` (+ pure `retireFromIndexText`), `retirementStatus`.
- `scripts/lib/friction/retro/registry.mjs` (create) — `RegistrySchema`, `readRegistry`,
  `appendDecision`, `validateRegistry({entries, repoRoot})`, `activationFor(identity, {runGit})`.
- `scripts/lib/friction/retro/proposal-schema.mjs` (create) — `ProposalSchema`,
  `ProposalsEnvelopeSchema`, `checkProposalsAgainstScan(envelope, scan)`.
- `scripts/lib/friction/retro/artifacts.mjs` (create) — `ScanArtifactSchema`, `newScanId`,
  `writeScanArtifact`, `readScanArtifact(id|'latest')`, `listScanIds`, `readAllScanArtifacts`, `pruneScanArtifacts`,
  `writeHeartbeat`, `readHeartbeat`.
- `scripts/lib/friction/retro/effect.mjs` (create) — `coveredAccounts`, `computeEffect`.
- `scripts/lib/friction/retro/closure.mjs` (create) — `preflightDecision`, `closeDecision` (enforce and
  reject; the ordered idempotent closure, component 13).
- `scripts/lib/friction/retro/report.mjs` (create) — `renderScanReport`, `renderProposals` (markdown).

**Store + migration**

- `supabase/migrations/20261116120000_harness_retro.sql` (create) —
  - `harness_retro_scans (scan_id text PRIMARY KEY, account_key text NOT NULL, repo_uuid uuid NOT NULL,
    fingerprint_version int NOT NULL, requested_since timestamptz NOT NULL, requested_until timestamptz
    NOT NULL, files_listed int NOT NULL, files_read int NOT NULL, read_errors int NOT NULL,
    completed boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), CHECK (requested_since <
    requested_until))`
  - `harness_retro_sessions (session_key text PRIMARY KEY, repo_uuid uuid NOT NULL, account_key text NOT
    NULL, origin text NOT NULL CHECK (origin IN ('interactive','automated')), started_at timestamptz NOT
    NULL, fingerprint_version int NOT NULL, signal_count int NOT NULL, last_scan_id text NOT NULL,
    observed_until timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`
  - `harness_retro_occurrences (session_key text NOT NULL REFERENCES harness_retro_sessions(session_key)
    ON DELETE CASCADE, fingerprint text NOT NULL, kind text NOT NULL, tool text NOT NULL DEFAULT '',
    occurrences int NOT NULL CHECK (occurrences > 0), first_at timestamptz, last_at timestamptz,
    PRIMARY KEY (session_key, fingerprint))`
  - indexes `(repo_uuid, started_at)` on sessions, `(fingerprint)` on occurrences, `(repo_uuid,
    account_key, completed)` on scans; RLS enabled, no anon policy (mirrors `memory_friction`).
  - `repo_uuid` carries no FK to `audit_repos` deliberately: a session from a repo with no
    `audit_repos` row in THIS store must still count; the identity is the stable uuidv5, not a row.
  - No label / no free-text column (egress table).
- `scripts/lib/store/harness-retro.mjs` (create) — `writeSessionSnapshot(snapshot)` (one `withTx`:
  upsert session, delete + insert occurrences; returns a receipt `{applied, rows, reason?, error?}`),
  `writeScanRow(row)`, `readRetroWindow({repoUuid, fromTs, toTs, fingerprintVersion})`,
  `readCompletedScans({repoUuid})`. Zod `.strict()` row schemas at the boundary. Graceful cloud-off
  (`reason:'cloud-off'`, the only decline); a superseded snapshot is `applied:true, reason:'superseded'`; schema faults rethrow.
- `scripts/lib/audit-store-writers.mjs` (modify) — register `retro.sessionSnapshot`
  (`rowKey: p => p.session_key`) and `retro.scanComplete` (`rowKey: p => p.scan_id`) through the
  existing `receipt()` translation; update the keyed-writers docstring list.
- `scripts/db-test-container.mjs` + `.github/workflows/postgres-parity.yml` (modify) — enrol
  `tests/harness-retro-store.db.test.mjs` in lockstep.
- Schema fixture regenerated via `npm run db:local:regen` if the parity/coupling checks require it.

**CLI**

- `scripts/harness-retro.mjs` (create) — verbs `scan [--since 14d] [--fleet] [--persist] [--top N]`,
  `record --scan <id|latest> --stdin`, `enforce --identity <fingerprint:fp|tripwire:name> --scan <id|latest> --test p --layer l
  --summary s [--memory name] [--force-unscanned]` (evidenceFingerprints, kind and tool are resolved
  from the named scan: `[fp]` for a fingerprint, the tripwire's matched set for a tripwire; a
  `tripwire:` identity implies `--memory <name>`), `reject --identity … --scan … --summary s`,
  `effect [--identity i]
  [--window-days N]`, `status`. CLI contract: `isInvokedAsScript`, `--selfcheck-relocation`,
  `assertKnownFlags`, `emit` + `finishAndExit`, progress on stderr, stdin bodies. Every envelope
  carries `measured` and, when false, a `reason`.
- `package.json` (modify) — `"harness:retro": "node scripts/harness-retro.mjs"`.
- `scripts/lib/sync-entry-lists.mjs` (modify) — add the CLI to `CORE_ENTRY` (the synced SKILL.md names it).
- `scripts/lib/sync-isolation-verify.mjs` (modify) — add to `CLI_SMOKE_SET` (after the CORE_ENTRY declaration).
- `scripts/lib/bundle-deps.json` (regenerate via `npm run bundle:deps`).

**Skill**

- `skills/harness-retro/SKILL.md` (create, < 12,000 chars) — scan → judge the candidates per the
  ladder → `record` → present proposals → on human approval the fix is its own PR, whose branch runs
  `enforce` → `effect` later. Names synced tooling by path (`node scripts/harness-retro.mjs`).
- `skills/harness-retro/references/judging-candidates.md` (create) — the ladder, the three-things
  contract with a worked example, coordinator-chore heuristics, `already-covered`, the egress table.
- `skills/harness-retro/references/effect-and-closure.md` (create) — `enforce`/`reject`, activation,
  retirement, reading the effect verdicts.
- `skills/fleet/references/ending-a-session.md` (modify) — one step: run `/harness-retro` before
  archiving a coordinator.
- `scripts/lib/store/skill-census.mjs` + `tests/skill-census.test.mjs` (modify) — roster 17 → 18.
- `AGENTS.md` (modify) — the two skill-count sentences only (check `statedIn` quotes first).
- `docs/reference/skill-roster.md` (modify) — one roster row.
- `.claude/skills/harness-retro/**` — generated by `npm run skills:regenerate`.
- `.harness-retro/decisions.json` (create) — `{"version":1,"decisions":[]}`.

**Tests** (all under `tests/`)

- `tests/harness-retro-signals.test.mjs` — every kind, both directions (success, meta user turn,
  `hook_success` must NOT fire); per-file join reset; unjoined counted; subagent attribution.
- `tests/harness-retro-fingerprint.test.mjs` — equivalence (path/sha/count variants → one fp),
  collision (distinct failures stay distinct), version folded in, label redaction of a planted token.
- `tests/harness-retro-repo-resolve.test.mjs` — subdirectory, linked worktree, deleted worktree
  fallback, same-basename repos, unresolvable → null.
- `tests/harness-retro-aggregate.test.mjs`, `tests/harness-retro-inventory.test.mjs`,
  `tests/harness-retro-tripwires.test.mjs`, `tests/harness-retro-effect.test.mjs` (every verdict
  branch incl. coverage gaps and account restriction), `tests/harness-retro-registry.test.mjs`
  (validates the COMMITTED registry; red-then-green controls for missing test, test lacking the
  fingerprint, unsafe summary), `tests/harness-retro-proposal-schema.test.mjs` (three-things
  refusal, inflated counts refused, a tripwire proposal over two one-off fingerprints accepted
  end-to-end, SKILL.md ↔ `z.toJSONSchema` parity),
  `tests/harness-retro-closure.test.mjs` (idempotent re-run after a failure at each step boundary,
  preflight writes nothing on bad input, incomplete-retirement status, a multi-link `MEMORY.md` line
  left intact with `needs-manual-reflow`, two `enforce`/`reject` processes with DIFFERENT config dirs
  serialised by the registry lock).
- `tests/harness-retro-cli.test.mjs` — cross-process end-to-end over a temp `CLAUDE_CONFIG_DIR`:
  UNMEASURED on empty and on format drift; `scan` → artifact → `record` from a SECOND process;
  cloud-off persists nothing; other-repo not persisted; egress: a planted secret and a planted user
  sentence never appear in any artifact or store payload.
- `tests/harness-retro-store.db.test.mjs` (DB-gated) — snapshot replace-semantics (rescan removes a
  vanished occurrence), transaction atomicity (a failing insert leaves no session row), a delayed
  OLDER snapshot returns `{applied: true, rows: 0, reason: 'superseded'}` and changes nothing, two concurrent snapshots end with the newer one, scan
  row `completed`, window read; plus an unmigrated-store case (42P01 rethrown, not declined).

### 7b. Implementation Phases

**Phase 1 — Reader, signals, fingerprint, repo identity**: streaming enumeration, the per-session
state machine, normalisation + fingerprinting, canonical repo resolution, the scan orchestrator.
Files: `scripts/lib/friction/retro/patterns.mjs` (create), `scripts/lib/friction/retro/fingerprint.mjs`
(create), `scripts/lib/friction/retro/transcripts.mjs` (create), `scripts/lib/friction/retro/repo-resolve.mjs`
(create), `scripts/lib/friction/retro/signals.mjs` (create), `scripts/lib/friction/retro/scan.mjs`
(create), `tests/harness-retro-signals.test.mjs` (create), `tests/harness-retro-fingerprint.test.mjs`
(create), `tests/harness-retro-repo-resolve.test.mjs` (create).

**Phase 2 — Ranking, inventory, tripwires, registry, proposals, artifacts, effect, closure**:
everything pure or local-file that turns a scan into ranked, inventory-checked candidates, validated
proposals and recorded decisions. Files: `scripts/lib/friction/retro/aggregate.mjs` (create),
`scripts/lib/friction/retro/inventory.mjs` (create), `scripts/lib/friction/retro/memory-tripwires.mjs`
(create), `scripts/lib/friction/retro/registry.mjs` (create), `scripts/lib/friction/retro/proposal-schema.mjs`
(create), `scripts/lib/friction/retro/artifacts.mjs` (create), `scripts/lib/friction/retro/effect.mjs`
(create), `scripts/lib/friction/retro/closure.mjs` (create), `scripts/lib/friction/retro/report.mjs`
(create), `.harness-retro/decisions.json` (create), `tests/harness-retro-aggregate.test.mjs` (create),
`tests/harness-retro-inventory.test.mjs` (create), `tests/harness-retro-tripwires.test.mjs` (create),
`tests/harness-retro-registry.test.mjs` (create), `tests/harness-retro-proposal-schema.test.mjs`
(create), `tests/harness-retro-effect.test.mjs` (create), `tests/harness-retro-closure.test.mjs` (create).

**Phase 3 — Store**: migration, store module, durable writer registration, DB suite enrolment.
Files: `supabase/migrations/20261116120000_harness_retro.sql` (create),
`scripts/lib/store/harness-retro.mjs` (create), `scripts/lib/audit-store-writers.mjs` (modify),
`scripts/db-test-container.mjs` (modify), `.github/workflows/postgres-parity.yml` (modify),
`tests/harness-retro-store.db.test.mjs` (create).

**Phase 4 — CLI**: verbs, envelopes, artifacts, heartbeat, persistence through `durableWrite`,
effect from store or local artifacts, sync declaration. Files: `scripts/harness-retro.mjs` (create),
`package.json` (modify), `scripts/lib/sync-entry-lists.mjs` (modify),
`scripts/lib/sync-isolation-verify.mjs` (modify), `tests/harness-retro-cli.test.mjs` (create).

**Phase 5 — Skill + roster**: the skill and its references, fleet pointer, roster/count updates.
Files: `skills/harness-retro/SKILL.md` (create), `skills/harness-retro/references/judging-candidates.md`
(create), `skills/harness-retro/references/effect-and-closure.md` (create),
`skills/fleet/references/ending-a-session.md` (modify), `scripts/lib/store/skill-census.mjs` (modify),
`tests/skill-census.test.mjs` (modify), `AGENTS.md` (modify), `docs/reference/skill-roster.md` (modify).

**Close-out (not a phase)**: `npm run skills:regenerate`, `npm run bundle:deps`,
`npm run db:local:regen` (if required), `npm run check`, `npm test`, `npm run db:local` for the
DB suite, a real `node scripts/harness-retro.mjs scan --since 7d` on this machine (pre-ship
empirical verify), `npm run plans:index`.

## 8. Risk & Trade-off Register

- **Lexical inventory/tripwire matching is weak** — a hint, never a suppressor; the judge reads the
  named surface. Upgrade path: embeddings via the arch-memory seam.
- **Transcript format drift** → UNMEASURED with a reason, not a silent zero (§6).
- **Volume** (1.9 GB/week): streaming + mtime prefilter, `--since` default 14 d; measured ~9 s/week.
- **Privacy**: §2 egress table. The residual risk is the local label (bounded, redacted, on the same
  disk as its source) and the judging model (same provider/account as the original session).
- **Correction detection is noisy** — weight 0.3, below every error kind.
- **Hook-block recurrence is enforcement firing** — weight 0.5; the judge decides "absorbed vs costing
  a round trip".
- **Positive control is reviewed, not mutation-tested** (component 12 scope note); the effect metric
  is the after-the-fact check that the enforcement changed behaviour.
- **Deferred (true scope boundaries, named)**:
  - Fixing what the instrument found (relative hook paths in `.claude/settings.json`, the grep-nudge
    round trip, the `archive_session` hook-rewrite) — the retro's first proposals, each its own PR
    after human approval ("propose, never apply"). Independence: none of them is on a code path the
    retro calls.
  - Registering `scan --persist` with the local weekly maintenance runner (the retro works without it;
    only the passive cadence is missing).
  - Scripting the coordinator chores the retro will flag (merge-on-green-at-head watcher, archive +
    worktree removal, refusing to fast-forward CES main while a store is behind) — each a separate
    proposal through this pipeline.

## 9. Testing Strategy

- **Unit (pure)**: every extractor, normaliser, resolver (git injected), aggregator, matcher, schema,
  effect branch and closure step — including the direction each must NOT fire.
- **Integration**: the CLI cross-process over a synthetic `CLAUDE_CONFIG_DIR` (two slug dirs incl. a
  worktree slug, a subagent file, a truncated last line).
- **DB**: `tests/harness-retro-store.db.test.mjs`, enrolled in both runners.
- **Tier-3 egress (same commit)**: the CLI test asserts the store payload keys are exactly the
  allowlist and that planted secret/user text never reaches any artifact or payload.

### Proof plan

| Behaviour | Oracle | Pass condition | Evidence |
|---|---|---|---|
| Detects recurring failures | fixture: one error in 3 sessions + a one-off | one `strong` candidate; the one-off counted, not ranked | aggregate test |
| Empty or unreadable scan is UNMEASURED | empty config dir; lines that assemble zero sessions | `measured:false` + named reason, never `candidates:[]` alone | CLI test |
| No write cloud-off / other-repo | stub store; two-repo fixture | zero store calls; `persisted:false` + reason | CLI test |
| Rescan reconciles | DB: snapshot, then snapshot without one fp | occurrence row gone, session row updated | store DB test |
| Three-things + evidence honesty | proposal missing `positiveControl`; inflated sessions | `record` refuses naming the field / the mismatch | schema test |
| Registry ties fix to failure | entry whose test lacks the fingerprint | refused; committed registry validates | registry test (red-then-green) |
| Closure is re-runnable | fail after step 2, re-run | end state identical to an uninterrupted run | closure test |
| Effect is honest | synthetic sessions per branch, coverage gap, version change | each verdict reached exactly; `unmeasured`/`pending` carry reasons | effect test |
| Works on the real corpus | `scan --since 7d` on this machine | `measured:true`; the relative-hook-path fingerprint in the top candidates | PR body |

## 11. Execution Clustering

- **Cluster A** — Phases 1–2 — fix-gate: yes
  - Coupling: the pure core — Phase 2 consumes Phase 1's session/occurrence shape and the
    fingerprint/label contract; auditing them together lets the wiring pass check that seam.
  - author-tier: standard
- **Cluster B** — Phases 3–4 — fix-gate: yes
  - Coupling: the CLI is the only caller of the store writers; persistence semantics (transactional
    snapshot, scan completion, repo-local, cloud-off) live on the seam between them.
  - Additional files: `tests/audit-store-durability-call-site.test.mjs` (modify — classify the new
    `superseded` receipt reason), `.audit-loop/domain-map.json` (modify — declare `scripts → friction`
    for the CLI entry point).
  - author-tier: standard
- **Cluster C** — Phase 5 — fix-gate: final
  - Coupling: the skill's field list and verbs are pinned to Cluster A's `ProposalSchema` and
    Cluster B's CLI.
  - Additional files: `skills/harness-retro/gate-contract.json` (create), `skills/harness-retro/references/worktree-preflight.md`
    (create — generated by `scripts/sync-shared-audit-refs.mjs`), `scripts/lib/gate-honesty/oracles.mjs` (modify —
    `retro-enforce-unscanned-refusal` scenario), `scripts/lib/gate-honesty/schema.mjs` (modify), `tests/gate-honesty.test.mjs`
    (modify — pinned census).
- **Final gate**: consolidated Gemini review over the union diff of Clusters A–C.

## Audit trail

- **R1** (GPT, SIGNIFICANT_GAPS, H:10 M:2): all 12 accepted and folded in — egress table (H1),
  transactional durable snapshot writer (H2, H5), scan-coverage table + account-restricted population
  (H3), git common-dir repo identity (H4), sha-free registry entry + first-parent activation (H6, H9),
  idempotent ordered closure (H7), versioned local artifacts + scan-checked `record` (H8), per-file
  state machine (H10), `FINGERPRINT_VERSION` (M1), specified weights/floor/tie-break (M2). Scoped down
  with reasons recorded inline: mutation-proof of every positive control (H6), a rollback journal (H7).
- **R2** (GPT, SIGNIFICANT_GAPS, H:4 M:2): all 6 accepted — schema faults rethrow and spill (H1),
  multi-link `MEMORY.md` lines never edited (H2), `observed_until`-guarded snapshot upsert (H3),
  activation only from a landing-time source with provenance (H4), `tripwire:` proposal identity
  (M1), registry-scoped lock + lock order (M2).
- **R3** (GPT, SIGNIFICANT_GAPS, H:3 M:1 — the cap): all 4 accepted — sessions selected by mtime but
  assembled from all files, incomplete snapshots never persisted (H1); superseded = applied, not a new
  decline (H2); scan-completion protocol that can only under-claim coverage (H3); `identity` +
  `evidenceFingerprints` registry entries (M1). Acceptance rate 22/22 across three rounds; each
  round's findings were narrower than the last (round 3 = consequences of round-2 fixes), so the
  loop stops at the cap and goes to the final gate.
- **Final gate** (gemini-4-argon, round 1): CONCERNS → `gateDisposition: approve_with_debt`. G1 (MED,
  non-blocking): CLI/registry-test/activation still keyed on `fingerprint` after R3-M1 → fixed
  (`--identity` + `--scan`, identity-keyed test and activation search). G2 (LOW): DB-test oracle
  still said `stale-snapshot` → fixed (`superseded`). No debt left open from the gate.
- **Structural card at the cap**: 2 STRUCTURAL clusters (closure workflow; durable write contract),
  both on `scripts/lib/audit-store-writers.mjs`, linked to existing debt `fbc38b29` "Stale Write
  Replay". Call: **STOP** (the coordinator's brief caps plan audit at 3 rounds). The shared primitive
  the card asks about already exists — `durableWrite` + `withTx`; this plan's writer uses it with an
  `observed_until` freshness guard rather than adding a second mechanism. Debt `fbc38b29` is about
  OTHER writers' replay ordering and stays independent (this plan's writer does not call them).

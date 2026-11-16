# Plan: Harness Retro — promote recurring session failures into enforcement

- **Date**: 2026-11-16
- **Status**: In Progress
- **Author**: Claude + Louis
- **Scope**: backend (CLI + pure libs + one new skill — no UI, no migration)

> **Detected**: scope `backend`, stack `js-ts` (+ postgres). Principle set: engineering principles #1–#20.
> - **Target domain(s)**: `friction`, `scripts`, `shared-lib`, `skills-content`, `stores`, `supabase`
> - ⚠ **Cross-domain work** — a horizontal feature (scan → judge → record → enforce → measure), each step in its owning subsystem. No new domain: the core lives under `scripts/lib/friction/retro/`, which the `scripts/lib/friction/**` rule already tags `friction`.
> - **No migration in v1.** An earlier revision of this plan added three tables; the v1 right-sizing
>   cut (§2 Right-sizing gate, cut 1) removed them — v1 writes nothing to the audit store, so no
>   store needs migrating before CES `main` moves.

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
    Op->>CLI: scan --since 14d
    CLI->>Rd: enumerate and stream jsonl (local disk only)
    Rd->>Sig: records per file, attributed to a session
    Sig-->>CLI: per-session occurrence counts
    CLI->>Inv: rank candidates, check existing harness and tripwires
    CLI->>Reg: read decided fingerprints
    CLI->>Art: write scan artifact (versioned, derived only)
    Op->>Op: skill step - the session model judges the top-N candidates
    Op->>CLI: record --scan id --stdin (Zod-validated against the scan)
    CLI->>Art: write proposals artifact + markdown
    Note over Op: human approves one; the fix PR also runs enforce, adding the registry entry
    Op->>CLI: effect
    CLI->>Reg: activation = first-parent main commit that introduced the entry
    CLI->>Art: before vs after recurrence over covered windows (local artifacts)
```

### Egress policy — what may leave the reader, per destination (H1)

| Destination | Fields | Free text? | Why safe |
|---|---|---|---|
| **Audit store** (private DB) | v1: **nothing**, except the existing `memory_friction.mitigation_refs` link written by `frictionLink` when a `type: friction` tripwire is enforced (a test path) | **No** | v1 adds no store write of its own (right-sizing cut 1). |
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
   reported and is **never effect evidence**. One
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
   reported and never guessed. "This repo" = the identity of the running checkout,
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
   label with a STRICTER rule than the inventory hint — containment ≥ **0.5** AND ≥ **3** shared
   tokens (at the 0.35 hint floor, 71 of ~90 tripwires "matched" a 14-day corpus; measured
   2026-11-16, 4 with the stricter rule). Output per tripwire: `firedSessions`,
   `matchedFingerprints`, `enforced`. `firedSessions ≥ 2` and not enforced → **promotion
   candidate**; zero matches → `no-evidence`, never "dead". **v1 only lists them** (cut 3).
9. **Local artifacts (H8)** under `.audit/harness-retro/` (gitignored):
   - `scan-<scanId>.json` — `ScanArtifactSchema` v1: `{schemaVersion, scanId, fingerprintVersion,
     accountKey, requested:{since, until}, files:{listed, read, readErrors, unparseableLines},
     measured, reason?, sessions:[{sessionKey, repoUuid|null, origin, startedAt, counts:{fp:n}}],
     fingerprints:{fp:{kind, tool, label}}, candidates[], tripwires[], summary}`.
   - `proposals-<scanId>.json` + `.md` — written by `record`.
   `scanId` = UTC timestamp (ms) + 6 random hex. `scan` prunes only artifacts that can never be effect
   evidence (fleet, unmeasured or incomplete) older than 60 days; evidence artifacts are kept.
10. **The LLM step = the session's own model, driven by the skill.** The skill reads the latest
    scan artifact's top **5** candidates (`--top`) and the top promotion candidates, judges each, and pipes proposals to
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
13. **`enforce` / `reject` — idempotent closure (H7).** A **preflight** validates every input
    (identity is a candidate of the scan or `--force-unscanned`; the test qualifies per the registry
    rules; the summary is public-safe) and writes nothing on failure. Then (1) the registry append,
    under the registry's own lock (`withFileLock` on `.harness-retro/decisions.json.lock`), atomic,
    idempotent on `identity`; (2) for a `tripwire:` identity whose memory is `type: friction`, the
    EXISTING `frictionLink(kind:'test', ref: <test>)` — idempotent — so `memory_friction.resolved`
    flips through the existing seam. **v1 does not edit `MEMORY.md`** (cut 3): retiring the
    tripwire line is a human edit in the fix PR; the memory file is kept.
14. **Store — none in v1 (cut 1).** The effect metric reads the local scan artifacts (component 9),
    which outlive the transcripts they were derived from (pruned after 60 days vs Claude Code's
    ~30-day transcript cleanup). The cost of that choice is named: effect evidence is per machine and
    per account, and a deleted `.audit/harness-retro/` loses it. Promote to a store only when a
    measured need appears (e.g. an effect verdict that needs another machine's sessions).

### The existing friction tables — what v1 reuses, and what they cannot carry

- **Reused**: `memory_friction.mitigation_refs` + its generated `resolved` column are the
  enforcing-link store for friction-typed tripwires, written through the existing `frictionLink`
  (`commands.mjs:416`). The committed `.harness-retro/decisions.json` is the enforcing link for
  everything else, reviewed in the fix PR.
- **Cannot carry the scan's derived rows**: `memory_friction` mirrors `type: friction` memory files
  keyed `UNIQUE (repo_id, memory_name)`, and `frictionMirror` (`commands.mjs:321`) tombstones every
  row whose memory file is absent on a complete scan — a fingerprint row with no memory file would
  be deactivated by the next `quality mirror`. It also has no per-session occurrence column, which
  the before/after metric needs (numerator AND denominator). `friction_log` is free text with no
  key, so a rescan would double-count. Carrying the rows there would mean encoding counts in prose.
- **Therefore v1 stores the derived rows nowhere but local artifacts** rather than add a table it
  cannot yet show a need for (the constraint: no new table without a proven need).
- **Also reused**: `resolveHarnessMemoryDir`, `claudeConfigDir`, `redactSecrets` /
  `preWriteSecretGate`, `withFileLock` / `atomicWriteFileSync`, `resolveRepoIdentity`.

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
carries `window`, `accounts`, counts, both rates and the thresholds. Source (v1): the union of the
local scan artifacts on this machine (`source:'local-scan'`).

**Horizon — which data limit applies.** The binding limit is Claude Code's transcript retention
(`cleanupPeriodDays` in the account's `settings.json`, default **30 days**), not artifact pruning:
(1) every scan clamps its coverage claim to `now − cleanupPeriodDays` (a `--since 60d` request covers
only the last 30 — older sessions may already be deleted, and their absence must not read as "no
failure"); (2) a before-window can therefore only be measured if a scan ran while its sessions were
still on disk — run `/harness-retro` at the end of coordinator sessions *before* a fix lands;
(3) the scan artifacts that hold those counts are effect evidence and are **never pruned** (only
old fleet / unmeasured / incomplete scans are), so after the 30-day transcript cleanup they are the
sole local copy (`.gitignore` Category P, no durable home in v1 — declared honestly). A
before-window older than the earliest completed scan → `unmeasured: no-covered-account` naming the
retention limit, never "0 recurrences". Artifact size: ~185 KB per 7-day scan of this repo.

### Cadence

- **Skill**: `/harness-retro` at the end of every coordinator (or any) session.
  `skills/fleet/references/ending-a-session.md` gains one step pointing at it — the fleet SKILL.md
  cannot grow (over the size ratchet).
- **No periodic run in v1** (cut 2): no scheduler, no heartbeat. `status` reports the last scan's age.

### Right-sizing gate

- **Band-aid extreme**: a grep script printing top error strings — no fingerprint identity, no
  "already exists" check, no evidence contract, no effect; lessons stay prose.
- **Over-engineered extreme**: an always-on daemon, a new store schema, an LLM API judge, embedding
  clusters, automated MEMORY.md surgery, a dashboard, a scheduler.
- **Chosen v1 — the smallest structurally honest version** (constraint from the coordinator,
  2026-11-16): the deterministic scanner, fingerprints and cross-session counts, the existing-harness
  check, and a ranked proposal report whose every item names a layer and a positive control, with
  the evidence checked against the scan.

**Cut from v1, and why** — each was built in an earlier revision of this branch and removed:

1. **The audit-store tables + migration** (`harness_retro_scans/_sessions/_occurrences`, a
   durable snapshot writer, a DB suite). The existing friction tables cannot carry the rows (above),
   and v1 has no proven need for cross-machine persistence: local artifacts back the effect metric.
   Removing it also removes a migration every store would have to apply before `main` moves.
2. **A periodic / scheduled run and its heartbeat.** Cadence is "end of every coordinator session";
   measure whether that is enough before adding a scheduler.
3. **Automated memory retirement** (frontmatter mark, moving `MEMORY.md` lines to an enforced
   index, two-direction consistency checks). v1 lists promotion candidates; a human edits the index.
4. **Judging more than the top few.** The judge sees the top 5 candidates by default; the report
   still lists counts for the rest.
5. **Any dashboard.** The markdown report and `--json` envelope are the output.

**Kept, because each is a current requirement**: the effect metric (asked for explicitly) computed
from local artifacts; the committed decision registry and its `npm test` validation (the "ships
with a check proving it fires" rule); evidence-checked `record`; the `frictionLink` reuse.

**Cost of one retro run** (measured 2026-11-16 on this machine, which had ~45 other node processes
running): the scan is deterministic — **zero model tokens**, **22 s for 7 days** (1,188 transcript
files, 133 in-scope sessions), 112–131 s for 14 days (3,307 files); the default window is therefore
7 days. The judging step reads the top-5 candidates plus promotion candidates: **~5.3 KB ≈ 1.3 k
input tokens**, plus the model's own proposal output (a few hundred tokens per proposal). That is
cheap enough to run at the end of every coordinator session.

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
- **Fleet scope**: `--fleet` reports every resolved repo; a fleet scan is never effect evidence for
  this repo (only repo-local scans are).

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
- `scripts/lib/friction/retro/memory-tripwires.mjs` (create) — `parseMemoryIndex`, `readFrontmatter`,
  `scanTripwires` (read-only; v1 lists candidates, retirement is a human edit — cut 3).
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

**Store** — none in v1 (right-sizing cut 1).

**CLI**

- `scripts/harness-retro.mjs` (create) — verbs `scan [--since 7d] [--fleet] [--top 5]`,
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
  other-repo and unresolved sessions excluded; v1 has no store flag (`--persist` is refused); egress: a planted secret and a planted user
  sentence never appear in any artifact or store payload.

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

**Phase 3 — CLI**: verbs, envelopes, local artifacts, effect from local artifacts, sync declaration.
Files: `scripts/harness-retro.mjs` (create), `package.json` (modify), `scripts/.cli-catalog.json` (modify),
`scripts/lib/sync-entry-lists.mjs` (modify), `scripts/lib/sync-isolation-verify.mjs` (modify),
`tests/harness-retro-cli.test.mjs` (create).

**Phase 4 — Skill + roster**: the skill and its references, fleet pointer, roster/count updates.
Files: `skills/harness-retro/SKILL.md` (create), `skills/harness-retro/references/judging-candidates.md`
(create), `skills/harness-retro/references/effect-and-closure.md` (create),
`skills/fleet/references/ending-a-session.md` (modify), `scripts/lib/store/skill-census.mjs` (modify),
`tests/skill-census.test.mjs` (modify), `AGENTS.md` (modify), `docs/reference/skill-roster.md` (modify).

**Close-out (not a phase)**: `npm run skills:regenerate`, `npm run bundle:deps`, `npm run check` (incl. `npm test`), a real `node scripts/harness-retro.mjs scan --since 7d` on this machine (pre-ship
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
  - A periodic / scheduled run (cut 2), a store (cut 1), automated tripwire retirement (cut 3) — each
    re-enters only with a measured need.
  - Scripting the coordinator chores the retro will flag (merge-on-green-at-head watcher, archive +
    worktree removal, refusing to fast-forward CES main while a store is behind) — each a separate
    proposal through this pipeline.

## 9. Testing Strategy

- **Unit (pure)**: every extractor, normaliser, resolver (git injected), aggregator, matcher, schema,
  effect branch and closure step — including the direction each must NOT fire.
- **Integration**: the CLI cross-process over a synthetic `CLAUDE_CONFIG_DIR` (two slug dirs incl. a
  worktree slug, a subagent file, a truncated last line).
- **Tier-3 egress (same commit)**: the CLI test asserts that planted secret/user text never reaches
  any artifact the CLI writes (v1 writes no store payload).

### Proof plan

| Behaviour | Oracle | Pass condition | Evidence |
|---|---|---|---|
| Detects recurring failures | fixture: one error in 3 sessions + a one-off | one `strong` candidate; the one-off counted, not ranked | aggregate test |
| Empty or unreadable scan is UNMEASURED | empty config dir; lines that assemble zero sessions | `measured:false` + named reason, never `candidates:[]` alone | CLI test |
| No store write; other repos excluded | two-repo fixture; `--persist` | other-repo/unresolved counted, not ranked; `--persist` exits 2 | CLI test |
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
- **Cluster B** — Phase 3 — fix-gate: yes
  - Coupling: the CLI composes Cluster A's modules into the cross-process artifact hand-off.
  - Additional files: `.audit-loop/domain-map.json` (modify — declare `scripts → friction`),
    `tests/fixtures/cross-skill-envelopes.json` / `tests/dashboard-*.test.mjs` (modify — roster 18).
  - author-tier: standard
- **Cluster C** — Phase 4 — fix-gate: final
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

### Implementation audit trail (`/cycle --autonomous`, 2026-11-16)

- **Cluster A** (Phases 1–2): 4 GPT rounds. R1 30 findings (5 deferred-declared to B/C, all built
  there), R2 14, R3 11, R4 12 at 33% acceptance → **STOP** on the acceptance-rate rule; every
  valid finding fixed, the rest dismissed with recorded reasons. The recurring class was path
  redaction (R2–R4), closed structurally: absolute paths are redacted to the next delimiter.
- **Cluster B** (Phases 3–4): 2 rounds. R1 15 (9 fixed), R2 1 HIGH (a re-raise of the
  by-design "no scan-row upgrade on drain", linked `sameConcernAs`) + 1 MEDIUM (fixed) →
  converged (HIGH 0 after the re-raise ruling, MEDIUM ≤ 2, quickFix 0).
- **Cluster C** (Phase 5): covered by the consolidated final gate.
- **Final gate** (Gemini, union of A–C): **APPROVE**.
- **Deviations, recorded honestly**: (1) Clusters B and C were built while Cluster A's audit ran,
  so `cycle-cluster-scope.mjs` refused A's scope as "out-of-scope edits"; A's rounds were run over
  exactly A's files with an explicit `aa714af3..HEAD` patch instead. (2) Every audit after the
  migration file existed ran with `AUDIT_ALLOW_SCHEMA_BEHIND=1` — the NAS store is (correctly)
  not migrated by a worker — so those rounds are local-only and commits read `AI-Gate: not-run`.
  (3) The full `npm test` added four repo invariants the plan did not list (CLI catalog entry,
  the cross-skill golden writer list, two dashboard roster counts) — fixed in place.
- **Structural card at the cap**: 2 STRUCTURAL clusters (closure workflow; durable write contract),
  both on `scripts/lib/audit-store-writers.mjs`, linked to existing debt `fbc38b29` "Stale Write
  Replay". Call: **STOP** (the coordinator's brief caps plan audit at 3 rounds). The shared primitive
  the card asks about already exists — `durableWrite` + `withTx`; this plan's writer uses it with an
  `observed_until` freshness guard rather than adding a second mechanism. Debt `fbc38b29` is about
  OTHER writers' replay ordering and stays independent (this plan's writer does not call them).
- **v1 right-sizing cut (after the audits, 2026-11-16)** — on the coordinator's relayed constraint
  (smallest structurally honest v1; reuse the friction tables or prove they cannot carry the data;
  defer scheduling, dashboards, automated retirement, wide LLM judging; name the cost): removed the
  three-table migration, store module, durable writers and DB suite; the heartbeat; automated
  tripwire retirement; default judged candidates 10 → 5; default window 14 d → 7 d; stricter
  tripwire matching (71 → 4 candidates on the 14-day corpus). Removals only, plus one stricter
  threshold; re-verified by the full test suite and a focused audit round on the changed files.

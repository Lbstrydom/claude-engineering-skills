# Sensitive-path classification and the VCS contract

Moved out of `AGENTS.md` (2026-08-01) under its progressive-disclosure rule.
The invariants that constrain every change stayed resident there — single
source of truth, fail-closed, `formatSkipLog`, the closed error enums. This
file is the mechanism behind them.

## Sensitive paths

[`scripts/lib/sensitive-paths.mjs`](../../scripts/lib/sensitive-paths.mjs) is
the single source of truth for classification. Two categories:

- **`sensitive`** — `.env*`, `secrets/`, `credentials*`, certs/keys, `.aws/`,
  `.ssh/`, `id_rsa*`, `password.*`, `tokens?.*`
- **`generatedNoise`** — lockfiles, `.min.js`, `.map`

Four legacy consumers (`quickfix-patterns.mjs`, `audit-scope.mjs`,
`sensitive-egress-gate.mjs`, `extract.mjs`) all delegate here via
`classifyPath` / `shouldSkipForIndexing` / `filterDiffFiles`. Do not add a
fifth implementation.

### Skip logging

Skip logging MUST go through `formatSkipLog`. Sensitive entries aggregate by
default; `SENSITIVE_PATHS_DEBUG=1` emits `[redacted:<sha256-hex8>].<ext>` —
never basenames, never full paths.

### Diff state handling

The state-aware `filterDiffFiles` rewrites a modified-to-sensitive entry as
`deleted:` so the indexer can tombstone prior rows; a deletion of a sensitive
path is preserved as a tombstone for the same reason. The 12-case state matrix
is in `docs/plans/sustainability-cleanup-batch.md` WS3.

### Canonical-path layer (WS-CANON)

`resolveAndClassify(p, {repoRoot})` sits on top of `classifyPath`. It runs the
lexical check first (cheap, no FS touch); when that returns `null` it calls
`fs.realpathSync` and re-classifies the canonical target. This catches a
symlink whose visible name is innocent (`repo/notes.txt`) but whose target
resolves into `~/.ssh/id_rsa` or `secrets/`.

Fail-closed in both directions:

- resolution error → `resolutionFailed: true`, `category: 'sensitive'`
- symlink escaping `repoRoot` → `escapedRepo: true`, `category: 'sensitive'`

`gateSymbolForEgress({…, repoRoot})` opts in; callers without `repoRoot` get
the pre-WS-CANON lexical-only behaviour.

`redactSecrets` is fail-closed too — non-string payloads route through
[`scripts/lib/redact.mjs`](../../scripts/lib/redact.mjs) `redactObject`
(depth/node-capped, ancestor-stack cycle detection), and any failure returns
`[REDACTED:redaction-failed]` rather than leaking the raw payload.

INC-001 in [`docs/security-strategy.md`](../security-strategy.md) records the
symlink-bypass class this layer closed.

## The VCS contract

[`scripts/lib/vcs.mjs`](../../scripts/lib/vcs.mjs) returns structured results,
never bare throws. `gitCommitSha` / `gitDiffWithWorkingTree` return
`{ok:true, …}` or `{ok:false, error:{code, message, cause?}}`.

Closed `VcsErrorCode` enum, and the exit code each maps to via
`vcs.exitCodeFor(code)`:

| Code | Exit | Retryable |
|---|---|---|
| `GIT_BINARY_MISSING` | 127 | no |
| `NOT_A_GIT_REPOSITORY` | 5 | no |
| `BAD_REVISION` | 4 | no |
| `WORKING_TREE_UNREADABLE` | 5 | no |
| `EXEC_FAILED` | 1 | **yes** — the only one (`RETRYABLE_VCS_ERRORS`) |

`isSafeGitRevision` is the boolean predicate for revision strings.

## Subprocess helpers

`runJsonLines` moved to
[`scripts/lib/subprocess.mjs`](../../scripts/lib/subprocess.mjs) (WS-LIVE) as
`runJsonLinesAsync` + `runJsonLinesAsyncStrict`. Async streaming restores
heartbeat liveness during the symbol-index pipeline.

Closed `SubprocErrorCode` enum: `EXIT_NONZERO`, `SPAWN_FAILED`,
`KILLED_BY_SIGNAL`, `PARSE_FAILED_HARD`.

The **strict** wrapper hard-fails on parse errors by default — this closes the
`.filter(Boolean)` silent-data-loss invariant, where unparseable lines vanished
and the caller read a short list as a complete one. Pass
`opts.maxParseErrors: Infinity` for the legacy tolerant behaviour.

# Plan: pre-push — a sanctioned lane for `archive/*` refs
- **Date**: 2026-10-11
- **Status**: Draft
- **Author**: Claude + Louis
- **Scope**: backend (git hook + one CLI + one lib; no UI) · stack `js-ts` (`detect-stack`: `js-ts`)
- **Target domain(s)**: `root-scripts`, `shared-lib`
- **Depends on**: none. Precedent: the delete-only skip in `.githooks/pre-push` §0.5 (#158). Spun out of `docs/plans/fleet-unclaimed-work-and-switch-friction.md` §2.6 item z.

## 0. Decisions at a glance

| # | Decision | Why in one line |
|---|---|---|
| D1 | The lane **runs one thing: a scan of what the push publishes** (secret patterns + sensitive paths). It skips all 34 steps of `check`; §3 classifies every step and a test pins the table | `check` contains **no** such scan (§1.2), so there is nothing to "keep"; the lane must add it |
| D2 | A push takes the lane iff **every** ref update's *destination* is `refs/heads/archive/*` or `refs/tags/archive/*` and at least one is not a deletion. Any other ref, deletions included, gets the full gate | Mixed pushes keep today's behaviour exactly |
| D3 | The scan subject is the **object set the remote lacks**: `git rev-list --objects <shas> --not --remotes=<remote>`. Blobs, commits and tag objects are scanned; trees are not | Scans what is published, not a diff or a checkout. No sandbox, no `npm ci` |
| D4 | No remote-tracking refs for the named remote, an unpeelable ref, or any git failure → the lane **declines** and the full gate runs | The lane never guesses its own range; a decline is today's behaviour |
| D5 | Findings block. A finding set can be **acknowledged exactly** with `AUDIT_ARCHIVE_LANE_ACK=<fingerprint>`; the fingerprint hashes the finding set, so it cannot cover content it was not shown | Raw pattern hits block the motivating archive (§1.3); a blanket bypass is the `--no-verify` habit again |
| D6 | The lane's code comes from **the checkout the hook itself lives in** (`$0`), not from the pusher's cwd | The running hook is not the pusher's checkout (§1.4) |
| D7 | `AUDIT_PREPUSH_ARCHIVE_LANE=0` forces the full gate | A way to tighten, never to loosen |
| D8 | `check` is **not** changed. Whether the full gate should also scan pushed content is raised for the user, not decided here | Out of scope, and it would block every push on fixture strings (§1.3) |

## 1. Evidence

Figures are labelled `measured` (command run 2026-10-11 in this checkout) or `derived`.

### 1.1 The motivating push

`git ls-remote origin 'refs/heads/archive/*' 'refs/tags/archive/*'` → one branch, `archive/queue-burndown-2026-10-02` at `3c0afc4e` (measured). `git rev-list --left-right --count origin/main...3c0afc4e` → `48 49`: the archive is 49 commits ahead of and 48 behind main (measured, with `origin/main` at `3590b97b`).

To see which steps of `check` fail on a commit like that, a probe ran **each of the 34 steps separately** in a throwaway worktree at `3c0afc4e`, with the sandbox's own range variables (`AUDIT_PUSH_RANGE_BASE` = the merge-base, `…_REQUIRED=1`, `ARCH_COVERAGE_REQUIRE_ENVELOPE=1`) and the observed-graph envelope provisioned from the main checkout. The probe script is not committed (one-off instrument; its result table is §3). Result (measured): **31 pass, 2 fail, 1 not run** (`npm test`, ~9 min).

| Failing step | Why | Kind |
|---|---|---|
| `docs:refs:gate` | `skills/audit-code/SKILL.md:217` cites `scripts/lib/foo.mjs` and `tests/foo.test.mjs`: GONE. This reproduces the push failure. The snapshot was never green under its own gate, which is normal for a backup of work in flight | commit state |
| `upstream:reconcile:gate` | Exit 2 after "Cloud store connected": it reads the live store's upstream-report queue, which is not a property of the commit | live store state |

### 1.2 `check` has no secret scan and no sensitive-path gate on pushed content

A static census of the import closure of the 40 entry scripts the 33 non-test steps run (313 reachable modules) finds 19 modules that call `scanForSecrets`, `redactSecrets`, `classifyPath`, `resolveAndClassify` or `isPathSensitive` (measured). Read one by one, none turns a hit into a failure about **committed content**: they are LLM-egress and store-write redaction (`neighbourhood-query`, `embed-text`, `anthropic-client`, `store/*`), path-validation (`path-validation`, `gate-honesty/schema`), and skip filters (`efficacy-lints` skips sensitive files rather than reporting them). Method limit: static, so a dynamic `import()` with a computed specifier would not appear; `npm test` exercises the primitives but scans no pushed object.

So the brief's constraint, "keep the secret scan and egress check that `check` includes", names nothing that exists. The honest reading is its intent: **publishing to a public repo must not skip secret/sensitive-path scrutiny**. D1 delivers that by adding the scan to the lane.

### 1.3 A raw scan blocks the motivating archive

Prototype: `rev-list --objects 3c0afc4e --not origin/main` (what a first push would send), `scanForSecrets` over every blob/commit body and `classifyPath` over every blob path.

| Range | Objects | Time | Sensitive-path hits | Raw secret-pattern hits |
|---|---|---|---|---|
| `archive/queue-burndown-2026-10-02` as a first push | 460 (49 commits, 246 trees, 165 blobs) | 155 ms | 0 | **13 in 9 files** |
| last 300 commits of `origin/main` | 4,522 | 1.2 s | 0 | 61 in 23 paths (21 under `tests/`; 40 in docs, CI and example config) |

Every one of the 13 is synthetic: loopback DSNs (`postgres:postgres@127.0.0.1`), `u:p@h`, `hunter2@host.example.com`, `sk-ant-test-not-a-real-key`, `ghp_abcdefghijklmnopqrstuvwxyz0123456789`, `sk-or-v1-DEADBEEFDEADBEEF`. This repo tests its own scanner, so fixtures shaped like secrets are the norm. A lane that blocks on raw hits with no acknowledgement path would reject the very push it exists for, and the pusher would reach for `--no-verify`. Zero sensitive-path hits in both ranges: path findings are the low-noise class.

Rejected: value heuristics ("looks fake": loopback host, sequential run, `test` marker). Each is individually reasonable and together they are a zoo that a real secret can slip through and a new fixture shape can trip. The scan reports; a person acknowledges the exact set.

### 1.4 The hook that runs is not the pusher's checkout

`git config --get core.hooksPath` → `C:\GIT\claude-engineering-skills\.claude\worktrees\fleet-unclaimed-work-plan\.githooks` (measured): a **linked worktree's** `.githooks`, in backslash form, not main's. Consequences, each pinned in §5:
- `dirname "$0"` on a backslash path returns `.`; the hook must normalise `\` before locating its own root.
- The pusher's cwd (`REPO_ROOT`) may predate the lane, so `REPO_ROOT/scripts/prepush-archive-lane.mjs` can be absent while the hook is new. Hence D6, and a missing script declines to the full gate.
- If that worktree is deleted, git runs **no hook at all**, silently. Not fixed here; reported in §6.

### 1.5 An unbounded scan is not affordable

Buffering every blob reachable from `origin/main` overflowed a 512 MiB buffer (`ENOBUFS`) across 25,988 objects (measured): history holds more than 0.5 GB of blob content. So the lane must (a) bound its range by remote-tracking refs (D4) and (b) read blobs in size-bounded batches.

## 2. Design

```mermaid
flowchart TD
  A["pre-push: stdin lines"] --> B{"delete-only?"}
  B -->|"yes"| X["exit 0 (existing, section 0.5)"]
  B -->|"no"| C["working-tree check + harvest (existing)"]
  C --> D["node lane CLI: decide from the lines"]
  D --> E{"every destination under archive/ ?"}
  E -->|"no"| F["exit 3: full gate"]
  E -->|"yes"| G["rev-list --objects shas --not --remotes=remote"]
  G --> H{"range computable?"}
  H -->|"no"| F
  H -->|"yes"| I["scan blobs, commits, tags"]
  I --> J{"findings?"}
  J -->|"none"| K["exit 0: skip the full check"]
  J -->|"acknowledged exactly"| K
  J -->|"otherwise"| L["exit 1: block, print list and fingerprint"]
  F --> M["existing sandbox + npm run check"]
```

### 2.1 One oracle for the predicate

The hook already parses stdin in bash. The lane predicate is decided **only in the Node CLI** (`decidePushLane`), fed the raw lines. A second spelling in bash would be exactly the two-implementations seam the repo warns about, with nothing that could compare them. Cost: one `node` start (~50 ms) on every non-delete push, against a ~10 min check.

Exit protocol of `scripts/prepush-archive-lane.mjs`: **0** lane ran clean (or acknowledged), skip the full check; **1** blocked by findings; **3** declined, run the full gate. Any other status, or a crash, is treated by the hook as a decline: a broken lane must never block a push the full gate would verify, and must never wave one through. The CLI catches all errors and exits 3, so an uncaught exception's status 1 cannot masquerade as "findings".

### 2.2 What is scanned, and what "clean" may claim

For each published archive ref the CLI peels `LOCAL_SHA^{commit}` (an annotated tag is followed; a tag of a tree or blob declines). Then `git rev-list --objects <shas> --not --remotes=<remote>` lists the objects the remote lacks as of the last fetch. A stale fetch only over-scans (safe direction). `--remotes=<remote>` needs at least one `refs/remotes/<remote>/*` ref; a push to a bare URL declines.

Scanned bodies: blobs, and the raw text of commit and tag objects (messages can carry secrets). Trees are skipped. Sizes come from one `cat-file --batch-check`; bodies are read in batches of at most 64 MiB; a blob over 8 MiB is a finding of kind `unscanned`, not a silent skip.

Vacuous-pass guards (sandbox-honesty rule: can this go green having checked nothing?):
- An empty object list is "the remote already holds everything" and says so; it is distinct from a failed `rev-list`, which declines.
- Objects read must equal objects listed, or the lane declines.
- The summary always prints counts (`N objects, M scanned, K findings`), so zero is never ambiguous.

### 2.3 Findings, output, acknowledgement

Finding kinds: `path` (`classifyPath(path) === 'sensitive'`), `secret` (`scanForSecrets`, pattern names only), `unscanned`. **Matched text is never printed.** A `path` finding prints `[redacted:<hash8>].<ext>` and the blob id, per the `formatSkipLog` convention (sensitive basenames do not reach logs; this output lands in agent transcripts); the block message gives `git log --find-object=<oid> --name-only -n 1` to locate it. A `secret` finding prints its path in full, since the path is not the secret.

The fingerprint is the first 12 hex of a SHA-256 over the sorted `kind, blob id, pattern` triples. `AUDIT_ARCHIVE_LANE_ACK` equal to it acknowledges exactly that set; any other value blocks and prints the expected one. The message shows both a PowerShell and a bash form with the literal value, no `<placeholders>` (repo convention). An acknowledged run always prints one stderr line saying how many findings it passed.

### 2.4 Hook integration

Inside `.githooks/pre-push` §1, before the sandbox: if `AUDIT_PREPUSH_ARCHIVE_LANE` is not `0`, locate `HOOK_ROOT` from `$0` (backslashes normalised), require `$HOOK_ROOT/scripts/prepush-archive-lane.mjs`, run it with `cwd` = the pusher's checkout and the stdin lines on its stdin. Exit 0 → print what was skipped and continue to §1.5 onward; 1 → `exit 1`; anything else → fall through to the existing full gate untouched. §0.9 (working-tree surface check) and §0.95 (harvest) still run first; §2 (consumer sync) already skips non-default pushes.

## 3. Classification of `check` (the table the PR carries)

Classes: **P** publication-safety (none exist; the lane's own scan fills the slot) · **S** snapshot-drift: compares the commit with a baseline, index or generated artifact that a backup of work in flight need not have caught up with · **E** environment: its verdict depends on the machine or live store, not the commit · **T** the test suite. "Probe" is the §1.1 result on `3c0afc4e`.

| Step | Class | Reason it is skipped | Probe |
|---|---|---|---|
| `context:check` | S | AGENTS.md ↔ CLAUDE.md alignment and size cap | pass |
| `docs:check` | S | docs placement discipline | pass |
| `docs:refs:gate` | S | cited repo paths must resolve against a baseline | **FAIL** |
| `docs:synced-links:gate` | S | relative links in synced markdown | pass |
| `docs:architecture-intent:check` | S | domain roster vs `domain-map.json` | pass |
| `plans:status` | S | plan `Status:` line conformity | pass |
| `plans:index:check` | S | generated plans index byte-freshness | pass |
| `requirements:map:check` | S | generated requirements map byte-freshness | pass |
| `bundle:deps:check` | S | generated bundle deps byte-freshness | pass |
| `skills:check` | S | `.claude/skills/**` regeneration freshness | pass |
| `skills:consumer-refs:gate` | S | pointers inside synced skills | pass |
| `plans:lint` | S | Mermaid renderer-compat lint | pass |
| `parity:check-coupling` | S | schema-coupling baseline | pass |
| `efficacy:check` | S | opt-in efficacy lints | pass |
| `on-conflict:check` | S | store write-path lint | pass |
| `arch:coverage-gate` | E | needs the observed-graph envelope, which is DB-derived at main's HEAD, not the commit | pass |
| `db:check-rls:gate` | S | migration RLS check | pass |
| `cli:flags:gate` | S | drift-only ratchet | pass |
| `emit:exit:gate` | S | drift-only ratchet | pass |
| `stdout:flush:gate` | S | drift-only ratchet | pass |
| `knip:gate` | S | drift-only ratchet | pass |
| `size:ratchet:gate` | S | drift-only ratchet | pass |
| `gitignore:policy:gate` | S | `.gitignore` category declarations | pass |
| `status:integrity:gate` | S | session-log conservation vs a base | pass |
| `npm-args:gate` | S | documented `npm run x --flag` form | pass |
| `mcp:parity:gate` | S | two MCP configs equivalent | pass |
| `visual-contract-doc:gate` | S | doc example vs schema | pass |
| `worktree:preflight:gate` | S | skill preflight marker | pass |
| `db:enrolment:gate` | S | DB suites enrolled in runners | pass |
| `db:suites:gate` | E | runs DB suites in a container | pass |
| `gates:poison` | E | proves every gate can fail (~70 s) | pass |
| `upstream:coverage:gate` | E | live-store upstream dispositions | pass |
| `upstream:reconcile:gate` | E | live-store upstream queue | **FAIL** |
| `npm test` | T | ~9 min suite | not run |

Honest reading of the probe: 31 of 33 gates *would* pass on this particular archive, so skipping them forfeits nothing here, but that is a property of one branch. A backup of work in flight is not obliged to satisfy main-line integrity gates (the probe's own `docs:refs:gate` failure is the proof), these gates guard what `main` and consumers receive, and an archive ref reaches neither (consumer sync runs only for the default branch; §2 of the hook). **This reads the brief's "skip only what cannot hold for an old commit" more broadly than its three examples, in the direction of fewer checks.** The alternative, a sandbox run of "all of `check` minus a skip list", costs a checkout plus 2–3 minutes and fails on any backup that is not green, which is the friction that produced `--no-verify`. If the user prefers it, only the lane's runner changes (reuse `prepush-check.mjs` with a step filter); the classification table is already the input.

The table is data in `scripts/lib/prepush-archive-lane.mjs` (`ARCHIVE_LANE_CHECK_CLASSIFICATION`). A test fails when `package.json`'s `check` gains a step with no entry, or the table names a step `check` no longer has (both directions, since the filesystem-side census is the only one that can see a new gate no list mentions). A future publication-safety gate must land as class **P** or the test names it.

## 4. Phases

1. **Library** `scripts/lib/prepush-archive-lane.mjs`: `parsePushLines`, `decidePushLane`, `parseObjectList`, `batchBySize`, `scanObjects`, `fingerprintFindings`, `formatFindings`, the classification table. Pure, with git and the reader injected. Tests: `tests/prepush-archive-lane.test.mjs`.
2. **CLI** `scripts/prepush-archive-lane.mjs`: `--remote`, `--selfcheck-relocation`, `assertKnownFlags`, `finishAndExit` after any stdout write; catches every error → exit 3. Tests against real fixture repos in the same file.
3. **Hook** `.githooks/pre-push` §1 as in §2.4. Tests: `tests/prepush-archive-lane-hook.test.mjs`.
4. **Docs**: a section in `docs/runbooks/prepush-sandbox.md`; the PR body carries §3.

## 5. Verification

Pure and fixture tests (Tier 1; deterministic seams):
- Predicate: archive branch only; archive tag only; archive plus `main` (full); archive plus a non-archive deletion (full); delete-only is not the lane's (§0.5 exits first); `refs/heads/archive` with no slash is not an archive ref; destination is what counts (`main:refs/heads/archive/x` is the lane, `archive/x:refs/heads/main` is not).
- Scan, with a **negative control for every finding kind**: a committed `.env` (path), a PEM block (secret), an oversize blob (unscanned) must each block; a clean branch must pass; a re-push of an existing ref reports "remote already holds everything" and is not the same message as a scan.
- Ack: exact fingerprint passes; a fingerprint for a different set blocks and prints the expected one.
- Declines: no remote-tracking refs; tag of a tree; a corrupt object list. Each exits 3.
- Table: both-direction census against `package.json`.

Hook tests (behavioural, as in `prepush-delete-only-push.test.mjs`): a stubbed `prepush-check.mjs` records its argv.
- Archive push: stub **not** called, lane summary on stderr.
- **Controls**: an ordinary branch push and a mixed push call the stub with the usual range; `AUDIT_PREPUSH_ARCHIVE_LANE=0` calls the stub on an archive push; a lane script that crashes or exits 3 calls the stub.
- **Worktree topology (constraint 3)**: a real `git push` to a local bare remote, from a **linked worktree**, with `core.hooksPath` set to the real repo's `.githooks` in Windows backslash form on win32 and the pusher's `scripts/` lacking the lane. Asserts the hook located its root from `$0`, the lane ran, and stdin carried git's real format.

Live replay (Pre-ship empirical verify): push `3c0afc4e` as `archive/queue-burndown-2026-10-02` to a local bare remote seeded with `origin/main`. Expect: blocked with 13 findings and a fingerprint; with that fingerprint set, accepted; the full gate never starts. Then confirm a non-archive push from the same worktree still runs the full gate.

## 6. Declined, accepted limits, and things found on the way

- **Not changed: `check`.** Whether ordinary pushes should also scan pushed content is a separate decision; per §1.3 it needs the same acknowledgement design or it blocks on fixtures. Raised for the user.
- **Accepted v1 limit: acknowledgement fatigue.** Every archive push with fixtures needs one. Revisit trigger: acks become routine; then add a content-addressed allowlist of reviewed blob ids, not path or value heuristics.
- **Consumer hook** (`scripts/install-prepush-hook.mjs`, which has its own delete-only precedent) is not changed; consumers push archive refs too. Follow-up.
- **`core.hooksPath` points into a linked worktree** (§1.4). If that worktree goes away, git runs no hook and nothing says so. Worth its own task (a `doctor` probe that resolves the configured hooks directory).
- **`--no-verify` cannot be prevented**, only made unnecessary. The lane reduces the reasons to use it; it is not enforcement.
- **Not scanned: ref names, `refs/notes`, and anything not reachable from the pushed archive refs.**
- **Band-aid vs over-built.** The band-aid is `--no-verify` with a nicer name (a lane that runs nothing); the over-built version is a sandbox that runs a curated subset of `check` plus a value-heuristic suppression layer. This is the smallest thing that is a true function of the problem: archive refs publish commits, so scan exactly what is published, and let a person acknowledge exactly what was shown.

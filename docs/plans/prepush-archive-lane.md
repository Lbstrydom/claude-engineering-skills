# Plan: pre-push — a sanctioned lane for `archive/*` refs
- **Date**: 2026-10-11
- **Status**: In Progress
- **Author**: Claude + Louis
- **Scope**: backend (git hook + one CLI + one lib; no UI) · stack `js-ts` (`detect-stack`: `js-ts`)
- **Target domain(s)**: `root-scripts`, `shared-lib`
- **Depends on**: none. Precedent: the delete-only skip in `.githooks/pre-push` §0.5 (#158). Spun out of `docs/plans/fleet-unclaimed-work-and-switch-friction.md` §2.6 item z.

## 0. Decisions at a glance

| # | Decision | Why in one line |
|---|---|---|
| D1 | The lane **runs one thing: a scan of what the push publishes** (secret patterns + sensitive paths). It skips all 34 steps of `check`; §3 classifies every step, and a test makes the classification executable | `check` contains **no** such scan (§1.2), so there is nothing to "keep"; the lane must add it |
| D2 | A push takes the lane iff **every** ref update's *destination* is `refs/heads/archive/*` or `refs/tags/archive/*` and at least one is not a deletion. Any other ref, deletions included, gets the full gate | Mixed pushes keep today's behaviour exactly |
| D3 | Two coverages, kept apart. **Content**: bodies of objects the destination lacks (`rev-list --objects <shas> --not <roots>`). **Paths**: every path a published commit adds or changes (`log --raw`), including a blob the destination already holds | An object list names each object once; it cannot say where a reused blob now lives (§1.6) |
| D4 | `<roots>` = what the **destination itself** advertises (`git ls-remote --refs <push URL>`, the hook's second argument) plus the remote shas on stdin, kept only if present locally. Remote-tracking refs are not used | They describe a fetch, not the push destination, and survive a force-push that removed their history (§1.4) |
| D5 | Four outcomes. `not-applicable` → full gate. `clean` → skip the full check. `findings` or `error` → **block**. No valid result at all (missing script, crash, old checkout): an ordinary push → full gate with a loud warning; a push that **looks** archive-only → **refused** (a bash check that can only block) | An archive push is scanned or refused; a broken lane never turns into an unscanned publish (§2.1) |
| D6 | Findings can be **acknowledged exactly** with `AUDIT_ARCHIVE_LANE_ACK=<fingerprint>`; the fingerprint hashes each finding's full identity (kind, object, path, pattern), and an acknowledgement is **offered and accepted only for a set listed in full** (at most 200), so it cannot cover what it was not shown | Raw hits block the motivating archive (§1.3); a blanket bypass is the `--no-verify` habit again |
| D7 | The lane's code comes from **the checkout the hook itself lives in** (`$0`), not the pusher's cwd | The running hook is not the pusher's checkout (§1.5) |
| D8 | `AUDIT_PREPUSH_ARCHIVE_LANE=0` reverts to the full gate. **That is a loosening**: the full gate has no scan. It exists so a lane bug is never an outage | Stated plainly, not as "tighten only" |
| D9 | `check` is **not** changed. Whether the full gate should also scan pushed content is raised for the user, not decided here | Out of scope, and it would block every push on fixture strings (§1.3) |

## 1. Evidence

Figures are labelled `measured` (command run 2026-10-11 in this checkout) or `derived`.

### 1.1 The motivating push

`git ls-remote origin 'refs/heads/archive/*' 'refs/tags/archive/*'` → one branch, `archive/queue-burndown-2026-10-02` at `3c0afc4e` (measured). `git rev-list --left-right --count origin/main...3c0afc4e` → `48 49`: 49 commits ahead of and 48 behind main (measured, `origin/main` at `3590b97b`).

To see which steps of `check` fail on a commit like that, a probe ran **each of the 34 steps separately** in a throwaway worktree at `3c0afc4e`, with the sandbox's own range variables (`AUDIT_PUSH_RANGE_BASE` = the merge-base, `…_REQUIRED=1`, `ARCH_COVERAGE_REQUIRE_ENVELOPE=1`) and the observed-graph envelope provisioned from the main checkout. The probe is a one-off instrument and is not committed; its result table is §3. Result (measured): **31 pass, 2 fail, 1 not run** (`npm test`, ~9 min).

| Failing step | Why | Kind |
|---|---|---|
| `docs:refs:gate` | `skills/audit-code/SKILL.md:217` cites `scripts/lib/foo.mjs` and `tests/foo.test.mjs`: GONE. This reproduces the push failure. The snapshot was never green under its own gate, which is normal for a backup of work in flight | commit state |
| `upstream:reconcile:gate` | Exit 2 after "Cloud store connected": it reads the live store's upstream-report queue, which is not a property of the commit | live store state |

### 1.2 `check` has no secret scan and no sensitive-path gate on pushed content

A static census of the import closure of the 40 entry scripts the 33 non-test steps run (313 reachable modules) finds 19 modules that call `scanForSecrets`, `redactSecrets`, `classifyPath`, `resolveAndClassify` or `isPathSensitive` (measured). Read one by one, none turns a hit into a failure about **committed content**: they are LLM-egress and store-write redaction (`neighbourhood-query`, `embed-text`, `anthropic-client`, `store/*`), path-validation (`path-validation`, `gate-honesty/schema`), and skip filters (`efficacy-lints` skips sensitive files rather than reporting them). Method limit: static, so a dynamic `import()` with a computed specifier would not appear; `npm test` exercises the primitives but scans no pushed object.

So the brief's constraint, "keep the secret scan and egress check that `check` includes", names nothing that exists. The honest reading is its intent: **publishing to a public repo must not skip secret/sensitive-path scrutiny**. D1 delivers that by adding the scan to the lane. It also means the full gate is **not** a safe fallback for scrutiny, which shapes D5.

### 1.3 A raw scan blocks the motivating archive

Prototype: `rev-list --objects 3c0afc4e --not origin/main` (what a first push would send), `scanForSecrets` over every blob/commit body and `classifyPath` over every blob path.

| Range | Objects | Time | Sensitive-path hits | Raw secret-pattern hits |
|---|---|---|---|---|
| `archive/queue-burndown-2026-10-02` as a first push | 460 (49 commits, 246 trees, 165 blobs) | 155 ms | 0 | **13 in 9 files** |
| last 300 commits of `origin/main` | 4,522 | 1.2 s | 0 | 61 in 23 paths (21 under `tests/`; 40 in docs, CI and example config) |

Every one of the 13 is synthetic: loopback DSNs (`postgres:postgres@127.0.0.1`), `u:p@h`, `hunter2@host.example.com`, `sk-ant-test-not-a-real-key`, `ghp_abcdefghijklmnopqrstuvwxyz0123456789`, `sk-or-v1-DEADBEEFDEADBEEF`. This repo tests its own scanner, so fixtures shaped like secrets are the norm. A lane that blocks on raw hits with no acknowledgement path would reject the very push it exists for, and the pusher would reach for `--no-verify`. Zero sensitive-path hits in both ranges: path findings are the low-noise class.

Rejected: value heuristics ("looks fake": loopback host, sequential run, `test` marker). Each is individually reasonable, together they are a zoo that a real secret can slip through and a new fixture shape can trip. The scan reports; a person acknowledges the exact set.

### 1.4 What the destination holds is not what a remote-tracking ref says

A remote can have different fetch and push URLs, and a tracking ref keeps history the remote has since removed by a force-push or deletion. So `--not --remotes=<remote>` can exclude objects the push will in fact publish, and "a stale fetch only over-scans" is false. The hook is given the destination: `$2` is the push URL, and each stdin line carries the remote's current sha for the ref being updated. D4 derives its exclusion roots from those, and from what `git ls-remote --refs "$2"` advertises, and keeps only roots present locally. "Present" means the advertised object resolves locally to a commit (`cat-file -e <sha>^{commit}`), but **the advertised id itself is what is excluded**: an annotated tag the destination advertises is a tag object, and excluding it is what prunes the tag object and everything it reaches. A root the destination advertises holds its whole closure. An unreachable destination yields `error`, which blocks; the push itself would fail anyway.

### 1.5 The hook that runs is not the pusher's checkout

`git config --get core.hooksPath` → `C:\GIT\claude-engineering-skills\.claude\worktrees\fleet-unclaimed-work-plan\.githooks` (measured): a **linked worktree's** `.githooks`, in backslash form, not main's. Consequences, each pinned in §5:
- `dirname "$0"` on a backslash path returns `.`; the hook must normalise `\` before locating its own root.
- The pusher's cwd (`REPO_ROOT`) may predate the lane, so `REPO_ROOT/scripts/prepush-archive-lane.mjs` can be absent while the hook is new. Hence D7.
- If that worktree is deleted, git runs **no hook at all**, silently. Not fixed here; reported in §6.

### 1.6 An object list is not a path list

`git rev-list --objects` prints each object once, with one representative path. A blob committed at `notes.txt` and again at `.env` is listed under one of them; and a new commit that adds `.env` using a blob the destination already holds lists no blob at all. Path coverage therefore comes from the commits themselves: `git log --root --raw -z --no-abbrev --no-renames -m --format=%H <shas> --not <roots>` emits every path-and-blob pair each published commit adds or changes (with `-m`, a merge is compared with each parent; with `--root`, a root commit is compared with the empty tree). `--root` is explicit because `log.showRoot=false` in the pusher's git config otherwise suppresses root-commit diffs and an archive whose root commit carries a `.env` would read clean. The invocation passes every flag that a user config could otherwise change; a config-dependent safety scan is a scan whose result varies by machine. Content coverage stays with the object list, since a blob the destination already holds is already public.

### 1.7 An unbounded scan is not affordable

Buffering every blob reachable from `origin/main` overflowed a 512 MiB buffer (`ENOBUFS`) across 25,988 objects (measured): history holds more than 0.5 GB of blob content. So the range must be bounded by D4's roots, and every read must be bounded (§2.2).

## 2. Design

```mermaid
flowchart TD
  A["pre-push: stdin lines, remote, push URL"] --> B{"delete-only?"}
  B -->|"yes"| X["exit 0 (existing, section 0.5)"]
  B -->|"no"| C["working-tree check + harvest (existing)"]
  C --> D["lane CLI from the hook's own checkout"]
  D --> E{"every destination under archive/ ?"}
  E -->|"no"| F["token: not-applicable"]
  E -->|"yes"| G["roots: stdin remote shas + ls-remote of push URL"]
  G --> H{"roots established, limits respected?"}
  H -->|"no"| R["token: error, block"]
  H -->|"yes"| I["content scan + path scan"]
  I --> J{"findings?"}
  J -->|"none"| K["token: clean, skip the full check"]
  J -->|"acknowledged exactly"| K
  J -->|"otherwise"| L["token: findings, block"]
  D -.->|"no valid token"| W["warn loudly, run the full gate"]
  F --> M["existing sandbox + npm run check"]
  W --> M
```

### 2.1 One oracle, and a protocol that does not trust exit status

The hook already parses stdin in bash. The lane predicate is decided **only in the Node CLI** (`decidePushLane`), fed the raw lines; a second spelling in bash would be the two-implementations seam the repo warns about. Cost: one `node` start (~50 ms) on every non-delete push, against a ~10 min check.

`node` exits 1 on a syntax or import error before any `catch` can run, so **exit status is transport, not meaning**. The CLI writes exactly one line to stdout, `archive-lane/v1 <outcome>` with `<outcome>` one of `not-applicable`, `clean`, `findings`, `error`, and everything human-readable to stderr. The hook captures stdout and acts only on a line that matches that grammar exactly:

| Token | Hook action |
|---|---|
| `not-applicable` | run the full gate, silently (not an archive push) |
| `clean` | skip the full check; print what was skipped |
| `findings`, `error` | `exit 1`; the stderr diagnostics say what and how to proceed |
| none valid (crash, import error, missing script, empty stdout, unknown outcome) | a push that looks archive-only (every destination under `archive/`): **refuse**, say the lane is unavailable and name `AUDIT_PREPUSH_ARCHIVE_LANE=0` as the explicit override. Any other push: print `archive lane unavailable (...): running the full gate`, then run it |

The last row needs the predicate in bash, because without the lane code the hook cannot otherwise know a push was archive-only. That is a second spelling of the oracle (`isArchiveRef`), accepted because it is used **only** on this branch and **can only block**: drift between the two can never choose the wrong lane, at worst it refuses or fails to refuse a push whose lane already failed. `tests/prepush-archive-lane-hook.test.mjs` compares the two ref by ref (a drift test). An earlier draft let the full gate run here and accepted it as a residual; the code audit (H5) showed that waves an archive push through unscanned or sends the pusher to `--no-verify`. A valid token always wins over exit status.

### 2.2 What is scanned, with what limits, and what "clean" may claim

Only non-deletion stdin lines contribute: a deletion's `LOCAL_SHA` is all zeros and is never passed to git as a tip (it would be a fatal "bad object"), so `archive/a` updated while `archive/b` is deleted scans `archive/a` alone. Each published archive ref yields two things, kept apart: its **tip**, the `LOCAL_SHA` git sent, which may be an annotated tag object or a chain of them; and its **peeled commit**, `tip^{commit}` (a chain that does not peel to a commit is `error`). `<roots>` follow D4. Then:

- **Content**: `rev-list --objects --stdin`, fed `<tip>` and `^<root>` lines, from the **tips**, so every newly published annotated-tag object in a chain is listed (a commit does not reference the tags that point at it). Scanned: blobs, and the raw text of commit and tag objects (messages can carry secrets). Trees are skipped.
- **Paths**: `log --root --raw -z --stdin ...` as in §1.6, fed the peeled commits and `^<root>` lines; every entry whose status is not deletion is classified.

**Tips and roots go to git on stdin, never on the command line.** A destination with thousands of branches and tags makes `<roots>` long enough to overflow the argument limit (about 32 KB on Windows), which would fail the spawn with `E2BIG` and turn a healthy push into a permanent `error`. `rev-list` and `log` both read `--stdin`.

Limits are constants in the lib. An incomplete scan blocks; it is never clean. They fail in two ways, and the difference is deliberate:
- an object over 8 MiB, **of any type**, is an `unscanned` **finding**, which a person can acknowledge like any other (the scan finished and says what it could not read);
- bodies are read in batches of at most 64 MiB, so one object can never exceed the batch;
- these are `error`, with no acknowledgement: more than 200,000 listed objects, or a 120 s wall-clock budget, or output beyond a 256 MiB buffer on `rev-list` / `log` → `error` naming which limit was hit.

Every git call runs with `GIT_NO_REPLACE_OBJECTS=1` and `GIT_NO_LAZY_FETCH=1`: `git replace` refs make `rev-list` and `cat-file` answer with substitutes while `pack-objects` publishes the originals, and a partial clone must not fetch a missing object mid-scan. One deadline governs all of them: each call is handed the time that remains as its own timeout, and the budget is checked again after the last batch.

Enumeration is buffered, not streamed: the measured ranges are 460 and 4,522 objects, and the object cap bounds the worst case. Streaming would be machinery no current requirement needs.

Vacuous-pass guards (can this go green having checked nothing?):
- An empty object list is "the destination already holds everything" and says so; it is distinct from a failed `rev-list`, which is `error`.
- **Exhaustive accounting.** Every listed object must have resolved metadata (one `cat-file --batch-check` line: type and size) and exactly one terminal disposition: *body scanned* (blob, commit, tag), *tree, intentionally excluded*, or *oversized, represented by an `unscanned` finding*. A missing metadata line, a truncated or short body, an unexpected type, or a failed subprocess is `error`. The count of dispositions must equal the count of listed objects.
- The summary always prints counts (`N objects, M bodies scanned, P paths classified, K findings`), so zero is never ambiguous.

### 2.3 Findings, output, acknowledgement

Finding kinds: `path` (`classifyPath(path) === 'sensitive'`), `secret` (`scanForSecrets`, pattern names only), `unscanned`. **Matched text is never printed.**

One `displayPath(path)` formats every path in stdout and stderr, for every kind and every diagnostic: a path that classifies as `sensitive` prints as `[redacted:<hash8>].<ext>` (the `formatSkipLog` convention; this output lands in agent transcripts), any other path prints in full, and a pathless commit or tag finding prints its object type and id. So a sensitive file whose body also matches a secret pattern is redacted on both of its lines. The block message gives `git log --find-object=<oid> --name-only -n 1` to locate a redacted path.

Each finding has one canonical identity, `kind, object type, object id, path (verbatim, before redaction), pattern or reason`; findings are deduplicated on it. The fingerprint is the first 12 hex of a SHA-256 over the sorted identities. So the same blob at a second sensitive path is a different finding, and approving one path cannot approve another. `AUDIT_ARCHIVE_LANE_ACK` equal to the fingerprint acknowledges exactly that set; any other value blocks and prints the expected one. The message shows a PowerShell and a bash form with the literal value, no `<placeholders>` (repo convention). An acknowledged run always prints one stderr line saying how many findings it passed.

**Diagnostics are credential-safe.** A push URL can carry credentials, and a Node subprocess failure carries its full argument list in its message, so no caught exception is ever rendered directly. Failures are structured at the injected git boundary as `{op, code}` (for example `{op:'ls-remote', code:'unreachable'}`) and every diagnostic is built from those and from sanitized context only: `displayDestination(url)` strips URL userinfo and query values (and shows a local path as given), and selected subprocess stderr passes the same sanitizer plus `redactSecrets`. The raw exception and raw argv never reach stdout or stderr.

### 2.4 Hook integration

Inside `.githooks/pre-push` §1, before the sandbox: unless `AUDIT_PREPUSH_ARCHIVE_LANE` is `0`, locate `HOOK_ROOT` from `$0` (backslashes normalised), require `$HOOK_ROOT/scripts/prepush-archive-lane.mjs`, and run it with `cwd` = the pusher's checkout, the stdin lines on its stdin, and the hook's `$1` and `$2` as `--remote="$1"` and `--destination="$2"` (the `=` form, so a value beginning with a hyphen cannot be read as a flag). The destination reaches git only as `git ls-remote --refs -- <destination>`: the end-of-options delimiter keeps a URL such as `--upload-pack=...` from being parsed as an option. The remote name is for display only. Act per §2.1's table. §0.9 (working-tree surface check) and §0.95 (harvest) still run first; §2 (consumer sync) already skips non-default pushes.

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
| `npm-args:gate` | S | the `--` separator in documented npm commands | pass |
| `mcp:parity:gate` | S | two MCP configs equivalent | pass |
| `visual-contract-doc:gate` | S | doc example vs schema | pass |
| `worktree:preflight:gate` | S | skill preflight marker | pass |
| `db:enrolment:gate` | S | DB suites enrolled in runners | pass |
| `db:suites:gate` | E | runs DB suites in a container | pass |
| `gates:poison` | E | proves every gate can fail (~70 s) | pass |
| `upstream:coverage:gate` | E | live-store upstream dispositions | pass |
| `upstream:reconcile:gate` | E | live-store upstream queue | **FAIL** |
| `npm test` | T | ~9 min suite | not run |

Honest reading of the probe: 31 of 33 gates *would* pass on this particular archive, so skipping them forfeits nothing here, but that is a property of one branch. A backup of work in flight is not obliged to satisfy main-line integrity gates (the probe's own `docs:refs:gate` failure is the proof), these gates guard what `main` and consumers receive, and an archive ref reaches neither (consumer sync runs only for the default branch; hook §2). **This reads the brief's "skip only what cannot hold for an old commit" more broadly than its three examples, in the direction of fewer checks.** The alternative, a sandbox run of "all of `check` minus a skip list", costs a checkout plus 2–3 minutes and fails on any backup that is not green, which is the friction that produced `--no-verify`. If the user prefers it, only the lane's runner changes (reuse `prepush-check.mjs` with a step filter); the table is already its input.

**The table is executable, not descriptive.** It is data in `scripts/lib/prepush-archive-lane.mjs` (`ARCHIVE_LANE_CHECK_CLASSIFICATION`), and `validateClassification(table, steps)` returns problems the test asserts are empty:
- a step in `package.json`'s `check` with no entry, or an entry for a step `check` no longer has (the census runs against the file, the only side that can see a new gate no list mentions);
- a **class P entry with no `laneScanner`**, or one naming a scanner the lane does not have (`secret-scan`, `sensitive-path-scan`). So a future publication-safety gate cannot be added by editing the table alone: the lane would still skip it, and the validator says so;
- a class other than P/S/E/T, or an empty reason.

A synthetic test adds a P step with no mapping and asserts the validator rejects it. What no test can establish is that an `S` entry should have been `P`: that is a human judgment, made in the review of whatever PR changes `check`, and the validator's failure message states the question ("does this step protect against harm from the commits becoming public?").

## 4. Phases

1. **Library** `scripts/lib/prepush-archive-lane.mjs`: `parsePushLines`, `decidePushLane`, `establishRoots`, `listPublished` (content + paths), `scanPublished`, `canonicalIdentity`, `fingerprintFindings`, `displayPath`, `formatDiagnostics`, `validateClassification`, the table and the limit constants. Pure, with git and the clock injected. Tests: `tests/prepush-archive-lane.test.mjs`.
2. **CLI** `scripts/prepush-archive-lane.mjs`: `--remote`, `--destination`, `--selfcheck-relocation`, `assertKnownFlags`, `finishAndExit` after the token line; every error becomes an `error` token. Tests against real fixture repos in the same file.
3. **Hook** `.githooks/pre-push` §1 as in §2.4. Tests: `tests/prepush-archive-lane-hook.test.mjs`.
4. **Docs**: a section in `docs/runbooks/prepush-sandbox.md`; the PR body carries §3.

## 5. Verification

Pure and fixture tests (Tier 1; deterministic seams):
- Predicate: archive branch only; archive tag only; archive plus `main` (full); archive plus a non-archive deletion (full); `refs/heads/archive` with no slash is not an archive ref; destination is what counts (`main:refs/heads/archive/x` is the lane, `archive/x:refs/heads/main` is not).
- Roots: a destination advertising **an annotated tag** (the tag object is excluded and its history is not re-scanned); a destination with **thousands of refs** (the spawn must not fail on argument length); a push that updates one archive ref and **deletes another** (the zero id is never passed to git); a destination whose **push URL differs from the fetch URL** (two bare repos); **stale tracking refs** after the destination's history was force-removed (the objects must be scanned, not excluded); remote shas from stdin; an unreachable destination is `error`.
- Content and paths, with a **negative control per finding kind**: a committed `.env` (path), a PEM block (secret), an oversize blob, an oversize commit message and an oversize tag message (unscanned) each block; a clean branch passes. **Tags**: a clean annotated tag passes; a secret-bearing annotation blocks; a nested annotated tag (a tag of a tag) has both messages scanned; a tag whose chain peels to a tree is `error`.
- Accounting: a mixed set containing all three permitted dispositions (scanned, excluded tree, oversized) is `clean` or `findings` as appropriate; an omitted or truncated body is `error`. Path coverage: **one blob under an ordinary and a sensitive path** flags the sensitive one; **a new sensitive path whose blob the destination already holds** flags; a merge commit's introduced path flags.
- Output: a fixture whose sensitive filename contains a secret-pattern body — its raw path appears nowhere in captured stdout or stderr; no matched text appears either. **Hostile destination**: a destination beginning with `-` (for example `--upload-pack=touch-a-marker`) is passed after `--`, creates no marker file, and yields `error`. **Failure path**: a fake git process whose `ls-remote` fails while echoing a credential-bearing destination (`https://user:token@host/…?token=…`); neither the userinfo nor the query value appears anywhere in captured output.
- Config independence: a real repository with `log.showRoot=false` in its config and a `.env` committed in the pushed **root** commit blocks, and a clean root commit under the same config passes.
- Ack: exact fingerprint passes; a fingerprint for a different set blocks and prints the expected one; the same blob at two sensitive paths gives two identities; input order does not change the fingerprint; a changed path with unchanged content invalidates the ack.
- Limits: object cap, time budget and buffer overflow each yield `error`, never `clean`; "destination already holds everything" is worded differently from a scan.
- Table: both-direction census against `package.json`, plus the synthetic unmapped P step.

Hook tests (behavioural, as in `prepush-delete-only-push.test.mjs`); a stubbed `prepush-check.mjs` records its argv:
- Archive push: stub **not** called, summary on stderr.
- **Controls**: an ordinary branch push and a mixed push call the stub with the usual range; `AUDIT_PREPUSH_ARCHIVE_LANE=0` calls it on an archive push.
- **Protocol**: a lane script that exits 0 with no token, one that exits 1 with a syntax error, one printing an unknown outcome, and a missing script each print the "unavailable" warning and call the stub; a `findings` token with exit 0 still blocks.
- **Worktree topology**: a real `git push` to a local bare remote, from a **linked worktree**, with `core.hooksPath` set to the real repo's `.githooks` (Windows backslash form on win32) and the pusher's `scripts/` lacking the lane. Asserts the hook found its root from `$0`, the lane ran, and stdin carried git's real format.

Live replay (Pre-ship empirical verify): push `3c0afc4e` as `archive/queue-burndown-2026-10-02` to a local bare remote seeded with `origin/main`. Expect: blocked with 13 findings and a fingerprint; with that fingerprint set, accepted; the full gate never starts. Then confirm a non-archive push from the same worktree still runs the full gate.

## 6. Declined, accepted limits, and things found on the way

- **Not changed: `check`.** Whether ordinary pushes should also scan pushed content is a separate decision; per §1.3 it needs the same acknowledgement design or it blocks on fixtures. Raised for the user.
- **Resolved in the code audit: a broken lane no longer reverts to today** for an archive-looking push (§2.1, last row). It still does for an ordinary push, which is the point of the full gate.
- **Accepted v1 limit: acknowledgement fatigue.** Every archive push with fixtures needs one. Revisit trigger: acks become routine; then add a content-addressed allowlist of reviewed blob ids, not path or value heuristics.
- **Consumer hook** (`scripts/install-prepush-hook.mjs`, which has its own delete-only precedent) is not changed; consumers push archive refs too. Follow-up.
- **`core.hooksPath` points into a linked worktree** (§1.5). If that worktree goes away, git runs no hook and nothing says so. Worth its own task (a `doctor` probe that resolves the configured hooks directory).
- **`--no-verify` cannot be prevented**, only made unnecessary. The lane reduces the reasons to use it; it is not enforcement.
- **Not scanned: ref names, `refs/notes`, and anything not reachable from the pushed archive refs.**
- **Band-aid vs over-built.** The band-aid is `--no-verify` with a nicer name (a lane that runs nothing); the over-built version is a sandbox that runs a curated subset of `check` plus a value-heuristic suppression layer. This is the smallest thing that is a true function of the problem: archive refs publish commits, so scan exactly what is published, and let a person acknowledge exactly what was shown.

## 7. Audit trail

`/audit-plan`, session `audit-plan-1791743960` (2026-10-11), `--mode plan`.

| Reviewer | Round | Result | Disposition |
|---|---|---|---|
| GPT | 1 | NEEDS_REVISION, H:4 M:4 | 8 of 8 accepted and fixed: remote-tracking refs are not the destination (D4); path coverage separate from content (D3); fail-open fallback (D5, D8); exit status is not a protocol (§2.1); fingerprint identity; redaction by classification; executable classification (§3); resource bounds |
| GPT | 2 | NEEDS_REVISION, H:1 M:1 | 2 of 2 accepted and fixed: `--root` against `log.showRoot=false`; credential-safe diagnostics |
| GPT | 3 | NEEDS_REVISION, H:1 M:1 | 2 of 2 accepted and fixed: tag objects need the original tips; exhaustive accounting |
| Gemini | 1 | CONCERNS, blocking 3 | 3 of 3 accepted and fixed: roots and tips go to git on stdin (argument length); deletions contribute no tip; advertised tag ids stay the exclusion root |
| Gemini | 2 (cap) | CONCERNS, blocking 1 | Accepted and fixed in the plan: `--` before the destination, `=` form for the CLI flag. **Not re-reviewed**: the 2-round cap applies, and the fix is one line with its own test case |

Acceptance rate 100% in every round (no dismissals, deferrals or rebuttals); every finding was a concrete design defect, none was rigor pressure. The GPT cap (3) was reached while findings were still being accepted, which is why Gemini's two rounds followed. Finding count fell 8 → 2 → 2 → 3 → 1.

**Not reviewed**: the plan text after Gemini's round-2 fix; any implementation (none exists yet); and the one judgment the user should confirm, that the lane skips all of `check` rather than a subset (§3).

## 8. Implementation notes (2026-10-11)

Built as planned (§4). Deviations and findings, each from running the code rather than from the plan:

- **The hook finds its checkout by path arithmetic, not `git -C`.** `git` exports `GIT_DIR` into a hook's environment, which overrides discovery: `git -C "$HOOK_DIR" rev-parse --show-toplevel` would have answered with the *pusher's* checkout, silently defeating D7. `HOOK_ROOT` is `dirname "$0"` (backslashes normalised) plus `..`, resolved with `pwd -W` where Git Bash has it.
- **`git log --raw -z` puts a newline between a commit's header and its first entry** (`od -c`: NUL, newline, then the colon token). The first parser, written from the documented shape, skipped the first entry of every commit; four tests failed on it before it was fixed, and the `parseRawLog` unit fixture now carries the real shape. `--no-show-signature` was added to the same invocation for the same reason as `--root`: a config can otherwise change the output.
- **Mutation-checked, each seen to fail**: removing `--root` fails the `log.showRoot=false` test; removing `-m` fails the merge-only-path test; resolving the lane from the pusher's cwd fails both worktree-topology tests.
- **`.env.example` is a `sensitive` path** under the shared classifier (`(^|/)\.env(\..+)?$`), so a repo history that carries one produces a `path` finding. Not special-cased: the classifier is the single oracle, and the acknowledgement exists for exactly this. A full-history scan of an empty destination gave 780 findings in 25,272 objects, which is also why an empty destination is the honest "everything is published" case and not an error.
- **Live replay on the real case.** `archive/queue-burndown-2026-10-02` (`3c0afc4e`) against a local bare destination seeded with `origin/main`: 460 objects, 128 paths classified, 0 path findings, 14 secret findings (the 13 of §1.3, one blob counted per pattern), 0.5 s end to end. The printed fingerprint is the acknowledgement.
- **Pre-existing and unrelated**: `tests/prepush-installed-tree-identity.test.mjs` "records a subset of the root lockfile" fails in the main checkout at the same base commit, because that checkout's `node_modules` holds six packages (`braces`, `fill-range`, `is-number`, `micromatch`, `picomatch`, `to-regex-range`) that its lockfile does not declare. Machine state, not this change; the pre-push sandbox installs afresh when it detects a stale tree.

## 9. Code audit trail

`/audit-code`, session `audit-code-1791746397`, `--scope diff` (the implementation commit).

| Round | Result | Disposition |
|---|---|---|
| 1 | SIGNIFICANT_ISSUES, H:6 M:5 | 10 accepted and fixed, 1 dismissed. Fixed: `git replace` refs could hide content (`GIT_NO_REPLACE_OBJECTS`, seen red without it); a token in an ordinary filename was printed; an unreadable `::` record was skipped (now a parse error; the config-driven trigger the finding described did not reproduce); no subprocess deadline except `ls-remote`, and no check after the last batch (seen red without it); a 40-line list beside a whole-set fingerprint (cap raised to 200, none offered above it); a failed stdin read answered not-applicable; and **H5**, a broken lane reverting an archive-looking push to a gate that does not scan (now refused; see §2.1). Dismissed: M5, the adjacency wave reporting its own enumeration bound |
| 2 | PASS, H:0 M:0 | stable 1/2 |
| 3 | PASS, H:0 M:0 | stable 2/2, converged. Full-scope detector census: 0 detectors, nothing blocked |

**Not covered by the GPT passes**: `.githooks/pre-push` has no extension, so the file taxonomy classifies it as an unrecognised type and the code passes never read it (the audit said so: "1 of 8 changed source file(s) not fully audited"). The hook is therefore covered by its 29 behavioural tests (including a real `git push` from a linked worktree, two mutations seen red, and the bash-versus-oracle drift test) and by the Gemini final gate, not by the multi-pass audit.

**Gemini final review (code), round 1: APPROVE, gate `approve`** (0 blocking, 0 debt, 0 wrongly dismissed, 0 over-engineering flags). Its own qualifier: "Code: PARTIAL, changed lines unmeasured for 1 file", which is the extension-less hook above, so the approval is for the four `.mjs` files and the tests; the hook's coverage is the behavioural suite named above plus the self-review recorded in the PR.

**First full pre-push gate (2026-10-11): 18,703 of 18,747 passed, 2 failed, both mine, and neither showed up in the targeted runs.** The hook's fail-closed branch added a second `while read`, which `tests/prepush-sandbox-honesty.test.mjs` ("reads git stdin exactly once") caps at one; and two `fs.rmSync` calls in the new hook test lacked the `{recursive, maxRetries, retryDelay}` options `tests/rmsync-retry-guard.test.mjs` requires. Fixed by reading the captured copy with `awk` instead of a second loop (the invariant stays as written) and by hardening the calls. Lesson recorded: a targeted run of the tests named after your change is not a substitute for the suite, because the guards that catch you are named after the invariant, not the feature.

## 10. Adversarial review of the hook (2026-10-12)

The user chose an in-session adversarial review of `.githooks/pre-push` and the post-`daa78040` changes (no paid run). An independent agent was given the threat model and write access to scratch directories only, and told to demonstrate rather than assert. It reproduced one HIGH, one MEDIUM and three LOW defects, each with a script; **59 of 59 existing hook tests passed throughout**, so none was covered. All five are fixed, each with a test seen red on the old code.

| # | Finding | Fix |
|---|---|---|
| 1 HIGH | **Fail-open.** `parsePushLines` split on JS `\s` and demanded exactly four fields. A push of `HEAD^{/add backup}:refs/heads/archive/x` (the local field is a revision expression holding spaces) or a ref name holding U+00A0 was called malformed, the lane answered `not-applicable`, and the full gate (no scan) published a `.env` and a token. Reproduced with a real `git push` | Fields are found from the **right** (`sha ref sha`, the rest is the local ref) and split on ASCII space/tab only; the awk spelling uses `$(NF-1)`. A line the parser cannot read that mentions `archive/` is **refused**, never `not-applicable`. And a `not-applicable` token for a push the hook itself reads as archive-only is a **disagreement and is refused**, so parser drift can no longer fail open |
| 2 MEDIUM | Secrets the lane called clean: a JSON-escaped PEM (a GCP service-account file), a `# `-prefixed PEM, UTF-16 text (PowerShell `>`), `.npmrc` tokens, and credential stores with no secret-shaped name (`.git-credentials`, `.netrc`, `.pgpass`, `.pypirc`, `.htpasswd`, `*.keystore`, `*.jks`, `*.tfvars`) | Lane-local scan variants (NUL-stripped, escaped-newline-decoded, comment-prefix-stripped), bounded to bodies of 1 MiB or less so they cannot multiply the unbounded scan time; an `npm-token` pattern in `secret-patterns.mjs` and the credential-store paths in `sensitive-paths.mjs`, the shared oracles, so LLM egress benefits too. A generic `https://user:pass@host` pattern was **not** added: it is false-positive heavy in docs and the stores that matter are now caught by path |
| 3 LOW | The refusal branch defaulted to "do not refuse" when `awk` failed | `lane_looks_archive` returns 2 (could not tell) and the no-token branch refuses unless it is a positive "not archive" |
| 4 LOW | `CDPATH` set plus a relative `$0` made `cd` print the directory into `HOOK_ROOT`, so a healthy lane looked "not found" | `CDPATH= cd --` with output discarded |
| 5 LOW | The hook header still said "no valid token → run the full gate" | Rewritten |

Attacks that held (the reviewer's list): blob, tree and annotated-tag-of-blob tips; a stale remote-tracking ref; `git replace`; a secret only in a commit message; a secret added then deleted inside the pushed range; a `.env` reusing a blob the destination holds; CRLF, blank, tab-separated, duplicate and unterminated stdin lines; 3,000 refs; mixed pushes; relative remote URLs from a subdirectory; token forgery through the lane's stdout; a destination holding `=` or a leading `-`; a pre-set `PUSH_STDIN` or `LANE_*` variable. Not reproduced and not changed: sha256 repositories (the 40-zero deletion id never matches, which fails closed as `tip-not-commit`), a regex stall not being interrupted by the deadline (about 2 s per MB, no hang seen), a symlinked `$0` (fails closed as "script not found").

Lesson: the second review found a fail-open that two GPT rounds, a Gemini gate and 83 passing tests did not, in the one file the audit tooling could not read. A guard that decides "not mine, someone else will check" is the dangerous shape: here the "someone else" was a gate that does not scan.

### 10.1 The oracle changes, checked against the coordinator's three conditions (2026-10-12)

The review's fixes touched two shared oracles: `scripts/lib/sensitive-paths.mjs` (the single sensitive-path oracle; AGENTS.md Tier 3: a change lands with its test) and `scripts/lib/secret-patterns.mjs` (the deliberately gentle final-pass redactor, which must not grow blanket patterns).

1. **Own tests, same commit.** `a8d3845e` carried tests for both, but only in the lane's test files. The oracles' own files now carry them too: `tests/sensitive-paths.test.mjs` (positives at any depth, and negatives that must stay unclassified: `README.md`, a docs page merely named for netrc, `src/tfvars.mjs`, `terraform.tfvars.example`, `scripts/keystore-info.mjs`, …), `tests/sensitive-paths-canonical.test.mjs` (the new names are caught through a symlink too, with injected `fs`, so it runs on Windows), and `tests/secret-patterns.test.mjs`. Four mutations were each seen red (drop the path pattern, loosen the keystore pattern to swallow prose, drop the npm pattern, loosen it to drop its anchoring).
2. **Incident consultation** (`get-incident-neighbourhood` for both files): two records, neither mitigation-failing. INC-001 (a lexical classifier fooled by a symlink; `manual-verification-required`; path overlap) is the class the canonical test now covers for the new names; the change adds lexical patterns only and `resolveAndClassify` re-classifies the canonical target through the same list. INC-002 (a destructive DB suite) has no path overlap. The consultation also warned that `docs/security-strategy.md` was edited since the last `security:refresh`; that edit is not this change's.
3. **The npm-token pattern cannot match prose or hashes.** `\bnpm_[A-Za-z0-9]{36}\b` is anchored three ways (literal prefix, exactly 36 alphanumerics, a word boundary each side). The test lists eight negatives that all return no match: prose containing `npm_registry` and `npm_config_cache`, the `npm_config_*` / `npm_lifecycle_event` / `npm_package_version` / `npm_execpath` environment names, a 40-hex sha1, a 64-hex sha256, 35 and 37 characters after the prefix, `my_npm_` + 36 characters, and `mynpm_` + 36 characters.

Whether to audit the two oracle diffs with the paid GPT/Gemini pair is the user's call (they change egress for every consumer); the coordinator has recommended it.

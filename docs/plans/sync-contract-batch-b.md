# Plan: Sync contract batch (cluster B)

- **Date**: 2026-10-25
- **Status**: In progress - audit-plan 3 rounds (H2→M1→clean), Gemini APPROVE 2026-10-25
- **Author**: Claude (CES chip, cluster B of the 2026-10-25 backlog triage (plan doc not yet on main), §5)
- **Scope**: backend (sync / sync:pr / check-setup / upstream CLI; no UI, **no migrations**)

> **Target domain(s)**: `sync`, `install`, `upstream`, `tests`. Tier 3 seam (consumer sync contract): every change below lands with its test in the same commit.
> Pins: `file:line` anchors are at `ac94d9b6` (origin/main, 2026-10-25).

## 1. Context

Six fleet proposals share one seam: what the consumer sync and `sync:pr` say and do.
Re-verified against `ac94d9b6` before planning — two are narrower than their wording:

| id | Proposal says | What is actually there |
|---|---|---|
| d93e | print the exact install command; doctor FAIL not warn | The sync **already prints** the command (`formatUndeclaredBundleDeps`, `scripts/lib/install/bundle-deps.mjs:301`, `displayAddDev`). Missing: `check-setup.mjs` has **no** declared-bundle-deps check at all, so a consumer running the doctor sees nothing. |
| 689c | derive the lists | A lock-step test exists (`tests/sync-inventory-parity.test.mjs`) and the two lists are equal today. Still two hand-kept copies; the test only catches drift after the fact. |
| 2221 | stale vs customised | `findUnabsorbedSyncBase` covers *committed content equal to the recorded base sitting on a sync branch*. It does **not** cover *disk equals an OLDER upstream version* (not the recorded base) — the Copilot case. |
| da9a | skip-clean on stale | confirmed: `planConsumerPr` returns `CLEAN` from `classified.clean` alone (`scripts/lib/sync-pr.mjs:189`); nothing compares the manifest stamp to source HEAD. |
| a5ce | .gitignore left behind | confirmed: sync writes the managed block (`sync-to-repos.mjs:2333`) but `.gitignore` is not in `classified.syncOwned`; it sits dirty in the consumer. |
| 5bc2 | consumer-side close | confirmed: `upstreamTransition` requires `git rev-parse --verify <commit>^{commit}` in the *consumer* repo (`scripts/lib/upstream/commands.mjs:589`), where the CES commit does not exist. |

## 2. Design (smallest structurally-honest fix per item)

**D1 — d93e: `check-setup` FAILs on a missing/undeclared required bundle package.**
Reuse `assessDeclaredBundleDeps` (do not re-derive). In `check-setup.mjs` add `checkBundleDeps(report, repoPath)`: `measured:false` → `warn` naming the reason (never pass); `undeclared`/`optionalOnly` non-empty → `report.fail` with the assessment's own `command`; clean → `pass`. Source repo itself and repos with no synced tree: skipped with a stated reason, not passed. Band-aid refused: raising the sync's warning colour. Over-build refused: a new dep resolver.

**D2 — 2221: a diverged file that equals a PRIOR upstream version is not divergence.**
New pure `classifyAgainstUpstreamHistory({ diskHash, priorHashes })` plus impure `readPriorUpstreamHashes(sourceRoot, srcRel, {max})` in `sync-divergence.mjs` (walks `git log -n <max> --format=%H -- <srcRel>` of the SOURCE repo, hashes each blob with both LF and CRLF forms, mirroring `findUnabsorbedSyncBase`). `decideAction` gets a new input `vcs.priorUpstream` (boolean); diverged + `priorUpstream` → `WRITE` with reason `diverged-prior-upstream` (prose in `describeReason`: "equals an earlier upstream version — stale, not edited"). Fail-closed: any git error / shallow history / no match → `null` → today's refusal. Bounded and asked only for diverged paths. **Run-scoped resolver (audit R1 M2):** `createPriorUpstreamResolver({sourceRoot, perPathMax: 100, totalBudget: 2000})` is built once per sync run; it lists history with ONE `git log --format=%H --raw` per source path, batches blob reads through a single `git cat-file --batch` process, and caches `blobOid → {lfHash, crlfHash}` across paths. When `totalBudget` blob reads are spent, every later path returns `null` (today's refusal) and the run prints one line saying the lookup budget was exhausted. Test: an instrumented git adapter over 100 diverged paths asserts batching (≤ 1 `cat-file` process), cache reuse (shared blob read once) and the budget cut-off.

**D3 — da9a: `sync:pr` must not read "clean" as "up to date".**
Pure `classifyBundleFreshness({ stamp, sourceSha, sourceDirty })` → `current | different | unverified` (audit R1 M1), decision table:

| stamp | sourceSha | source tree | outcome |
|---|---|---|---|
| not 40-hex (missing, short, malformed) | any | any | `unverified` |
| 40-hex | not 40-hex / unreadable | any | `unverified` |
| equal | equal | dirty | `unverified` (a matching HEAD stamp does not prove equal content) |
| equal | equal | clean | `current` |
| differs | valid | any | `different` — never "behind" (no ancestry is verified; it may be ahead or divergent) |

`sync-pr.mjs` resolves `sourceSha` (`git rev-parse HEAD` of SOURCE_ROOT) and `sourceDirty` (`git status --porcelain` non-empty) and passes them in; abbreviated stamps are NOT expanded (the sync writes full shas; a short one is `unverified`). On `CLEAN`: `current` → `CLEAN` unchanged; `different` → new skip reason `CLEAN_BUNDLE_DIFFERS` ("no synced changes on disk, but the bundle stamp <x> differs from source <y> — run `npm run sync -- --target <name>` first"); `unverified` → `CLEAN_UNVERIFIED` ("could not verify the bundle is current"). Exit code unchanged (skip, not error); only the line differs.

**D4 — a5ce: `sync:pr` includes the managed `.gitignore` block change.**
New pure `classifyGitignoreTransition(headText|null, workText)` in `sync-gitignore.mjs`, built on the canonical `parseGitignoreState`/`updateManagedBlock` (no second parser; audit R1 H2). Complete contract:

| HEAD `.gitignore` | working tree | outcome |
|---|---|---|
| exists, one well-formed block | same, block differs, rest of file byte-identical | `block-only` → rides in the PR |
| exists, **no block** | block inserted, rest byte-identical (first install) | `block-only` |
| **absent from HEAD** (path missing, git answered "no such path") | file whose entire content equals `updateManagedBlock('', block)` — i.e. only the managed block | `block-only` (new file) |
| absent from HEAD | anything else | `mixed` |
| any | malformed / duplicate / orphan markers on either side | `invalid` |
| any | rest of file differs | `mixed` |

`mixed`/`invalid` → NOT committed; listed under `leftBehind` with the reason. Reading HEAD distinguishes "missing path" (`git cat-file -e` exit 1/128 + `ls-tree` empty → `null`) from a git/read failure (→ `unverified`, listed under `leftBehind`, never swallowed). `sync-pr.mjs` passes `gitignoreTransition` to the planner; only `block-only` adds `.gitignore` to `addPaths`/`commitPathspecs`/`surface`. Both directions covered: block-only rides; block + hand edit is held back and named.

**D5 — 689c: one list.**
Move `CORE_ENTRY` (importable + non-importable halves), `DEBT_ENTRY`, `LEARNING_ENTRY`, `ARCH_ENTRY`, `SYNC_ISOLATION_ENTRY` to a leaf module `scripts/lib/sync-entry-lists.mjs` (no path arithmetic, no imports); both `sync-to-repos.mjs` and `sync-inventory.mjs` import it. Existing parity test is kept but re-pointed to assert both consumers expose the *same object identity*, plus a negative control (a list edited in only one place cannot exist). Order of `sync-to-repos` `CORE_ENTRY` is preserved (spread of importable then non-importable is asserted equal to today's array in a golden test before the move).

**D6 — 5bc2: consumer-side close verifies the commit against the upstream remote.**
The existing invariant is KEPT (requirement `REQ-correctness-2f2c1d39`: the stored commit resolves to a commit object in THIS repo's object database — remote existence is a weaker guarantee; audit R1 H1). In `upstreamTransition`, when local `rev-parse` fails and `commit` is hex ≥ 8 chars and the synced manifest names an upstream `repo` (`owner/name`, validated against `^[\w.-]+/[\w.-]+$`): (1) resolve the full OID via injected `resolveUpstreamCommit(repo, sha)` (default `gh api repos/<repo>/commits/<sha> --jq .sha`; output validated as 40-hex, else fail); (2) fetch that object into the current repo with a plain `git fetch --no-tags <https://github.com/<repo>.git> <oid>` through injected `fetchObject` — deliberately **no `--depth`/`--filter`** (audit R2 M1: a depth fetch writes `.git/shallow` and turns a complete consumer repo shallow; a filter adds promisor config). It writes objects and `FETCH_HEAD` only; HEAD, the index, the working tree, refs, config and shallow state are untouched (the cost is the upstream history objects, accepted for a one-off close); (3) re-run `rev-parse --verify <oid>^{commit}` locally and persist the **full OID** only if it now succeeds. Any step failing → the existing `BAD_INPUT` naming the failed step, **nothing written**. Tests: injected-resolver unit cases for each failing step, plus a real temp-repo test (a bare "upstream" repo, a consumer repo, `fetchObject` pointed at the file path) proving the object appears locally, HEAD/index/refs/config unchanged, `rev-parse --is-shallow-repository` still `false` and `.git/shallow` absent, and the transition stores the full OID.

## 3. File-level plan

| File | Change |
|---|---|
| `scripts/lib/install/bundle-deps.mjs` | none (reused) |
| `scripts/check-setup.mjs` | D1 `checkBundleDeps` wired in the main check sequence |
| `scripts/lib/sync-divergence.mjs` | D2 helpers + `decideAction`/`describeReason` branch |
| `scripts/sync-to-repos.mjs` | D2 pass `priorUpstream`; D5 import lists |
| `scripts/lib/sync-pr.mjs` | D3 reasons + `sourceSha`; D4 `.gitignore` surfacing |
| `scripts/sync-pr.mjs` | D3 pass `sourceSha`; D4 read HEAD/work `.gitignore`; wording of skip lines |
| `scripts/lib/sync-gitignore.mjs` | D4 `isManagedBlockOnlyChange` |
| `scripts/lib/sync-entry-lists.mjs` (new) | D5 |
| `scripts/lib/sync-inventory.mjs` | D5 import lists |
| `scripts/lib/upstream/commands.mjs` | D6 |
| tests | `check-setup-bundle-deps.test.mjs` (new), `sync-divergence.test.mjs`, `sync-pr.test.mjs`, `sync-gitignore` cases, `sync-inventory-parity.test.mjs`, `upstream-commands` cases |

New module `sync-entry-lists.mjs` joins the bundle closure automatically (imported by `sync-inventory`, which is synced); `sync-path-map.mjs` stays the layout oracle (untouched).

## 4. Testing (Tier 3 — same commit)

Each item: a red-then-green test on the pure decision **and** one assertion on a real temp git repo where git facts matter (D2, D4, D6 resolution fallback uses an injected resolver; D4 uses real `git init`).
Negative controls (must NOT fire): D2 disk equals neither base nor any prior version → still refuses; D2 shallow/failed git → refuses; D3 matching stamp → still `clean`; D4 `.gitignore` with an out-of-block hand edit → not committed, listed in `leftBehind`; D1 repo with all deps declared → pass; D6 unresolvable sha → BAD_INPUT and nothing stored.
`npm test` whole suite before first push (memory: run whole suite before first push).

## 5. Risks

- D2 widens what the sync overwrites without consent. Bounded to *byte-identical to an earlier upstream blob of the same source file*; nothing a consumer typed can match unless they reverted to upstream. Fail-closed on any git doubt.
- D4 touches a consumer file the consumer owns; mitigated by the block-only predicate.
- D5 is a refactor of the closure input: golden test pins `getSyncClosure` output before/after for every consumer.
- Consumers are unobservable: after merge, `npm run sync:dry` from an up-to-date checkout shows no unexpected delta; no migrations; no hook change.

## 6. Implementation phases (single cluster, below §11 threshold)

1. D5 (pure move, golden-pinned). 2. D3. 3. D4. 4. D2. 5. D1. 6. D6. Close-out: `npm run skills:check`, docs note in `docs/runbooks/consumer-adoption.md` §Diagnostics (one paragraph).

## 7. Out of scope

Pre-push hook, final-review, anthropic-client (clusters A/C/D/E). `degraded` classification, receipt rotation, `sync-path-map` layout.

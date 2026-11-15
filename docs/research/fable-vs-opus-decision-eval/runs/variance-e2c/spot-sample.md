# Spot sample — variance-e2c

Blinded. For each response, read the question and the correct decision, then the response,
and write **Y** (reaches the correct decision) or **N** in the table at the end.
The judge labels sit in a collapsed block AFTER the marks table: do not open it until every row is filled.

## 1. `917f54e5` — case `sdk-pin-max-tokens-review`

**Question.** Review this pin change as a coordinator deciding whether PR #360 is safe to merge at this step. The code at each moved site is described as otherwise unchanged: is that enough to conclude the pinned sites still behave correctly? State your verdict on the change, what you would check or change before merge, and what the coordinator should do next.

**Correct decision.** Not safe as is: the pin changes max_tokens semantics from accepted-and-ignored (cli) to enforced (sdk), and with a model that spends output on a thinking block a 64-token cap leaves no text block, while content[0].text reads the wrong block, so labels silently become underived (100% failure hidden by graceful degradation). Re-measure every cap at the moved sites, read the first text block via one helper at the seam, and surface stop_reason when no text arrives.

<details><summary>Response</summary>

> # Review of PR #360, step a4697858 ("throw and pin")
> 
> ## Short answer
> 
> No. "The code at each moved site is otherwise unchanged" does not show the sites behave the same. The pin changes the transport, and the transport changes what the unchanged code means. The clearest case is `max_tokens`.
> 
> ## Why "unchanged code" is not "unchanged behavior"
> 
> - **The caps were never enforced locally.** On the `cli` backend, `max_tokens` is accepted and ignored. The adapter's own warning records a measurement: 1995 output tokens returned against `max_tokens: 200`. The maintainer's machine ran `cli` ambiently, so every site that never named a backend ran with no output ceiling there.
> - **The pin turns them on.** Under `{backend:'sdk'}`, params go to the Messages API as given, and the API enforces `max_tokens`. The pin quietly activates caps that were dead code everywhere live calls actually ran. CI runs `sdk`, but nothing provided shows CI making live calls at these sites, so CI is no evidence the caps fit either.
> - **Nothing checks for truncation at these sites.** A capped response comes back as a normal success with `stop_reason: 'max_tokens'`. None of the moved sites shown reads `stop_reason`.
> 
> Every audit round so far looked at the throw, the gate and the availability oracle. None looked at what the moved call sites now send to a backend that honours every param.
> 
> ## Site by site
> 
> **Work-unit labels** (`max_tokens: 64`, `latest-[model]` → `[model]-[model]-5-5`)
> - 64 tokens is ample for a 3–8 word name if the model complies. A preamble or a markdown-wrapped reply could still be cut off.
> - A cut-off reply is the worst case here:
>   - `return res?.content?.[0]?.text` passes the fragment through.
>   - `sanitizeLabel` may accept it.
>   - The fragment is then `putCached` under `CACHE_TTL_MS` and labelled `labelSource: 'llm'`.
>   - The "successes only (C10)" cache rule cannot tell a truncated label from a real one, so a bad name persists for the full TTL.
> - Reading `content[0]` alone also assumes the first block is text. Under `sdk`, a non-text first block yields `null`, which shows up as `underived`. That is benign, but it is untested.
> 
> **Judge** (`latest-[model]`, `max_tokens: 4000`)
> - It must return a JSON object scored on every rubric dimension. On `cli` that output was effectively unbounded. On `sdk`, 4000 tokens now binds.
> - If a large rubric or verbose reasoning exceeds it:
>   - the JSON is truncated;
>   - `extractJsonObject` fails;
>   - the call returns `conformant: false, 'judge returned no JSON'`.
> - That is the same symptom the pin comment says it fixed ("scoring its own transport failures as `conformant: false`"), now from a different cause. It is also indistinguishable from a genuinely nonconforming judge. The judge's rows feed cross-arm comparisons, so this is a measurement-integrity risk, not just an availability one.
> 
> **Refine-prompts** (`max_tokens: 2000`) and **brief condense** (cap not shown)
> - Same class of risk. A truncated refinement suggestion or brief would be consumed as complete.
> 
> **The two census-only sites** (`evolve-prompts.mjs` via `llm-wrappers.callClaude`, `solo-control-audit.mjs` via `runPass`)
> - Their diffs are not in the evidence. Their caps and truncation handling are unreviewed.
> - `solo-control-audit` is the spend-bearing harness that compares arms. Any arm whose earlier rows were recorded as `cli(default)` ran without enforced caps. Rows from before and after the pin are therefore not on the same contract. That is a comparability break beyond the backend label.
> 
> ## What the evidence establishes and what it doesn't
> 
> **Established:**
> - `max_tokens` is unenforced on `cli`, and this was measured.
> - These sites pass `system`, so the seam now throws on `cli`, and they are pinned to `sdk`.
> - `sdk` forwards params as given.
> - The preflight run and the negative controls cover the throw, the gate and the oracle.
> 
> **Not established:**
> - Whether any cap is adequate for the model it now resolves to. The `latest-*` sentinels drift.
> - Whether any site has ever produced a truncated output under `sdk`.
> - How each site behaves on `stop_reason: 'max_tokens'`.
> - That the 2595 tests exercise a real capped response. They almost certainly mock the client.
> 
> ## What I would check or change before merge
> 
> 1. **Live `sdk` smoke per moved site (all six).** Run representative inputs, including the largest realistic judge rubric. Record `usage.output_tokens` against `max_tokens` and `stop_reason`. Size the caps from that data, with headroom.
> 2. **Handle truncation explicitly at every site:**
>    - Labels: `stop_reason === 'max_tokens'` counts as `failed` and is not cached.
>    - Judge: return a distinct error (`'judge output truncated at max_tokens'`) so it is not confused with nonconformance.
>    - Refine and brief: treat as failure or fall through.
> 3. **Make label extraction robust.** Join or find text blocks, as the judge already does, instead of reading `content[0]`.
> 4. **Add a negative control in the style the PR already uses.** A mocked `sdk` response with `stop_reason: 'max_tokens'` and a plausible fragment must not be cached and must not be marked `llm` or `conformant`.
> 5. **Mark the arm-eval and solo-control provenance boundary.** Rows recorded as `cli(default)` before this change should not be pooled with post-pin `sdk` rows without a note.
> 6. **Note the billing shift.** Locally, these sites now bill the API key rather than the CLI subscription. This is intended, but the maintainer should know before running the judge or the harness at volume.
> 
> ## Coordinator next steps
> 
> - Hold the merge. Request a narrow follow-up commit on #360 covering items 1–4, plus a reviewer pass on the two census-only sites' diffs.
> - Raise a standing review rule: any change of transport or backend at a call site is a behaviour change. The review must list which params the new backend honours that the old one ignored, or the reverse.
> - The throw-and-pin design and the gate are sound and should stay as they are.
> 
> ## Decision
> 
> **Not safe to merge at this step as is. Approve the design, block on a cap and truncation audit of the pinned sites.**
> 
> The pin moves sites from a backend where `max_tokens` is ignored to one where the API enforces it. The adapter documents this: 1995 tokens returned against a cap of 200 on `cli`. So caps that never bound during local live use now bind, and the "otherwise unchanged" code was never validated against them. None of the moved sites shown checks `stop_reason`.
> 
> The two consequences that matter:
> - The labeller can cache a truncated name as a successful `llm` label for the full TTL.
> - The 4000-token judge can emit truncated JSON that is recorded as `conformant: false`. That is indistinguishable from real nonconformance and corrupts cross-arm comparisons, which are also affected by the `cli(default)` → `sdk` provenance break in `solo-control-audit`.
> 
> Merge once each of the six sites has:
> - a measured `sdk` output size,
> - a cap sized from that measurement,
> - explicit `max_tokens`-truncation handling,
> - a negative control proving truncated output is neither cached nor scored.

</details>

## 2. `c78a9e95` — case `check-ignore-ci-cause-string`

**Question.** Diagnose this CI-only failure, where a test pinned to one cause string in a degraded-scan warning sees a different cause string on the runner than it does locally and on main. Decide whether to re-run it as a flake, loosen or retarget the assertion, or change the code, and say what the code should report. Give your decision and the next steps, including who is affected.

**Correct decision.** A real race, not a flake: git check-ignore --stdin outside a work tree exits 128 without reading stdin while spawnSync is still writing, so the parent sees either status 128 or EPIPE depending on platform/load. Fix the cause reporting in code (a non-zero status other than 0/1 wins over the write error; a write error with status 0/1 keeps its own code) and leave the test unchanged; the loud degradation held either way. Not a re-run and not a loosened regex.

<details><summary>Response</summary>

> # Diagnosis: `prepush-hook-v18` reports EPIPE instead of exit 128 on ubuntu CI
> 
> ## What the evidence shows
> 
> **The failure is in the cause string, not the degradation.** The ubuntu child did everything else right:
> - It detected the degraded scan.
> - It printed the WARN line.
> - It still extracted the symbol.
> 
> Only the parenthesised cause differs: `(EPIPE)` instead of `(git exit 128)`. The test also checks `/128/.test(l.warning)` on the wire `ownership` line, so it would have failed there too.
> 
> **The code explains how EPIPE gets there:**
> 
> ```js
> const ign = git(['check-ignore', '-z', '--stdin'], nulList);   // query sent on stdin
> if (ign.error || (ign.status !== 0 && ign.status !== 1)) {
>   ... `(${ign.error ? ign.error.code || ign.error.message : `git exit ${ign.status}`})`
> ```
> 
> In a non-git directory, `git check-ignore` fails at repository discovery ("fatal: not a git repository", exit 128) and never reads stdin. `spawnSync` then writes `nulList` into a pipe whose reader may already be gone:
> - If git exits before Node writes, the write fails with EPIPE.
> - `spawnSync` then returns both `status: 128` and `error: {code: 'EPIPE'}`.
> - The ternary checks `ign.error` first, so the secondary transport error hides git's real answer.
> - If Node's write lands first, `error` is unset and the message says `git exit 128`.
> 
> This is a timing race between git's startup and failure and Node's stdin write. That fits the observations:
> - It passed in main's last full-suite run.
> - It passes on the author's Windows machine, where pipe semantics and `git.exe` startup timing differ.
> - It failed here on ubuntu.
> - The code is byte-identical on main, so main carries the same latent defect.
> 
> **What the evidence does not establish:**
> - I have not seen the raw `spawnSync` result showing `status: 128` alongside `error.code === 'EPIPE'`. That is inferred from the code path and the documented "128 = not a work tree" cause.
> - I don't know exactly why Windows never hits it.
> - One green main run doesn't tell us how often it fails on Linux.
> 
> These are cheap to confirm (see below). None of them changes what the fix should be.
> 
> ## Choosing among the options
> 
> **Re-run as a flake: no.** A re-run would probably go green and merge a suite that is known to be racy. The race is real behaviour of shipped code, not test-harness noise.
> 
> **Loosen or retarget the assertion to accept EPIPE: no.** The test pins the cause the module's own docstring promises ("128 = not a work tree"). Accepting EPIPE would bless a misleading diagnostic. "EPIPE" points an operator at a transport problem when the true cause is "this is not a work tree".
> 
> **Change the code: yes.** The `degraded` flag is already correct, so no scan is ever presented as verified. The defect is purely in what gets reported as the cause.
> 
> ## What the code should report
> 
> Give git's exit status precedence over a stdin write error. Treat `error` as the cause only when there is no status.
> 
> | Spawn result | Report |
> |---|---|
> | `status` is a number other than 0/1 | `git exit ${status}`, plus the first line of `ign.stderr` (e.g. "fatal: not a git repository"). Optionally append "(stdin: EPIPE)" as secondary detail. |
> | `status === null` (ENOENT, ENOBUFS kill, signal/timeout) | `error.code \|\| error.message`, as today. ENOBUFS still reports ENOBUFS, because the killed child has a null status. |
> | `status` is 0/1 and `error` is set (e.g. EPIPE because git did not consume all input) | Keep `degraded: true`, report the error code. The answer may cover only part of the query, so it must not be trusted. |
> 
> Do **not** bump `OWNERSHIP_RULE_EPOCH`. What counts as disowned is unchanged; this is a diagnostic-text fix only, and a bump would force a needless full re-walk on every consumer.
> 
> ## Next steps
> 
> 1. **Confirm the race.**
>    - Loop the subtest 50 times on Linux (container or WSL) and log `ign.status` and `ign.error`. Expect intermittent EPIPE alongside 128.
>    - Check recent full-suite history for earlier intermittent failures of this file.
> 2. **Add a deterministic regression test.** Run `ignoredUntrackedPaths` in a non-git temp dir with candidates totalling well over the 64 KiB pipe buffer (for example, 1 MiB of paths). Node's write is then guaranteed to hit EPIPE after git exits.
>    - Assert `degraded === true` and that `warning` matches `git exit 128`.
>    - This fails today on Linux every time, not by chance, and passes after the fix.
> 3. **Land the fix to main in a small dedicated PR**, since main has the defect too. Then rebase #359. #359 will still be red from `tests/skill-command-blocks-parse-under-powershell.test.mjs`, which needs its own diagnosis.
> 4. **Propagate through the sync.** Consumers receive the file at `scripts/.[model]-skills/lib/disowned-paths.mjs`.
> 
> ## Who is affected
> 
> - **Upstream:** PR #359 is blocked, and any PR or main run can fail intermittently on ubuntu.
> - **Consumers on Linux/macOS running the extractor or doctor outside a work tree** (temp dirs, scratch roots) intermittently get a misleading `(EPIPE)` cause. Their `degraded` flag is still correct.
> - **Anything that pattern-matches the cause** is affected: the extract wire's `ownership.warning` and any consumer tooling keyed on "128".
> - **`debt-ledger.mjs`** (`warnOnDegraded: false`, branches on `degraded`) is functionally unaffected.
> 
> ## Decision
> 
> Change the code; don't re-run and don't loosen the test.
> 
> The failure comes from a stdin-write race in `ignoredUntrackedPaths`. Git exits 128 in a non-git root without reading stdin. Node's input write can then fail with EPIPE, and the warning builder prefers `ign.error` over `ign.status`, so the true cause is replaced by a transport artefact.
> 
> The evidence for this:
> - The CI output shows the correct degradation with only the cause string wrong (`EPIPE` vs `git exit 128`).
> - The code shows `--stdin` input plus error-first precedence.
> - The pattern of passing on Windows and on main's last run but failing on ubuntu matches a timing race.
> 
> The fix:
> - Report `git exit <status>` (with git's stderr line) whenever a status exists.
> - Reserve `error.code` for spawn failures with a null status.
> - Keep `degraded: true` in every non-clean case.
> - Prove it with a test that uses input larger than the pipe buffer.
> - Don't bump the ownership epoch.
> - Ship it to main first, then rebase #359.
> 
> The fix reaches consumers through the synced `lib/disowned-paths.mjs`; the affected consumer paths are listed above.

</details>

## 3. `b3455ebe` — case `disposable-db-guard-predicate`

**Question.** Both guards have just been shown to be inert against the database they exist to protect. Decide what the guards should test and why, what else in `assertDisposableDbUrl` (if anything) needs to change as part of the same fix, whether any bypass should exist, and what to do about the fixture that was just regenerated. Give your decision, the reasoning, and the verification you would require before calling it fixed.

**Correct decision.** Do not extend the hostname denylist. Replace it, in the one shared predicate both guards call, with a test of what "disposable" means: an allowlist of loopback hosts, so any unrecognised host is presumed to be somebody's real database and the guard cannot rot when the store moves again. Make the production-identity check compare host+port+database rather than DSN strings, give the guard no environment-variable bypass, prove it red-then-green on dangerous inputs with the legitimate container DSN as the vacuous-pass control, and regenerate the fixture from a fresh migration replay, not the dump-restored store.

<details><summary>Response</summary>

> # Both database guards test whether the host is Supabase, not whether the database is safe to use
> 
> ## What the evidence establishes
> 
> **The predicate stood in for something else.** `isHostedSupabaseHost` answers "is this hostname under `.supabase.co` or `.supabase.com`?" Both guards use that answer to mean "is this production?" The docstring states the premise outright: the shared Supabase project is "this repo's one and only production database". That premise stopped being true this morning. Production is now a LAN address on a non-default port. The suffix regex can never match it, so both guards are inert against it. This is a failed premise, not a bug in the regex.
> 
> **The tests could not catch it.** The tests pass because they pin exactly the Supabase hosts. Not one of them asks "is a non-Supabase production URL refused?"
> 
> **It already caused a near miss.** The fixture generator ran against the new production store, printed no refusal, and wrote a fixture.
> 
> **The generator's concern is wider than "is this production".** Its real requirement is "a database freshly built by replaying migrations into vanilla Postgres." The new store is vanilla Postgres, yet it still produced a wrong fixture. Dump/restore renumbered `attnum` past dropped-column tombstones, so 9 `ordinal_position` values in `refresh_runs` changed. So "not Supabase" was never sufficient for the generator. Supabase was just the only way it had gone wrong before.
> 
> **`assertDisposableDbUrl` has a second weak layer.** Its production-identity check is `testUrl === productionUrl`, raw string equality. Its own docstring describes the 2026-07-14 incident as the test URL being "set to (or resolved to the same database as)" production. String equality cannot detect "resolved to." Any of these make two URLs for the same database compare unequal:
> - different credentials;
> - `postgres://` vs `postgresql://`;
> - an explicit vs implicit `:5432`;
> - extra query params;
> - `localhost` vs `127.0.0.1`.
> 
> The check is also skipped entirely when a caller omits `productionUrl` (the default is `null`).
> 
> ## What the evidence does not establish
> 
> - **Whether `AUDIT_DB_TEST_URL` anywhere now points at the new store.** This covers local shells, `.env` files and CI secrets. I have no evidence either way. If it does, the destructive suites would `DROP SCHEMA public CASCADE` on production today, with no guard stopping them.
> - **What host CI's postgres-parity service container is reached at.** It could be `localhost` or a service hostname such as `postgres`. This decides whether a loopback allowlist breaks CI.
> - **Whether both suite callers actually pass `productionUrl`, read before the swap.** The excerpt shows the parameter but not the call sites.
> - **Whether anything other than these two callers relies on the predicate, or does destructive work keyed off `AUDIT_DB_URL`.**
> - **Whether the generator run against production was strictly read-only.** Presumably it only reads the catalog, but I haven't seen the code.
> - **Whether the old Supabase project still holds live data.**
> 
> ## Immediate containment, before any code change
> 
> 1. Audit `AUDIT_DB_TEST_URL` in every environment (developer machines, `.env*`, CI secrets) and confirm none of them resolves to the new store.
> 2. Discard the regenerated fixture with `git checkout -- tests/fixtures/expected-schema.json`. Do not commit it, stash it, or "fix up" those 9 values.
>    - The committed fixture stays the ground truth.
>    - To confirm it, run `npm run db:local:regen` and check for a zero diff, or compare against CI's `live-schema` artifact.
>    - Also note that production now diverges from a fresh migration replay in `ordinal_position`. Any future check that compares production to the fixture will report this as drift, and that is expected.
> 
> ## The fix
> 
> **1. Flip both guards from a denylist to a fail-closed allowlist.** Replace `isHostedSupabaseHost` as the deciding predicate with a shared `isDisposableDbUrl(url)`, a new name so nobody keeps reading it as "is production." It accepts only:
> - loopback hosts: `127.0.0.1`, `localhost`, `[::1]` (note that Node's `URL.hostname` keeps the brackets on IPv6);
> - with no `host` or `hostaddr` query parameter, because libpq and pg-connection-string honour those, so `postgres://127.0.0.1/db?host=10.x.x.x` would otherwise pass and connect to production;
> - with a non-empty hostname, because an empty host falls back to `PGHOST` or a Unix socket, which could be production on the production box.
> 
> Everything else is refused, including RFC1918 addresses. This matches the repo's stated design that a disposable database "is a local/container Postgres." The `npm run db:local` URL (`127.0.0.1:5432`) passes unchanged. If CI reaches its service container by service name, add that one hostname to the in-code allowlist after checking the workflow file.
> 
> **2. Keep the Supabase suffix check as a separate denylist** so the specific, explanatory error message survives. It is no longer what makes either guard safe.
> 
> **3. Add a server-side marker check before any destructive operation or fixture read.** A loopback URL is still only a property of a URL. An SSH tunnel or port-forward to the LAN store on `127.0.0.1:NNNN` would pass the allowlist.
> - At provision time, `db:local` and CI set a database-level marker that survives `DROP SCHEMA public`, for example `ALTER DATABASE postgres SET app.disposable = 'on'`.
> - After connecting, both guards require `current_setting('app.disposable', true) = 'on'` before doing anything else.
> - Production never has the marker, so this asserts the identity of the database itself, which is what the URL checks were standing in for.
> - This depends on confirming the CI provisioning step can set the marker; I'd ship it in the same change if it can.
> 
> **4. Repair the production-identity check in `assertDisposableDbUrl`:**
> - Compare normalized identities (lowercased host, port defaulted to 5432, database name), not raw strings.
> - If `productionUrl` is missing, read `process.env.AUDIT_DB_URL` itself, or throw. Do not silently skip the check.
> - Verify both suites call it before the `AUDIT_DB_URL = AUDIT_DB_TEST_URL` swap.
> 
> **5. Narrow what the generator reads.** It should stop reading `AUDIT_DB_URL`, the production variable, as its input. Make it take its target from the disposable path (what `db:local:regen` provides) and apply the same `isDisposableDbUrl` check plus the marker check. Reading the production variable by default is why this keeps happening.
> 
> **6. Correct the documentation.** Update the predicate docstring, the `assertDisposableDbUrl` docstring and error text ("exactly one Supabase project, and it is always production"), and the AGENTS.md invariant ("rejecting a Supabase-hosted or production-identical test URL") so they state the new rule and record today's incident.
> 
> ## Bypass: none
> 
> Neither guard gets a bypass flag or environment variable.
> - The 2026-07-14 wipe came from a single environment variable silently doing the wrong thing. An override variable would be the same failure mode waiting in someone's shell profile.
> - The generator already documents its legitimate alternatives: `db:local:regen`, or CI's `live-schema` artifact.
> - Widening what counts as disposable means a reviewed code change to the allowlist. It must never be a runtime switch.
> 
> ## Verification required before calling it fixed
> 
> - **Unit tests for `isDisposableDbUrl`:**
>   - Accepts loopback hosts on any port, in any case.
>   - Rejects:
>     - the actual new production URL shape (LAN IP, non-default port);
>     - arbitrary RFC1918 and public hosts;
>     - both Supabase suffixes;
>     - an empty host;
>     - `?host=` and `?hostaddr=`;
>     - invalid URLs.
> - **Identity-normalization tests:** credential, scheme, port and query-param variants of the same database are treated as identical. A missing `productionUrl` is not silently skipped.
> - **Refusal tests:**
>   - Run the generator with `AUDIT_DB_URL` set to the production DSN. It must exit 2, write no file, and refuse before `getPool()`. Confirm the pre-connect refusal in code order or by a test double, not by connecting.
>   - Exercise the destructive-suite guard in isolation with the production DSN. Never run the suite itself as the test.
>   - Test the full suite against a decoy: a throwaway container on a non-loopback address must be refused.
> - **Marker test:** a loopback database without the marker must be refused.
> - **Positive path:**
>   - `npm run db:local` followed by both integration suites passes.
>   - `npm run db:local:regen` reproduces the committed fixture with zero diff.
>   - CI postgres-parity is green, which proves the CI host and marker pass.
> - **Callers and docs:** a grep confirms no remaining caller uses the old predicate as a production test and no other destructive path keys off `AUDIT_DB_URL`. AGENTS.md and the runbook are updated.
> 
> ## Decision
> 
> **What the guards test.** Both guards should stop asking "is this Supabase?" and fail closed unless the target is provably disposable. That means:
> - a loopback host with no `host`/`hostaddr` overrides and a non-empty hostname, from an in-code allowlist (plus CI's service hostname only if the workflow file requires it);
> - plus a database-level disposable marker checked after connecting.
> 
> The Supabase denylist stays only for its error message.
> 
> **Why.** The evidence is direct. The predicate's own docstring rests on "Supabase is the only production database." This morning's cutover made that false. The generator then ran against production unrefused, and its output was caught only by chance.
> 
> **Changes inside `assertDisposableDbUrl` in the same fix.** Its `testUrl === productionUrl` string equality cannot catch the "resolved to the same database" case its own incident describes. It becomes a normalized host/port/database comparison that is mandatory, not skipped when `productionUrl` is null.
> 
> **Generator input.** The generator stops reading `AUDIT_DB_URL` as its input. Today's dump/restore drift shows "not Supabase" was never the condition it actually needed.
> 
> **Bypass.** None, for either guard. The allowlist changes only by reviewed code.
> 
> **The regenerated fixture.** Discard it, keep the committed fixture, and confirm the committed one with a zero-diff `db:local:regen`.
> 
> **First action.** Before any of this lands, audit every `AUDIT_DB_TEST_URL` value against the new store. No guard currently protects it.

</details>

## 4. `39dfdd7f` — case `windowed-views-consumer-path-review`

**Question.** Review this change before it merges. List the defects you would block on, ordered by impact, each with the evidence in the code shown and how you would verify it without waiting for a consumer to hit it; then list what you checked and found sound. Do not rewrite the feature; say what must change.

**Correct decision.** Block the merge on two defects that cannot show in this repo and one that CI would catch. (1) SELF_REPO climbs three directories from the module, which is the repo root only in the source layout; in a consumer the module sits one directory deeper, so it resolves to the consumer's scripts directory and readManifest can never find the declaration. (2) Even resolved correctly, .windowed-views.json is read by path at runtime, is not importable, and is in neither CORE_ASSETS list, so the sync never ships it and a consumer has nothing to read. The consequence of both is that every queue chip loses its delta in a consumer (the unreadable case suppresses all five queues, including the ones that are not windowed). (3) Adding an asset is two edits: the hand-maintained sync-inventory mirror must change in lock-step or its parity test fails. The existing repo-root helper that is correct in both layouts should replace the arithmetic.

<details><summary>Response</summary>

> # Review: PR #351, `collect-home-queues.mjs` windowed-trend suppression
> 
> ## Summary
> 
> The trend logic is correct. The way it finds its declaration is broken in every consumer, and it breaks twice over:
> 
> - The manifest is not shipped.
> - Even if it were, the code looks for it in the wrong directory.
> 
> Because the design fails closed, the result is not a crash. Every consumer would silently lose the trend on **every** queue, including the non-windowed ones. The author's tests pass because both faults only show up in the consumer layout.
> 
> ---
> 
> ## Blocking defects (ordered by impact)
> 
> ### B1. `.windowed-views.json` is not shipped to consumers
> 
> **Evidence**
> 
> - `readManifest` loads the file with `fs.readFileSync(path.join(repoRoot, manifest))`. That is an fs read by path, so the import-graph walk cannot discover it.
> - The situation states that such files ship only if listed in `CORE_ASSETS`.
> - Neither list contains it:
>   - `sync-to-repos.mjs:270-311` lists `.sync-manifest.json`, `flows.json`, the dashboard css/js, `consistency-contract.md`, `oss-call-policy.json`, `bundle-deps.json`, `compat-bootstrap.sql`, `expected-schema.json` and migrations. The manifest is absent.
>   - The mirror in `sync-inventory.mjs:114-135` lacks it too.
> - `windowed-views.mjs` itself *will* ship, because it is statically imported. So the reader arrives in the consumer without its data.
> 
> **Consequence**
> 
> 1. `readManifest` returns `kind: 'missing'`.
> 2. `windowedKeys` becomes `null`, so every measurement gets `windowed: 'unknown'` and `comparable` is false.
> 3. `previous` and `previousAt` are null for Q1, Q2 **and Q3**.
> 4. Every chip turns neutral in every consumer, with nothing on the measurement explaining why.
> 
> This is the same failure class `CORE_ASSETS` already documents twice:
> 
> - `oss-call-policy.json`: 15 wasted observations.
> - `expected-schema.json`: `--adopt` dead in every consumer.
> 
> This instance is quieter than either, because the fallback looks like a legitimate state rather than an error.
> 
> **Must change**
> 
> - Add `.windowed-views.json` to `CORE_ASSETS` in `sync-to-repos.mjs`, with the usual "fs-read, walker can't see it" comment.
> - Add it to the mirror in `sync-inventory.mjs` too, or the verifier will disagree with the sync.
> 
> **Verify now, without a consumer**
> 
> - Run the sync's file-set computation, or a sync into a throwaway temp git repo as target. Confirm `.windowed-views.json` is absent today and present after the fix.
> - Check where `sourceRelToDestRel('.windowed-views.json')` maps it. The default rule only covers `scripts/<rest>`. I expect a root file to stay at its canonical path, as `docs/reference/consistency-contract.md` does, but I have not seen that branch of `sync-path-map.mjs`. The answer decides what the reader must resolve to (see B2).
> - Confirm a root-level dotfile is accepted by the round-trip property test in `sync-path-map.test.mjs`.
> 
> ### B2. `SELF_REPO` resolves to the consumer's `scripts/` directory, not its repo root
> 
> **Evidence**
> 
> - The code computes `path.resolve(dirname(import.meta.url), '..', '..', '..')`.
> - In this repo the module sits at `scripts/lib/dashboard/`. Three levels up is the repo root, which is correct.
> - In a consumer it sits at `scripts/.[model]-skills/lib/dashboard/`. Three levels up is `<consumer>/scripts`.
> - So even with B1 fixed, `readManifest` looks for `<consumer>/scripts/.windowed-views.json`. That returns `missing`, and the symptom is identical to B1.
> - Fixing B1 alone therefore changes nothing observable. Both must land together.
> 
> **Must change**
> 
> - Stop counting `..`. The repo already has a helper for exactly this: `findRepoRootFromScript(import.meta.url)` in `assert-repo-root.mjs`. Its docstring describes it as the non-asserting variant "for computing repo-rooted paths at module load time".
> - Before relying on it, confirm that `findExpectedRoot` resolves through `scripts/.[model]-skills/…` to the consumer root. Its implementation is not shown.
> - If it returns `null`, that must flow into the existing `'unknown'` path, not crash at module load.
> - The resolved root must match where B1's sync actually lands the file.
> 
> **Verify now**
> 
> - **Unit test:** call the root resolution with a fabricated `file:///tmp/c/scripts/.[model]-skills/lib/dashboard/collect-home-queues.mjs` URL and assert it returns `/tmp/c`.
> - **Integration test:** copy the bundle into `tmp/scripts/.[model]-skills/` (ideally via the B1 temp-sync), place the manifest where the path map puts it, and call `collectQueues` with a stub `run` and **no** `manifestRoot`. Assert:
>   - Q3 has `windowed: 'no'` and a non-null `previous`.
>   - Q1 and Q2 have `windowed: 'yes'`.
> - Today this test should show `'unknown'` everywhere, which demonstrates the bug.
> 
> ### B3. The fail-closed state is indistinguishable from a working-but-empty one
> 
> **Evidence**
> 
> - `missing`, `invalid` (which carries a `reason`) and "manifest fine" all collapse into the same neutral chips.
> - `detail` is only populated for non-ok status, and nothing records why the trend was withheld.
> - This is what lets B1 and B2 go unnoticed. The stated principle, "an unasked question must not render as good news", is met. But the result also must not render as "nothing to report".
> 
> **Must change**
> 
> - When `manifest.kind !== 'ok'`, surface it. Put the kind and reason in the measurement or card detail, or emit a one-time warning.
> - The point is that an operator, or a test, can see that the declaration was unreadable.
> 
> **Verify**
> 
> - A test with `manifestRoot` pointing at an empty dir asserts that the reason is present on the output.
> 
> ### B4. No test covers the consumer layout
> 
> **Evidence**
> 
> - The tests run only in this repo, where both B1 and B2 happen to be correct.
> - The `manifestRoot` injection point means tests probably never exercise the default.
> 
> **Must change**
> 
> - Add the B2 integration test (default path, consumer layout).
> - Add, or confirm there already is, a check that the two `CORE_ASSETS` lists are identical. The "keep in lock-step" comments currently rely on humans.
> 
> ---
> 
> ## Not verified: check before merge, block only if wrong
> 
> - **`makeMeasurement` and the new field.** `home-model.mjs` is not shown. If `makeMeasurement` whitelists fields, `windowed` is silently dropped, and `dashboard.js` cannot distinguish "windowed" from "no previous line".
> - **`windowedQueueKeys` and `queues`.** `readManifest`'s declared return type is `{kind, views, exemptions}`, with no `queues`. Confirm that `windowedQueueKeys` reads `queues` from within `views`, and that validation rejects a manifest whose queue keys don't match `q1`/`q2`/`q3`. A typo would otherwise silently make a windowed queue `'no'`, the unsafe direction.
> - **Exceptions from `readManifest`.** Confirm it cannot throw past its `try`, for example on a JSON parse error or a directory instead of a file. If it does, it fails the whole card rather than degrading to `'unknown'`.
> - **The gate in consumers.** Does `windowed-views:gate` run there, and does it look at `.audit-loop/migrations` rather than `supabase/migrations`? That is outside this diff but the same layout concern.
> 
> ---
> 
> ## Checked and sound
> 
> - **Gating logic.** `comparable = windowed === 'no'`, so both `'yes'` and `'unknown'` suppress the trend.
> - **Field symmetry.** `previous` and `previousAt` are gated identically, and the existing `status === 'ok'` gate is preserved.
> - **Fail-closed intent.** An unreadable manifest suppresses all trends rather than guessing.
> - **No hardcoding.** The windowed set comes from the declaration, the same one the gate checks, rather than being hardcoded in the dashboard.
> - **Root choice.** The rationale for reading from the tooling's own root rather than the reported-on `root` is right. In a consumer the shipped migrations, and so the views, are upstream's, so upstream's declaration is the correct one to read.
> - **Imports.** `windowed-views.mjs` is a static import, so the walker will ship it. `node:path` and `node:url` are builtins and need no `bundle-deps.json` change.
> - **Testability.** The `manifestRoot` option is a reasonable test seam.
> 
> ---
> 
> ## Decision
> 
> **Do not merge as is. Request changes on B1 to B4.**
> 
> In the shown code, the dashboard reads `.windowed-views.json` by fs path:
> 
> - **B1:** that path is absent from both `CORE_ASSETS` lists, so the file never reaches consumers.
> - **B2:** independently, `SELF_REPO` uses a fixed three-level `..`. That lands on `<consumer>/scripts` because consumer files sit one directory deeper under `scripts/.[model]-skills/`.
> 
> Either fault alone yields `kind: 'missing'`, then `windowed: 'unknown'`, then no trend for any queue, including Q3, in every consumer. Both must be fixed together. This repeats the documented `oss-call-policy.json` and `expected-schema.json` blind spot, in a quieter form.
> 
> Required changes:
> 
> - Add the file to both asset lists.
> - Resolve the root with `findRepoRootFromScript` (after confirming it handles the `.[model]-skills` depth) to wherever the path map lands the file.
> - Make an unreadable manifest visible rather than silent.
> - Add a consumer-layout test that exercises the default path.
> 
> The trend-gating logic itself is correct and needs no change.

</details>

## 5. `5325a037` — case `stale-override-four-sites`

**Question.** Decide whether the override's recorded reason accurately describes what the sync delivers to a consumer, whether the override should stand as it is, and what should happen to the open upstream report. Say how you would establish it and what the consumer and upstream coordinators should each do next.

**Correct decision.** No: the three node-command sites (two bash blocks and the Actions run: line) are rewritten to the consumer path on delivery, and the fourth is a link label beside its own upstream URL with the consumer path named two lines later, so reason (2) is dead. The override's other rationale (plan links out of the shipped closure) is independent and must be judged separately, not dropped wholesale. Close the upstream report as not reproducing; make no rewriter change; the method is to render a disposable consumer and read the delivered bytes.

<details><summary>Response</summary>

> # Does the consistency-contract override's recorded reason still match what the sync delivers?
> 
> ## Short answer
> 
> Part 2 of the override's reason (the four upstream-path complaints) almost certainly misdescribes what `main@f48d9863` delivers:
> 
> - **Items (a)–(c)** are exactly the case the rewriter exists for. They should arrive already rewritten.
> - **Item (d)** is not a broken command at all.
> 
> Part 1 (the `docs/plans/` links) cannot be judged from these excerpts. I would confirm both parts with one disposable sync before anyone edits the override or answers the report.
> 
> ## What the code shows
> 
> **The doc is synced and passes through the rewriter.**
> - `sync-to-repos.mjs:279-282` lists `docs/reference/consistency-contract.md` in the shipped set.
> - The write loop runs every outgoing file through `rewriteCommandSurface` (lines 1571-1577). The expected-content path does the same (lines 1405-1413).
> - `.md` is a text surface according to the module doc ("plain-text files (.md, …)"). I have not seen the `TEXT_EXTENSIONS` literal itself, so that is one assumption.
> 
> **Items (a), (b) and (c) match the rewrite pattern.**
> - `COMMAND_REGEX = /\bnode\s+scripts\/([^\s`"'),;&|]+)/g` matches each of these:
>   - (a) `node scripts/persona-consistency-run.mjs --canary …`
>   - (b) `node scripts/persona-consistency-run.mjs \`. The tail stops at the space, so it is `persona-consistency-run.mjs`.
>   - (c) `- run: node scripts/persona-consistency-run.mjs …`. `\b` matches before `node` after the space.
> - Each match becomes `node scripts/.[model]-skills/persona-consistency-run.mjs`. Two conditions apply:
>   - `persona-consistency-run.mjs` must be in `ownedSourceTails`, which is built from `repo.files` (line 1163).
>   - `sourceRelToDestRel` must not treat the path as an explicit exception.
> - I have not seen either condition directly. It is very likely the script ships, because the shipped doc and the persona-test skill depend on it. If it does not ship, the real defect is "script missing from the consumer", not "doc names the wrong path".
> 
> **Item (d) is not a copy-paste command.**
> - The rewriter only touches `node scripts/…` invocations, so the `scripts/lib/redact.mjs` link text is left unchanged.
> - The link target is an absolute GitHub URL to upstream's source, which is valid wherever it is read.
> - The very next sentence reads: "In a consumer repo that module is synced to `scripts/.[model]-skills/lib/redact.mjs`."
> - So the delivered doc already names the consumer path. "Copy-pasting fails" does not fit this item.
> 
> **The report may have been accurate when it was filed.**
> - The override was last re-scoped on 2026-09-04. The rewriter and the consumer-path sentence in (d) may have landed after that date.
> - `git log -- scripts/lib/sync-rewriter.mjs docs/reference/consistency-contract.md` since 2026-09-04 would settle this.
> - The question is whether the reason is still true, not whether the consumer was wrong.
> 
> **Part 1 is unverified.** None of the excerpts contain a `docs/plans/` link. It needs a grep of the delivered doc and a check of whether each link target exists in the consumer tree.
> 
> **The override has a cost.** Because it freezes the file, the consumer has had none of upstream's edits to this doc since September. Its hand-maintained copy may have drifted from the attribute contract that frontend developers author against.
> 
> ## How to establish it
> 
> 1. Create a fresh disposable git repo configured with the same profile/file set as the private consumer, so that `repo.files` includes persona-test. Run `node scripts/sync-to-repos.mjs --target-path <repo>`. Do not add an override.
> 2. In the delivered `docs/reference/consistency-contract.md`:
>    - `grep -n 'node scripts/persona-consistency-run.mjs'` should return 0 hits.
>    - `grep -n 'scripts/.[model]-skills/persona-consistency-run.mjs'` should return 3 hits: Setup, Parity probe, and the Actions `run:` line.
>    - Confirm the redact paragraph contains the consumer-path sentence.
>    - `grep -n 'docs/plans/'` and check whether each target exists in the disposable repo.
> 3. Confirm that `scripts/.[model]-skills/persona-consistency-run.mjs` and `scripts/.[model]-skills/lib/redact.mjs` exist. Run the rewritten command (or `--help`) to show it resolves.
> 4. Diff the private consumer's hand-maintained copy against the delivered file, to see what the override is actually protecting.
> 
> ## What each side should do next
> 
> **Consumer coordinator**
> - If step 2 matches expectations, re-scope the override. Remove part 2 entirely and record the verification (base SHA, date).
> - Keep the override only if the `docs/plans/` links are confirmed dangling, and state that as the sole reason.
> - Pull in any upstream content changes that the frozen copy has missed.
> - If part 1 also proves false or is fixed upstream, delete the override and take the synced file.
> 
> **Upstream coordinator**
> - Do not close the report on code-reading alone. Reply on it with the disposable-sync evidence:
>   - (a)–(c) are resolved by the command-surface rewriter, citing the commit and the base SHA.
>   - (d) is not a defect: it is an absolute upstream URL, and the delivered prose already gives the consumer path.
> - If dangling `docs/plans/` links are confirmed, treat that as a real upstream doc defect. The fix is either converting them to absolute GitHub URLs (as was done for redact) or removing them.
> - Keep the report open, narrowed to that item, until it ships. Close it only after a resync shows no dangling links.
> 
> ## Decision
> 
> The override's recorded reason does not accurately describe current delivery, so the override should not stand as written.
> 
> - **Items (a)–(c):** these `node scripts/persona-consistency-run.mjs` invocations match `COMMAND_REGEX`. On the assumption that the script is in `repo.files`, `rewriteTextCommandInvocations` rewrites them to `scripts/.[model]-skills/…` on every sync write (`sync-to-repos.mjs:1571-1577`).
> - **Item (d):** this is an absolute upstream URL, and the very next sentence of the doc already gives the consumer path, so copy-pasting it does not fail.
> - **Part 1:** the `docs/plans/` claim is unverified either way.
> 
> I would confirm all of this with one disposable-consumer sync and grep before acting. Then the consumer drops part 2 and keeps the override only on part 1, if that is confirmed. Upstream answers the report with that evidence, narrows it to the plan-link item if it is real, and closes it otherwise. The report should not be closed, nor the override edited, until that sync output is in hand.

</details>

## 6. `9fe6442b` — case `consumer-prepush-schema-behind-refusal`

**Question.** Decide what the consumer coordinator should do today, what the real cause is and whose bug it is, what to avoid doing, and what to change and where. Give your decision, how you would confirm the diagnosis before changing anything, and the next steps.

**Correct decision.** The store is not behind and the printed remedy must not be run. The hook runs the source checkout's audit with the consumer as cwd; assertStoreSchemaRealized defaults its root to process.cwd(), while the layout is read from the module path (source), so the migrations directory resolves to <consumer>/supabase/migrations, the consumer's own application schema, which is compared with the audit-loop ledger and reported permanently missing. Running --migrate would apply the application's DDL to the shared audit store. Fix upstream in this repo by defaulting the root to the bundle's own root (cwd stays an explicit override for tests), with a test that fails on the old default; do not override or patch the consumer.

<details><summary>Response</summary>

> # Consumer pushes refused as UNMEASURED: diagnosis and decision
> 
> **Short answer:** The store is not behind. This is our bug, in the upstream repo. The schema precondition compares the consumer's own application migrations against the audit-loop ledger. Do not run the printed command. For today, set the schema-behind override in the consumer's push environment, after a read-only confirmation. Then fix the root resolution upstream.
> 
> ## The cause, from the code
> 
> 1. **The hook sets the working directory to the consumer.** It runs the source checkout's `openai-audit.mjs` with cwd set to the consumer repo, on purpose (`AUDIT_ALLOW_FOREIGN_CWD=1`).
> 
> 2. **The precondition inherits that cwd.** `assertStoreSchemaRealized` defaults `cwd = process.cwd()` and passes it as `repoRoot` to `checkMigrationRealization`. That function forwards it to `resolveMigrationsDir(repoRoot)`. This overrides the parameter's own default, `defaultRepoRoot()`, which deliberately resolves from the module's file location rather than from cwd.
> 
> 3. **The layout comes out as "source".** `detectLayout()` reads the module's own path. The module lives in the sibling source checkout, not under the consumer-tooling segment, so the layout is `source` and the directory is `supabase/migrations`.
> 
> 4. **The two halves combine badly.** The result is `<consumer>/supabase/migrations`, which is the consumer's product schema. Every one of those files is permanently "absent" from `public.audit_loop_migrations`, so the check returns `behind: true` and the audit exits 1.
> 
> 5. **The comment in `checkMigrationRealization` already describes this bug.** It says the old code "picked that repo's OWN `supabase/migrations` and compared an app schema against the audit-loop ledger — every app migration permanently 'missing', every commit refused."
>    - That fix addressed the layout half.
>    - The root half is still taken from cwd, and only in this foreign-cwd, sibling-source configuration.
> 
> 6. **Why the upstream repo passes:** there, cwd equals the tool root.
> 
> 7. **Why nobody noticed before:** hook v12 is behaving correctly. It turned a long-silent failure into a visible one. It also means this consumer has had no audit measured on any push since the precondition landed. Before v12, "noise" really meant "no audit at all."
> 
> ## What the evidence does not establish
> 
> - **Which database it connected to.** The report is paraphrased and does not say whether the message named `database <x>`. The consumer is a Supabase app, so its environment may carry a DSN for its own application database.
>   - The refusal does prove that a database holding `audit_loop_migrations` was reached. Without that ledger the check returns `no-ledger` and the audit proceeds.
>   - It does not prove that this was the shared store.
> - **What `setup-postgres.mjs --migrate` would actually apply.** It is not shown.
> - **Whether the store is current.** That is the coordinator's statement, not something I have checked.
> 
> ## Confirm before changing anything (all read-only)
> 
> 1. **Reproduce from the consumer checkout.** Run `AUDIT_ALLOW_FOREIGN_CWD=1 node ../[model]-engineering-skills/scripts/openai-audit.mjs …` and check three things:
>    - the `dir` in the error is `<consumer>/supabase/migrations`;
>    - the listed names are the consumer's app migrations, not upstream filenames;
>    - the `db` named is the shared store.
> 2. **Run the same command from the upstream checkout with the same DSN.** It should pass. That pins the difference to cwd rather than the database.
> 3. **Compare the ledger with the bundle.** Query `select … from public.audit_loop_migrations` and compare it against upstream's `supabase/migrations`. This confirms the store really is current.
> 4. **Isolate the function in a node one-liner.** Call `checkMigrationRealization` once with the consumer root and once with the upstream root, and print `resolveMigrationsDir(defaultRepoRoot())`.
> 5. **Read `setupPostgresCommand` and `setup-postgres --migrate`.** Find out which directory it applies. This tells us how dangerous the printed advice is.
> 6. **Look up the override variable's real name.** It is `SCHEMA_BEHIND_OVERRIDE_ENV` in the code, and its value is not shown here. Also confirm that the step CLI passes the environment through to the audit child process.
> 
> ## What to avoid
> 
> **Do not run `setup-postgres.mjs --migrate`.** There are two possible outcomes:
> - If it resolves its directory the same cwd-based way, it could apply a private product schema's DDL to the shared store, and possibly record those files in the ledger every repo reads.
> - If it resolves correctly, it does nothing and the refusal continues.
> 
> Neither outcome helps.
> 
> **Prefer the schema override over `AUDIT_PREPUSH_ALLOW_UNMEASURED`.** The latter skips measurement entirely, which just restores the pre-v12 blindness.
> 
> **Do not set either override globally.** Scope it to the consumer's push environment and record a removal condition: remove it once the upstream fix ships.
> 
> **Keep the consumer's details out of the public fix.** Describe the issue generically, as "Supabase consumer with its own `supabase/migrations`". Do not include the repo name, migration names or DSN.
> 
> ## Today's workaround
> 
> Once step 3 shows the store is current, set the schema-behind override (`<SCHEMA_BEHIND_OVERRIDE_ENV>=1`) for this consumer's hook runs. The audit then actually runs and produces a verdict.
> 
> Its warning says results will be local-only and that commits will read `AI-Gate: not-run`. That claim assumes the store really is behind, which here it is not. Whether the run registers normally is unverified, so check one run's gate marker. Treat either outcome as acceptable for the interim.
> 
> ## Upstream fix
> 
> 1. **Resolve the bundle from the tool's install location.** `scripts/lib/audit/schema-precondition.mjs` should stop defaulting to `process.cwd()`. The bundle to compare is the one shipped with the tool, so use `defaultRepoRoot()`. Better still, `checkMigrationRealization` in `scripts/lib/db/schema-realization.mjs` should derive its directory from `defaultRepoRoot(detectLayout())` and drop or rename the `repoRoot` parameter, so cwd cannot reach it at all.
> 2. **Add a regression test.** With a stub pool and the source layout, set cwd to a temporary directory containing a decoy `supabase/migrations`. The test must compare against the tool's bundle.
> 3. **Add an end-to-end test of the hook's foreign-cwd invocation.**
> 4. **Audit every other caller of `resolveMigrationsDir` that passes cwd.** This includes the runtime write guard and `setup-postgres --migrate`, which may share the same hazard.
> 5. **Consider a sanity check in the refusal path.** Refuse to print a DDL remediation when `dir` is not under the tool root.
> 6. **Ship it as a hook/tool update, then tell the coordinator to remove the override.**
> 
> ## Decision
> 
> **What the consumer coordinator should do today:**
> - Do **not** run `setup-postgres.mjs --migrate`.
> - Do **not** fall back to `AUDIT_PREPUSH_ALLOW_UNMEASURED`.
> - First, read-only, confirm three things: the error's `dir` is the consumer's own `supabase/migrations`, the named `db` is the shared store, and `audit_loop_migrations` matches upstream's bundle.
> - Then set the schema-behind override, scoped to the consumer's push environment, as a temporary measure until the upstream fix lands.
> 
> **The cause and whose bug it is:** The shared store is not behind. This is an upstream bug in [model]-engineering-skills. `assertStoreSchemaRealized` passes `process.cwd()` as the repo root. The hook deliberately sets cwd to the consumer, and the source checkout's path gives the `source` layout. Together they select the consumer's application migrations and compare them against the audit-loop ledger. This is the same failure the code comment says was fixed; only the layout half was fixed, and the root half still comes from cwd.
> 
> **What to change and where:** Upstream, resolve the bundle root from the module's install location (`defaultRepoRoot()`) and never from cwd, in `schema-precondition.mjs` and `checkMigrationRealization`. Add a decoy-directory regression test and a foreign-cwd hook test, and check other cwd-based callers of `resolveMigrationsDir`.
> 
> **Evidence this rests on:** the hook template, the `cwd = process.cwd()` default, the `resolveMigrationsDir(repoRoot)` call, how `detectLayout` behaves for a sibling checkout, and the fact that the same store passes when audited from the upstream repo itself.

</details>

## Marks

| # | grade id | Your verdict (Y/N) |
|---|---|---|
| 1 | 917f54e5 |  |
| 2 | c78a9e95 |  |
| 3 | b3455ebe |  |
| 4 | 39dfdd7f |  |
| 5 | 5325a037 |  |
| 6 | 9fe6442b |  |

<details><summary>Judge labels — open only after every verdict above is filled</summary>

| # | grade id | Judge (both passes) | Passes split |
|---|---|---|---|
| 1 | 917f54e5 | Y | - |
| 2 | c78a9e95 | N | split |
| 3 | b3455ebe | N | - |
| 4 | 39dfdd7f | Y | - |
| 5 | 5325a037 | N | - |
| 6 | 9fe6442b | N | - |

</details>

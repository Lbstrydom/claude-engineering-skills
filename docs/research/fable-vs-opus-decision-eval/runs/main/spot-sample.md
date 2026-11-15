# Spot sample — main

Blinded. For each response, read the question and the correct decision, then the response,
and write **Y** (reaches the correct decision) or **N** in the table at the end.
The judge labels sit in a collapsed block AFTER the marks table: do not open it until every row is filled.

## 1. `7a5f91ef` — case `disposable-db-guard-predicate`

**Question.** Both guards have just been shown to be inert against the database they exist to protect. Decide what the guards should test and why, what else in `assertDisposableDbUrl` (if anything) needs to change as part of the same fix, whether any bypass should exist, and what to do about the fixture that was just regenerated. Give your decision, the reasoning, and the verification you would require before calling it fixed.

**Correct decision.** Do not extend the hostname denylist. Replace it, in the one shared predicate both guards call, with a test of what "disposable" means: an allowlist of loopback hosts, so any unrecognised host is presumed to be somebody's real database and the guard cannot rot when the store moves again. Make the production-identity check compare host+port+database rather than DSN strings, give the guard no environment-variable bypass, prove it red-then-green on dangerous inputs with the legitimate container DSN as the vacuous-pass control, and regenerate the fixture from a fresh migration replay, not the dump-restored store.

<details><summary>Response</summary>

> # Production DB guards: replacing the "is it Supabase" check after the self-hosted cutover
> 
> ## What happened
> 
> Both guards answer "is this hostname under `.supabase.co`/`.supabase.com`?" They exist to answer two different questions:
> 
> - **Destructive suites:** "is this database disposable?"
> - **Fixture generator:** "is this a fresh replay of the migrations, which is what postgres-parity CI checks?"
> 
> The Supabase check stood in for both only while the docstring's premise held: "this repo has exactly one Supabase project, and it is always production". The cutover made that premise false. Production is now a LAN address on a non-default port. The predicate returns `false`, so both guards wave it through.
> 
> The tests pass because they pin only the hosts the predicate already handles. None of them asks the question that matters: "is a non-Supabase, non-local host refused?" Today's fixture run is the live proof. It exited cleanly against production, and only an unexpected diff caught it.
> 
> The current design is a **denylist of one vendor**. Any production move, alias, tunnel or proxy defeats it silently. The fix has to turn the guard into an allowlist of positively disposable databases, so that unknown hosts are refused.
> 
> ## What the guards should test
> 
> ### 1. URL check, no connection needed
> 
> Accept the URL only if the host is loopback: `127.0.0.1`, `::1`/`[::1]`, or `localhost`, compared exactly, not as a suffix. Refuse everything else, including LAN addresses, Supabase, and any other hostname.
> 
> - **CI host:** I have not seen the CI workflow. If CI reaches its pgvector service under a service hostname (for example `postgres`), that name goes into the allowlist in code, where a reviewer sees it. It does not go in via an environment variable.
> - **Parse like the driver parses:** check that the guard reads the URL the same way the pool does.
>   - libpq and, I believe, node-postgres's `pg-connection-string` honour a `?host=` query parameter.
>   - An empty host falls back to `PGHOST`.
>   - So `postgres://u@127.0.0.1/db?host=10.0.0.5` could pass a `new URL().hostname` check and still connect to the LAN store.
>   - Either parse with the pool's own parser or reject URLs carrying `host`/`hostaddr` parameters or an empty host. This needs to be confirmed against the installed `pg` version.
> 
> ### 2. Server-side check, which is the one that actually matters
> 
> A loopback URL does not prove the server is disposable. An SSH tunnel or port-forward to the LAN store appears as `127.0.0.1`, and that becomes more likely now that production lives on a private network. So after connecting, and **before** any `DROP SCHEMA`, require a positive disposable marker on the server.
> 
> - **Who sets it:** only the provisioning paths set the marker: `npm run db:local`, `db:local:regen`, and the CI setup step.
> - **Where it lives:** somewhere the destructive suites do not destroy. `DROP SCHEMA public CASCADE` would erase a table in `public`, so use a `COMMENT ON DATABASE` or a row in a dedicated non-`public` schema.
> - **Why positive, not a "production" marker on prod:** a production marker would be a denylist again, failing open whenever it is missing. That is exactly what dump/restore can do. A plain `pg_dump` does not carry `COMMENT ON DATABASE`, and production was just rebuilt by dump/restore.
> 
> ### 3. Fixture generator: same two checks, plus a stricter rationale
> 
> Its stated rationale ("vanilla Postgres, not Supabase extensions/grants") is now known to be incomplete. The new store *is* vanilla and still produced a wrong fixture, because dump/restore renumbers `attnum` past dropped-column tombstones and a fresh migration replay does not.
> 
> The real invariant is: **the fixture must come from a database that `generate-expected-schema` or CI freshly built by replaying migrations.** Concretely:
> 
> - Require loopback plus the marker.
> - I would also stop the generator reading `AUDIT_DB_URL`. That variable's default value in any developer shell is now production. Have `db:local:regen` pass the target explicitly, through a dedicated variable or argument. Reading the production variable as the generator's input is the hazard that made three incidents possible.
> 
> ### 4. One shared predicate, renamed
> 
> Replace `isHostedSupabaseHost` with something like `isDisposableDbUrl` (URL check) plus `assertDisposableDb(pool)` (marker check). Rewrite the docstring so it states the real invariant, not the vendor proxy.
> 
> - Keeping the Supabase match as an extra deny rule with its specific error message is harmless.
> - It must not be the gate.
> 
> ## Other changes needed in `assertDisposableDbUrl`
> 
> **The `testUrl === productionUrl` check is fail-open in several ways:**
> 
> - It is raw string equality. Different credentials, `localhost` vs `127.0.0.1`, an explicit vs omitted `:5432`, `sslmode` or other query params, or a trailing slash all defeat it.
> - `productionUrl` defaults to `null`, so a caller that forgets to pass it gets no check at all.
> - It is also skipped when `AUDIT_DB_URL` is unset in that shell.
> - The 07-14 incident was described as the test URL "resolved to the same database", which is precisely the case string equality misses.
> 
> **What to do with it:**
> 
> - With the allowlist and marker in place, this check becomes defence in depth.
> - Keep it, but compare normalised (host, port-with-default, database) tuples.
> - Make a missing `productionUrl` an explicit decision at call sites, not a silent default.
> - Do not present it as a control.
> 
> **Placement:** the guard is currently called in each suite's `before()`. Move the marker check into the helper that issues the `DROP`, so a future suite cannot skip it.
> 
> **Documentation:** update the AGENTS.md invariant (lines 592–595) and the runbook §Incident. "Rejecting a Supabase-hosted … test URL" now describes a guard that doesn't protect anything.
> 
> ## Bypass
> 
> **None. No env-var override for either guard.**
> 
> - The history is three failures of discipline: the 07-14 wipe, plus fixture regenerations 808beb8 and 154fb57. That history is the stated reason the generator refuses outright.
> - An `ALLOW_NON_DISPOSABLE=1` flag ends up in someone's `.env`, and then the guard is gone.
> - There is no legitimate reason to drop schemas on, or derive the fixture from, a non-disposable database.
> - Legitimate variations go through reviewed code, not runtime flags. A new disposable host is an allowlist entry in code. A new disposable environment runs the marker-setting provisioning step.
> - For the fixture, the CI `live-schema` artifact is already the escape hatch.
> 
> ## The fixture regenerated today
> 
> **Discard it.** Run `git checkout -- tests/fixtures/expected-schema.json` and delete any copy. It reflects dump/restore `attnum` numbering, not a migration replay, and would turn the schema gate red.
> 
> **Then confirm the committed fixture is still correct:** run `db:local:regen` (or pull CI's `live-schema` artifact) and require a **zero** diff. Today's diff showing *only* 9 `ordinal_position` changes suggests the committed fixture is fine, but that is inference, not proof.
> 
> **Side check, not part of this fix:** the renumbering should close gaps without reordering columns. Still, grep for positional SQL (`INSERT … VALUES` without a column list, `COPY` without columns, `SELECT *` consumed by index) against `refresh_runs`.
> 
> ## What the evidence does not establish, and what I'd check before or alongside the fix
> 
> - **Other callers and other repos.** Are there other callers of `isHostedSupabaseHost`, or other destructive paths (`DROP`, `TRUNCATE`, reset scripts)? This is one shared store for every repo, so check whether sibling repos copied this guard.
> - **Destructive suites since the cutover.** Has anyone run them since this morning? Specifically, does anyone have `AUDIT_DB_TEST_URL` pointing at, or derived from, the new LAN DSN? The current guard would have allowed it. Check row counts and recent run history on the new store.
> - **Generator writes.** Confirm the generator is read-only (information_schema queries only), so today's run did not modify production.
> - **CI configuration.** Find the actual host CI uses for `AUDIT_DB_TEST_URL` and the parity container, so the allowlist doesn't break CI.
> - **Parser behaviour.** Find out how the installed `pg` parses `?host=` and empty hosts.
> 
> ## Verification required before calling it fixed
> 
> 1. **Unit tests for the URL check.**
>    - Must refuse:
>      - a LAN IPv4 address with a non-default port, in the exact shape of the new production DSN;
>      - Supabase hosts;
>      - arbitrary hostnames;
>      - look-alikes such as `localhost.example.com` and `127.0.0.1.nip.io`;
>      - a non-loopback IPv6 address;
>      - `?host=` overrides;
>      - an empty host.
>    - Must accept: `127.0.0.1`, `[::1]` and `localhost`.
>    - At least one test must be the case that would have failed this morning.
> 2. **Marker test.** A loopback database *without* the marker is refused before any `DROP`. The same database with the marker passes.
> 3. **Live negative test against the real new production DSN.**
>    - `assertDisposableDbUrl(<prod DSN>)` throws.
>    - `generate-expected-schema.mjs` with the production target exits 2 and writes nothing.
>    - Both refusals must happen before any destructive statement. Pinned test hosts are what gave false confidence last time.
> 4. **Positive path.** `npm run db:local`: the suites pass. `db:local:regen`: zero fixture diff. CI parity and schema suites green, with the marker provisioning step in place.
> 5. **Documentation.** AGENTS.md, the runbook and the `client.mjs` docstring describe the disposable/fresh-replay invariant, not "Supabase = production".
> 
> ## Decision
> 
> **What the guards test.** Replace the Supabase-host denylist with a fail-closed disposability test, shared by both guards:
> 
> - the URL host must be loopback, plus any explicitly allowlisted CI service host, parsed the way the driver parses it; and
> - the connected server must carry a positive disposable marker that only `db:local`, `db:local:regen` and CI provisioning set, checked immediately before any `DROP`.
> 
> The fixture generator additionally stops reading `AUDIT_DB_URL`, and takes its target only from the regen script.
> 
> **What else changes in `assertDisposableDbUrl`.** The string-equality production check is normalised and made mandatory-by-decision, and demoted to defence in depth.
> 
> **Bypass.** No bypass exists for either guard.
> 
> **Today's fixture.** Discard it. Re-verify the committed fixture against a fresh migration replay, requiring zero diff.
> 
> **Evidence this rests on:**
> 
> - Today's run passed `isHostedSupabaseHost` against the new LAN production store and wrote a fixture with 9 renumbered `ordinal_position`s in `refresh_runs`. This proves the predicate tracks a vendor, not the property either guard needs.
> - The docstring's justification ("exactly one Supabase project… always production") is now false.
> - The 07-14 wipe and commits 808beb8 and 154fb57 show that guards relying on discipline or proxies fail repeatedly.
> - `testUrl === productionUrl` is defeated by trivial DSN variations and by an omitted argument.
> 
> **Not fixed until** the live negative test against the actual production DSN is refused by both guards and the positive path stays green in local and CI.

</details>

## 2. `4692d66e` — case `windowed-views-consumer-path-review`

**Question.** Review this change before it merges. List the defects you would block on, ordered by impact, each with the evidence in the code shown and how you would verify it without waiting for a consumer to hit it; then list what you checked and found sound. Do not rewrite the feature; say what must change.

**Correct decision.** Block the merge on two defects that cannot show in this repo and one that CI would catch. (1) SELF_REPO climbs three directories from the module, which is the repo root only in the source layout; in a consumer the module sits one directory deeper, so it resolves to the consumer's scripts directory and readManifest can never find the declaration. (2) Even resolved correctly, .windowed-views.json is read by path at runtime, is not importable, and is in neither CORE_ASSETS list, so the sync never ships it and a consumer has nothing to read. The consequence of both is that every queue chip loses its delta in a consumer (the unreadable case suppresses all five queues, including the ones that are not windowed). (3) Adding an asset is two edits: the hand-maintained sync-inventory mirror must change in lock-step or its parity test fails. The existing repo-root helper that is correct in both layouts should replace the arithmetic.

<details><summary>Response</summary>

> ## Blocking defects, in order of impact
> 
> **1. In a consumer, `SELF_REPO` is not a repo root, so the manifest read always misses.**
> 
> - Evidence: `SELF_REPO = path.resolve(dirname(import.meta.url), '..', '..', '..')` hard-codes three levels up.
>   - Here the module is at `scripts/lib/dashboard/`, so three up is the repo root, which is correct.
>   - Per `sync-path-map.mjs` it lands at `scripts/.[model]-skills/lib/dashboard/` in a consumer, where three up is `<consumer>/scripts`.
>   - `readManifest` then joins that with `MANIFEST_PATH` and reads `<consumer>/scripts/.windowed-views.json`, where nothing puts a file.
> - Effect: `manifest.kind !== 'ok'`, so `windowedKeys` is `null` and every queue gets `windowed: 'unknown'` and `previous: null`. The trend disappears for all queues in every consumer, including the non-windowed ones, with no error. The per-queue behaviour the PR adds only ever runs in this repo.
> - This fails in the safe direction: no misleading "good news" is shown. But it is a silent, fleet-wide loss of the legitimate trends.
> - Verify without a consumer:
>   - Compute `sourceRelToDestRel('scripts/lib/dashboard/collect-home-queues.mjs')`, resolve three `..` from its directory, and confirm the result ends in `/scripts`.
>   - Better, sync into a scratch directory and call `collectQueues` from the copied file with a stubbed `run` and a `statusText` containing a `Backlog` line. Assert a non-windowed queue returns `windowed: 'no'` with a non-null `previous`. Today that will return `'unknown'`.
> - What must change: resolve the manifest location in a way that holds in both layouts. `findRepoRootFromScript(import.meta.url)` exists for this, but its `null` return must map to `'unknown'` rather than being passed to `path.join`.
> 
> **2. `.windowed-views.json` is not shipped at all.**
> 
> - Evidence: it is read by path at runtime (`fs.readFileSync`), so the import walk cannot find it. It appears in neither `CORE_ASSETS` in `sync-to-repos.mjs` nor the mirror in `sync-inventory.mjs`.
> - This is the same blind spot the existing comments record for `oss-call-policy.json` and `expected-schema.json`.
> - It is independent of defect 1: fixing either alone still leaves the manifest unreadable in consumers.
> - Verify: run the sync as a dry-run or into a scratch directory and look for the file in the copied set.
> - What must change:
>   - Add it to both lists in lock-step.
>   - Decide its consumer destination explicitly. The path map's exception set is described as closed, and no rule for a repo-root dotfile is shown.
>   - Make the destination and the read path from defect 1 agree.
> 
> **3. Nothing tests the consumer layout, and the failure is designed to be quiet.**
> 
> - Evidence: the author's tests run here, where the layout makes both defects invisible, so CI green cannot tell working from broken. "Unreadable manifest → suppress everything" is a reasonable runtime fallback, but it also hides a packaging error.
> - What must change:
>   - Add a test that runs the collector from the mapped path (the scratch-sync check above, kept permanently).
>   - Add a visible signal when the manifest is `missing` or `invalid`, such as a measurement detail or log line, so "unknown" can be told apart from "nothing to compare".
> 
> ## Checked and found sound
> 
> - **Suppression logic:** `comparable = windowed === 'no'` gates both `previous` and `previousAt`. Unknown and windowed both withhold the trend, and the `status === 'ok'` condition is preserved.
> - **Module shipping:** `windowed-views.mjs` is a static import, so the walker will ship the module itself.
> - **Design choices:**
>   - Reading the declaration from the tooling rather than the reported `root` is right for a shared store.
>   - `manifestRoot` is injectable for tests.
>   - The queue set is not hard-coded.
> - **Upstream path:** `SELF_REPO` is correct in this repo.
> 
> ## Not established by what is shown — check before merge
> 
> - **`readManifest`'s catch block.** It is cut off. I am assuming ENOENT returns `{kind: 'missing'}` as the JSDoc says. If any path throws (for example EISDIR), the queues card fails rather than degrading.
> - **Key matching.** `windowedQueueKeys` must return a `Set` whose keys match the collector's (`'q1'`/`'q2'` casing). A mismatch fails open as `'no'`, and the misleading trend stays. Assert against the committed manifest, not a fixture.
> - **`makeMeasurement`.** Confirm it preserves the new `windowed` field and that the shipped `dashboard.js` renders `previous: null` as neutral.
> - **The gate script.** If it is in a sync entry list, it will look for `supabase/migrations`, which is `.audit-loop/migrations` in a consumer.
> - **`bundle-deps.json`.** Confirm it does not need regenerating because of the new import.
> 
> ## Decision
> 
> Block the merge. The path arithmetic in the diff, combined with the documented `scripts/` → `scripts/.[model]-skills/` mapping, puts the manifest lookup at `<consumer>/scripts/.windowed-views.json`. The two `CORE_ASSETS` lists show the file is never shipped anywhere. Either fact alone means every consumer silently loses all queue trends, and the PR's tests cannot see it because they run in the native layout.
> 
> To unblock:
> 1. Use layout-independent root resolution.
> 2. Add the manifest to both asset lists with an agreed destination.
> 3. Add a test that runs the collector from a synced scratch copy.
> 
> The suppression logic itself is fine and needs no redesign.

</details>

## 3. `9133744a` — case `check-ignore-ci-cause-string`

**Question.** Diagnose this CI-only failure, where a test pinned to one cause string in a degraded-scan warning sees a different cause string on the runner than it does locally and on main. Decide whether to re-run it as a flake, loosen or retarget the assertion, or change the code, and say what the code should report. Give your decision and the next steps, including who is affected.

**Correct decision.** A real race, not a flake: git check-ignore --stdin outside a work tree exits 128 without reading stdin while spawnSync is still writing, so the parent sees either status 128 or EPIPE depending on platform/load. Fix the cause reporting in code (a non-zero status other than 0/1 wins over the write error; a write error with status 0/1 keeps its own code) and leave the test unchanged; the loud degradation held either way. Not a re-run and not a loosened regex.

<details><summary>Response</summary>

> # Diagnosis: a stdin race that mislabels the cause of a correct degraded scan
> 
> ## What happened
> 
> `ignoredUntrackedPaths` passes the candidate list to `git check-ignore -z --stdin` through `spawnSync(..., { input })`. In the scratch root, which is not a work tree, git fails during repository setup and exits 128 ("not a git repository") **before it reads stdin**.
> 
> Node then writes `input` into a pipe whose reader has already gone. When git exits before the write completes, the write fails with `EPIPE`, and `spawnSync` sets `result.error` to that EPIPE.
> 
> The code checks `ign.error` before `ign.status`:
> 
> ```js
> `(${ign.error ? ign.error.code || ign.error.message : `git exit ${ign.status}`})`
> ```
> 
> So the label becomes `(EPIPE)`, which is a downstream symptom of the real cause, git exit 128. The CI stderr matches this exactly. Every other part of the line is correct:
> 
> - the WARN prefix is present;
> - the "NOT verified" text is present;
> - the scan still completes with `symbols=1`.
> 
> The degradation is detected correctly. Only the stated cause is wrong.
> 
> ## Why only CI, and why main passed
> 
> The input is a single 9-byte path, so whether the write lands before or after git exits is a scheduling race. On Linux, losing that race gives EPIPE. On Windows, anonymous-pipe semantics and slower process startup make the write almost always land first, so the local run passes. Main's last green run on ubuntu probably won the race. The code is byte-identical on main, so **PR #359 did not cause this; main carries the same latent failure.**
> 
> ## This is not just a test flake
> 
> With real candidate lists, the race stops being a race. The Linux pipe buffer is 64 KiB. A full scan of a non-git root with a few thousand paths cannot fit its input into the buffer before git exits. On Linux that case would report `EPIPE` almost every time.
> 
> The wrong cause therefore reaches real users:
> 
> - the scanner's stderr;
> - the `ownership` wire line's `warning` (the test's second assertion, `/128/.test(l.warning)`, would also fail);
> - the doctor;
> - every consumer that syncs `scripts/.[model]-skills/lib/disowned-paths.mjs`.
> 
> "git exit 128" tells an operator "you're not in a work tree". "EPIPE" suggests an I/O or pipe fault and sends them in the wrong direction.
> 
> ## What the evidence does and does not establish
> 
> **Established:**
> - The cause label is EPIPE on CI.
> - The error-first branch produces exactly that string.
> - The degraded path was taken, so the safety property ("unverified ≠ clean") held.
> 
> **Not established:**
> - Whether `ign.status` is populated as 128 alongside `error: EPIPE` in this Node version. I expect it is, because the child ran and exited, but the CI output doesn't show it. This matters for the fix.
> - Whether any consumer (for example, the v18 pre-push hook) branches on the cause text. If one does, this is a behaviour bug in consumers, not only a diagnostic one.
> - The second failed file (`skill-command-blocks-parse-under-powershell`). It is unrelated and still blocks #359 on its own.
> 
> ## What to check next
> 
> 1. **Linux repro.** Loop `spawnSync('git', ['check-ignore','-z','--stdin'], {cwd: nonGitTmp, input})` with both tiny input and input of more than 64 KiB. Log `error?.code`, `status` and `stderr`. Confirm that `status === 128` accompanies EPIPE and that large input makes EPIPE deterministic.
> 2. **Consumer usage.** Grep upstream and consumer repos for `git exit 128`, `EPIPE` and `.warning` parsing to find anything that keys on the cause.
> 
> ## What the code should report
> 
> Report git's exit status whenever git actually ran. Fall back to the spawn error only when the child never produced a status.
> 
> - **`ENOENT` (git missing), `status === null`:** report the error code. This is unchanged.
> - **`EPIPE`, `status` not 0 or 1:** report `git exit <status>`. Optionally add the first line of git's stderr (for example, "not a git repository") and a note such as `stdin EPIPE`.
> - **`EPIPE`, `status` 0 or 1:** stay degraded, because git did not consume the whole query, so the answer may be partial. Label it something like `git exit N, stdin truncated (EPIPE)`.
> 
> Keep `degraded: true` and the existing wording in every one of these cases.
> 
> Do **not** bump `OWNERSHIP_RULE_EPOCH`. What counts as disowned is unchanged; only the diagnostic text changes.
> 
> ## Test changes
> 
> - Keep the RED assertion pinned to `git exit 128`. That is the contract the test exists to protect: "the 128 cause".
> - Add a subtest that makes the race deterministic. Use a non-git root with enough candidates that the stdin payload exceeds 64 KiB, and assert `git exit 128` on both stderr and the wire `ownership` line. Without this, the fix is only verified probabilistically.
> 
> ## Who is affected
> 
> - **Upstream main:** latently red on Linux.
> - **PR #359:** blocked, but innocent.
> - **Consumer repos running the synced lib:** they get mislabelled degraded-scan warnings outside work trees. They need the next sync. If any consumer parses the cause, flag it explicitly in the sync notes.
> 
> ## Decision
> 
> **Change the code. Do not re-run the job as a flake, and do not loosen the assertion.**
> 
> The failure is a real ordering defect. `ignoredUntrackedPaths` lets the secondary `EPIPE` from writing stdin to an already-exited git hide git's actual exit status of 128. The evidence:
> - The CI stderr shows `(EPIPE)` together with an otherwise correct degraded warning.
> - The code checks `ign.error` before `ign.status`.
> - Git rejects a non-work-tree before reading stdin.
> - The race explains both the Windows and main passes and the ubuntu failure.
> 
> Re-running would hide a bug that becomes deterministic for realistic candidate counts. Loosening the regex to accept EPIPE would turn a wrong diagnosis into the contract.
> 
> The fix: prefer `git exit <status>` whenever a status exists, keep `degraded: true` in every case, and add a deterministic test with more than 64 KiB of input. Land it as its own PR against main, since main has the same bug, and then rebase #359. #359 also needs the unrelated PowerShell failure resolved separately. Ship the fix to consumers in the next sync of `scripts/.[model]-skills/lib/disowned-paths.mjs`, with no epoch bump.
> 
> Before merging, confirm with a Linux repro that `status === 128` is present alongside `EPIPE`. If it is absent, add a cheap `git rev-parse --is-inside-work-tree` pre-check so the 128 cause is established before any stdin is written.

</details>

## 4. `64dc31fb` — case `sync-manifest-ratchet-report`

**Question.** Is the reported diagnosis (that the sync records the hash it intended to write for paths it refused, re-asserting a false base) correct? Decide what the coordinator should conclude, what should be reproduced or checked before anyone changes anything, what the real defect is if there is one, and whether anyone should hand-repair the consumer's manifest. Give your decision and the next steps.

**Correct decision.** Not a ratchet: for refused/held paths the manifest keeps the last hash the sync actually wrote, so manifest != disk is the intended divergence signal; the report's evidence cannot distinguish that from the claimed bug. Do not repair the manifest to disk hashes (that is the earlier defect that turns refusal into overwrite). The real defect is the one-shot "upstream moved" warning, computed against the previously rewritten receipt instead of the manifest base. Only the refusal path may be claimed as reproduced.

<details><summary>Response</summary>

> # Is storyline's "ratchet" diagnosis right?
> 
> ## What the code at `d0f3d8f5` actually does
> 
> **The manifest writer does not record intent for refused paths.**
> - Lines 1837–1867 build a set called `notWrittenByUs`. It holds refused paths, held paths, failed writes and skipped writes.
> - For every path in that set, the writer copies forward the **prior manifest's** entry (`carried = priorFiles[dstRel]`, with a legacy-layout fallback). It does this only if the prior entry exists and the file is still on disk.
> - Only paths the sync actually wrote are re-hashed, and they are hashed **from disk** after the write, not from the source.
> - So a refusal leaves the recorded base exactly where it was. The base is not moved forward, and no ratchet is visible in this code.
> - One edge case: if a refused path has no prior entry, it is **dropped** from the manifest, not recorded with an intended hash.
> 
> **The storyline evidence fits this behaviour as well as it fits the report.**
> - Manifest `29ec5697` against disk `d884e509` on a refused path is exactly what carry-forward produces. The base is the last bytes the sync wrote, and the disk holds the consumer's edit.
> - Reading `29ec5697` as "upstream's intent" is an inference, and nothing in the report tests it.
> - If upstream's version of `.vscode/mcp.json` has not changed since the last write, then the old base and the current intent are the same hash. A single snapshot cannot tell them apart.
> 
> **The claim about the verifier does not match the gate shown.**
> - Gate 2B hashes every manifest entry on disk.
> - It fails on any mismatch unless one of two things applies:
>   - the path matches a declared override (it is then counted as held), or
>   - the path is the receipt and passes a structural check.
> - A refused, non-overridden path such as `.vscode/mcp.json` should therefore turn 2B **red**.
> - "8/8 green with 11 disagreeing paths" means one of the following:
>   - those 11 paths are all covered by `.sync-overrides.json`, so they are held rather than refused;
>   - the verifier ran against a different checkout or manifest;
>   - the storyline coordinator is describing a different tool. The report names `verify-sync-invariants`, not `sync-isolation-verify.mjs`, and the "only checks it exists and parses" claim may be true of that other tool.
> 
> **What the evidence does not establish:**
> - Which sync version wrote storyline's current manifest. If an *older* version did write intended hashes, the current code would faithfully carry that wrong base forward indefinitely.
> - That would be a real defect: carry-forward has no way to heal a poisoned base.
> - That hypothesis is unproven, but it is the most plausible route by which the report's symptom could be real.
> 
> ## Reproduce and check before changing anything
> 
> **1. Disposable consumer repo, using the real CLI.**
> - **Sync 1.** Record the manifest hash for a test path, call it `H1`.
> - **Edit the path, then run sync 2.** Expect it to be refused, and expect the manifest entry to still be `H1`.
> - **Change upstream's source for that path** (local branch, or a source edit), **then run sync 3.**
>   - Expect the entry to still be `H1`, not the new upstream hash.
>   - Expect the receipt's `divergenceRefused` to list the path.
>   - If the entry becomes the new upstream hash, the report is right after all.
> - **Repeat with a path that has no prior entry.** Confirm it is dropped, and see how `classifyAgainstBase` treats `baseHash === undefined` on the next run.
> - **Repeat with an override declared for the path.** Confirm it is reported as held and that the base is carried.
> - **Run `sync-isolation-verify` after the refusal.** Expect 2B to fail, and expect it to pass once the override is declared.
> 
> **2. On storyline, read-only.**
> - Snapshot the manifest, the receipt and the overrides file before doing anything else.
> - For each of the 11 paths, classify it against the receipt's latest `divergenceRefused`, its `overridesHeld`, and `.sync-overrides.json`.
> - Get the actual verifier output. Check which tool was run, and whether 2B's `details.held` lists the 11 paths.
> - Compute the sha256 of upstream's blob for `.vscode/mcp.json` at each upstream commit. Is `29ec5697` the current upstream, an earlier upstream version, or neither?
> - Find the sync commit that last wrote each manifest entry. The manifest's `commitSha` and the receipt's `source.commitSha` history give this. Then check whether that version's writer recorded intent.
> 
> ## Do not hand-repair the manifest
> 
> - The manifest base is the input that decides whether a path is diverged.
> - If someone "fixes" `.vscode/mcp.json` to the disk hash `d884e509`, the next sync classifies that file as pristine and **silently overwrites the consumer's edit**. That is the exact data loss the refusal exists to prevent.
> - Hand edits would also destroy the evidence needed to date the problem.
> - If a base does turn out to be poisoned by an old writer, the repair should go through the tool:
>   - resolve it per path (either declare an override, or revert to upstream and let the sync re-record);
>   - or ship a supported re-baseline that is logged in the receipt.
> 
> ## Decision
> 
> **Do not accept the diagnosis as stated, and do not change the sync or hand-edit storyline's manifest yet.**
> 
> At `main@d0f3d8f5`, the manifest writer (lines 1837–1867) carries the **prior** base forward for refused and held paths and never writes the intended hash. The reported manifest-versus-disk mismatch is exactly what that carry-forward produces, so it is not evidence of a ratchet. Gate 2B (lines 329–419) compares every entry against disk and fails on refused paths, which contradicts "only checks it exists and parses".
> 
> The real open questions are:
> - whether storyline's bases were written by an older sync version that did record intent, which current carry-forward would then preserve indefinitely;
> - why the verifier reported green. Most likely the paths are actually held by overrides, or a different tool or checkout was used.
> 
> Next steps:
> 1. Run the multi-sync repro on a disposable consumer.
> 2. Snapshot storyline's state, then classify the 11 paths against the receipt and the overrides file.
> 3. Compare `29ec5697` against upstream's blob history for `.vscode/mcp.json`.
> 4. Get the actual verifier output.
> 
> Only if the repro shows the manifest entry advancing on refusal, or shows a poisoned base inherited from an older writer, should a fix be designed. Any such fix should be a tool-mediated re-baseline, not a manual manifest edit, because a manual edit would mark diverged files as pristine and let the next sync overwrite the consumer's changes.

</details>

## 5. `350d14b4` — case `sdk-pin-max-tokens-review`

**Question.** Review this pin change as a coordinator deciding whether PR #360 is safe to merge at this step. The code at each moved site is described as otherwise unchanged: is that enough to conclude the pinned sites still behave correctly? State your verdict on the change, what you would check or change before merge, and what the coordinator should do next.

**Correct decision.** Not safe as is: the pin changes max_tokens semantics from accepted-and-ignored (cli) to enforced (sdk), and with a model that spends output on a thinking block a 64-token cap leaves no text block, while content[0].text reads the wrong block, so labels silently become underived (100% failure hidden by graceful degradation). Re-measure every cap at the moved sites, read the first text block via one helper at the seam, and surface stop_reason when no text arrives.

<details><summary>Response</summary>

> **Verdict: the pin is the right change and the diff matches its description, but "otherwise unchanged" does not establish that the pinned sites behave correctly. I would hold the merge for a short live check and a few small fixes.**
> 
> ## What the evidence establishes
> 
> - At the four sites shown, the diff changes only the transport pin and the availability gate. Model, `max_tokens`, `system`, messages and response parsing are untouched, so the author's claim is accurate as a statement about the code.
> - The throw, the gate and the availability oracle are well covered by the negative controls.
> 
> ## What it does not establish
> 
> Identical params mean different things on the two transports, and on the maintainer's machine these sites only ever ran on `cli`.
> 
> - **`max_tokens` becomes a real ceiling.** The cli adapter accepted and ignored it (1995 tokens returned against a cap of 200). After the pin, 64 (labels), 4000 (judge) and 2000 (refine) are enforced. Nothing shown demonstrates these caps were ever exercised live on `sdk`, and the 2595 tests and controls target the seam and gate, not live output.
> - **`system` is honoured for the first time locally.** This is intended, but past local behaviour is therefore no evidence about the new outputs.
> - **Failures at these sites are silent.**
>   - **Judge:** a reply truncated at 4000 tokens yields no parseable JSON and returns `conformant: false`. That is the same failure class the commit says it removes: a transport artifact scored as a verdict. Whether 4000 is enough depends on rubric and output count, which I can't see.
>   - **Labels:** the code reads only `content[0].text`, where the judge joins all blocks. If the sdk response for `[model]-[model]-5-5` leads with a non-text block or is cut off at 64 tokens, every unit becomes `underived` via the swallowed catch. Nothing is cached, so it retries and bills each run. A truncated-but-non-empty label is cached as a success, since `stop_reason` is never checked.
> - **Stale cache.** The label cache key is `v${LABEL_PROMPT_VERSION}:${u.key}` with no backend component. Labels produced under cli, where `system` was outranked, will keep being served as `llm-cached` until the TTL expires.
> - **Two sites not shown.** The commit names six sites, but I've seen four. `evolve-prompts`/`llm-wrappers` and `solo-control-audit` are unreviewed here. The latter's rows are compared across arms, so pre-pin `cli(default)` rows are not comparable with post-pin rows.
> - **Keyless cli machines.** Labels, brief and refinement now skip or fall to Gemini by design. The `context.mjs` comment previously called silent Gemini degradation a defect, so this reversal should be visible rather than silent. The judge shows no availability gate at all.
> 
> ## Before merge
> 
> 1. Make one live `sdk` call per pinned site with a realistic prompt. Record `stop_reason`, `usage.output_tokens` and content block types. If CI or another contributor already runs these live on `sdk`, those logs would settle it more cheaply.
> 2. In the labels site, select the first text block rather than `content[0]`, and treat `stop_reason === 'max_tokens'` as a failure so it is not cached.
> 3. In the judge, return a distinct error for truncation rather than plain non-conformance.
> 4. Bump `LABEL_PROMPT_VERSION` or clear the cache.
> 5. Review the two unseen sites the same way.
> 
> ## After merge
> 
> - Re-run judge calibration on `sdk`, since the earlier calibration ran under ambient cli.
> - Segregate `solo-control-audit` rows by provenance.
> - Emit a stderr line when a pinned site skips for lack of a key.
> 
> ## Decision
> 
> Do not merge at this step yet; approve the design conditionally. The diff proves the code is unchanged, but the adapter excerpt proves the transport changes what `max_tokens` means. The commit comments say the same of `system`, and the audits and tests never exercised the moved sites live on `sdk`. Because both the labels and judge sites turn truncation or shape problems into quiet fallbacks (`underived`, `conformant: false`), a regression would not show as a red test. The live smoke call per site, the `stop_reason` and text-block handling, the cache version bump, and a look at the two unshown sites are the conditions for merge.

</details>

## 6. `b3455ebe` — case `skills-manifest-commit-or-ignore`

**Question.** Choose how to end the recurring `skills.manifest.json` conflicts. Say what you would change, what you would check before changing it, which obvious alternatives you reject, and what else in the repo the choice touches (tests, gates, workflows, policy text). Give your decision and the next steps.

**Correct decision.** Stop committing skills.manifest.json: gitignore it as a Category A build output and drop it from skills:regenerate and skills:check, because nothing reads a committed copy (the installer that did is retired; release.yml runs build-manifest.mjs itself before it reads bundleVersion). Remove the conflict at its source rather than resolving it, keep build-manifest.mjs --check as a verifier for whichever file it is pointed at, and update the pieces that assumed the file is tracked (its poison pill and gate contract, the freshness-wiring test, the policy text, a stale test comment).

<details><summary>Response</summary>

> ## What the evidence establishes
> 
> - **The conflict is structural.** `build-manifest.mjs:201-210` hashes every skill file's SHA into one 16-hex `bundleVersion` on one line. Any two branches that each edit any skill file produce different values there, so the 9 conflicts on that line follow from the design.
> - **Purity is not the issue.** The file passes the policy test (byte-identical regeneration, enforced by a check). The test just never asks whether the artifact survives parallel branches, and a repo-wide digest on one committed line cannot.
> - **Releases do not need the committed copy.** `release.yml` runs `node scripts/build-manifest.mjs` before building checksums and the tarball.
> - **In-repo readers look few.** The test comment says only `build-manifest.mjs` (write and check) and `tiered-shadow-contract-digest.mjs` (the `bundleVersion` string) use it. The scoped grep agrees: the other hits are comments, gate metadata and the release workflow.
> 
> ## What it does not establish
> 
> - **The payoff.** `docs/plans/README.md` conflicted 8 times and `status.md` twice, and the overlap is not given. Removing the manifest clears at most 9 of the 13 conflicted PRs; the real number is those where it was the only conflict.
> - **Complete consumer coverage.** The grep covers only `scripts`, `.github`, `.fleet.json`, `setup.mjs` and `package.json`, and only the literal filename. It excludes `tests/`, `docs/`, `skills/`, `.[model]/` and `dashboard/`. The dashboard test is already one reader outside that scope.
> - **What `.fleet.json:3` means.** If it is a list of files synced to other repos, something downstream expects the file to exist.
> - **External readers.** The repo is public and the manifest carries `rawUrlBase`, so old installers may fetch it raw from `main`. The comments also disagree: `build-manifest.mjs` says `install-skills` and `check-skill-updates` read `bundleVersion`, while the test says the install path is retired. The grep shows no hit in those two scripts, which favours "retired". But `release.yml:98` still tars them, so the release workflow may itself be stale.
> 
> ## Checks before changing
> 
> 1. Re-run the merge-tree replay ignoring `skills.manifest.json` to get the real reduction.
> 2. Run `git grep -n -e "skills.manifest" -e bundleVersion 76ad4ad9` over the whole tree, and read `build-manifest.mjs:25-58`. Those lines hint at a "silently-dropped" detector, tests that mutate and restore the committed file, and a path resolver.
> 3. Read `.fleet.json` and its consumer.
> 4. Run `git ls-files scripts/install-skills.mjs scripts/check-skill-updates.mjs`, look at the last successful Release run, and decide whether a raw-URL 404 matters for any installer still in the wild.
> 5. Read how `tiered-shadow-contract-digest.mjs` gets `bundleVersion` and what it does when the file is missing.
> 
> ## Alternatives rejected
> 
> - **Custom merge driver or `merge=union`.** GitHub computes the CONFLICTING state server-side and does not run custom drivers. A union merge would leave two `bundleVersion` lines.
> - **Auto-rebase or regenerate bot, or a merge queue.** This treats the symptom, and a conflicting PR cannot enter a queue anyway.
> - **A bot that commits the manifest to `main` after each merge.** `main` would be transiently stale, it needs bot writes to a protected branch, and it breaks pre-push `skills:check` unless that is weakened.
> - **Keep it committed but drop only `bundleVersion`.** Adjacent per-file SHA lines would still collide. It also keeps a file whose only read field has just been removed.
> - **Leave it and rebase by hand.** That is the current cost.
> 
> ## What the change touches
> 
> - **Reader.** Export a pure `computeBundleVersion()` from `build-manifest.mjs` and have `tiered-shadow-contract-digest.mjs` call it. A fresh CI checkout will not have the file.
> - **Tests.** `dashboard-collect-reference.test.mjs` uses the committed manifest as its sentinel, and its "cannot go stale" comment becomes false. Derive the inventory in memory instead. `release.yml` runs `npm test` before "Build manifest", so no test may read the on-disk file. Also fix any tests that mutate and restore the committed file.
> - **Gates.** Replace `build-manifest.mjs --check` in `skills:check` with a build-validity and determinism check, so frontmatter and packaging errors still fail pre-push. Update `gate-contracts/skills-check.json` and the poison pill at `check-gate-poison-pills.mjs:358` in the same PR, or `check-gate-contracts` will fail. If the committed diff was how a silently dropped file was caught, add an explicit allowlist-coverage test. Add a guard that the file is not tracked.
> - **Workflow and comments.** `release.yml` already builds the file; fix line 98 if those scripts are gone. Update the `setup.mjs:422` and `build-manifest.mjs` comments.
> - **Policy text.** Category A's wording ("cannot be a pure function of committed source") does not fit this file. Amend the test for B: byte-identical, checked, and with no aggregate value that changes on any edit across a broad input set. Pure-but-aggregate artifacts are built on demand and gitignored. The plans-index counts line fails the same test, though that decision is separate.
> - **Transition.** Deleting the file on `main` gives every open PR that touched it a one-time modify/delete conflict. Merge when the open queue is small and tell sessions to resolve with `git rm`.
> 
> ## Decision
> 
> Stop committing `skills.manifest.json`. Gitignore it, build it on demand and at release, and compute `bundleVersion` from source wherever it is needed.
> 
> This rests on three things in the evidence:
> 
> - The conflict is inherent to a repo-wide hash on one committed line (`build-manifest.mjs:201-210`, 9 of 9 conflicts on that line).
> - The release workflow already regenerates the file.
> - The only identified in-repo reader wants one string that can be computed directly.
> 
> It is conditional on the `.fleet.json` and external raw-URL checks coming back clean. If something outside does fetch it from `main`, publish it as a release asset or to a non-PR branch rather than keep it on `main`.
> 
> Next steps:
> 
> 1. Run the five checks above.
> 2. Land one PR with the reader refactor, test and gate-contract updates, the `skills:check` change, the gitignore and untracked guard, and the AGENTS.md amendment.
> 3. Re-measure the conflict rate, expecting README and `status.md` conflicts to remain.

</details>

## 7. `08fe9566` — case `sdk-pin-max-tokens-review`

**Question.** Review this pin change as a coordinator deciding whether PR #360 is safe to merge at this step. The code at each moved site is described as otherwise unchanged: is that enough to conclude the pinned sites still behave correctly? State your verdict on the change, what you would check or change before merge, and what the coordinator should do next.

**Correct decision.** Not safe as is: the pin changes max_tokens semantics from accepted-and-ignored (cli) to enforced (sdk), and with a model that spends output on a thinking block a 64-token cap leaves no text block, while content[0].text reads the wrong block, so labels silently become underived (100% failure hidden by graceful degradation). Re-measure every cap at the moved sites, read the first text block via one helper at the seam, and surface stop_reason when no text arrives.

<details><summary>Response</summary>

> **Verdict:** "Otherwise unchanged" is not enough to conclude the pinned sites behave correctly. The throw-and-pin design is sound, but I would hold the merge at this step until each pinned site has been run live on `sdk` once.
> 
> ## Why "unchanged" does not settle it
> 
> The pin changes which transport interprets the same lines. For each moved site on a cli-ambient machine (the maintainer's), the request that actually executes now differs in two ways:
> 
> - **`system` is honoured for the first time.** That is the intended fix.
> - **`max_tokens` is enforced for the first time.** The adapter excerpt says the cap was "accepted and ignored" on cli, with 1995 output tokens measured against `max_tokens: 200`. So the caps at these sites (64 for labels, 4000 for the judge, 2000 for refine-prompts) have never bound in a local live run.
> 
> The pin also moves billing to the API-key meter, which is the declared intent.
> 
> Nothing in the commit's verification exercises this. The 2595 tests and the negative controls prove the gate, the oracle and the scanner. CI was always on `sdk`, but nothing shown says CI makes live calls at these sites. Unless someone has run them live on `sdk`, the live experience with them is all on cli.
> 
> ## Site-level risks
> 
> **Work-unit labels**
> - **Silent failure.** `defaultLabeller` swallows any setup error and returns null (`labeller-unavailable`), and the per-unit `catch {}` turns any API error into `underived`. If the API rejects the request (model id, a 429 from the unbounded `Promise.all`, a credential problem), nothing fails loudly and the labels simply disappear.
> - **Brittle response read.** The labeller reads `content[0].text` only, while the judge joins all text blocks. Whether `[model]-[model]-5-5` on the raw API always returns text first within 64 tokens is unverified. A 3–8 word name probably fits, but there is no `stop_reason` check, and a clipped label counts as a success and is cached.
> - **Stale cache.** The cache key is `v${LABEL_PROMPT_VERSION}:${u.key}` and the diff does not bump the version. Labels produced on cli, where `SYSTEM` was not honoured, will keep being served as `llm-cached` until the TTL expires. The fix would not be visible, and any before/after comparison would be confounded.
> 
> **Judge**
> - **Truncation misread as non-conformance.** If the 4000 cap truncates the output, the result is `judge returned no JSON` or a parse failure, recorded as `conformant: false`. That is the same misattribution the pin comment says it removes, with a new cause. I can't tell from the excerpts whether judge output approaches 4000 tokens on `sdk`.
> - **Old rows are suspect.** The pin comment itself says cli-era judge rows scored transport failures as non-conformant. Those rows, and the `solo-control-audit` rows tagged `cli(default)`, are not comparable with post-pin rows.
> 
> **Keyless cli installs**
> - Labels and refine-prompts now skip and the brief falls to Gemini. That is by design, but these features go from running to quietly off.
> - The judge has no availability gate in the excerpt, so it would presumably throw. Whether the maintainer's machine has an `ANTHROPIC_API_KEY` is not stated.
> 
> ## Before merge
> 
> 1. Run every pinned site live on `sdk` once, including the two indirect ones (`evolve-prompts` via `callClaude`, and `solo-control-audit`). Record `stop_reason`, output tokens and the content block types.
> 2. Make the judge report `stop_reason === 'max_tokens'` as a distinct error rather than `conformant: false`. Make the labeller skip caching on truncation and read the first text block rather than block 0.
> 3. Bump `LABEL_PROMPT_VERSION`, or otherwise invalidate the cli-era label cache.
> 4. Surface `labelWorkUnits`' `failed` count and `reason` to the caller, so an all-`underived` run is visible.
> 5. Confirm the key and meter situation on cli-ambient machines, and mark the cli-era judge and audit rows as a separate baseline.
> 
> Next, send this list to the author and ask whether any pinned site has ever run live on `sdk`. If it has, item 1 is mostly closed and the rest are small follow-ups. No further audit round on the gate is needed.
> 
> ## Decision
> 
> Hold PR #360 at this step: the design is approved, but the merge is conditional on a live `sdk` smoke run of all six pinned sites, the `stop_reason` handling and the label-cache bump.
> 
> This rests on three pieces of evidence:
> - The adapter excerpt shows `max_tokens` was ignored on cli, and the commit says `system` was not honoured there. Identical call-site code therefore sends a materially different effective request once pinned.
> - The commit's tests and negative controls cover the gate and the availability checks, not the pinned sites' live behaviour.
> - The label path swallows every failure into `underived` or `labeller-unavailable`, so a regression there would not surface on its own.
> 
> The evidence does not show that any site is actually broken. It shows that correctness on `sdk` has not been demonstrated.

</details>

## 8. `284d3e1d` — case `prepush-check-target-tree`

**Question.** Decide how the pre-push hook should obtain the tree it runs `npm run check` against, which alternatives you reject and why, and what other parts of the repo the choice forces you to change or at least audit (things that only worked because of how the hook ran today). Give your decision and the next steps.

**Correct decision.** Run the check in a throwaway git worktree at exactly the pushed commit (the sha git hands the hook on stdin), not in the shared working tree, not after a git stash, and not by refusing a dirty tree. Because a fresh worktree has none of the gitignored inputs, every check that skips on a missing input must become a hard error in that sandbox (a setup failure is a push failure, never a pass), and every gate that infers its base from working-tree state must take the range git gave the hook from one resolver.

<details><summary>Response</summary>

> # Pre-push hook: which tree `npm run check` should run against
> 
> ## What the evidence establishes
> 
> - The hook runs `( cd "$REPO_ROOT" && npm run check )`, which checks the **shared working tree** and not the commits being pushed. It never reads `LOCAL_SHA` for the blocking step. Only the non-blocking DB-seam advisory reads stdin.
> - Nothing else checks pushes. There is no CI `check` on push or PR, so whatever the hook fails to verify reaches the remote unverified.
> - Two sessions share this tree, and that has already caused a real failure. On 2026-07-19 one session was half-way through writing `scripts/lib/prompt-seeds.mjs`, and another session's import of it failed. So the working tree can be both **different from** the pushed commit and **unstable while the checks run**.
> - AGENTS.md forbids exactly the cheap fixes: no auto-stash, no auto-commit, and leave unrelated uncommitted state alone.
> - `arch-coverage-gate.mjs` exits 0 ("skipping") when its gitignored, generated input is missing. Any fresh tree would silently turn that gate into a no-op.
> 
> What the evidence does **not** establish:
> - How often a false block or false pass actually happens. Nobody has measured it.
> - How many other checks read gitignored or generated inputs, mtimes, `.git` internals, or sibling-repo paths.
> - Whether `npm run` finds `node_modules/.bin` from a nested directory on Git for Windows.
> 
> The decision below does not depend on frequency: one false pass is enough to ship broken code, because there is no other gate. The other unknowns must be verified before rollout.
> 
> ## Options considered
> 
> 1. **Status quo (check the working tree).** Rejected. It is wrong in both directions: it blocks on files that are not being pushed, and it passes on fixes that are not committed. It also races with the other session's half-written files.
> 2. **Stash, check, pop.** Rejected.
>    - It directly violates "Never auto-stash".
>    - With two live sessions it is destructive: the other session's files vanish mid-edit, and conflicts on pop can lose work.
>    - It also fails on the passing side: a stash leaves HEAD, which is not necessarily the `LOCAL_SHA` being pushed (for example, `git push origin feature:main` or pushing an older ref).
> 3. **Refuse to push from a dirty tree.** Rejected as a gate. With two sessions the tree is almost always dirty with someone else's work, so this blocks constantly. It also still checks HEAD rather than `LOCAL_SHA`. It survives only as a diagnostic, described below.
> 4. **`git archive` or `checkout-index` into a temp dir.** Rejected. It produces the right files but no git metadata, so any check that calls `git log`, `git diff` or `rev-parse` breaks or changes behaviour.
> 5. **Chosen: a detached `git worktree` at each pushed `LOCAL_SHA`, and run `check` there.** It contains exactly the bytes the remote will receive. It keeps full git access. The other session cannot touch it. It is cheap, because it shares the object store.
> 
> ## How the chosen design works
> 
> - **Read stdin once.** Buffer it at the top of the hook, because the DB-seam loop currently consumes it. Then derive the set of distinct `LOCAL_SHA`s: skip deletions (zero SHA), skip SHAs already checked, and fall back to `HEAD` if stdin is empty (manual run).
> - **Create the worktree** with `git worktree add --detach "$REPO_ROOT/.prepush/<sha>-$$" "$LOCAL_SHA"`.
>   - Use a PID-unique directory so two sessions pushing at once don't collide.
>   - Add `trap` cleanup (`git worktree remove --force` plus `git worktree prune`), and prune stale `.prepush/*` on entry.
> - **Get dependencies without reinstalling.**
>   - Nesting the worktree under `REPO_ROOT` lets Node's ancestor walk find `$REPO_ROOT/node_modules`. No junctions are needed, which matters because Windows symlinks are unreliable.
>   - **Must verify:** that `npm run` also puts the ancestor `node_modules/.bin` on PATH under Git for Windows. If not, prepend `$REPO_ROOT/node_modules/.bin` to PATH explicitly.
> - **Lockfile guard.** If `package-lock.json` at `LOCAL_SHA` differs from what is installed (`node_modules/.package-lock.json`), **fail closed**. The message should tell the operator to run `npm ci` in the main checkout. Results against the wrong dependencies are not verification.
> - **Fail closed if the worktree can't be created.** This is the only gate. `--no-verify` remains the explicit escape hatch.
> - **Measurement as a side effect.** Log whenever the main working tree differs from `LOCAL_SHA` for tracked or untracked paths, using `git diff --quiet "$LOCAL_SHA"` plus untracked files. When the worktree check passes, also run or record what the old behaviour would have said. This gives the missing frequency data and costs nothing.
> 
> ## What this choice forces us to change or audit
> 
> These things only worked because the checks ran inside a long-lived, locally generated main checkout:
> 
> 1. **Gitignored or generated inputs.** `arch-coverage-gate` will silently skip in every fresh worktree.
>    - Fix: regenerate inputs inside the worktree (for example, `arch:render` before the gate, if it is deterministic from tracked sources). Do **not** copy them from the main checkout, because they reflect the working tree, not the commit.
>    - Add a hook-mode flag (e.g. `PREPUSH_ISOLATED=1`) under which "input missing, skipping" becomes a failure.
>    - Audit every `check` sub-script for the same pattern: `context:check`, `skills:check`, `efficacy:check`, `db:check-rls:gate`, `docs:refs:gate`, `plans:*`, and the test suite.
> 2. **Uncommitted local configuration.** Some checks may depend on local config or environment files that are not committed. Identify them, and pass explicitly whatever is legitimately local. Keep `AUDIT_DB_TEST_URL` unset, as today.
> 3. **Code that assumes `.git` is a directory.** In a worktree, `.git` is a file. Grep for direct reads of `.git/…` and replace them with `git rev-parse --git-dir` or `--git-common-dir`.
> 4. **Freshness based on mtimes.** Every file in a fresh checkout has mtime "now". Any freshness or drift check that uses `fs.stat` mtimes rather than git dates will mis-report. Audit `skills:check` and `context:check` in particular.
> 5. **Path assumptions.**
>    - Look for hard-coded `REPO_ROOT`s, `process.cwd()` assumptions, and `../<sibling-repo>` relative paths. These shift by two levels when nested under `.prepush/`.
>    - Also check the Windows long-path limit with the nested directory.
> 6. **Filesystem walkers in the main checkout.** Tests, lint and doc scanners that glob the repo must ignore `.prepush/`. Add it to `.gitignore` and to every walker's exclude list. Otherwise a concurrent session's `npm test` will pick up the transient tree. This is the same race class we are fixing.
> 7. **Tests that inspect live working-tree state.** Tests using `git status` or `git diff` against the working tree behave differently in a clean worktree. Audit and fix the ones that implicitly relied on local dirt.
> 8. **The consumer sync step (section 2).** It syncs the **working tree** to consumer repos, so it has the same bug: uncommitted or unpushed content leaks downstream on push.
>    - Run it from the verified worktree, before cleanup, or at minimum warn when the main tree differs from `LOCAL_SHA`.
>    - Decide this explicitly. Don't leave it accidentally inconsistent with the check step.
> 9. **DB-seam advisory.** It keeps its logic but must read the buffered stdin.
> 10. **Documentation.** Update the hook's header comment, AGENTS.md and any setup docs describing what the hook verifies. Also update the "Two sessions, one working tree" note so it records that pushes are now isolated from it.
> 
> ## Next steps
> 
> 1. Run a spike: time `worktree add` plus `check` on Windows and confirm `.bin` resolution from the nested directory.
> 2. Audit all thirteen `check` sub-scripts plus `npm test` against points 1–7 above. Fix them, or add regeneration, before switching the gate.
> 3. Implement the hook changes, including the lockfile guard, hook-mode failing on missing inputs, cleanup, and divergence logging.
> 4. Roll out in shadow mode for a short period: blocking stays on the old path, the worktree path is advisory, and divergences and disagreements are logged. Then switch blocking to the worktree path.
> 5. Separately, consider a CI `check` job so the hook is no longer the sole gate.
> 
> ## Decision
> 
> The pre-push hook should run `npm run check` in an **isolated, detached `git worktree` checked out at each pushed `LOCAL_SHA`** (from the hook's stdin; `HEAD` if stdin is empty), nested under a gitignored `$REPO_ROOT/.prepush/` so Node resolves the main checkout's `node_modules`. It should fail closed if the worktree can't be built or the lockfile differs from what is installed.
> 
> **Rejected alternatives:**
> - Checking the working tree: it is wrong in both directions and racy, as shown by the 2026-07-19 import failure.
> - Stash/pop: it violates AGENTS.md's no-auto-stash rule, endangers the concurrent session's work, and checks HEAD rather than the pushed SHA.
> - Refusing dirty trees: it blocks constantly with two sessions and still checks the wrong commit.
> - `git archive` exports: they have no git metadata.
> 
> **What the choice obliges:**
> - Regenerate rather than silently skip gitignored inputs; `arch-coverage-gate`'s exit-0 skip is the known case, so audit every gate for the same pattern.
> - Audit for `.git`-as-directory reads, mtime-based freshness, path and sibling-repo assumptions, and tests relying on working-tree state.
> - Exclude `.prepush/` from every walker.
> - Make the consumer-sync step use the pushed tree, or warn.
> - Buffer stdin for the DB-seam advisory.
> - Update the docs that describe the hook.
> 
> **What this rests on:**
> - The hook runs at `REPO_ROOT` and ignores `LOCAL_SHA`.
> - There is no CI backstop.
> - The status log records a concurrent-session collision.
> - AGENTS.md's scope rules forbid the cheap alternatives.
> - The gate skips silently when its generated input is missing.
> 
> How often false blocks and false passes happen is unmeasured. The divergence logging will measure it, but the decision does not depend on it.

</details>

## 9. `ca169519` — case `sync-manifest-ratchet-report`

**Question.** Is the reported diagnosis (that the sync records the hash it intended to write for paths it refused, re-asserting a false base) correct? Decide what the coordinator should conclude, what should be reproduced or checked before anyone changes anything, what the real defect is if there is one, and whether anyone should hand-repair the consumer's manifest. Give your decision and the next steps.

**Correct decision.** Not a ratchet: for refused/held paths the manifest keeps the last hash the sync actually wrote, so manifest != disk is the intended divergence signal; the report's evidence cannot distinguish that from the claimed bug. Do not repair the manifest to disk hashes (that is the earlier defect that turns refusal into overwrite). The real defect is the one-shot "upstream moved" warning, computed against the previously rewritten receipt instead of the manifest base. Only the refusal path may be claimed as reproduced.

<details><summary>Response</summary>

> ## What the code at `d0f3d8f5` establishes
> 
> **The manifest writer does not record an "intended" hash for refused paths.** In the writer (1837-1867), every path in `divergenceRefusals`, `receiptOverridesHeld`, `failedWrites` or `skippedWrites` goes into `notWrittenByUs`. For those paths the only value that can be written is the prior manifest's own entry:
> 
> ```js
> const carried = priorFiles[dstRel] ?? (legacy fallback);
> if (carried && stillThere) consumerFileMap[dstRel] = carried;
> … continue;
> ```
> 
> - The source hash (`srcHash`) is never consulted on this branch. A refused path keeps its previous base or drops out of the manifest; it cannot acquire a new one.
> - For paths the sync did write, the entry is a hash of the bytes re-read from disk, not of what it meant to write.
> - So the "ratchet" summary (each refusal moves the base forward) describes behaviour the shown code does not have.
> 
> **The claim about the verifier is also wrong for the verifier shown.** Gate 2B hashes every `manifest.files` entry against disk. A mismatch is forgiven in only two cases: the receipt file passing a structural check, or the path matching a declared override (reported under `details.held`). Anything else is `mismatched` and fails the gate. If `verify-sync-invariants` is a different script, it is not in evidence.
> 
> ## What the reported evidence does and does not show
> 
> - **`.vscode/mcp.json` is `29ec5697` in the manifest and `d884e509` on disk.** This is the precondition for a refusal, not a symptom of one: a path is refused because disk differs from the recorded base. The observation fits "carried base, consumer edited the file" as well as the reporter's reading.
> - **"Read as upstream's intent" is an interpretation.** Nobody compared `29ec5697` against upstream's bytes for that path. Even a match would not discriminate, because if upstream has not changed the file since the last write, the carried base and upstream's intent are the same hash.
> - **"8/8 green with 11 paths disagreeing" contradicts a genuinely refused path.** A refused path has no override by definition, so Gate 2B should fail on it. One of these premises must therefore be off:
>   - The 11 are held paths plus possibly the receipt, which is green by design. This is my leading guess, and it suggests "refused" and "held" were conflated.
>   - The verifier ran against a different manifest; the manifest is gitignored, so it is per-checkout.
>   - The verifier's `matchOverride` covers the path where the sync's override matching did not, or the override was added after the refusal.
> - **"The frozen set can only grow" is unverified.** The append-only receipt records `divergenceRefused` and `overridesHeld` per run, so the claim can be checked directly.
> 
> ## Checks before anyone changes anything
> 
> 1. **Snapshot storyline's state first.** Copy the manifest, `.sync-receipt.json` and `.sync-overrides.json` aside; the next sync rewrites the manifest.
> 2. **Read existing artifacts (no sync needed):**
>    - Is `.vscode/mcp.json` under `divergenceRefused` or `overridesHeld` in the latest receipt entry?
>    - Did the refused set actually grow across receipt entries?
>    - What does the verifier's Gate 2B `details.held` / `receipt` list, and does it account for all 11 paths?
>    - Does `29ec5697` equal that path's destination bytes at the previously synced upstream commit, or at the current one?
> 3. **Reproduce on a disposable consumer with the real CLI.** Record the manifest entry, disk hash, sync output and verifier result after each step.
> 
> | Step | Action | Code predicts | Report predicts |
> |---|---|---|---|
> | 1 | Clean sync; note manifest hash H1 for path P | manifest = disk = H1 | same |
> | 2 | Edit P in the consumer; sync | refused; manifest stays H1 | same (upstream unchanged, so not discriminating) |
> | 3 | Change P upstream (intent becomes H2); sync | refused; manifest stays H1 | manifest becomes H2 |
> | 4 | Sync twice more | manifest stays H1; refused set is stable | — |
> | 5 | Restore P to its H1 bytes; sync | P is written; manifest becomes H2; refused set shrinks | — |
> 
>    Step 3 is the discriminating one. Also run Gate 2B after steps 2 and 3: it should be red for a refused path with no override, then green with `held` once an override is declared.
> 4. **Probe the paths the excerpt does not settle:**
>    - **Legacy layout:** start from a legacy-layout manifest, where the fallback is `priorFiles[srcRel]`. If legacy entries hashed source bytes and the destination is a rewritten file, the carried base would be an upstream-source hash that never matched disk. That would be a static false base, not a ratchet. This is a hypothesis; the excerpt does not show what legacy manifests contained.
>    - **Missing or corrupt manifest:** the manifest is gitignored, so any fresh clone has none. `classifyAgainstBase` with no base is not shown, and a refused path with no `carried` value is dropped from the manifest, where Gate 2B never iterates it.
> 
> ## Real defect, if any
> 
> None is established. The candidates, in order of likelihood:
> 
> - **No defect.** The 11 paths are declared holds or the receipt. The follow-up is at most a reporting improvement, such as making "green with N held" harder to misread.
> - **Verifier/sync disagreement.** If the receipt confirms a true refusal with no override while Gate 2B is green, the bug is in what the verifier loaded or matched, not in the manifest writer.
> - **Legacy or missing-manifest base seeding**, as described in check 4.
> 
> ## Hand-repairing the manifest
> 
> No one should hand-repair the manifest.
> 
> - Setting the entry to the disk hash makes the path look pristine, so the next sync silently overwrites storyline's local version.
> - Setting it to upstream's hash changes nothing.
> - Deleting the manifest drops every base into the unexamined no-base path.
> - The file is gitignored, so any edit is unreviewable and local to one checkout.
> 
> The supported resolutions per path are to declare an override, restore the base bytes to take upstream, or deliberately use the overwrite-diverged option.
> 
> ## Decision
> 
> Do not accept the diagnosis, and do not change the sync or the consumer's manifest on the strength of this report.
> 
> - **The claim is contradicted by the writer.** At 1837-1867, refused and held paths carry the prior manifest hash or are dropped, never upstream's intended hash. Written paths are hashed from disk.
> - **The cited evidence does not discriminate.** Manifest differing from disk on a refused path is the definition of diverged.
> - **The verifier claim is contradicted by Gate 2B.** It hash-compares every manifest entry and passes mismatches only for declared overrides or the receipt.
> - **The unexplained item is "8/8 green with a refused path mismatching".** It points to held paths or a manifest/override mismatch, not a ratchet.
> 
> Next steps: snapshot storyline's manifest, receipt and overrides; run the receipt and Gate 2B detail checks; run the reproduction, including the upstream-change step and the legacy and no-manifest variants. Reply to storyline with those results. Open a defect only if a carried hash is shown to change on refusal, a legacy-seeded base is shown to be wrong, or Gate 2B is shown passing an undeclared mismatch.

</details>

## 10. `fe4ee2c2` — case `stale-override-four-sites`

**Question.** Decide whether the override's recorded reason accurately describes what the sync delivers to a consumer, whether the override should stand as it is, and what should happen to the open upstream report. Say how you would establish it and what the consumer and upstream coordinators should each do next.

**Correct decision.** No: the three node-command sites (two bash blocks and the Actions run: line) are rewritten to the consumer path on delivery, and the fourth is a link label beside its own upstream URL with the consumer path named two lines later, so reason (2) is dead. The override's other rationale (plan links out of the shipped closure) is independent and must be judged separately, not dropped wholesale. Close the upstream report as not reproducing; make no rewriter change; the method is to render a disposable consumer and read the delivered bytes.

<details><summary>Response</summary>

> ## What the evidence establishes
> 
> **Items (a), (b), (c): the three `node scripts/persona-consistency-run.mjs` commands.** On a reading of the code, the reason is probably wrong here at `f48d9863`.
> 
> - All three source occurrences (lines ~136, ~417, ~610) match `COMMAND_REGEX`, including the `- run:` YAML line and the one ending in ` \`. The tail is captured cleanly as `persona-consistency-run.mjs`.
> - `rewriteTextCommandInvocations` then emits `node scripts/.[model]-skills/persona-consistency-run.mjs`, via `sourceRelToDestRel`.
> - The doc is in the sync file list (sync-to-repos.mjs:279-282), and `rewriteCommandSurface` runs on the write path (1571-1577) and on the expected-content path (1405-1413).
> 
> That conclusion depends on four things the excerpts do not show:
> 
> - **Ownership:** `scripts/persona-consistency-run.mjs` must be in `repo.files` for this consumer. `ownedSourceTails` is built per repo, and if the script is not there the rewriter is a deliberate no-op.
> - **Exceptions:** `isExplicitException` must not cover that script.
> - **Extension:** `TEXT_EXTENSIONS` must include `.md`. The header comment says it does, but the set itself is not shown.
> - **Write path:** nothing between line 1577 and the actual write may replace `outContent`.
> 
> **Item (d): the prose reference to `scripts/lib/redact.mjs`.** This is literally true but the complaint no longer holds.
> 
> - The rewriter only touches `node scripts/…` invocations, so this bare path is delivered unchanged.
> - However, it is the link text of a link to upstream's GitHub blob, where the source path is the correct one. It is not a command to paste.
> - The next sentence already says "In a consumer repo that module is synced to `scripts/.[model]-skills/lib/redact.mjs`", so the doc names the consumer path.
> - Still to confirm: that the module actually lands at that path in a consumer.
> 
> **Part 1: links to `docs/plans/`.** The excerpts neither support nor refute this. They cover about 35 lines of a 700-line doc and contain no such link. This is now the only part of the reason that could still justify the override.
> 
> **Timing.** The reason dates from 2026-09-04 and the base is 2026-11-14. It may have been accurate when written, with the rewriter coverage and the "In a consumer repo…" sentence arriving later. Nothing here shows which.
> 
> ## How I would establish it
> 
> 1. Create a disposable repo with `git init`. Give it the same file set or profile as the private consumer, or confirm `repo.files` does not differ between them, and no overrides.
> 2. Run `node scripts/sync-to-repos.mjs --target-path <repo>`.
> 3. In the delivered `docs/reference/consistency-contract.md`, run three greps:
>    - `grep -n 'node scripts/'`: every hit should be `scripts/.[model]-skills/…`. This also catches any variant the regex misses.
>    - `grep -n 'redact.mjs'`: confirm the consumer-path sentence survives.
>    - `grep -n 'docs/plans/'`: check whether each link target exists in the disposable repo.
> 4. Confirm `scripts/.[model]-skills/persona-consistency-run.mjs` and `scripts/.[model]-skills/lib/redact.mjs` exist, and that the rewritten command resolves the script.
> 5. Run `git log -S` on the doc and the rewriter to date when each item stopped being true, for the report's closing note.
> 
> ## Next steps
> 
> **Consumer coordinator**
> 
> - Do not leave the entry as written. After the test, rewrite the reason so it contains only what the delivered file actually shows.
> - If the `docs/plans/` links are dangling, keep the override but narrow it to that reason alone.
> - If they are not, remove the override.
> - Either way, diff the hand-maintained copy against the delivered doc. This is the authoritative `data-engine-*` contract, and a copy frozen since September may have drifted from what the shipped persona-test skill enforces.
> 
> **Upstream coordinator**
> 
> - Do not close the report on code reading alone. Attach the disposable-sync output.
> - If (a)–(c) are delivered rewritten, resolve them as fixed and cite the commit.
> - Resolve (d) as addressed by the consumer-path sentence, unless the consumer still objects to the wording.
> - If the `docs/plans/` links dangle in the delivered doc, treat that as a live upstream defect affecting every consumer. Track it in this report or a new one, and fix it by stripping the links, making them absolute, or shipping the targets.
> - If (a)–(c) are not rewritten, the report stays open and the fault is in the ownership list or exception map, not the doc.
> 
> ## Decision
> 
> The override should not stand as it is, because its recorded reason does not accurately describe what the sync delivers at `f48d9863`.
> 
> - **(a)–(c):** contradicted by the rewriter code (`COMMAND_REGEX`, `rewriteTextCommandInvocations`, `sourceRelToDestRel`, call site at sync-to-repos.mjs:1571), provided the script is bundle-owned and not an explicit exception.
> - **(d):** literally present, but it is a correct upstream link followed by an explicit statement of the consumer path, so it is not a paste hazard.
> - **Part 1 (`docs/plans/` links):** unverified from the evidence. It alone decides whether the override is narrowed to that reason or removed.
> 
> Confirm all of this with one real sync into a disposable consumer and the three greps on the delivered file. Then re-scope or drop the override accordingly, and close the stale items in the upstream report with that evidence. Keep the report open, or open a new one, only for whatever the delivered file still shows to be broken.

</details>

## 11. `c4a60856` — case `consumer-prepush-schema-behind-refusal`

**Question.** Decide what the consumer coordinator should do today, what the real cause is and whose bug it is, what to avoid doing, and what to change and where. Give your decision, how you would confirm the diagnosis before changing anything, and the next steps.

**Correct decision.** The store is not behind and the printed remedy must not be run. The hook runs the source checkout's audit with the consumer as cwd; assertStoreSchemaRealized defaults its root to process.cwd(), while the layout is read from the module path (source), so the migrations directory resolves to <consumer>/supabase/migrations, the consumer's own application schema, which is compared with the audit-loop ledger and reported permanently missing. Running --migrate would apply the application's DDL to the shared audit store. Fix upstream in this repo by defaulting the root to the bundle's own root (cwd stays an explicit override for tests), with a test that fails on the old default; do not override or patch the consumer.

<details><summary>Response</summary>

> **Short answer to the coordinator:** the store is not behind, do not run the printed command, and do not use `AUDIT_PREPUSH_ALLOW_UNMEASURED` as the fix. This is an upstream bug in this repo's schema precondition. For today, use the narrower override named in the error block itself.
> 
> ## What the code establishes
> 
> - **The root is the consumer's cwd.** `openai-audit.mjs:759` calls `assertStoreSchemaRealized()` with no arguments, so `cwd = process.cwd()`. Under the hook that is the consumer checkout, by design (`AUDIT_ALLOW_FOREIGN_CWD=1`).
> - **The layout is "source".** `resolveMigrationsDir(repoRoot)` takes its layout from `detectLayout()`, which reads the module's own install path. The hook runs the source checkout's copy, so the directory name is `supabase/migrations`.
> - **The two together pick the wrong directory.** Source-layout name joined to the consumer root gives `<consumer>/supabase/migrations`, which is the consumer's application schema. No app migration is in `public.audit_loop_migrations`, so the check returns `behind: true`, the audit exits 1, and hook v12 reports UNMEASURED.
> - **An earlier fix was incomplete.** The comment in `checkMigrationRealization` describes this exact failure and says it was fixed by dropping the layout argument. That fixed the layout half only. The root still comes from the caller, although `defaultRepoRoot()` exists precisely to resolve it "from THIS file rather than `process.cwd()`".
> - **Hook v12 is correct.** It did not cause this; it stopped hiding it. The store and the consumer's repo layout are not at fault either.
> 
> Two consequences follow:
> 
> - **Past pushes went unaudited.** This consumer's pushes have been unaudited since the precondition landed, not just since v12.
> - **Other consumers are affected differently.** A hook-driven consumer without `supabase/migrations` gets `no-migrations-dir`, so the check silently verifies nothing.
> 
> ## What is not established
> 
> - **What `setup-postgres.mjs --migrate` reads.** Its code is not in the excerpts. If it resolves migrations from cwd, running it from the consumer could apply private product DDL to the shared audit store. If it resolves from its own file, it is a no-op that leaves the error in place. Neither helps.
> - **Whether the run registers under the override.** The override's warning ("cannot be registered… `AI-Gate: not-run`") assumes the store really is behind. Here it probably is not, so registration probably works. However, the "runtime write guard" mentioned in the comments is not shown, and it could make the same cwd mistake.
> - **That the store is current.** This is reported, and the fact that upstream audits run against it is consistent with it, but I have not checked it directly.
> 
> ## Confirm before changing anything
> 
> 1. Run the audit CLI from the consumer checkout. The `dir` in the error should be under the consumer, and the "missing" names should be the consumer's app migration files, not audit-loop migrations.
> 2. Run the same command from a scratch directory with no `supabase/migrations`. It should proceed, which proves the cwd dependence.
> 3. Compare this repo's own `supabase/migrations` against the ledger, to confirm the store is current.
> 4. Read `setup-postgres.mjs` and grep for every caller of `checkMigrationRealization` and `resolveMigrationsDir` that passes a cwd, including the write guard.
> 
> ## What to do
> 
> **Consumer, today:**
> - Set the schema-behind override printed in the error block, per push in the shell and not in a profile. This lets the audit actually run and return a verdict.
> - On the first push, confirm that a verdict was produced and that the run row landed in the store.
> - Use `AUDIT_PREPUSH_ALLOW_UNMEASURED` only as a per-push last resort if that fails. It restores the pre-v12 state of pushing with no audit.
> 
> **Avoid:**
> - Running the printed migrate command.
> - Inserting rows into the ledger to make the check pass.
> - Moving or renaming the consumer's migrations.
> - Using `--no-verify`, reverting v12, or removing `AUDIT_ALLOW_FOREIGN_CWD`.
> - Pasting the consumer's error block (private migration names, DB descriptor) into this public repo.
> 
> **Upstream fix:**
> - In `schema-precondition.mjs`, make `assertStoreSchemaRealized` default to `defaultRepoRoot()` instead of `process.cwd()`.
> - Better still, have `checkMigrationRealization` derive root and layout together from the install path, so they cannot diverge.
> - Add a regression test using synthetic fixtures: a source-layout module, with cwd set to a foreign directory containing its own `supabase/migrations`, must compare the source bundle.
> - Fix any other cwd-passing callers found in step 4.
> - No hook regeneration is needed. Consumers pick up the fix by updating the sibling source checkout, then drop the override.
> - Notify other consumers.
> 
> ## Decision
> 
> This is an upstream bug in this repo. The precondition takes its layout from the module's install path and its root from the consumer's cwd, so it compares the consumer's application migrations against the audit-loop ledger (`openai-audit.mjs:759`, the `assertStoreSchemaRealized` default, and `resolveMigrationsDir`). The store is not shown to be behind. The consumer should not run `setup-postgres.mjs --migrate`, and should bridge today with the schema-behind override rather than `AUDIT_PREPUSH_ALLOW_UNMEASURED`, verifying on the first push that the run registers. Upstream fixes the root resolution to use `defaultRepoRoot()`, adds the foreign-cwd regression test, and keeps hook v12's UNMEASURED refusal as is.

</details>

## 12. `9a4eaeb0` — case `stale-override-four-sites`

**Question.** Decide whether the override's recorded reason accurately describes what the sync delivers to a consumer, whether the override should stand as it is, and what should happen to the open upstream report. Say how you would establish it and what the consumer and upstream coordinators should each do next.

**Correct decision.** No: the three node-command sites (two bash blocks and the Actions run: line) are rewritten to the consumer path on delivery, and the fourth is a link label beside its own upstream URL with the consumer path named two lines later, so reason (2) is dead. The override's other rationale (plan links out of the shipped closure) is independent and must be judged separately, not dropped wholesale. Close the upstream report as not reproducing; make no rewriter change; the method is to render a disposable consumer and read the delivered bytes.

<details><summary>Response</summary>

> ## What the evidence establishes
> 
> **The doc is synced and passes through the rewriter.** `docs/reference/consistency-contract.md` is in the sync list (`sync-to-repos.mjs:279-282`). The write path runs `rewriteCommandSurface` on the outbound content (`:1571-1577`).
> 
> **Claims 2(a)–(c) describe the upstream source, not what the rewriter should deliver.** The source does contain `node scripts/persona-consistency-run.mjs` in all three places:
> 
> - Parity-probe block (132-138)
> - Setup block (412-420)
> - Actions `- run:` line (604-611)
> 
> Each one matches `COMMAND_REGEX`. The tail stops at whitespace, so the trailing `\` continuation and the `- run:` prefix do not interfere. If the tail is owned, `sourceRelToDestRel` turns it into `node scripts/.[model]-skills/persona-consistency-run.mjs`.
> 
> **Claim 2(d) is not handled by the rewriter, but the source already addresses it.** The rewriter only touches `node scripts/…` invocations, so a bare prose path is never rewritten. However, at `f48d9863` the passage (690-698) links `scripts/lib/redact.mjs` to an absolute GitHub URL, which is correct for upstream source. It then says "In a consumer repo that module is synced to `scripts/.[model]-skills/lib/redact.mjs`." That is not a copy-paste hazard.
> 
> ## What it does not establish
> 
> - **Ownership of the script.** The rewrite only fires if `scripts/persona-consistency-run.mjs` is in `repo.files` and is not an explicit exception. Neither the file list entry nor `isExplicitException` is shown. If the script is not owned for that consumer, the command stays unrewritten and would not work under either path.
> - **`.md` handling.** The comments imply `.md` is in `TEXT_EXTENSIONS`, but the set itself is not shown.
> - **Part 1 of the reason.** None of the excerpts shows a `docs/plans/` link. I cannot say whether those links exist, whether they are relative (broken in a consumer) or absolute, or whether plans are shipped.
> - **History.** I cannot tell whether the report was accurate on 2026-09-04 and fixed since, or was written from the upstream source rather than a delivered file. That changes how the report is closed, not what to do.
> 
> ## How I would establish it
> 
> 1. Run the real sync into a fresh disposable consumer and read the delivered doc. I expect:
>    - zero hits for `node scripts/persona-consistency-run.mjs`;
>    - hits for `node scripts/.[model]-skills/persona-consistency-run.mjs` at the three sites;
>    - the redact passage naming the `.[model]-skills` path;
>    - `scripts/.[model]-skills/persona-consistency-run.mjs` actually present in the delivered tree.
> 2. In the same delivered file, grep for `docs/plans/`. Classify each hit as a relative link (dead in the consumer) or an absolute URL.
> 3. Confirm the disposable repo's file set matches what the private consumer would receive, since `ownedSourceTails` is built per repo.
> 4. Run `git log` on the rewriter and on the four doc passages to date the fix against 2026-09-04.
> 
> ## Next steps
> 
> **Consumer coordinator**
> 
> - Diff the delivered file against the hand-maintained copy.
> - If the `docs/plans/` links are also absent or harmless, remove the override and take the synced copy. Upstream any local-only content first.
> - If the dead plan links are real, keep the override but rewrite its `reason` to that single ground and drop the four-places claim.
> - Either way, the current reason should not remain. A frozen copy of the authoritative annotation contract silently drifts, and this one has been frozen for over two months.
> 
> **Upstream coordinator**
> 
> - Do not close the report on code reading alone. Attach the run output (commit, grep results) and close the four-places item as fixed or not reproducible, according to the git history.
> - If step 2 finds dead plan links, track that as its own item and fix it by shipping the plans, using absolute links, or stripping them.
> - Note the residual gap: bare prose paths are never rewritten. Item (d) was fixed by hand in this doc, and other shipped docs may have the same problem.
> - Consider a sync test asserting that no owned `node scripts/<tail>` survives in delivered docs.
> 
> ## Decision
> 
> Part 2 of the override's reason most likely does not describe what the sync delivers at `f48d9863`. The three command invocations match `COMMAND_REGEX` and should be rewritten to `scripts/.[model]-skills/…`, and the redact prose already names the consumer path. This is a code-reading conclusion, conditional on the script being in `repo.files`. The sync run into a disposable consumer is what confirms it.
> 
> Part 1 (the `docs/plans/` links) is unverified by the excerpts and is settled by the same run.
> 
> The override should not stand as it is. Remove it if part 1 also fails. Otherwise narrow its reason to part 1 only.
> 
> The upstream report should be closed for the four-places claim once the delivered-file evidence is attached. Any real plan-link problem should be split into its own report.

</details>

## Marks

| # | grade id | Your verdict (Y/N) |
|---|---|---|
| 1 | 7a5f91ef |  |
| 2 | 4692d66e |  |
| 3 | 9133744a |  |
| 4 | 64dc31fb |  |
| 5 | 350d14b4 |  |
| 6 | b3455ebe |  |
| 7 | 08fe9566 |  |
| 8 | 284d3e1d |  |
| 9 | ca169519 |  |
| 10 | fe4ee2c2 |  |
| 11 | c4a60856 |  |
| 12 | 9a4eaeb0 |  |

<details><summary>Judge labels — open only after every verdict above is filled</summary>

| # | grade id | Judge (both passes) | Passes split |
|---|---|---|---|
| 1 | 7a5f91ef | N | - |
| 2 | 4692d66e | Y | - |
| 3 | 9133744a | Y | - |
| 4 | 64dc31fb | N | - |
| 5 | 350d14b4 | Y | - |
| 6 | b3455ebe | Y | - |
| 7 | 08fe9566 | Y | - |
| 8 | 284d3e1d | Y | - |
| 9 | ca169519 | N | - |
| 10 | fe4ee2c2 | N | - |
| 11 | c4a60856 | N | - |
| 12 | 9a4eaeb0 | N | - |

</details>

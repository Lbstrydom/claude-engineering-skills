# Spot sample — rehearsal

Blinded. For each response, read the question and the correct decision, then the response,
and write **Y** (reaches the correct decision) or **N** in the table at the end.
The judge labels sit in a collapsed block AFTER the marks table: do not open it until every row is filled.

## 1. `6f202c5f` — case `sdk-pin-max-tokens-review`

**Question.** Review this pin change as a coordinator deciding whether PR #360 is safe to merge at this step. The code at each moved site is described as otherwise unchanged: is that enough to conclude the pinned sites still behave correctly? State your verdict on the change, what you would check or change before merge, and what the coordinator should do next.

**Correct decision.** Not safe as is: the pin changes max_tokens semantics from accepted-and-ignored (cli) to enforced (sdk), and with a model that spends output on a thinking block a 64-token cap leaves no text block, while content[0].text reads the wrong block, so labels silently become underived (100% failure hidden by graceful degradation). Re-measure every cap at the moved sites, read the first text block via one helper at the seam, and surface stop_reason when no text arrives.

<details><summary>Response</summary>

> ## Verdict
> 
> **No, "the code at each site is otherwise unchanged" does not establish that the pinned sites behave correctly.** The claim is about source text. The behavior of each call changes at runtime, on the maintainer's machine, in several ways the diff does not show. The pin direction is probably right, but PR #360 should not merge on this step until the items below are checked and the behavior change is written down.
> 
> ## What the evidence establishes
> 
> - **The diffs are small and consistent.** Each of the four shown files changes only the client construction (`{backend:'sdk'}`) and the availability gate (`isClaudeAvailableFor('sdk')`). The message bodies (`system`, `messages`, `max_tokens`, model) are untouched.
> - **The gate logic matches the stated problem.** On a keyless cli install, `isClaudeAvailable()` returns true, so a pinned site would have passed its gate and then thrown `ANTHROPIC_API_KEY required`. Switching the gates to `isClaudeAvailableFor('sdk')` addresses that.
> - **CI is mostly unaffected.** CI already runs the `sdk` default, so for CI the pin is close to a no-op. The 2595-test preflight therefore says little about the cli-ambient behavior that the pins change.
> - **The judge's rationale is credible.** The old judge path let the cli agent persona override `system`, so transport failures could be scored as `conformant: false`. The pin removes that path.
> 
> ## What the evidence does not establish
> 
> **1. The change is not behavior-neutral on the maintainer's machine.** Each moved site changes on a cli-ambient machine:
> - **Transport:** from `[model] -p` to the Messages API.
> - **Meter:** from the [model] Code login to a metered API key. The commit message itself says the meter changes.
> - **Auth requirement:** a keyless machine that ran these calls before now either throws (judge, which has no gate) or skips silently (labels, refine-prompts, brief).
> - **`system` honored:** the cli agent persona no longer overrides it.
> - **`max_tokens` enforced:** the warning shows the cli ignored it (1995 output tokens against a cap of 200). On sdk the caps now bite, so output distributions change. The judge at 4000, refine at 2000 and labels at 64 each need a truncation check.
> - **Output comparability:** historical cli outputs, including judge scores and `provenance.backend: 'cli(default)'` rows in `solo-control-audit`, are not comparable with new sdk outputs without a provenance boundary.
> 
> **2. The six-site claim is not verified by the shown diff.** The message says there were six unpinned sites, and the four shown files account for four. `evolve-prompts.mjs` and `solo-control-audit.mjs` are not in the shown diff. Their pins, and the `indirectPins` entry for `evolve-prompts`, are unverified. The `indirectPins` escape is also described as "verified by re-reading the named options function," which I have not seen.
> 
> **3. The availability oracle is not shown.** `isClaudeAvailableFor('sdk')` must check for the key that the sdk leg needs, and must not be a backend-name check. Its semantics are asserted but not shown.
> 
> **4. The judge has no availability gate.** `callJudgeDefault` constructs the sdk client directly. On a keyless machine it will throw. Whether that throw becomes a recorded `conformant: false`, which would silently poison an arm comparison, depends on the catch around the judge call. That catch is not in the evidence.
> 
> **5. Spend and budget.** `context.mjs` gates the [model] leg on `budgetFor('[model]')`. Moving the labeller, refine and judge calls to the metered API could push real spend on the maintainer's account, and the PR does not say so in a cost note.
> 
> **6. Brief provenance.** On a keyless cli install, the brief now falls through to Gemini rather than [model]-via-cli. That is the intent, but the brief's recorded model and any downstream comparisons need to reflect it.
> 
> ## What I would check or change before merge
> 
> 1. **Show the remaining diffs and the gate's `indirectPins` logic.** Confirm all six sites are pinned, and run `npm run [model]:pin:gate` on the PR branch and on a planted unpinned file.
> 2. **Show `isClaudeAvailableFor`.** Confirm it checks the key for sdk and is independent of ambient backend. Add a test: `CLAUDE_BACKEND=cli` with no key, call each gate, and assert the gate returns false without throwing.
> 3. **Harden the judge.** Add an explicit availability check, or fail loud (not `conformant: false`) on a missing key or transport error, so a configuration failure cannot be scored as a model verdict. Check `stop_reason` and treat `max_tokens` truncation as an error.
> 4. **Check `max_tokens` truncation.** For each pinned site, record `stop_reason`. Make sure labels truncated at 64 tokens are still handled by `sanitizeLabel`, and that judge JSON truncated at 4000 is reported as an error, not as "no JSON".
> 5. **Add a provenance boundary.** Mark pre-pin cli results (judge scores, `cli(default)` rows) as a different provenance, and do not compare them across the boundary without a re-run or a note.
> 6. **Write a cost note.** Estimate the API spend shift for a typical arm-eval and label run. Get explicit maintainer sign-off that moving these calls onto the metered meter is intended.
> 7. **Smoke test on both configurations.** Run each pinned site on a maintainer-like machine with and without a key (`CLAUDE_BACKEND=cli`), plus CI's `sdk` default. Check the outputs, not just exit codes.
> 8. **Check the tests.** Confirm at least one test asserts that a pinned call reaches sdk when `CLAUDE_BACKEND=cli` is set. Stubbed client tests may not exercise the pin.
> 
> ## What the coordinator should do next
> 
> - Do not merge #360 on the basis of "code unchanged." Ask the author for the remaining diffs, the oracle definition, and a short behavior-change note covering transport, meter, auth, max_tokens, and provenance.
> - Route the judge hardening and the cost sign-off to the owners of arm-eval and the maintainer.
> - Once items 1–8 are satisfied, the pin change can merge. Record in the PR description that cli-ambient behavior changed for these sites and that historical cli results are a separate provenance.
> 
> ## Decision
> 
> **Not safe to merge at this step as presented.** The pin direction is defensible: `system` is a billable contract the call site never chose a transport for, and the sdk path is the one CI already tests. But "the code at each site is otherwise unchanged" does not show that the pinned sites behave correctly. Each moved site changes transport, meter, auth requirement, `max_tokens` enforcement and output distribution on any cli-ambient machine. The evidence does not verify the six-site coverage, the availability oracle, the judge's failure mode, or the spend shift. Hold the merge until those are checked and the behavior change is documented, then merge with the provenance boundary recorded.

</details>

## 2. `5a6e0b15` — case `sync-manifest-ratchet-report`

**Question.** Is the reported diagnosis (that the sync records the hash it intended to write for paths it refused, re-asserting a false base) correct? Decide what the coordinator should conclude, what should be reproduced or checked before anyone changes anything, what the real defect is if there is one, and whether anyone should hand-repair the consumer's manifest. Give your decision and the next steps.

**Correct decision.** Not a ratchet: for refused/held paths the manifest keeps the last hash the sync actually wrote, so manifest != disk is the intended divergence signal; the report's evidence cannot distinguish that from the claimed bug. Do not repair the manifest to disk hashes (that is the earlier defect that turns refusal into overwrite). The real defect is the one-shot "upstream moved" warning, computed against the previously rewritten receipt instead of the manifest base. Only the refusal path may be claimed as reproduced.

<details><summary>Response</summary>

> ## Verdict
> 
> The diagnosis is not correct as stated, at least for `main@d0f3d8f5`. The code does not write the intended hash for refused paths. The reporter's symptoms are real, but the report's reading of them is probably wrong, and the storyline evidence cannot yet distinguish the explanations. I would not change the sync or touch storyline's manifest until the checks below are done.
> 
> ## What the code shows
> 
> 1. **Refused paths carry the prior base, not the intent.** In the manifest writer (`sync-to-repos.mjs:1837-1867`), every destination in `divergenceRefusals`, `receiptOverridesHeld`, `failedWrites` or `skippedWrites` goes through the `notWrittenByUs` branch. That branch sets `consumerFileMap[dstRel] = priorFiles[dstRel]` (or the legacy source-keyed lookup), and only if the file still exists. The new hash of the bundle file is never computed for these paths. The `continue` skips the disk-hash line, so no intended value is ever written.
> 
> 2. **Held paths get the same treatment.** Override-held paths also sit in `notWrittenByUs`, so the claim that "the manifest holds upstream's intent" fails for held paths too.
> 
> 3. **The key set cannot grow through refusals.** Keys are only added from `intendedDests`, and a refused key is only kept if it already had a carried value and the file exists. A refusal with no prior record adds nothing. So the "frozen set can only grow" claim is not supported by this code.
> 
> 4. **Gate 2B does see the disagreement.** A manifest/disk mismatch fails 2B unless (a) the path is the receipt and structurally valid, or (b) `matchOverride` holds it. Case (b) returns `pass: true` with `details.held` listing the path. So 8/8 green with 11 disagreeing paths most likely means 11 held paths, not a blind verifier. This is a weakness (see below), but it is not "cannot see it".
> 
> 5. **`verify-sync-invariants` was not provided.** The claim that it only checks existence and parse is unverified here.
> 
> ## What the evidence does not establish
> 
> - **Whether `29ec5697` is a false base.** Under the code, `29ec5697` is the last hash the sync recorded when it wrote the file. It is a true base if it equals a historical upstream version of `.vscode/mcp.json`, and the consumer later edited the file to `d884e509`. It would be a real anomaly only if it matches no upstream version the sync ever wrote, or if it matches the current upstream while the consumer's file was never written by the sync.
> - **Version skew.** The report may come from a sync version other than `d0f3d8f5`. Storyline's receipt `source.commitSha` and the copy of `sync-to-repos.mjs` it actually runs need to be checked.
> - **Which 11 paths.** I don't know whether they are all in `.sync-overrides.json`, which would make the verifier's green result correct.
> - **Why `d884e509` was refused.** The receipt's `divergenceRefused` reason and `staleSyncRef` would show this.
> 
> ## What to reproduce before changing anything
> 
> Use a fresh disposable consumer and a scratch copy of the upstream repo where I can alter a bundle file.
> 
> 1. **Sync 1** writes the file. Record the manifest hash H0 and confirm it equals the disk hash.
> 2. **Consumer edit.** Change the file on disk (to E1). Run **sync 2** with no upstream change. Expected: refused as diverged, manifest still H0, disk still E1, receipt has a `divergenceRefused` entry.
> 3. **Upstream change.** Alter the source file in the scratch repo (to U2). Run **syncs 3 and 4**. Expected: still refused, manifest still H0 on every run, the intended hash of U2 never appears in the manifest, and the set of manifest keys is unchanged.
> 4. **Override variant.** Add an override for the path and run again. Expected: manifest still H0 (held paths are also in `notWrittenByUs`), gate 2B passes with the path in `held`, and the receipt's `overridesHeld` shows `upstreamMoved: true` after the upstream change.
> 5. **Gate and invariants.** Run the verifier after each step and capture `details`. Also run `verify-sync-invariants` and read its source, since it was not supplied.
> 
> If the disposable run shows the manifest holding the intended hash, the diagnosis is confirmed and the code I was given is not what is running. If it shows H0 stable, the diagnosis is refuted for this version.
> 
> ## What to check in storyline
> 
> - `git log -p -- .vscode/mcp.json` in storyline, to see whether the consumer committed `d884e509` or whether it is a local edit.
> - Hash `.vscode/mcp.json` at every upstream commit that touched the source file, and match `29ec5697` and `d884e509` against them. If `29ec5697` matches an earlier upstream version, the base is genuine.
> - The receipt history: `divergenceRefused` and `overridesHeld` for this path over time, and the `source.commitSha` of each entry.
> - `.sync-overrides.json` and the 11 paths; the verifier's `details.held` list.
> - The version of `sync-to-repos.mjs` storyline ran, compared with `d0f3d8f5`.
> 
> ## Real defects worth fixing, whatever the storyline result
> 
> 1. **Gate 2B passes override-held drift with no staleness check.** A standing override can mask upstream movement indefinitely. The sync already computes `upstreamMoved`, but the gate does not read it. The gate should at least report the held count and flag `upstreamMoved` in the summary.
> 2. **The receipt records no base hashes.** The manifest is gitignored and the receipt holds paths but not hashes, so the origin of `29ec5697` cannot be audited from anything committed. Recording the base hash per refused or held path in the receipt entry would make this kind of report checkable.
> 3. **Stale-edit classification.** If `d884e509` equals an earlier upstream version, the path should be classified as stale and overwritten, not refused. The `priorUpstream.matches` check only runs when `rewriteResult.hits` is empty and `vcs` is non-null, so this path needs a look.
> 
> ## Should anyone hand-repair the manifest?
> 
> No. Hand-editing is harmful in both directions.
> 
> - **Setting the entry to the disk hash (`d884e509`)** makes the consumer's local edit look like the recorded base. `classifyAgainstBase` would then call the file pristine, and the next sync would overwrite the consumer's edit with upstream content without a refusal.
> - **Setting the entry to the current upstream hash** records a base the consumer never had, so the record becomes a lie in the opposite direction, and the next sync's classification becomes meaningless for that path.
> 
> The correct resolution is a decision by the storyline consumer:
> 
> - revert the local edit, so the next sync overwrites normally; or
> - declare an override with a reason in `.sync-overrides.json`, so the state is explicit and the receipt tracks `upstreamMoved`.
> 
> If the reproduction shows the sync refusing a file that should be classified as stale, the fix belongs in the sync's classification, followed by a normal sync run, not a manifest edit.
> 
> ## Message back to storyline
> 
> Tell them the manifest does not hold intent for refused paths, that the next step is to check whether `29ec5697` matches a historical upstream version, and that they should not hand-edit the manifest. Ask for the receipt's `divergenceRefused` reason for `.vscode/mcp.json`, the override file, the list of 11 paths, and their sync script's version.
> 
> ## Decision
> 
> The reported diagnosis is **not** supported by the code at `main@d0f3d8f5`. For refused and held paths, `sync-to-repos.mjs:1837-1867` carries forward the prior recorded hash and never writes the intended hash, and refusals cannot grow the manifest key set. The verifier's gate 2B fails on any mismatch unless the path is structurally a valid receipt or covered by an override, so the 8/8-green result probably reflects 11 held paths. The genuine concerns are that gate 2B does not check `upstreamMoved` for held paths, that the receipt records no base hashes so the origin of `29ec5697` cannot be audited, and that a stale-edit misclassification is possible.
> 
> Before changing anything: reproduce the refuse, hold and consecutive-sync behaviour in a disposable consumer; check storyline's receipt, override file, git history and sync version; and match `29ec5697` and `d884e509` against upstream history. Do **not** hand-edit storyline's manifest, since setting it to the disk hash would cause the next sync to overwrite the consumer's local edit. The consumer should choose between reverting the edit and declaring an explicit override.

</details>

## 3. `9b450557` — case `check-ignore-ci-cause-string`

**Question.** Diagnose this CI-only failure, where a test pinned to one cause string in a degraded-scan warning sees a different cause string on the runner than it does locally and on main. Decide whether to re-run it as a flake, loosen or retarget the assertion, or change the code, and say what the code should report. Give your decision and the next steps, including who is affected.

**Correct decision.** A real race, not a flake: git check-ignore --stdin outside a work tree exits 128 without reading stdin while spawnSync is still writing, so the parent sees either status 128 or EPIPE depending on platform/load. Fix the cause reporting in code (a non-zero status other than 0/1 wins over the write error; a write error with status 0/1 keeps its own code) and leave the test unchanged; the loud degradation held either way. Not a re-run and not a loosened regex.

<details><summary>Response</summary>

> ## Diagnosis
> 
> **What failed.** The first subtest expects `stderr` to match `could not determine gitignore status (git exit 128)`. The runner printed `could not determine gitignore status (EPIPE)`. The degraded path was taken in both cases, so the classification is right. Only the cause label differs, and the test pins that label.
> 
> **Mechanism.** `ignoredUntrackedPaths` writes the candidate list to `git check-ignore --stdin`. In a non-work-tree scratch root, git exits 128 almost immediately. Whether Node's write to the child's stdin lands before the child closes its end of the pipe is a timing race:
> 
> - If git has already closed stdin when Node writes, the write fails with EPIPE. `spawnSync` then populates `ign.error` in addition to `ign.status`.
> - The warning builder checks `ign.error` first: `${ign.error ? ign.error.code || ign.error.message : \`git exit ${ign.status}\`}`. So when `error` is set, the real exit status (128) is discarded and only `EPIPE` is reported.
> - If the write wins the race, as it apparently does on the Windows machine and in main's recent runs, `error` is unset and the message says `git exit 128`.
> 
> This explains the pattern. The code is byte-identical on main, so the PR did not cause the failure. The runner's timing exposed the race, and main's green runs were the non-EPIPE side of it.
> 
> **A second defect in the same output.** The coverage line reads `1/1 eligible source files cruised (100.0%) ... 0 disowned`. That is the same shape a verified clean scan would print. The `degraded` flag and warning are on the wire, but the human-readable line presents an unverified scan as complete with zero disowned files. The module's own docstring says this is the outcome to prevent. It is a separate fix from the flake, but it belongs in the same change.
> 
> **What the evidence does not establish.**
> - I have not reproduced the EPIPE on Linux. The race is inferred from the message and the code path, not observed.
> - I have not confirmed that `ign.status` is populated when `ign.error` is EPIPE. My reading of `spawnSync` is that the child did run and exit, so status should be 128, but this needs checking.
> - The second subtest (the wire assertion) was never reached, so I don't know whether it would also fail. Its `/128/` check on `l.warning` would fail for the same reason.
> - I have not checked whether any consumer parses the warning text for `EPIPE` or `git exit`.
> 
> ## Decision
> 
> This is not a flake to re-run, and the assertion should not simply be loosened to accept `EPIPE`. Accepting `EPIPE` would hide that the warning drops the real cause, which is the thing the test is meant to pin: a non-work-tree root, git exit 128.
> 
> The fix is in the code:
> 1. In `ignoredUntrackedPaths`, report `git exit ${status}` whenever `status` is non-null, and report the error code only when there is no status (for example, ENOENT when git is missing). When both exist, the message can carry both, for example `git exit 128; stdin closed early (EPIPE)`.
> 2. Keep `degraded: true` and the empty `paths` set exactly as they are. This is not a change to what counts as disowned, so `OWNERSHIP_RULE_EPOCH` stays at `ignored-untracked-v1`.
> 3. Change the coverage line so that a degraded scan does not print `0 disowned` without qualification. It should say the ownership check was unverified.
> 4. Keep the test pinned to `git exit 128`. Add a unit test that forces the EPIPE path (for example, a child that exits before reading stdin, or a large stdin write into a process that exits) and asserts the status is still reported.
> 
> ## Next steps
> 
> 1. Reproduce on Linux or WSL. Loop `ignoredUntrackedPaths` in `/tmp` a few hundred times and log `ign.error?.code` and `ign.status`. Also record the git and Node versions on the runner and locally.
> 2. Apply the cause-selection change and the coverage-line wording change.
> 3. Add the forced-EPIPE unit test and keep the existing subtests.
> 4. Grep consumer repos for `could not determine gitignore status`, `EPIPE`, and `git exit` to find any code or tests that parse the text.
> 5. Re-run `full-suite` on the PR. Don't rely on a re-run alone to go green.
> 6. Sync the fixed `disowned-paths.mjs` to consumers through the normal sync path.
> 7. Track the unrelated `skill-command-blocks-parse-under-powershell` failure separately. It is not part of this diagnosis.
> 
> **Who is affected.**
> - The PR #359 author, whose branch is red on a failure that is not caused by their change.
> - The Windows-based maintainer, who will see green locally and may be confused by the CI result.
> - Every consumer repo that has synced `disowned-paths.mjs`, including the file scanner, the doctor, and `debt-ledger`. Their warning text changes, and they get the corrected coverage wording.
> - Anyone running the scanner from a temp directory, where the degraded path is most likely to be hit.

</details>

## 4. `eafd6c7f` — case `cli-system-honour-claim`

**Question.** PR #360 refuses `system` on the `cli` transport and justifies it with a stated property of that transport (the oracle's `why` string, its docblock and the plan table). Judge that stated property against the code and the measurements in the context: is it accurate as worded, what exactly can be claimed, and should the choice between throw / warn / route-to-sdk change? Give your decision on the PR's claim and the policy, and say what the coordinator should do next.

**Correct decision.** The wording is overstated: the cli adapter DOES pass system (--system-prompt) and a simple instruction can be obeyed; for a structured-output contract the Claude Code persona plus the ~164K-token context outranks it, unpredictably by prompt (real prompt 0/4, shortened variant 3/3). tools/tool_choice are the params genuinely dropped. The throw/pin stays, justified by the seam deciding from params alone, not by "ignored"; the oracle strings and docs should be restated with the figures and guarded by a test.

<details><summary>Response</summary>

> ## Verdict
> 
> Do not merge PR #360 with its current justification. The refusal itself can stand, but the stated property is wrong in its verb ("drops"/"ignores") and overstated in its scope and mechanism. Rewrite the reason to match what was measured, and keep `throw` for `system` as a policy choice that is openly labelled as such.
> 
> ## What the code establishes
> 
> - **`tools` / `tool_choice`: accurate.** The adapter always spawns `--tools ''` and never forwards `params.tools` or `tool_choice`. A forced tool call gets a text block with no error. This is a structural fact about the argv, so presence-based refusal is justified.
> - **`system`: not dropped.** The adapter forwards a string `system` as `--system-prompt` (`effectiveSystem`, then `args.push('--system-prompt', …)`). The PR description's "drops" / "ignores" is therefore false. The accurate verb is "forwards it but does not reliably honour it." That is a different and weaker property, and it has different remedies.
> - **Array-form `system`:** the refusal reason says the cli backend "does not honour a structured system block as an instruction." The adapter's handling of arrays is in the elided part of the excerpt (`effectiveSystem` is only shown for the string case). Until I see that branch, I cannot confirm whether arrays are silently dropped or flattened. The refusal is defensible either way, but the wording should match the actual behaviour.
> 
> ## What the measurements establish
> 
> - On one prompt shape (normalize-intent, `max_tokens: 200`), one model (`[model]-[model]-5-5`) and one machine, cli produced 1995, 2254, 2784 and 2248 output tokens, with agentic answers ("I haven't changed anything…", "I couldn't make the change…"). sdk produced one-line answers in 29 and 43 tokens. That is solid evidence that, for this shape, cli does not behave as a terse one-shot completer.
> - A shortened three-sentence replica of the same instruction returned a correct one-line answer 3/3, at 466–673 output tokens. So the system instruction was honoured in those runs, at high cost. The failure is conditional on prompt shape, not categorical.
> 
> ## What the evidence does not establish
> 
> 1. **The mechanism is not isolated.** The docblock says the persona and the ~164k-token context "outrank" `system`. Both were present in every run, and `--bare` cannot be used to separate them because it returns "Not logged in" here. The causal story is a hypothesis.
> 2. **The refusal is keyed to the wrong variable.** The persona and context are present on every cli call, including calls with no `system` at all. The measurements never tested a user-only call carrying the same text. If the agentic behaviour appears there too, then "`system` is the cause" is false and the refusal boundary is arbitrary. The rule only tells us that `system` is the parameter the measured callers happened to use.
> 3. **The cost framing mixes two things.** The "~500–1000× cost" figure uses notional per-call self-reported dollars. cli spends a flat-rate Max credit, so the real cost is credit consumption, latency and quota. The argument is still valid, but it should be stated in those terms.
> 4. **Single-run sample.** The sdk leg is n=2 and the cli leg n=4 on one model. This is enough to show a pattern, not to set a general rule about `system`.
> 5. **Unverified citations.** The "20/20 runs fell back to legacy" claim (AGENTS.md) and the arm-eval judge scoring its own transport failure as `conformant: false` are cited but not in the context. Both need their run records before they are used as justification.
> 
> ## Throw / warn / route-to-sdk
> 
> - **Throw for `tools` / `tool_choice`:** clearly correct. The answer is structurally the wrong shape and cannot be served by cli.
> - **Throw for `system`:** defensible, but on different grounds than the PR gives. The strongest reason is that a consumer such as arm-eval cannot tell a transport failure from a model failure when cli returns the wrong kind of answer. A silent misscore is worse than a refusal. Warning does not help here: the max_tokens warning fires once per session, and nothing downstream can act on it.
> - **Warn for `max_tokens`:** remains right, because every caller sets it and refusing would void the operator's transport choice. The real safeguard is consumers reading `stop_reason`, as `assessBatchCompleteness` does.
> - **Route to sdk silently:** still rejected. Choosing a billing meter from a param the call site never connected to billing is the wrong design. The explicit `{backend:'sdk'}` pin, with its gate, keeps the decision visible.
> 
> The cost of throwing on `system` is that short-system calls which cli could serve (3/3 in the replica) will now need an sdk pin, which moves their spend off the Max credit. Accept that consciously and track the moved sites through the pin gate.
> 
> ## Changes required before merge
> 
> 1. Replace "drops" / "ignores" in the PR description with "forwards `system` as `--system-prompt`, but does not reliably honour it on measured prompt shapes."
> 2. Rewrite the `system` `why` string and the docblock. State the measured scope (shape, model, n), the observed ratios, and the short-replica counter-evidence. Mark the persona/context explanation as a hypothesis unless it is isolated.
> 3. Remove or qualify the "outrank" claim in the oracle and in the plan table.
> 4. Correct the cost language to credit/latency terms, or label the dollar figures as notional.
> 5. Confirm the array-`system` behaviour from the adapter's elided branch and make the wording match it.
> 
> ## Next steps
> 
> 1. **Test the user-only case.** Send the normalize-intent text as the user message with no `system`, and check for the same agentic answers. If it shows them, the refusal should move from `system` presence to a behavioural predicate or a broader cli-unsuitable rule. If it does not, the `system`-keyed refusal is a defensible proxy.
> 2. **Isolate context from persona.** Run `[model] -p` from a directory with no project memory files, if discovery is cwd-scoped, and record the context token count per run. This is the only way to test "context outranks instruction" without `--bare`.
> 3. **Extend the short-system test.** Run the short replica across more prompts and at least one other model, to find where the instruction stops being honoured. Only then consider a narrower predicate.
> 4. **Pull the cited run records** for the 20/20 tiered-recall fallback and the arm-eval misscoring, and link them from the plan.
> 5. **Keep the throw**, merge after the wording changes, and record which call sites are pinned to sdk and why.
> 
> ## Decision
> 
> **Do not merge PR #360 as written.** The refusal of `tools` and `tool_choice` on `cli` is correct and should merge. The refusal of `system` should merge only with its rationale rewritten. The PR's claim that `cli` "drops" or "ignores" `system` is contradicted by the adapter, which forwards it as `--system-prompt`. The measurements support a narrower, conditional claim: on the measured normalize-intent shape (one model, n=4), `cli` did not honour the instruction and produced agentic answers at 52–96× the sdk output tokens, while a shortened replica was honoured 3/3. The persona/context mechanism is unisolated, and the refusal keys on `system` presence without testing user-only calls. Keep `throw` for `system` as an explicit policy choice, justified by silent misscoring in consumers such as arm-eval, and do not route silently to sdk. Run the user-only and context-isolation checks before any predicate is narrowed.

</details>

## Marks

| # | grade id | Your verdict (Y/N) |
|---|---|---|
| 1 | 6f202c5f |  |
| 2 | 5a6e0b15 |  |
| 3 | 9b450557 |  |
| 4 | eafd6c7f |  |

<details><summary>Judge labels — open only after every verdict above is filled</summary>

| # | grade id | Judge (both passes) | Passes split |
|---|---|---|---|
| 1 | 6f202c5f | Y | - |
| 2 | 5a6e0b15 | N | - |
| 3 | 9b450557 | N | - |
| 4 | eafd6c7f | Y | - |

</details>

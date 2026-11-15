# Spot sample — variance

Blinded. For each response, read the question and the correct decision, then the response,
and write **Y** (reaches the correct decision) or **N** in the table at the end.
The judge labels sit in a collapsed block AFTER the marks table: do not open it until every row is filled.

## 1. `9b450557` — case `check-ignore-ci-cause-string`

**Question.** Diagnose this CI-only failure, where a test pinned to one cause string in a degraded-scan warning sees a different cause string on the runner than it does locally and on main. Decide whether to re-run it as a flake, loosen or retarget the assertion, or change the code, and say what the code should report. Give your decision and the next steps, including who is affected.

**Correct decision.** A real race, not a flake: git check-ignore --stdin outside a work tree exits 128 without reading stdin while spawnSync is still writing, so the parent sees either status 128 or EPIPE depending on platform/load. Fix the cause reporting in code (a non-zero status other than 0/1 wins over the write error; a write error with status 0/1 keeps its own code) and leave the test unchanged; the loud degradation held either way. Not a re-run and not a loosened regex.

<details><summary>Response</summary>

> # Diagnosis: `git exit 128` reported as `EPIPE` in the degraded-scan warning on Linux CI
> 
> ## What the failure shows
> 
> The warning on the runner has the right shape and the wrong cause. It reads `could not determine gitignore status (EPIPE)` where the test expects `(git exit 128)`. The scan was still marked degraded, and the rest of the warning text is unchanged.
> 
> The warning builder picks its cause in this order:
> 
> ```js
> `(${ign.error ? ign.error.code || ign.error.message : `git exit ${ign.status}`})`
> ```
> 
> So on this run `spawnSync` returned an `error` with code `EPIPE`, and that took precedence over the exit status.
> 
> `EPIPE` from `spawnSync` here has only one plausible source: Node writing the `input` (the NUL list) to git's stdin after git had already closed its end. Neither reaching for `ENOENT` (git missing) nor `ENOBUFS` (output overflow) fits that code.
> 
> That matches the scenario the test sets up:
> - The scratch root is not a work tree.
> - `git check-ignore --stdin` fails in repository discovery, before it reads stdin.
> - git exits 128 and its stdin closes.
> - If Node's write lands after that point, the write gets EPIPE. `spawnSync` then reports both the child's exit status and `error: EPIPE`.
> - The code checks `error` first, so the real cause (git said "not a work tree", 128) is replaced by a side effect of it.
> 
> This is a race, which explains why the result differs by environment:
> - **Windows (local):** anonymous-pipe semantics differ, and the 8-byte write effectively never fails.
> - **Linux, usually:** the tiny write lands in the pipe buffer before git exits.
> - **Linux, sometimes:** git wins the race. This run on 2026-11-14 is one of those times. Main's last green run is one where it lost.
> 
> ## What the evidence does and does not establish
> 
> **Established:**
> - The cause string came from `ign.error.code === 'EPIPE'`.
> - The degraded path was taken, so there was no false-clean scan.
> - The code is byte-identical on main, so PR #359 did not introduce this.
> - The bug is latent on main.
> 
> **Inferred but not observed:**
> - That `ign.status` was 128 on this run.
> - That the EPIPE came from the stdin write.
> - That a change in runner image or git version did not make the race more frequent.
> 
> The log shows neither `status`, `signal` nor git's stderr.
> 
> **Not established:**
> - The failure rate.
> - Anything about the second failing file, `skill-command-blocks-parse-under-powershell`. That needs its own triage, and the PR stays red until it is handled.
> 
> ## Checks I would run
> 
> 1. On Linux, call `ignoredUntrackedPaths` against a non-git temp dir, once with a small candidate list and once with a large one (more than 64 KiB, larger than the pipe buffer). Log `status`, `signal`, `error.code` and stderr. I expect the large-input case to give `status: 128` plus `error: EPIPE` deterministically. That confirms the mechanism and gives a reliable RED test.
> 2. Loop the existing subtest about 200 times on ubuntu to measure how often the small-input race fires.
> 3. Note the git version on the runner versus main's last green run, in case the image changed.
> 
> ## What to do
> 
> **Re-run as a flake: no.** A re-run would probably go green, but that would hide a real reporting defect that also exists on main.
> 
> **Loosen the assertion: no.** Accepting any cause would bless a misleading diagnosis. The test's contract is correct: when git ran and exited 128, the reported cause must be 128.
> 
> **Change the code.** Prefer the child's own verdict when there is one:
> - **`status` is a number other than 0 or 1:** git ran and said why it failed. Report `git exit ${status}`. Optionally append the first line of git's stderr (for example `fatal: not a git repository`) and a note such as `; stdin write: EPIPE`.
> - **No `status` (null) and there is an `error`:** for example `ENOENT` when git is missing, or `ENOBUFS` or a kill. Report the error code, as the code does today.
> - **`status` is 0 or 1 and there is also an `error`:** the answer may be built from partial input. Stay degraded and report both, for example `git exit 1 with stdin EPIPE`. Do not trust the result.
> - Keep `degraded: true` and the `warning` field in every case.
> 
> **Tests:**
> - Keep subtest A as written. It will become stable once the fix lands.
> - Add the deterministic large-input, non-git-root test. It should assert `git exit 128` on the warning and on the wire `ownership` line, and must not mention EPIPE alone.
> 
> **Where the fix lands:** a small fix PR against main, merged first, then rebase #359 onto it. Folding it into #359 is acceptable if the maintainer prefers. Either way it should be recorded as a pre-existing bug, not something #359 introduced.
> 
> ## Who is affected
> 
> **Consumer repos** that sync `scripts/.[model]-skills/lib/disowned-paths.mjs`:
> - On Linux, their file scanner and doctor can intermittently report `EPIPE` instead of "not a work tree" when run outside git. This misdirects debugging toward pipes or IO.
> - Ownership correctness is not affected. The scan is still flagged degraded, so there is no false-confident result.
> - Any consumer that parses `warning` for the exit code sees inconsistent strings.
> - They pick up the fix on their next sync.
> - `OWNERSHIP_RULE_EPOCH` must **not** be bumped, because the ownership rule is unchanged.
> 
> **`debt-ledger.mjs`** calls with `warnOnDegraded: false`. It prints nothing and branches on `degraded`, so it is unaffected apart from the returned string.
> 
> **Upstream CI:** intermittent red on any PR, independent of the PR's content, until the fix lands.
> 
> ## Decision
> 
> Do not re-run this as a flake, and do not loosen the assertion. The failure is a real, timing-dependent reporting bug in `ignoredUntrackedPaths`, present on main and not introduced by PR #359.
> 
> The evidence:
> - The warning shows the cause was taken from `ign.error.code === 'EPIPE'`.
> - The precedence `ign.error ? … : git exit ${status}` lets a stdin-write EPIPE, caused by git exiting 128 on a non-work-tree before reading its input, override the real exit status.
> - The result depends on a race that Windows and most Linux runs lose.
> 
> Change the code so that a numeric non-0/1 `status` is reported as `git exit N`, optionally with git's stderr and a secondary EPIPE note. Use `error.code` only when there is no exit status. Keep the result degraded whenever an error and a status co-occur.
> 
> Keep the 128-pinned test, and add a deterministic large-input reproduction. Land the fix on main first, then rebase #359, and triage the unrelated PowerShell failure separately. Consumers receive the corrected diagnostics on their next sync, with no epoch bump.
> 
> Before merging, confirm the inferred `status: 128` alongside `error: EPIPE` on Linux with the large-input probe.

</details>

## 2. `a807c69f` — case `sdk-pin-max-tokens-review`

**Question.** Review this pin change as a coordinator deciding whether PR #360 is safe to merge at this step. The code at each moved site is described as otherwise unchanged: is that enough to conclude the pinned sites still behave correctly? State your verdict on the change, what you would check or change before merge, and what the coordinator should do next.

**Correct decision.** Not safe as is: the pin changes max_tokens semantics from accepted-and-ignored (cli) to enforced (sdk), and with a model that spends output on a thinking block a 64-token cap leaves no text block, while content[0].text reads the wrong block, so labels silently become underived (100% failure hidden by graceful degradation). Re-measure every cap at the moved sites, read the first text block via one helper at the seam, and surface stop_reason when no text arrives.

<details><summary>Response</summary>

> # Review of PR #360, step a4697858 ("throw and pin")
> 
> ## Is "the code is otherwise unchanged" enough?
> 
> No. The PR's claim is true of the source text. It is not a claim about behaviour, because the commit changes which transport executes each call, and the two transports do not honour the same parameters.
> 
> The adapter's own code shows this. On `cli`, `max_tokens` is "accepted and ignored". The adapter cites a measured case: **1995 output tokens returned against `max_tokens: 200`**. On `sdk`, params "are sent to the Messages API as given", so the cap is enforced.
> 
> So every pinned site has a cap that was decorative under its previous local transport and is now binding. On the maintainer's machine, `cli` was ambient. Any output the maintainer saw from these sites, including calibration runs, prompt tuning and labels in the cache, was produced with no ceiling at all.
> 
> The caps in the diff:
> 
> | Site | Cap | Risk once enforced |
> |---|---|---|
> | judge (`latest-[model]`) | 4000 | A JSON object that must score "EVERY rubric dimension" gets truncated. `extractJsonObject` then fails and returns `conformant:false, 'judge returned no JSON'`. That is the same failure signature the pin was meant to remove, now for a different reason. |
> | refine-prompts | 2000 | The refinement suggestion gets truncated. No `stop_reason` check is visible. |
> | work-unit labels (`[model]-[model]-5-5`) | 64 | Probably enough for a 3–8 word plain-text label. However, it was never exercised with the cap binding on this model. If the model emits a non-text or thinking block first, or a preamble, then `content[0].text` is wrong or truncated. |
> | context brief | not shown | Unknown. |
> | evolve-prompts (via `llm-wrappers.callClaude`), solo-control-audit | not in this diff | Unknown. |
> 
> The labeller makes this worse in a specific way. It returns `res?.content?.[0]?.text` with no `stop_reason` check. `sanitizeLabel` then truncates to 72 characters, and `putCached` stores the result as a success for `CACHE_TTL_MS`. A label cut off at the cap therefore looks like a clean success and persists. In the judge, a cut-off answer is recorded as model non-conformance and counted against the arm being scored. In neither site would the truncation be visible.
> 
> ## What the evidence establishes and what it does not
> 
> **Established:**
> - The throw semantics and the gate (Rules A and B, verified `indirectPins`) work as described.
> - The negative controls show the scanner, the oracle and the seam are not inert.
> - The `isClaudeAvailableFor('sdk')` gate changes are correct and well reasoned. A keyless cli install now skips or falls through instead of raising a credential error.
> - 2595 tests pass.
> 
> **Not established:**
> - That any pinned site produces correct output on `sdk`. None of the listed checks makes a live call through a pinned site.
> - CI runs `sdk`, but these paths are LLM calls that the suite presumably stubs, so a green CI says nothing about cap fit.
> - I also cannot tell from this evidence whether `[model]-[model]-5-5` or the current `latest-[model]` emit thinking blocks or need more headroom. That has to be measured, not assumed.
> 
> **A second-order effect the audits did not cover: comparability.**
> - The judge's earlier scores were produced on `cli`, where the agent persona outranked `system`. solo-control-audit rows carry `provenance.backend: 'cli(default)'`.
> - After merge, the same harnesses run on a different transport, with enforced caps and a different billing meter.
> - Rows and scores from before and after this commit are not comparable across that boundary unless they are marked as such.
> 
> ## What I would check or change before merge
> 
> 1. **Cap audit per pinned site, all six including the two not in this diff.** For each site, take the observed output-token distribution from the previous `cli` runs and compare it to the cap. Raise any cap that real outputs exceeded. The judge at 4000 needs checking first.
> 2. **Live `sdk` smoke run per pinned site.** Record `stop_reason`, output tokens and the content block types. Attach the results to the PR. This is cheap, and it is the only evidence that the pinned behaviour is correct.
> 3. **Handle truncation explicitly.**
>    - In the labeller: treat `stop_reason === 'max_tokens'` or a missing text block as `underived`, and do not cache it.
>    - Select the first `text` block instead of `content[0]`.
>    - In the judge: report truncation as its own error, not as "returned no JSON".
> 4. **Cache hygiene.** Labels cached under `cli` and under `sdk` share a `v${LABEL_PROMPT_VERSION}` key. Consider bumping the version so the transport change is visible in the cache.
> 5. **Provenance boundary.** Make sure the judge and solo-control-audit record the actual backend after the change. Note in the PR that cross-arm comparisons must not span a4697858.
> 6. **Optional hardening.** Add a gate or test asserting that pinned sites check `stop_reason`. That would make "pinned" also mean "cap-aware".
> 
> ## What the coordinator should do next
> 
> - Hold the merge on items 1–3.
> - Keep the throw-and-gate design. It is sound, and none of this argues for reverting to routing.
> - Ask the author for the per-site smoke evidence, and for the cap and truncation fixes in a follow-up commit on #360.
> - Point out to the reviewers that the audit rounds covered the mechanism but not the effect of moving each call onto a transport that enforces parameters the old one ignored.
> - Flag the data-comparability boundary to whoever consumes arm-eval and solo-control results.
> 
> ## Decision
> 
> **Not safe to merge at this step as-is. The design is approved, but the merge is conditional on the items above.**
> 
> "Code otherwise unchanged" does not show the pinned sites still behave correctly. The move from `cli` to `sdk` turns previously ignored `max_tokens` caps into binding ones:
> - The adapter documents that `cli` ignores the cap (1995 tokens returned against 200).
> - `sdk` passes params as given.
> - The pinned sites carry caps of 4000 (judge), 2000 (refine) and 64 (labeller).
> 
> The labeller does not check `stop_reason` and caches whatever text comes back, and the judge maps unparseable output to `conformant:false`. Truncation would therefore show up as silent, persistent degradation rather than an error.
> 
> None of the reported evidence (2595 tests, negative controls, the gate) exercises a pinned site live on `sdk`. Before merge I require:
> - a cap audit and live `sdk` smoke run across all six pinned sites;
> - truncation-aware handling (check `stop_reason`, select the first text block, never cache a truncated label);
> - a recorded provenance and comparability boundary for the judge and solo-control-audit.

</details>

## 3. `b24a702b` — case `stale-override-four-sites`

**Question.** Decide whether the override's recorded reason accurately describes what the sync delivers to a consumer, whether the override should stand as it is, and what should happen to the open upstream report. Say how you would establish it and what the consumer and upstream coordinators should each do next.

**Correct decision.** No: the three node-command sites (two bash blocks and the Actions run: line) are rewritten to the consumer path on delivery, and the fourth is a link label beside its own upstream URL with the consumer path named two lines later, so reason (2) is dead. The override's other rationale (plan links out of the shipped closure) is independent and must be judged separately, not dropped wholesale. Close the upstream report as not reproducing; make no rewriter change; the method is to render a disposable consumer and read the delivered bytes.

<details><summary>Response</summary>

> # Consistency-contract override: does the recorded reason match what the sync delivers?
> 
> ## What the code establishes
> 
> **Part 2(a)–(c), the three `node scripts/persona-consistency-run.mjs` invocations.**
> 
> - The doc is in the sync bundle (`sync-to-repos.mjs:282`).
> - Every file the sync writes goes through `rewriteCommandSurface`. That happens both on the write path (`:1571-1577`) and on the expected-content path (`:1405-1413`).
> - For text files, `COMMAND_REGEX` (`/\bnode\s+scripts\/([^\s`"'),;&|]+)/g`) matches all three forms:
>   - the one-line Setup block: the tail stops at whitespace;
>   - the backslash-continued Parity block: the tail is `persona-consistency-run.mjs`, terminated by the space before `\`;
>   - the YAML `- run: node scripts/...` line, which inside a `.md` file is plain text.
> - Each match becomes `node scripts/.[model]-skills/persona-consistency-run.mjs`, provided three things hold:
>   - `persona-consistency-run.mjs` is in `ownedSourceTails`, which is built from `repo.files` at `:1163`;
>   - `.md` is in `TEXT_EXTENSIONS` (the docstring at `:37-38` says it is);
>   - the path is not an explicit exception in `sync-path-map`.
> 
>   If all three hold, the delivered doc does **not** name upstream's source path in (a)–(c).
> 
> **Part 2(d), the `scripts/lib/redact.mjs` reference.**
> 
> - The rewriter does not touch it, because it is not a `node scripts/` invocation.
> - It is not a copy-paste command, though. It is link text pointing at the upstream GitHub URL.
> - The next sentence of the source already tells the reader that in a consumer repo the module is at `scripts/.[model]-skills/lib/redact.mjs`.
> - Naming upstream's path while linking to upstream and giving the consumer path is accurate documentation, not a defect. "Copy-pasting it verbatim fails" does not describe it.
> 
> **Part 1, links to `docs/plans/`.**
> 
> - The excerpts show no such links, and the rewriter does not alter links.
> - So the evidence neither confirms nor refutes part 1. It needs a grep.
> 
> ## What the evidence does not establish
> 
> - **Ownership for this consumer.** We don't know whether `scripts/persona-consistency-run.mjs` is in *that* consumer's `repo.files` and is not an explicit exception. If the consumer's profile ships the doc without the script, ownership fails and (a)–(c) would pass through unrewritten. In that case the reason would be accurate, and the real bug would be a different one: the bundle ships a doc that references a script it doesn't ship.
> - **Whether the reason was true when written.** The override was re-scoped on 2026-09-04. Because the override freezes the file, the consumer has never seen a later delivery. The reason may have been accurate then, if the rewriter or the redact sentence landed afterwards. Check with `git log -S` on `sync-rewriter.mjs` and on the "In a consumer repo that module is synced to" line.
> 
> ## How to establish it
> 
> 1. Create a disposable git repo configured with the same profile and file list as the private consumer. If the profile is unknown, run once with the default persona-test profile and note that assumption.
> 2. Run `node scripts/sync-to-repos.mjs --target-path <repo>`.
> 3. Run `grep -n 'node scripts/' docs/reference/consistency-contract.md`.
>    - Expect only `scripts/.[model]-skills/...` hits.
>    - Expect zero bare `node scripts/persona-consistency-run.mjs`.
> 4. Run `grep -n 'docs/plans' ...` to settle part 1.
> 5. Confirm the redact paragraph is delivered with the consumer-path sentence intact.
> 6. In the sync output, confirm `persona-consistency-run.mjs` was itself delivered to `scripts/.[model]-skills/`.
> 
> ## Next steps for the consumer coordinator
> 
> - Diff your hand-maintained copy against the freshly delivered doc.
> - If the run confirms (a)–(c) are rewritten, re-scope the override reason to part 1 only, and only if the grep finds plan links.
> - If there are no plan links, or you can tolerate dead links, drop the override and take the synced doc, so you stop drifting from upstream contract changes.
> - Don't leave a reason on record that describes defects the sync no longer produces.
> 
> ## Next steps for the upstream coordinator
> 
> - Post the reproduction (commands and grep output at `f48d9863`) on the open report.
> - Close (a)–(c) as not reproducing, citing the rewriter path. Close (d) as working as intended; optionally make the link text read "upstream source: …" to remove ambiguity.
> - If plan links exist, split part 1 into its own issue: either stop linking unshipped plans from a shipped doc, or ship them.
> - Add a regression check: gate3 or the verifier should assert that the delivered `consistency-contract.md` contains no unrewritten owned `node scripts/` invocation.
> - Don't close the report before the run confirms ownership for the consumer's profile.
> 
> ## Decision
> 
> The override's recorded reason does not accurately describe what the sync delivers at `main@f48d9863`, as far as part 2 goes. This is provisional until one disposable-repo sync run confirms it.
> 
> - **(a)–(c):** The sync rewrites them to `scripts/.[model]-skills/persona-consistency-run.mjs`. This rests on:
>   - `COMMAND_REGEX` matching all three forms;
>   - `rewriteTextCommandInvocations` mapping owned tails through `sourceRelToDestRel`;
>   - the sync applying `rewriteCommandSurface` to every written file, this doc included.
> 
>   It assumes the script is in the consumer's owned set.
> - **(d):** This is a deliberate upstream link, followed by an explicit consumer-path sentence. It is not a failing command.
> - **Part 1:** Unverified by the evidence; it needs a grep of the delivered file.
> 
> The override should not stand as written. Re-scope it to the plan-link reason if that is confirmed, otherwise remove it. Once the run reproduces the rewritten output, upstream should close the open report for (a)–(d) with the evidence attached, and track any confirmed plan-link problem as a separate issue.
> 
> If the run instead shows bare `node scripts/persona-consistency-run.mjs`, the consumer's reason stands for (a)–(c). The report should then stay open and be retitled to the ownership gap: the bundle ships the doc without the script it references.

</details>

## 4. `bd5a57fd` — case `cli-system-honour-claim`

**Question.** PR #360 refuses `system` on the `cli` transport and justifies it with a stated property of that transport (the oracle's `why` string, its docblock and the plan table). Judge that stated property against the code and the measurements in the context: is it accurate as worded, what exactly can be claimed, and should the choice between throw / warn / route-to-sdk change? Give your decision on the PR's claim and the policy, and say what the coordinator should do next.

**Correct decision.** The wording is overstated: the cli adapter DOES pass system (--system-prompt) and a simple instruction can be obeyed; for a structured-output contract the Claude Code persona plus the ~164K-token context outranks it, unpredictably by prompt (real prompt 0/4, shortened variant 3/3). tools/tool_choice are the params genuinely dropped. The throw/pin stays, justified by the seam deciding from params alone, not by "ignored"; the oracle strings and docs should be restated with the figures and guarded by a test.

<details><summary>Response</summary>

> # PR #360's stated reason for refusing `system` on the `cli` transport
> 
> **Summary:** the PR is right to refuse `system` on `cli`, but its stated reason is wrong as written. The code shows `system` is passed through. The measurements show it is honoured unreliably, not ignored. The figure cited as proof measures `max_tokens`, not `system`. Throw-and-pin should stay. The wording should not merge until it is fixed.
> 
> ## What the code establishes
> 
> **"Drops" is false.** The adapter's argv builder (`[model]-client.mjs:749-750`) runs:
> 
> ```js
> if (effectiveSystem) args.push('--system-prompt', effectiveSystem);
> ```
> 
> `system` reaches `[model] -p`. The plan table says the same ("passed as `--system-prompt`, outranked…"). So the PR description's "drops" contradicts the branch itself.
> 
> **`tools` / `tool_choice` are different.** "Dropped" is accurate for them. Neither is ever destructured or forwarded, and `--tools ''` is unconditional. That half of the oracle is sound.
> 
> ## What the measurements establish, and what they don't
> 
> **"Ignores" / "does not honour `system` as an instruction" is overbroad.**
> 
> - §6.B shows the full normalize prompt failed in 4/4 cli runs (1 through the seam, 3 below it). In each run `[model] -p` treated the prompt as a task and answered as an agent.
> - But the same section reports that a shortened 3-sentence replica of the same instruction, on the same model and argv, returned a correct one-line answer 3/3.
> - So `system` is honoured sometimes. The defensible claim is that `cli` does not *reliably* honour `system`. Evidence covers one prompt shape, one model (`[model]-[model]-5-5`) and n≈4+3, and the failure is silent.
> 
> **The quoted proof measures the wrong thing.** Both the `why` string ("measured: 1995 output tokens against a 200 ceiling") and the table's "69× output tokens" are evidence that **`max_tokens` is unenforced**. That defect is a separate one, and the PR deliberately does *not* refuse on it.
> 
> - The shortened replica shows the conflation directly. `system` was obeyed (one line, 89–95 chars), yet it still emitted 466–673 tokens against sdk's 43.
> - Output volume over a ceiling cannot show that `system` was disobeyed. The evidence that does show it is the *content*: "I haven't changed anything…". The judge observation adds to this, where a schema-mismatched answer was scored `conformant: false`.
> - As written, a reader could cite the same number to justify refusing `max_tokens`, which the docblock argues against.
> 
> **The mechanism is a hypothesis, not a measurement.** "The persona plus ~164k-token project context *outrank* it" is plausible. Every failing run read AGENTS.md and reported on tool availability. But nothing isolated the context. The one instrument that would do so, `--bare`, is unusable because it strips OAuth. I would also check the CLI's documented semantics for `--system-prompt` (replace vs. append to the default prompt) before stating any mechanism. Neither the oracle nor the plan says which applies.
> 
> **Structured `system` arrays.** The array branch's reason ("takes `--system-prompt` as a single string") is about *representation*, not measured dishonour. The elided `effectiveSystem` line leaves it unclear what an array would actually become in argv. Refusing it is correct either way. It belongs with the "cannot represent" class (`assertOneShotTextMessages`), and should not be described as measured.
> 
> ## Should throw / warn / route-to-sdk change?
> 
> No. The corrected property still passes the PR's own membership test, arguably more strongly than before.
> 
> - **Unreliable is worse than dropped for the caller.** A call site cannot tell from the response whether its `system` instruction took effect.
> - **Consumers don't notice.** `judge.mjs` demonstrably scored its own transport failure as a model failure. A once-per-session warning would not stop that.
> - **The `max_tokens` collapse argument doesn't apply.** Refusing `system` does not refuse every call; only some callers set it. Operators keep `cli` for system-less calls.
> - **Route-to-sdk stays rejected** for the reason the adapter comment gives. Which meter a call bills would then be decided by a param the call site never connected to billing, and nothing committed would record which sites had moved.
> - **No length threshold.** "Short `system` prompts work" rests on one prompt at n=3. It would also add the second routing dial the docblock rightly removed for `max_tokens`.
> 
> ## What the coordinator should do next
> 
> 1. **Request wording changes before merge.**
>    - **PR description:** strike "drops"/"ignores".
>    - **Oracle `why` (string case):** say something like "the cli backend passes `system` as `--system-prompt` but does not reliably honour it: on normalize-intent's shape every measured run answered as a [model] Code agent instead of following the instruction, with no error". Remove the 1995/200 figure from it.
>    - **Docblock and plan table `system` row:** replace "69× output tokens, instruction ignored" with the content-based evidence. Note the 3/3 shortened-replica result, and label "outrank / 164k context" as the suspected mechanism.
>    - **1995/200 figure:** keep it on the `max_tokens` row and in the warning, where it belongs.
> 2. **Add a regression test** that the cli argv contains `--system-prompt <value>` whenever `system` is set. This pins the factual correction so "drops" cannot quietly become true or be re-asserted.
> 3. **Check the CLI's documented `--system-prompt` semantics** (replace vs. append) and record the answer next to the mechanism claim.
> 4. **Optional, non-blocking:** take one more measured shape, e.g. the `judge.mjs` call, so the `system` refusal does not rest on a single prompt.
> 
> ## Decision
> 
> **Do not merge the stated reason as written. Keep the throw-and-pin policy.**
> 
> - **"Drops"/"ignores" is wrong.** `[model]-client.mjs:750` forwards `system` as `--system-prompt`.
> - **"Does not honour `system` as an instruction" is overbroad.** §6.B records the shortened replica honoured 3/3 on the same argv.
> - **The cited proof (1995 tokens vs. `max_tokens: 200`) measures the unenforced ceiling, not `system`.** The shortened replica obeyed `system` while still overrunning.
> - **What can be claimed:** `cli` passes `system` but does not *reliably* honour it. On normalize-intent's shape, every one of 4 runs answered as an agent, silently. The 164k-context "outrank" explanation is an unisolated hypothesis.
> - **Why throw stays:** that corrected property still changes the *kind* of answer the caller receives, without signal, which is what `judge.mjs`'s mis-scoring shows. Refusing `system` does not collapse `cli` usability the way refusing `max_tokens` would. Route-to-sdk would still make billing an undeclared side effect.
> - **Merge condition:** the corrected wording plus an argv test asserting `--system-prompt` is forwarded.

</details>

## Marks

| # | grade id | Your verdict (Y/N) |
|---|---|---|
| 1 | 9b450557 |  |
| 2 | a807c69f |  |
| 3 | b24a702b |  |
| 4 | bd5a57fd |  |

<details><summary>Judge labels — open only after every verdict above is filled</summary>

| # | grade id | Judge (both passes) | Passes split |
|---|---|---|---|
| 1 | 9b450557 | N | - |
| 2 | a807c69f | Y | - |
| 3 | b24a702b | Y | - |
| 4 | bd5a57fd | Y | - |

</details>

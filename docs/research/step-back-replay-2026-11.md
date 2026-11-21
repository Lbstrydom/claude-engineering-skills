# Step-back replay (Q1) — verdict, 2026-11-22

- **Plan**: `docs/plans/verification-lessons.md` §2.4 (Phase 4). Pre-registered rule, fixed before any paid call: an arm is
  **adopted** only with `falseStops = 0` and `earlyStops ≥ 2` of 4 bad PRs; otherwise **not adopted**, and the step-back ships as
  an **on-demand** tool only.
- **Verdict**: **not adopted** — for both paid arms. **Same-model vs different-model: undecided on this data** (see §4). The
  step-back ships on-demand (`audit-structural-card.mjs --step-back`), never as an automatic round gate.
- **Spend (metered from provider usage)**: **$4.77** of a $20 hard stop (18 calls). Preflight upper bound was $17.51.

## 1. What ran

| Item | Value |
|---|---|
| Revision | `974f4e50` (Cluster D audited head), pinned with `npm run fixture:create` (`step-back-replay-2026-11`) |
| Data | read-only export of `audit_runs` / `audit_findings` / `finding_adjudication_events` in one `REPEATABLE READ READ ONLY` transaction: 33 runs, 309 findings, 282 events, 7 branches |
| Run pinning | exact `audit_runs.id` lists per PR in `docs/research/step-back-replay-spec.json`; freeze: 7 recoverable, 0 unrecoverable; export and spec sha256 recorded and verified before the run |
| Checkpoints | R3 + R6 for #410, #421, #424, #429 (bad); R3 for #426 (converged at R4); #412 and #425 (2 rounds) are controls — the step-back cannot fire there |
| No look-ahead | checkpoint N sees findings of runs ≤ N and each finding's latest effective event with round ≤ N created before run N+1 (final run: + 3h); ground truth held in a separate scoring file the pack never sees |
| Context pack | plan + ledger-at-N + rounds ≤ N + cited files and one-hop imports/importers read by `git show <audited_sha>`, sensitive-path filtered and secret-redacted; 486k–599k chars (~130k–178k input tokens); arch-memory neighbours off (would be look-ahead) |
| Arms | `none` (computed: the recorded run), `same` = `latest-gpt` (gpt-6.1-terra), `different` = `latest-pro` (gemini-pro-latest) |

Commands (all outputs under `C:\tmp\vl-replay`, outside the repo):

```bash
node scripts/step-back-replay.mjs export --branches claude/model-eval-audit-at-commit-tree,claude/solo-control-hardening-bdb23f,ces/telemetry-export-p3,claude/solo-control-reaudit-421,claude/sashiko-adjudicated-scoring,ces/arch-coverage-and-git-timeout,ces/coverage-read-failed --since 2026-11-19 --out C:/tmp/vl-replay/export.json
node scripts/step-back-replay.mjs freeze --export C:/tmp/vl-replay/export.json --spec docs/research/step-back-replay-spec.json --out C:/tmp/vl-replay/dataset.json
node scripts/step-back-replay.mjs run --dataset C:/tmp/vl-replay/dataset.json --arms same,different --max-usd 20 --confirm-spend --results C:/tmp/vl-replay/calls.jsonl --out C:/tmp/vl-replay/results.json
```

## 2. Results (measured)

| PR | label | ckpt | accepted-HIGH rounds (truth) | same (GPT) | different (Gemini) |
|---|---|---|---|---|---|
| #410 | bad | R3 | 1,2,4,5 | structural | stop |
| #410 | bad | R6 | | structural | invalid (truncated) |
| #421 | bad | R3 | 1,2,3,4,5 | structural | invalid (truncated) |
| #421 | bad | R6 | | structural | invalid (truncated) |
| #424 | bad | R3 | 1,2,3,4,5,6 | structural | invalid (truncated) |
| #424 | bad | R6 | | structural | structural |
| #429 | bad | R3 | 1,2,3,4,5 | structural | invalid (truncated) |
| #429 | bad | R6 | | structural | invalid (truncated) |
| #426 | converged | R3 | 1,2 | structural | structural |

Scores (the harness, pre-registered rule): **same — early 0, false 4, invalid 0 → not adopted. different — early 1, false 1,
invalid 6 → not adopted.**

## 3. What the numbers mean

- **The same-model arm does not discriminate.** It answered `structural` at all 9 checkpoints — on every bad PR at R3 and R6
  *and* on the converged #426. A trigger that fires the same way on a run that is about to converge and on one that is spinning
  carries no information about which is which. Its 4 false stops are R3 stops on PRs with later accepted HIGHs.
- **The different-model arm is mostly UNMEASURED — an instrument defect, not a verdict.** 6 of 9 replies are invalid JSON, each
  with ~3,986 output tokens against a 4,000-token cap: Gemini's thinking tokens are billed and counted as output, so the visible
  JSON was cut off mid-string. Its 3 valid replies include a `stop` at #410 R3, which is a false stop under the truth rule, so
  even a fully measured re-run could not satisfy `falseStops = 0`; it was not re-run (it cannot change the verdict, and re-running
  to get a different answer is the retry-to-green this plan bans). **Debt**: raise the Gemini output ceiling (or disable thinking
  for this call) before this arm is used again.

## 4. Ground-truth caveat (stated to the coordinator before the paid run, verbatim)

> The ground truth "a later round had an accepted HIGH" marks nearly every round of the bad PRs, because we accepted most
> findings. So a stop at R3 scores as a false stop, and only R6 stops on #410/#421/#429 can count as early stops. The adoption
> rule (falseStops=0, earlyStops≥2) is therefore strict but still decidable; the proxy cannot distinguish "accepted and real"
> from "accepted but marginal" — the exact concern the brainstorm raised — and the verdict will say that plainly rather than
> over-claim.

This verdict therefore says only that **neither arm, on this
data, would have stopped a bad run without also stopping before an accepted HIGH**; it does not say the bad runs' later findings
were real.

**Same vs different: undecided on this data.** One arm is non-discriminating; the other is two-thirds unmeasured. No pick is made.

## 5. Consequences for the round policy

- The **deterministic signals** (reopen rate, severity drift, retired) stay as the trigger at rounds 3 and 6; they are what the
  operator reads. In the live clusters of this plan they did fire usefully (reopen/oscillation at R3 on Clusters A, C and D;
  stop decisions were taken by the operator from them). That is anecdote, not this replay's evidence.
- The **step-back reviewer** ships **on-demand only**: the card can run it, its output is advisory, and a `stop` never writes debt
  without a human. It is not an automatic gate.
- The post-round-6 default (stop-to-debt or a human) is unchanged and does not depend on this result.

## 6. Retirement / revisit predicate

Revisit when either (a) a ground truth that separates "accepted and real" from "accepted but marginal" exists (e.g. the
per-stage recall of Phase 3 run on the sashiko corpus), or (b) the Gemini arm is fixed and ≥ 4 new bad runs with R6 checkpoints
are available. Until then this verdict stands and no collector is added (AGENTS.md: model swaps and policy tests are synchronous).

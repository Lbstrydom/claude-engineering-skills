# Step-back replay v2 (Q1, three arms) — verdict, 2026-11-22

- **Plan**: `docs/plans/verification-lessons.md` §2.4 (Phase 4). The adoption rule is the one fixed before the v1 run and unchanged
  here: an arm is **adopted** only with `falseStops = 0` and `earlyStops ≥ 2` of 4 bad PRs; otherwise **not adopted**.
- **Verdict**: **not adopted — for all three arms** (`same`, `different`, `higher`). The step-back stays an **on-demand**,
  advisory tool, never an automatic round gate. **Which arm decides better: undecided on this data** (§3). On cost alone, the
  `same` arm is the cheapest per valid decision by 2.4x over `different` and 6.5x over `higher` (§2.2).
- **Spend (metered from provider usage, every call)**: **$13.42** of a $40 hard stop (27 calls). The preflight upper bound was
  $26.88. No call had missing usage, so no figure below is an estimate.
- **What changed from v1** (`docs/research/step-back-replay-2026-11.md`): Gemini gets a thinking budget (3,000) and a 7,000-token
  output ceiling, and a capped reply is recorded as truncated; a third arm `higher` (`latest-opus` → `claude-opus-5-5`, pinned to
  the sdk backend) was added at Louis's request ("a higher level model making the call so opus equivalent"); cost per arm is a
  first-class result; packs open cited files by their real-case path (the v1 case-folding limitation is fixed).

Population: measured from 1 store — d5a9d07b repo-scoped (self).

## 1. What ran

| Item | Value |
|---|---|
| Revision | `2cb7bbd9` (replay v2 audited head: GPT R1–R4, Gemini R2 APPROVE with Code FULL), pinned with `node scripts/pinned-worktree.mjs create --name step-back-replay-v2` |
| Data | the v1 dataset unchanged (`C:\tmp\vl-replay\dataset.json`, sha256 verified by the run): same 5 PRs, same checkpoints, same separate scoring file |
| Checkpoints | R3 + R6 for #410, #421, #424, #429 (bad); R3 for #426 (converged at R4); #412 and #425 are controls with no call |
| Arms | `same` = `latest-gpt` (gpt-6.1-terra), `different` = `latest-pro` (gemini-pro-latest), `higher` = `latest-opus` (claude-opus-5-5) |
| Run | one execution (heartbeat run id `step-back-replay-v2`: start 10:09:42Z, end 10:16:48Z, exit 0); 27 of 27 planned calls, `stopped: null` |

```bash
node scripts/run-heartbeat.mjs run --run-id step-back-replay-v2 --stale-after 900 -- node scripts/step-back-replay.mjs run --dataset C:/tmp/vl-replay/dataset.json --arms same,different,higher --max-usd 40 --confirm-spend --results C:/tmp/vl-replay/v2-calls.jsonl --out C:/tmp/vl-replay/v2-results.json
```

## 2. Results (measured)

### 2.1 Decisions

| PR | label | ckpt | accepted-HIGH rounds (truth) | same (GPT) | different (Gemini) | higher (Opus) |
|---|---|---|---|---|---|---|
| #410 | bad | R3 | 1,2,4,5 | structural | structural | structural |
| #410 | bad | R6 | | structural | structural | stop |
| #421 | bad | R3 | 1,2,3,4,5 | structural | stop | stop |
| #421 | bad | R6 | | structural | stop | structural |
| #424 | bad | R3 | 1,2,3,4,5,6 | structural | stop | structural |
| #424 | bad | R6 | | structural | stop | stop |
| #429 | bad | R3 | 1,2,3,4,5 | structural | stop | structural |
| #429 | bad | R6 | | structural | stop | structural |
| #426 | converged | R3 | 1,2 | structural | stop | stop |

Every reply was valid: **0 invalid, 0 truncated, 0 provider failures in all three arms** (Gemini's largest output was 3,662
tokens against the 7,000 ceiling — the v1 instrument defect is fixed). All three arms are `complete`.

Scores (harness, pre-registered rule): **same — early 0, false 4. different — early 0, false 4. higher — early 0, false 4.
All not adopted.**

### 2.2 Cost per arm (all measured)

| Arm | Calls | Input tokens | Output tokens | Total | $/valid decision | $/false stop |
|---|---|---|---|---|---|---|
| same (GPT) | 9 | 1,339,690 | 2,881 | **$1.35** | **$0.150** | $0.339 |
| different (Gemini) | 9 | 1,495,689 | 25,168 | **$3.29** | **$0.366** | $0.823 |
| higher (Opus) | 9 | 2,144,855 | 9,634 | **$8.77** | **$0.975** | $2.193 |

`$/early stop` is undefined for every arm (no early stops). Input tokens differ for the same packs because each provider counts
its own tokens: Opus counted ~1.6x GPT's input for identical text.

## 3. What the numbers mean

- **No arm said `continue` even once — 27 of 27 replies were a stopping action.** The rule treats `stop` and `structural` alike
  as stopping (`STOPPING_ACTIONS`), so every arm's first stop on every PR is R3, and on the four bad PRs every R3 is followed by
  an accepted HIGH. Under this ground truth **no arm that stops at R3 can be adopted**, and none could have scored differently.
  The identical scores are a property of the data, not evidence that the three models judge alike.
- **The arms do differ in kind, and the rule does not score that.** `same` answered `structural` everywhere — including the
  converged #426, as in v1 (reproduced: it does not discriminate). `different` said `stop` at 7 of 9, including #426. `higher`
  mixed the two (4 stop, 5 structural) with no pattern that tracks the truth labels: it said `stop` on the converged #426 R3 and
  `structural` on #424 R3 and #429 R6. Nothing here shows one arm separating spinning runs from converging ones.
- **Cost is the only measured separation.** At equal measured quality, the cheapest arm is the defensible default for the
  on-demand tool: `same` at $0.15 per decision. `higher` costs 6.5x for no measured gain on this data; that is not evidence
  that Opus decides no better, only that this replay cannot see a difference.
- **The replay is saturated.** Re-running it, with any model, cannot produce an adoption: the ground truth marks the R3 stop on
  every bad PR as false. More information needs a different ground truth (§5), not more calls.

## 4. Ground-truth caveat (stated to the coordinator before the v1 paid run, verbatim, and still binding)

> The ground truth "a later round had an accepted HIGH" marks nearly every round of the bad PRs, because we accepted most
> findings. So a stop at R3 scores as a false stop, and only R6 stops on #410/#421/#429 can count as early stops. The adoption
> rule (falseStops=0, earlyStops≥2) is therefore strict but still decidable; the proxy cannot distinguish "accepted and real"
> from "accepted but marginal" — the exact concern the brainstorm raised — and the verdict will say that plainly rather than
> over-claim.

v2 adds one observation to it: because all three models stopped at R3 on every PR, the "decidable" branch of that caveat never
came into play. This verdict says only that **no arm, on this data, would have stopped a bad run without also stopping before an
accepted HIGH**; it does not say the bad runs' later findings were real, nor that any model is a better judge than another.

## 5. Consequences and revisit predicate

- The round policy is unchanged from v1 §5: deterministic signals at rounds 3 and 6; the step-back reviewer is on-demand and
  advisory, and a `stop` never writes debt without a human; the post-round-6 default is unchanged.
- **Default arm for the on-demand step-back stays `same`** (cheapest at equal measured quality) — already the card's default
  (`audit-structural-card.mjs --step-back-arm same|different`). `higher` exists only in the replay harness and is **not** added
  to the card: $0.97 a decision bought nothing measurable here.
- **Revisit** only when a ground truth that separates "accepted and real" from "accepted but marginal" exists (e.g. Phase 3's
  per-stage recall on the sashiko corpus), or when ≥ 4 new bad runs with R6 checkpoints exist **and** at least one arm answers
  `continue` somewhere. No collector is added; a model swap or policy test stays synchronous (AGENTS.md).

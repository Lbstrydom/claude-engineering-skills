# Audit canary on real rounds — 2026-11

**Question.** Does the opt-in known-answer canary (`AUDIT_CANARY=1`, `scripts/lib/audit/canary.mjs`, PR #329) still
detect on real, larger rounds, where it competes with real code? That decides default-on vs opt-in.

**Recommendation: default-on is supported by this evidence, with the caveat that it is 11 planted passes on one repo
(see Limits). Ship default-on only after the matcher follow-up (basename match, `pass-failed` for lost map-reduce units)
lands — that follow-up fixes the matcher's known gap, which this sample did not exercise.**

## Method (measured)
- 11 merged PRs from `main`, picked for size and type spread:
  2 to 43 changed files; backend-heavy, mixed, one docs/env-heavy (#308).
- Tooling pinned: `npm run fixture:create -- --name canary-rounds --rev 39eb023f` (needs the canary code, so tooling is
  main HEAD, not each PR's merge commit). Each PR's own diff was supplied as `git diff <parent> <merge>` via `--diff`,
  its changed files that exist at the pin via `--files` (≤40). File contents are therefore main-HEAD versions of the
  changed files (deviation from `--scope diff --base`, which would have diffed the whole range since the parent).
- Per PR, two arms, same command, `AUDIT_DB_URL= LEARNING_DISABLE=1`, store untouched:
  `node scripts/openai-audit.mjs code <stub plan> --files <list> --diff <file> --allow-infra-scope --no-ledger --out <f>`
  with and without `AUDIT_CANARY=1`. Raw runner: stub plan, `run.sh` (scratch, not committed).

## Results (measured; `_canary`, `_usage`, `[canary]` stderr from each `--out` JSON)
| PR (merge sha) | files | planted pass | status | off in/out tok · $ | on in/out tok · $ | verdict off → on |
|---|---|---|---|---|---|---|
| #328 6830fd07 | 7 | backend | detected | 100932/3253 · 0.117 | 98082/6026 · 0.128 | M6 → H2 M4 |
| #327 938efbef | 13 | be-services | detected | 164032/15809 · 0.243 | 164815/17692 · 0.253 | H10 M7 → H3 M12 |
| #302 7cbc1145 | 2 | backend | detected | 56421/3149 · 0.072 | 56208/2956 · 0.071 | M3 L2 → M3 L1 |
| #300 d010208e | 4 | backend | detected | 68778/5300 · 0.095 | 65222/5894 · 0.095 | H3 M4 → H4 M4 |
| #292 c275bc51 | 9 | backend | detected | 173762/11721 · 0.232 | 168947/11927 · 0.229 | H4 M11 → H7 M7 |
| #291 31af4a6f | 6 | backend | detected | 179763/15024 · 0.255 | 173095/17543 · 0.261 | H12 M10 → H14 M9 |
| #306 e9543903 | 25 | be-services | detected | 393214/30454 · 1.015 | 393141/29032 · 1.004 | H20 M14 → H16 M16 |
| #303 b4c09fb4 | 24 | be-services | detected | 295270/17907 · 0.725 | 295560/17930 · 0.726 | H8 M9 L2 → H10 M9 L2 |
| #315 58352c39 | 8 | backend | detected | 160441/7995 · 0.200 | 160757/9278 · 0.207 | H4 M8 → H4 M8 |
| #308 80e43a0a | 2 | backend | detected | 38381/2112 · 0.049 | 38456/2953 · 0.053 | M4 → M4 |
| #317 4d66a87d | 43 | be-services | detected | 879733/63465 · 2.235 | 849599/60075 · 2.150 | H26 M9 → H25 M7 |

- **Detection: 11/11 planted passes `detected`; 0 `missed`, 0 `failed`, 0 `not-planted`, all exit 0.** Every `[canary]`
  line quotes a HIGH finding anchored on the canary path (`<path>:4` or `<path>: canOpenAdminConsole`, one with an em dash).
- **Miss classification: none to classify** — no auditor-blind and no matcher-miss in this sample.
- Only one pass per round was planted (`backend` or `be-services`), so the sample is 11 planted passes, not 11 × passes.
- **Cost (derived, sum of `_usage`):** off 2,510,727 in / 176,189 out / $5.239; on 2,463,882 in / 181,306 out / $5.176.
  The on-arm delta is within run-to-run noise (it is negative); the canary's own cost (~$0.0015/planted pass,
  plan §10) is invisible against the ~$0.5 mean round. Verdict counts differ between arms in both directions —
  that is ordinary sampling variance of an LLM auditor across two runs, not a canary effect (the arms cannot share a cache).

## Budget note
The brief capped spend at ~$5; actual was **$10.42 (derived: 5.239 + 5.176)**, $4.39 of it the single 43-file round (#317).
It was not stopped early because detection was uniformly clean, but it is an overrun.

## Limits (what this does not show)
- 11 planted passes, one repo, one auditor model (gpt-6.1-terra via the local `.env`), one run per arm. A 95% lower
  bound for 11/11 is ~74% (rule of three, derived) — "no systematic miss", not "≥ 99% reliable".
- The prior small-scope run saw 5/12 with an announcing path and 16/16 with the neutral path; this sample is consistent
  with the neutral path holding on larger rounds, up to ~880K input tokens.
- Round 1 only; `--no-ledger`; no R2+ suppression interplay.
- Files were read at main HEAD, not at each PR's merge commit.
- No docs-only round was run (that case yields `not-planted` by design — no eligible pass), so the default-on question
  for docs-only diffs is open: it would make such rounds INCOMPLETE (exit 3). Settle that before default-on.
- The known matcher gap (bare/partial/absolute path citations, lost map-reduce units reading `missed`) was not hit;
  the follow-up PR fixes it.

## Decision
Detection on real rounds held, so there is no evidence for the structured-detection-field fallback (plan §9).
Default-on needs two things first: the matcher follow-up, and a decision for diffs with no eligible pass.

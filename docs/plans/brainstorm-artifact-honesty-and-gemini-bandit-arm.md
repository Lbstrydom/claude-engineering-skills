# Plan: /brainstorm artifact-send honesty + gemini-review bandit arm registration

- **Date**: 2026-11-28
- **Status**: Complete — implemented 2026-11-28 in one PR (merge by the coordinator)
- **Author**: Claude + Louis
- **Scope**: backend (CLI helper + skill prose + learning seam; no UI)
- **Upstream reports**: `c1f6738a` (brainstorm "sent verbatim" when truncated), `0aab5c0f` (LOW — gemini-review bandit reward dropped)

> **Target domain(s)**: `brainstorm`, `final-review`, `skills-content`, `tests`

> All `file:line` citations are pinned to commit `067057e9`.

---

## 1. Context Summary

### Bug 1 — c1f6738a: "sent verbatim" when the artifact was cut

- `scripts/lib/brainstorm/artifact-context.mjs:41` — `ARTIFACT_MAX_TOKENS = 3000`, divided
  among all requested artifacts (`:137`, floor 200 tokens each).
- `:97` redacts secrets; `:100-104` slices an oversized artifact and appends a
  `[truncated: …]` marker to the text the models receive, setting `truncated: true`.
- `scripts/brainstorm-round.mjs:481` — the only stderr line reports count + tokens, never a cut.
- `scripts/brainstorm-round.mjs:492` — envelope `artifactContext.attached[{path, bytes, truncated}]`.
- `skills/brainstorm/SKILL.md:228` tells the agent to render
  `ℹ Focal artifact(s) sent verbatim: <paths>` — **unconditionally**; `:37` and `:88`
  also say "verbatim". The envelope already knows the truth (`truncated`), but the
  prose never consults it, so a 40K-char plan cut to ~12K reads to the user as
  sent whole. The model-facing `ARTIFACT_BLOCK_PREAMBLE` (`artifact-context.mjs:47`)
  says "verbatim" too, though the inline marker does tell the model.
- `scripts/lib/brainstorm/schemas.mjs:190-201` — the write schema is a non-strict
  `z.object`, which **strips unknown keys**: any new envelope field must be declared
  there or it silently vanishes from the emitted JSON (`brainstorm-round.mjs:648-655`
  serialises `parsed.data`).

### Bug 2 — 0aab5c0f: gemini-review verdict reward silently dropped

- `scripts/lib/final-review/post-review.mjs:586-598` — `recordGeminiOutcomes` calls
  `bandit.update('gemini-review', revId, reward)` with no prior `addArm`.
- The arm is registered only by the legacy code-audit loop
  (`scripts/lib/audit/legacy-production-audit.mjs:748-752`, loop over `PASS_NAMES`);
  the tiered pipeline, plan audits and `gemini-review.mjs` itself never register it.
- Bandit state is per checkout (`scripts/bandit.mjs:58`, `.audit/bandit-state.json`),
  so a fresh worktree has none: `update` warns `unknown arm … skipped` and returns
  `false` (`bandit.mjs:137-150`), and `post-review.mjs:598` ignores the return.
- `addArm` is idempotent (`bandit.mjs:81-89`: only writes when the key is absent).
- `recordGeminiOutcomes` does not consult `LEARNING_DISABLE` today; the new
  `addArm` is a new persisted write, so it must not happen under `LEARNING_DISABLE=1`.

---

## 2. Proposed Architecture

### 2.1 Bug 1 — the envelope is the one source of truth, and it carries the line

The helper, not the SKILL.md prose, composes the exact line the agent renders.
Prose that paraphrases an envelope is the drift this bug is; prose that says
"print this field" cannot drift.

1. `resolveArtifact` additionally returns `totalChars` and `sentChars`, both
   measured on the **same string** — the post-redaction text, the one the models
   would receive whole — so `sentChars <= totalChars` holds by construction:
   `totalChars` = redacted text length before any cut, `sentChars` = length of the
   slice actually sent (the inline marker excluded). The unit is the JS string
   length (UTF-16 code units), labelled "chars" exactly as the existing
   `[truncated: N chars …]` marker already does. `redactionCount` counts
   patterns redacted over the whole file — the line says "redacted from the
   file", never "in what was sent". `bytes` is kept unchanged for back-compat (it
   is, and stays, `raw.length`, the pre-redaction file length).
2. New pure export `summariseArtifacts(loaded, { requested, policyAttached })`
   in `artifact-context.mjs` builds the envelope's `artifactContext` object —
   moved out of `brainstorm-round.mjs:490-495` so the summary and its render line
   are built in one place — adding per-artifact `sentChars`, `totalChars`,
   `redactionCount`, and a top-level `renderLine`.
3. New pure export `formatArtifactRenderLine(attached, { policyAttached })`:
   - no attachments → `null` (refusal lines already cover that case);
   - every artifact whole → `ℹ Focal artifact(s) attached whole: \`a.md\`, \`b.mjs\`[ + repo policy pack].`
   - any cut → leading `⚠` and, per artifact, either `\`a.md\` (whole)` or
     `\`b.mjs\` (⚠ TRUNCATED to ~12,000 of 40,000 chars)`;
   - any redaction → suffix `(N secret pattern(s) redacted from the file)` on that artifact.
   Neither "verbatim" nor "sent" is ever emitted: the line describes what the
   **prompt contained**, which the helper knows; whether a provider received it is
   each provider block's own state (`misconfigured`, `http_error`, …), rendered
   below it. (Plan-audit R2-H1: a misconfigured run must not read as "sent".)
4. `brainstorm-round.mjs` writes one stderr warning per truncated artifact:
   `[brainstorm] ⚠ artifact TRUNCATED: <path> — ~N of M chars attached (per-artifact budget T tokens)`.
5. `schemas.mjs` declares the new fields (`sentChars`, `totalChars`,
   `redactionCount` per attached entry; `renderLine` at the top) as **optional**,
   so session-ledger rows written before this change still parse.
6. `ARTIFACT_BLOCK_PREAMBLE` drops "verbatim" for "from this repository (secrets
   redacted; any cut is marked inline)".
7. `SKILL.md`: line 228 becomes "prepend `artifactContext.renderLine` exactly as
   given". Only a fresh envelope from this helper is ever rendered (the render
   step reads the round's own `--out` JSON), so a missing line means a stale
   helper; the fallback sentence is: if `renderLine` is absent, name each
   `attached` path with `truncated: true` as TRUNCATED and never say whole/verbatim; lines 37 and 88 stop saying verbatim (`gate-contract.json`'s
   `ignoredCandidates` entry quoting line 88 is updated to the new text).

### 2.2 Bug 2 — register the arm where the reward is recorded

New exported helper in `post-review.mjs`:

```js
export function recordGeminiVerdictReward(bandit, result, revId, { env = process.env } = {})
  → { recorded: boolean, reason: 'recorded'|'learning-disabled'|'coverage-gated'|'update-rejected' }
```

- `env.LEARNING_DISABLE === '1'` → no `addArm`, no `update`, `learning-disabled`.
- `result._coverageGate?.downgraded` → `coverage-gated` (existing rule preserved).
- Reward derivation is **moved verbatim**, not redesigned: the existing
  `VERDICT_REWARDS` map (`APPROVE 0.8, CONCERNS 0.5, CONCERNS_REMAINING 0.35,
  REJECT 0.2`) and its `?? 0.5` default for any other verdict. Eligibility is
  exactly today's: every result except a coverage-gated one.
- else `bandit.addArm('gemini-review', revId, null, { promptRevisionId: revId })`
  (same metadata shape the legacy loop uses), then `update`; a `false` return
  writes `[learning] ⚠ gemini-review verdict reward NOT recorded …` to stderr
  and returns `update-rejected`.

- **Failure disposition**: any throw from `addArm`/`update` (a state write
  failing, say) is caught inside the helper, written to stderr as
  `[learning] ⚠ gemini-review verdict reward NOT recorded (<message>)` and
  returned as `{recorded:false, reason:'error'}`. A throw from `new PromptBandit()`
  is caught by `recordGeminiOutcomes`'s existing outer `try/catch`, which already
  logs `[learning] <message>`. Neither can affect the review: `recordGeminiOutcomes`
  runs after `emitReviewOutput` (`scripts/gemini-review.mjs:952-953`), so the
  verdict has been written before any learning write is attempted, and the
  function never throws out.

`recordGeminiOutcomes` calls it; under `LEARNING_DISABLE=1` it also skips
constructing the `PromptBandit`, so no state file is touched.
The finding-level `outcomes.jsonl` / FP-tracker writes are unchanged (out of scope,
see §8).

---

## 3. Sustainability Notes

- One owner per fact: the render line lives next to the data it describes;
  SKILL.md only points at it.
- Pure helpers with injected `bandit`/`env` make both seams testable without the
  filesystem or a provider.

## 4. File-Level Plan

| File | Change |
|---|---|
| `scripts/lib/brainstorm/artifact-context.mjs` | (modify) `sentChars`/`totalChars`; `summariseArtifacts`, `formatArtifactRenderLine`; preamble wording |
| `scripts/brainstorm-round.mjs` | (modify) use `summariseArtifacts`; per-artifact TRUNCATED stderr warning |
| `scripts/lib/brainstorm/schemas.mjs` | (modify) optional new fields on `artifactContext` |
| `skills/brainstorm/SKILL.md` | (modify) render `renderLine`; drop "verbatim" claims at :37, :88, :228 |
| `skills/brainstorm/gate-contract.json` | (modify) ignoredCandidates line text for :88 |
| `.claude/skills/brainstorm/**` | (modify) regenerated by `npm run skills:regenerate` |
| `.skill-size-baseline.json` | (modify) only if the ratchet requires re-baselining a shrink |
| `scripts/lib/final-review/post-review.mjs` | (modify) `recordGeminiVerdictReward`; LEARNING_DISABLE gate |
| `tests/brainstorm-artifact-context.test.mjs` | (modify) render-line tests + schema round-trip |
| `tests/gemini-verdict-reward.test.mjs` | (create) fresh-state reward tests |

## 5. Testing Strategy (same commit; each with a negative control)

- **Truncated renders as TRUNCATED**: an oversized artifact → `renderLine` contains
  `⚠ TRUNCATED to ~N of M chars` with N < M and never "verbatim"; **negative
  control**: a small artifact in the same call renders `(whole)` and an
  all-small set renders `attached whole` with no `⚠`/`TRUNCATED`.
- **CLI integration (hermetic)**: spawn `brainstorm-round.mjs` with provider keys
  and the Azure profile scrubbed (both providers `misconfigured`, no spend),
  `--no-arch --no-policy`, one large tracked file and one small one via
  `--with-artifact`. Assert the emitted envelope's `renderLine` names the large
  file TRUNCATED and the small one `(whole)`, contains neither "sent" nor
  "verbatim" (nothing was sent: both providers are misconfigured), and stderr carries exactly one
  `artifact TRUNCATED` warning naming the large file. **Negative control**: the
  same run with only the small file → no TRUNCATED anywhere, no warning.
- **Line agrees with what was sent**: from one `loadArtifacts` call, the
  per-artifact content inside `loaded.text` (between its `--- path ---` header and
  the marker) has length exactly `sentChars`, and the render line's N is that
  number — the summary cannot describe a different payload than the one built.
- **Schema keeps the line**: `BrainstormEnvelopeWriteSchema`'s `artifactContext`
  sub-schema round-trips `renderLine`/`sentChars` (a stripped key would fail).
- **Wiring through `recordGeminiOutcomes`** (`process.chdir` into a fresh tmp dir,
  so `.audit/bandit-state.json` starts absent): an `APPROVE` result leaves
  `gemini-review:<rev>:global` with `pulls === 1`; under `LEARNING_DISABLE=1` the
  state file is never created (the constructor guard). **Failure branches** via an
  injected stub bandit: `update` returning `false` → `update-rejected` + the stderr
  warning; `addArm` throwing → `error`, and no throw escapes.
- **Fresh bandit state records the reward**: `PromptBandit` on an empty tmp state
  file → `recordGeminiVerdictReward` returns `recorded`, arm `gemini-review:<rev>:global`
  has `pulls === 1`. **Negative control**: the pre-fix call shape (`update` without
  `addArm`) on the same fresh state returns `false` — proving the test would catch
  the bug. Plus `LEARNING_DISABLE=1` → `learning-disabled`, no arm created, and
  coverage-gated → no pull.

No live provider calls.

## 6. Implementation Phases

1. Bug 1 code + schema + tests.
2. Bug 2 helper + tests.
3. Close-out: `npm run skills:regenerate`, `npm run skills:check`,
   `npm run skills:size:gate`, the touched suites (`brainstorm-*`, `bandit`, the
   new test), `npm run guards:preflight`. CES's full `npm test` runs in the
   `full-suite.yml` PR job (AGENTS.md §Testing — this repo's full suite runs in
   Actions, not on the shared machine); the PR is not reported done until that
   job is green.

## 7. Risk & Trade-off Register

| Risk | Mitigation |
|---|---|
| New envelope keys stripped by Zod | Declared in schema; round-trip test |
| Old session rows lack the keys | Fields optional on read |
| SKILL.md grows past the size ratchet | Replacing prose with a field pointer is net shorter; gate run in close-out |
| `addArm` in a checkout with learning off | Gated on `LEARNING_DISABLE=1` before the bandit is constructed |

## 8. Out of scope (named, independent)

- `recordGeminiOutcomes`'s finding-level `outcomes.jsonl` / FP-tracker writes do not
  consult `LEARNING_DISABLE` either. The fix here neither calls nor depends on that
  path's gating (it touches only the verdict-reward branch), so it is a separate
  follow-up rather than a silent defer.

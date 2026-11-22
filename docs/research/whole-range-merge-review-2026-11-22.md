# Whole-range merge review: does one review of a merged range find what per-PR audits missed?

Date 2026-11-22. Range `0ce1f50e..b52a77f1` (33 squash commits, #410-#449, 427 files, +42,592/-1,392). Every figure is labelled
**measured** (a command's output), **derived** (arithmetic on measured figures) or **expected**.

## Verdict

**Adopted, at the margin.** Rule fixed before the run: adopt only if at least 2 findings are real, missed by the per-PR audits and
MEDIUM or above. **Measured: 2** (severities are this verifier's judgement, so the margin is thin). The coordinator playbook §11
now asks for a range review every 20 merges and at the end of a run; 20 is **derived** from one range and should be revised.

## Basis for the shorter-sessions rule (coordinator-playbook §10)

Figures handed to this chip by the coordinator from its transcript measurement (not re-measured here): across 110 sessions, cached-input
reads were about 720 tokens per output token, and one chip reached 4,386 messages. The 300-message threshold in §10 is **expected**
(a judgement, not a measured optimum).

## Method (commands)

1. Digest, not diff: a 42K-line diff is not reviewable in one call. The digest (209K chars, **measured**) holds each commit's
   subject and body, the net diff of `AGENTS.md`, `package.json`, the baselines and `skills/**/*.md`, the first 22 lines of every
   new non-test script and the first 14 of every new doc (75 and 22 here, all included; the builder fails on an unreadable file and
   states the counts in the digest, so a size limit would be a labelled batch, never a silent cap). Builder (scratch script, run from the repo):

   ```js
   // node digest.mjs <base> <head> <out>
   import { execFileSync } from 'node:child_process'; import fs from 'node:fs';
   const [base, head, out] = process.argv.slice(2);
   const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 28 });
   let s = `# RANGE ${base}..${head}\n\n## COMMITS\n`;
   for (const c of git('log', '--reverse', '--format=%h', `${base}..${head}`).trim().split('\n'))
     s += `\n### ${git('log', '-1', '--format=%h %s%n%n%b', c).trim()}\n  ${git('show', '--shortstat', '--format=', c).trim()}\n`;
   for (const f of ['AGENTS.md', 'package.json', '.gate-files.json', '.file-size-baseline.json', '.stdout-flush-baseline.json', 'knip.jsonc', '.fleet.json'])
     s += `\n--- ${f}\n${git('diff', '-U1', base, head, '--', f)}\n`;
   s += `\n## skills\n${git('diff', '-U1', base, head, '--', 'skills/**/*.md')}\n`;
   const added = (p) => git('diff', '--diff-filter=A', '--name-only', base, head, '--', p).trim().split('\n').filter(Boolean);
   const lead = (f, n) => git('show', `${head}:${f}`).split('\n').slice(0, n).join('\n'); // throws on an unreadable file
   const newScripts = added('scripts').filter(f => !f.includes('test')), newDocs = added('docs');
   for (const f of newScripts) s += `\n--- ${f}\n${lead(f, 22)}\n`;
   for (const f of newDocs) s += `\n--- ${f}\n${lead(f, 14)}\n`;
   s += `\n## COVERAGE: ${newScripts.length} new scripts and ${newDocs.length} new docs, all included\n`;
   fs.writeFileSync(out, s);
   ```
2. One call through the repo's seam, `createAnthropicClient()` (backend `sdk`) with `resolveModel('latest-opus')` = `claude-opus-5-5`,
   `max_tokens` 16000, prompt: report only cross-PR problems (duplicated mechanisms, contradicting rules or docs, overlapping gates,
   cumulative growth, a later PR undoing an earlier one), cite PRs and paths, at most 12 findings, JSON.
3. Verification: every finding checked against the tree at `b52a77f1` (grep, file reads, `node scripts/check-help-readonly.mjs`,
   `node scripts/skill-size-ratchet.mjs`), and against the per-PR audit store with a READ-ONLY query over `audit_findings` created
   since 2026-11-19 (2,117 rows, **measured**) for the finding's keywords.
4. Negative control: the same prompt and builder over a 7-PR range judged coherent (telemetry, solo-control and model-eval work):
   `9356566d..f5d74cbe` (#421, #422, #425, #426, #427, #429, #430).

## Cost (measured tokens, derived dollars at the repo's own table, `model-pricing-table.mjs`: $4 in / $20 out per M)

| Run | Input tokens | Output tokens | Derived USD |
|---|---|---|---|
| Full range, run 1 (`max_tokens` 8000, output truncated at finding 9) | 86,227 | 8,000 | 0.51 |
| Full range, run 2 (`max_tokens` 16000, complete: 11 findings) | 86,227 | 8,174 | 0.51 |
| Control, 7 PRs (8 findings) | 15,481 | 4,238 | 0.15 |
| **Total** | | | **1.17** (cap 8) |

Human cost is larger than the model's: verifying about 13 distinct findings took one chip session.

## Findings, verified at `b52a77f1`

Class 1 = real and missed by the per-PR audits; class 2 = real but already caught or tracked; class 3 = false.

| # | Finding | Class | Severity | Evidence |
|---|---|---|---|---|
| A | `skills/plan/SKILL.md:115` still tells the planner `cloud:true, records:[]` means "No near-duplicates found - proceed", after #412 made an empty result over unverified coverage "absence of evidence" (`arch-render.mjs` renders it so; the SKILL line contradicts its own CLI) | 1 | **MEDIUM** | the audit store has two findings on that area (a generated-copy edit, a missing-adapter case), none on this line |
| B | `model-eval/case-tree.mjs:21` keeps its own 8-name `GIT_REPO_SELECTORS` list beside `git-env-sanitize.mjs`, whose header names two hand-kept lists as the drift risk (git has 15 local vars) | 1 | **MEDIUM** | the store has the case-tree finding (R1, MEDIUM: inherited GIT_DIR); the per-PR fix was the local list, nobody asked why not the shared sanitizer |
| C | two different `makeGitRunner` (`worktree-identity.mjs`: 10 s, retry once; `audit/round-signals.mjs`: no timeout, 256 MB) | 1 | LOW | store: no hit. The "opposite retry rules" half is false (local probe vs `ls-remote`, each documented) |
| D | `telemetry-export/deliver.mjs` header says "exactly git add, commit, push"; #430 made it plumbing commit, lease-pinned push, rollback | 1 | LOW | code at `deliver.mjs:156-191` |
| E | `reader.mjs` says "five things", lists six states; PR title says "four-state" | 1 | LOW | `reader.mjs:3` |
| F | `round-cap-and-structural-card.md` code-only step-back section ships unchanged in the audit-plan copy | 1 | LOW | identical sections, one shared canonical |
| G | "A rerun may diagnose, never clear" restated in AGENTS.md, `ci-wait.md` and the playbook | 1 | LOW | deliberate tripwire plus skill copies; the `landing.md` pointer resolves |
| H | `docs/plans/solo-control-hardening.md` still "In Progress ... merge pending" (control only) | 1 | LOW | plan header line 4 |
| I-N | "later squash re-carries earlier PRs" (stacked-PR commit lists in a message body; the net tree has #411's work), "size ratchets gamed" (`audit-code/SKILL.md` +78 bytes in 33 commits, baseline holds), "AGENTS.md says 27 gated sentences, PRs disagree" (27 contracts, 27 distinct), "two not-measured mechanisms" (different concerns, no overlap shown), "CLIs bypass the help guard" (`help-readonly`: 208 CLIs, 0 offenders), "`store-setup.json` second owner" (one parser reads both keys) | 3 | n/a | each checked as stated |

Class 2: none found. Full range: 7 distinct real (2 MEDIUM+, 5 LOW) and 6 false, a false-positive rate of **6 of 13 (46%)**.

## Negative control

Control range, 8 findings: 3 real (all LOW: D, E, H), 5 false (drop-directory logic "implemented three times" - both callers import the
same `scanDrop`; a stdout-flush baseline race that the baseline file contradicts; two size-ratchet "workarounds"; one-letter-apart
npm script names). False-positive rate **5 of 8 (63%)**, with **0 MEDIUM-or-above class-1 findings**. In this one control range the prompt
produced no MEDIUM-or-above real finding (n = 1, so not a claim about coherent ranges in general), and about half of everything it said
was false: every finding needs verifying.

## Limits

- n = 1 range, severities set by the verifier after seeing the evidence; 2 is the rule's minimum, so a different grader could read 1.
- The per-PR cross-check was a keyword query over the audit store, not a reading of every ledger.
- The digest omits function bodies by design; a defect visible only in code, not in headers, bodies or docs, is out of reach.
- Expected, not measured: N = 20 merges. It is 33 commits / 2 qualifying findings, rounded to a cadence.

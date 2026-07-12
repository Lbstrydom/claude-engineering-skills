# KD curation worksheet — 2026-07-12 sweep

> **SUPERSEDED (same day):** curation was executed in-session — 7 entries
> (KD-020..KD-026) added to `known-defects.json`, corpus now 15/15 usable.
> One shortlist candidate was discarded (Gemini token-cap: hindsight-only
> knowledge) and one re-paired (KD-022's true introducer is `b6917174`, not
> the harvested pairing). See
> [`kd-curation-adjudication-pack.md`](kd-curation-adjudication-pack.md) for
> the full evidence + the independent-LLM review prompt. This file is kept as
> the record of how the shortlist was ranked.

**Context.** After the two `findSensitivePathMentions` false-positive fixes
(word/word prose + `process.env.X` mid-identifier match), the corpus is
already back at **8/8 usable** claude-engineering-skills entries — KD-002 and
KD-006 recovered with no curation (they were blocked purely by `process.env.*`
reads in their diffs). Everything below is **margin-building**: each entry you
curate raises the promotion tier's sample size above the `minSampleSize: 8`
floor in `scripts/lib/model-eval/config/auditor-thresholds.json`, so one stale
entry can no longer drop a run to `inconclusive`. Recommended: curate 3–5 of
the shortlist below. Diminishing returns after ~15 total — per-eval LLM cost
scales linearly with corpus size (each entry runs 5-pass generation for BOTH
candidate and baseline, plus blind judging).

Source pool: 89 unique buggy commits in
`known-defects.candidates.json` now pass all three deterministic gates
(diff ≤ 200K chars, `assertEgressSafe`, `findSensitivePathMentions`).
Ranked shortlist below = best 8 by fix-shape/surgical-ness/confidence.

## Your job per entry (~10 min each)

1. **Read the fix commit** — this is the objective evidence a defect existed:
   `git show ac013eda4fe05953ad5bab1d5c8cbc98fb4f4cae` (real SHA per entry below).
2. **Read the buggy commit's diff** — this is exactly what the evaluated model
   will see: `git show 1823c7c81edfaa6624d29dd5de984031c4d20afe`.
3. **Confirm causality** (the go/no-go judgment): the thing the fix repairs
   must be *visible in the buggy diff* — i.e. a careful reviewer of the buggy
   commit could plausibly have flagged it. Blame-derived pairs (all of these)
   can be wrong: if the fix actually repairs something introduced elsewhere,
   **discard the candidate**, don't force it.
4. **Fill in the skeleton** (pre-filled below) and append it to the `defects`
   array in `docs/experiments/audit-effectiveness/known-defects.json`:
   - `files` — narrow to the defect-location file(s) only. MUST be paths
     changed in the **buggy** commit (loader hard-fails otherwise:
     `declared_files_not_in_diff`).
   - `evidenceHunk` — `path:Lx-Ly (functionName)` of the defective lines in
     the buggy commit.
   - `defectDesc` — one precise mechanical sentence: what is wrong and when
     it bites (see KD-001 in known-defects.json for the house style).
   - `expectedFindingRubric` — what an auditor finding must say to count as
     a catch. Scoring is Jaccard token-overlap (`text-similarity.mjs`), so
     write it in natural reviewer vocabulary, not exotic phrasing.
   - `severity` — HIGH / MEDIUM / LOW by real blast radius.
5. **Validate** (paste-ready, PowerShell-safe):
   ```powershell
   node -e "import('node:fs').then(async fs => { const { loadCorpusCase } = await import('./scripts/lib/model-eval/known-defect-corpus.mjs'); const kd = JSON.parse(fs.readFileSync('docs/experiments/audit-effectiveness/known-defects.json','utf8')); for (const d of kd.defects.filter(x => x.repo === 'claude-engineering-skills')) { try { const r = loadCorpusCase({ kdEntry: d, repoRoots: [process.cwd()] }); console.log(d.id, 'USABLE', r.visibleInput.diff.length); } catch (e) { console.log(d.id, 'BLOCKED', e.message.slice(0,120)); } } })"
   ```
   Then `npm test`.

**Do not pick** candidates whose buggy diff touches `sensitive-paths.mjs`,
`egress-path-scan.mjs`, `secret-patterns.mjs`, or test fixtures containing
literal `id_rsa`/`.env`/key-shaped strings — they self-trip the gate forever.

## Ranked shortlist (all currently gate-clean)

### 1. Missing required deps → install broken (surgical: 1 file, 4.4K diff)
- Buggy `1823c7c81edfaa6624d29dd5de984031c4d20afe` — "feat: auto-install npm deps in target repo during skill install"
- Fix `ac013eda4fe05953ad5bab1d5c8cbc98fb4f4cae` — "fix: move @google/genai and @anthropic-ai/sdk to required deps"
- Likely defect: dep-install list omitted packages the installed scripts import.
```json
{
  "id": "KD-020",
  "repo": "claude-engineering-skills",
  "buggyCommit": "1823c7c81edfaa6624d29dd5de984031c4d20afe",
  "fixCommit": "ac013eda4fe05953ad5bab1d5c8cbc98fb4f4cae",
  "files": ["scripts/install-skills.mjs"],
  "evidenceHunk": "FILL-IN",
  "defectDesc": "FILL-IN",
  "expectedFindingRubric": "FILL-IN",
  "severity": "MEDIUM"
}
```

### 2. cwd-dependent sibling resolution (3 files, 27K)
- Buggy `fb8244f749b93c5b3ba1a62ecc30a23f02e85a5c` — "refactor(refresh): async streaming subprocess for liveness (WS-LIVE)"
- Fix `dc64e319900375d5371361c024a2e3855f9cd78a` — "fix(arch:refresh): resolve pipeline siblings via import.meta.dirname"
- Likely defect: pipeline resolved sibling script paths relative to cwd, breaking invocation from any other directory.
```json
{
  "id": "KD-021",
  "repo": "claude-engineering-skills",
  "buggyCommit": "fb8244f749b93c5b3ba1a62ecc30a23f02e85a5c",
  "fixCommit": "dc64e319900375d5371361c024a2e3855f9cd78a",
  "files": ["scripts/symbol-index/refresh.mjs"],
  "evidenceHunk": "FILL-IN",
  "defectDesc": "FILL-IN",
  "expectedFindingRubric": "FILL-IN",
  "severity": "MEDIUM"
}
```

### 3. ux-lock report matching not rootDir-aware (2 files, 3.8K — smallest)
- Buggy `5a0f667e50223cad7b89fa337485922e9c687a80` — "fix(ux-lock): rootDir-aware report matching + validated run_context"
- Fix `c9c805b514a0579189068721d40c6d6688a4453e` — "fix(store): harden plan/spec writes + verify-skipped + verifier fail-closed"
```json
{
  "id": "KD-022",
  "repo": "claude-engineering-skills",
  "buggyCommit": "5a0f667e50223cad7b89fa337485922e9c687a80",
  "fixCommit": "c9c805b514a0579189068721d40c6d6688a4453e",
  "files": ["scripts/ux-lock-run.mjs"],
  "evidenceHunk": "FILL-IN",
  "defectDesc": "FILL-IN",
  "expectedFindingRubric": "FILL-IN",
  "severity": "MEDIUM"
}
```

### 4. cache-check reads stale local log instead of cloud DB (12K)
- Buggy `6498f99b61b8ddea88456e29dfc017bae9db81c3` — "feat(audit): persist cache metrics to Supabase audit_runs + cloud-aware check"
- Fix `87738e8315fd54671e47ace4a3f10f459b1c56c8` — "fix(cache-check): load shared ~/.audit-loop.env so it reads the DB, not a stale local log"
- Likely defect: env-loading gap → silently reported stale local data as current.
```json
{
  "id": "KD-023",
  "repo": "claude-engineering-skills",
  "buggyCommit": "6498f99b61b8ddea88456e29dfc017bae9db81c3",
  "fixCommit": "87738e8315fd54671e47ace4a3f10f459b1c56c8",
  "files": ["scripts/cache-hitrate-check.mjs"],
  "evidenceHunk": "FILL-IN",
  "defectDesc": "FILL-IN",
  "expectedFindingRubric": "FILL-IN",
  "severity": "MEDIUM"
}
```

### 5. Fuzzy file discovery pulls audit infra into its own audit scope (1 file, 7.2K)
- Buggy `eecdbf98915811e63d0223fd2d7ef95173435ea2` — "fix: add fuzzy file discovery when plan paths don't match exact filenames"
- Fix `9d0ce472c5cd2d1c5e7efa5c26bfa1231274d23a` — "fix: exclude audit-loop infrastructure files from audit scope"
- Likely defect: fuzzy discovery matched the audit tooling's own files, feeding audit infrastructure into its own audit scope (noise + self-reference).
```json
{
  "id": "KD-024",
  "repo": "claude-engineering-skills",
  "buggyCommit": "eecdbf98915811e63d0223fd2d7ef95173435ea2",
  "fixCommit": "9d0ce472c5cd2d1c5e7efa5c26bfa1231274d23a",
  "files": ["scripts/lib/file-io.mjs"],
  "evidenceHunk": "FILL-IN",
  "defectDesc": "FILL-IN",
  "expectedFindingRubric": "FILL-IN",
  "severity": "MEDIUM"
}
```

### 6. TDZ crash — remaining refs to mergedResult (3 files, 6.4K)
- Buggy `f92bca7e8086e2c11b7a2ce7c86935ac058ded85` — "fix: TDZ crash in suppression + Gemini schema stripping"
- Fix `5a3556326d9b0014d8bffac56e523950ce9251b0` — "fix: remaining TDZ refs to mergedResult in openai-audit.mjs"
- Attractive: an incomplete fix (the buggy commit fixed SOME TDZ refs, missed others) — a classic reviewer catch.
```json
{
  "id": "KD-025",
  "repo": "claude-engineering-skills",
  "buggyCommit": "f92bca7e8086e2c11b7a2ce7c86935ac058ded85",
  "fixCommit": "5a3556326d9b0014d8bffac56e523950ce9251b0",
  "files": ["scripts/openai-audit.mjs"],
  "evidenceHunk": "FILL-IN",
  "defectDesc": "FILL-IN",
  "expectedFindingRubric": "FILL-IN",
  "severity": "HIGH"
}
```

### 7. Gemini maxOutputTokens uncapped past SDK streaming threshold (20K)
- Buggy `df6c7f9bd8fcffcf9bb69c86b9f1dae493c11c0b` — "fix: address audit-loop efficiency gaps from field feedback"
- Fix `fbd1121c16f5662812ea7aa928e0728af53f48ca` — "fix: cap Gemini maxOutputTokens at 21333 (SDK streaming threshold)"
```json
{
  "id": "KD-026",
  "repo": "claude-engineering-skills",
  "buggyCommit": "df6c7f9bd8fcffcf9bb69c86b9f1dae493c11c0b",
  "fixCommit": "fbd1121c16f5662812ea7aa928e0728af53f48ca",
  "files": ["scripts/lib/config.mjs", "scripts/gemini-review.mjs"],
  "evidenceHunk": "FILL-IN",
  "defectDesc": "FILL-IN",
  "expectedFindingRubric": "FILL-IN",
  "severity": "MEDIUM"
}
```

### 8. setup CLI consumer-layout migrate path (3 files, 41K — largest, take last)
- Buggy `be9545d6f9e854eef8d9dd5d808cd8afd1d52d73` — "feat(postgres-parity): M2 — setup CLI + compat-bootstrap + adopt-mode"
- Fix `bc3c8f1b69cb4643d8e7e548484e31a41ec65e7c` — "fix(nav-audit,setup): consumer-layout migrate path + unauth-draft warning + sentinel"
```json
{
  "id": "KD-027",
  "repo": "claude-engineering-skills",
  "buggyCommit": "be9545d6f9e854eef8d9dd5d808cd8afd1d52d73",
  "fixCommit": "bc3c8f1b69cb4643d8e7e548484e31a41ec65e7c",
  "files": ["scripts/setup-postgres.mjs"],
  "evidenceHunk": "FILL-IN",
  "defectDesc": "FILL-IN",
  "expectedFindingRubric": "FILL-IN",
  "severity": "MEDIUM"
}
```

## Rejected during ranking (don't revisit without reason)

- `3405d1463b` (revert, high confidence) — docs-only plan-file removal/revert; not an auditor-findable code defect.
- `aee44183be` / `e2ca809b8c` / `0d39e99e8a` — all blame-attributed to one fix ("enable RLS on audit_loop_migrations"); 3-way blame spread means attribution is guesswork; the real introducer is likely the migration commit itself.
- `da469140e0` — the fix (mask secrets in setup-cloud `--format json`) is a real security defect, but the blamed buggy commit ("add adaptive-context modules to CORE_SCRIPTS") looks unrelated — likely a pure-addition defect wrongly attributed by blame.

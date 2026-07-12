# Known-Defect Corpus Curation — Independent Adjudication Pack

Date: 2026-07-12 · Curator: Claude (Fable 5), single session · Repo: claude-engineering-skills (public, MIT)

---

## PROMPT FOR THE ADJUDICATOR (start here)

You are an independent adjudicator reviewing 7 newly curated entries for a
ground-truth corpus of known software defects. The corpus is used to evaluate
LLM code-auditor models: a candidate model reviews the diff of a known-buggy
commit, and its findings are scored against the curated entry. A **bad corpus
entry corrupts every future model evaluation**, so your job is to be skeptical.
You have no stake in these entries being accepted — the curator (an LLM) may
have made errors, and several entries carry curator-flagged concerns.

For **each of the 7 proposed entries**, return a verdict:

- **ACCEPT** — the entry is valid ground truth as written.
- **REVISE** — the defect is real but a field is wrong or suboptimal
  (rubric too narrow/too generous, wrong severity, wrong files, description
  inaccurate). Provide the concrete replacement text.
- **REJECT** — the entry fails one or more validity criteria below. State which.

Check each entry against these **validity criteria**:

1. **Causality** — does the fix commit actually prove the buggy commit carried
   this defect? (Blame-derived pairs can be misattributed; a later refactor of
   the same lines is NOT a fix.)
2. **Diff-visibility** — is the defect visible in the buggy commit's diff (the
   defective lines are added/modified there), such that a competent reviewer
   of THAT diff could in principle have flagged it?
3. **No hindsight-only knowledge** — could a reviewer have known this was wrong
   AT THE TIME of the buggy commit? An entry is invalid if the defect only
   became a defect due to a later external change (SDK behavior change,
   dependency update, requirement added later).
4. **Rubric fairness** — the `expectedFindingRubric` describes what a correct
   finding would say, in natural reviewer vocabulary. Scoring uses token-overlap
   similarity (Jaccard) plus a file match, so the rubric must neither be so
   specific that a correct paraphrase misses it, nor so generic that an
   unrelated finding matches it.
5. **Severity calibration** — HIGH = crash / data loss / silently-dead feature;
   MEDIUM = wrong behavior with a loud failure or bounded blast radius;
   LOW = cosmetic/inefficiency.
6. **Files correctness** — `files` lists the defect-location file(s), and those
   files are changed in the buggy commit.

Also answer these **three cross-cutting questions** at the end:

- **Q1**: KD-021 and KD-026 are the same defect *class* (path resolution breaks
  under a documented relocation layout) in different subsystems. Is having both
  in one corpus acceptable, or does it double-weight one skill and bias the
  evaluation? Recommend keeping both / dropping one.
- **Q2**: KD-022 packs two distinct defects into one entry with an either/or
  rubric. Is that acceptable for token-overlap scoring, or should it be split /
  narrowed to one defect?
- **Q3**: Review the curator's five REJECTED candidates (section at the end).
  Do you agree with each rejection? Flag any you would have accepted.

Output format: a table of |ID|verdict|one-line reason|, then per-entry detail
only where the verdict is REVISE or REJECT, then Q1–Q3 answers.

---

## Context: how the corpus is used (read before judging)

- Corpus file: `docs/experiments/audit-effectiveness/known-defects.json` —
  hand-curated entries, each pairing a **buggyCommit** (the defect introducer)
  with a **fixCommit** (objective, after-the-fact proof the defect was real).
- At evaluation time, a loader extracts `git diff buggyCommit^ buggyCommit`
  (context width -U8) and hands it to the candidate auditor model as "review
  this change". The model does NOT see the fix commit or the entry.
- Scoring (`deterministic-scorer.mjs`): a candidate finding "catches" the
  defect if its `file` exactly matches one of the entry's `files` AND its
  text has sufficient token-overlap (Jaccard) with `expectedFindingRubric`.
- Evaluated models also receive general project context (the repo's AGENTS.md
  conventions), so defects that are only catchable *given documented project
  invariants* (e.g. "tooling must survive relocation to the consumer layout")
  are fair game — that context is available to the reviewer.
- **Correction (post-adjudication, 2026-07-12)**: the harness additionally
  reads the entry's files as full-file context — but from the CURRENT
  checkout, not the buggy-commit state (the fix is typically already applied
  there). Defect visibility must therefore be judged on the **diff alone**;
  any "full file context" argument in a curator rationale below is void.
- Known structural limitation (accepted, documented): entries come from real,
  organic commits, so a reviewing model often finds OTHER genuine bugs in the
  same diff and gets no credit. Judge entries on validity, not on whether the
  one curated defect is the only defect present.
- All commits below are from a public MIT-licensed repository; sharing these
  diffs externally is fine.

Harvest provenance: candidates were mined from local git history by
`scripts/defect-harvest.mjs` (revert / "Fixes <sha>" / blame-derived pairs),
mechanically filtered (diff ≤ 200K chars, secret-content scan, sensitive-path
scan), then ranked and hand-verified by the curator, who read both commits of
each pair before writing the entry. Blame-derived pairs (`kind: blame`) carry
attribution risk — blame follows line-rewrites, so the "introducer" can be a
refactor that merely touched the lines. Two of the harvested pairs were
re-paired by the curator for exactly this reason (noted per-entry).

Post-curation validation: all 7 entries load USABLE through the corpus loader
(diff extraction + egress gates + declared-files-in-diff check). The corpus now
has 15 usable claude-engineering-skills entries (was 8).

---

## Proposed entries

### KD-020 — deps the pipeline hard-requires classified as optional

```json
{
  "id": "KD-020",
  "repo": "claude-engineering-skills",
  "buggyCommit": "1823c7c81edfaa6624d29dd5de984031c4d20afe",
  "fixCommit": "ac013eda4fe05953ad5bab1d5c8cbc98fb4f4cae",
  "files": ["scripts/install-skills.mjs"],
  "evidenceHunk": "scripts/install-skills.mjs:L214-L219 (main — REQUIRED_DEPS/OPTIONAL_DEPS classification)",
  "defectDesc": "The dependency auto-installer classifies @google/genai and @anthropic-ai/sdk as OPTIONAL_DEPS whose install failure is swallowed (\"audit will degrade gracefully\"), but the multi-model audit pipeline hard-imports both (Gemini auditor, Claude Opus fallback reviewer) — a consumer whose optional install fails gets a runtime import crash in the core audit flow, not graceful degradation.",
  "expectedFindingRubric": "flags that dependencies the pipeline hard-requires at runtime (@google/genai and/or @anthropic-ai/sdk) are classified as optional with swallowed install failure — the required-vs-optional dependency classification does not match actual runtime imports",
  "severity": "MEDIUM"
}
```

**Curator rationale.** Buggy commit (2026-04-07 08:18, "feat: auto-install npm
deps in target repo during skill install") introduces the classification;
the fix (same day, 08:21, ~2 minutes later) moves both packages to required.
The misclassification is fully visible in the buggy diff's added lines.
Confidence: high. Harvest kind: blame.

**Buggy diff (defective lines, added in this commit):**
```js
const REQUIRED_DEPS = ['openai', 'zod', 'dotenv', 'micromatch'];
// Optional: enhance audit quality but core loop works without them
const OPTIONAL_DEPS = ['@google/genai', 'proper-lockfile', '@anthropic-ai/sdk'];
...
} catch {
  console.log(`  ${Y}○${X} Some optional deps failed — audit will degrade gracefully`);
}
```

**Fix commit message:** "fix: move @google/genai and @anthropic-ai/sdk to
required deps — These are needed for the multi-model pipeline (Gemini auditor
in variant B, Claude Opus fallback reviewer). Only proper-lockfile remains
optional."

**Fix diff (core):**
```js
-const REQUIRED_DEPS = ['openai', 'zod', 'dotenv', 'micromatch'];
-const OPTIONAL_DEPS = ['@google/genai', 'proper-lockfile', '@anthropic-ai/sdk'];
+const REQUIRED_DEPS = ['openai', 'zod', 'dotenv', 'micromatch', '@google/genai', '@anthropic-ai/sdk'];
+const OPTIONAL_DEPS = ['proper-lockfile'];
```

---

### KD-021 — pipeline siblings spawned via cwd-relative paths

```json
{
  "id": "KD-021",
  "repo": "claude-engineering-skills",
  "buggyCommit": "fb8244f749b93c5b3ba1a62ecc30a23f02e85a5c",
  "fixCommit": "dc64e319900375d5371361c024a2e3855f9cd78a",
  "files": ["scripts/symbol-index/refresh.mjs"],
  "evidenceHunk": "scripts/symbol-index/refresh.mjs:L261-L310 (extract/summarise/embed spawn call sites — cwd-relative script paths)",
  "defectDesc": "The extract→summarise→embed pipeline spawns its sibling scripts via cwd-relative string paths (scripts/symbol-index/extract.mjs etc.) that only exist in the source-repo layout; in a consumer repo the tooling is relocated under scripts/.claude-skills/, so every spawn is MODULE_NOT_FOUND and arch:refresh is silently dead in all consumers.",
  "expectedFindingRubric": "flags that sibling pipeline scripts are spawned via cwd-relative path strings instead of resolving relative to the current module (import.meta.dirname / fileURLToPath), breaking when the tooling is relocated to the consumer layout or invoked from a different working directory",
  "severity": "HIGH"
}
```

**Curator rationale + flagged concern.** The buggy commit (2026-05-23,
"refactor(refresh): async streaming subprocess for liveness (WS-LIVE)")
rewrote the spawn call sites wholesale — the cwd-relative path strings
(`'scripts/symbol-index/extract.mjs'` as a spawn argument) appear as ADDED
lines in its diff, so criterion 2 is met. **Concern to weigh**: the path
*shape* predates this commit (the refactor carried it forward rather than
minting it), so "introducer" is arguable — but the repo's relocation contract
(tooling must survive `scripts/.claude-skills/` relocation) was documented in
AGENTS.md at the time, so a reviewer of these added lines had the context to
flag it. The fix confirms real impact: "arch:refresh had been dead in
consumers since the isolation migration" (silent — masked by another bug).
Severity HIGH for silently-dead-feature-in-all-consumers. Harvest kind: blame.

**Buggy diff (added spawn lines, -U8 excerpt):**
```js
const extractArgs = ['scripts/symbol-index/extract.mjs', '--root', repoRoot, '--mode', mode];
...
const summarised = await runJsonLinesAsyncStrict('node', ['scripts/symbol-index/summarise.mjs'], {
...
const embedded = await runJsonLinesAsyncStrict('node', ['scripts/symbol-index/embed.mjs'], {
```

**Fix commit message (core):** "refresh.mjs spawned extract/summarise/embed via
cwd-relative paths (scripts/symbol-index/*.mjs) that only exist in the source
repo. In a consumer the tooling lives under scripts/.claude-skills/symbol-index/,
so the spawn was a silent MODULE_NOT_FOUND — arch:refresh had been dead in
consumers since the isolation migration... resolve them off import.meta.dirname,
which is correct in both layouts."

---

### KD-022 — Playwright runner: two silent-data-loss defects

> **OUTCOME: REVISED** (3/3 adjudicators) — narrowed to the rootDir defect
> only; see the Adjudication Outcomes section at the end.

```json
{
  "id": "KD-022",
  "repo": "claude-engineering-skills",
  "buggyCommit": "b6917174f1ce2a3bdb866b27680a89c7ee9c409f",
  "fixCommit": "5a0f667e50223cad7b89fa337485922e9c687a80",
  "files": ["scripts/ux-lock-run.mjs"],
  "evidenceHunk": "scripts/ux-lock-run.mjs (cmdSpec — run-context default at the opt() read; report test-file paths resolved via normalizeSpecPath(t.file, repoRoot))",
  "defectDesc": "Two silent-data-loss defects in the new Playwright runner CLI: (1) the default --run-context value (ux-lock) is not in the regression_spec_runs CHECK constraint allowed set, so every default invocation silently drops its DB row; (2) Playwright JSON report file paths are emitted relative to the report rootDir (bare basenames for a nested testDir), but the matcher resolves them against the repo root — every test orphans and the requested spec records 0 tests / passed:false.",
  "expectedFindingRubric": "flags an unvalidated default enum-like value written to a constrained DB column (silent row drop on constraint violation), or that report-relative file paths are resolved against the wrong base directory (repo root instead of the report/testDir root), silently orphaning every test",
  "severity": "MEDIUM"
}
```

**Curator rationale + flagged concerns.** **This pairing was re-paired by the
curator.** The harvester originally paired buggy=5a0f667e with fix=c9c805b5,
but c9c805b5 merely refactors the RUN_CONTEXTS set introduced by 5a0f667e into
a shared constant (refactor, not fix → causality fails). 5a0f667e is itself
the FIX for two real defects; `git log -S` traces both defective lines to
b6917174 ("feat(ux-lock): deterministic Playwright runner", 2026-06-22), where
they are added lines:
```js
const runContext = opt('run-context') || 'ux-lock';    // line 104 of the diff
...
const sp = normalizeSpecPath(t.file, repoRoot);        // line 139 of the diff
```
**Concerns to weigh**: (a) defect 1's catchability requires knowing the DB
CHECK constraint's allowed values, which are in a migration file NOT in this
diff — a reviewer could flag "default value not validated against the DB's
allowed set" as a risk but could not know 'ux-lock' is invalid; (b) defect 2
requires knowing Playwright's report-path convention (rootDir-relative). The
either/or rubric is the curator's mitigation — see cross-cutting Q2. Both
defects were confirmed by real field failures (fix message: "Two more
Windows-consumer failures from the same /ux-lock run"). Harvest kind: blame
(re-paired).

**Fix commit message (core):** "(1) The Playwright JSON report emits file paths
relative to its rootDir (bare basenames for a nested testDir) — the spec
matcher resolved them against the REPO root, so every test was dropped as an
orphan and the requested spec recorded 0 tests / passed:false. (2) The runner
defaulted --run-context to 'ux-lock', which the regression_spec_runs CHECK
constraint has never allowed — the row write failed silently on every default
invocation."

---

### KD-023 — cloud-aware check silently falls back to stale local data

```json
{
  "id": "KD-023",
  "repo": "claude-engineering-skills",
  "buggyCommit": "6498f99b61b8ddea88456e29dfc017bae9db81c3",
  "fixCommit": "87738e8315fd54671e47ace4a3f10f459b1c56c8",
  "files": ["scripts/cache-hitrate-check.mjs"],
  "evidenceHunk": "scripts/cache-hitrate-check.mjs:L28 (bare dotenv/config import) + L37-L45 (HAS_SUPABASE source selection with silent local fallback)",
  "defectDesc": "The new cloud-aware source selection gates on credential env vars loaded via bare dotenv/config, which reads only the cwd .env — in this project the DB credentials normally live in the shared ~/.audit-loop.env, so any run outside the one directory with a local .env silently selects the stale per-machine local log and falsely reports INSUFFICIENT_DATA even when the DB holds ample runs (a wrong-green: the check reports a confident conclusion without having read the authoritative source).",
  "expectedFindingRubric": "flags that the data-source auto-selection depends on env vars that may not be loaded in this invocation context (cwd-only .env loading vs the shared env file), causing a silent fallback to stale/empty local data that is indistinguishable from a genuine no-data state",
  "severity": "MEDIUM"
}
```

**Curator rationale.** The buggy commit's diff ADDS both halves of the defect:
`import 'dotenv/config'` (cwd-only) and the `HAS_SUPABASE = process.env...`
gate with silent fallback to the local log. The failure mode (a confident
wrong answer, not an error) matches the repo's documented "audit your success
paths" doctrine, and the project's shared-env-file convention is documented
context. Fix confirmed the real-world impact: falsely reported
INSUFFICIENT_DATA while the DB held 75 qualifying runs. Confidence: high.
Harvest kind: blame.

**Buggy diff (added lines):**
```js
+import 'dotenv/config';
...
+const HAS_SUPABASE = process.env.SUPABASE_AUDIT_URL
+  && (process.env.SUPABASE_AUDIT_SERVICE_ROLE_KEY || process.env.SUPABASE_AUDIT_ANON_KEY);
+const SOURCE = SOURCE_OVERRIDE ?? (HAS_SUPABASE ? 'supabase' : 'local');
```

**Fix commit message (core):** "cache-hitrate-check.mjs used bare 'import
dotenv/config' (cwd .env only), never loading ~/.audit-loop.env where the
AUDIT_DB_URL DSN usually lives. So when run from a cron/routine... HAS_SUPABASE
was false, it fell back to the per-machine local log, found none, and falsely
reported INSUFFICIENT_DATA / 0 R2+ runs — even though the DB has 75 R2+ runs."

---

### KD-024 — fuzzy file discovery has no self-exclusion for audit tooling

```json
{
  "id": "KD-024",
  "repo": "claude-engineering-skills",
  "buggyCommit": "eecdbf98915811e63d0223fd2d7ef95173435ea2",
  "fixCommit": "9d0ce472c5cd2d1c5e7efa5c26bfa1231274d23a",
  "files": ["scripts/lib/file-io.mjs"],
  "evidenceHunk": "scripts/lib/file-io.mjs:L255-L390 (extractPlanPaths Phase 2 — _extractPlanKeywords/_scanRepoFiles fuzzy discovery, no exclusion of the audit tooling's own files)",
  "defectDesc": "The new fuzzy file-discovery fallback (_scanRepoFiles + keyword matching) scans ALL repo files with no exclusion of the audit tooling's own synced scripts — in consumer repos (where these scripts are synced in) plan keywords fuzzily match the audit infrastructure itself, so the auditors flag issues in the audit tool instead of the project code under review.",
  "expectedFindingRubric": "flags that the fuzzy repo-file scan has no exclusion/denylist for the audit tooling's own files (self-inclusion of infrastructure into audit scope), polluting audit context in consumer repos where the tooling is synced in",
  "severity": "MEDIUM"
}
```

**Curator rationale + flagged concern.** The buggy commit (2026-04, "fix: add
fuzzy file discovery when plan paths don't match exact filenames") adds
`_scanRepoFiles()` walking the whole repo plus keyword matching, with no
exclusion for the tool's own files. The fix (10 days later) adds
`isAuditInfraFile()` applied at four leakage points, citing exactly this
failure ("synced scripts/ files were included in the audit context, causing
Gemini/Claude Opus to flag issues in the audit tool itself"). **Concern to
weigh**: fuzzy discovery WIDENED a pre-existing scope-pollution exposure
rather than creating the category (Phase 1 regex extraction could also match
tool files, and the fix patches those paths too) — is "made an existing
latent problem much more likely to fire" a valid introducer? Also,
catchability requires awareness of the synced-to-consumers deployment model
(documented in project context). Harvest kind: blame.

**Buggy diff (added, core):**
```js
+  const regexFoundCount = [...paths].filter(p => fs.existsSync(path.resolve(p))).length;
+  if (regexFoundCount < 5) {
+    const keywords = _extractPlanKeywords(planContent);
+    if (keywords.length > 0) {
+      const repoFiles = _scanRepoFiles();
+      for (const file of repoFiles) {
+        const basename = path.basename(file).toLowerCase()...
+        // Require strong match: keyword ≥6 chars and covers ≥50% of the basename
```

---

### KD-025 — incomplete TDZ fix: three sibling crash sites remain

> **OUTCOME: REJECTED and removed** (3/3 adjudicators; empirically confirmed
> — see the Adjudication Outcomes section at the end).

```json
{
  "id": "KD-025",
  "repo": "claude-engineering-skills",
  "buggyCommit": "f92bca7e8086e2c11b7a2ce7c86935ac058ded85",
  "fixCommit": "5a3556326d9b0014d8bffac56e523950ce9251b0",
  "files": ["scripts/openai-audit.mjs"],
  "evidenceHunk": "scripts/openai-audit.mjs:L1277-L1321 (runMultiPassCodeAudit — mergedResult._debtMemory/_ledgerRejectedCount/_ledgerWriteError assigned before the const mergedResult definition)",
  "defectDesc": "Incomplete fix of a TDZ crash class: the commit hoists ONE pre-definition assignment (mergedResult._suppression → var _suppressionData) but leaves three identical assignments (mergedResult._debtMemory, ._ledgerRejectedCount, ._ledgerWriteError) earlier in the same function, each still a guaranteed ReferenceError (temporal dead zone on the later const mergedResult) whenever its code path executes.",
  "expectedFindingRubric": "flags that the TDZ fix is incomplete — other assignments to mergedResult before its const definition remain in the same function (same crash class as the one being fixed; the pattern was fixed in one instance but not swept for siblings)",
  "severity": "HIGH"
}
```

**Curator rationale + flagged concern.** The buggy commit ("fix: TDZ crash in
suppression...") fixes the `_suppressionData` instance; the fix commit lands
**3 minutes later** hoisting the three siblings it missed — as direct a
"incomplete fix" proof as exists. **Concern to weigh**: the three remaining
defective lines are NOT inside the buggy commit's own diff hunks (they're
elsewhere in the same function) — a reviewer sees the diff fix one TDZ
instance and must ask "were all instances swept?", which requires the
surrounding file content. The evaluation harness provides full-file context
for changed files, so the sibling lines ARE visible to the evaluated model,
but strictly diff-only reviewers would need to infer the risk. Judge whether
criterion 2 is satisfied under "diff + full file context". Severity HIGH:
each remaining line is a guaranteed ReferenceError on its code path (ledger
write failure path, debt-memory path). Harvest kind: blame.

**Fix diff (proves the three missed siblings):**
```js
-    mergedResult._debtMemory = {
+    // Stored in temp var because mergedResult is defined later (TDZ)
+    var _debtMemoryData = {
...
-        mergedResult._ledgerRejectedCount = rejected.length;
+        var _ledgerRejectedCount = rejected.length;
...
-      mergedResult._ledgerWriteError = err.message;
+      var _ledgerWriteError = err.message;
```

---

### KD-026 — setup CLI repo-root resolution wrong under consumer layout

```json
{
  "id": "KD-026",
  "repo": "claude-engineering-skills",
  "buggyCommit": "be9545d6f9e854eef8d9dd5d808cd8afd1d52d73",
  "fixCommit": "bc3c8f1b69cb4643d8e7e548484e31a41ec65e7c",
  "files": ["scripts/setup-postgres.mjs"],
  "evidenceHunk": "scripts/setup-postgres.mjs:L37 (REPO_ROOT = path.resolve(__dirname, '..') — assumes the source-repo layout) + the repo-relative BOOTSTRAP_SQL path",
  "defectDesc": "The new setup CLI resolves the repo root as path.resolve(__dirname, '..'), which is only correct in the source-repo layout (scripts/ one level below root); under the consumer synced layout (scripts/.claude-skills/) it lands on scripts/, so --migrate fails with ENOENT on the migrations dir in every consumer repo, and compat-bootstrap.sql is resolved repo-relative instead of script-relative.",
  "expectedFindingRubric": "flags that repo-root/path resolution assumes the source layout (__dirname one level below root) and breaks under the documented consumer relocation layout (scripts/.claude-skills/) — path resolution must be layout-aware or script-relative",
  "severity": "MEDIUM"
}
```

**Curator rationale.** The buggy commit (postgres-parity M2, the commit that
CREATED setup-postgres.mjs) introduces `REPO_ROOT = path.resolve(__dirname,
'..')` as an added line. The fix (field-tested against a real consumer repo)
switches to the layout-aware `findRepoRootFromScript()` and documents the
exact failure: "--migrate failed with ENOENT scripts/.audit-loop/migrations in
consumers". Same class as KD-021 but a LOUD failure (ENOENT with a clear
message) vs KD-021's silent death → MEDIUM vs HIGH. See cross-cutting Q1 on
class duplication. Confidence: high. Harvest kind: blame.

**Fix diff (core):**
```js
-const REPO_ROOT = path.resolve(__dirname, '..');
+// `path.resolve(__dirname, '..')` is WRONG under the isolated layout (it lands on
+// `scripts/`, so `--migrate` failed with ENOENT `scripts/.audit-loop/migrations`
+// in consumers). findRepoRootFromScript walks up to the `scripts` ancestor...
+const REPO_ROOT = findRepoRootFromScript(import.meta.url) || path.resolve(__dirname, '..');
-const BOOTSTRAP_SQL = path.join(REPO_ROOT, 'scripts', 'lib', 'db', 'compat-bootstrap.sql');
+const BOOTSTRAP_SQL = path.join(__dirname, 'lib', 'db', 'compat-bootstrap.sql');
```

---

## Candidates the curator REJECTED (verify these too — Q3)

1. **Gemini maxOutputTokens 16000→32000 uncapped** (buggy `df6c7f9bd8`, fix
   `fbd1121c16` "cap at 21333 — SDK streaming threshold"). REJECTED for
   **hindsight-only knowledge**: the fix message says the SDK "**now**
   requires streaming" above 21333 — the constraint appears to have arrived
   AFTER the buggy commit, so the bump was not wrong when written. A reviewer
   at the time could not have flagged it. (Criterion 3.)
2. **Original harvester pairing buggy=`5a0f667e`, fix=`c9c805b5`.** REJECTED
   for **causality failure**: c9c805b5 refactors the RUN_CONTEXTS set into a
   shared constant — a consistency refactor of those lines, not a defect fix.
   Blame attribution artifact. (Re-paired as KD-022 instead.)
3. **The RLS triplet** (buggy `aee44183be` / `e2ca809b8c` / `0d39e99e8a`, all
   → fix `faf02a7cde` "enable RLS on audit_loop_migrations"). REJECTED for
   **attribution noise**: blame spread the fix across three unrelated commits;
   the plausible real introducer is the migration that created the table
   without RLS, which is none of the three.
4. **setup-cloud secrets unmasked in --format json** (fix `1f2954bb17`, blamed
   buggy `da469140e0` "add adaptive-context modules to CORE_SCRIPTS").
   REJECTED for **attribution noise**: the blamed commit is unrelated to the
   defect; likely a pure-addition (omission) defect blame cannot attribute.
   The defect itself is real — a future candidate if the true introducer is
   identified.
5. **Docs-plan revert** (buggy `3405d1463b`, revert pair, high harvest
   confidence). REJECTED: docs-only change, not an auditor-findable code
   defect (the corpus evaluates code auditors).

---

## Validation record (post-curation)

All 15 claude-engineering-skills entries load USABLE through the corpus
loader (`loadCorpusCase`: diff extraction, secret-content egress gate,
sensitive-path-mention gate, declared-files-in-diff cross-check):

```
KD-002 USABLE 39835 · KD-005 USABLE 72557 · KD-006 USABLE 96821
KD-015 USABLE 23180 · KD-016 USABLE 35123 · KD-017 USABLE 87573
KD-018 USABLE 131422 · KD-019 USABLE 48998 · KD-020 USABLE 4407
KD-021 USABLE 26749 · KD-022 USABLE 78000 · KD-023 USABLE 12292
KD-024 USABLE 7210 · KD-025 USABLE 6416 · KD-026 USABLE 41006
(numbers = extracted diff size in chars; cap 200000)
```

Pre-existing blocked entries (unchanged, for completeness): KD-001, KD-003,
KD-004 (their diffs genuinely contain `.env`/`.ssh`/key-shaped fixture text
that the egress gates correctly refuse to send externally), KD-007 (diff
exceeds the 200K bound).

---

## ADJUDICATION OUTCOMES (2026-07-12, applied same day)

Three independent LLM adjudicators reviewed this pack. Verdict matrix:

| ID | Adj-1 | Adj-2 | Adj-3 | Applied outcome |
|---|---|---|---|---|
| KD-020 | ACCEPT | REVISE (severity→HIGH) | ACCEPT | **KEPT at MEDIUM** (2-1) |
| KD-021 | ACCEPT | ACCEPT | ACCEPT (+caveat) | **KEPT**; `provenanceNote` + `defectClass` added |
| KD-022 | REVISE (split) | REVISE (narrow) | REVISE (narrow) | **NARROWED** to the rootDir defect |
| KD-023 | ACCEPT | ACCEPT | ACCEPT | **KEPT** |
| KD-024 | ACCEPT | ACCEPT | ACCEPT | **KEPT** |
| KD-025 | REJECT | REJECT | REJECT | **REMOVED** (empirically confirmed) |
| KD-026 | ACCEPT | ACCEPT | ACCEPT | **KEPT**; `defectClass` added |

**Corpus result: 14 usable claude-engineering-skills entries** (was 15 with
KD-025; still within the 12–15 target band). All 14 re-validated USABLE
through the loader after the edits.

### Decision detail

- **KD-025 removal — empirical confirmation of the unanimous reject.**
  Adjudicator 3 supplied a reinstatement test: extract the actual -U8 diff and
  check whether the three sibling assignments appear anywhere (context lines
  count). Result: they do NOT — the buggy commit's hunks sit at L1163–1185 and
  L1388–1409 while the siblings live at ~L1277–1321, in the gap between hunks.
  Additionally the harness's full-file read comes from the CURRENT checkout
  (fix already applied), so the siblings are invisible there too. The entry
  would have scored an unavoidable miss against every candidate — exactly the
  metric corruption the corpus must prevent. Removed.
- **KD-022 narrowing (3/3).** All three adjudicators found the either/or
  rubric unsound for single-target Jaccard scoring, and 2/3 found the
  run_context defect fails no-hindsight in practice (the CHECK constraint's
  allowed values live in a migration outside the diff — a reviewer could flag
  the *risk* but not know 'ux-lock' is invalid). Kept only the Playwright
  rootDir defect (public, documented framework behaviour). Severity stayed
  MEDIUM (2-1; Adj-2 argued HIGH for silent data loss — outvoted: blast
  radius is bounded to run recording, the suite itself still runs).
  Corpus rule adopted going forward: **one entry = one defect**; if a commit
  fixes two independently catchable defects, curate two entries with distinct
  rubrics.
- **KD-020 severity (2-1 for MEDIUM).** Adj-2 argued the runtime import crash
  demands HIGH per the calibration table. Kept MEDIUM: the crash is
  conditional on an optional-install failure in a degraded environment, not a
  guaranteed code-path crash — "bounded blast radius" governs.
- **Q1 (KD-021/KD-026 class duplication): keep both** (3/3), with the
  recommended mitigation applied: both entries now carry
  `defectClass: "consumer-relocation-path-resolution"` so per-class reporting
  / future corpus balancing can see the double-weighting. If the corpus is
  ever trimmed to a fixed size, drop KD-026 first (Adj-3: keep the harder,
  silent variant).
- **Q3 (five rejections): all upheld 3/3.** Two follow-ups attempted:
  - *Secrets-unmasked introducer re-harvest* (Adj-3 suggestion): found it —
    `b8de7567` ("shared ~/.audit-loop.env autoload", same day as the fix,
    which says "caught dogfooding the just-shipped feature" — clean
    causality). **Not addable**: its diff legitimately discusses env-file
    paths throughout (`.env`, `.claude/audit-loop.env`, …) and hard-fails the
    sensitive-path egress gate (plus 187K chars, near the size cap). An
    env-file-handling commit can never pass an env-file-refusing gate; noted
    as a structural corpus exclusion, not re-attemptable.
  - *Gemini SDK threshold changelog check* (Adj-3 caveat on rejection #1):
    not performed — "now requires" plus the 10-day gap remains suggestive
    but unproven; the rejection stands on current evidence and the candidate
    can be revisited if the SDK changelog ever proves the threshold predates
    the buggy commit.
- **Known corpus bias, now documented** (Adj-3 observation from rejections
  #3/#4): blame-based harvesting structurally cannot attribute pure-omission
  defects (missing RLS, missing masking) — the corpus under-represents "code
  that should exist but doesn't", a class real auditors are expected to
  catch. A future manual harvest lane could attribute omission defects to the
  file-/feature-creating commit (as the b8de7567 re-harvest demonstrated),
  though the egress gate will exclude some candidates by nature.
- **Deferred (recorded, not built)**: per-`defectClass` catch-rate reporting
  in the scorer (Adj-3's mitigation #1). The tag is in place on the two
  relocation entries; the reporting change is scoped for whenever the next
  scorer iteration happens.

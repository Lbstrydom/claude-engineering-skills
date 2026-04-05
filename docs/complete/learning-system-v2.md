# Plan: Learning System v2 — Adaptive Prompt Evolution & Contextual Bandits
- **Date**: 2026-04-02
- **Status**: In Progress (consolidated rewrite after 3 audit rounds)
- **Author**: Claude + Louis
- **Scope**: Overhaul all learning subsystems — FP tracker, bandit, reward function, prompt refinement, outcome management, file-store abstraction

---

## 1. Context Summary

### Purpose
The audit loop has a 5-layer learning stack (outcome logging, FP tracker, Thompson Sampling bandit, cloud persistence, prompt refinement). Each layer works but has gaps that reduce learning quality: coarse pattern keys, unused context bucketing, procedural-only rewards, aggressive EMA, no example-driven refinement, no outcome decay, and a manual prompt update loop.

This plan closes all gaps and adds best practices from the online learning / RLHF literature: contextual bandits, replay buffer sampling, automated TextGrad-style prompt evolution, sliding window statistics, and UCB exploration bonuses.

### Key Requirements
1. **FP pattern granularity** — patterns stored as structured dimensions, repo-aware and file-type-aware
2. **Context-aware bandit** — prompt selection conditioned on repo size and dominant language (hierarchical backoff)
3. **Substantive reward signal** — canonical per-finding reward: procedural (40%) + substantive (30%) + deliberation quality (30%)
4. **Stable EMA** — derived from lazy-decay weighted mean (see 2.7), not a standalone function
5. **Example-driven refinement** — LLM sees actual dismissed/accepted findings with ruling rationale
6. **Outcome decay** — time-weighted statistics with 30-day half-life; stale outcomes pruned
7. **Automated prompt evolution** — TextGrad + bandit = LLM generates variants, bandit A/B tests, human reviews winners
8. **Backward compatible** — all changes degrade gracefully; existing local-only mode unaffected
9. **Shared file-store abstraction** — one `MutexFileStore` class for all read-modify-write state
10. **Seedable RNG** — deterministic testing for all stochastic components

### Non-Goals
- Replacing Thompson Sampling with a full neural contextual bandit (too complex for this codebase size)
- Real-time prompt updates mid-audit (prompt is fixed per run)
- Multi-tenant cloud learning (single-user Supabase, cross-repo only)

---

## 2. Proposed Changes

### 2.1 FP Tracker: Structured Dimensions & Multi-Scope Counters

**File**: `scripts/lib/findings.mjs` — `FalsePositiveTracker`

**Current**: Pattern key is `category::severity::principle` — same bucket across all repos and file types.

**Change**: Replace string-key model with structured dimension storage. Each observation updates counters at all applicable scope levels in one operation.

**Structured pattern record** (see Appendix A.1 for canonical Zod schema):

```javascript
/**
 * FP pattern record — structured dimensions, not embedded string keys.
 * One record per unique combination of dimensions at each scope.
 */
const FPPatternRecord = {
  // Dimensions (structured, not embedded in key)
  category: 'missing error handling',
  severity: 'MEDIUM',
  principle: 'robustness',
  repoId: 'abc123',         // GLOBAL_REPO_ID for global scope
  fileExtension: 'mjs',     // UNKNOWN_FILE_EXT for global scope
  scope: 'repo+fileType',   // 'global' | 'repo' | 'repo+fileType'
  
  // Counters (lazy-decay model — see 2.7)
  dismissed: 0,             // Raw lifetime count (for diagnostics only)
  accepted: 0,              // Raw lifetime count (for diagnostics only)
  decayedAccepted: 0,       // Time-decayed accepted weight
  decayedDismissed: 0,      // Time-decayed dismissed weight
  lastDecayTs: Date.now(),  // Timestamp of last decay application
  ema: 0.5,                 // Derived from decayed weights after each update
  firstSeen: Date.now(),
  lastUpdated: Date.now()
};
```

**Multi-scope write**: When recording an observation, update counters at all 3 scope levels:

```javascript
record(finding, accepted, repoFingerprint = null, filePath = null) {
  const dims = extractDimensions(finding, repoFingerprint, filePath);
  
  // Update all 3 scope levels in one operation
  const scopes = [
    { ...dims, scope: 'repo+fileType' },
    { ...dims, fileExtension: UNKNOWN_FILE_EXT, scope: 'repo' },
    { ...dims, repoId: GLOBAL_REPO_ID, fileExtension: UNKNOWN_FILE_EXT, scope: 'global' }
  ];
  
  for (const scopeDims of scopes) {
    const key = buildPatternKey(scopeDims);
    this._updatePattern(key, scopeDims, accepted);
  }
  // Persistence via MutexFileStore (see 2.12)
  this._store.save(this.patterns);
}
```

**Legacy data strategy**: Existing pattern keys (old format without structured dimensions) are **never migrated or re-keyed**. They are preserved as global-scope records. New observations collected prospectively with full structured metadata at all scope levels.

**Lookup strategy**: Hierarchical with **confidence-aware override** (see 2.8 for suppression policy):
1. Check `repo+fileType` — only overrides broader scope if `effectiveSampleSize(pattern) >= MIN_FP_SAMPLES` (default 5), where effective sample size = `decayedAccepted + decayedDismissed` after lazy decay
2. Check `repo` — same confidence threshold
3. Check `global` — always trusted (largest sample)

**First match with sufficient confidence wins.** Narrower scopes without enough data are skipped, not trusted.

### 2.2 EMA Derivation (from Lazy-Decay Weights)

**File**: `scripts/lib/findings.mjs` — `FalsePositiveTracker.record()`

**Current**: Fixed `alpha = 0.3` from observation 1. With threshold at 5 observations, the most recent observation is ~30% of the signal.

**Change**: The `ema` field is **not** computed by a standalone EMA function. It is derived directly from the lazy-decay weighted mean defined in section 2.7: `ema = decayedAccepted / (decayedAccepted + decayedDismissed)`. This avoids maintaining two competing mathematical models. The exponential decay half-life (30 days) inherently provides recency weighting — recent observations carry more weight than stale ones — making a separate warm-up/alpha EMA unnecessary. See `applyLazyDecay()` and `recordWithDecay()` in section 2.7 for the canonical computation.

### 2.3 Bandit: Single Selection Entrypoint with Hierarchical Backoff

**File**: `scripts/bandit.mjs` — `PromptBandit`

**Current**: `contextBucket` field exists in schema but is never populated. All repos/sizes share the same arm.

**Key decision**: One `select(passName, context)` method — no separate `selectWithContext()` codepath. This method:
1. Resolves the best candidate bucket via hierarchical backoff (exact -> size -> global)
2. Lazily materializes arms for all known variants at that level via `ensureContextArms()`
3. Applies cold-start exploration (force sub-threshold arms) then Thompson Sampling

**Context contract**:

```javascript
/**
 * Canonical context for bandit arm selection.
 * Each dimension has a small set of discrete values to avoid data fragmentation.
 */
function buildContext(repoProfile) {
  return {
    sizeTier: contextSizeTier(repoProfile.totalChars),
    dominantLanguage: normalizeLanguage(repoProfile.dominantLanguage)
  };
}

function contextSizeTier(charCount) {
  if (charCount < 20_000) return 'small';
  if (charCount < 80_000) return 'medium';
  if (charCount < 300_000) return 'large';
  return 'xlarge';
}

function contextBucketKey(context) {
  return `${context.sizeTier}:${context.dominantLanguage}`;
}
```

**Lazy arm materialization**: When selecting at a context level, ensure all known variants have arms at that level. This avoids needing multi-level registration at `addArm()` time:

```javascript
/**
 * Ensure all known variants have arms at the given context level.
 * Called lazily at selection time, not at arm registration time.
 */
_ensureContextArms(passName, bucket) {
  const globalArms = this._armsForBucket(passName, GLOBAL_CONTEXT_BUCKET);
  for (const arm of globalArms) {
    const key = `${passName}:${arm.variantId}:${bucket}`;
    if (!this.arms[key]) {
      this.arms[key] = {
        alpha: 1, beta: 1, pulls: 0,
        passName, variantId: arm.variantId,
        contextBucket: bucket,
        promptRevisionId: arm.promptRevisionId,
        ...arm.metadata
      };
    }
  }
}
```

**Selection with hierarchical backoff and cold-start exploration**:

```javascript
const MIN_BUCKET_SAMPLES = 5;
const UCB_MIN_PULLS = 3;

/**
 * Single selection entrypoint.
 * @param {string} passName - Pass name (structure, wiring, backend, frontend, sustainability)
 * @param {object|null} context - From buildContext(repoProfile)
 * @returns {object} Selected arm
 */
select(passName, context = null) {
  const exactKey = context ? contextBucketKey(context) : null;
  const sizeKey = context?.sizeTier || null;
  
  // Hierarchical backoff: exact → size → global
  const levels = [
    exactKey ? { bucket: exactKey, label: 'exact' } : null,
    sizeKey ? { bucket: sizeKey, label: 'size' } : null,
    { bucket: GLOBAL_CONTEXT_BUCKET, label: 'global' }
  ].filter(Boolean);
  
  for (const { bucket } of levels) {
    this._ensureContextArms(passName, bucket);
    const candidates = this._armsForBucket(passName, bucket);
    if (candidates.length > 0 && this._totalPulls(candidates) >= MIN_BUCKET_SAMPLES) {
      return this._selectFromCandidates(candidates);
    }
  }
  
  // Fallback: global with no sample threshold
  return this._selectFromCandidates(this._armsForBucket(passName, GLOBAL_CONTEXT_BUCKET));
}

/**
 * Select from candidate arms using cold-start exploration + Thompson Sampling.
 * Cold-start: any arm with < UCB_MIN_PULLS gets forced via UCB1.
 * After warm-up: pure Thompson Sampling.
 */
_selectFromCandidates(candidates) {
  if (candidates.length <= 1) return candidates[0] ?? null;
  
  const totalPulls = candidates.reduce((sum, a) => sum + a.pulls, 0);
  
  // Cold-start: select ONLY from underexplored arms (pulls < UCB_MIN_PULLS).
  // Only after ALL arms meet the threshold, switch to full Thompson Sampling.
  const underexplored = candidates.filter(a => a.pulls < UCB_MIN_PULLS);
  if (underexplored.length > 0) {
    let best = null, bestUcb = -1;
    for (const arm of underexplored) {
      const mean = arm.alpha / (arm.alpha + arm.beta);
      const exploration = arm.pulls === 0
        ? Infinity
        : Math.sqrt(2 * Math.log(totalPulls + 1) / arm.pulls);
      const ucb = mean + exploration;
      if (ucb > bestUcb) { bestUcb = ucb; best = arm; }
    }
    return best;
  }
  
  // Thompson Sampling (uses injected RNG — see 2.13)
  let best = null, bestSample = -1;
  for (const arm of candidates) {
    const sample = this._rng.beta(arm.alpha, arm.beta);
    if (sample > bestSample) { bestSample = sample; best = arm; }
  }
  return best;
}
```

**Update at context level**: When recording a reward, update the arm at the bucket where it was selected:

```javascript
update(passName, variantId, reward, contextBucket = GLOBAL_CONTEXT_BUCKET) {
  const key = `${passName}:${variantId}:${contextBucket}`;
  const arm = this.arms[key];
  if (!arm) return false;
  
  const clampedReward = Math.max(0, Math.min(1, reward));
  arm.alpha += clampedReward;
  arm.beta += (1 - clampedReward);
  arm.pulls++;
  this._store.save(this.arms);
  return true;
}
```

**Backward compat**: Existing unbucketed arms (no `contextBucket` field) are normalized to `contextBucket: GLOBAL_CONTEXT_BUCKET` on load.

### 2.4 Immutable Prompt Revisions

**File**: `scripts/lib/prompt-registry.mjs` (NEW)

**Key decision**: Prompt identity uses content-hash revision IDs. `default` is an alias pointing to a revision. Promotion repoints the alias, never mutates learning identity. Historical outcomes always reference the exact revision used.

```javascript
/**
 * Compute revision ID from prompt content.
 * Immutable: the same text always produces the same ID.
 */
function revisionId(promptText) {
  const fullHash = createHash('sha256').update(promptText).digest('hex');
  const shortHash = fullHash.slice(0, 12);  // 12 hex chars for collision resistance
  return `rev-${shortHash}`;
  // Full checksum stored in revision file for verification (see saveRevision)
}
```

**Revision storage**: Each revision is stored once in `.audit/prompt-revisions/<pass>/<revisionId>.json` (includes prompt text + full SHA-256 checksum for verification). The `default` alias is a JSON file `.audit/prompt-revisions/<pass>/default.json` containing `{ "revisionId": "rev-abc123456789" }`.

**Revision lifecycle**: Each revision has a lifecycle state: `draft → active → promoted → retired → abandoned`. State transitions require a reference check — a revision cannot be retired or abandoned if active bandit arms or in-flight experiments reference it. Rollback marks the experiment/arm inactive; it never deletes revision content.

**Promotion**: Repoints the `default` alias to a new revision ID. The promoted revision moves to `promoted` state; the previously promoted revision moves to `retired`. The old revision file remains (immutable). All bandit arms and outcome records reference the `revisionId`, not `default`, so historical data is never ambiguous.

```javascript
/**
 * Promote a revision to be the default for a pass.
 * Does NOT mutate the revision — just repoints the alias.
 */
export function promoteRevision(passName, revisionId) {
  const aliasPath = join(REVISIONS_DIR, passName, 'default.json');
  atomicWriteFileSync(aliasPath, JSON.stringify({ revisionId }));
}
```

**Bootstrap migration**: Prompt constants are extracted from `openai-audit.mjs` to `scripts/lib/prompt-seeds.mjs` as the canonical seed artifact. On first use, the prompt-registry reads from `prompt-seeds.mjs` (not from `openai-audit.mjs`) and registers each as the initial `default` revision. `saveRevision()` is idempotent — content-addressed: same content produces the same revision ID, so re-running bootstrap is a no-op. Rollback uses `abandonRevision()` which transitions the revision to `abandoned` state (never physical deletion). Reference check prevents abandoning revisions with active bandit arms or experiments.

```javascript
/**
 * Bootstrap: register existing prompt constants as initial default revisions.
 * Idempotent — same content = same revision ID = no-op.
 */
export function bootstrapFromConstants(passPrompts) {
  for (const [passName, promptText] of Object.entries(passPrompts)) {
    const revId = revisionId(promptText);
    saveRevision(passName, revId, promptText, {
      source: 'bootstrap',
      createdAt: Date.now()
    });
    // Only set default if no default exists yet
    const current = getActiveRevisionId(passName);
    if (!current) {
      promoteRevision(passName, revId);
    }
  }
}

/**
 * Save a prompt revision. Idempotent: if revision file already exists
 * with matching content, this is a no-op.
 */
export function saveRevision(passName, revId, promptText, metadata = {}) {
  const revPath = join(REVISIONS_DIR, passName, `${revId}.json`);
  if (existsSync(revPath)) return;  // Content-addressed: same ID = same content
  mkdirSync(dirname(revPath), { recursive: true });
  atomicWriteFileSync(revPath, JSON.stringify({
    revisionId: revId,
    promptText,
    checksum: createHash('sha256').update(promptText).digest('hex'),
    lifecycleState: 'draft',  // draft → active → promoted → retired → abandoned
    ...metadata
  }));
}

/**
 * Abandon a revision. NEVER physically deletes — transitions to 'abandoned' state.
 * Reference check: refuses to abandon if active bandit arms or experiments reference it.
 */
export function abandonRevision(passName, revId, bandit) {
  const revPath = join(REVISIONS_DIR, passName, `${revId}.json`);
  if (!existsSync(revPath)) return { ok: false, reason: 'not_found' };
  const rev = JSON.parse(readFileSync(revPath, 'utf8'));
  
  // Reference check — block if active arms or experiments point here
  const activeRefs = bandit.armsReferencingRevision(passName, revId);
  if (activeRefs.length > 0) {
    process.stderr.write(`  [prompt-registry] Cannot abandon ${revId}: ${activeRefs.length} active arm(s) reference it\n`);
    return { ok: false, reason: 'active_references', refs: activeRefs };
  }
  
  rev.lifecycleState = 'abandoned';
  rev.abandonedAt = Date.now();
  atomicWriteFileSync(revPath, JSON.stringify(rev));
  return { ok: true };
}
```

**Cloud sync**: The `prompt_revisions` Supabase table stores prompt text + checksum for promoted revisions. Auto-generated variants are local-only and excluded from cloud sync until promoted. On promotion, prompt text syncs to `prompt_revisions` table.

### 2.5 Pass-Scoped Evaluation Records

**File**: `scripts/bandit.mjs`, `scripts/lib/findings.mjs`

**Key decision**: Each pass (structure, wiring, backend, frontend, sustainability) selects its own prompt variant. Evaluation records are keyed by `runId + passName + promptRevisionId`. Reward is aggregated per-pass, not per-run.

```javascript
/**
 * Pass Evaluation Record — traces arm selection -> findings -> edits -> reward.
 * Keyed by runId + passName + promptRevisionId (not run-scoped).
 * Zod-validated at each boundary. Persisted in ledger and synced to Supabase.
 */
const PassEvaluationRecordSchema = z.object({
  runId: z.string(),
  passName: z.string(),             // structure | wiring | backend | frontend | sustainability
  promptRevisionId: z.string(),     // rev-<sha12> — immutable content hash
  contextBucket: z.string(),        // Context bucket at selection time
  
  // Many-to-many finding <-> edit links
  findingEditLinks: z.array(z.object({
    semanticHash: z.string(),       // from semanticId()
    findingId: z.string(),          // H1, M2, etc.
    severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
    
    // Edits that addressed this finding
    edits: z.array(z.object({
      file: z.string(),             // Normalized file path
      type: z.enum(['edit', 'create', 'delete']),
      linesChanged: z.array(z.number()).optional()
    })),
    
    // Lifecycle state
    remediationState: z.enum(['pending', 'planned', 'fixed', 'verified', 'regressed']),
    verifiedBy: z.enum(['gemini', 'gpt', 'claude']).optional()
  })),
  
  // Computed after all links populated
  totalFindings: z.number(),
  findingsWithEdits: z.number(),
  computedReward: z.number().optional()
});
```

**Orchestrator populates links**: During Step 4, the orchestrator tracks which files it modifies per finding. After Step 5 verification, `remediationState` is updated. `ledToCodeChange` is derived from `edits.length > 0` per finding.

**RemediationTask lifecycle**: Each accepted finding creates a `RemediationTask` at adjudication time, providing a stable identity for tracking remediation through fix, verification, and reward. The task ID is referenced by fix generation, edit tracking, and verification steps.

```javascript
/**
 * RemediationTask — created at adjudication, tracks fix lifecycle.
 * Provides stable identity from adjudication -> fix -> verify -> reward.
 */
const RemediationTaskSchema = z.object({
  taskId: z.string(),            // Deterministic: `${runId}-${passName}-${semanticHash}`
  runId: z.string(),
  passName: z.string(),
  semanticHash: z.string(),      // From semanticId() — links to finding
  findingId: z.string(),         // H1, M2, etc.
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  
  // Lifecycle
  remediationState: z.enum(['pending', 'planned', 'fixed', 'verified', 'regressed']),
  createdAt: z.number(),
  updatedAt: z.number(),
  
  // Fix tracking — appended as edits occur
  edits: z.array(z.object({
    file: z.string(),
    type: z.enum(['edit', 'create', 'delete']),
    linesChanged: z.array(z.number()).optional(),
    timestamp: z.number()
  })),
  
  // Verification
  verifiedBy: z.enum(['gemini', 'gpt', 'claude']).optional(),
  verifiedAt: z.number().optional()
});

/**
 * Create a RemediationTask at adjudication time.
 * Fix generation references taskId to associate edits.
 */
export function createRemediationTask(runId, passName, finding) {
  return {
    taskId: `${runId}-${passName}-${finding.semanticHash}`,  // Deterministic, includes passName
    runId,
    passName,
    semanticHash: finding.semanticHash,
    findingId: finding.findingId,
    severity: finding.severity,
    remediationState: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    edits: []
  };
}

/**
 * Append an edit to a task (called during fix generation).
 */
export function trackEdit(task, edit) {
  task.edits.push({ ...edit, timestamp: Date.now() });
  task.remediationState = 'fixed';
  task.updatedAt = Date.now();
}

/**
 * Update task after verification step.
 * Reward reads from persisted task state.
 */
export function verifyTask(task, verifiedBy, passed) {
  task.remediationState = passed ? 'verified' : 'regressed';
  task.verifiedBy = verifiedBy;
  task.verifiedAt = Date.now();
  task.updatedAt = Date.now();
}
```

**Persistence**: `RemediationTask` records are persisted to `.audit/remediation-tasks.jsonl` via `AppendOnlyStore` (schema-validated with `RemediationTaskSchema`). CRUD APIs:

```javascript
const taskStore = new AppendOnlyStore('.audit/remediation-tasks.jsonl', {
  schema: RemediationTaskSchema
});

/** Create and persist a new task. */
export function persistTask(task) { taskStore.append(task); }

/** Load all tasks, optionally filtered by runId. */
export function loadTasks(runId = null) {
  const all = taskStore.loadAll();
  return runId ? all.filter(t => t.runId === runId) : all;
}

/** Update a task (append new version — append-only, latest wins on load). */
export function updateTask(task) {
  task.updatedAt = Date.now();
  taskStore.append(task);
}
```

The `findingEditLinks` in `PassEvaluationRecord` are derived from `RemediationTask` records at reward computation time, ensuring the reward formula reads from persisted task state rather than ephemeral in-memory tracking.

### 2.6 Canonical Reward Formula

**File**: `scripts/bandit.mjs` — `computeReward()`

**Current**: Reward is purely procedural — based on Claude's position and GPT's ruling.

**Change**: Three-component reward formula per finding. Per-pass reward is severity-weighted mean of per-finding rewards after verification. Stored on `PassEvaluationRecord`.

```javascript
/**
 * Canonical per-finding reward formula.
 * Components: procedural (40%) + substantive (30%) + deliberation quality (30%).
 * Per-pass reward: severity-weighted mean of per-finding rewards.
 */
export function computeReward(resolution, evaluationRecord) {
  const positionWeights = { accept: 1.0, partial_accept: 0.6, challenge: 0.0 };
  const rulingWeights = { sustain: 1.0, compromise: 0.5, overrule: 0.0 };
  const severityMult = { HIGH: 1.0, MEDIUM: 0.7, LOW: 0.4 };

  const sevMult = severityMult[resolution.final_severity] ?? 0;

  // 1. Procedural signal (40%)
  const procedural = (positionWeights[resolution.claude_position] * 0.4
                    + rulingWeights[resolution.gpt_ruling] * 0.6)
                    * sevMult;

  // 2. Substantive signal (30%) — verification-gated from finding-edit-links
  const link = evaluationRecord.findingEditLinks.find(
    l => l.semanticHash === resolution.semanticHash
  );
  // Reward gates: verified=1.0, fixed=0.7, planned=0.5, pending=0.0, regressed=0.0
  const remediationReward = {
    verified: 1.0, fixed: 0.7, planned: 0.5, pending: 0.0, regressed: 0.0
  };
  const changeBonus = remediationReward[link?.remediationState] ?? 0.0;
  // Severity weighting applied ONCE here — not again in computePassReward()
  const substantive = changeBonus * sevMult;

  // 3. Deliberation quality signal (30%)
  const deliberation = deliberationSignal(resolution);

  return procedural * 0.4 + substantive * 0.3 + deliberation * 0.3;
}

/**
 * Extract deliberation quality signal from the Claude-GPT exchange.
 * Higher = finding prompted substantive technical discussion.
 * Lower = trivially dismissed or rubber-stamped.
 */
export function deliberationSignal(resolution) {
  let signal = 0.5;

  if (resolution.claude_position === 'challenge' && resolution.gpt_ruling === 'sustain') {
    signal += 0.3;
  }
  if (resolution.gpt_ruling === 'compromise') {
    signal += 0.15;
  }
  if (resolution.claude_position === 'accept' && resolution.gpt_ruling === 'sustain') {
    signal -= 0.1;
  }
  if (resolution.ruling_rationale && resolution.ruling_rationale.length > 200) {
    signal += 0.1;
  }

  return Math.max(0, Math.min(1, signal));
}

/**
 * Compute per-pass reward: simple mean of per-finding rewards.
 * Severity weighting is already applied ONCE inside computeReward() —
 * do NOT apply it again here to avoid double-weighting.
 */
export function computePassReward(evaluationRecord) {
  const rewards = evaluationRecord.findingEditLinks
    .map(l => l.reward ?? 0);
  
  if (rewards.length === 0) return 0;
  return rewards.reduce((sum, r) => sum + r, 0) / rewards.length;
}
```

### 2.7 Outcome Decay, Timestamp Normalization & Pruning

**File**: `scripts/lib/findings.mjs`

**Current**: All outcomes weighted equally regardless of age.

**Change**: Time-weighted effectiveness computation with exponential decay.

**Side-effect-free reads**: `loadOutcomes()` is a pure read — no file writes, no backfill. Timestamp normalization is applied in-memory only. A separate `compactOutcomes()` function handles backfill + pruning under `MutexFileStore` lock, called explicitly by the CLI or at audit-end.

```javascript
/**
 * Load outcomes — pure read, no side effects.
 * Legacy entries without timestamps get _importedAt assigned IN MEMORY only.
 * Call compactOutcomes() separately for persistent backfill + pruning.
 */
export function loadOutcomes(logPath) {
  const outcomes = readJsonlFile(logPath);
  const now = Date.now();
  
  for (const o of outcomes) {
    if (!o.timestamp && !o._importedAt) {
      o._importedAt = now;  // In-memory only — not persisted
    }
  }
  
  return outcomes;
}

/**
 * Compact outcomes file: backfill _importedAt + prune stale entries.
 * Runs under MutexFileStore lock to prevent concurrent corruption.
 * AppendOnlyStore uses the same lock file as compaction.
 */
export async function compactOutcomes(logPath, options = {}) {
  const { maxAgeMs = 180 * 24 * 60 * 60 * 1000 } = options;
  const store = new MutexFileStore(logPath + '.compact', {
    lockPath: logPath + '.lock'  // Shared lock with AppendOnlyStore
  });
  
  await store.mutate(() => {
    const outcomes = readJsonlFile(logPath);
    const now = Date.now();
    let backfilled = 0;
    
    // Backfill _importedAt on legacy entries
    for (const o of outcomes) {
      if (!o.timestamp && !o._importedAt) {
        o._importedAt = now;
        backfilled++;
      }
    }
    
    // Prune stale entries (if enabled)
    let fresh = outcomes;
    if (process.env.OUTCOME_PRUNE_ENABLED !== 'false') {
      fresh = outcomes.filter(o => {
        const ts = o.timestamp || o._importedAt || now;
        return (now - ts) < maxAgeMs;
      });
    }
    
    const pruned = outcomes.length - fresh.length;
    if (backfilled > 0 || pruned > 0) {
      atomicWriteFileSync(logPath, fresh.map(o => JSON.stringify(o)).join('\n') + '\n');
      if (backfilled > 0) process.stderr.write(`  [outcomes] Backfilled ${backfilled} legacy entries with _importedAt\n`);
      if (pruned > 0) process.stderr.write(`  [outcomes] Pruned ${pruned} stale entries\n`);
    }
    
    return fresh;
  });
}

/**
 * Compute pass effectiveness with exponential time decay.
 * Effective sample size derived from lazy-decay weights on FP patterns (see 2.7).
 */
export function computePassEffectiveness(outcomes, passName = null, options = {}) {
  const {
    halfLifeMs = 30 * 24 * 60 * 60 * 1000,   // 30-day half-life
    maxAgeMs = 180 * 24 * 60 * 60 * 1000      // 180-day hard cutoff
  } = options;
  
  const now = Date.now();
  const lambda = Math.LN2 / halfLifeMs;
  
  let filtered = passName ? outcomes.filter(o => o.pass === passName) : outcomes;
  
  // Use normalized timestamps
  filtered = filtered.filter(o => {
    const ts = o.timestamp || o._importedAt || now;
    return (now - ts) < maxAgeMs;
  });
  
  if (filtered.length === 0) return { acceptanceRate: 0, signalScore: 0, total: 0, accepted: 0, dismissed: 0, effectiveWeight: 0 };

  let weightedAccepted = 0, weightedTotal = 0;
  let accepted = 0, dismissed = 0;

  for (const o of filtered) {
    const ts = o.timestamp || o._importedAt || now;
    const age = now - ts;
    const weight = Math.exp(-lambda * age);
    weightedTotal += weight;
    if (o.accepted) { weightedAccepted += weight; accepted++; }
    else dismissed++;
  }

  return {
    acceptanceRate: weightedTotal > 0 ? weightedAccepted / weightedTotal : 0,
    signalScore: weightedTotal > 0 ? weightedAccepted / weightedTotal : 0,
    total: filtered.length,
    accepted,
    dismissed,
    effectiveWeight: weightedTotal
  };
}

// NOTE: pruneOutcomes() has been removed — use compactOutcomes() instead,
// which combines backfill + pruning under MutexFileStore lock (see above).
//
// PRECONDITION: compactOutcomes() MUST be called before computePassEWR(),
// computePassEffectiveness(), or any refinement/evolution flow that reads
// decay-sensitive data. This ensures _importedAt is backfilled and stale
// entries are pruned before decay weights are computed. Alternatively,
// consumers MAY use file mtime as a stable fallback timestamp when
// _importedAt is missing, avoiding a hard dependency on compaction ordering.
```

**Lazy-decay model**: Instead of a snapshot `effectiveSampleSize`, each pattern stores `decayedAccepted`, `decayedDismissed`, and `lastDecayTs`. `applyLazyDecay()` is a pure function that returns a decayed view without mutating the source — decay is only persisted on write/compaction, not on read. EMA and confidence are derived from the decayed weights. Narrower scopes override broader only when effective sample size (`decayedAccepted + decayedDismissed`) >= `MIN_FP_SAMPLES`:

```javascript
/**
 * Apply lazy decay to a pattern's weights — PURE FUNCTION.
 * Returns a new decayed view without mutating the input.
 * Persist only on explicit write/compaction, not on read.
 */
function applyLazyDecay(pattern, halfLifeMs = 30 * 24 * 60 * 60 * 1000) {
  const now = Date.now();
  const lambda = Math.LN2 / halfLifeMs;
  const elapsed = now - (pattern.lastDecayTs || now);
  
  if (elapsed <= 0) return { ...pattern };
  
  const decay = Math.exp(-lambda * elapsed);
  const decayedAccepted = pattern.decayedAccepted * decay;
  const decayedDismissed = pattern.decayedDismissed * decay;
  const total = decayedAccepted + decayedDismissed;
  
  return {
    ...pattern,
    decayedAccepted,
    decayedDismissed,
    lastDecayTs: now,
    ema: total > 0 ? decayedAccepted / total : 0.5
  };
}

/**
 * Effective sample size: sum of decayed weights (after lazy decay applied).
 * Used for confidence-aware scope resolution.
 */
function effectiveSampleSize(pattern) {
  return pattern.decayedAccepted + pattern.decayedDismissed;
}

/**
 * Record an observation with lazy decay.
 * 1. Compute decayed view (pure — no mutation)
 * 2. Add new observation (weight 1.0)
 * 3. Persist mutated result (decay + observation applied together on write)
 */
function recordWithDecay(pattern, accepted, halfLifeMs = 30 * 24 * 60 * 60 * 1000) {
  const decayed = applyLazyDecay(pattern, halfLifeMs);
  
  // Apply observation to decayed view, then persist
  if (accepted) {
    decayed.decayedAccepted += 1.0;
    decayed.accepted = (pattern.accepted || 0) + 1;
  } else {
    decayed.decayedDismissed += 1.0;
    decayed.dismissed = (pattern.dismissed || 0) + 1;
  }
  
  // Re-derive EMA from updated weights
  const total = decayed.decayedAccepted + decayed.decayedDismissed;
  decayed.ema = total > 0 ? decayed.decayedAccepted / total : 0.5;
  decayed.lastUpdated = Date.now();
  
  // Copy mutated fields back to pattern for persistence
  Object.assign(pattern, decayed);
}
```

### 2.8 Unified Suppression Policy Service

**File**: New — `scripts/lib/suppression-policy.mjs`

**Purpose**: Single source of truth for all R2+ suppression decisions. Feeds all three layers (system-prompt exclusions, R2+ prompt augmentation, post-output suppression) from one resolved policy.

```javascript
/**
 * Resolve suppression policy from all sources.
 * Called once at audit start, result feeds all three R2+ layers.
 */
export function resolveSuppressionPolicy(ledger, fpTracker, cloudPatterns, repoFingerprint) {
  const policy = {
    ledgerExclusions: buildLedgerExclusions(ledger),
    fpSuppressions: resolveFpPatterns(fpTracker, cloudPatterns, repoFingerprint),
    systemPromptExclusions: [],
    suppressionTopics: new Set()
  };

  policy.systemPromptExclusions = deduplicateExclusions(
    policy.ledgerExclusions, policy.fpSuppressions
  );
  policy.suppressionTopics = new Set([
    ...policy.ledgerExclusions.map(e => e.topicId),
    ...policy.fpSuppressions.map(p => buildPatternKey(p))
  ]);

  return policy;
}

/** Format policy for system prompt injection (Layer 1). */
export function formatPolicyForPrompt(policy) { /* ... */ }

/**
 * Check a finding against the policy (Layer 3 post-output).
 * Confidence-aware: narrower scopes only override broader ones when they
 * have enough evidence (effectiveSampleSize >= MIN_FP_SAMPLES).
 * Returns { suppress: boolean, scope: string, confidence: number, reason: string }
 */
export function shouldSuppressFinding(finding, policy) {
  for (const scope of ['repo+fileType', 'repo', 'global']) {
    const match = policy.fpSuppressions.find(p =>
      p.scope === scope && matchesFinding(p, finding)
    );
    if (!match) continue;

    const ess = effectiveSampleSize(match);  // decayedAccepted + decayedDismissed
    if (ess < MIN_FP_SAMPLES) continue;

    if (match.ema < 0.15) {
      return {
        suppress: true,
        scope,
        confidence: Math.min(1, ess / 10),
        reason: `FP pattern (${scope}, n=${ess.toFixed(1)}, ema=${match.ema.toFixed(2)})`
      };
    }

    // Scope has enough data but doesn't suppress — stop checking broader scopes
    return { suppress: false, scope, confidence: 0, reason: 'Pattern exists but above threshold' };
  }

  // No FP pattern match — check ledger exclusions
  const ledgerMatch = policy.ledgerExclusions.find(e => matchesFinding(e, finding));
  if (ledgerMatch) {
    return { suppress: true, scope: 'ledger', confidence: 1, reason: `Ledger exclusion: ${ledgerMatch.topicId}` };
  }

  return { suppress: false, scope: 'none', confidence: 0, reason: 'No matching pattern' };
}
```

**Integration**: `openai-audit.mjs` calls `resolveSuppressionPolicy()` once at R2+ start. The result is passed to `buildRulingsBlock()` (Layer 1), R2+ prompt construction (Layer 2), and `suppressReRaises()` (Layer 3). All three layers use the same resolved policy.

### 2.9 Canonical Evaluation Metric (EWR)

**File**: `scripts/lib/findings.mjs`

**Purpose**: One metric for pass quality everywhere — bandit reward, worst-pass detection, convergence, promotion decisions. Eliminates the objective function mismatch where the bandit optimizes blended reward but evolution targets raw acceptance rate.

```javascript
/**
 * Canonical pass quality metric: Expected Weighted Reward.
 * Used by: bandit updates, evolveWorstPass() target selection,
 *          convergence reporting, variant promotion decisions.
 */
export function computePassEWR(outcomes, passName, options = {}) {
  const { halfLifeMs = 30 * 24 * 60 * 60 * 1000 } = options;
  const now = Date.now();
  const lambda = Math.LN2 / halfLifeMs;
  
  const passOutcomes = outcomes.filter(o => o.pass === passName && o.reward != null);
  if (passOutcomes.length === 0) return { ewr: 0, confidence: 0, n: 0 };
  
  let weightedRewardSum = 0, weightSum = 0;
  for (const o of passOutcomes) {
    const ts = o.timestamp || o._importedAt || now;
    const weight = Math.exp(-lambda * (now - ts));
    weightedRewardSum += o.reward * weight;
    weightSum += weight;
  }
  
  const ewr = weightSum > 0 ? weightedRewardSum / weightSum : 0;
  const confidence = Math.min(1, weightSum / 10);
  
  return { ewr, confidence, n: passOutcomes.length };
}
```

### 2.10 Example-Driven Prompt Refinement

**File**: `scripts/refine-prompts.mjs` — `suggestRefinements()`

**Current**: Sends only aggregate stats. The LLM has no examples to reason about.

**Change**: Include dismissed and accepted findings with ruling rationale. Use sanitized outcomes (see 2.11). Apply replay buffer sampling (mixed recent + random) to prevent catastrophic forgetting.

```javascript
async function suggestRefinements(passName, outcomesPath) {
  const outcomes = loadOutcomes(outcomesPath);
  const passOutcomes = outcomes.filter(o => o.pass === passName);
  
  // Sanitize before any external LLM call
  const sanitized = sanitizeOutcomes(passOutcomes);
  
  // Empty-state handling: when sanitized examples < minimum threshold, fall back to stats-only
  if (sanitized.length < MIN_EXAMPLES_THRESHOLD) {
    process.stderr.write(`[refine] Only ${sanitized.length} sanitized outcomes (need ${MIN_EXAMPLES_THRESHOLD}) — stats-only refinement\n`);
    if (sanitized.length === 0) {
      return { status: 'INSUFFICIENT_DATA', message: `Only ${sanitized.length} sanitized outcomes` };
    }
  }
  
  const dismissed = sanitized.filter(o => !o.accepted && o.detail);
  const accepted = sanitized.filter(o => o.accepted && o.detail);
  
  // Mixed sampling: 3 recent + 2 random (replay buffer)
  const dismissedExamples = [
    ...dismissed.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 3),
    ...reservoirSample(dismissed, 2, this._rng)
  ].map(formatExample);
  
  const acceptedExamples = reservoirSample(accepted, 3, this._rng).map(formatExample);
  
  const exampleBlock = [
    'DISMISSED FINDINGS (false positives — the prompt should avoid generating these):',
    ...dismissedExamples,
    '',
    'ACCEPTED FINDINGS (true positives — the prompt should keep generating these):',
    ...acceptedExamples
  ].join('\n');

  // LLM call via learning-service adapter (see 2.14)
  const userPrompt = `Outcome data:\n\n${statsBlock}\n\n${exampleBlock}\n\nSuggest prompt refinements...`;
  // ... call via adapter ...
}
```

**Replay buffer sampling**: Uniform random via reservoir sampling (seedable RNG):

```javascript
/**
 * Reservoir sampling (uniform random from full history).
 * Uses injected RNG for deterministic testing.
 */
function reservoirSample(outcomes, k, rng = Math) {
  const reservoir = [];
  for (let i = 0; i < outcomes.length; i++) {
    if (i < k) {
      reservoir.push(outcomes[i]);
    } else {
      const j = Math.floor(rng.random() * (i + 1));
      if (j < k) reservoir[j] = outcomes[i];
    }
  }
  return reservoir;
}
```

### 2.11 Outcome Sanitization Pipeline

**File**: New — `scripts/lib/sanitizer.mjs`

**Purpose**: Sanitize outcome data before sending to external LLMs for refinement or prompt evolution. Prevents leaking secrets, internal paths, or sensitive code excerpts.

**Key decision**: Uses `primaryFile`/`affectedFiles` (NOT `section`). Outcomes without file metadata excluded. Secret redaction with working regex.

```javascript
/**
 * Sanitize outcome records before external LLM calls.
 * Applied in refine-prompts.mjs and evolve-prompts.mjs before any sampling.
 */
export function sanitizeOutcomes(outcomes, options = {}) {
  return outcomes
    .filter(o => {
      // Require normalized file metadata — NOT section (unreliable logical label)
      const file = o.primaryFile || o.affectedFiles?.[0];
      if (!file) return false;
      return !isSensitiveFile(file);
    })
    .map(o => ({
      category: o.category,
      severity: o.severity,
      primaryFile: o.primaryFile ? sanitizePath(o.primaryFile) : 'unknown',
      detail: redactSecrets(o.detail?.slice(0, 300) || ''),
      ruling: o.ruling,
      rulingRationale: o.rulingRationale?.slice(0, 200) || '',
      accepted: o.accepted,
      pass: o.pass,
      // Recency bucket so downstream sampling works after sanitization
      _recencyBucket: recencyBucket(o.timestamp || o._importedAt)
    }));
}

/**
 * Classify outcome recency for sampling after sanitization.
 * Enables recency-weighted sampling without exposing raw timestamps.
 */
function recencyBucket(ts) {
  if (!ts) return 'old';
  const ageMs = Date.now() - ts;
  if (ageMs < 7 * 24 * 60 * 60 * 1000) return 'recent';    // < 7 days
  if (ageMs < 30 * 24 * 60 * 60 * 1000) return 'mid';       // < 30 days
  return 'old';
}

/**
 * Migration adapter for outcomes missing primaryFile.
 * Reconstructs from evaluation records where possible, tags as 'unresolvable' if not.
 */
export function backfillPrimaryFile(outcomes, evaluationRecords) {
  for (const o of outcomes) {
    if (o.primaryFile) continue;
    const evalMatch = evaluationRecords.find(
      e => e.runId === o.runId && e.findingEditLinks?.some(l => l.semanticHash === o.semanticHash)
    );
    const link = evalMatch?.findingEditLinks?.find(l => l.semanticHash === o.semanticHash);
    o.primaryFile = link?.edits?.[0]?.file || 'unresolvable';
  }
  return outcomes;
}

/** Sanitize file path: two-level (directory/basename), redact absolute paths. */
function sanitizePath(filePath) {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  return parts[parts.length - 1] || 'unknown';
}

/** Detect common secret patterns in text. */
function redactSecrets(text) {
  return text
    .replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED_TOKEN]')
    .replace(/(key|token|secret|password|api_key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[REDACTED_KEY]');
}
```

**Validation**: Sanitized output validated with `SanitizedOutcomeSchema` (see Appendix A.3) before sending — only whitelisted fields pass through.

### 2.12 Shared File-Store Abstraction (MutexFileStore)

**File**: New — `scripts/lib/file-store.mjs`

**Key decision**: One `MutexFileStore` class for all read-modify-write state (bandit, FP tracker, experiments). Uses lock file + atomic write. Append-only stores (outcomes, evaluations) use atomic append. All modules go through this instead of independent `_save()` methods.

```javascript
/**
 * Mutex-guarded, atomic file store for JSON state.
 * All read-modify-write state files go through this class.
 */
export class MutexFileStore {
  /**
   * @param {string} filePath - Absolute path to state file
   * @param {object} options
   * @param {number} options.staleLockTimeoutMs - Lock file considered stale after this (default 60000)
   * @param {import('zod').ZodSchema} options.schema - Zod schema; uses schema.safeParse() consistently
   * @param {string} options.lockPath - Explicit lock file path (default: filePath + '.lock')
   */
  constructor(filePath, options = {}) {
    this._filePath = filePath;
    this._lockPath = options.lockPath ?? (filePath + '.lock');
    this._staleLockTimeoutMs = options.staleLockTimeoutMs ?? 60000;
    this._schema = options.schema ?? null;
    // Use schema.safeParse() consistently for all validation
    this._validate = this._schema
      ? (data) => { const r = this._schema.safeParse(data); if (!r.success) throw r.error; return r; }
      : null;
  }
  
  /**
   * Acquire lock, read current state, apply mutator, write atomically, release lock.
   * @param {function} mutator - (currentState) => newState
   * @returns {object} The new state after mutation
   */
  async mutate(mutator) {
    await this._acquireLock();
    try {
      const current = this._readSync();
      const next = mutator(current);
      if (this._validate) this._validate(next);
      atomicWriteFileSync(this._filePath, JSON.stringify(next, null, 2));
      return next;
    } finally {
      this._releaseLock();
    }
  }
  
  /** Synchronous read with optional Zod validation (no lock needed for read-only access).
   *  Corrupted records quarantined to .audit/quarantine/. */
  load() {
    const data = this._readSync();
    if (this._validate) {
      const result = this._validate(data);
      if (!result.success) {
        _quarantineRecord(data, result.error, this._filePath);
        return this._defaultState ?? {};
      }
    }
    return data;
  }
  
  /** Synchronous save with lock + atomic write. */
  save(state) {
    this._acquireLockSync();
    try {
      if (this._validate) this._validate(state);
      atomicWriteFileSync(this._filePath, JSON.stringify(state, null, 2));
    } finally {
      this._releaseLock();
    }
  }
  
  // ... lock acquisition with stale-lock detection ...
}

/**
 * Append-only store for JSONL files (outcomes, evaluations).
 * Uses the same lock file as compaction to prevent append-during-compact races.
 * @param {object} options
 * @param {import('zod').ZodSchema} options.schema - Optional Zod schema for validation on append
 */
export class AppendOnlyStore {
  constructor(filePath, options = {}) {
    this._filePath = filePath;
    this._lockPath = filePath + '.lock';  // Same lock as compactOutcomes()
    this._schema = options.schema ?? null;
  }
  
  append(record) {
    if (this._schema) {
      const result = this._schema.safeParse(record);
      if (!result.success) {
        _quarantineRecord(record, result.error, this._filePath);
        return;
      }
    }
    this._acquireLockSync();
    try {
      // fs.appendFileSync is atomic at the OS level for small writes (single JSONL lines)
      fs.appendFileSync(this._filePath, JSON.stringify(record) + '\n');
    } finally {
      this._releaseLock();
    }
  }
  
  loadAll() {
    return readJsonlFile(this._filePath);
  }
}
```

/**
 * Quarantine corrupted records to .audit/quarantine/ for manual inspection.
 * Records are never silently discarded.
 */
function _quarantineRecord(data, error, sourcePath) {
  const quarantineDir = join(dirname(sourcePath), '..', 'quarantine');
  mkdirSync(quarantineDir, { recursive: true });
  const ts = Date.now();
  const filename = `${basename(sourcePath)}.${ts}.json`;
  writeFileSync(join(quarantineDir, filename), JSON.stringify({
    source: sourcePath,
    quarantinedAt: new Date(ts).toISOString(),
    error: error.message || String(error),
    data
  }, null, 2));
  process.stderr.write(`  [store] Quarantined corrupted data from ${sourcePath} to quarantine/${filename}\n`);
}
```

**Usage**: All modules that previously had independent `_save()` methods now receive a `MutexFileStore` or `AppendOnlyStore` instance:

| State file | Store type | Module |
|------------|-----------|--------|
| `.audit/bandit-state.json` | `MutexFileStore` | `bandit.mjs` |
| `.audit/fp-tracker.json` | `MutexFileStore` | `findings.mjs` |
| `.audit/experiments.jsonl` | `AppendOnlyStore` | `evolve-prompts.mjs` |
| `.audit/outcomes.jsonl` | `AppendOnlyStore` | `findings.mjs` |
| `.audit/evaluations.jsonl` | `AppendOnlyStore` | `bandit.mjs` |
| `.audit/remediation-tasks.jsonl` | `AppendOnlyStore` | `findings.mjs` |
| `.audit/experiment-manifests/<id>.json` | `MutexFileStore` | `evolve-prompts.mjs` |
| `.audit/prompt-revisions/<pass>/default.json` | `MutexFileStore` | `prompt-registry.mjs` |

### 2.13 Seedable RNG

**Key decision**: Inject RNG interface into all stochastic components (Thompson Sampling, reservoir sampling, UCB). Deterministic fixtures in unit tests. Small statistical smoke test kept separately.

```javascript
/**
 * RNG interface. Production uses Math.random(); tests inject a seeded PRNG.
 */
export function createRNG(seed = null) {
  if (seed === null) {
    return {
      random: () => Math.random(),
      beta: (alpha, beta) => randomBeta(alpha, beta)  // existing implementation
    };
  }
  // Seedable xorshift128 for deterministic tests
  let s = [seed, seed ^ 0x12345678, seed ^ 0x9ABCDEF0, seed ^ 0xDEADBEEF];
  function next() {
    let t = s[3];
    t ^= t << 11; t ^= t >>> 8;
    s[3] = s[2]; s[2] = s[1]; s[1] = s[0];
    t ^= s[0]; t ^= s[0] >>> 19;
    s[0] = t;
    return (t >>> 0) / 0x100000000;
  }
  return {
    random: next,
    beta: (alpha, beta) => randomBetaSeeded(alpha, beta, next)
  };
}
```

**Testing**: Unit tests inject `createRNG(42)` for deterministic assertions. A small statistical smoke test (separate test file) runs 1000 iterations with `createRNG()` (unseeded) to verify distribution properties.

### 2.14 Learning-Service Adapter

**File**: New — `scripts/lib/llm-wrappers.mjs`

**Key decision**: LLM calls in refinement/evolution use a shared wrapper module extracted from `openai-audit.mjs` and `gemini-review.mjs`. Standard `{result, usage, latencyMs}` envelope.

```javascript
/**
 * Shared LLM wrapper module — extracted from openai-audit.mjs and gemini-review.mjs.
 * All new LLM calls in refinement/evolution must go through this adapter.
 * Direct anthropic.messages.create() or ai.models.generateContent() calls
 * are prohibited in refinement/evolution modules.
 *
 * Adapter accepts injected provider clients via constructor/factory — no
 * self-created clients. Callers pass pre-configured OpenAI/Gemini/Anthropic
 * instances. This enables testing with mock clients and avoids hidden
 * dependency on env vars inside the adapter.
 */

/**
 * Create a learning adapter with injected provider clients.
 * @param {object} providers - { openai?, gemini?, anthropic? } — pre-configured client instances
 * @returns {LearningAdapter}
 */
export function createLearningAdapter(providers = {}) {
  const { openai, gemini, anthropic } = providers;
  
  return {
    /**
     * Generate a prompt variant via LLM. Uses injected clients.
     * Try Gemini Flash first (cheaper), fall back to Claude Haiku.
     * @returns {Promise<{result: GeneratedVariant, usage, latencyMs}>}
     */
    async generateVariantViaLLM(systemPrompt, userPrompt, schema) {
      // All calls go through wrappers with Zod validation
      // Returns standard {result, usage, latencyMs} envelope
      if (gemini) return callGemini(gemini, systemPrompt, userPrompt, schema);
      if (anthropic) return callClaude(anthropic, systemPrompt, userPrompt, schema);
      if (openai) return safeCallGPT(openai, systemPrompt, userPrompt, schema);
      throw new Error('No LLM provider injected into learning adapter');
    }
  };
}
```

**Extraction scope**: `safeCallGPT()` and `callGemini()` are extracted from their current homes (`openai-audit.mjs`, `gemini-review.mjs`) into `lib/llm-wrappers.mjs` to avoid circular dependencies. Both original modules then import from the shared wrapper.

### 2.15 Automated TextGrad Prompt Evolution

**File**: New — `scripts/evolve-prompts.mjs`

**Purpose**: Close the manual prompt refinement loop. LLM generates prompt variants, bandit A/B tests them, human reviews winners.

**Flow**:
```
outcomes.jsonl -> analyze worst-performing pass (by EWR) -> LLM generates variant prompt
-> auto-register as bandit arm -> bandit A/B tests over next N runs
-> after convergence, report winner to user for review
```

**Pass catalog from config**: Pass names sourced from `lib/config.mjs`, not hardcoded:

```javascript
import { PASS_NAMES } from './lib/config.mjs';

// NOT: const passNames = ['structure', 'wiring', 'backend', 'frontend', 'sustainability'];
// Instead: use PASS_NAMES from config
```

**Empty-state handling**: When sanitized examples < minimum threshold (3), service functions return typed result objects — no `process.exit()` in service functions. CLI wrapper translates to exit codes:

```javascript
const MIN_EXAMPLES_THRESHOLD = 3;

// Service function returns typed result:
// { status: 'INSUFFICIENT_DATA' | 'NO_ACTION' | 'CREATED', message?, experiment? }

// CLI wrapper translates:
// CREATED -> exit 0
// NO_ACTION / INSUFFICIENT_DATA -> exit 2
// error -> exit 1
```

**Implementation**:

```javascript
export async function evolveWorstPass(outcomesPath, bandit, options = {}) {
  const outcomes = loadOutcomes(outcomesPath);
  
  // Find worst pass using canonical EWR metric
  const passStats = PASS_NAMES
    .map(p => ({ pass: p, ...computePassEWR(outcomes, p) }))
    .filter(s => s.n >= 10 && s.confidence >= 0.5)
    .sort((a, b) => a.ewr - b.ewr);
  
  if (passStats.length === 0) {
    return { status: 'INSUFFICIENT_DATA', message: 'Not enough confident data for any pass' };
  }
  
  const worst = passStats[0];
  if (worst.ewr > 0.7) {
    return { status: 'NO_ACTION', message: 'All passes above 0.7 EWR — no evolution needed' };
  }
  
  // Load current prompt via prompt registry
  const currentPrompt = getActivePrompt(worst.pass);
  const currentRevisionId = getActiveRevisionId(worst.pass);
  
  // Sanitize and sample examples (mixed recent + random)
  const sanitized = sanitizeOutcomes(outcomes.filter(o => o.pass === worst.pass));
  if (sanitized.length < MIN_EXAMPLES_THRESHOLD) {
    return { status: 'INSUFFICIENT_DATA', message: `Only ${sanitized.length} sanitized examples for ${worst.pass}` };
  }
  
  const dismissed = sanitized.filter(o => !o.accepted);
  const accepted = sanitized.filter(o => o.accepted);
  const examples = {
    dismissed: [...dismissed.slice(-3), ...reservoirSample(dismissed, 2)],
    accepted: reservoirSample(accepted, 3)
  };
  
  // Generate variant via LLM adapter
  const variant = await generateVariantViaLLM(/* ... */);
  if (!variant) return null;
  
  // Compute immutable revision ID from content hash
  const newRevisionId = revisionId(variant.result.promptText);
  const experimentId = `${worst.pass}-${newRevisionId}`;  // Deterministic for idempotent sync
  
  // Guard: prevent resurrection of already-resolved experiments
  const existing = experimentStore.loadAll().find(e => e.experimentId === experimentId);
  if (existing && ['killed', 'promoted', 'stale'].includes(existing.status)) {
    return { status: 'NO_ACTION', reason: 'experiment already resolved' };
  }
  
  try {
    // Persisted experiment manifest with step completion markers.
    // On startup, reconcile orphaned revisions/arms from incomplete prior runs.
    const manifest = {
      experimentId,
      steps: { revision_saved: false, arm_registered: false, active: false }
    };
    
    // Step 1: Persist prompt revision atomically (immutable)
    saveRevision(worst.pass, newRevisionId, variant.result.promptText, {
      source: 'textgrad-auto',
      parentRevisionId: currentRevisionId,
      generatedAt: Date.now()
    });
    manifest.steps.revision_saved = true;
    experimentManifestStore.save(manifest);
    
    // Step 2: Register bandit arm (references revision ID)
    // Auto-generated variants are local-only until promoted
    bandit.addArm(worst.pass, newRevisionId, null, {
      source: 'textgrad-auto',
      parentRevisionId: currentRevisionId,
      promptRevisionId: newRevisionId,
      syncable: false  // Only promoted variants sync to Supabase
    });
    manifest.steps.arm_registered = true;
    experimentManifestStore.save(manifest);
    
    // Step 3: Log experiment with deterministic ID
    const experiment = {
      experimentId,
      timestamp: Date.now(),
      pass: worst.pass,
      revisionId: newRevisionId,
      parentRevisionId: currentRevisionId,
      parentEWR: worst.ewr,
      parentConfidence: worst.confidence,
      parentEffectiveSampleSize: worst.n,
      rationale: variant.result.rationale,
      status: 'active'
    };
    
    experimentStore.append(experiment);
    manifest.steps.active = true;
    experimentManifestStore.save(manifest);
    return experiment;
    
  } catch (err) {
    abandonRevision(worst.pass, newRevisionId, bandit);
    process.stderr.write(`[evolve] Failed to persist variant: ${err.message}\n`);
    return null;
  }
}
```

**Experiment state machine**: `active` (min 10 pulls) -> `converged` (posterior win probability > 0.9 sustained for 3 runs) -> `promoted`/`killed`/`stale`. Deterministic `experimentId` for idempotent sync.

**Startup reconciliation**: On startup, `reconcileOrphanedExperiments()` scans `.audit/experiment-manifests/` for incomplete manifests (where `active` is false). For each orphan: if `revision_saved` but not `arm_registered`, abandon the revision. If `arm_registered` but not `active`, deactivate the arm. No full saga needed — just idempotent cleanup of partial state.

**Baseline invalidation invariant**: Each experiment freezes `parentRevisionId` as the control baseline at creation time. If the `default` alias for that pass changes while the experiment is still `active` (i.e., the control arm has been repointed), the experiment is automatically marked `stale` and excluded from promotion decisions. Stale experiments still collect data but cannot be promoted or converge. Checked at selection time and at promotion time:

```javascript
/**
 * Check if an experiment's baseline has been invalidated.
 * If default alias no longer points to parentRevisionId, mark stale.
 */
function checkBaselineValidity(experiment) {
  const currentDefault = getActiveRevisionId(experiment.pass);
  if (currentDefault !== experiment.parentRevisionId && experiment.status === 'active') {
    experiment.status = 'stale';
    process.stderr.write(`  [evolve] Experiment ${experiment.experimentId} marked stale: default changed from ${experiment.parentRevisionId} to ${currentDefault}\n`);
  }
  return experiment;
}
```

**Experiment evaluation scope**: Experiments evaluate at GLOBAL bucket only. Context-specific experiment evaluation is deferred until the basic pipeline is proven. This simplifies convergence to single-bucket comparison — the experiment's variant arm and the control arm are compared using only their `GLOBAL_CONTEXT_BUCKET` statistics.

**Human review gate**: `evolve-prompts.mjs review` shows experiments where the bandit has converged. Human runs `promote` to make a variant the new default (repoints alias), or `kill` to remove it.

### 2.16 CLI Contract for evolve-prompts.mjs

```
node scripts/evolve-prompts.mjs evolve [--outcomes <path>] [--out <file>]
  -> Identify worst pass, generate variant, register bandit arm
  -> Exit 0: variant created | Exit 1: error | Exit 2: no action needed / insufficient data
  -> stdout: 1-line summary | --out: JSON experiment record

node scripts/evolve-prompts.mjs review [--out <file>]
  -> Show converged experiments with side-by-side stats
  -> Exit 0: experiments found | Exit 2: none converged

node scripts/evolve-prompts.mjs promote <pass> <revisionId> [--out <file>]
  -> Promote revision to default, sync to Supabase prompt_revisions table
  -> Exit 0: promoted | Exit 1: variant not found

node scripts/evolve-prompts.mjs kill <pass> <revisionId>
  -> Remove variant, update bandit state
  -> Exit 0: removed | Exit 1: variant not found

node scripts/evolve-prompts.mjs stats [--outcomes <path>]
  -> Show EWR per pass, active experiments, bandit convergence
```

**Structured output schemas** (Zod):
```javascript
const GeneratedVariantSchema = z.object({
  promptText: z.string().min(100).max(10000),
  diff: z.string().describe('Human-readable diff from parent prompt'),
  rationale: z.string().max(500),
  targetedPatterns: z.array(z.string()).describe('FP patterns this variant aims to fix')
});

const ExperimentRecordSchema = z.object({
  experimentId: z.string(),   // Deterministic: `${passName}-${revisionId}`
  timestamp: z.number(),
  pass: z.string(),
  revisionId: z.string(),     // rev-<sha12>
  parentRevisionId: z.string(),
  parentEWR: z.number(),
  parentConfidence: z.number(),
  parentEffectiveSampleSize: z.number().int(),
  status: z.enum(['active', 'converged', 'promoted', 'killed', 'stale']),
  rationale: z.string().optional(),
  finalEWR: z.number().optional(),
  finalConfidence: z.number().optional(),
  totalPulls: z.number().int().optional()
});
```

**Error handling**: Service functions return typed result objects (`{status: 'INSUFFICIENT_DATA'|'NO_ACTION'|'CREATED', ...}`). CLI wrapper translates to exit codes: `CREATED` -> exit 0, `NO_ACTION`/`INSUFFICIENT_DATA` -> exit 2, thrown errors -> exit 1. Missing outcomes file -> `INSUFFICIENT_DATA`. Missing prompt files -> thrown error. Supabase unavailable -> local-only mode (log warning, continue). Invalid LLM response -> log, return `{status: 'NO_ACTION'}`.

### 2.17 Cloud Sync Enhancements

**File**: `scripts/learning-store.mjs`

**Changes**:

**DB boundary mapping**: All sync functions perform explicit camelCase→snake_case mapping on write and snake_case→camelCase mapping on read, inline within each sync function (not separate modules). Each transform result is validated with the corresponding Zod schema (e.g., `FPPatternRecordSchema.safeParse()` after reading from DB) to catch drift between local and cloud schemas early.

1. **Sync context buckets**: Update `syncBanditArms()` to include `context_bucket` in upsert rows.

2. **Sync experiment log**: New `syncExperiments()` function upserts experiments using deterministic `experimentId` as the upsert key:

```javascript
export async function syncExperiments(experiments) {
  if (!_supabase) return;
  const { error } = await _supabase
    .from('prompt_experiments')
    .upsert(experiments, { onConflict: 'experiment_id' });
}
```

3. **Prompt revision distribution**: On promotion, sync prompt text to `prompt_revisions` table:

```javascript
export async function syncPromptRevision(passName, revisionId, promptText) {
  if (!_supabase) return;
  const { error } = await _supabase
    .from('prompt_revisions')
    .upsert({
      pass_name: passName,
      revision_id: revisionId,
      prompt_text: promptText,
      checksum: computePromptChecksum(promptText),
      promoted_at: new Date().toISOString()
    }, { onConflict: 'pass_name,revision_id' });
}
```

4. **Load FP patterns**: After Stage 2b backfill, all rows have explicit dimension columns — no dual-stack loading needed. Queries use only the new-format columns:

```javascript
import { GLOBAL_REPO_ID } from './lib/config.mjs';

export async function loadFalsePositivePatterns(repoId) {
  if (!_supabase) return { repoPatterns: [], globalPatterns: [] };
  
  const { data: repo } = await _supabase
    .from('false_positive_patterns')
    .select('category, severity, principle, repo_id, file_extension, scope, dismissed, accepted, ema, decayed_accepted, decayed_dismissed, last_decay_ts, auto_suppress')
    .eq('repo_id', repoId).eq('auto_suppress', true);
  
  const { data: global } = await _supabase
    .from('false_positive_patterns')
    .select('category, severity, principle, repo_id, file_extension, scope, dismissed, accepted, ema, decayed_accepted, decayed_dismissed, last_decay_ts, auto_suppress')
    .eq('repo_id', GLOBAL_REPO_ID).eq('auto_suppress', true);
  
  return {
    repoPatterns: repo || [],
    globalPatterns: global || []
  };
}
```

### 2.18 Non-Null Sentinels & Config Additions

**File**: `scripts/lib/config.mjs`

**Sentinel constants**: Used instead of NULL for DB uniqueness constraints:

```javascript
export const GLOBAL_CONTEXT_BUCKET = 'global';
export const GLOBAL_REPO_ID = '00000000-0000-0000-0000-000000000000';
export const UNKNOWN_FILE_EXT = 'unknown';
```

**Normalized language enum**: Canonical language identifiers for bandit context bucketing:

```javascript
export const LANGUAGES = Object.freeze(['js', 'ts', 'py', 'go', 'java', 'rust', 'mixed', 'other']);

/**
 * Normalize a language string to canonical enum value.
 * Handles common aliases (javascript -> js, typescript -> ts, python -> py, golang -> go).
 */
export function normalizeLanguage(lang) {
  if (!lang) return 'other';
  const lower = lang.toLowerCase().trim();
  const aliases = {
    javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
    typescript: 'ts', tsx: 'ts',
    python: 'py', python3: 'py',
    golang: 'go',
    'c#': 'other', csharp: 'other', cpp: 'other', c: 'other',
    ruby: 'other', php: 'other', swift: 'other', kotlin: 'other'
  };
  const normalized = aliases[lower] || lower;
  return LANGUAGES.includes(normalized) ? normalized : 'other';
}
```

**Pass catalog**: Canonical list of pass names, used by evolution/refinement instead of hardcoding:

```javascript
export const PASS_NAMES = Object.freeze(['structure', 'wiring', 'backend', 'frontend', 'sustainability']);
```

**New env vars**:

| Variable | Default | Purpose |
|----------|---------|---------|
| `OUTCOME_HALF_LIFE_DAYS` | `30` | Half-life for outcome time decay (days) |
| `OUTCOME_MAX_AGE_DAYS` | `180` | Hard cutoff for outcome pruning (days) |
| `OUTCOME_PRUNE_ENABLED` | `true` | Enable/disable outcome pruning |
| `UCB_MIN_PULLS` | `3` | Minimum pulls before Thompson Sampling takes over |
| `MIN_BUCKET_SAMPLES` | `5` | Minimum total pulls at a context level before trusting it |
| `MIN_FP_SAMPLES` | `5` | Minimum effective sample size before trusting narrow FP scope |
| `MIN_EXAMPLES_THRESHOLD` | `3` | Minimum sanitized examples for example-driven refinement |

### 2.19 Supabase Schema Additions

**Rollout strategy**: Staged migration — additive columns first, then backfill, then constraints.

```sql
-- Stage 1: Additive changes only (safe to run on existing data)

-- Prompt revisions (new table — stores promoted prompt text)
CREATE TABLE IF NOT EXISTS prompt_revisions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  pass_name TEXT NOT NULL,
  revision_id TEXT NOT NULL,           -- rev-<sha12> content hash
  prompt_text TEXT NOT NULL,
  checksum TEXT NOT NULL,
  promoted_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (pass_name, revision_id)
);

-- Prompt evolution experiments (new table)
CREATE TABLE IF NOT EXISTS prompt_experiments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  experiment_id TEXT NOT NULL UNIQUE,  -- deterministic ID for idempotent sync
  pass_name TEXT NOT NULL,
  revision_id TEXT NOT NULL,           -- rev-<sha12>
  parent_revision_id TEXT,
  parent_ewr REAL,
  parent_confidence REAL,
  parent_effective_sample_size INT,
  rationale TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'converged', 'promoted', 'killed', 'stale')),
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  final_ewr REAL,
  final_confidence REAL,
  total_pulls INT DEFAULT 0
);

-- Add context_bucket to bandit_arms (nullable, no constraint yet)
ALTER TABLE bandit_arms ADD COLUMN IF NOT EXISTS context_bucket TEXT;

-- Replace pattern_type/pattern_value with explicit dimension columns
-- Stage 1: Add as NULLABLE (NOT NULL enforced only after backfill validation)
ALTER TABLE false_positive_patterns ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE false_positive_patterns ADD COLUMN IF NOT EXISTS severity TEXT;
ALTER TABLE false_positive_patterns ADD COLUMN IF NOT EXISTS principle TEXT;
ALTER TABLE false_positive_patterns ADD COLUMN IF NOT EXISTS repo_id UUID DEFAULT '00000000-0000-0000-0000-000000000000';
ALTER TABLE false_positive_patterns ADD COLUMN IF NOT EXISTS file_extension TEXT DEFAULT 'unknown';
ALTER TABLE false_positive_patterns ADD COLUMN IF NOT EXISTS scope TEXT DEFAULT 'global';

-- Stage 2: Backfill — normalize NULL sentinels to non-null values

UPDATE bandit_arms SET context_bucket = 'global' WHERE context_bucket IS NULL;
ALTER TABLE bandit_arms ALTER COLUMN context_bucket SET DEFAULT 'global';
ALTER TABLE bandit_arms ALTER COLUMN context_bucket SET NOT NULL;

UPDATE false_positive_patterns SET file_extension = 'unknown' WHERE file_extension IS NULL;
ALTER TABLE false_positive_patterns ALTER COLUMN file_extension SET DEFAULT 'unknown';
ALTER TABLE false_positive_patterns ALTER COLUMN file_extension SET NOT NULL;

UPDATE false_positive_patterns
  SET repo_id = '00000000-0000-0000-0000-000000000000'
  WHERE repo_id IS NULL;
ALTER TABLE false_positive_patterns ALTER COLUMN repo_id SET DEFAULT '00000000-0000-0000-0000-000000000000';
ALTER TABLE false_positive_patterns ALTER COLUMN repo_id SET NOT NULL;

-- Stage 2b: Backfill old-format FP records (pattern_type/pattern_value -> explicit columns)
-- Preserves existing behavior (auto_suppress = true) and sets explicit dimension defaults
UPDATE false_positive_patterns
  SET category = split_part(pattern_value, '::', 1),
      severity = split_part(pattern_value, '::', 2),
      principle = split_part(pattern_value, '::', 3),
      auto_suppress = true,
      repo_id = '00000000-0000-0000-0000-000000000000',
      scope = 'global',
      file_extension = 'unknown'
  WHERE category IS NULL AND pattern_value IS NOT NULL;

-- Stage 3: Enforce NOT NULL only after backfill validation (verify zero NULLs remain)
-- Run validation query first: SELECT count(*) FROM false_positive_patterns WHERE category IS NULL;
ALTER TABLE false_positive_patterns ALTER COLUMN repo_id SET NOT NULL;
ALTER TABLE false_positive_patterns ALTER COLUMN file_extension SET NOT NULL;
ALTER TABLE false_positive_patterns ALTER COLUMN scope SET NOT NULL;

-- Stage 4: Enforce unique constraints (safe after backfill)

ALTER TABLE bandit_arms DROP CONSTRAINT IF EXISTS bandit_arms_pass_name_variant_id_key;
ALTER TABLE bandit_arms DROP CONSTRAINT IF EXISTS bandit_arms_unique;
ALTER TABLE bandit_arms ADD CONSTRAINT bandit_arms_unique
  UNIQUE (pass_name, variant_id, context_bucket);

ALTER TABLE false_positive_patterns DROP CONSTRAINT IF EXISTS false_positive_patterns_unique;
ALTER TABLE false_positive_patterns ADD CONSTRAINT false_positive_patterns_unique
  UNIQUE (repo_id, category, severity, principle, file_extension, scope);
```

---

## 3. File-Level Implementation Plan

| File | Action | Description |
|------|--------|-------------|
| `scripts/lib/config.mjs` | MODIFY | Add sentinel constants (`GLOBAL_REPO_ID`, `GLOBAL_CONTEXT_BUCKET`, `UNKNOWN_FILE_EXT`), `PASS_NAMES`, new env vars for decay/pruning/thresholds |
| `scripts/lib/file-store.mjs` | CREATE | `MutexFileStore` (lock + atomic write) and `AppendOnlyStore` (atomic append) — shared abstraction for all state files |
| `scripts/lib/findings.mjs` | MODIFY | Structured FP dimensions, multi-scope counters, EMA derived from lazy-decay weights (`decayedAccepted`/`decayedDismissed`/`lastDecayTs`), side-effect-free `loadOutcomes()`, `compactOutcomes()` under lock, `RemediationTask` lifecycle with CRUD APIs persisted to `.audit/remediation-tasks.jsonl` via `AppendOnlyStore`, canonical EWR metric, use `MutexFileStore` |
| `scripts/lib/prompt-registry.mjs` | CREATE | Immutable prompt revisions (`rev-<sha12>`), lifecycle states (`draft→active→promoted→retired→abandoned`), `default` alias, bootstrap from existing constants (idempotent), load/save/promote/abandon APIs (reference-checked: refuses state transition when active arms reference revision), checksum, lineage tracking, use `MutexFileStore` |
| `scripts/lib/prompt-seeds.mjs` | CREATE | Extracted prompt constants from `openai-audit.mjs` — canonical seed artifact for bootstrap; `openai-audit.mjs` imports from here |
| `scripts/lib/sanitizer.mjs` | CREATE | Outcome sanitization — `primaryFile`/`affectedFiles` (not `section`), redact secrets, filter sensitive files, Zod-validate output |
| `scripts/lib/suppression-policy.mjs` | CREATE | Unified R2+ suppression policy — confidence-aware scope resolution, feeds all 3 layers from one object |
| `scripts/lib/llm-wrappers.mjs` | CREATE | Extract `safeCallGPT()` and `callGemini()` from their current modules; standard `{result, usage, latencyMs}` envelope; `createLearningAdapter(providers)` factory accepts injected client instances (no self-created clients); used by refinement/evolution |
| `scripts/bandit.mjs` | MODIFY | Single `select(passName, context)` with `ensureContextArms()` + hierarchical backoff + UCB cold-start, pass-scoped evaluation records, canonical reward formula with deliberation signal, seedable RNG, use `MutexFileStore` |
| `scripts/refine-prompts.mjs` | MODIFY | Example-driven refinement with sanitization, replay buffer (reservoir sampling with seedable RNG), empty-state handling (exit 2), use prompt-registry + LLM adapter |
| `scripts/evolve-prompts.mjs` | CREATE | TextGrad pipeline with CLI (evolve/review/promote/kill/stats), experiment state machine, deterministic `experimentId`, pass catalog from config, empty-state exit 2 |
| `scripts/learning-store.mjs` | MODIFY | Non-null sentinel sync, experiment sync by `experimentId`, prompt revision distribution on promotion, hierarchical FP loading |
| `scripts/openai-audit.mjs` | MODIFY | Use prompt-registry for prompt loading, wire context to bandit `select()`, populate finding-edit-links, use suppression-policy, extract `safeCallGPT()` to `lib/llm-wrappers.mjs` |
| `scripts/gemini-review.mjs` | MODIFY | Wire context bucket passthrough, extract `callGemini()` to `lib/llm-wrappers.mjs` |
| `supabase/migrations/002_learning_v2.sql` | CREATE | 3-stage migration: additive -> backfill sentinels -> enforce constraints |
| `tests/shared.test.mjs` | MODIFY | EMA from lazy-decay weights, hierarchical pattern keys, lazy-decay model, side-effect-free `loadOutcomes()`, `compactOutcomes()`, `RemediationTask` lifecycle |
| `tests/bandit.test.mjs` | MODIFY | Single `select()` with hierarchical backoff, UCB cold-start (underexplored-only selection), verification-gated reward, deliberation signal, seedable RNG fixtures |
| `tests/evolve.test.mjs` | CREATE | TextGrad pipeline, replay buffer, experiment state machine, CLI contracts, empty-state handling |
| `tests/sanitizer.test.mjs` | CREATE | Secret redaction, path normalization, sensitive file exclusion, Zod validation |
| `tests/file-store.test.mjs` | CREATE | MutexFileStore lock acquisition, atomic writes, stale lock detection, AppendOnlyStore |

---

## 4. Dependency & Ordering

```
Phase 0 — Foundation (no runtime dependencies, can be parallel):
  ├── 2.18 Config: sentinel constants, PASS_NAMES, new env vars
  ├── M12 Extract prompt constants to lib/prompt-seeds.mjs
  ├── 2.12 MutexFileStore + AppendOnlyStore (lib/file-store.mjs)
  ├── 2.14 LLM wrapper extraction (lib/llm-wrappers.mjs)
  ├── 2.11 Outcome sanitizer (lib/sanitizer.mjs)
  ├── 2.19 Supabase migration Stage 1 (additive columns only)
  └── 2.13 Seedable RNG (lib/rng.mjs or inline in bandit.mjs)

Phase A (depends on Phase 0 — can be parallel within phase):
  ├── 2.1 FP tracker structured dimensions + multi-scope counters
  ├── 2.2 EMA derivation from lazy-decay weights (see 2.7)
  ├── 2.7 Outcome decay + timestamp normalization + pruning
  ├── 2.9 Canonical EWR metric
  ├── 2.4 Immutable prompt revisions (lib/prompt-registry.mjs)
  └── 2.8 Unified suppression policy (lib/suppression-policy.mjs)

Phase B (depends on Phase A):
  ├── 2.3 Single select() with ensureContextArms + hierarchical backoff + UCB
  ├── 2.5 Pass-scoped evaluation records + finding-edit-links
  ├── 2.6 Canonical reward formula with deliberation signal
  └── 2.10 Example-driven refinement with sanitization + replay buffer

Phase C (depends on Phase B):
  ├── 2.15 TextGrad evolution pipeline (evolve-prompts.mjs)
  ├── 2.16 CLI contracts + Zod schemas
  └── 2.17 Cloud sync: sentinels, experiment upsert, prompt revision distribution

Phase D (depends on Phase C):
  ├── 2.19 Supabase migration Stages 2-3 (backfill sentinels → enforce constraints)
  ├── Wiring in openai-audit.mjs (prompt-registry, suppression-policy, context, evaluation record)
  ├── Wiring in gemini-review.mjs (context bucket passthrough)
  └── Full test suite (all new modules + backward compat)
```

---

## 5. Testing Strategy

### Unit Tests (node --test) — Deterministic via Seedable RNG

- **EMA derivation**: Verify `ema` is derived from `decayedAccepted / (decayedAccepted + decayedDismissed)` after lazy decay; verify default 0.5 when total is zero; verify no standalone EMA function exists (EMA is computed inline by `applyLazyDecay()` and `recordWithDecay()`)
- **Hierarchical pattern keys**: Verify repo+fileType key, repo-only key, global key; verify hierarchical lookup order; verify legacy keys treated as global scope (never re-keyed)
- **Outcome decay**: Verify 30-day half-life weighting; verify 180-day hard cutoff; verify legacy outcomes (no timestamp) use `_importedAt` not epoch 0
- **Side-effect-free loadOutcomes()**: Verify `loadOutcomes()` does not write to disk; verify `_importedAt` assigned in-memory only; verify repeated loads are idempotent
- **compactOutcomes()**: Verify backfill + pruning under lock; verify `OUTCOME_PRUNE_ENABLED=false` skips pruning; verify backfilled entries not pruned immediately; verify same lock file as `AppendOnlyStore`
- **Lazy-decay model**: Verify `applyLazyDecay()` is pure (returns new object, does not mutate input); verify it applies `exp(-lambda * elapsed)` to both weights; verify EMA derived from decayed weights; verify `effectiveSampleSize()` returns `decayedAccepted + decayedDismissed`; verify decay is only persisted on write/compaction
- **RemediationTask lifecycle**: Verify task created at adjudication with deterministic ID; verify `trackEdit()` appends edits and updates state; verify `verifyTask()` sets verified/regressed; verify reward reads from persisted task state
- **Single select()**: Verify hierarchical backoff (exact -> size -> global); verify `ensureContextArms()` lazy materialization; verify `MIN_BUCKET_SAMPLES` threshold; verify no separate `selectWithContext()` exists
- **UCB cold-start**: Verify ONLY underexplored arms (<`UCB_MIN_PULLS`) are candidates during cold-start; verify transition to full Thompson Sampling only after ALL arms meet threshold; verify UCB1 score calculation
- **Canonical reward**: Verify per-finding: procedural 40% + substantive 30% + deliberation 30%; verify verification-gated substantive (`verified=1.0, fixed=0.7, planned=0.5, pending=0.0, regressed=0.0`); verify per-pass: simple mean (severity applied ONCE in `computeReward()`, NOT in `computePassReward()`); verify stored on `PassEvaluationRecord`
- **Deliberation signal**: Verify challenged+sustained scores highest; trivially accepted scores lowest; rationale length bonus
- **Canonical EWR**: Verify time-weighted reward aggregation; verify confidence calculation; verify same metric used by bandit, evolution, and convergence
- **Replay buffer**: Verify reservoir sampling uniformity with seedable RNG (deterministic test + statistical smoke test)
- **Sanitizer**: Verify `primaryFile`/`affectedFiles` used (not `section`); verify outcomes without file metadata excluded; verify secret redaction regex; verify Zod validation
- **Prompt registry**: Verify immutable revisions (`rev-<sha12>`, 12 hex chars); verify lifecycle states (`draft→active→promoted→retired→abandoned`); verify `abandonRevision()` refuses when active arms reference the revision; verify bootstrap from `prompt-seeds.mjs` is idempotent; verify `saveRevision()` is content-addressed no-op for same content; verify `default` alias repointing; verify promotion does not mutate content; verify full checksum stored for verification
- **MutexFileStore**: Verify lock acquisition; verify atomic writes; verify stale-lock timeout; verify Zod validation on `load()` quarantines corrupted data to `.audit/quarantine/`; verify `AppendOnlyStore` validates on `append()` and quarantines invalid records
- **Seedable RNG**: Verify deterministic output with seed; verify Beta distribution shape (smoke test)
- **Empty-state handling**: Verify service functions return `{status: 'INSUFFICIENT_DATA'}` (not `process.exit()`); verify CLI wrapper translates to exit code 2
- **Experiment state machine**: Verify `active` -> `converged` -> `promoted`/`killed`/`stale` transitions; verify deterministic `experimentId`; verify baseline invalidation marks experiment `stale` when default alias changes
- **Sanitized location**: Verify `sanitizePath()` produces `directory/basename` (two-level path); verify absolute paths redacted
- **Language enum**: Verify `normalizeLanguage()` handles aliases (`javascript`->`js`, `typescript`->`ts`, etc.); verify unknown languages map to `'other'`

### Integration Tests

- **End-to-end learning**: Run mock audit -> record outcomes with lifecycle -> verify FP tracker updates at all scopes -> verify bandit reward uses canonical formula -> verify cloud sync with sentinels
- **TextGrad pipeline**: Mock LLM -> verify sanitized input -> verify revision created (immutable) -> verify bandit arm registered -> verify experiment logged with deterministic ID
- **Suppression policy**: Verify unified policy feeds all 3 R2+ layers consistently; verify ledger + FP + cloud patterns merged and deduplicated; verify confidence-aware override

### Backward Compatibility

- Verify existing `.audit/bandit-state.json` loads correctly — arms without `contextBucket` treated as `GLOBAL_CONTEXT_BUCKET`
- Verify existing `.audit/fp-tracker.json` loads correctly — old pattern keys treated as global scope, never re-keyed; lazy decay initializes `decayedAccepted`/`decayedDismissed` from raw counters on first access
- Verify existing `outcomes.jsonl` without timestamps — `_importedAt` assigned in-memory by `loadOutcomes()` (no side effects); `compactOutcomes()` persists backfill under lock
- Verify existing Supabase data survives Stage 2 backfill — NULL sentinels normalized without data loss
- Verify modules that used independent `_save()` work correctly with `MutexFileStore`

---

## 6. Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Auto-generated prompts could degrade quality | Bandit A/B tests before promotion; human review gate required; EWR confidence threshold; experiment state machine with min 10 pulls |
| Context bucketing fragments data too much | Hierarchical backoff with `MIN_BUCKET_SAMPLES`; lazy arm materialization via `ensureContextArms()`; 3-level fallback |
| Outcome decay removes valuable historical signal | 180-day cutoff; pruning controlled by `OUTCOME_PRUNE_ENABLED`; legacy entries backfilled with `_importedAt` (not epoch 0) |
| RLAIF deliberation signal is a crude proxy | Weighted at only 30% of total reward; procedural + substantive still dominate |
| Legacy FP data loses specificity | Legacy keys preserved as global-scope fallback; never re-keyed; new scoped stats collected prospectively |
| Supabase migration on existing deployments | 3-stage rollout: additive -> backfill -> constraints; each stage independently safe |
| Outcome detail leaks secrets to external LLMs | Sanitization pipeline: `primaryFile`/`affectedFiles` (not `section`), secret redaction regex, sensitive file exclusion, Zod validation |
| Objective function mismatch between bandit and evolution | Canonical EWR metric used everywhere: bandit, evolution targeting, convergence, promotion |
| Prompt ownership fragmented across scripts | Dedicated prompt-registry with immutable revisions; `default` is an alias; all scripts depend on registry |
| R2+ suppression layers diverge | Unified suppression-policy resolves once, feeds all 3 layers from same policy object |
| Cross-machine variant sync gaps | Auto-generated variants local-only until promoted; `prompt_revisions` table syncs on promotion |
| Concurrent audit runs corrupt state | `MutexFileStore` with lock file + atomic writes for all mutable state; deterministic experiment IDs for idempotent sync |
| New LLM calls diverge from project patterns | Shared `lib/llm-wrappers.mjs` extracted from existing modules; standard envelope; direct API calls prohibited in refinement/evolution |
| Sparse FP scope overrides strong global signal | Confidence-aware suppression: `effectiveSampleSize >= MIN_FP_SAMPLES` required before narrower scope overrides; emits winning scope + confidence |
| Non-deterministic test failures from stochastic components | Seedable RNG injected into all stochastic components; deterministic fixtures in unit tests; statistical smoke tests kept separate |
| `select()` and `selectWithContext()` drift apart | Single `select(passName, context)` entrypoint — no separate codepath exists |

---

## Appendix A — Canonical Schemas (Single Source of Truth)

All code snippets in sections 2.x are derived from these canonical schemas. When in doubt, these schemas are authoritative.

### A.1 FP Pattern Record
```javascript
const FPPatternRecordSchema = z.object({
  category: z.string(),
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']),
  principle: z.string(),
  repoId: z.string(),           // GLOBAL_REPO_ID for global scope
  fileExtension: z.string(),    // UNKNOWN_FILE_EXT for global scope
  scope: z.enum(['global', 'repo', 'repo+fileType']),
  dismissed: z.number().int().min(0),       // Raw lifetime count (diagnostics)
  accepted: z.number().int().min(0),        // Raw lifetime count (diagnostics)
  decayedAccepted: z.number().min(0),       // Time-decayed accepted weight
  decayedDismissed: z.number().min(0),      // Time-decayed dismissed weight
  lastDecayTs: z.number(),                  // Timestamp of last decay application
  ema: z.number().min(0).max(1),            // Derived from decayed weights
  firstSeen: z.number(),
  lastUpdated: z.number()
});
```

### A.2 Canonical Reward Formula
```javascript
// SINGLE canonical formula — used by computeReward(), stored on PassEvaluationRecord,
// aggregated by computePassEWR(), compared by evolveWorstPass()
//
// Per-finding: procedural (40%) + substantive (30%) + deliberation quality (30%)
// Per-pass: simple mean of per-finding rewards (severity applied ONCE in computeReward)
function computeReward(resolution, evaluationRecord) {
  // 1. Procedural signal (40%)
  const procedural = (positionWeights[resolution.claude_position] * 0.4
                    + rulingWeights[resolution.gpt_ruling] * 0.6)
                    * severityMult[resolution.final_severity];

  // 2. Substantive signal (30%) — verification-gated from finding-edit-links
  const link = evaluationRecord.findingEditLinks.find(l => l.semanticHash === resolution.semanticHash);
  const remediationReward = { verified: 1.0, fixed: 0.7, planned: 0.5, pending: 0.0, regressed: 0.0 };
  const changeBonus = remediationReward[link?.remediationState] ?? 0.0;
  // Severity weighting applied ONCE here — not again in computePassReward()
  const substantive = changeBonus * severityMult[resolution.final_severity];

  // 3. Deliberation quality signal (30%)
  const deliberation = deliberationSignal(resolution);

  return procedural * 0.4 + substantive * 0.3 + deliberation * 0.3;
}
```

### A.3 Sanitized Outcome Record
```javascript
const SanitizedOutcomeSchema = z.object({
  category: z.string(),
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  primaryFile: z.string(),      // Two-level path (directory/basename), NOT section or absolute path
  detail: z.string().max(300),  // Redacted
  ruling: z.string().optional(),
  rulingRationale: z.string().max(200).optional(),
  accepted: z.boolean(),
  pass: z.string(),
  _recencyBucket: z.enum(['recent', 'mid', 'old'])  // For recency sampling after sanitization
});
```

### A.4 Pass Evaluation Record
```javascript
const PassEvaluationRecordSchema = z.object({
  runId: z.string(),
  passName: z.string(),
  promptRevisionId: z.string(),     // rev-<sha12> — immutable content hash
  contextBucket: z.string(),
  findingEditLinks: z.array(z.object({
    semanticHash: z.string(),
    findingId: z.string(),
    severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
    edits: z.array(z.object({
      file: z.string(),
      type: z.enum(['edit', 'create', 'delete']),
      linesChanged: z.array(z.number()).optional()
    })),
    remediationState: z.enum(['pending', 'planned', 'fixed', 'verified', 'regressed']),
    verifiedBy: z.enum(['gemini', 'gpt', 'claude']).optional(),
    reward: z.number().optional()   // Per-finding canonical reward
  })),
  totalFindings: z.number(),
  findingsWithEdits: z.number(),
  computedReward: z.number().optional()  // Per-pass severity-weighted mean
});
```

### A.5 Experiment Record
```javascript
const ExperimentRecordSchema = z.object({
  experimentId: z.string(),           // Deterministic: `${passName}-${revisionId}`
  timestamp: z.number(),
  pass: z.string(),
  revisionId: z.string(),             // rev-<sha12>
  parentRevisionId: z.string(),
  parentEWR: z.number(),
  parentConfidence: z.number(),
  parentEffectiveSampleSize: z.number().int(),
  status: z.enum(['active', 'converged', 'promoted', 'killed', 'stale']),
  rationale: z.string().optional(),
  finalEWR: z.number().optional(),
  finalConfidence: z.number().optional(),
  totalPulls: z.number().int().optional()
});
```

### A.6 Non-Null Sentinels
```javascript
// Defined in lib/config.mjs — used instead of NULL for DB uniqueness
export const GLOBAL_CONTEXT_BUCKET = 'global';
export const GLOBAL_REPO_ID = '00000000-0000-0000-0000-000000000000';
export const UNKNOWN_FILE_EXT = 'unknown';
```

### A.7 RemediationTask Record
```javascript
const RemediationTaskSchema = z.object({
  taskId: z.string(),            // Deterministic: `${runId}-${passName}-${semanticHash}`
  runId: z.string(),
  passName: z.string(),
  semanticHash: z.string(),
  findingId: z.string(),
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  remediationState: z.enum(['pending', 'planned', 'fixed', 'verified', 'regressed']),
  createdAt: z.number(),
  updatedAt: z.number(),
  edits: z.array(z.object({
    file: z.string(),
    type: z.enum(['edit', 'create', 'delete']),
    linesChanged: z.array(z.number()).optional(),
    timestamp: z.number()
  })),
  verifiedBy: z.enum(['gemini', 'gpt', 'claude']).optional(),
  verifiedAt: z.number().optional()
});
```

### A.8 Language Enum
```javascript
export const LANGUAGES = Object.freeze(['js', 'ts', 'py', 'go', 'java', 'rust', 'mixed', 'other']);
```

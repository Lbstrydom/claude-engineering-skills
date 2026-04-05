# Plan: Phase B — SonarQube Classification for Findings

- **Date**: 2026-04-04
- **Status**: Audit-complete, ready to implement
- **Audit history**: 2 rounds (R1 H:5 M:6 L:0 → R2 H:5 M:3 L:1)
- **Stopping criteria**: HIGH count flat at 5 across R1→R2, but MEDIUM count dropped meaningfully (6→3). The remaining R2 HIGH findings are scope-creep requests (cross-source dedup normalization, full semanticId redesign, producer-output routing refactor) that Phase B deliberately doesn't own. Known limitations documented inline: (1) LLMs currently emit `sourceKind`/`sourceName` via prompt — could be caller-injected post-hoc in a follow-up; (2) classification fields in `semanticId` inputs would break dedup — kept separate by design.
- **Author**: Claude + Louis
- **Scope**: Add optional structured classification to findings (SonarQube-style: BUG | VULNERABILITY | CODE_SMELL | SECURITY_HOTSPOT) with effort estimation and source attribution. Backward compatible — existing findings continue to validate.
- **Parent plan**: `multi-language-and-linter-integration.md` (Phase B of 3)
- **Depends on**: Phase A (language profiles) must be complete

---

## 1. Context Summary

### What Exists Today

The `FindingSchema` at [schemas.mjs:12](scripts/lib/schemas.mjs#L12) has free-text `category` and `principle` fields. There's no structured taxonomy, no effort estimation, and no source attribution beyond what's embedded in category strings.

All three LLMs (Claude, GPT-5.4, Gemini) classify findings differently — GPT might say "DRY violation" while Claude says "code duplication" for the same issue. This inconsistency corrupts cross-round dedup and makes verdict math unreliable.

### Why SonarQube Taxonomy

SonarQube's classification is the industry standard for code quality findings:

- **BUG** — code that is demonstrably broken or will break at runtime
- **VULNERABILITY** — exploitable security flaw (OWASP Top 10)
- **CODE_SMELL** — works but makes code harder to maintain/extend
- **SECURITY_HOTSPOT** — needs manual security review (not necessarily a flaw)

All three LLMs already know this vocabulary from training data. Referencing it grounds findings in a shared language and aligns with existing developer mental models.

### Key Requirements

1. **Backward compatible** — existing findings without classification continue to validate
2. **Optional nested envelope** — `classification` is an optional object; when present, ALL fields within are required (atomic sub-schema)
3. **Extensible source** — `sourceKind` enum (stable) + `sourceName` string (free-text) — adding a new tool doesn't require schema migration
4. **Single canonical wire format** — one shape everywhere: GPT output, Gemini output, ledger snapshots, learning-store rows
5. **Read-boundary defaulting** — old persisted data without classification reads as `classification: null`, no backfill

### Non-Goals

- Linter integration → Phase C
- Rule-metadata registry → Phase C (classification for tool findings)
- Framework-specific taxonomy extensions → out of scope
- Auto-classification of existing findings — new findings only

---

## 2. Proposed Architecture

### 2.1 ClassificationSchema (Optional Nested Envelope)

**Modified file**: `scripts/lib/schemas.mjs`

```javascript
// Optional nested envelope — all fields within are required WHEN the envelope is present.
// This keeps schema evolution safe: absent = old format, present = new format fully specified.
export const ClassificationSchema = z.object({
  sonarType: z.enum(['BUG', 'VULNERABILITY', 'CODE_SMELL', 'SECURITY_HOTSPOT']).describe(
    'SonarQube classification: BUG=broken behavior, VULNERABILITY=exploitable flaw, ' +
    'CODE_SMELL=maintainability debt, SECURITY_HOTSPOT=needs manual security review'
  ),
  effort: z.enum(['TRIVIAL', 'EASY', 'MEDIUM', 'MAJOR', 'CRITICAL']).describe(
    'Fix effort estimate: TRIVIAL=<5min, EASY=<30min, MEDIUM=<2h, MAJOR=<1day, CRITICAL=architectural rewrite'
  ),
  sourceKind: z.enum(['MODEL', 'REVIEWER']).describe(
    'Stable source category. MODEL=primary auditor (GPT/Claude), REVIEWER=final-gate (Gemini/Opus). ' +
    'Phase C will add LINTER and TYPE_CHECKER.'
  ),
  sourceName: z.string().max(32).describe(
    'Specific tool/model: "gpt-5.4", "claude-opus-4-1", "gemini-3.1-pro-preview", etc.'
  ),
});

// Core finding fields (unchanged)
const FindingBase = {
  id: z.string().max(10).describe('Finding ID, e.g. H1, M3, L2'),
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  category: z.string().max(80),
  section: z.string().max(120),
  detail: z.string().max(600),
  risk: z.string().max(300),
  recommendation: z.string().max(600),
  is_quick_fix: z.boolean(),
  is_mechanical: z.boolean(),
  principle: z.string().max(80),
};

/**
 * ProducerFindingSchema — what LLMs emit. Classification is REQUIRED.
 * Used as response schema for GPT / Gemini / Claude audit calls.
 * Ensures all new findings have classification populated.
 */
export const ProducerFindingSchema = z.object({
  ...FindingBase,
  classification: ClassificationSchema, // REQUIRED (not .optional())
});

/**
 * PersistedFindingSchema — what we read from storage. Classification is OPTIONAL.
 * Old findings written before Phase B have no classification; must still validate.
 * Also accepts classification: null (from JSON parse of nullable cloud columns).
 */
export const PersistedFindingSchema = z.object({
  ...FindingBase,
  classification: ClassificationSchema.nullable().optional(),
});

/**
 * Backward-compatible alias — existing code that imports `FindingSchema`
 * gets the permissive persisted schema. Enforcement is at producer boundaries only.
 */
export const FindingSchema = PersistedFindingSchema;
```

### 2.2 Canonical Wire Format — ONE Shape Everywhere

**Decision**: The nested `classification` object is the ONLY shape. No flat fields. No dual-format support. Every producer/consumer reads/writes the same shape.

| Location | Before | After |
|---|---|---|
| GPT audit output (`openai-audit.mjs`) | `{severity, category, ...}` | Same + optional `classification: {...}` |
| Gemini output (`gemini-review.mjs`) | Same as GPT | Same + optional `classification: {...}` |
| Ledger entries (`batchWriteLedger`) | Passthrough raw finding | Validate via `FindingSchema.parse()` before write |
| Learning store rows | Flat columns | Add 4 nullable columns (sonar_type, effort, source_kind, source_name) |
| JSONL outcomes | Flat record | Include `classification` if present |

### 2.3 Migration Paths (Per Consumer)

**Producers** (emit findings with `classification`):

1. **openai-audit.mjs GPT prompts** — Update pass prompts to instruct GPT to populate `classification` for every finding. Schema auto-propagates via `zodTextFormat(FindingSchema)`. No code changes beyond prompt text.

2. **gemini-review.mjs** — Gemini schema is auto-derived via `zodToGeminiSchema(FindingSchema)`. Once `FindingSchema` has `classification`, Gemini gets it automatically. Prompt updated to instruct Gemini to populate it.

**Consumers** (read findings that MAY have `classification`):

1. **lib/ledger.mjs: `batchWriteLedger()`** — Ledger entries have their own schema (`LedgerEntrySchema` in schemas.mjs), not `FindingSchema`. Validate against that. Invalid entries are RETURNED in a `rejected` array — caller decides whether to proceed:
   ```javascript
   export function batchWriteLedger(ledgerPath, entries) {
     const accepted = [];
     const rejected = [];
     for (const entry of entries) {
       const validated = LedgerEntrySchema.safeParse(entry);
       if (!validated.success) {
         rejected.push({ entry, error: validated.error.message });
         continue;
       }
       accepted.push(validated.data);
     }
     // Only proceed with accepted entries; return rejection details
     // ... existing upsert logic using `accepted`
     return { inserted, updated, total, rejected };
   }
   ```
   Callers can inspect `rejected` and fail loudly or log. Never silently drop.

2. **lib/findings.mjs: `appendOutcome()`** — Pass through `classification` when present; no schema enforcement (JSONL is append-only, tolerant of missing fields).

3. **learning-store.mjs: `recordFindings()`** — Add nullable columns to insert payload:
   ```javascript
   const row = {
     run_id: runId,
     finding_fingerprint: f._hash || 'unknown',
     severity: f.severity,
     category: f.category,
     pass: stage,
     round_raised: round,
     // NEW: classification columns (nullable)
     sonar_type: f.classification?.sonarType ?? null,
     effort: f.classification?.effort ?? null,
     source_kind: f.classification?.sourceKind ?? null,
     source_name: f.classification?.sourceName ?? null,
   };
   ```

4. **lib/context.mjs / reporting** — Defensively access. Do NOT use a magic string; preserve null/undefined and have reporting layers handle the absent case explicitly:
   ```javascript
   // Correct pattern — downstream code checks for presence
   const classification = finding.classification; // null | undefined | ClassificationSchema
   if (classification) {
     console.log(`[${classification.sonarType}] ${finding.category}`);
   } else {
     console.log(`[unclassified] ${finding.category}`);  // Display-only label
   }
   ```
   The display label `'unclassified'` is only used for UI output, never mixed into the `sonarType` field itself.

### 2.4 Prompt Updates (Instruct LLMs to Classify)

**Modified file**: `scripts/lib/prompt-seeds.mjs`

Append a classification block to all pass prompts:

The rubric is generated at runtime from model config (no hardcoded names in prompt text):

```javascript
/**
 * Build classification rubric for a pass. sourceName comes from runtime config.
 * Prevents prompt/config drift when model versions change.
 */
export function buildClassificationRubric({ sourceKind, sourceName }) {
  return `
## Classification (REQUIRED for every finding)
For each finding, populate the \`classification\` field:

- **sonarType**: Choose ONE of:
  - BUG: Code that is demonstrably broken or will break at runtime
  - VULNERABILITY: Exploitable security flaw (OWASP Top 10 pattern)
  - CODE_SMELL: Works but harms maintainability/extensibility
  - SECURITY_HOTSPOT: Needs manual security review (uncertain if flaw)
- **effort**: Estimate fix effort:
  - TRIVIAL: < 5 minutes, mechanical change
  - EASY: < 30 minutes, single-file change
  - MEDIUM: < 2 hours, touches 2-3 files
  - MAJOR: < 1 day, multi-component change
  - CRITICAL: architectural rewrite required
- **sourceKind**: Always "${sourceKind}" for your findings
- **sourceName**: Always "${sourceName}" for your findings
`;
}
```

**Usage**:
- `openai-audit.mjs`: `buildClassificationRubric({ sourceKind: 'MODEL', sourceName: openaiConfig.model })` — reads model from config
- `gemini-review.mjs`: `buildClassificationRubric({ sourceKind: 'REVIEWER', sourceName: geminiConfig.model })`
- Claude Opus fallback: `buildClassificationRubric({ sourceKind: 'REVIEWER', sourceName: claudeConfig.model })`

Appending to pass prompts happens at prompt-build time, not at module load, so model config changes are picked up immediately.

### 2.5 Supabase Migration

**New file**: `supabase/migrations/<timestamp>_add_classification.sql`

```sql
-- Backward-compatible additive columns — existing rows remain valid with NULL
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS sonar_type TEXT;
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS effort TEXT;
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS source_kind TEXT;
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS source_name TEXT;

-- All-or-nothing atomicity: classification fields must be set together or all-null
ALTER TABLE audit_findings
  DROP CONSTRAINT IF EXISTS chk_classification_atomic;
ALTER TABLE audit_findings
  ADD CONSTRAINT chk_classification_atomic
  CHECK (
    (sonar_type IS NULL AND effort IS NULL AND source_kind IS NULL AND source_name IS NULL)
    OR
    (sonar_type IS NOT NULL AND effort IS NOT NULL AND source_kind IS NOT NULL AND source_name IS NOT NULL)
  );

-- Idempotent enum constraints via DROP + ADD pattern (ALTER doesn't support IF NOT EXISTS for constraints)
ALTER TABLE audit_findings DROP CONSTRAINT IF EXISTS chk_sonar_type;
ALTER TABLE audit_findings
  ADD CONSTRAINT chk_sonar_type
  CHECK (sonar_type IS NULL OR sonar_type IN ('BUG', 'VULNERABILITY', 'CODE_SMELL', 'SECURITY_HOTSPOT'));

ALTER TABLE audit_findings DROP CONSTRAINT IF EXISTS chk_effort;
ALTER TABLE audit_findings
  ADD CONSTRAINT chk_effort
  CHECK (effort IS NULL OR effort IN ('TRIVIAL', 'EASY', 'MEDIUM', 'MAJOR', 'CRITICAL'));

ALTER TABLE audit_findings DROP CONSTRAINT IF EXISTS chk_source_kind;
ALTER TABLE audit_findings
  ADD CONSTRAINT chk_source_kind
  CHECK (source_kind IS NULL OR source_kind IN ('MODEL', 'REVIEWER', 'LINTER', 'TYPE_CHECKER'));

-- Indexes (idempotent)
CREATE INDEX IF NOT EXISTS idx_audit_findings_sonar_type
  ON audit_findings(sonar_type) WHERE sonar_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_findings_source_kind
  ON audit_findings(source_kind) WHERE source_kind IS NOT NULL;
```

**Pre-insert column detection** (handles un-migrated deployments):

```javascript
// learning-store.mjs — detect column availability at init time
let _hasClassificationColumns = null;

async function detectClassificationColumns() {
  if (_hasClassificationColumns !== null) return _hasClassificationColumns;
  try {
    // Probe by selecting the column with LIMIT 0
    const { error } = await _supabase.from('audit_findings').select('sonar_type').limit(0);
    _hasClassificationColumns = !error;
  } catch {
    _hasClassificationColumns = false;
  }
  if (!_hasClassificationColumns) {
    process.stderr.write('  [learning] classification columns not present — run migration to enable\n');
  }
  return _hasClassificationColumns;
}

// In recordFindings(): conditionally include classification columns
const hasClassification = await detectClassificationColumns();
const row = {
  /* core fields */,
  ...(hasClassification ? {
    sonar_type: f.classification?.sonarType ?? null,
    effort: f.classification?.effort ?? null,
    source_kind: f.classification?.sourceKind ?? null,
    source_name: f.classification?.sourceName ?? null,
  } : {}),
};
```

---

## 3. File Impact Summary

| File | Changes |
|---|---|
| `scripts/lib/schemas.mjs` | Add `ClassificationSchema`, add optional `classification` field to `FindingSchema` |
| `scripts/lib/prompt-seeds.mjs` | Append `CLASSIFICATION_RUBRIC` to all pass prompts |
| `scripts/lib/ledger.mjs` | Add Zod validation in `batchWriteLedger()` (validate each entry against FindingSchema) |
| `scripts/learning-store.mjs` | `recordFindings()` adds nullable classification columns to insert payload |
| `scripts/gemini-review.mjs` | Update system prompt to instruct classification; schema auto-propagates |
| `supabase/migrations/<ts>_add_classification.sql` | **New** — additive columns + constraints |
| `tests/shared.test.mjs` | Tests for ClassificationSchema validation, FindingSchema backward compat |

---

## 4. Testing Strategy

### Unit Tests (hermetic)

| Test | What it validates |
|---|---|
| `ClassificationSchema.parse({})` fails | All sub-fields required when envelope present |
| `ClassificationSchema.parse({sonarType, effort, sourceKind, sourceName})` succeeds | Valid full envelope |
| `FindingSchema.parse(oldFinding)` succeeds | Backward compat — no classification field |
| `FindingSchema.parse(newFinding)` succeeds | Forward compat — with classification |
| `FindingSchema.parse({...oldFinding, classification: {}})` fails | Partial envelope rejected |
| `FindingSchema.parse({...oldFinding, classification: undefined})` succeeds | Explicit undefined = absent |
| `zodToGeminiSchema(FindingSchema)` generates valid JSON Schema | Gemini output contract still derivable |
| `batchWriteLedger()` rejects invalid classification | Write-boundary validation works |
| `batchWriteLedger()` accepts findings without classification | Backward compat at write boundary |

### Integration Tests (hermetic)

| Test | What it validates |
|---|---|
| GPT prompt injection contains rubric | `PASS_BACKEND_SYSTEM` includes CLASSIFICATION_RUBRIC |
| Ledger roundtrip with classification | Write then read preserves all fields |
| Ledger roundtrip without classification | Old-format entries still readable |
| `recordFindings()` with classification | Insert payload has nullable columns populated |
| `recordFindings()` without classification | Insert payload has null columns |

### Schema Migration Test (optional, gated)

| Test | What it validates |
|---|---|
| SQL migration applies cleanly | No errors on Supabase branch with existing data |
| SQL migration is idempotent | Running twice doesn't error (IF NOT EXISTS) |

---

## 5. Rollback Strategy

All changes are additive at the schema level:

- **`classification` field is optional** — existing findings without it continue to validate
- **Sub-schema is atomic** — either fully present or absent; no partial state
- **Supabase columns are nullable** — existing rows remain valid
- **Validation at write boundary only** — reads tolerate missing classification

Revert path:
1. Remove `classification` field from `FindingSchema` in `schemas.mjs`
2. Remove `CLASSIFICATION_RUBRIC` append from prompts
3. Remove classification columns from `recordFindings()` insert (Supabase columns can stay — harmless)
4. Ledger validation: existing findings without classification still pass

---

## 6. Implementation Order

1. **`schemas.mjs`** — Add `ClassificationSchema`, add optional field to `FindingSchema`
2. **Schema unit tests** — validation, backward compat, Gemini schema derivation
3. **`prompt-seeds.mjs`** — Append `CLASSIFICATION_RUBRIC` to pass prompts
4. **`ledger.mjs`** — Add validation in `batchWriteLedger()`
5. **`learning-store.mjs`** — Add classification columns to `recordFindings()` insert
6. **Supabase migration** — Write migration SQL, test on branch
7. **`gemini-review.mjs`** — Update system prompt
8. **Integration tests** — roundtrip through ledger, learning store
9. Run full `npm test` — verify no regressions

---

## 7. Out of Scope (Phase C and later)

- **LINTER and TYPE_CHECKER `sourceKind` values** — added in Phase C when tool findings land
- **Rule metadata registry** — Phase C (maps tool rule IDs to severity/sonarType)
- **Structured `location` field** — Phase C (for machine-parseable file:line:column)
- **Cross-source dedup semantics** — Phase C
- **Per-framework classification guidance** — future enhancement

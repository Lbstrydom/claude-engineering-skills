# Plan: Audit Context Brief Generator
- **Date**: 2026-03-29
- **Status**: Complete (shipped — `scripts/lib/context.mjs` (`readProjectContextForPass`, `readRepoProfile`, `generateBriefViaGemini`, `generateBriefViaClaude` with sdk/cli backend routing). The brief is injected into every audit pass; visible in logs as `[brief] Generating via claude-haiku-4-5...` / `[brief] Final brief: 3584 chars`. Status line corrected 2026-05-23.)
- **Author**: Claude + Louis

---

## 1. Context Summary

### What exists today

`readProjectContextForPass(passName)` in `shared.mjs` reads the target repo's `CLAUDE.md` and extracts sections by heading regex:

- **Per-pass extraction**: Each of the 5 code audit passes gets different sections (~1500-3000 chars each via regex)
- **Single-call modes** (plan, rebuttal, review): Get the first 4000 chars of the raw CLAUDE.md
- **Caching**: The raw CLAUDE.md content is cached in `_claudeMdCache` (read once per process)

**Problem**: For large CLAUDE.md files (wine-cellar-app = 71K / ~18K tokens), the extracted sections contain full markdown with code examples, tables, and explanations. An auditor doesn't need `How Deployment Works` or `MCP Server Configuration` — it needs:
- Dependency versions (to avoid false positives like the Zod 3 vs 4 issue)
- Key constraints (cellar_id scoping, async/await requirements, CSP compliance)
- Do/Don't rules
- Naming conventions

### Patterns we can reuse

- `_getClaudeMd()` — existing file discovery and caching
- `extractSections(patterns)` — existing regex section extraction
- The per-pass switch statement — still useful for pass-specific hints on top of the brief

### What is new

A **one-time brief generation step** at audit start that produces a compact (~1000-1500 char) context block from any repo's CLAUDE.md. This brief replaces the large raw sections in pass prompts.

---

## 2. Proposed Architecture

### Approach: Hybrid — Regex Pre-extraction + LLM Condensation

Not every repo uses the same CLAUDE.md structure. Third-party repos, monorepos, and repos with Agents.md or copilot-instructions.md all use different formats. A pure regex approach would need constant maintenance.

| Approach | Pros | Cons |
|----------|------|------|
| **Pure regex** | Zero cost, instant, deterministic | Brittle across formats, needs per-format maintenance |
| **Pure LLM** | Handles any format | Adds latency, cost, API dependency for every run |
| **Hybrid** | Best of both: deterministic where possible, LLM for the rest | Slightly more complex |

**Decision**: Hybrid. (**Principles: #16 Graceful Degradation, #3 Open/Closed**):

1. **Phase A — Regex pre-extraction** (~0ms): Pull obvious structured data (dependency tables, version numbers, stack info) deterministically. This works regardless of LLM availability.
2. **Phase B — LLM condensation** (~2-4s, one-time): Send the raw CLAUDE.md (or whatever regex didn't capture) to **Gemini Flash** with a structured prompt asking for an audit-relevant brief. Gemini Flash is ideal: fastest/cheapest model, SDK already installed, separate from the auditing models.
3. **Fallback**: If `GEMINI_API_KEY` is absent or the LLM call fails, fall back to regex-only extraction + raw truncation. Zero regression.

**LLM fallback chain**: Claude Haiku → Gemini Flash → regex-only

| Model | When | Why |
|-------|------|-----|
| **Claude Haiku** | `ANTHROPIC_API_KEY` set (primary) | Best quality — captures all constraints, scoping rules, do/don't lists comprehensively |
| **Gemini Flash** | Haiku unavailable, `GEMINI_API_KEY` set | Faster but shallower output; good enough as fallback |
| **Regex-only** | No LLM keys available | Zero-cost fallback, same quality as today |

### Data Flow

```
Audit Start
    │
    ▼
_getClaudeMd()              ← existing: read + cache raw file
    │
    ▼
generateAuditBrief()        ← NEW: two-phase extraction
    │
    ├─ Phase A (regex, ~0ms):
    │   ├─ Dependency tables → "dep@version" lines
    │   ├─ Stack/runtime line
    │   └─ Version-critical notes (e.g., "Zod 4 NOT Zod 3")
    │
    ├─ Phase B (Gemini Flash, ~2-4s, one-time):
    │   ├─ Input: raw CLAUDE.md (truncated to ~12K chars)
    │   ├─ Prompt: "Extract audit-relevant facts only"
    │   └─ Output: structured brief (constraints, rules, patterns)
    │
    └─ Merge: regex facts + LLM brief → final brief (~1000-1500 chars)
    │
    ▼
_auditBriefCache            ← NEW: cached for process lifetime
    │
    ▼
readProjectContextForPass(passName)  ← MODIFIED: returns brief + pass-specific addendum
    │
    ├─ Brief (~1000-1500 chars, same for all passes)
    └─ Pass addendum (~200-500 chars, pass-specific details)

Fallback (no GEMINI_API_KEY or LLM failure):
    Phase A regex output + raw truncation → same quality as today
```

### Key Design Decisions

| Decision | Principle | Rationale |
|----------|-----------|-----------|
| Regex, not LLM | **Graceful Degradation** (#16) | No API dependency for context preparation |
| Brief cached per process | **DRY** (#1) | Generated once, reused across 5+ passes |
| Brief + addendum pattern | **Single Source of Truth** (#10) | Common facts stated once; pass-specific hints added per pass |
| Fallback to raw truncation | **Graceful Degradation** (#16) | If patterns don't match (foreign CLAUDE.md), fall back to current behavior |
| Extraction patterns are data | **No Hardcoding** (#8) | Patterns defined as a config array, easy to extend |

---

## 3. Sustainability Notes

### Assumptions that could change
- CLAUDE.md format convention could drift → extraction patterns are data-driven, easy to update
- A future CLAUDE.md might not have a Dependencies section → fallback extracts package.json instead
- Users might want to inject custom audit context → the brief is additive, not exclusive

### Extension points
- `BRIEF_EXTRACTION_PATTERNS` array — add new patterns without modifying the extraction loop
- `generateAuditBrief()` returns a string — could be replaced with an LLM call later without changing consumers
- Pass addendum patterns can be extended independently of the brief

### What we deliberately defer
- **LLM-based summarization** — can be added as an opt-in mode later if regex proves insufficient
- **Custom audit context injection** — users could add an `.audit-context.md` override file in the future
- **package.json fallback** — reading dependency versions from package.json when CLAUDE.md lacks a Dependencies section

---

## 4. File-Level Plan

### 4.1 `scripts/shared.mjs` (MODIFY)

**Changes**:

#### New: `generateAuditBrief()` function

Two-phase extraction that produces a compact brief from any CLAUDE.md format.

```javascript
/**
 * Generate a compact audit brief from the project's CLAUDE.md.
 * Phase A: Regex extracts structured data (deps, versions).
 * Phase B: Gemini Flash condenses the rest into audit-relevant facts.
 * Cached for the process lifetime. Falls back to regex-only if no GEMINI_API_KEY.
 * @returns {Promise<string>} Compact brief (~1000-1500 chars)
 */
export async function generateAuditBrief() { ... }
```

**Phase A — Regex pre-extraction** (deterministic, ~0ms):

1. **Stack line**: First line matching `**Stack**:` or `**Runtime**:` or `**Purpose**:` → one line
2. **Dependencies**: Tables with version info → compact `dep@version` list. Also scans for version-critical notes (like "Zod 4 — NOT Zod 3")
3. **package.json fallback**: If no deps found in CLAUDE.md, read `package.json` dependencies

**Phase B — LLM condensation** (Gemini Flash, ~2-4s, one-time):

Input: Raw CLAUDE.md (truncated to ~12K chars to fit Flash context comfortably)
Prompt: Structured extraction request for audit-relevant facts only:
- Coding constraints and rules (async patterns, scoping, auth requirements)
- Do / Do NOT rules
- Key architectural patterns the auditor must respect
- Naming conventions (compact)
- Testing requirements

Output: ~800-1000 chars of structured facts. Merged with Phase A results.

**Fallback**: If `GEMINI_API_KEY` is absent, Gemini call fails, or total brief is <200 chars, fall back to `content.slice(0, 1500)` — current behavior, zero regression.

#### New: `initAuditBrief()` function

Must be called once at audit start (in `main()`) before any passes run. Generates and caches the brief so `readProjectContextForPass()` stays synchronous.

```javascript
/**
 * Pre-generate the audit brief. Call once at startup.
 * After this, readProjectContextForPass() returns the cached brief synchronously.
 * @returns {Promise<string>} The generated brief
 */
export async function initAuditBrief() { ... }
```

#### Modified: `readProjectContextForPass(passName)`

Replace the current switch-case with brief + addendum. Stays synchronous (brief is pre-cached by `initAuditBrief()`):

```javascript
export function readProjectContextForPass(passName) {
  const brief = _auditBriefCache ?? _fallbackContext();
  if (!brief || brief.startsWith('(No CLAUDE.md')) return brief;

  // Pass-specific addendum — additional detail for this specific pass
  const addendum = _getPassAddendum(passName);

  return addendum
    ? `${brief}\n\n### Pass-Specific Context\n${addendum}`
    : brief;
}
```

#### New: `_getPassAddendum(passName)` (private)

Extracts a small (~200-500 char) pass-specific addendum from the raw CLAUDE.md. Uses the same section-matching patterns as today's switch-case, but truncated more aggressively since the brief already covers the fundamentals.

```javascript
const PASS_ADDENDUM_PATTERNS = {
  structure: ['Code Organisation'],
  wiring: ['API Design'],
  backend: ['Data Integrity', 'Multi-User', 'PostgreSQL'],
  frontend: ['Frontend Patterns', 'Content Security Policy'],
  sustainability: ['Testing'],
  plan: [],    // Brief is sufficient
  rebuttal: [], // Brief is sufficient
  review: []   // Brief is sufficient
};
```

#### Modified: `readProjectContext()`

For single-call modes (plan, rebuttal, review), return the brief instead of raw 4000 chars:

```javascript
export function readProjectContext() {
  return generateAuditBrief() || '(No CLAUDE.md found — auditing without project context)';
}
```

**Why this file**: These functions already live here. No new files needed — this is a refinement, not a new module. (**Principle: #2 SRP** — the context-loading responsibility stays in one place.)

### 4.2 `scripts/openai-audit.mjs` (MINOR CHANGE)

Add `await initAuditBrief()` call in `main()` before the audit runs. One line change:

```javascript
// In main(), after reading plan and creating OpenAI client:
await initAuditBrief();  // NEW — pre-generate context brief
```

All other context consumption stays the same — `readProjectContextForPass()` remains synchronous.

### 4.3 `scripts/gemini-review.mjs` (MINOR CHANGE)

Same — add `await initAuditBrief()` in `main()` before the review call. `readProjectContext()` will then return the cached brief.

### 4.4 `CLAUDE.md` (NO CHANGES)

The audit-loop's own CLAUDE.md is already compact (3.8K). The brief generator will handle it fine — it'll extract the Dependencies table and the Do NOT section, producing an even tighter brief.

---

## 5. Risk & Trade-off Register

| Risk | Mitigation |
|------|------------|
| Gemini Flash unavailable or slow | Fallback to regex-only + raw truncation. Brief generation is best-effort. |
| LLM halluccinates constraints that aren't in CLAUDE.md | Phase A regex facts (deps, versions) are deterministic and prepended first. LLM only adds to them. |
| Brief drops a critical constraint | Pass addendum still extracts full pass-specific sections (smaller, but present) |
| Brief becomes stale mid-audit if CLAUDE.md changes | CLAUDE.md is read once at start — same as today. Acceptable for a single audit run. |
| Gemini Flash adds ~2-4s startup latency | One-time cost at audit start, amortized across 5+ passes. Net savings: fewer tokens per pass = faster GPT responses. |
| GEMINI_API_KEY not set but OPENAI_API_KEY is | Graceful: regex-only brief, no crash. Log a note to stderr. |

### Trade-offs made

1. **Hybrid over pure regex** — regex alone breaks on non-standard CLAUDE.md formats. LLM handles any format. Regex provides deterministic dep/version facts as a trust anchor.
2. **Gemini Flash over Haiku/GPT-mini** — avoids adding SDK deps, reuses existing key, different model family from auditors.
3. **Brief + addendum** over **brief only** — pass-specific context is still useful for backend (multi-user queries) and frontend (CSP compliance).
4. **Pre-generation in main()** — keeps `readProjectContextForPass()` synchronous. Callers don't need to change to async.

### Deliberately deferred

- **Custom .audit-context.md** — user override file, useful but premature
- **Brief quality scoring** — could validate LLM output against regex facts for consistency
- **Multi-file context** — some repos have CLAUDE.md + multiple sub-CLAUDE.md files; handle later

---

## 6. Testing Strategy

### Manual testing

1. **Wine-cellar-app** (71K CLAUDE.md): Run `initAuditBrief()` and verify it captures: stack, Zod version, cellar_id constraint, async/await requirement, CSP rule, Do/Don't rules
2. **claude-audit-loop** (3.8K CLAUDE.md): Verify brief captures: Zod 4 API notes, ESM requirement, Do NOT rules
3. **Repo with no CLAUDE.md**: Verify graceful `(No CLAUDE.md found)` return
4. **Repo with minimal CLAUDE.md**: Verify fallback to regex-only when LLM adds little value
5. **No GEMINI_API_KEY**: Verify graceful fallback to regex-only + raw truncation
6. **Gemini Flash timeout/error**: Verify graceful degradation with stderr warning

### Key edge cases

- CLAUDE.md with no standard sections (foreign repo) → LLM handles any format
- Dependencies in inline format (`**Zod**: 4.0.0`) vs table format (`| zod | 4.0.0 |`) → regex handles both
- Very large CLAUDE.md (>100K) → truncate to 12K chars before sending to Flash
- CLAUDE.md with only code blocks and no prose → LLM extracts what it can, regex provides deps
- Gemini Flash returns empty or irrelevant brief → fall back to regex + raw truncation

### Token savings estimate

| Repo | Current per-pass | With brief | Saving |
|------|-----------------|------------|--------|
| wine-cellar-app (71K) | ~750 tokens | ~350 tokens | 53% |
| claude-audit-loop (3.8K) | ~500 tokens | ~300 tokens | 40% |
| Per full audit (5 passes) | ~3750 tokens | ~1750 tokens | ~2000 tokens saved |

Over a 4-round audit: **~8000 input tokens saved** across passes, plus:
- **Fewer false positives** from irrelevant context confusing the auditor
- **Better signal** — auditors see exactly what matters (versions, constraints, rules)
- **Any-format support** — works on repos with non-standard CLAUDE.md/Agents.md

### Cost of LLM condensation

- Gemini Flash: ~12K input + ~500 output = ~$0.001 per audit run (negligible)
- Latency: ~2-4s one-time at startup (amortized across all passes)

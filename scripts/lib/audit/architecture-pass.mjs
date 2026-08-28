/**
 * @fileoverview Architecture-intent audit pass (Wave 1.5) — mechanical
 * detector → LLM bouncer → deterministic fallback.
 *
 * Extracted from `legacy-production-audit.mjs` (docs/plans/legacy-production-audit-decomposition.md
 * Phase 3) — a pure relocation, verbatim bodies, no behaviour change. Lands
 * next to `detector.mjs`... actually the mechanical detector for this pass is
 * `../arch-intent/adapter-contract.mjs`'s `runArchIntentAnalysis`, which this
 * file imports — matching the plan's "extract by existing dependency" rule.
 *
 * @module scripts/lib/audit/architecture-pass
 */

import fs from 'node:fs';
import path from 'node:path';
import { FindingSchema, ArchIntentPassSchema } from '../schemas.mjs';
import { normalizePath } from '../file-io.mjs';
import { computePassLimits } from '../robustness.mjs';
import { buildCachePrompt, safeCallGPT } from './llm-helpers.mjs';
import { runArchIntentAnalysis, isArchIntentReportClean, deriveArchState } from '../arch-intent/adapter-contract.mjs';
import { loadArchIntentConfig } from '../arch-intent/load-config.mjs';
import { parseIntentDoc } from '../arch-intent/intent-doc-parser.mjs';
import { ArchIntentConfigError } from '../arch-intent/errors.mjs';
import { detectRepoStack } from '../repo-stack.mjs';

// Architecture-intent system prompt — the LLM-bouncer rubric.  See
// docs/plans/architecture-intent-framework.md §9.  Static (never
// varies across rounds) so safe to be in `system` prompt for cache-stability.
const PASS_ARCH_INTENT_SYSTEM = `You are auditing PR diffs against the repo's declared architectural intent. The mechanical analyser has already flagged candidate violations — your job is to classify SEVERITY and filter false positives.

You receive:
1. The repo's architecture-intent.md (the hand-curated C4 + rationale).
2. A list of mechanical violations: { fromFile, toFile, fromDomain, toDomain, ruleViolated }.
3. Unmapped files (in repo, not in any domain rule).
4. Dead intent (domains declared but with no files).

Output: findings list. Use:
- HIGH: cross-cutting violation, breaks a critical invariant (e.g., audit-orchestration → learning-store when not allowed creates a circular dep between core subsystems).
- MEDIUM: boundary erosion in a non-critical edge, OR a recurring pattern that suggests the boundary is wrong (consider proposing an allowedDeps update INSTEAD of a fix).
- LOW: isolated, easily-fixed cases (one file in the wrong domain; one stray import).

When recommending a fix, prefer "move the file to the right domain" or "extract the cross-cutting concern into a shared module" over "add the dep to allowedDeps". Adding to allowedDeps is admitting the intent doc was wrong — sometimes that's right, but say so explicitly.

DO NOT raise findings for:
- Same-domain edges (always allowed by definition).
- Edges to \`vendor\` (external deps — different policy layer).
- Unmapped files in test/ or docs/ (heuristic — only flag src/ + scripts/).

DO raise findings for:
- deadIntent (domain declared but no files) — possible stale intent.
- unmappedFiles in src/ or scripts/ — gap in domain-map.

GROUNDING — READ THIS. Every edge finding you emit MUST correspond to a file in
the mechanical violations or unmapped list above. The mechanical analyser has
ALREADY resolved every domain and checked every import against allowedDeps; an
edge it did NOT flag is ALLOWED, and you must not re-raise it. Do NOT reason
from the intent diagram to "notice" a questionable-looking edge and flag it —
the diagram is context for SEVERITY, not an invitation to re-derive the graph.
Set each finding's \`section\` to the exact flagged file it concerns. A finding
whose file is not in the lists above will be dropped as ungrounded.

Severity floor: any mechanical violation defaults to MEDIUM unless you can justify HIGH or LOW with concrete reasoning.`;

/**
 * Architecture-intent audit pass (Wave 1.5).
 *
 * Runs the two-phase analysis (inventory + per-stack edge analysis), then
 * either short-circuits on clean OR sends violations to the LLM bouncer.
 * Falls back to deterministic severity rubric if the LLM call fails.
 *
 * @returns {Promise<{ state: string, result: object }>}
 */
export async function runArchitecturePass({ openai, repoRoot, focusBlock, planContent, historyBlock, ledgerFile, impactSet, isR2Plus }) {
  const emptyResult = {
    result: { pass_name: 'architecture', findings: [], summary: 'pass not run' },
    usage: { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 },
    latencyMs: 0,
  };

  const intentPath = path.join(repoRoot, 'docs/architecture-intent.md');
  const domainMapPath = path.join(repoRoot, '.audit-loop/domain-map.json');

  if (!fs.existsSync(intentPath)) {
    return { state: 'SKIPPED_NO_INTENT', result: emptyResult, archReport: null };
  }
  if (!fs.existsSync(domainMapPath)) {
    return { state: 'SKIPPED_MISSING_DOMAIN_MAP', result: emptyResult, archReport: null };
  }

  let domainMap;
  try {
    domainMap = loadArchIntentConfig(repoRoot);
  } catch (err) {
    if (err instanceof ArchIntentConfigError) {
      // audit-orchestrator-hardening H8 (hardening-implementation audit
      // round 1): Phase 5 routed deriveFindingsFromReport's 4 violation
      // loops through full FindingSchema.parse(...), but this EARLY-RETURN
      // branch constructs its finding inline, bypassing deriveFindingsFromReport
      // entirely — the same "hand-built deterministic finding" class Phase 5
      // exists to fix, just a second call site it didn't cover. Adds the
      // required `id`/`risk` fields and routes through FindingSchema.parse
      // for full consistency with Phase 5's canonical path.
      return {
        state: 'ERROR_INVALID_CONFIG',
        result: {
          result: {
            pass_name: 'architecture',
            findings: [FindingSchema.parse({
              id: 'A0',
              severity: 'HIGH',
              category: '[Architecture] Invalid domain-map.json',
              detail: err.message,
              risk: 'Architecture checks cannot run at all until this config is fixed — cross-domain boundary violations elsewhere in the repo go undetected in the meantime.',
              recommendation: 'Fix the config file at .audit-loop/domain-map.json. See docs/plans/architecture-intent-framework.md §2 decision 5.',
              section: '.audit-loop/domain-map.json',
              affectedFiles: ['.audit-loop/domain-map.json'],
              affectedPrinciples: ['#5 SSoT'],
              is_quick_fix: false,
              is_mechanical: false,
              is_reopened: false,   // mechanical wave — never reopens a prior ruling
              principle: '#5 SSoT',
            })],
            summary: 'Architecture pass aborted — config invalid',
          },
          usage: emptyResult.usage,
          latencyMs: 0,
        },
        archReport: null,
      };
    }
    throw err;
  }

  if (domainMap.allowedDeps === null) {
    return { state: 'SKIPPED_NO_BASELINE', result: emptyResult, archReport: null };
  }

  const intent = parseIntentDoc(intentPath);
  const { stackKinds } = detectRepoStack(repoRoot);

  if (stackKinds.length === 0) {
    return { state: 'SKIPPED_UNSUPPORTED_STACK', result: emptyResult, archReport: null };
  }

  const report = await runArchIntentAnalysis({ repoPath: repoRoot, stackKinds, domainMap });
  const derivedState = deriveArchState(report);

  // Stderr summary so operators see the mechanical findings even when LLM
  // doesn't fire (clean) or fails (fallback).
  process.stderr.write(`  [architecture] mechanical: ${report.violations.length} violations, ${report.unmappedFiles.length} unmapped, ${report.deadIntent.length} dead, ${report.perStackResults.length} stacks\n`);

  if (isArchIntentReportClean(report)) {
    return {
      state: 'ANALYZED_CLEAN',
      archReport: report,
      result: {
        result: { pass_name: 'architecture', findings: [], summary: 'Architecture intent clean' },
        usage: emptyResult.usage,
        latencyMs: 0,
      },
    };
  }

  // Build prompt + call LLM bouncer for severity classification
  const violationsForPrompt = formatViolationsForPrompt(report, intent);
  const archLimits = computePassLimits(violationsForPrompt.length + 4000, 'medium');
  const llmCall = await safeCallGPT(openai, {
    ...buildCachePrompt({
      rubric: PASS_ARCH_INTENT_SYSTEM,
      focusBlock,
      passName: 'architecture',
      planContent,
      ledgerFile: isR2Plus ? ledgerFile : null,
      impactSet,
      isR2Plus,
      historyBlock,
      codeHeader: '## Intent + Mechanical Violations',
      code: violationsForPrompt,
    }),
    schema: ArchIntentPassSchema,
    schemaName: 'architecture_pass',
    reasoning: 'medium',
    ...archLimits,
    passName: 'architecture',
  }, { pass_name: 'architecture', findings: [], summary: 'LLM call failed; falling back to deterministic rubric' });

  if (llmCall.failed) {
    // Deterministic fallback (decision 11): emit findings from mechanical
    // report using simplified rubric (no HIGH in fallback mode).
    return {
      state: derivedState === 'ANALYZED_PARTIAL' ? 'ANALYZED_PARTIAL' : 'ANALYZED_FALLBACK_DETERMINISTIC',
      archReport: report,
      result: {
        ...llmCall,
        result: {
          pass_name: 'architecture',
          findings: deriveFindingsFromReport(report),
          summary: `LLM bouncer failed (${llmCall.error}); ${report.violations.length} mechanical findings emitted with simplified rubric`,
        },
      },
    };
  }

  // Ground the bouncer's findings to the mechanical report — drop any it
  // hallucinated from the intent diagram about edges the mechanical layer
  // never flagged (2026-07-20). Only touches the LLM success path; the
  // deterministic fallback above is mechanical and already grounded.
  const grounded = groundArchFindingsToReport(llmCall.result?.findings ?? [], report);
  if (grounded.dropped.length > 0) {
    process.stderr.write(`  [architecture] dropped ${grounded.dropped.length} ungrounded bouncer finding(s) (file not in mechanical report)\n`);
  }
  return {
    state: derivedState,
    archReport: report,
    result: { ...llmCall, result: { ...llmCall.result, findings: grounded.kept } },
  };
}

/**
 * Ground the LLM bouncer's findings to what the MECHANICAL analyser actually
 * flagged — "the bouncer only judges what it's handed."
 *
 * Why (2026-07-20): the bouncer is handed the full architecture-intent mermaid
 * diagram plus the mechanical violations, and the LLM reasons from the DIAGRAM
 * to "notice" edges that look questionable — re-raising imports the mechanical
 * layer already checked against allowedDeps and CLEARED. Reproduced: a run
 * whose only mechanical violation was `stores → plan` emitted 16 findings
 * claiming `brainstorm → requirements` violates a boundary. That edge is
 * EXPLICITLY in allowedDeps["brainstorm"] — the mechanical detector correctly
 * never flagged it; the bouncer invented it from the diagram. These recur on
 * every audit (the arch pass scans the whole repo, not the diff) and were the
 * dominant driver of the memory-health cluster-density trigger.
 *
 * The bouncer's schema carries no structured edge, but every finding carries a
 * `section` (its file). A legitimate bouncer finding classifies a mechanical
 * violation, so its file is one the mechanical layer flagged. A finding whose
 * file is NOT in {violation fromFile/toFile} ∪ {unmapped files} is ungrounded
 * and dropped. A finding with no file-like section is KEPT (conservative — a
 * domain-level dead-intent finding legitimately names no file, and we do not
 * drop what we cannot disprove).
 *
 * Pure. @returns {{kept: object[], dropped: object[]}}
 */
export function groundArchFindingsToReport(findings, report) {
  if (!Array.isArray(findings) || findings.length === 0) return { kept: findings ?? [], dropped: [] };
  const flagged = new Set();
  for (const v of report?.violations ?? []) {
    if (v.fromFile) flagged.add(normalizePath(v.fromFile));
    if (v.toFile) flagged.add(normalizePath(v.toFile));
  }
  for (const u of report?.unmappedFiles ?? []) {
    if (typeof u === 'string') flagged.add(normalizePath(u));
  }
  // A section is "file-like" if it carries a path separator or a file
  // extension. `section` may be `path` or `path:symbol`/`path:line` — take the
  // part before the first colon (after any Windows drive letter).
  const fileOf = (f) => {
    const raw = f?._primaryFile || f?.section;
    if (typeof raw !== 'string' || !raw) return null;
    // Skip a leading Windows drive letter (e.g. "C:") before splitting off a
    // trailing ":symbol"/":line" suffix, so the drive letter's own colon
    // isn't mistaken for that suffix separator (39a73f09 — the prior
    // sentinel-based approach also embedded literal NUL bytes in the source).
    const driveMatch = raw.match(/^[A-Za-z]:/);
    const rest = driveMatch ? raw.slice(driveMatch[0].length) : raw;
    const stripped = (driveMatch ? driveMatch[0] : '') + rest.split(':')[0];
    return /[\\/]|\.[A-Za-z0-9]+$/.test(stripped) ? normalizePath(stripped) : null;
  };
  const kept = [], dropped = [];
  for (const f of findings) {
    const file = fileOf(f);
    if (file === null || flagged.has(file)) kept.push(f);
    else dropped.push(f);
  }
  return { kept, dropped };
}

/**
 * Format a mechanical report into the prompt body for the LLM bouncer.
 * Aggregates by (fromDomain, toDomain, ruleViolated) when >20 violations
 * to stay within token budget (decision 16).
 */
function formatViolationsForPrompt(report, intent) {
  const lines = [];
  if (intent.mermaid) {
    lines.push('## Intended boundaries (from architecture-intent.md)');
    lines.push('```mermaid');
    lines.push(intent.mermaid);
    lines.push('```');
    lines.push('');
  }
  lines.push(`## Mechanical Violations (${report.violations.length} total)`);
  if (report.violations.length > 20) {
    // Aggregate by (fromDomain, toDomain, ruleViolated)
    const clusters = new Map();
    for (const v of report.violations) {
      const key = `${v.fromDomain} → ${v.toDomain} (${v.ruleViolated})`;
      if (!clusters.has(key)) clusters.set(key, []);
      clusters.get(key).push(v);
    }
    for (const [key, vs] of clusters) {
      lines.push(`- **${key}**: ${vs.length} edges`);
      for (const v of vs.slice(0, 3)) {
        lines.push(`  - ${v.fromFile} → ${v.toFile}`);
      }
      if (vs.length > 3) lines.push(`  - ... and ${vs.length - 3} more`);
    }
  } else {
    for (const v of report.violations) {
      lines.push(`- ${v.fromDomain} → ${v.toDomain}: ${v.fromFile} → ${v.toFile}`);
    }
  }
  if (report.unmappedFiles.length > 0) {
    lines.push('');
    lines.push(`## Unmapped Files (${report.unmappedFiles.length})`);
    for (const f of report.unmappedFiles.slice(0, 30)) lines.push(`- ${f}`);
    if (report.unmappedFiles.length > 30) lines.push(`- ... and ${report.unmappedFiles.length - 30} more`);
  }
  if (report.deadIntent.length > 0) {
    lines.push('');
    lines.push(`## Dead Intent (${report.deadIntent.length})`);
    for (const d of report.deadIntent) lines.push(`- ${d}`);
  }
  if (report.perStackResults.some(r => r.status === 'error')) {
    lines.push('');
    lines.push('## Per-stack Analyzer Failures');
    for (const r of report.perStackResults.filter(r => r.status === 'error')) {
      lines.push(`- ${r.stackKind}: ${r.error?.message}`);
    }
  }
  return lines.join('\n');
}

/**
 * Deterministic fallback rubric (decision 11). Used when the LLM bouncer
 * fails — emits findings from the mechanical report alone. No HIGH severity
 * (cross-cutting detection requires LLM judgement).
 *
 * Phase 5 (audit-orchestrator-hardening, audit-plan fix H3): `FindingBase`
 * (schemas.mjs) requires `id`/`severity`/`category`/`section`/`detail`/
 * `risk`/`recommendation`/`is_quick_fix`/`is_mechanical`/`principle` — ALL
 * non-optional. This function previously omitted `id` and `risk` on every
 * branch (every other field was already present). Both are added here and
 * every emitted finding is routed through `FindingSchema.parse(...)` —
 * `id` is a new `A`-prefixed monotonic sequence (mirrors the `T`-prefixed
 * tool-finding convention: `H`/`M`/`L` = model-assigned, `T` = tool,
 * `A` = architecture-deterministic); `risk` is one deterministic sentence
 * per violation TYPE (the four loops below are four structurally distinct
 * violation classes, not four instances of one class).
 */
export function deriveFindingsFromReport(report) {
  const findings = [];
  let archIdCounter = 0;
  const nextId = () => `A${++archIdCounter}`;
  for (const v of report.violations) {
    findings.push(FindingSchema.parse({
      id: nextId(),
      severity: 'MEDIUM',
      category: '[Architecture] Forbidden cross-domain edge',
      detail: `${v.fromFile} (${v.fromDomain}) imports ${v.toFile} (${v.toDomain}); not in allowedDeps[${v.fromDomain}].`,
      risk: "Violates the plan's stated domain boundary — changes in one domain can now silently break the other.",
      recommendation: `Either move one of the files to align with allowed deps OR explicitly update allowedDeps in .audit-loop/domain-map.json with rationale in architecture-intent.md.`,
      section: v.fromFile,
      affectedFiles: [v.fromFile, v.toFile],
      affectedPrinciples: ['#5 SSoT'],
      is_quick_fix: false,
      is_mechanical: true,
      is_reopened: false,   // mechanical wave — never reopens a prior ruling
      principle: '#5 SSoT',
    }));
  }
  for (const f of report.unmappedFiles) {
    if (!f.startsWith('src/') && !f.startsWith('scripts/')) continue; // heuristic
    findings.push(FindingSchema.parse({
      id: nextId(),
      severity: 'LOW',
      category: '[Architecture] File missing domain rule',
      detail: `${f} is not matched by any rule in .audit-loop/domain-map.json.`,
      risk: "This file's dependencies are unevaluated by the architecture gate until a rule exists for it.",
      recommendation: 'Add a rule for this path so its dependencies can be evaluated.',
      section: f,
      affectedFiles: [f],
      affectedPrinciples: ['#5 SSoT'],
      is_quick_fix: true,
      is_mechanical: true,
      is_reopened: false,   // mechanical wave — never reopens a prior ruling
      principle: '#5 SSoT',
    }));
  }
  for (const d of report.deadIntent) {
    findings.push(FindingSchema.parse({
      id: nextId(),
      severity: 'LOW',
      category: '[Architecture] Dead declared domain',
      detail: `Domain "${d}" is declared in domain-map.json but no files match.`,
      risk: 'A stale domain entry misleads future domain-boundary decisions.',
      recommendation: 'Either remove the unused domain from the spec, or add files that will live in it.',
      section: '.audit-loop/domain-map.json',
      affectedFiles: ['.audit-loop/domain-map.json'],
      affectedPrinciples: ['#5 SSoT'],
      is_quick_fix: true,
      is_mechanical: true,
      is_reopened: false,   // mechanical wave — never reopens a prior ruling
      principle: '#5 SSoT',
    }));
  }
  for (const r of report.perStackResults.filter(r => r.status === 'error')) {
    findings.push(FindingSchema.parse({
      id: nextId(),
      severity: 'MEDIUM',
      category: `[Architecture] Stack analyzer failure (${r.stackKind})`,
      detail: r.error?.message ?? 'unknown error',
      risk: 'The architecture check silently produced no signal for this stack — a real violation could be passing undetected.',
      recommendation: `Check that the ${r.stackKind} adapter dependencies are installed and the repo is in a parsable state.`,
      section: r.stackKind,
      affectedFiles: [],
      affectedPrinciples: ['#15 Error Handling'],
      is_quick_fix: false,
      is_mechanical: true,
      is_reopened: false,   // mechanical wave — never reopens a prior ruling
      principle: '#15 Error Handling',
    }));
  }
  return findings;
}

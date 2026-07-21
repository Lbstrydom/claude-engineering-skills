/**
 * @fileoverview Zod schema + the shared `validateGateContract` policy for
 * `skills/<name>/gate-contract.json` (plan §F2.3). One policy, THREE callers
 * (loader.mjs, the gate-honesty test suite, scripts/check-gate-contracts.mjs)
 * — no drift between what each caller accepts (R3-H2).
 *
 * Design constraints this file enforces (do not relax without re-reading the
 * plan's Decision record + audit trail):
 *   - `kind: "document-only"` gates may carry ONLY {id, kind, reason,
 *     statedIn?, stated?} — an oracle/implementation/params/tests/proof on a
 *     document-only gate is the fake-check bug class this suite exists to
 *     catch, so the schema itself refuses it (never a runtime warning).
 *   - `statedIn` is a CLOSED enum per contract: exactly the owning skill's
 *     own SKILL.md, or AGENTS.md. No other path is legal — a different
 *     skill's SKILL.md, an arbitrary docs path, traversal, or a symlink
 *     escape are all schema-invalid, not merely "unusual".
 *   - executable gates are a discriminated union keyed by `oracle` — each
 *     oracle declares its own required extra field (params / fixture /
 *     scenario) and rejects fields belonging to a different oracle.
 *
 * @module scripts/lib/gate-honesty/schema
 */

import path from 'node:path';
import { z } from 'zod';
import { resolveAndClassify } from '../sensitive-paths.mjs';

/** Closed v1 oracle registry (unknown id = a schema-validation divergence). */
export const ORACLE_IDS = Object.freeze([
  'convergence-threshold',
  'tiered-shadow-window',
  'visual-gate-unverified',
  'cli-exit',
]);

/** Closed v1 cli-exit scenario registry (§F2.3 — right-sized to what's contracted). */
export const CLI_EXIT_SCENARIOS = Object.freeze([
  'visual-static-gate-refusal',
  'ctx-drift-clean',
  'ctx-drift-high',
]);

const ProofSchema = z.enum(['process', 'unit-seam']);

const CommonExecutableFields = {
  id: z.string().min(1),
  kind: z.literal('executable'),
  statedIn: z.string().min(1),
  stated: z.string().min(1),
  implementation: z.string().min(1),
  tests: z.array(z.string().min(1)).min(1),
  proof: ProofSchema,
};

const ConvergenceThresholdParams = z.object({
  high: z.number().int().nonnegative(),
  medium: z.number().int().nonnegative(),
  quickFix: z.number().int().nonnegative(),
}).strict();

const TieredShadowRow = z.object({
  legacyOk: z.boolean(),
  shadowOk: z.boolean(),
  // The `.strict()` comparison previously permitted ONLY `tieredRunStatus`, but
  // the tieredShadowWindow oracle (oracles.mjs) reads `tieredEligibleCount` /
  // `legacyEligibleCount` to decide a decision-grade comparison. So a fixture
  // row that carried those fields — the exact case the oracle exists to
  // evaluate — was REJECTED by this schema, leaving the eligibility branch
  // untestable (audit M2, flagged by GPT ×2 and Gemini). Optional because the
  // existing fallback_legacy fixtures omit them; numbers to match the oracle's
  // `typeof === 'number'` guard.
  comparison: z.object({
    tieredRunStatus: z.enum(['complete', 'fallback_legacy']),
    tieredEligibleCount: z.number().optional(),
    legacyEligibleCount: z.number().optional(),
  }).strict().nullable(),
}).strict();

const ExecutableGateSchema = z.discriminatedUnion('oracle', [
  z.object({ ...CommonExecutableFields, oracle: z.literal('convergence-threshold'), params: ConvergenceThresholdParams }).strict(),
  z.object({ ...CommonExecutableFields, oracle: z.literal('tiered-shadow-window'), fixture: z.object({ rows: z.array(TieredShadowRow).min(1) }).strict() }).strict(),
  z.object({ ...CommonExecutableFields, oracle: z.literal('visual-gate-unverified') }).strict(),
  z.object({ ...CommonExecutableFields, oracle: z.literal('cli-exit'), scenario: z.enum(CLI_EXIT_SCENARIOS) }).strict(),
]);

const DocumentOnlyGateSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('document-only'),
  reason: z.string().min(1),
  // Optional, unvalidated-for-containment metadata — a human pointer to
  // where the judgement call is discussed. Never checked against disk;
  // that would imply a mechanical binding that doesn't exist (fake-check).
  statedIn: z.string().min(1).optional(),
  stated: z.string().min(1).optional(),
}).strict();

const GateSchema = z.discriminatedUnion('kind', [ExecutableGateSchema, DocumentOnlyGateSchema]);

// The `not-a-gate` disposition store (gate-contract-authoring.md D6, Gemini G1).
// A candidate line the coverage check greps but which is NOT an enforcement
// claim is recorded HERE, in the contract — never in a plan document. Each
// carries the exact line and why it is not a gate, so the coverage check reads
// only Zod-validated contract data.
const IgnoredCandidateSchema = z.object({
  line: z.string().min(1),
  reason: z.string().min(1),
}).strict();

export const GateContractSchema = z.object({
  version: z.literal(1),
  // A skill name is a directory-name IDENTIFIER, never a path fragment (audit
  // M1). Without this grammar a `skill` of `../../evil` interpolates into the
  // `skills/${skill}/SKILL.md` approved-source string and could make
  // isApprovedStatedInSource accept a traversal target. realpath containment is
  // a second layer, but the identifier grammar closes it at the root. Every
  // real skill name (audit-code, ai-context-management, …) already matches.
  skill: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'skill must be a kebab-case identifier, not a path'),
  // `.min(1)` is GONE — an empty `gates` is legal as an explicit "this skill has
  // no gates" declaration, but ONLY paired with a top-level `reason` (below).
  gates: z.array(GateSchema),
  // Present ONLY on an empty-gates declaration (D4). The superRefine enforces
  // the biconditional so a real contract cannot carry a hand-wave and a no-gate
  // skill cannot stay silent.
  reason: z.string().min(1).optional(),
  ignoredCandidates: z.array(IgnoredCandidateSchema).optional(),
}).strict().superRefine((c, ctx) => {
  if (c.gates.length === 0 && c.reason === undefined) {
    ctx.addIssue({
      code: 'custom', path: ['reason'],
      message: 'a contract with no gates must carry a non-empty top-level "reason" — silence is what the ratchet exists to remove',
    });
  }
  if (c.gates.length > 0 && c.reason !== undefined) {
    ctx.addIssue({
      code: 'custom', path: ['reason'],
      message: 'top-level "reason" is only for an empty-gates declaration; a contract WITH gates must not carry one (a real gate cannot hide behind a hand-wave)',
    });
  }
});

/**
 * Closed source-authority policy (R3-H2 — the ONE shared check consumed by
 * the loader, the suite, and check-gate-contracts.mjs). `statedIn` is legal
 * ONLY as exactly `skills/<contractSkill>/SKILL.md` or exactly `AGENTS.md`.
 *
 * @param {string} statedIn — as declared in the contract
 * @param {string} contractSkill — the contract's own `skill` field
 * @returns {boolean}
 */
export function isApprovedStatedInSource(statedIn, contractSkill) {
  const norm = String(statedIn).replace(/\\/g, '/');
  return norm === `skills/${contractSkill}/SKILL.md` || norm === 'AGENTS.md';
}

/**
 * Repo-root-contained + realpath-resolved existence check (INC-001 rule —
 * fail-closed on any resolution error, never "couldn't check so allow").
 *
 * @param {string} relPath
 * @param {string} repoRoot
 * @returns {{ok: boolean, reason?: string}}
 */
export function resolveContainedPath(relPath, repoRoot) {
  const verdict = resolveAndClassify(relPath, { repoRoot });
  if (verdict.escapedRepo) return { ok: false, reason: 'escapes-repo' };
  if (verdict.resolutionFailed) return { ok: false, reason: 'unresolvable' };
  return { ok: true };
}

/**
 * Validate ONE parsed contract object end-to-end: schema shape, the
 * statedIn source-authority policy, and (for executable gates) that
 * `implementation` + every `tests[]` entry resolve to a real, contained
 * path. Returns a structured result — never throws on a bad contract
 * (a malformed contract is data to report, not a crash).
 *
 * @param {unknown} raw — parsed JSON
 * @param {string} repoRoot
 * @returns {{ok: true, contract: object} | {ok: false, errors: string[]}}
 */
export function validateGateContract(raw, repoRoot) {
  const parsed = GateContractSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const contract = parsed.data;
  const errors = [];
  const seenIds = new Set();

  for (const gate of contract.gates) {
    if (seenIds.has(gate.id)) errors.push(`duplicate gate id: ${gate.id}`);
    seenIds.add(gate.id);

    if (gate.kind !== 'executable') continue;

    if (!isApprovedStatedInSource(gate.statedIn, contract.skill)) {
      errors.push(`[${contract.skill}][${gate.id}] statedIn "${gate.statedIn}" is not an approved source (must be skills/${contract.skill}/SKILL.md or AGENTS.md)`);
      continue;
    }

    const implCheck = resolveContainedPath(gate.implementation, repoRoot);
    if (!implCheck.ok) {
      errors.push(`[${contract.skill}][${gate.id}] implementation path invalid (${implCheck.reason}): ${gate.implementation}`);
    } else if (!existsFile(path.resolve(repoRoot, gate.implementation))) {
      errors.push(`[${contract.skill}][${gate.id}] implementation file does not exist: ${gate.implementation}`);
    }

    for (const t of gate.tests) {
      const testCheck = resolveContainedPath(t, repoRoot);
      if (!testCheck.ok) {
        errors.push(`[${contract.skill}][${gate.id}] tests[] path invalid (${testCheck.reason}): ${t}`);
        continue;
      }
      const abs = path.resolve(repoRoot, t);
      if (!existsFile(abs)) {
        errors.push(`[${contract.skill}][${gate.id}] tests[] file does not exist: ${t}`);
        continue;
      }
      if (!fileTextReferencesId(abs, gate.id)) {
        errors.push(`[${contract.skill}][${gate.id}] tests[] file "${t}" does not reference gate id "${gate.id}" — a contract cannot claim a test that doesn't know about it`);
      }
    }

    const statedAbs = path.resolve(repoRoot, gate.statedIn);
    if (!existsFile(statedAbs)) {
      errors.push(`[${contract.skill}][${gate.id}] statedIn file does not exist: ${gate.statedIn}`);
    } else if (!fileTextContains(statedAbs, gate.stated)) {
      errors.push(`[${contract.skill}][${gate.id}] stated "${gate.stated}" (${gate.statedIn}); not found verbatim — prose/contract have drifted`);
    }
  }

  return errors.length === 0 ? { ok: true, contract } : { ok: false, errors };
}

// ── small fs helpers, isolated for a single import surface ────────────────
import fs from 'node:fs';

function existsFile(abs) {
  try { return fs.statSync(abs).isFile(); } catch { return false; }
}

function fileTextContains(abs, needle) {
  try { return fs.readFileSync(abs, 'utf-8').includes(needle); } catch { return false; }
}

function fileTextReferencesId(abs, id) {
  try { return fs.readFileSync(abs, 'utf-8').includes(id); } catch { return false; }
}

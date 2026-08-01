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
  'poison-pill',
]);

/** Closed v1 cli-exit scenario registry (§F2.3 — right-sized to what's contracted). */
export const CLI_EXIT_SCENARIOS = Object.freeze([
  'visual-static-gate-refusal',
  'ctx-drift-clean',
  'ctx-drift-high',
  'brainstorm-argv-error',
  'nav-invalid-contract',
  'nav-bootstrap-refuse-clobber',
  'persona-fatal-rig-no-manifest',
  'uxlock-strict-selector-violation',
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
    // Eligible-row cardinalities: non-negative integers (audit M4). Optional
    // because the fallback_legacy fixtures omit them, but they MUST be a pair —
    // both present or both absent (audit H3, escalated from M4). A half-
    // specified row is meaningless (the oracle's typeof-number guard would
    // silently drop it from the decision-grade comparison), so it is a schema
    // error, not a tolerated shape.
    tieredEligibleCount: z.number().int().nonnegative().optional(),
    legacyEligibleCount: z.number().int().nonnegative().optional(),
  }).strict().refine(
    (c) => (c.tieredEligibleCount === undefined) === (c.legacyEligibleCount === undefined),
    { message: 'tieredEligibleCount and legacyEligibleCount must be specified as a pair — both or neither' },
  ).nullable(),
}).strict();

/**
 * A `poison-pill` gate's proof: the gate must REJECT a deliberately broken copy of the
 * artifact it guards, and accept the pristine one.
 *
 * `isolation` is a one-value enum rather than a free string because the alternative that
 * was considered — redirecting a single path argument — says nothing about where else the
 * gate writes. Outputs must be isolated, not just inputs, so the only legal answer is a
 * temp copy. A gate that cannot be run that way is exempt with a reason, never
 * `isolation: "none"`.
 *
 * The tamper is `overlay` (a committed snapshot lands at a destination) and/or `mutate`
 * (one JSON field of the live artifact is changed in place). At least one is required: a
 * pill with nothing to tamper with hands the gate a pristine artifact and reports a pass.
 * `expectStderr` is required for the same reason `expectExit` alone is not enough — a
 * non-zero exit cannot distinguish "detected the tampering" from "crashed before reading
 * anything".
 */
const PoisonPillSchema = z.object({
  isolation: z.literal('tmpdir'),
  argv: z.array(z.string().min(1)).min(1),
  overlay: z.record(z.string().min(1), z.string().min(1)).optional(),
  mutate: z.record(z.string().min(1), z.object({
    path: z.string().min(1),
    value: z.unknown(),
  }).strict()).optional(),
  expectExit: z.number().int().optional(),
  expectStderr: z.string().min(1),
  why: z.string().min(1),
  needsGit: z.boolean().optional(),
}).strict().refine(
  (p) => Object.keys(p.overlay ?? {}).length + Object.keys(p.mutate ?? {}).length > 0,
  { message: 'a poison pill needs an overlay or a mutate — otherwise the gate is handed a pristine artifact and "passes" having detected nothing' },
);

const ExecutableGateSchema = z.discriminatedUnion('oracle', [
  z.object({ ...CommonExecutableFields, oracle: z.literal('convergence-threshold'), params: ConvergenceThresholdParams }).strict(),
  z.object({ ...CommonExecutableFields, oracle: z.literal('tiered-shadow-window'), fixture: z.object({ rows: z.array(TieredShadowRow).min(1) }).strict() }).strict(),
  z.object({ ...CommonExecutableFields, oracle: z.literal('visual-gate-unverified') }).strict(),
  z.object({ ...CommonExecutableFields, oracle: z.literal('cli-exit'), scenario: z.enum(CLI_EXIT_SCENARIOS) }).strict(),
  z.object({ ...CommonExecutableFields, oracle: z.literal('poison-pill'), poisonPill: PoisonPillSchema }).strict(),
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

// The ratchet baseline (Phase D). `exemptions` is empty in the release state —
// every skill is contracted — and each entry, when present, is a DECLARED
// exception with a reason (a deferred skill), never a silent gap. `skill` is a
// kebab-case identifier (a listSkillNames root); the checker additionally
// verifies the root still exists and is not also contracted (§7b).
export const GateContractBaselineSchema = z.object({
  version: z.literal(1),
  exemptions: z.array(z.object({
    skill: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'skill must be a kebab-case identifier'),
    reason: z.string().min(1),
  }).strict()),
}).strict();

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
  const errors = validateGates(contract.gates, {
    owner: contract.skill,
    approvedStatedIn: `skills/${contract.skill}/SKILL.md or AGENTS.md`,
    isApproved: (s) => isApprovedStatedInSource(s, contract.skill),
    repoRoot,
  });
  return errors.length === 0 ? { ok: true, contract } : { ok: false, errors };
}

/**
 * The per-gate checks, shared verbatim by skill contracts and CLI-gate contracts.
 *
 * Extracted rather than copied (plan §2 dec. 3): the rejected design was a second registry
 * with its own checker "extending" this protocol in name only, which is how the first one
 * rots. One loop means a rule added here — a new path containment check, a new drift test —
 * cannot apply to half the contracts, which is this plan's own defect class.
 */
function validateGates(gates, { owner, approvedStatedIn, isApproved, repoRoot }) {
  const errors = [];
  const seenIds = new Set();

  for (const gate of gates) {
    if (seenIds.has(gate.id)) errors.push(`duplicate gate id: ${gate.id}`);
    seenIds.add(gate.id);

    if (gate.kind !== 'executable') continue;

    if (!isApproved(gate.statedIn)) {
      errors.push(`[${owner}][${gate.id}] statedIn "${gate.statedIn}" is not an approved source (must be ${approvedStatedIn})`);
      continue;
    }

    const implCheck = resolveContainedPath(gate.implementation, repoRoot);
    if (!implCheck.ok) {
      errors.push(`[${owner}][${gate.id}] implementation path invalid (${implCheck.reason}): ${gate.implementation}`);
    } else if (!existsFile(path.resolve(repoRoot, gate.implementation))) {
      errors.push(`[${owner}][${gate.id}] implementation file does not exist: ${gate.implementation}`);
    }

    for (const t of gate.tests) {
      const testCheck = resolveContainedPath(t, repoRoot);
      if (!testCheck.ok) {
        errors.push(`[${owner}][${gate.id}] tests[] path invalid (${testCheck.reason}): ${t}`);
        continue;
      }
      const abs = path.resolve(repoRoot, t);
      if (!existsFile(abs)) {
        errors.push(`[${owner}][${gate.id}] tests[] file does not exist: ${t}`);
        continue;
      }
      if (!fileTextReferencesId(abs, gate.id)) {
        errors.push(`[${owner}][${gate.id}] tests[] file "${t}" does not reference gate id "${gate.id}" — a contract cannot claim a test that doesn't know about it`);
      }
    }

    const statedAbs = path.resolve(repoRoot, gate.statedIn);
    if (!existsFile(statedAbs)) {
      errors.push(`[${owner}][${gate.id}] statedIn file does not exist: ${gate.statedIn}`);
    } else if (!fileTextContains(statedAbs, gate.stated)) {
      errors.push(`[${owner}][${gate.id}] stated "${gate.stated}" (${gate.statedIn}); not found verbatim — prose/contract have drifted`);
    }
  }

  return errors;
}

/**
 * A CLI gate's contract — `scripts/gate-contracts/<gate>.json`.
 *
 * Same file layout idea as `skills/<name>/gate-contract.json` (contract beside its
 * subject), same `id`/`statedIn`/`stated`/`implementation`/`tests`/`proof` vocabulary, and
 * the SAME validator. The only differences are structural rather than stylistic: the owner
 * is an npm script name (`skills:check`) rather than a kebab-case skill directory, and
 * because no SKILL.md owns it, the single approved source for its claim is `AGENTS.md`.
 */
export const CliGateContractSchema = z.object({
  version: z.literal(1),
  // npm script names carry a colon; the grammar stays an identifier (no slashes, no dots,
  // no traversal) for the same reason `skill` does — it is interpolated into messages and
  // must never be a path fragment.
  gate: z.string().regex(/^[a-z0-9]+([:-][a-z0-9]+)*$/, 'gate must be an npm script identifier, not a path'),
  guards: z.string().min(1),
  gates: z.array(GateSchema).min(1),
  ignoredCandidates: z.array(IgnoredCandidateSchema).optional(),
}).strict();

/** @returns {{ok: true, contract: object} | {ok: false, errors: string[]}} */
export function validateCliGateContract(raw, repoRoot) {
  const parsed = CliGateContractSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const contract = parsed.data;
  const errors = validateGates(contract.gates, {
    owner: contract.gate,
    approvedStatedIn: 'AGENTS.md',
    isApproved: (s) => String(s).replace(/\\/g, '/') === 'AGENTS.md',
    repoRoot,
  });
  return errors.length === 0 ? { ok: true, contract } : { ok: false, errors };
}

// ── small fs helpers, isolated for a single import surface ────────────────
import fs from 'node:fs';

function existsFile(abs) {
  try { return fs.statSync(abs).isFile(); } catch { return false; }
}

/**
 * Normalise line endings before any verbatim text comparison.
 *
 * A `stated` quote is authored in JSON, so its newlines are always `\n`. The
 * prose file it is checked against is read from the WORKING COPY, which on
 * Windows carries CRLF even though `.gitattributes` pins `eol=lf` — git calls
 * such a file clean, so the drift is invisible. Comparing raw bytes therefore
 * failed every multi-line `stated` quote on a Windows checkout while passing in
 * CI, reporting "prose/contract have drifted" against text that matches exactly.
 *
 * Same class as the `skills.manifest.json` CRLF defect recorded in AGENTS.md:
 * anything that hashes or compares file bytes against a committed artifact must
 * canonicalise CRLF→LF first. Both sides are normalised so a contract authored
 * with literal CRLF cannot reintroduce the asymmetry.
 */
function normaliseEol(text) {
  return text.replace(/\r\n/g, '\n');
}

function fileTextContains(abs, needle) {
  try {
    return normaliseEol(fs.readFileSync(abs, 'utf-8')).includes(normaliseEol(needle));
  } catch { return false; }
}

function fileTextReferencesId(abs, id) {
  try { return normaliseEol(fs.readFileSync(abs, 'utf-8')).includes(normaliseEol(id)); } catch { return false; }
}

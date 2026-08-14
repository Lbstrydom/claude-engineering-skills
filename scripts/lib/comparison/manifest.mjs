/**
 * @fileoverview `ComparisonManifestSchema` — the declarative arm-set format,
 * shared by the passive campaign and the synchronous swap-eval.
 *
 * This module exists because the schema was load-bearing and owned by nobody:
 * it decides role, arm identity, incumbent, controls, subject paths and the
 * adjudicator-not-supported refusal, while `arms.mjs` held only an arm and
 * `controls.mjs` only the dials. A composite contract with no home is how two
 * variants appear.
 *
 * TWO PROPERTIES, both from measured failures:
 *
 *  - **Strict everywhere.** A dial belonging to another role, or a typo'd key,
 *    is a load-time refusal — never a silently ignored field that runs at a
 *    provider default (`reasoningEfort`).
 *  - **Every path-bearing field is DECLARED and typed as a resolved handle.**
 *    A resolver with no declared inputs is the INC-001 shape again: the
 *    classifier existed that time too, and one call site simply saw the
 *    pre-resolution string. `resolveManifestPaths` is the only way to turn the
 *    declared strings into readable handles.
 *
 * Plan: docs/plans/role-agnostic-comparison-core.md D4, §Security Considerations.
 *
 * @module scripts/lib/comparison/manifest
 */

import { z } from 'zod';
import { ROLES } from './roles.mjs';
import { ArmSchema, checkArmSetSemantics } from './arms.mjs';
import { controlsSchemaForRole } from './controls.mjs';
import { resolveLocalPath } from './paths.mjs';

/** Manifest ids become path components, same reason as arm ids. */
export const MANIFEST_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The path-bearing fields, declared explicitly so `paths.mjs` has something to
 * govern and no consumer has to guess which strings are paths.
 *
 * Runtime cited-source paths are deliberately NOT here: they arrive from MODEL
 * OUTPUT, not from this file, and are resolved per-finding with `resolveGitPath`
 * at the revision the finding was collected against.
 */
export const SUBJECT_PATH_FIELDS = Object.freeze(['corpusPath', 'diffPath', 'transcriptDir']);

const SubjectSchema = z.object({
  corpusPath: z.string().min(1).optional(),
  diffPath: z.string().min(1).optional(),
  transcriptDir: z.string().min(1).optional(),
}).strict();

/**
 * Build the manifest schema for one role. Role-parameterised rather than one
 * union, so the error message names the role's own dials instead of a merged
 * set nobody declared.
 *
 * @param {string} role
 */
export function manifestSchemaForRole(role) {
  return z.object({
    schemaVersion: z.literal(1),
    id: z.string().regex(MANIFEST_ID_PATTERN, 'manifest id must match ^[a-z0-9][a-z0-9-]{0,63}$ — it is interpolated into receipt paths'),
    role: z.literal(role),
    decision: z.object({
      type: z.literal('select_default'),
      incumbent: z.string().min(1),
    }).strict(),
    arms: z.array(ArmSchema).min(1),
    controls: controlsSchemaForRole(role),
    subject: SubjectSchema.optional(),
  }).strict().superRefine(manifestSemanticRules);
}

/** Rules structural strictness cannot express — the same shape as the
 * campaign's, kept here so both mechanisms enforce them identically. */
function manifestSemanticRules(cfg, ctx) {
  // Delegates to the shared oracle in arms.mjs. This function used to carry
  // its own copy of the same four rules, which is how the campaign and the
  // manifest drift apart — the control arm type landed in one of them
  // first, and only a mechanical check found the other.
  checkArmSetSemantics(cfg, (message, cursor) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, ...(cursor ? { path: cursor } : {}) }));
}

/**
 * Parse a manifest object.
 *
 * The role is read BEFORE schema selection, so an unsupported role produces the
 * controls module's explanatory refusal rather than a generic "invalid literal"
 * from a union — the `adjudicator` case must say *why* it is not supported.
 *
 * @param {unknown} raw
 * @returns {{manifest: object}}
 */
export function parseComparisonManifest(raw) {
  const role = raw && typeof raw === 'object' ? raw.role : undefined;
  if (typeof role !== 'string' || !ROLES.includes(role)) {
    throw new Error(
      `[comparison/manifest] role must be one of ${ROLES.join(', ')} — got ${JSON.stringify(role)}`,
    );
  }
  // Throws the explanatory message for a role in the vocabulary that has no
  // declarative-manifest support yet (adjudicator).
  const schema = manifestSchemaForRole(role);
  return { manifest: schema.parse(raw) };
}

/**
 * Resolve every declared subject path into a handle. Refuses at LOAD, before
 * any provider call, so a typo or a sensitive target costs nothing.
 *
 * @param {object} manifest
 * @param {{repoRoot: string}} opts
 * @returns {Record<string, import('./paths.mjs').PathHandle>}
 */
export function resolveManifestPaths(manifest, { repoRoot } = {}) {
  const out = {};
  const subject = manifest?.subject ?? {};
  for (const field of SUBJECT_PATH_FIELDS) {
    const value = subject[field];
    if (value === undefined) continue;
    out[field] = resolveLocalPath(value, { repoRoot });
  }
  return out;
}

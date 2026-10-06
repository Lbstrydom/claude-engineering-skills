/**
 * @fileoverview Shared /fleet execution contracts — the ONE definition of values
 * that config, registry, overlap and git-facts must agree on: merge methods,
 * the tier schema, the commit-oid shape and segment-aware path containment.
 *
 * Dependency-neutral on purpose: imports only `zod` and node builtins, so every
 * other fleet module can depend on it without creating a cycle.
 *
 * @module scripts/lib/fleet/contracts
 */
import path from 'node:path';
import { z } from 'zod';

export const MERGE_METHODS = Object.freeze(['pr', 'direct-squash', 'direct-merge']);
export const TIER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A full git object id: exactly 40 (sha1) or 64 (sha256) lowercase hex chars. */
export const OID_PATTERN = '(?:[0-9a-f]{40}|[0-9a-f]{64})';
export const OID_RE = new RegExp(`^${OID_PATTERN}$`);
export const isOid = (s) => typeof s === 'string' && OID_RE.test(s);

const IS_WIN = process.platform === 'win32';
const fold = (p) => (IS_WIN ? path.resolve(p).toLowerCase() : path.resolve(p));

/**
 * Is `child` equal to or inside `parent`? Segment-aware: the relative path is
 * OUTSIDE only when it is exactly `..`, starts with `..` + separator, or is
 * absolute (a different drive). A child named `..fleet` is INSIDE.
 * @param {string} child
 * @param {string} parent
 * @param {{strict?: boolean}} [opts] - `strict` excludes `child === parent`
 */
export function isInside(child, parent, { strict = false } = {}) {
  const rel = path.relative(fold(parent), fold(child));
  if (rel === '') return !strict;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

const NON_BLANK = (s) => s.trim() !== '';

/** argv array; when non-empty its first element (the executable) must be non-blank. */
export const argvSchema = ({ min = 0 } = {}) => z.array(z.string(), { error: 'must be an argv array of strings (a shell string is a config error)' })
  .min(min)
  .refine((a) => a.length === 0 || NON_BLANK(a[0]), 'the executable (first element) must be a non-empty, non-whitespace string');

export const TierSchema = z.strictObject({
  name: z.string().regex(TIER_NAME_RE, 'must match [a-z0-9][a-z0-9_-]*'),
  command: argvSchema({ min: 1 }),
  stage: z.enum(['pre-land', 'post-merge']).default('pre-land'),
  timeoutMs: z.number().int().positive().optional(),
  shell: z.boolean().optional(),
});

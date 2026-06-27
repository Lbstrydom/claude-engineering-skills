/**
 * @fileoverview Author-tier OBSERVATION builder (observation-only — no routing).
 *
 * Per docs/completed/model-tier-observation.md. Produces a `recordDecision` payload
 * that captures, per audit run: aggregates-only scope signals × the heuristic
 * suggested logical tier × the (hinted) declared author tier + ladder partition
 * key × the audit-difficulty outcome (rounds, converged). It NEVER changes
 * execution; a future, data-gated routing phase consumes these rows via replay.
 *
 * Privacy: raw file paths are consumed in `deriveSignals` and discarded — only
 * aggregates (counts/flags/buckets) leave this module, so telemetry can't leak
 * a path/secret (egress invariant).
 *
 * @module scripts/lib/learning/author-tier-observation
 */

import { z } from 'zod';
import { LOGICAL_TIERS, tierForModel, describeModel } from '../model-resolver.mjs';
import { classifyPath } from '../sensitive-paths.mjs';

// Tunable thresholds — one place to adjust the heuristic.
const MANY_FILES = 5;          // > this → frontier
const ECONOMY_MAX_FILES = 2;   // mechanical-only AND <= this → economy
const DIFF_BUCKETS = [
  { name: 'xs', max: 10 },
  { name: 's',  max: 50 },
  { name: 'm',  max: 200 },
  { name: 'l',  max: Infinity },
];

// Mechanical = docs / config / test-only paths (NOT a classifyPath category, so
// defined locally). Conservative: any non-matching path makes the set non-mechanical.
const MECHANICAL_RE = /(^|\/)(docs?)\/|\.(md|mdx|txt|json|ya?ml|toml|ini|cfg|conf)$|(^|\/)__tests__\/|\.(test|spec)\.[mc]?[jt]sx?$/i;

// Doc/test-ONLY subset — used to exclude paths from the SECURITY floor. A doc or
// test ABOUT auth is not a security change; but a security CONFIG file
// (`config/auth.yaml`, `oauth.json`) IS — so config is deliberately NOT in this
// set (audit R4: don't let the binary mechanical exclusion swallow security
// config). Right-sized: a doc/test-vs-rest split, not a full path taxonomy — the
// signal is observation-only and the §11 `author-tier:` override is the escape hatch.
const DOC_TEST_RE = /(^|\/)(docs?)\/|\.(md|mdx|txt)$|(^|\/)__tests__\/|\.(test|spec)\.[mc]?[jt]sx?$/i;

// Security-RELEVANT source paths. `classifyPath` flags secret FILES (.env etc.)
// that must never reach an LLM; it does NOT flag security-relevant SOURCE code.
// The frontier floor (plan intent) wants both — so add a source-path pattern for
// auth/security/crypto/payment/session code. (Concurrency stays out — not
// path-detectable; it's the §11 override case.)
//
// Security-relevant SOURCE path matcher. Case-SENSITIVE (no `/i`) on purpose: a
// case-fold boundary can't distinguish a camelCase word break from a longer word
// (under `/i`, `[A-Z]` also matches lowercase, so `author.ts` would over-match).
// So we enumerate the two real forms in a JS/TS tree and use a case-TRANSITION
// boundary (a security word ends at a separator, an UpperCase letter, a digit, or
// end-of-string):
//   • lowercase form — `auth_service`, `user-auth.ts`, `oauth2.ts`, `authGuard.ts`
//   • Capitalized (camelCase/PascalCase) form — `useAuth.ts`, `LoginForm.tsx`,
//     `getAuthToken.ts` (Gemini consolidated-gate finding: JS/TS casing was missed).
// `author.ts` / `authority.ts` correctly DON'T match (keyword followed by a
// lowercase letter = part of a longer word). The over-match half (a doc/test
// ABOUT auth) is handled at the call site (DOC_TEST_RE exclusion).
// Longer morphological variants (authentication/authorization/…) are listed
// BEFORE bare `auth` so alternation prefers the whole word — `authentication.ts`
// matches, while `author.ts`/`authority.ts` still don't (the `auth` branch's
// case-transition boundary excludes a trailing lowercase letter). Gemini
// consolidated-gate finding: these full words are common security source files.
const SECURITY_PATH_RE = /(^|[/_.\-])(authentication|authenticator|authorization|authorize|unauthorized|auth|authn|authz|security|crypto|payments?|billing|session|permissions?|oauth|jwt|login|password)([/._\-]|[A-Z]|\d|$)|(^|[/_.\-]|[a-z])(Authentication|Authenticator|Authorization|Authorize|Unauthorized|Auth|Authn|Authz|Security|Crypto|Payments?|Billing|Session|Permissions?|OAuth|JWT|Jwt|Login|Password)([/._\-]|[A-Z]|\d|$)/;

function diffBucket(diffLines) {
  const n = Number.isFinite(diffLines) ? diffLines : 0;
  return DIFF_BUCKETS.find((b) => n < b.max)?.name ?? 'l';
}

/**
 * Reduce raw run data to an AGGREGATES-ONLY signal object. Raw `changedFiles`
 * are consumed here and never returned (egress invariant).
 *
 * @param {{ changedFiles?: string[], domains?: string[], diffLines?: number }} input
 * @returns {{ fileCount:number, domainTags:string[], crossDomain:boolean,
 *             floorTouch:boolean, mechanicalOnly:boolean, diffBucket:string }}
 */
// Domain tags are short, LOWERCASE slugs from the committed domain-map (the
// wired caller passes `computeTargetDomains(...).domains`, a closed taxonomy).
// This is a SHAPE+CASE filter, not a semantic allowlist: anything with a
// separator, whitespace, uppercase, or over-length is dropped. Lowercase-only is
// load-bearing — it rejects the realistic refactor hazard of an UPPER_SNAKE
// env-var name (`OPENAI_API_KEY`, `AWS_SECRET_ACCESS_KEY`) being passed as a
// domain (audit Cluster-A R3 egress finding). A lowercase token-shaped secret
// from an UNTRUSTED source is out of scope (the source is the committed map); if
// `domains` is ever fed untrusted input, add a domain-map allowlist here.
// Same pattern is enforced again in the Zod schema (single source of truth).
const DOMAIN_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export function deriveSignals({ changedFiles = [], domains = [], diffLines = 0 } = {}) {
  const files = Array.isArray(changedFiles) ? changedFiles.filter((f) => typeof f === 'string') : [];
  const tags = Array.isArray(domains)
    ? [...new Set(domains.filter((d) => typeof d === 'string' && DOMAIN_SLUG_RE.test(d)))].slice(0, 20)
    : [];

  // floorTouch: any sensitive path OR a DB migration — the "always-hard" set
  // that's reliably path-detectable. (Concurrency is NOT path-detectable and is
  // deliberately left to the optional §11 author-tier override.)
  const floorTouch = files.some(
    (f) => classifyPath(f) === 'sensitive'                 // secret files (.env, keys…)
      || /(^|\/)supabase\/migrations\//i.test(f)           // DB migrations
      // security source OR security config — excluding ONLY docs/tests about
      // auth (docs/auth.md, auth.test.js). Security config (config/auth.yaml,
      // oauth.json) still floors (audit Cluster-A R3 over-match + R4 config gap).
      || (!DOC_TEST_RE.test(f) && SECURITY_PATH_RE.test(f)),
  );
  // mechanicalOnly: every changed path is docs/config/test-only.
  const mechanicalOnly = files.length > 0 && files.every((f) => MECHANICAL_RE.test(f));

  return {
    fileCount: files.length,
    domainTags: tags,
    crossDomain: tags.length > 1,
    floorTouch,
    mechanicalOnly,
    diffBucket: diffBucket(diffLines),
  };
}

/**
 * Read-only heuristic: scope signals → suggested logical tier. Explicit
 * precedence (floors first). Recorded for comparison; NEVER acted on here.
 * @returns {'economy'|'standard'|'frontier'}
 */
export function suggestTier(signals = {}) {
  if (signals.floorTouch) return 'frontier';
  if (signals.fileCount > MANY_FILES || signals.crossDomain || signals.diffBucket === 'l') return 'frontier';
  if (signals.mechanicalOnly && signals.fileCount <= ECONOMY_MAX_FILES) return 'economy';
  return 'standard';
}

/**
 * Normalise an author-tier hint to a logical tier. The hint may be a logical
 * tier already (the §11 `author-tier:` form) or a concrete/sentinel model id.
 * Total: returns 'unknown' for anything unrecognised (tierForModel is the
 * fallback and itself returns 'unknown').
 */
export function normalizeTierHint(hint) {
  if (typeof hint !== 'string' || !hint) return 'unknown';
  if (LOGICAL_TIERS.includes(hint)) return hint;
  return tierForModel(hint);
}

// Boundary schema (Zod) — validated before the row is handed to recordDecision.
const TierEnum = z.enum(['economy', 'standard', 'frontier', 'unknown']);
export const AuthorTierObservationSchema = z.object({
  decisionType: z.literal('author_tier'),
  // Audit-BOUND key (auditRunId + round + sequence) — mirrors `convergence_predict`.
  // openai-audit runs once PER ROUND, so a per-run `externalId` would (a) not know
  // the final outcome at emit and (b) collapse under ON CONFLICT DO NOTHING to
  // round 1. Per-round rows carry each round's `converged`; the run-level
  // rounds-to-converge derives at read/replay (max round / first converged).
  auditRunId: z.string().min(1),
  round: z.number().int().positive(),
  sequence: z.number().int().nonnegative(),
  repoId: z.string().nullable().optional(),
  context: z.object({
    round: z.number().int().positive(),
    fileCount: z.number().int().nonnegative(),
    // slug-only + bounded — defence-in-depth against path/secret egress via domains.
    // Single source of truth: the same DOMAIN_SLUG_RE deriveSignals filters with.
    domainTags: z.array(z.string().regex(DOMAIN_SLUG_RE)).max(20),
    crossDomain: z.boolean(),
    floorTouch: z.boolean(),
    mechanicalOnly: z.boolean(),
    diffBucket: z.enum(['xs', 's', 'm', 'l']),
    declaredTierSource: z.enum(['provided', 'unknown']),
    authorModel: z.string().nullable(),
    authorProvider: z.string().nullable(),
    authorFamily: z.string().nullable(),
  }),
  choice: z.object({ suggestedTier: TierEnum, declaredTier: TierEnum }),
  outcome: z.object({ converged: z.boolean() }),
});

/**
 * Build the `recordDecision` INPUT envelope for one audit ROUND. The caller passes
 * it straight to `recordDecision(...)`, which DERIVES the decision_key from
 * (auditRunId, round, sequence) → `<runId>:author_tier:r<round>:s0`. Throws on
 * schema-invalid input (caller catches + logs+skips; never blocks an audit).
 *
 * @param {{ runId:string, round:number, signals:object, converged:boolean,
 *           authorTierHint?:string|null, repoId?:string|null }} input
 */
export function buildAuthorTierObservation({ runId, round, signals, converged, authorTierHint = null, repoId = null }) {
  // Guard before use: a bad runId/round would poison the derived decision_key.
  if (typeof runId !== 'string' || runId.trim() === '') {
    throw new TypeError('buildAuthorTierObservation: runId must be a non-empty string');
  }
  if (!Number.isInteger(round) || round < 1) {
    throw new TypeError('buildAuthorTierObservation: round must be a positive integer');
  }
  if (!signals || typeof signals !== 'object') {
    // Guard before dereferencing signals.* — a malformed signals object would
    // otherwise read undefined props and fail later in Zod with an opaque error
    // (audit R4 boundary finding). Callers pass deriveSignals() output.
    throw new TypeError('buildAuthorTierObservation: signals must be an object (deriveSignals output)');
  }
  const declaredTier = normalizeTierHint(authorTierHint);
  const declaredTierSource = declaredTier === 'unknown' ? 'unknown' : 'provided';
  // Ladder partition key — only when the hint is a concrete/sentinel model id.
  const d = authorTierHint ? describeModel(authorTierHint) : null;

  const envelope = {
    decisionType: 'author_tier',
    auditRunId: runId,
    round,
    sequence: 0,
    repoId: repoId ?? null,
    context: {
      round,
      fileCount: signals.fileCount,
      domainTags: signals.domainTags,
      crossDomain: signals.crossDomain,
      floorTouch: signals.floorTouch,
      mechanicalOnly: signals.mechanicalOnly,
      diffBucket: signals.diffBucket,
      declaredTierSource,
      authorModel: d?.concreteModel ?? null,
      authorProvider: d?.provider ?? null,
      authorFamily: d?.family ?? null,
    },
    choice: { suggestedTier: suggestTier(signals), declaredTier },
    outcome: { converged: !!converged },
  };

  AuthorTierObservationSchema.parse(envelope); // throws on invalid → caller logs+skips
  return envelope;
}

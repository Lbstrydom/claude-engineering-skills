/**
 * @fileoverview The committed decision registry `.harness-retro/decisions.json`
 * (plan docs/plans/harness-retro.md §2 component 12).
 *
 * A decision lands IN THE FIX PR, reviewed with the fix and its test — so it
 * carries no commit sha (a commit cannot name itself). Activation is DERIVED
 * after merge from a landing-time source ({@link activationFor}). The registry
 * is PUBLIC: `summary` is human-written and must carry no path, email or secret.
 *
 * Every mutation takes the registry's OWN lock (`decisions.json.lock`) and
 * rewrites atomically, so two processes from different accounts (different
 * memory dirs) still serialise.
 *
 * @module scripts/lib/friction/retro/registry
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../../file-io.mjs';
import { withFileLock } from '../../file-lock.mjs';
import { preWriteSecretGate } from '../../security/secret-classifier.mjs';
import { normaliseSignalText } from './fingerprint.mjs';

export const REGISTRY_REL = path.join('.harness-retro', 'decisions.json');
export const LAYERS = Object.freeze(['hook', 'gate', 'script', 'reference-doc', 'agents-md']);
export const FP_RE = /^[0-9a-f]{16}$/;
export const IDENTITY_RE = /^(?:fingerprint:[0-9a-f]{16}|tripwire:[A-Za-z0-9_.-]+)$/;
/** The runner collects `tests/*.test.mjs` (scripts/run-tests.mjs DEFAULT_DIRS). */
const COLLECTED_TEST_RE = /^tests\/(?:claudemd\/|install\/)?[^/]+\.test\.mjs$/;

export const DecisionSchema = z.object({
  identity: z.string().regex(IDENTITY_RE),
  evidenceFingerprints: z.array(z.string().regex(FP_RE)).min(1),
  fingerprintVersion: z.number().int().positive(),
  kind: z.string().min(1),
  tool: z.string(),
  decision: z.enum(['enforced', 'rejected']),
  layer: z.enum(LAYERS).optional(),
  test: z.string().optional(),
  summary: z.string().min(10).max(300),
  memory: z.string().regex(/^[A-Za-z0-9_.-]+$/).optional(),
  decidedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
}).strict().superRefine((d, ctx) => {
  if (d.decision === 'enforced' && (!d.layer || !d.test)) {
    ctx.addIssue({ code: 'custom', message: 'an enforced decision names its layer and its test' });
  }
  if (d.identity.startsWith('fingerprint:') && d.evidenceFingerprints[0] !== d.identity.slice('fingerprint:'.length)) {
    ctx.addIssue({ code: 'custom', message: 'a fingerprint identity is its own first evidence fingerprint' });
  }
});

export const RegistrySchema = z.object({
  version: z.literal(1),
  decisions: z.array(DecisionSchema),
}).strict();

const EMPTY = Object.freeze({ version: 1, decisions: [] });

/** Read + validate. A missing file is the empty registry; a malformed one THROWS (never silently empty). */
export function readRegistry(repoRoot) {
  const p = path.join(repoRoot, REGISTRY_REL);
  if (!fs.existsSync(p)) return { version: 1, decisions: [] };
  return RegistrySchema.parse(JSON.parse(fs.readFileSync(p, 'utf8')));
}

/** identity → decision, plus every evidence fingerprint → its decision (ranking suppression). */
export function decisionIndex(registry) {
  const byIdentity = new Map();
  const byFingerprint = new Map();
  for (const d of registry.decisions) {
    byIdentity.set(d.identity, d);
    for (const fp of d.evidenceFingerprints) byFingerprint.set(fp, d);
  }
  return { byIdentity, byFingerprint };
}

/**
 * Summary is public: refuse anything path-, email- or secret-shaped. Uses the
 * SAME normaliser that cleans fingerprint labels, so the two policies cannot
 * drift (cluster-A audit R2-H3: a hand list of roots let /srv/... through).
 */
export function summaryProblems(summary) {
  const s = String(summary ?? '');
  const norm = normaliseSignalText(s);
  const out = [];
  if (norm.includes('<path>')) out.push('summary contains an absolute path');
  if (norm.includes('<email>')) out.push('summary contains an email address');
  if (!preWriteSecretGate(s).ok) out.push('summary contains a secret shape');
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const EXECUTABLE_TEST_RE = /\b(?:it|test)\s*\(\s*['"`]/;

/** Replace every string literal's CONTENT with nothing, keeping its quotes (`'abc'` → `''`). */
export function blankStringContents(src) {
  let out = ''; let quote = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) { out += c; quote = null; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    out += c;
  }
  return out;
}

/**
 * Remove `//` line comments and `/* *\/` block comments, leaving string
 * literals intact (a small scanner, not a parser: enough to stop a comment from
 * satisfying the positive-control check).
 */
export function stripComments(src) {
  let out = ''; let i = 0; let quote = null;
  while (i < src.length) {
    const c = src[i]; const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const end = src.indexOf('*/', i + 2); i = end === -1 ? src.length : end + 2; continue; }
    out += c; i++;
  }
  return out;
}

/**
 * Does `test` qualify as the positive control for `identity`? It must be a file
 * `npm test` collects, contain at least one executable `it(`/`test(` case, and
 * name the identity inside a STRING LITERAL — a comment-only mention does not
 * count (audit M3/M8): the literal is what an assertion or a case title carries.
 * @returns {string[]} problems (empty = qualifies)
 */
export function testPathProblems({ test, identity, repoRoot }) {
  const rel = String(test ?? '').replace(/\\/g, '/');
  if (!COLLECTED_TEST_RE.test(rel)) return [`test ${rel || '(none)'} is not a tests/*.test.mjs file that npm test collects`];
  let body = '';
  try { body = fs.readFileSync(path.join(repoRoot, rel), 'utf8'); } catch (err) {
    return [err?.code === 'ENOENT' ? `test ${rel} does not exist` : `test ${rel} is unreadable (${err?.code})`];
  }
  // Comments are stripped first: a commented-out `it('<fp>')` is neither an
  // executable case nor a literal an assertion carries (cluster-A audit R2-H5).
  body = stripComments(body);
  const problems = [];
  // The executable-case check runs on CODE ONLY (string contents blanked), so a
  // fixture string like "it('x')" is not mistaken for a case (audit R3-M2).
  if (!EXECUTABLE_TEST_RE.test(blankStringContents(body))) problems.push(`test ${rel} declares no it()/test() case`);
  const needle = identity.startsWith('fingerprint:') ? identity.slice('fingerprint:'.length) : identity;
  const inLiteral = new RegExp(`(['"\`])[^'"\`\\n]*${escapeRe(needle)}[^'"\`\\n]*\\1`);
  if (!inLiteral.test(body)) problems.push(`test ${rel} does not name ${needle} in a string literal`);
  return problems;
}

/**
 * The registry's own consistency rules, beyond the schema. Each `enforced`
 * entry's test qualifies per {@link testPathProblems} — the mechanical link
 * between the failure and the check that prevents it.
 * @returns {string[]} problems (empty = valid)
 */
export function validateRegistry({ registry, repoRoot }) {
  const problems = [];
  const seen = new Set();
  for (const d of registry.decisions) {
    if (seen.has(d.identity)) problems.push(`${d.identity}: duplicate decision`);
    seen.add(d.identity);
    for (const p of summaryProblems(d.summary)) problems.push(`${d.identity}: ${p}`);
    if (d.decision !== 'enforced') continue;
    for (const p of testPathProblems({ test: d.test, identity: d.identity, repoRoot })) problems.push(`${d.identity}: ${p}`);
  }
  return problems;
}

/**
 * Append one decision under the registry's own lock. Idempotent on `identity`:
 * an existing decision with the same identity is left as-is (`appended:false`).
 */
export async function appendDecision(repoRoot, decision) {
  const parsed = DecisionSchema.parse(decision);
  // The write boundary enforces the same rules the committed-registry test does
  // (audit H14): nothing invalid reaches the public file through any path.
  const problems = [...summaryProblems(parsed.summary),
    ...(parsed.decision === 'enforced' ? testPathProblems({ test: parsed.test, identity: parsed.identity, repoRoot }) : [])];
  if (problems.length) {
    const e = new Error(`refusing to record ${parsed.identity}: ${problems.join('; ')}`);
    e.code = 'REGISTRY_INVALID';
    throw e;
  }
  const p = path.join(repoRoot, REGISTRY_REL);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let appended = false;
  await withFileLock(`${p}.lock`, {}, async () => {
    const reg = fs.existsSync(p) ? RegistrySchema.parse(JSON.parse(fs.readFileSync(p, 'utf8'))) : { ...EMPTY, decisions: [] };
    if (reg.decisions.some((d) => d.identity === parsed.identity)) return;
    reg.decisions.push(parsed);
    reg.decisions.sort((a, b) => a.identity.localeCompare(b.identity));
    atomicWriteFileSync(p, `${JSON.stringify(reg, null, 2)}\n`);
    appended = true;
  });
  return { appended, path: p };
}

/**
 * When did an enforcement go LIVE? Only a landing-time source is accepted.
 * @param {string} identity
 * @param {{runGit: (args: string[]) => string|null, runGh?: (args: string[]) => string|null,
 *          repoSlug?: string|null, mainRef?: string}} deps
 * @returns {{status: 'active', at: string, provenance: string, commit: string}
 *         | {status: 'pending-merge'} | {status: 'unknown', reason: string}}
 */
export function activationFor(identity, { runGit, runGh = null, repoSlug = null, mainRef = 'origin/main' }) {
  // -G on the EXACT `"identity": "<id>"` line, not -S on a substring: `tripwire:foo`
  // must never match the introduction of `tripwire:foobar` (audit R3-M1).
  const exactLine = `"identity": "${identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`;
  const log = runGit(['log', '--first-parent', '--reverse', '--format=%H%x09%cI%x09%ce', `-G${exactLine}`, mainRef, '--', REGISTRY_REL.replace(/\\/g, '/')]);
  if (log === null) return { status: 'unknown', reason: 'activation-unknown: git history unavailable' };
  const first = log.split('\n').find((l) => l.trim());
  if (!first) return { status: 'pending-merge' };
  const [sha, committedAt, committerEmail] = first.split('\t');
  if (/noreply@github\.com$/i.test(committerEmail ?? '')) {
    return { status: 'active', at: committedAt, provenance: 'github-merge-commit', commit: sha };
  }
  if (runGh && repoSlug) {
    const out = runGh(['api', `repos/${repoSlug}/commits/${sha}/pulls`, '--jq', '[.[] | select(.merged_at != null) | .merged_at][0] // empty']);
    const at = out?.trim();
    if (at) return { status: 'active', at, provenance: 'pr-merged-at', commit: sha };
  }
  return { status: 'unknown', reason: 'activation-unknown: no landing-time source for the introducing commit' };
}

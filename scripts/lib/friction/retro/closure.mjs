/**
 * @fileoverview `enforce` / `reject` — record a human-approved decision (plan
 * docs/plans/harness-retro.md §2 component 13).
 *
 * Order: preflight (writes NOTHING on failure) → registry append (idempotent,
 * under the registry's own lock) → for a `tripwire:` identity whose memory is
 * `type: friction`, the EXISTING `frictionLink` seam records the enforcing test
 * in `memory_friction.mitigation_refs` (so `resolved` flips) — the reuse of the
 * friction tables. Both steps are idempotent; re-running finishes an interrupted run.
 *
 * v1 does NOT retire tripwires from `MEMORY.md`: the scan LISTS promotion
 * candidates and a human edits the index (plan right-sizing gate, cut 3).
 *
 * @module scripts/lib/friction/retro/closure
 */
import path from 'node:path';
import { appendDecision, DecisionSchema, summaryProblems, testPathProblems, LAYERS } from './registry.mjs';
import { evidenceFor } from './proposal-schema.mjs';
import { readFrontmatter } from './memory-tripwires.mjs';

/**
 * Validate everything before any write. Pure apart from reads.
 * @returns {{ok: true, decision: object, isFriction: boolean} | {ok: false, problems: string[]}}
 */
export function preflightDecision({ decision, identity, scan, test, layer, summary, repoRoot, memoryDir, forceUnscanned = false, now = new Date() }) {
  const problems = [];
  if (!['enforced', 'rejected'].includes(decision)) problems.push('decision must be enforced|rejected');
  const mem = identity?.startsWith('tripwire:') ? identity.slice('tripwire:'.length) : null;
  let evidence = scan ? evidenceFor(identity, scan) : null;
  if (!evidence && !forceUnscanned) problems.push(`${identity} is not a candidate of scan ${scan?.scanId ?? '(none)'} (pass --force-unscanned only for a fingerprint id you verified)`);
  if (!evidence && forceUnscanned) {
    if (!identity?.startsWith('fingerprint:')) problems.push('--force-unscanned applies to a fingerprint identity only');
    else evidence = { evidenceFingerprints: [identity.slice('fingerprint:'.length)] };
  }
  if (decision === 'enforced') {
    if (!LAYERS.includes(layer)) problems.push(`--layer must be one of ${LAYERS.join('|')}`);
    if (!test) problems.push('--test is required for enforced');
    // The SAME qualification the committed-registry test applies.
    else problems.push(...testPathProblems({ test, identity: String(identity ?? ''), repoRoot }).map((p) => `--test: ${p}`));
  }
  problems.push(...summaryProblems(summary));
  let isFriction = false;
  if (mem) {
    // A tripwire decision needs its memory READABLE: an unavailable or malformed
    // memory must not silently read as non-friction (audit v1-H1/H8).
    const fm = memoryDir ? readFrontmatter(path.join(memoryDir, `${mem}.md`)) : null;
    if (!memoryDir) problems.push('memory dir unresolved — a tripwire decision needs its memory file');
    else if (!fm) problems.push(`memory ${mem} not found or has no frontmatter`);
    else if (fm.parseError) problems.push(`memory ${mem} frontmatter is malformed: ${fm.parseError}`);
    else isFriction = fm.fm?.metadata?.type === 'friction';
  }
  const fpMeta = scan && evidence?.evidenceFingerprints?.[0] ? scan.fingerprints[evidence.evidenceFingerprints[0]] : null;
  const candidate = {
    identity,
    evidenceFingerprints: evidence?.evidenceFingerprints ?? [],
    fingerprintVersion: scan?.fingerprintVersion ?? 1,
    kind: fpMeta?.kind ?? (identity?.startsWith('tripwire:') ? 'tripwire' : 'unknown'),
    tool: fpMeta?.tool ?? '',
    decision,
    ...(decision === 'enforced' ? { layer, test: String(test).replace(/\\/g, '/') } : {}),
    summary: String(summary ?? ''),
    ...(mem ? { memory: mem } : {}),
    decidedAt: now.toISOString().slice(0, 10),
  };
  const schema = DecisionSchema.safeParse(candidate);
  if (!schema.success) problems.push(...schema.error.issues.map((i) => `${i.path.join('.') || 'decision'}: ${i.message}`));
  return problems.length ? { ok: false, problems: [...new Set(problems)] } : { ok: true, decision: schema.data, isFriction };
}

/**
 * Record the decision. `link` = the existing `frictionLink` (injected for tests).
 * @returns {Promise<{ok: boolean, problems?: string[], decision?: object, steps?: object}>}
 */
export async function closeDecision(args, { link = null } = {}) {
  const pre = preflightDecision(args);
  if (!pre.ok) return { ok: false, problems: pre.problems };
  const linkNeeded = pre.isFriction && pre.decision.decision === 'enforced';
  if (linkNeeded && typeof link !== 'function') {
    return { ok: false, problems: ['memory is type: friction — the frictionLink seam is required to record its enforcement'] };
  }
  const steps = { registry: await appendDecision(args.repoRoot, pre.decision) };
  if (linkNeeded) {
    steps.frictionLink = await link({ memory: pre.decision.memory, kind: 'test', ref: pre.decision.test, repoRoot: args.repoRoot });
    if (steps.frictionLink?.ok === false) {
      return { ok: false, problems: [`frictionLink failed: ${steps.frictionLink.error?.message ?? 'unknown'} — re-run enforce to finish`], steps };
    }
  }
  return { ok: true, decision: pre.decision, steps };
}

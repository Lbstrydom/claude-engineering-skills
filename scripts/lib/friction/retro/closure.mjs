/**
 * @fileoverview `enforce` / `reject` — the ordered, idempotent closure (plan
 * docs/plans/harness-retro.md §2 component 13).
 *
 * Order: preflight (writes NOTHING on failure) → registry append → memory
 * frontmatter mark → index retirement → friction mirror link. Locks: the
 * registry's own lock (inside `appendDecision`), then the memory dir's. Every
 * step is idempotent, so a run that died mid-way is FINISHED by re-running it;
 * `retirementStatus` reports a half-done retirement. There is no rollback: no
 * step needs undoing, only completing.
 *
 * @module scripts/lib/friction/retro/closure
 */
import path from 'node:path';
import { withFileLock } from '../../file-lock.mjs';
import { appendDecision, DecisionSchema, summaryProblems, testPathProblems, LAYERS } from './registry.mjs';
import { evidenceFor } from './proposal-schema.mjs';
import { markEnforced, readFrontmatter, retireFromIndex } from './memory-tripwires.mjs';

const MEMORY_LOCK = '.harness-retro.lock';

/**
 * Validate everything before any write. Pure apart from reads.
 * @returns {{ok: true, decision: object, memoryFile: string|null, isFriction: boolean} | {ok: false, problems: string[]}}
 */
export function preflightDecision({ decision, identity, scan, test, layer, summary, memory, repoRoot, memoryDir, forceUnscanned = false, now = new Date() }) {
  const problems = [];
  if (!['enforced', 'rejected'].includes(decision)) problems.push(`decision must be enforced|rejected`);
  let mem = memory ?? null;
  if (identity?.startsWith('tripwire:')) {
    const name = identity.slice('tripwire:'.length);
    if (mem && mem !== name) problems.push(`--memory ${mem} contradicts identity ${identity}`);
    mem = name;
  }
  let evidence = null;
  if (scan) evidence = evidenceFor(identity, scan);
  if (!evidence && !forceUnscanned) problems.push(`${identity} is not a candidate of scan ${scan?.scanId ?? '(none)'} (pass --force-unscanned only for a fingerprint id you verified)`);
  if (!evidence && forceUnscanned) {
    if (!identity?.startsWith('fingerprint:')) problems.push('--force-unscanned applies to a fingerprint identity only');
    else evidence = { evidenceFingerprints: [identity.slice('fingerprint:'.length)] };
  }
  if (decision === 'enforced') {
    if (!LAYERS.includes(layer)) problems.push(`--layer must be one of ${LAYERS.join('|')}`);
    if (!test) problems.push('--test is required for enforced');
    // The SAME qualification the committed-registry test applies — `.` or a
    // non-test file is refused here, before anything is written (audit H15).
    else problems.push(...testPathProblems({ test, identity: String(identity ?? ''), repoRoot }).map((p) => `--test: ${p}`));
  }
  problems.push(...summaryProblems(summary));
  let memoryFile = null; let isFriction = false;
  if (mem) {
    if (!memoryDir) problems.push('memory dir unresolved');
    else {
      memoryFile = path.join(memoryDir, `${mem}.md`);
      const fm = readFrontmatter(memoryFile);
      if (!fm) problems.push(`memory ${mem} has no parseable frontmatter (or does not exist)`);
      else isFriction = fm.fm?.metadata?.type === 'friction';
    }
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
  return problems.length ? { ok: false, problems: [...new Set(problems)] } : { ok: true, decision: schema.data, memoryFile, isFriction };
}

/**
 * Run the closure. `link` = the existing `frictionLink` (injected for tests).
 * @returns {Promise<{ok: boolean, problems?: string[], steps?: object}>}
 */
export async function closeDecision(args, { link = null } = {}) {
  const pre = preflightDecision(args);
  if (!pre.ok) return { ok: false, problems: pre.problems };
  // A friction-typed memory MUST be closed through the mirror seam too, or
  // memory_friction keeps it open forever; refuse before writing (audit H9).
  if (pre.isFriction && pre.decision.decision === 'enforced' && typeof link !== 'function') {
    return { ok: false, problems: ['memory is type: friction — the frictionLink seam is required to close it'] };
  }
  const steps = {};
  steps.registry = await appendDecision(args.repoRoot, pre.decision);
  if (pre.memoryFile && pre.decision.decision === 'enforced') {
    await withFileLock(path.join(args.memoryDir, MEMORY_LOCK), {}, async () => {
      steps.frontmatter = markEnforced(pre.memoryFile, {
        identity: pre.decision.identity, test: pre.decision.test, date: pre.decision.decidedAt,
      });
      steps.index = retireFromIndex(args.memoryDir, path.basename(pre.memoryFile));
    });
    if (pre.isFriction) {
      steps.frictionLink = await link({ memory: pre.decision.memory, kind: 'test', ref: pre.decision.test, repoRoot: args.repoRoot });
      if (steps.frictionLink?.ok === false) {
        // Every earlier step is idempotent, so a re-run finishes this one.
        return { ok: false, problems: [`frictionLink failed: ${steps.frictionLink.error?.message ?? 'unknown'} — re-run enforce to finish`], steps };
      }
    }
  }
  return { ok: true, decision: pre.decision, steps };
}

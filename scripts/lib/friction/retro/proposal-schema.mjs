/**
 * @fileoverview The three-things proposal contract (plan docs/plans/harness-retro.md
 * §2 components 10–11). Every `propose` names (1) the failure it prevents with the
 * evidence it was seen in, (2) the exact change, and (3) a positive control that
 * proves the new enforcement fires. `record` validates the model's output against
 * this schema AND against the scan, so evidence cannot be inflated.
 *
 * The field list in `skills/harness-retro/SKILL.md` is pinned to
 * this schema's EMITTED JSON Schema by tests/harness-retro-proposal-schema.test.mjs.
 * It is never sent to a provider: the judge is the session's own model, and this
 * schema only validates what `record` receives.
 *
 * @module scripts/lib/friction/retro/proposal-schema
 */
import { z } from 'zod';
import { IDENTITY_RE, LAYERS } from './registry.mjs';
import { canonicalSessions } from './aggregate.mjs';

const Propose = z.object({
  identity: z.string().regex(IDENTITY_RE),
  verdict: z.literal('propose'),
  failurePrevented: z.object({
    summary: z.string().min(10),
    sessions: z.number().int().positive(),
    occurrences: z.number().int().positive(),
  }).strict(),
  layer: z.enum(LAYERS),
  change: z.object({
    files: z.array(z.string().min(1)).min(1),
    description: z.string().min(10),
  }).strict(),
  positiveControl: z.object({
    test: z.string().min(1),
    assertion: z.string().min(10),
  }).strict(),
  coordinatorChore: z.boolean(),
  ladderJustification: z.string().min(10).optional(),
}).strict().superRefine((p, ctx) => {
  if (p.layer === 'agents-md' && !p.ladderJustification) {
    ctx.addIssue({ code: 'custom', path: ['ladderJustification'], message: "layer 'agents-md' is the last resort: say why every lower layer cannot enforce it" });
  }
});

const NonPropose = z.object({
  identity: z.string().regex(IDENTITY_RE),
  verdict: z.enum(['already-covered', 'judgment-only', 'not-actionable']),
  reason: z.string().min(10),
  coveredBy: z.string().min(1).optional(),
}).strict().superRefine((p, ctx) => {
  if (p.verdict === 'already-covered' && !p.coveredBy) {
    ctx.addIssue({ code: 'custom', path: ['coveredBy'], message: "'already-covered' names the surface that covers it" });
  }
});

export const ProposalSchema = z.union([Propose, NonPropose]);
export const ProposalsEnvelopeSchema = z.object({
  scanId: z.string().min(1),
  proposals: z.array(ProposalSchema).min(1),
}).strict();

/**
 * The evidence the scan holds for an identity: distinct sessions + occurrences.
 * A tripwire's evidence is the union of its matched fingerprints.
 * @returns {{kind: 'fingerprint'|'tripwire', sessions: number, occurrences: number, evidenceFingerprints: string[]}|null}
 */
export function evidenceFor(identity, scan) {
  const candidates = new Map(scan.candidates.map((c) => [`fingerprint:${c.fingerprint}`, c]));
  const tripwires = new Map(scan.tripwires.map((t) => [t.identity, t]));
  let fps;
  let kind;
  if (identity.startsWith('fingerprint:')) {
    if (!candidates.has(identity)) return null;
    fps = [identity.slice('fingerprint:'.length)]; kind = 'fingerprint';
  } else {
    const t = tripwires.get(identity);
    if (!t || t.status !== 'promotion-candidate') return null;
    fps = [...t.matchedFingerprints]; kind = 'tripwire';
  }
  const want = new Set(fps);
  const sessions = new Set();
  let occurrences = 0;
  for (const s of canonicalSessions(scan.sessions)) {
    for (const [fp, n] of Object.entries(s.counts)) {
      if (!want.has(fp)) continue;
      sessions.add(s.sessionKey); occurrences += n;
    }
  }
  return { kind, sessions: sessions.size, occurrences, evidenceFingerprints: fps.sort() };
}

/**
 * Validate an envelope against the schema and the named scan.
 * @returns {{ok: true, envelope: object} | {ok: false, problems: string[]}}
 */
export function checkProposalsAgainstScan(input, scan) {
  const parsed = ProposalsEnvelopeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  const env = parsed.data;
  const problems = [];
  if (env.scanId !== scan.scanId) problems.push(`scanId ${env.scanId} does not match scan ${scan.scanId}`);
  const seen = new Set();
  env.proposals.forEach((p, i) => {
    if (seen.has(p.identity)) problems.push(`proposals.${i}: duplicate identity ${p.identity}`);
    seen.add(p.identity);
    const ev = evidenceFor(p.identity, scan);
    if (!ev) { problems.push(`proposals.${i}: ${p.identity} is not a candidate or promotion candidate of scan ${scan.scanId}`); return; }
    if (p.verdict === 'propose') {
      if (p.failurePrevented.sessions !== ev.sessions) problems.push(`proposals.${i}: claims ${p.failurePrevented.sessions} sessions, scan has ${ev.sessions}`);
      if (p.failurePrevented.occurrences !== ev.occurrences) problems.push(`proposals.${i}: claims ${p.failurePrevented.occurrences} occurrences, scan has ${ev.occurrences}`);
    }
  });
  return problems.length ? { ok: false, problems } : { ok: true, envelope: env };
}

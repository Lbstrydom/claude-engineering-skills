/**
 * @fileoverview Post-landing verification for a ship train (plan T6, §2.8).
 *
 * Pure: the CLI gathers the facts (each PR's merge commit, its message and
 * tree, the first-parent chain on main) and this module judges them.
 *
 * What it checks, per landed PR, against the ACTUAL decision persisted before
 * that merge was submitted — never against the plan (round-2 H2):
 *   - the merge commit's message ends in a PARSEABLE AI-* trailer block;
 *   - every trailer equals the persisted claim (skill, models, gate, run id);
 *   - a `passed` claim's `AI-Audited-Tree` equals the commit's own tree. If it
 *     does not, publication is BLOCKED: the server pin that justified `passed`
 *     was not what `prepare` read.
 *
 * Across the train it records:
 *   - planned-vs-actual differences (pending-notes, never failures);
 *   - `finalMergeOid`, the last train merge in observed first-parent order;
 *   - foreign commits interleaved between train merges on an unpinned main
 *     (round-2 H1). A non-empty list is a recoverable BLOCKED state, not a
 *     success: `sync` needs an explicit `--accept-interleaved`;
 *   - whether the observed landing order equals the manifest's.
 *
 * @module scripts/lib/ship-train/verify
 */

import { parseMessageTrailers } from '../commit-trailers.mjs';
import { verifyBasisOf } from './receipt.mjs';

/**
 * Read the AI-* trailers of a commit message. Multiplicity is preserved: a key
 * appearing more than once is reported in `duplicates`, never silently reduced
 * to its last value — two contradictory claims on one commit is itself the
 * defect (round-1 code H2/M10).
 *
 * @param {string} message — the merge commit's full message
 * @returns {{parseable: boolean, trailers: Record<string, string>, duplicates: string[]}}
 */
export function readAiTrailers(message) {
  const { isTrailerBlock, trailers } = parseMessageTrailers(message);
  const out = {};
  const seen = new Set();
  const duplicates = new Set();
  for (const t of trailers) {
    if (!/^AI-/i.test(t.key)) continue;
    if (seen.has(t.key)) duplicates.add(t.key);
    seen.add(t.key);
    out[t.key] = t.value;
  }
  return { parseable: isTrailerBlock && seen.size > 0, trailers: out, duplicates: [...duplicates] };
}

/**
 * Compare one merge commit against its persisted claims.
 *
 * `identityUnproven` is true whenever a `passed` claim's tree identity cannot be
 * confirmed from the commit — a mismatched tree OR a missing/duplicated
 * `AI-Audited-Tree` (round-1 code M9). Either way publication must not proceed
 * on that claim.
 *
 * @param {{message: string, tree: string}} commit
 * @param {{gate: string, runId: string|null, auditedTree: string|null, models: string[]}} claims
 * @returns {{problems: string[], identityUnproven: boolean}}
 */
export function checkCommitClaims(commit, claims) {
  const problems = [];
  const { parseable, trailers, duplicates } = readAiTrailers(commit.message);
  if (!parseable) {
    return { problems: ['no parseable AI-* trailer block on the merge commit'], identityUnproven: claims.gate === 'passed' };
  }
  for (const key of duplicates) problems.push(`${key} appears more than once — the commit carries contradictory or repeated claims`);
  const expect = {
    'AI-Skill': 'ship',
    'AI-Models': claims.models.join(','),
    'AI-Gate': claims.gate,
    'AI-Run-ID': claims.runId ?? undefined,
    'AI-Audited-Tree': claims.gate === 'passed' ? claims.auditedTree : undefined,
  };
  for (const [key, want] of Object.entries(expect)) {
    const got = trailers[key];
    if (want === undefined && got !== undefined) problems.push(`${key} present ("${got}") but the persisted claim has none`);
    else if (want !== undefined && got !== want) problems.push(`${key} is ${got === undefined ? 'missing' : `"${got}"`}, persisted claim "${want}"`);
  }
  let identityUnproven = false;
  const tree = trailers['AI-Audited-Tree'];
  if (tree !== undefined && tree !== commit.tree) {
    identityUnproven = true;
    problems.push(`AI-Audited-Tree ${tree.slice(0, 12)} is not the commit's tree ${String(commit.tree).slice(0, 12)} — a passed claim that does not hold`);
  }
  // A passed claim's identity holds only when the trailer is present once, is
  // the commit's own tree, AND is the tree the persisted decision named
  // (round-3 code H1 — a trailer self-consistent with its commit but not with
  // the decision is a claim nobody made).
  if (claims.gate === 'passed'
    && (tree === undefined || duplicates.includes('AI-Audited-Tree') || tree !== claims.auditedTree)) {
    identityUnproven = true;
  }
  return { problems, identityUnproven };
}

/**
 * May this train be published to consumers now? The ONE predicate `sync`
 * consults (round-2 code H1) — recording a block in `verify` is not enforcing
 * it, so the enforcement lives in code here rather than in a caller's prose.
 *
 * Each block names the invocation flag that acknowledges it, and an
 * acknowledgement counts only when the receipt records it:
 *   - not verified yet, no final merge, or a revoked verification → no flag
 *     clears it (a human reads both records and starts a new op);
 *   - interleaved foreign commits before the final merge → `--accept-interleaved`,
 *     cleared only by a `publicationAmendment` naming exactly those oids;
 *   - a `passed` claim the merge commit does not confirm → `--accept-provenance-mismatch`.
 *
 * @param {object} receipt — a validated receipt
 * @param {{acceptProvenanceMismatch?: boolean}} [acks] — flags given on THIS invocation
 * @returns {{clear: boolean, blocks: Array<{reason: string, flag: string|null}>}}
 */
export function publicationClearance(receipt, { acceptProvenanceMismatch = false } = {}) {
  const v = receipt.verify;
  const blocks = [];
  if (!v || !['verified', 'verified-interleaved', 'publishing', 'partial'].includes(receipt.phase)) {
    blocks.push({ reason: `op is ${receipt.phase}; publication needs a verified train`, flag: null });
    return { clear: false, blocks };
  }
  if (!v.finalMergeOid) blocks.push({ reason: 'no final merge was recorded', flag: null });
  if (v.basis !== verifyBasisOf(receipt)) {
    blocks.push({ reason: 'the receipt changed after this verification was recorded — run verify again', flag: null });
  }
  if (receipt.revocation) blocks.push({ reason: `verification revoked: ${receipt.revocation.reason}`, flag: null });
  if (v.interleaved.length) {
    const accepted = new Set(receipt.publicationAmendment?.acceptedOids ?? []);
    const unaccepted = v.interleaved.filter((c) => !accepted.has(c.oid));
    if (unaccepted.length) {
      blocks.push({ reason: `${unaccepted.length} foreign commit(s) interleaved before the final merge are not accepted into this publication`, flag: '--accept-interleaved' });
    }
  }
  if (v.publicationBlocked && !acceptProvenanceMismatch) {
    blocks.push({ reason: v.blockedReason ?? 'verification blocked publication', flag: '--accept-provenance-mismatch' });
  }
  return { clear: blocks.length === 0, blocks };
}

/** The train's PRs: the selected sources plus the status-log PR. */
export function trainPrs(receipt) {
  return [...receipt.selected.map((s) => s.pr), ...(receipt.logPr ? [receipt.logPr.number] : [])];
}

/**
 * Judge a landed train.
 *
 * @param {object} input
 * @param {object} input.receipt — a validated receipt in phase `landed`
 * @param {Record<string, {mergeOid: string, message: string, tree: string}>} input.merged — by PR number
 * @param {Array<{oid: string, subject: string}>} input.chain — first-parent commits expectedOid..tip, OLDEST first
 * @param {string} input.at — ISO timestamp for the record
 * @returns {object} the receipt's `verify` record
 */
export function verifyLanded({ receipt, merged, chain, at }) {
  const perPr = {};
  const plannedVsActual = [];
  let publicationBlocked = false;
  const blocked = [];

  // ONE train membership set, used for claim checks, order and the final merge
  // alike (round-1 code H1). A merged entry outside it is not train evidence.
  const prs = trainPrs(receipt);
  const members = new Set(prs.map(String));
  const strays = Object.keys(merged).filter((k) => !members.has(k));
  for (const pr of prs) {
    const key = String(pr);
    const m = merged[key];
    const actual = receipt.actual?.[key];
    const problems = [];
    if (!m) problems.push('not merged');
    if (!actual) problems.push('no actual decision was persisted before the merge');
    if (m && actual) {
      const r = checkCommitClaims(m, actual.claims);
      problems.push(...r.problems);
      if (r.identityUnproven) {
        publicationBlocked = true;
        blocked.push(`#${pr}: the passed claim's tree identity is not confirmed by the merge commit`);
      }
      const planned = receipt.selected.find((s) => s.pr === pr)?.decision?.gate;
      if (planned && planned !== actual.claims.gate) plannedVsActual.push({ pr, planned, actual: actual.claims.gate });
    }
    perPr[key] = { ok: problems.length === 0, problems };
  }

  if (strays.length) {
    publicationBlocked = true;
    blocked.push(`merge evidence for PR(s) outside this train: ${strays.map((k) => `#${k}`).join(', ')}`);
  }
  const trainOids = new Map(Object.entries(merged)
    .filter(([pr]) => members.has(pr))
    .map(([pr, m]) => [m.mergeOid, Number(pr)]));
  const position = new Map(chain.map((c, i) => [c.oid, i]));
  const landedInOrder = [...trainOids.entries()]
    .filter(([oid]) => position.has(oid))
    .sort((a, b) => position.get(a[0]) - position.get(b[0]));
  const finalMergeOid = landedInOrder.length ? landedInOrder[landedInOrder.length - 1][0] : null;

  // Every merged PR must be on main's first-parent chain at all.
  for (const [oid, pr] of trainOids) {
    if (!position.has(oid)) perPr[String(pr)].problems.push('merge commit is not on the first-parent chain of the destination');
  }
  for (const k of Object.keys(perPr)) perPr[k].ok = perPr[k].problems.length === 0;

  const interleaved = [];
  if (finalMergeOid) {
    const end = position.get(finalMergeOid);
    for (let i = 0; i <= end; i++) {
      if (!trainOids.has(chain[i].oid)) interleaved.push({ oid: chain[i].oid, subject: chain[i].subject });
    }
  }

  const observedOrder = landedInOrder.map(([, pr]) => pr);
  const orderOk = !receipt.landingOrder
    || JSON.stringify(observedOrder) === JSON.stringify(receipt.landingOrder.filter((pr) => observedOrder.includes(pr)));

  // Every failed check blocks publication — recorded failures are not enforced
  // failures (round-3 code H3). One flag acknowledges them all, because each is
  // the same question: publish a train whose record does not verify?
  const failed = Object.entries(perPr).filter(([, p]) => !p.ok).map(([pr]) => `#${pr}`);
  if (failed.length) {
    publicationBlocked = true;
    blocked.push(`per-PR verification failed for ${failed.join(', ')}`);
  }
  if (!orderOk) {
    publicationBlocked = true;
    blocked.push(`observed landing order ${observedOrder.join(',')} differs from the manifest's`);
  }

  return {
    at,
    perPr,
    plannedVsActual,
    interleaved,
    finalMergeOid,
    publicationBlocked,
    blockedReason: publicationBlocked ? blocked.join('; ') : null,
    orderOk,
    observedOrder,
    basis: verifyBasisOf(receipt),
  };
}

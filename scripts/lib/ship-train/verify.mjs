/**
 * @fileoverview Ship-train verification — stateless (plan §2.8).
 *
 * Pure: the caller gathers facts from owned state (fleet's train manifest,
 * GitHub, git, the audit store) and this module judges them. Nothing here
 * reads or writes a ship-train record; every call is a fresh judgement, so
 * there is no stored result to go stale, race, or be revoked.
 *
 * Two questions, in order, per train source:
 *   1. SOURCE IDENTITY — is the merged PR the source the train tested? Its
 *      merged head must be the manifest's pinned oid, or a chain of fleet
 *      serial's own base-only updates leading back to it (each link judged by
 *      fleet's `classifyUpdatedHead`). Anything else blocks publication and no
 *      flag acknowledges it: identity is the train's definition.
 *   2. CLAIM TRUTH — is every AI-* claim on the squash commit TRUE, given git
 *      and the store? Not "equal to what was decided": an under-claim is true.
 *
 * Then, across the train: the final merge OID and any foreign commits
 * interleaved before it, and `publicationClearance` — the one predicate `sync`
 * applies to the verification it computed in the same invocation.
 *
 * @module scripts/lib/ship-train/verify
 */

import { parseMessageTrailers, AI_TRAILER_KEYS } from '../commit-trailers.mjs';

/** A merged head is a bounded number of serial updates from its pinned oid. */
export const MAX_UPDATE_LINKS = 5;

/**
 * Read the AI-* trailers of a commit message. Multiplicity is preserved: a key
 * appearing more than once is reported in `duplicates`, never reduced to its
 * last value — two contradictory claims on one commit is itself a false claim.
 *
 * @param {string} message
 * @returns {{parseable: boolean, trailers: Record<string, string>, duplicates: string[]}}
 */
export function readAiTrailers(message) {
  const { isTrailerBlock, trailers } = parseMessageTrailers(message);
  const out = {};
  const seen = new Set();
  const duplicates = new Set();
  const nonCanonical = [];
  for (const t of trailers) {
    if (!/^AI-/i.test(t.key)) continue;
    // ONE canonical key per claim (code R1 H2/M5): matching is case-insensitive,
    // so `ai-gate` and `AI-Gate` are the same claim — a second one is a
    // duplicate, never a separate key the lookup would miss.
    const canonical = CANONICAL_KEYS.get(t.key.toLowerCase()) ?? t.key;
    if (canonical !== t.key) nonCanonical.push(t.key);
    if (seen.has(canonical)) duplicates.add(canonical);
    seen.add(canonical);
    out[canonical] = t.value;
  }
  return { parseable: isTrailerBlock && seen.size > 0, trailers: out, duplicates: [...duplicates], nonCanonical };
}

/** The reserved keys as their one writer emits them (commit-trailers.mjs formatTrailerBlock). */
const CANONICAL_KEYS = new Map(AI_TRAILER_KEYS.map((k) => [k.toLowerCase(), k]));

/**
 * Judge source identity from a first-parent walk the caller gathered.
 *
 * @param {object} input
 * @param {string} input.pinnedOid — the manifest's `sources[].oid`
 * @param {Array<{oid: string, verdict: 'own'|'foreign'|'unverifiable', reason?: string}>} input.links
 *   — from the merged head backwards, each head with fleet's verdict on it being
 *   a clean base-only update of its first parent
 * @param {string|null} input.reachedOid — the oid the walk stopped at
 * @returns {{ok: boolean, reason: string|null}}
 */
export function judgeSourceIdentity({ pinnedOid, links, reachedOid }) {
  const bad = links.find((l) => l.verdict !== 'own');
  if (bad) {
    return { ok: false, reason: `${bad.oid.slice(0, 12)} is not fleet serial's own base-only update (${bad.verdict}${bad.reason ? `: ${bad.reason}` : ''})` };
  }
  if (reachedOid !== pinnedOid) {
    return { ok: false, reason: `merged head does not lead back to the tested head ${String(pinnedOid).slice(0, 12)} within ${MAX_UPDATE_LINKS} update link(s)` };
  }
  return { ok: true, reason: null };
}

/**
 * Is every claim on one squash commit TRUE? (plan §2.8 truth list)
 *
 * @param {object} input
 * @param {string} input.message — the squash commit's full message
 * @param {string} input.tree — the squash commit's own tree (%T)
 * @param {Array<{oid: string, tree: string}>} input.prCommits — the PR's commits (merge-base..merged head)
 * @param {{id: string, auditedTree: string|null, auditedSha: string|null, roundConvergedAfter: number|null}|null} input.run
 *   — `AI-Run-ID` resolved through the repo-scoped, code-mode lookup; null when absent or unresolvable
 * @returns {{true: boolean, gate: string|null, problems: string[], notes: string[]}}
 */
export function checkClaimTruth({ message, tree, prCommits, run }) {
  const { parseable, trailers, duplicates, nonCanonical } = readAiTrailers(message);
  if (!parseable) return { true: false, gate: null, problems: ['no parseable AI-* trailer block on the squash commit'], notes: [] };
  const problems = [
    ...duplicates.map((k) => `${k} appears more than once`),
    // The reserved namespace has exactly one writer, which emits canonical keys;
    // any other spelling did not come from it.
    ...nonCanonical.map((k) => `${k} is not the canonical spelling — not written by the trailer helper`),
  ];
  const notes = [];
  const gate = trailers['AI-Gate'] ?? null;
  const runId = trailers['AI-Run-ID'];
  const claimedTree = trailers['AI-Audited-Tree'];
  const trees = new Set(prCommits.map((c) => c.tree));
  const oids = new Set(prCommits.map((c) => c.oid));

  const runResolves = () => {
    if (!runId) { problems.push(`AI-Gate ${gate} names no AI-Run-ID`); return false; }
    if (!run || run.id !== runId) { problems.push(`run ${runId} is not a code-mode run of this repository`); return false; }
    return true;
  };
  const requireTreeBound = () => {
    if (!(run.auditedTree && trees.has(run.auditedTree))) problems.push(`run ${runId}'s audited tree is not the tree of any commit in this PR`);
  };
  const requireConverged = () => {
    if (run.roundConvergedAfter == null) problems.push(`run ${runId} did not converge`);
  };

  if (claimedTree !== undefined && gate !== 'passed') problems.push(`AI-Audited-Tree on a ${gate} gate`);
  // The train is the squash's writer and never writes this key: the final-review marker it derives from is a local record in the
  // worktree that ran the review, and none is bound to a PR's run in the checkout a train lands from (copilot-feedback-item4 B4).
  if (trailers['AI-Final-Review'] !== undefined) problems.push(`AI-Final-Review ${trailers['AI-Final-Review']} on a squash commit: the train does not write it, so the trailer helper did not either`);
  switch (gate) {
    case 'passed':
      if (claimedTree !== tree) problems.push(`AI-Audited-Tree ${String(claimedTree).slice(0, 12)} is not the commit's tree ${String(tree).slice(0, 12)}`);
      if (runResolves()) {
        if (run.auditedTree !== claimedTree) problems.push(`run ${runId} audited tree ${String(run.auditedTree).slice(0, 12)}, not the claimed ${String(claimedTree).slice(0, 12)}`);
        requireTreeBound();
        requireConverged();
      }
      break;
    case 'converged':
      if (runResolves()) { requireTreeBound(); requireConverged(); }
      break;
    case 'waived':
      if (runResolves() && !(trees.has(run.auditedTree) || oids.has(run.auditedSha))) {
        problems.push(`run ${runId} is unrelated to this PR's commits`);
      }
      break;
    case 'not-run':
      if (runId) problems.push('not-run carries an AI-Run-ID');
      break;
    default:
      problems.push(`AI-Gate is ${gate === null ? 'missing' : `"${gate}"`}`);
  }
  if (problems.length === 0 && gate === 'converged' && run?.auditedTree === tree) {
    notes.push('converged where the commit tree equals the audited tree — an under-claim, true');
  }
  return { true: problems.length === 0, gate, problems, notes };
}

/**
 * Judge a train from gathered facts.
 *
 * @param {object} input
 * @param {Array<{pr: number, merged: null | {mergeOid: string, message: string, tree: string},
 *   identity: {ok: boolean, reason: string|null}|null, prCommits: Array<{oid: string, tree: string}>,
 *   run: object|null}>} input.sources — every manifest source, in manifest (landing) order
 * @param {Array<{oid: string, subject: string}>} input.chain — destination first-parent commits after the
 *   train's base, OLDEST first
 */
export function verifyTrain({ sources, chain }) {
  const position = new Map(chain.map((c, i) => [c.oid, i]));
  const perPr = {};
  const unmerged = [];
  const identityFailures = [];
  const falseClaims = [];
  const offChain = [];
  const actualGates = {};
  const trainMerges = new Map();

  for (const s of sources) {
    const key = String(s.pr);
    if (!s.merged) {
      unmerged.push(s.pr);
      perPr[key] = { merged: false, identity: null, claim: null };
      continue;
    }
    if (!position.has(s.merged.mergeOid)) offChain.push(s.pr);
    if (!s.identity?.ok) {
      // A foreign head is not a train source: its merge is not train evidence.
      identityFailures.push(s.pr);
      perPr[key] = { merged: true, identity: s.identity?.reason ?? 'identity not established', claim: null };
      continue;
    }
    trainMerges.set(s.merged.mergeOid, s.pr);
    const claim = checkClaimTruth({ message: s.merged.message, tree: s.merged.tree, prCommits: s.prCommits, run: s.run });
    if (!claim.true) falseClaims.push(s.pr);
    actualGates[key] = claim.gate;
    perPr[key] = { merged: true, identity: null, claim };
  }

  const onChain = [...trainMerges.keys()].filter((o) => position.has(o)).sort((a, b) => position.get(a) - position.get(b));
  const finalMergeOid = onChain.length ? onChain[onChain.length - 1] : null;
  const interleaved = [];
  if (finalMergeOid) {
    for (let i = 0; i <= position.get(finalMergeOid); i++) {
      if (!trainMerges.has(chain[i].oid)) interleaved.push({ oid: chain[i].oid, subject: chain[i].subject });
    }
  }
  return { perPr, finalMergeOid, interleaved, unmerged, identityFailures, falseClaims, offChain, actualGates };
}

/**
 * May this train be published now? `sync` calls this on the verification it
 * computed in the SAME invocation, with the flags given on that invocation.
 * Unmerged sources, foreign heads and merges off the destination's chain have
 * no acknowledging flag: they are not this train.
 *
 * @param {ReturnType<typeof verifyTrain>} v
 * @param {{acceptInterleaved?: boolean, acceptProvenanceMismatch?: boolean}} [acks]
 * @returns {{clear: boolean, blocks: Array<{reason: string, flag: string|null}>}}
 */
export function publicationClearance(v, { acceptInterleaved = false, acceptProvenanceMismatch = false } = {}) {
  const blocks = [];
  const list = (prs) => prs.map((p) => `#${p}`).join(', ');
  if (!v.finalMergeOid) blocks.push({ reason: 'no train merge is on the destination', flag: null });
  if (v.unmerged.length) blocks.push({ reason: `not merged: ${list(v.unmerged)}`, flag: null });
  if (v.identityFailures.length) blocks.push({ reason: `merged at a head the train did not test: ${list(v.identityFailures)}`, flag: null });
  if (v.offChain.length) blocks.push({ reason: `merge commit not on the destination's first-parent chain: ${list(v.offChain)}`, flag: null });
  if (v.falseClaims.length && !acceptProvenanceMismatch) {
    blocks.push({ reason: `provenance claims that do not hold: ${list(v.falseClaims)}`, flag: '--accept-provenance-mismatch' });
  }
  if (v.interleaved.length && !acceptInterleaved) {
    blocks.push({ reason: `${v.interleaved.length} foreign commit(s) interleaved before the final merge`, flag: '--accept-interleaved' });
  }
  return { clear: blocks.length === 0, blocks };
}

/**
 * @fileoverview The pure half of `fleet land --rollup` (docs/plans/ship-batch-member-outcomes.md §2.9): n ready chips land as ONE
 * squash commit on one PR. Nothing here reads git or the network.
 *
 *  - the rollup branch name and the member commit message (NO `AI-*` trailer: a rollup commit never claims an audit verdict);
 *  - the overlap rule: two members that touch one path never share a rollup (the later one is held);
 *  - the manifest, in two stages (`provisional` at PR creation, `final` after the required checks are green at the candidate),
 *    rendered from the members' own evidence and the rollup's CI evidence only, and parsed back;
 *  - `verifyRollupProvenance`: a manifest in commit text is SELF-DECLARED (any PR can author one), so a catch-up entry treats it as
 *    verified only when a durable local run matches it field for field.
 *
 * @module scripts/lib/fleet/rollup
 */
import { createHash } from 'node:crypto';
import { isMatch } from '../glob.mjs';

export const MANIFEST_SCHEMA = 'fleet-rollup/v1';
const FENCE = '```';
const MANIFEST_RE = new RegExp(`${FENCE}${MANIFEST_SCHEMA}\\n([\\s\\S]*?)\\n${FENCE}`);
const MEMBER_TRAILER = 'Fleet-Rollup-Member';
const ROLLUP_TRAILER = 'Fleet-Rollup';

/** `rollup/YYYYMMDD-n`, from a Date and the lowest free number. */
export const rollupBranchName = (date, n) => `rollup/${date.toISOString().slice(0, 10).replace(/-/g, '')}-${n}`;
export const ROLLUP_BRANCH_RE = /^rollup\/\d{8}-\d+$/;

export const sha256Body = (body) => createHash('sha256').update(String(body ?? '').replace(/\s+$/, '')).digest('hex');

/**
 * The commit message of one member inside the rollup candidate: the member's own subject, then ONE `Fleet-Rollup-Member`
 * trailer that names the member and its full head. Never an `AI-*` trailer (AGENTS.md: the namespace is reserved to ship-commit).
 */
export function rollupMessage({ subject, id, oid }) {
  return `${String(subject).replace(/[\r\n]+/g, ' ').trim()}\n\n${MEMBER_TRAILER}: ${id} ${oid}\n`;
}

/**
 * Overlap holds: members in landing order; the first to touch a path keeps it, a later member that touches an already-claimed path
 * is held as `overlap:<path>` (paths matching an append-only glob never overlap: fleet unions them anyway).
 * @param {Array<{id: string, paths: string[]}>} members
 * @returns {{kept: string[], held: Array<{id: string, reason: string}>}}
 */
export function overlapHolds(members, appendOnlyGlobs = []) {
  const owner = new Map();
  const kept = [];
  const held = [];
  for (const m of members) {
    const hit = m.paths.find((p) => owner.has(p) && !(appendOnlyGlobs.length && isMatch(p, appendOnlyGlobs, { dot: true })));
    if (hit !== undefined) { held.push({ id: m.id, reason: `overlap:${hit} (also changed by ${owner.get(hit)}); it lands in the next rollup, after its restack and any re-audit` }); continue; }
    for (const p of m.paths) if (!owner.has(p)) owner.set(p, m.id);
    kept.push(m.id);
  }
  return { kept, held };
}

const cell = (s) => String(s ?? '-').replace(/\|/g, '/').replace(/[\r\n]+/g, ' ');

/**
 * The manifest, a human table and one fenced `fleet-rollup/v1` JSON block. `stage` is `provisional` (the PR body at creation, CI
 * pending) or `final` (the squash body, rendered only after the required checks were observed green at the candidate).
 * @param {{stage: 'provisional'|'final', rollupId: string, base: string, candidate: {oid: string, tree: string}, members: object[], held: object[], ci?: object}} a
 */
export function renderRollupManifest({ stage, rollupId, base, candidate, members, held, ci }) {
  if (stage === 'final' && !ci) throw new Error('a final manifest carries the rollup CI record');
  const doc = { schema: MANIFEST_SCHEMA, stage, rollupId, base, candidate, members, held, ci: stage === 'final' ? ci : 'pending' };
  const rows = members.map((m) => `| ${cell(m.id)} | ${cell(m.branch)} | ${m.head} | ${m.tree} | ${cell(m.runId)} | ${cell(m.gate)} | ${cell(m.finalReview)} |`);
  const heldRows = held.map((h) => `- held: ${cell(h.id)}: ${cell(h.reason)}`);
  return [
    `Fleet rollup ${rollupId}: ${members.length} member${members.length === 1 ? '' : 's'} landed as one squash commit on ${base}.`, '',
    'Each member was audited against ITS OWN head and tree (the columns below). The rollup commit carries no AI-* trailer: no single audit read the combined tree. Its CI is recorded against the candidate tree.', '',
    '| member | branch | head | audited tree | audit run | gate | final review |', '|---|---|---|---|---|---|---|', ...rows, '',
    ...(heldRows.length ? [...heldRows, ''] : []),
    `${FENCE}${MANIFEST_SCHEMA}`, JSON.stringify(doc, null, 2), FENCE, '',
    `${ROLLUP_TRAILER}: v1 ${rollupId}`, '',
  ].join('\n');
}

/** @returns {{ok: true, manifest: object} | {ok: false, reason: string}} a malformed manifest is never "zero members" */
export function parseRollupManifest(message) {
  const m = MANIFEST_RE.exec(String(message ?? '').replace(/\r\n/g, '\n'));
  if (!m) return { ok: false, reason: 'no fleet-rollup/v1 block' };
  let doc;
  try { doc = JSON.parse(m[1]); } catch { return { ok: false, reason: 'the manifest block is not JSON' }; }
  if (doc?.schema !== MANIFEST_SCHEMA || !['provisional', 'final'].includes(doc.stage)) return { ok: false, reason: 'not a fleet-rollup/v1 manifest' };
  if (typeof doc.rollupId !== 'string' || !ROLLUP_BRANCH_RE.test(doc.rollupId) || !Array.isArray(doc.members) || !doc.members.length) return { ok: false, reason: 'the manifest has no usable rollup id or members' };
  const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
  if (typeof doc.base !== 'string' || !doc.base || !OID.test(String(doc.candidate?.oid)) || !OID.test(String(doc.candidate?.tree)) || !Array.isArray(doc.held)) return { ok: false, reason: 'the manifest has no base, no candidate oid and tree, or no held list' };
  for (const x of doc.members) if (!x || typeof x.id !== 'string' || !x.id.trim() || !OID.test(String(x.head)) || !OID.test(String(x.tree))) return { ok: false, reason: 'a manifest member has no id, full head or tree' };
  if (doc.stage === 'final' && !(doc.ci && typeof doc.ci === 'object' && OID.test(String(doc.ci.head)) && OID.test(String(doc.ci.tree)) && Array.isArray(doc.ci.checks))) return { ok: false, reason: 'a final manifest carries no usable CI record' };
  return { ok: true, manifest: doc };
}

/**
 * Is a parsed manifest VERIFIED provenance? Only a `final` manifest, matched field for field against a durable local run: the same
 * repo, PR, merge oid, candidate oid and manifest hash. Anything else keeps the manifest "unverified, self-declared".
 * @param {object} manifest  from `parseRollupManifest`
 * @param {object|null} run  the local serial run of a train carrying `landing: 'rollup'`, or null
 * @param {{repo: string, number: number, mergeOid: string, message: string}} pr  the merged PR's facts and the FULL squash commit message (subject and body)
 * @returns {{verified: boolean, reason: string}}
 */
export function verifyRollupProvenance(manifest, run, pr) {
  if (manifest.stage !== 'final') return { verified: false, reason: 'the manifest is provisional' };
  const p = run?.policy;
  const step = run?.steps?.[0];
  if (!p || p.name !== 'rollup' || !step) return { verified: false, reason: 'no local rollup run is available to check it against' };
  // Only a landing whose read-back VERIFIED (tree equal to the candidate, parent the tested base, message the pinned manifest) establishes provenance.
  const landed = step.outcome?.status === 'landed' && step.outcome.verdict === 'verified' ? step.outcome : null;
  const checks = [
    [p.rollup.repo === pr.repo, 'the repository differs'], [p.rollup.prNumber === pr.number, 'the PR number differs'],
    [Boolean(landed), 'the run has no verified landing'], [landed?.mergeOid === pr.mergeOid, 'the merge oid differs'], [p.rollup.candidate.oid === manifest.candidate?.oid, 'the candidate differs'],
    [p.rollup.branch === manifest.rollupId, 'the rollup id differs'], [Boolean(step.attempt?.messageSha256) && step.attempt.messageSha256 === sha256Body(bodyOfMessage(pr.message)), 'the manifest hash differs'],
  ];
  const bad = checks.find(([ok]) => !ok);
  return bad ? { verified: false, reason: bad[1] } : { verified: true, reason: 'matches the local rollup run' };
}

/** The body of a commit message (everything after the subject line and one blank line). */
export function bodyOfMessage(message) {
  const lines = String(message ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const rest = lines.slice(1);
  if (rest.length && rest[0].trim() === '') rest.shift();
  return rest.join('\n');
}

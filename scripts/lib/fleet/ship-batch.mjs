/**
 * @fileoverview `fleet land --ship-batch` — land the already-shipped members of a batch with ONE coordinator action
 * (docs/plans/coordinator-aggregate-ship.md section 2.4).
 *
 * Each chip shipped itself (`ship-commit.mjs --preauthorised`); this re-verifies each member from durable facts, lands only
 * the members that verify, and leaves the rest open for the user's `/ship`. It extends the train and the serial runner rather
 * than replacing them:
 *
 *   build   grant -> per-member child check (+ CI + identity) -> PARTITION -> the existing train build over the ok members only
 *           -> a sidecar record `fleet/shipbatch/<trainId>.json` (the strict TrainSchema is untouched).
 *   approve the existing serial runner, with three seams this module supplies: `messageFor` (the grant re-read, the base-tip
 *           check, the child re-check and the member's own ship commit message), `onMerged` (the read-back) and `noUpdate`
 *           (a member behind the base is never mutated on the remote).
 *
 * **Provenance is copied, never composed.** The squash message is the head commit's own message; after each merge the squash is
 * read back and its AI-* trailers compared with the head's. Nothing here writes a trailer, and nothing raises a gate: a
 * waived or not-run member is refused by the child check and never reaches a merge.
 *
 * @module scripts/lib/fleet/ship-batch
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync } from '../file-io.mjs';
import { ciVerdict } from '../ci-verdict.mjs';
import { AI_TRAILER_KEYS, parseMessageTrailers } from '../commit-trailers.mjs';
import { assertManaged, fleetDir, readTrain } from './registry.mjs';
import { buildStatusFrom, gatherFacts } from './facts.mjs';
import { describeVerdict, observeRequiredChecks, requiredInventory } from './required-checks.mjs';
import { readShipBatchGrant, GRANT_VERSION } from './coordinator-grant.mjs';
import { approveSerial, resumeSerial } from './serial.mjs';

export const SHIP_BATCH_SCHEMA = 1;
export const CHILD_SCHEMA = 'shipped-head/v1';
const CHILD_TIMEOUT_MS = 120_000;
/** The remote every train is built against (lib/fleet/train.mjs). The built train is checked against it, so a change there fails loudly here. */
const TRAIN_REMOTE = 'origin';

const shipBatchDir = (dir) => path.join(dir, 'shipbatch');
export const shipBatchPath = (dir, trainId) => assertManaged(dir, path.join(shipBatchDir(dir), `${trainId}.json`));
const short = (o) => String(o ?? '?').slice(0, 12);

/** @returns {{ok: true, batch: object} | {ok: false, reason: string, absent?: boolean}} */
const OID_RE_SB = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
export const MEMBER_STATES = Object.freeze(['pending', 'needs-user', 'merge-requested', 'merged', 'verified', 'provenance-lost', 'landed-on-untested-base']);

/** Field-level validation of a sidecar record. @returns {string|null} what is wrong, or null */
export function shipBatchProblem(b, trainId) {
  if (!b || b.schemaVersion !== SHIP_BATCH_SCHEMA || b.trainId !== trainId) return 'the record is malformed or of a version this fleet does not understand';
  if (!Array.isArray(b.members) || !b.members.length || !Array.isArray(b.excluded)) return 'members/excluded are missing';
  if (typeof b.base !== 'string' || !b.base || typeof b.remote !== 'string' || !b.remote) return 'base or remote is missing';
  if (b.expectedTip !== null && !OID_RE_SB.test(String(b.expectedTip))) return 'expectedTip is not a commit id';
  const seen = new Set();
  for (const m of b.members) {
    if (!m || typeof m.id !== 'string' || !m.id || seen.has(m.id)) return `a member has a missing or duplicate id (${JSON.stringify(m?.id)})`;
    seen.add(m.id);
    if (!Number.isInteger(m.prNumber) || m.prNumber < 1 || typeof m.repo !== 'string' || !m.repo) return `member ${m.id}: prNumber/repo are not valid`;
    if (!OID_RE_SB.test(String(m.oid))) return `member ${m.id}: oid is not a commit id`;
    if (!MEMBER_STATES.includes(m.state)) return `member ${m.id}: state ${JSON.stringify(m.state)} is not one of ${MEMBER_STATES.join(', ')}`;
    if (m.mergeOid !== null && !OID_RE_SB.test(String(m.mergeOid))) return `member ${m.id}: mergeOid is not a commit id`;
  }
  return null;
}

/** The record must describe THIS train: every member is one of its sources, at the very head it recorded. */
export function shipBatchTrainProblem(batch, train) {
  for (const m of batch.members) {
    const src = (train.sources ?? []).find((x) => x.id === m.id);
    if (!src) return `member ${m.id} is not a source of the train`;
    if (src.oid !== m.oid) return `member ${m.id}: the record names ${short(m.oid)}, the train tested ${short(src.oid)}`;
    if (src.repo !== m.repo || src.prNumber !== m.prNumber) return `member ${m.id}: the record names ${m.repo}#${m.prNumber}, the train merges ${src.repo}#${src.prNumber}`;
  }
  return null;
}

export function readShipBatch(dir, trainId) {
  let text;
  try { text = fs.readFileSync(shipBatchPath(dir, trainId), 'utf-8'); } catch (e) { return { ok: false, absent: e.code === 'ENOENT', reason: e.code === 'ENOENT' ? 'no ship-batch record' : `unreadable: ${e.message}` }; }
  try {
    const b = JSON.parse(text);
    const why = shipBatchProblem(b, trainId);
    return why ? { ok: false, reason: `the ship-batch record is invalid: ${why}` } : { ok: true, batch: b };
  } catch (e) { return { ok: false, reason: `malformed JSON: ${e.message}` }; }
}

export function writeShipBatch(dir, batch) {
  fs.mkdirSync(shipBatchDir(dir), { recursive: true });
  atomicWriteFileSync(shipBatchPath(dir, batch.trainId), `${JSON.stringify(batch, null, 2)}\n`);
  return batch;
}

/** Patch one member (and optionally the batch's expected base tip) in the sidecar. Returns the updated batch. */
function patchBatch(dir, trainId, memberId, memberPatch, batchPatch = {}) {
  const r = readShipBatch(dir, trainId);
  if (!r.ok) throw new Error(`ship-batch record for ${trainId}: ${r.reason}`);
  const b = { ...r.batch, ...batchPatch, members: r.batch.members.map((m) => (m.id === memberId ? { ...m, ...memberPatch } : m)) };
  return writeShipBatch(dir, b);
}

// ---- the child: `ship-commit.mjs --check-shipped-head` in the member's own worktree -----------------------------------------

/** `<tooling>/ship-commit.mjs`, resolved from THIS module, so it is right in the source repo and in a consumer's `scripts/.claude-skills/`. */
export const shipCommitPath = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ship-commit.mjs');

/**
 * Run the member re-check and read its v1 envelope. Fail closed: a missing worktree, a spawn error, exit 1, a timeout, output
 * that is not exactly one JSON object, another schema, or another head are all REFUSED, each with its own reason.
 *
 * @param {{worktree: string|null, head: string, spawn?: Function, exists?: Function}} a
 * @returns {{ok: boolean, reasons: string[], envelope: object|null}}
 */
export function runShippedHeadChild({ worktree, head, base = null, remote = null, spawn = spawnSync, exists = fs.existsSync }) {
  const no = (reason, envelope = null) => ({ ok: false, reasons: [reason], envelope });
  if (!worktree || !exists(worktree)) return no('evidence-unavailable: the chip worktree is gone, so its local gate-evidence and final-review markers cannot be read');
  const r = spawn(process.execPath, [shipCommitPath(), '--check-shipped-head', '--head', head, ...(base ? ['--base', base] : []), ...(remote ? ['--remote', remote] : []), ...(base && remote ? ['--verify-base'] : []), '--json'], {
    cwd: worktree, encoding: 'utf-8', timeout: CHILD_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) return no(`checker-failed: ${r.error.code === 'ETIMEDOUT' ? `timed out after ${CHILD_TIMEOUT_MS / 1000}s` : r.error.message}`);
  if (r.signal) return no(`checker-failed: killed by ${r.signal}`);
  if (r.status === 1 || (r.status !== 0 && r.status !== 2)) return no(`checker-failed: exit ${r.status} (${String(r.stderr ?? '').trim().split('\n').pop() || 'no message'})`);
  let env;
  try { env = JSON.parse(String(r.stdout ?? '').trim()); } catch { return no('checker-failed: stdout is not exactly one JSON object'); }
  if (env?.schema !== CHILD_SCHEMA) return no(`checker-failed: schema ${JSON.stringify(env?.schema)} is not ${CHILD_SCHEMA}`);
  if (!OID_RE_SB.test(String(head)) || env.head !== head) return no(`checker-failed: it judged ${short(env.head)}, not the full commit ${short(head)} (a prefix is not an identity)`, env);
  if (r.status === 0 && env.ok === true) return { ok: true, reasons: [], envelope: env };
  const refusals = Array.isArray(env.refusals) && env.refusals.length ? env.refusals : ['the checker refused without a reason'];
  return { ok: false, reasons: r.status === 0 ? ['checker-failed: exit 0 but ok is not true', ...refusals] : refusals, envelope: env };
}

// ---- the members ------------------------------------------------------------------------------------------------------------

/** Every ready, landable session in landing order, with what the re-check needs. */
export function listReadyMembers(ctx) {
  const facts = gatherFacts({ cwd: ctx.cwd, config: ctx.config, now: ctx.now, env: ctx.env });
  if (!facts.registry.complete) return { ok: false, reason: `registry incomplete (${facts.registry.invalid.map((i) => i.file).join(', ')}) — a train is never built on partial data` };
  const status = buildStatusFrom(facts);
  const members = status.landingOrder.map((id) => {
    const s = facts.registry.sessions.find((x) => x.id === id);
    // A chip claims a BRANCH; the PR is joined onto it by the status read (head branch + ready oid), exactly as `land`'s own
    // build takes it (`item.pr`), so the PR facts come from there before the session's own (a pr-kind source).
    const pr = status.items.find((i) => i.id === id)?.pr ?? null;
    return {
      id, kind: pr ? 'pr' : s.source.kind, repo: pr?.repo ?? s.source.repo, prNumber: pr?.number ?? s.source.prNumber,
      baseRef: pr?.baseRef ?? s.source.baseRef, branch: s.source.branch, oid: s.ready?.oid ?? null, worktree: s.worktree ?? null,
    };
  });
  return { ok: true, members };
}

/**
 * C8 and C9 for one member, from GitHub: the PR is open, not a draft, and its head is the ready oid (C9); its required checks are
 * green at exactly that head, and where `.test-tiers.json` declares a full-suite workflow, that run is `full` (C8).
 * @returns {string[]} reasons it is not shippable (empty = green)
 */
export function ciAndIdentityReasons({ cwd, member, base, deps, requiredChecks, requiredChecksError = null, ciFn }) {
  const out = [];
  const v = deps.gh(['pr', 'view', String(member.prNumber), '-R', member.repo, '--json', 'state,isDraft,headRefOid,baseRefName'], cwd);
  let doc = null;
  if (v.ok) { try { doc = JSON.parse(v.stdout); } catch { doc = null; } }
  if (!doc) return [`identity: PR #${member.prNumber} cannot be read (${v.reason ?? 'unparseable'})`];
  if (String(doc.state).toUpperCase() !== 'OPEN') out.push(`identity: PR #${member.prNumber} is ${doc.state}, not OPEN`);
  if (doc.isDraft === true) out.push(`identity: PR #${member.prNumber} is a draft`);
  if (doc.baseRefName !== base) out.push(`identity: PR #${member.prNumber} targets ${doc.baseRefName}, not ${base}`);
  if (doc.headRefOid !== member.oid) out.push(`identity: PR #${member.prNumber} head ${short(doc.headRefOid)} is not the ready oid ${short(member.oid)}`);
  if (out.length) return out;
  const inv = requiredInventory(cwd, { repo: member.repo, base, configured: requiredChecks, configError: requiredChecksError, gh: deps.gh });
  const rc = observeRequiredChecks(cwd, { pr: member.prNumber, repo: member.repo, inventory: inv, expectHead: member.oid, gh: deps.gh });
  if (rc.verdict !== 'pass' && rc.verdict !== 'none-required') out.push(`ci: required checks ${describeVerdict(rc)}`);
  // The full-suite workflow `.test-tiers.json` declares grades a merge separately (ciVerdict): where none is declared the
  // verdict says so, and that is "nothing to measure here", never a pass and never a refusal.
  const run = (cmd, args) => spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000, windowsHide: true });
  const cv = (ciFn ?? ((a) => ciVerdict({ run, ...a })))({ pr: member.prNumber, head: member.oid });
  const undeclared = cv.verdict === 'unverified' && /no ciVerdict workflow is declared/.test(String(cv.reason));
  if (cv.verdict !== 'full' && !undeclared) out.push(`ci: the full-suite run is ${cv.verdict} (${cv.reason ?? 'no reason'})`);
  // Each absence alone is honest (no required checks configured; no workflow declared). BOTH together measure nothing at this head.
  if (rc.verdict === 'none-required' && undeclared) out.push('ci: no required checks are configured and no full-suite workflow is declared, so nothing measured CI at this head');
  return out;
}

/**
 * Partition the ready members into ship-ok and needs-user. A member that is not a PR, is stacked or retargeted, or fails any
 * condition is needs-user with every reason; nothing here throws.
 * @returns {{ok: Array<object>, needsUser: Array<{id: string, reasons: string[]}>}}
 */
export function partitionMembers({ cwd, members, base, remote = null, deps, checkChild, requiredChecks, requiredChecksError, ciFn }) {
  const ok = [];
  const needsUser = [];
  for (const m of members) {
    const reasons = [];
    if (m.kind !== 'pr' || !m.prNumber || !m.repo) reasons.push('not-a-pr: a ship-batch lands pull requests; this session is a bare branch');
    else if (m.baseRef && m.baseRef !== base) reasons.push(`stacked: the PR targets ${m.baseRef}, not ${base}`);
    if (!m.oid) reasons.push('no ready oid recorded');
    if (reasons.length === 0) {
      const child = checkChild({ worktree: m.worktree, head: m.oid, base, remote });
      if (!child.ok) reasons.push(...child.reasons);
      reasons.push(...ciAndIdentityReasons({ cwd, member: m, base, deps, requiredChecks, requiredChecksError, ciFn }));
    }
    if (reasons.length) needsUser.push({ id: m.id, prNumber: m.prNumber ?? null, reasons });
    else ok.push(m);
  }
  return { ok, needsUser };
}

// ---- build ------------------------------------------------------------------------------------------------------------------

const refusedResult = (reason, text) => ({ ok: false, code: 'refused', reason, text: text ?? `REFUSED: ${reason}` });

/** Why `--ship-batch` may not run: the grant. One place, called at build, approve, resume and before every merge. */
export function grantRefusal(deps) {
  const g = readShipBatchGrant({ file: deps.shipBatch?.grantFile });
  return g.ok ? null : { code: g.code, reason: `${g.code}: ${g.reason}` };
}

/**
 * `fleet land --ship-batch` (build). `buildFn(ctx, flags, deps)` is land.mjs's own train build, so tests, the tiers and the
 * integration worktree are exactly what a plain `land` runs — over the ship-ok members only.
 */
export function buildShipBatch(ctx, flags, deps, buildFn, { parseSelect }) {
  const { cwd, cmd } = ctx;
  const gr = grantRefusal(deps);
  if (gr) return refusedResult(gr.reason, `REFUSED: ${gr.reason}\n(declaration check, not verified authority: Louis writes the grant in his own ~/.claude/CLAUDE.md; plain \`${cmd} land\` still works with his go-ahead)`);
  // `deps.shipBatch.members` is the in-process test seam for the status read (which needs a real `gh` to join PRs onto branches).
  const listed = deps.shipBatch?.members ? { ok: true, members: deps.shipBatch.members } : listReadyMembers(ctx);
  if (!listed.ok) return refusedResult(listed.reason);
  let members = listed.members;
  if (flags['--select'] !== undefined) {
    const want = new Set(parseSelect(flags['--select']));
    members = members.filter((m) => want.has(m.id));
  }
  if (!members.length) return refusedResult('nothing is ready to land', 'REFUSED: nothing is ready to land (a session must be `ready`, its head not moved since, and ahead of the base)');
  const base = ctx.config.baseBranch;
  const checkChild = deps.shipBatch?.checkChild ?? runShippedHeadChild;
  let rc = {};
  try { rc = { requiredChecks: ctx.config.requiredChecks }; } catch (e) { rc = { requiredChecksError: e.message }; }
  const { ok, needsUser } = partitionMembers({ cwd, members, base, remote: TRAIN_REMOTE, deps, checkChild, ciFn: deps.shipBatch?.ciVerdict, ...rc });
  const needsText = needsUser.map((n) => `  needs-user  ${n.id}${n.prNumber ? ` (PR #${n.prNumber})` : ''}: ${n.reasons.join('; ')}`);
  if (!ok.length) {
    return { ok: false, code: 'refused', reason: 'no member is ship-ok', needsUser, text: `REFUSED: no member is ship-ok — nothing was built, merged or changed\n${needsText.join('\n')}\nEach waits for the user to type /ship in its own session.` };
  }
  // The partition happens BEFORE the integration worktree, so the tested set is the merged set.
  const r = buildFn(ctx, { ...flags, '--select': ok.map((m) => m.id).join(',') }, deps);
  if (!r.ok || !r.trainId) return { ...r, needsUser, text: `${r.text}${needsText.length ? `\n${needsText.join('\n')}` : ''}` };
  const dir = fleetDir(cwd);
  const t = readTrain(dir, r.trainId);
  if (!t.ok) return { ...r, ok: false, code: 'refused', reason: `the built train ${r.trainId} could not be read back (${t.reason})`, text: `REFUSED: the built train ${r.trainId} could not be read back (${t.reason}); no ship-batch record was written, so it cannot be approved with --ship-batch` };
  if (t.train.destination.remote !== TRAIN_REMOTE) return { ...r, ok: false, code: 'refused', reason: `the train targets remote ${t.train.destination.remote}, but its members were verified against ${TRAIN_REMOTE}`, text: `REFUSED: the train targets remote ${t.train.destination.remote}, but its members were verified against ${TRAIN_REMOTE}; no ship-batch record was written` };
  writeShipBatch(dir, {
    schemaVersion: SHIP_BATCH_SCHEMA, trainId: r.trainId, grantVersion: GRANT_VERSION, checkedAt: ctx.now.toISOString(),
    base, remote: t.train.destination.remote,
    expectedTip: t.train.destination.expectedOid,
    members: ok.map((m) => ({ id: m.id, prNumber: m.prNumber, repo: m.repo, oid: m.oid, worktree: m.worktree, state: 'pending', mergeOid: null, note: null })),
    excluded: needsUser,
  });
  const lines = [
    r.text,
    `ship-batch: ${ok.length} member(s) ship-ok, ${needsUser.length} needs-user (excluded BEFORE the build, so the tested set is the merged set)`,
    ...needsText,
    `approve (needs no chat go-ahead only because the grant is present): ${cmd} land --approve ${r.trainId} --ship-batch`,
  ];
  return { ...r, shipBatch: true, needsUser, text: lines.join('\n') };
}

// ---- merge: the seams the serial runner calls -----------------------------------------------------------------------------

/** line 1 = subject; everything after = body with exactly ONE leading blank line removed and trailing whitespace trimmed. Lossless. */
export function splitCommitMessage(message) {
  const lines = String(message ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const subject = lines[0] ?? '';
  const rest = lines.slice(1);
  if (rest.length && rest[0].trim() === '') rest.shift();
  return { subject, body: rest.join('\n').replace(/\s+$/, '') };
}

/** The AI-* trailers of a message as a sorted multiset of `key: value` lines. */
export function aiTrailerMultiset(message) {
  const p = parseMessageTrailers(message);
  return (p.isTrailerBlock ? p.trailers : []).filter((t) => AI_TRAILER_KEYS.includes(t.key)).map((t) => `${t.key}: ${t.value}`).sort();
}

/** Does the squash commit's message carry the head's provenance? Subject (minus a GitHub ` (#N)`), body and the AI-* multiset. */
export function readBackReasons(headMessage, squashMessage) {
  const h = splitCommitMessage(headMessage);
  const s = splitCommitMessage(squashMessage);
  const out = [];
  const strip = (x) => x.replace(/\s\(#\d+\)$/, '');
  if (strip(s.subject) !== strip(h.subject)) out.push(`the squash subject is ${JSON.stringify(s.subject)}, the ship commit's is ${JSON.stringify(h.subject)}`);
  if (h.body && !s.body.replace(/\r\n/g, '\n').includes(h.body)) out.push('the squash body does not contain the ship commit body');
  const a = aiTrailerMultiset(headMessage);
  const b = aiTrailerMultiset(squashMessage);
  if (a.length === 0) out.push('the ship commit has no AI-* trailers to compare');
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`the AI-* trailers differ (ship commit: ${a.join(' | ') || 'none'}; squash: ${b.join(' | ') || 'none'})`);
  return out;
}

/** The hooks the serial runner takes for a ship-batch run. */
export function makeShipBatchHooks({ cwd, dir, trainId, deps, requiredChecks, requiredChecksError = null }) {
  /** Bookkeeping failures the run could not return through the serial runner; withSummary reports them and the result is not ok. */
  const errors = [];
  const checkChild = deps.shipBatch?.checkChild ?? runShippedHeadChild;
  const git = (args) => deps.git(args, cwd, { timeoutMs: 120_000 });
  const message = (oid) => { const r = git(['log', '-1', '--format=%B', oid]); return r.ok ? r.stdout : null; };

  const messageFor = ({ source, headOid, baseOid }) => {
    const gr = grantRefusal(deps);
    if (gr) return { stop: `grant-revoked: ${gr.reason}` };
    const rec = readShipBatch(dir, trainId);
    if (!rec.ok) return { stop: `ship-batch record: ${rec.reason}` };
    const member = rec.batch.members.find((m) => m.id === source.id);
    if (!member) return { stop: `${source.id} is not a ship-batch member` };
    // GLOBAL problems STOP the run (they say something about the base or the grant, and no later member is safer).
    if (!baseOid) return { stop: 'base-moved: the base tip could not be read, so the base progression cannot be verified' };
    if (baseOid !== rec.batch.expectedTip) return { stop: `base-moved: the base is ${short(baseOid)}, the batch expects ${short(rec.batch.expectedTip)} (a commit that is not this batch's own landed): rebuild the train` };
    // MEMBER problems SKIP the member: it waits for the user's /ship, and the members that still verify land.
    const needsUser = (why) => { patchBatch(dir, trainId, member.id, { state: 'needs-user', note: String(why).slice(0, 900) }); return { skip: `needs-user: ${why}` }; };
    if (headOid !== member.oid) return needsUser(`PR #${source.prNumber} head ${short(headOid)} is not the verified ship head ${short(member.oid)}`);
    const c = checkChild({ worktree: member.worktree, head: headOid, base: rec.batch.base, remote: rec.batch.remote });
    if (!c.ok) return needsUser(c.reasons.join('; '));
    // The CI and identity facts at the head that is about to merge: the serial runner waited for the REQUIRED checks, but the
    // full-suite verdict `.test-tiers.json` declares is judged only here and at the build, and it can change in between.
    const live = ciAndIdentityReasons({ cwd, member: { ...member, baseRef: rec.batch.base }, base: rec.batch.base, deps, requiredChecks, requiredChecksError, ciFn: deps.shipBatch?.ciVerdict });
    if (live.length) return needsUser(live.join('; '));
    const msg = message(headOid);
    if (msg === null) return needsUser(`the ship commit ${short(headOid)} is not readable locally, so its message cannot be copied`);
    const { subject, body } = splitCommitMessage(msg);
    if (!subject.trim()) return needsUser('the ship commit has an empty subject');
    patchBatch(dir, trainId, member.id, { state: 'merge-requested' });
    return { subject, body };
  };

  const onMergedInner = ({ source, mergedOid }) => {
    const rec = readShipBatch(dir, trainId);
    if (!rec.ok) return { stop: `ship-batch record: ${rec.reason}` };
    const member = rec.batch.members.find((m) => m.id === source.id);
    if (!member || ['verified', 'provenance-lost', 'landed-on-untested-base'].includes(member.state)) return null;
    if (!mergedOid) { patchBatch(dir, trainId, member.id, { state: 'merged', note: 'merge commit not reported' }); return { stop: `PR #${source.prNumber} merged but GitHub reported no merge commit: verify it by hand` }; }
    const f = git(['fetch', '--no-tags', rec.batch.remote, `refs/heads/${rec.batch.base}`]);
    if (!f.ok) { patchBatch(dir, trainId, member.id, { state: 'merged', mergeOid: mergedOid, note: 'read-back not done' }); return { stop: `PR #${source.prNumber} merged at ${short(mergedOid)} but the base could not be fetched to verify it (${f.reason}) — --resume re-checks it` }; }
    const parents = git(['rev-list', '--parents', '-n', '1', mergedOid]);
    if (!parents.ok) { patchBatch(dir, trainId, member.id, { state: 'merged', mergeOid: mergedOid, note: `read-back not done: ${String(parents.reason ?? 'rev-list failed').slice(0, 200)}` }); return { stop: `PR #${source.prNumber} merged at ${short(mergedOid)} but its parent could not be read (${parents.reason ?? 'rev-list failed'}) — --resume re-checks it` }; }
    const first = parents.stdout.trim().split(/\s+/)[1] ?? null;
    if (first !== rec.batch.expectedTip) {
      patchBatch(dir, trainId, member.id, { state: 'landed-on-untested-base', mergeOid: mergedOid, note: `first parent ${short(first)}, expected ${short(rec.batch.expectedTip)}` });
      return { stop: `landed-on-untested-base: PR #${source.prNumber} landed on ${short(first)}, not the tested ${short(rec.batch.expectedTip)} — a foreign commit reached the base in the merge window; the remaining members need a rebuild` };
    }
    const squash = message(mergedOid);
    const head = message(member.oid);
    // A message that could not be READ is retryable (a stop, state merged); only two messages that were read and differ are a confirmed loss.
    if (squash === null || head === null) { patchBatch(dir, trainId, member.id, { state: 'merged', mergeOid: mergedOid, note: 'read-back not done: a commit message could not be read' }); return { stop: `PR #${source.prNumber} merged at ${short(mergedOid)} but a commit message could not be read to verify it — --resume re-checks it` }; }
    const why = readBackReasons(head, squash);
    // The squash IS the new base tip either way: the merge happened, and the next member's base check starts from it.
    if (why.length) { patchBatch(dir, trainId, member.id, { state: 'provenance-lost', mergeOid: mergedOid, note: why.join('; ').slice(0, 900) }, { expectedTip: mergedOid }); return null; }
    patchBatch(dir, trainId, member.id, { state: 'verified', mergeOid: mergedOid, note: null }, { expectedTip: mergedOid });
    return null;
  };
  const onMerged = (a) => { try { return onMergedInner(a); } catch (e) { errors.push(`${a.source?.id}: read-back failed (${e.message})`); return { stop: `PR #${a.source?.prNumber}: the read-back failed (${e.message}) — --resume re-checks it` }; } };
  const onSkip = ({ source, reason }) => { try { patchBatch(dir, trainId, source.id, { state: 'needs-user', note: String(reason).slice(0, 900) }); } catch (e) { errors.push(`${source.id}: could not record needs-user (${e.message})`); } };
  return { messageFor, onMerged, onSkip, noUpdate: true, shipBatch: true, errors };
}

// ---- approve / resume / summary ---------------------------------------------------------------------------------------------

/** Why the sidecar is not about the train it is filed under, or null. */
function trainMismatch(dir, trainId, batch) {
  const t = readTrain(dir, trainId);
  return t.ok ? shipBatchTrainProblem(batch, t.train) : `the train cannot be read (${t.reason})`;
}

/** `land --approve <train> --ship-batch`. */
export function approveShipBatch({ cwd, dir, trainId, deps, serialOpts }) {
  const gr = grantRefusal(deps);
  if (gr) return refusedResult(gr.reason);
  const rec = readShipBatch(dir, trainId);
  if (!rec.ok) return refusedResult(`train ${trainId} is not a ship-batch train (${rec.reason}): build it with \`land --ship-batch\`, or approve a plain train with the user's go-ahead`);
  const mismatch = trainMismatch(dir, trainId, rec.batch);
  if (mismatch) return refusedResult(`the ship-batch record does not describe train ${trainId}: ${mismatch}`);
  const hooks = makeShipBatchHooks({ cwd, dir, trainId, deps, requiredChecks: serialOpts?.requiredChecks, requiredChecksError: serialOpts?.requiredChecksError });
  return withSummary(approveSerial({ cwd, trainId, deps, ...serialOpts, messageFor: hooks.messageFor, hooks }), dir, trainId, hooks);
}

/** `land --resume <train> --ship-batch`. The grant and the base progression are re-checked before any further merge. */
export function resumeShipBatch({ cwd, dir, trainId, deps, serialOpts }) {
  const gr = grantRefusal(deps);
  if (gr) return refusedResult(gr.reason);
  const rec = readShipBatch(dir, trainId);
  if (!rec.ok) return refusedResult(`train ${trainId} is not a ship-batch train (${rec.reason})`);
  const mismatch = trainMismatch(dir, trainId, rec.batch);
  if (mismatch) return refusedResult(`the ship-batch record does not describe train ${trainId}: ${mismatch}`);
  const hooks = makeShipBatchHooks({ cwd, dir, trainId, deps, requiredChecks: serialOpts?.requiredChecks, requiredChecksError: serialOpts?.requiredChecksError });
  return withSummary(resumeSerial({ cwd, trainId, deps, ...serialOpts, messageFor: hooks.messageFor, hooks }), dir, trainId, hooks);
}

/** Fold the member states into the result and the verdict: a landed batch with a provenance-lost member is NOT ok. */
function withSummary(r, dir, trainId, hooks = null) {
  const rec = readShipBatch(dir, trainId);
  // The record is the per-member truth: if it cannot be read after the run, the summary cannot be honest, so the result is NOT ok.
  if (!rec.ok) return { ...r, ok: false, code: 'refused', reason: `the ship-batch record could not be read after the run (${rec.reason}): per-member outcomes are unknown`, text: `REFUSED: the ship-batch record could not be read after the run (${rec.reason}); per-member outcomes are unknown — check \`fleet land --resume ${trainId} --ship-batch\` and the merged PRs by hand` };
  const { members, excluded } = rec.batch;
  const lost = members.filter((m) => m.state === 'provenance-lost' || m.state === 'landed-on-untested-base');
  const landed = members.filter((m) => ['merged', 'verified', 'provenance-lost', 'landed-on-untested-base'].includes(m.state));
  const bookkeeping = hooks?.errors ?? [];
  const needs = members.filter((m) => m.state === 'needs-user');
  const verified = members.filter((m) => m.state === 'verified');
  const lines = [
    `ship-batch ${trainId}: landed ${landed.length} of ${members.length} ship-ok member(s); needs-user ${excluded.length}`,
    ...members.map((m) => `  ${m.state.padEnd(24)} ${m.id} (PR #${m.prNumber})${m.mergeOid ? ` -> ${short(m.mergeOid)}` : ''}${m.note ? `  [${m.note}]` : ''}`),
    ...excluded.map((n) => `  needs-user               ${n.id}${n.prNumber ? ` (PR #${n.prNumber})` : ''}: ${n.reasons.join('; ')}  -> the user types /ship in that session`),
    ...(bookkeeping.length ? [`bookkeeping failed (the result is not ok): ${bookkeeping.join('; ')}`] : []),
    ...(r.ok && !lost.length ? (needs.length ? [`partial: ${needs.length} member(s) wait for the user's /ship; the rest landed and verified. \`land --resume ${trainId} --ship-batch\` re-checks the waiting ones.`] : []) : r.reason ? [`stopped: ${r.reason}`] : []),
  ];
  // A partial landing (a member waits for the user) is ok when something landed and nothing was lost; nothing landed is not ok.
  const ok = Boolean(r.ok) && lost.length === 0 && bookkeeping.length === 0 && (r.partial ? verified.length > 0 : true);
  return { ...r, ok, code: ok ? 'ok' : (r.code === 'ok' ? 'refused' : r.code ?? 'refused'), ...(ok || r.reason ? {} : { reason: `provenance: ${lost.map((m) => `${m.id} ${m.state}`).join(', ')}` }), shipBatch: { members, excluded }, text: lines.join('\n') };
}

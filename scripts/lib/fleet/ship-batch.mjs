/**
 * @fileoverview `fleet land --ship-batch` — land the already-shipped members of a batch with ONE coordinator action
 * (docs/plans/coordinator-aggregate-ship.md section 2.4), rebuilt on the per-member outcome primitive of the serial runner
 * (docs/plans/ship-batch-member-outcomes.md).
 *
 * Each chip shipped itself (`ship-commit.mjs --preauthorised`); this re-verifies each member from durable facts, lands only
 * the members that verify, and leaves the rest open for the user's `/ship`.
 *
 *   build   grant -> `admitMember` per member -> PARTITION -> the existing train build over the admitted members only
 *           -> a WRITE-ONCE record `fleet/shipbatch/<trainId>.json` (v2, strict; never patched).
 *   approve the existing serial runner with a `policy`: pure decisions (`admit`, `readBack`, `testedTree`, `grantRefusal`) the
 *           loop asks and never writes through. The serial record is the only mutable per-member truth, with one writer.
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
import { z } from 'zod';
import { atomicWriteFileSync } from '../file-io.mjs';
import { AI_TRAILER_KEYS, parseMessageTrailers } from '../commit-trailers.mjs';
import { OID_RE } from './contracts.mjs';
import { assertManaged, fleetDir, readTrain } from './registry.mjs';
import { buildStatusFrom, gatherFacts, payloadFromStatus } from './facts.mjs';
import { describeVerdict, observeRequiredChecks, requiredInventory } from './required-checks.mjs';
import { readShipBatchGrant, GRANT_VERSION } from './coordinator-grant.mjs';
import { approveSerial, readSerial, resumeSerial } from './serial.mjs';
import { summariseRun } from './member-outcome.mjs';

export const SHIP_BATCH_SCHEMA = 2;
export const CHILD_SCHEMA = 'shipped-head/v1';
const CHILD_TIMEOUT_MS = 120_000;
/** The remote every train is built against (lib/fleet/train.mjs). The built train is checked against it, so a change there fails loudly here. */
const TRAIN_REMOTE = 'origin';
const Oid = z.string().regex(OID_RE);

const shipBatchDir = (dir) => path.join(dir, 'shipbatch');
export const shipBatchPath = (dir, trainId) => assertManaged(dir, path.join(shipBatchDir(dir), `${trainId}.json`));
const short = (o) => String(o ?? '?').slice(0, 12);

// ---- the build record: write-once, strict (R1-M7) ---------------------------------------------------------------------------

export const ShipBatchRecordSchema = z.strictObject({
  schemaVersion: z.literal(SHIP_BATCH_SCHEMA), trainId: z.string().min(1), grantVersion: z.string().min(1), checkedAt: z.string().min(1),
  base: z.string().min(1), remote: z.string().min(1), candidateTree: Oid,
  members: z.array(z.strictObject({ id: z.string().min(1), repo: z.string().min(1), prNumber: z.number().int().positive(), oid: Oid, tree: Oid, worktree: z.string().nullable() })).min(1),
  excluded: z.array(z.strictObject({ id: z.string().min(1), prNumber: z.number().int().positive().nullable(), reasons: z.array(z.string()) })),
});

/** The record must describe THIS train: every identity field of every source, the count, and the candidate tree. @returns {string|null} */
export function shipBatchTrainProblem(batch, train) {
  if ((train.sources ?? []).length !== batch.members.length) return `the record names ${batch.members.length} member(s), the train merges ${(train.sources ?? []).length}`;
  for (const m of batch.members) {
    const src = (train.sources ?? []).find((x) => x.id === m.id);
    if (!src) return `member ${m.id} is not a source of the train`;
    if (src.oid !== m.oid) return `member ${m.id}: the record names ${short(m.oid)}, the train tested ${short(src.oid)}`;
    if (src.repo !== m.repo || src.prNumber !== m.prNumber) return `member ${m.id}: the record names ${m.repo}#${m.prNumber}, the train merges ${src.repo}#${src.prNumber}`;
  }
  if (train.candidate?.tree !== batch.candidateTree) return `the record's candidate tree ${short(batch.candidateTree)} is not the train's ${short(train.candidate?.tree)}`;
  return null;
}

/** @returns {{ok: true, batch: object} | {ok: false, reason: string, absent?: boolean}} */
export function readShipBatch(dir, trainId) {
  let text;
  try { text = fs.readFileSync(shipBatchPath(dir, trainId), 'utf-8'); } catch (e) { return { ok: false, absent: e.code === 'ENOENT', reason: e.code === 'ENOENT' ? 'no ship-batch record' : `unreadable: ${e.message}` }; }
  let raw;
  try { raw = JSON.parse(text); } catch (e) { return { ok: false, reason: `malformed JSON: ${e.message}` }; }
  if (raw?.schemaVersion !== SHIP_BATCH_SCHEMA) return { ok: false, reason: `the record is of a version this fleet does not understand (${JSON.stringify(raw?.schemaVersion)})` };
  const r = ShipBatchRecordSchema.safeParse(raw);
  if (!r.success) return { ok: false, reason: `the ship-batch record is invalid: ${r.error.issues.slice(0, 2).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` };
  return r.data.trainId === trainId ? { ok: true, batch: r.data } : { ok: false, reason: 'the record belongs to another train' };
}

/**
 * Create a file that must not exist: the bytes go to a temp file and are published with `link()`, which is atomic and fails with
 * EEXIST instead of replacing anything (the existence check and the write are ONE operation). A write-once record's conflict is
 * `{created: false}`, never an overwrite.
 */
export function createOnly(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text);
  try { fs.linkSync(tmp, file); return { created: true }; } catch (e) { if (e.code === 'EEXIST') return { created: false }; throw e; } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}

/** Write-once: an existing record is never replaced. */
export function writeShipBatch(dir, batch) {
  const rec = ShipBatchRecordSchema.parse(batch);
  fs.mkdirSync(shipBatchDir(dir), { recursive: true });
  if (!createOnly(shipBatchPath(dir, rec.trainId), `${JSON.stringify(rec, null, 2)}\n`).created) throw new Error(`the ship-batch record for ${rec.trainId} already exists and is write-once`);
  return rec;
}

// ---- the child: `ship-commit.mjs --check-shipped-head` in the member's own worktree -----------------------------------------

/** `<tooling>/ship-commit.mjs`, resolved from THIS module, so it is right in the source repo and in a consumer's `scripts/.claude-skills/`. */
export const shipCommitPath = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ship-commit.mjs');

/**
 * Run the member re-check and read its v1 envelope. Fail closed: a missing worktree, a spawn error, exit 1, a timeout,
 * output that is not exactly one JSON object, another schema, or another head are all REFUSED, each with its own reason.
 * @returns {{ok: boolean, reasons: string[], envelope: object|null}}
 */
export function runShippedHeadChild({ worktree, head, base = null, remote = null, spawn = spawnSync, exists = fs.existsSync }) {
  const no = (reason, envelope = null) => ({ ok: false, reasons: [reason], envelope });
  if (!worktree || !exists(worktree)) return no('evidence-unavailable: the chip worktree is gone, so its local gate-evidence and final-review markers cannot be read');
  const r = spawn(process.execPath, [shipCommitPath(), '--check-shipped-head', '--head', head, ...(base ? ['--base', base] : []), ...(remote ? ['--remote', remote] : []), '--json'], {
    cwd: worktree, encoding: 'utf-8', timeout: CHILD_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) return no(`checker-failed: ${r.error.code === 'ETIMEDOUT' ? `timed out after ${CHILD_TIMEOUT_MS / 1000}s` : r.error.message}`);
  if (r.signal) return no(`checker-failed: killed by ${r.signal}`);
  if (r.status === 1 || (r.status !== 0 && r.status !== 2)) return no(`checker-failed: exit ${r.status} (${String(r.stderr ?? '').trim().split('\n').pop() || 'no message'})`);
  let env;
  try { env = JSON.parse(String(r.stdout ?? '').trim()); } catch { return no('checker-failed: stdout is not exactly one JSON object'); }
  if (env?.schema !== CHILD_SCHEMA) return no(`checker-failed: schema ${JSON.stringify(env?.schema)} is not ${CHILD_SCHEMA}`);
  if (!OID_RE.test(String(head)) || env.head !== head) return no(`checker-failed: it judged ${short(env.head)}, not the full commit ${short(head)} (a prefix is not an identity)`, env);
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
      id, gen: s.gen, rev: s.rev, headRepo: pr?.headRepo ?? s.source.headRepo ?? null, kind: pr ? 'pr' : s.source.kind, repo: pr?.repo ?? s.source.repo, prNumber: pr?.number ?? s.source.prNumber,
      baseRef: pr?.baseRef ?? s.source.baseRef, branch: s.source.branch, oid: s.ready?.oid ?? null, worktree: s.worktree ?? null,
    };
  });
  return { ok: true, members, payload: payloadFromStatus(status) };
}

/**
 * C8 and C9 for one member, from GitHub: the PR is open, not a draft, and its head is the member's oid (C9); every REQUIRED check of the
 * base branch is green at exactly that head (C8). There is no separate full-suite verdict here: the required check IS the CI gate, and
 * whether it is the FULL run is the repository's own ruleset (docs/plans/ship-batch-member-outcomes.md, "CI: required checks only").
 * @returns {string[]} reasons it is not shippable (empty = green)
 */
export function ciAndIdentityReasons({ cwd, member, base, deps, requiredChecks, requiredChecksError = null }) {
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
  // A required-check INVENTORY that cannot be established (a config error, an unreadable ruleset) is a persistent problem the member cannot
  // fix by retrying: it refuses. A required check that could not be OBSERVED right now (a failed read) stays an unmeasured fact (not-run).
  if (inv.source === 'unknown') out.push(`ci: the required-check inventory is unknown (${inv.reason ?? 'no reason'})`);
  else if (rc.verdict === 'none-required') out.push(`ci: no required checks are configured on ${base}, so nothing measured CI at this head`);
  else if (rc.verdict !== 'pass') out.push(`ci: required checks ${describeVerdict(rc)}`);
  return out;
}

// ---- admission: ONE predicate for the build and the merge, by mode (R1-F6, R1-H5) -------------------------------------------

/** The head-bound evidence of each admission mode, strict, so evidence cannot be borrowed across modes (§2.3). */
const CandidateSchemas = {
  'ship-batch': z.strictObject({ mode: z.literal('ship-batch'), head: Oid, child: z.any(), identityAndCi: z.array(z.string()) }),
  rollup: z.strictObject({ mode: z.literal('rollup'), head: Oid, child: z.any(), branchTip: Oid.nullable() }),
};

/**
 * `admitMember(mode, invariant, candidate)`. Both inputs are gathered by the caller AT the head being judged:
 *  - `invariant`: fixed for the batch: `{base, remote}`;
 *  - `candidate`: `{mode, head, child, ...}` bound to that head (`identityAndCi` for a ship-batch member, `branchTip` for a rollup member).
 * @returns {{ok: true} | {ok: false, kind: 'shipped-head-refused'|'ci-refused'|'pr-unreadable', reasons: string[]}}
 */
export function admitMember(mode, invariant, candidate) {
  const schema = CandidateSchemas[mode];
  if (!schema) throw new Error(`unknown admission mode ${JSON.stringify(mode)}`);
  const c = schema.parse(candidate);
  if (!invariant?.base || !invariant?.remote) throw new Error('admission needs the invariant base and remote');
  if (!c.child.ok) return { ok: false, kind: 'shipped-head-refused', reasons: c.child.reasons };
  if (mode === 'ship-batch') {
    // A PR that could not be READ is an unmeasured fact (not-run), never a measured refusal (F4): it is retried, not refused.
    if (c.identityAndCi.some((r) => /^identity: PR #\d+ cannot be read|^ci: required checks .*\bunknown\b/.test(r))) return { ok: false, kind: 'pr-unreadable', reasons: c.identityAndCi };
    return c.identityAndCi.length ? { ok: false, kind: 'ci-refused', reasons: c.identityAndCi } : { ok: true };
  }
  return c.branchTip === c.head ? { ok: true } : { ok: false, kind: 'shipped-head-refused', reasons: [`branch-moved: the remote branch is ${short(c.branchTip)}, not the admitted head ${short(c.head)}`] };
}

/** Gather a ship-batch candidate at `head` (child, identity and required checks), then judge it with `admitMember`. */
export function admitShipBatchMember({ cwd, member, head, base, remote, deps, requiredChecks, requiredChecksError }) {
  const checkChild = deps.shipBatch?.checkChild ?? runShippedHeadChild;
  const child = checkChild({ worktree: member.worktree, head, base, remote });
  const identityAndCi = child.ok ? ciAndIdentityReasons({ cwd, member: { ...member, oid: head }, base, deps, requiredChecks, requiredChecksError }) : [];
  return admitMember('ship-batch', { base, remote }, { mode: 'ship-batch', head, child, identityAndCi });
}

/**
 * Partition the ready members into admitted and needs-user. A member that is not a PR, is stacked or retargeted, or fails any
 * condition is needs-user with every reason; nothing here throws.
 * @returns {{ok: Array<object>, needsUser: Array<{id: string, prNumber: number|null, reasons: string[]}>}}
 */
export function partitionMembers({ cwd, members, base, remote = null, deps, requiredChecks, requiredChecksError }) {
  const ok = [];
  const needsUser = [];
  for (const m of members) {
    const reasons = [];
    if (m.kind !== 'pr' || !m.prNumber || !m.repo) reasons.push('not-a-pr: a ship-batch lands pull requests; this session is a bare branch');
    else if (m.baseRef && m.baseRef !== base) reasons.push(`stacked: the PR targets ${m.baseRef}, not ${base}`);
    if (!m.oid) reasons.push('no ready oid recorded');
    if (reasons.length === 0) {
      const a = admitShipBatchMember({ cwd, member: m, head: m.oid, base, remote, deps, requiredChecks, requiredChecksError });
      if (!a.ok) reasons.push(...a.reasons);
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
 * integration worktree are exactly what a plain `land` runs — over the admitted members only.
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
  let rc = {};
  try { rc = { requiredChecks: ctx.config.requiredChecks }; } catch (e) { rc = { requiredChecksError: e.message }; }
  const { ok, needsUser } = partitionMembers({ cwd, members, base, remote: TRAIN_REMOTE, deps, ...rc });
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
  if (!t.train.candidate?.tree) return { ...r, ok: false, code: 'refused', reason: 'the built train has no candidate tree', text: 'REFUSED: the built train has no candidate tree, so the combined-tested tree cannot be recorded; no ship-batch record was written' };
  const trees = ok.map((m) => deps.git(['rev-parse', `${m.oid}^{tree}`], cwd, { timeoutMs: 60_000 }));
  const bad = trees.findIndex((x) => !x.ok);
  if (bad >= 0) return { ...r, ok: false, code: 'refused', reason: `the tree of ${ok[bad].id} could not be read`, text: `REFUSED: the tree of member ${ok[bad].id} (${short(ok[bad].oid)}) could not be read; no ship-batch record was written` };
  writeShipBatch(dir, {
    schemaVersion: SHIP_BATCH_SCHEMA, trainId: r.trainId, grantVersion: GRANT_VERSION, checkedAt: ctx.now.toISOString(), base, remote: t.train.destination.remote,
    candidateTree: t.train.candidate.tree,
    members: ok.map((m, i) => ({ id: m.id, repo: m.repo, prNumber: m.prNumber, oid: m.oid, tree: trees[i].stdout.trim(), worktree: m.worktree })),
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

// ---- the commit message, and the read-back ------------------------------------------------------------------------------------

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

/** The AI-Gate value of a message, or null. */
export function gateOfMessage(message) {
  const p = parseMessageTrailers(message);
  return (p.isTrailerBlock ? p.trailers : []).find((t) => t.key === 'AI-Gate')?.value ?? null;
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

/** `git log -1 --format=%B <oid>`, or null when it cannot be read. */
export const commitMessage = (deps, cwd, oid) => { const r = deps.git(['log', '-1', '--format=%B', oid], cwd, { timeoutMs: 120_000 }); return r.ok ? r.stdout : null; };

/**
 * The measured read-back of one merge (pure of the run; reads git): the squash's first parent and tree, its message against the
 * head's, the AI-Gate it carries, and the PR's base. A read that fails is `{measured: false, why}`, never a verdict (F4).
 */
export function measureReadBack({ cwd, deps, remote, base, headOid, mergeOid, doc }) {
  const git = (args) => deps.git(args, cwd, { timeoutMs: 120_000 });
  const f = git(['fetch', '--no-tags', remote, `refs/heads/${base}`]);
  if (!f.ok) return { measured: false, why: `the base could not be fetched (${f.reason})` };
  const parents = git(['rev-list', '--parents', '-n', '1', mergeOid]);
  if (!parents.ok) return { measured: false, why: `the parent of ${short(mergeOid)} could not be read (${parents.reason ?? 'rev-list failed'})` };
  const tree = git(['rev-parse', `${mergeOid}^{tree}`]);
  if (!tree.ok) return { measured: false, why: `the tree of ${short(mergeOid)} could not be read` };
  const squash = commitMessage(deps, cwd, mergeOid);
  const head = commitMessage(deps, cwd, headOid);
  if (squash === null || head === null) return { measured: false, why: 'a commit message could not be read' };
  return {
    measured: true, firstParent: parents.stdout.trim().split(/\s+/)[1] ?? null, tree: tree.stdout.trim(),
    reasons: readBackReasons(head, squash), gate: gateOfMessage(squash), baseRefName: doc?.baseRefName ?? null,
  };
}

// ---- the policy: pure decisions the serial loop asks, and never writes through ---------------------------------------------

/**
 * The ship-batch policy: `persisted` is the block approve writes into the serial record; the functions are what the loop asks.
 * Nothing here writes. @param {{cwd: string, dir: string, trainId: string, deps: object, rec: object, train: object, requiredChecks?: string[], requiredChecksError?: string|null}} a
 */
export function makeShipBatchPolicy({ cwd, trainId, deps, rec, train, requiredChecks, requiredChecksError = null }) {
  return {
    name: 'ship-batch',
    treeIdentity: true,
    persisted: {
      name: 'ship-batch', grantVersion: rec.grantVersion, remote: rec.remote, candidateTree: rec.candidateTree, baseChain: [train.destination.expectedOid],
      members: Object.fromEntries(rec.members.map((m) => [m.id, { tree: m.tree, worktree: m.worktree }])), excluded: rec.excluded,
    },
    grantRefusal: () => grantRefusal(deps),
    testedTree: (run, s) => run.policy.members[s.id]?.tree ?? null,
    admit: ({ s, h, run }) => {
      const m = run.policy.members[s.id];
      const a = admitShipBatchMember({ cwd, member: { id: s.id, prNumber: s.prNumber, repo: s.repo, worktree: m?.worktree ?? null }, head: h, base: run.base, remote: run.remote, deps, requiredChecks, requiredChecksError });
      if (!a.ok) return { ok: false, kind: a.kind, reason: a.reasons.join('; ') };
      const msg = commitMessage(deps, cwd, h);
      if (msg === null) return { ok: false, kind: 'message-unreadable', reason: `the ship commit ${short(h)} is not readable locally, so its message cannot be copied` };
      const { subject, body } = splitCommitMessage(msg);
      if (!subject.trim()) return { ok: false, kind: 'message-invalid', reason: 'the ship commit has an empty subject' };
      return { ok: true, message: { subject, body } };
    },
    readBack: ({ s, mergeOid, doc, run }) => measureReadBack({ cwd, deps, remote: run.remote, base: run.base, headOid: s.attempt?.head ?? s.head, mergeOid, doc }),
  };
}

// ---- approve / resume / summary ---------------------------------------------------------------------------------------------

/** Why the build record is not about the train it is filed under, or null. */
function trainMismatch(dir, trainId, batch) {
  const t = readTrain(dir, trainId);
  return t.ok ? shipBatchTrainProblem(batch, t.train) : `the train cannot be read (${t.reason})`;
}

/** The per-member lines and the first line of the result, from the SERIAL RECORD only (§2.4). */
export function summaryText(run, trainId, extra = [], label = 'ship-batch') {
  const members = run.steps;
  const res = run.finalized?.result ?? summariseRun(run, { tailTree: null, stoppedReason: run.outcome?.status === 'stopped' ? run.outcome.reason : null });
  const lines = [
    ...res.provenance, `${label} ${trainId}: ${res.first}`,
    ...members.map((m) => {
      const o = m.outcome;
      const what = o ? `${o.status}/${o.code}${o.verdict ? `/${o.verdict}` : ''}` : `${m.step}`;
      return `  ${what.padEnd(34)} ${m.id} (PR #${m.prNumber})${o?.attribution === 'unknown' ? '  [attribution: unknown]' : ''}${o?.gate ? `  AI-Gate: ${o.gate}` : ''}${o?.mergeOid ? ` -> ${short(o.mergeOid)}` : ''}${o?.reason ? `  [${o.reason}]` : ''}`;
    }),
    ...(run.policy?.excluded ?? []).map((n) => `  needs-user${' '.repeat(24)} ${n.id}${n.prNumber ? ` (PR #${n.prNumber})` : ''}: ${n.reasons.join('; ')}  -> the user types /ship in that session`),
    ...res.tails, ...extra,
  ];
  return { res, text: lines.join('\n') };
}

/** Fold the serial run into the result: the verdict is the run's own, and the text is rendered from the serial record only. */
function withSummary(r, dir, trainId) {
  const rd = readSerial(dir, trainId);
  if (!rd.ok) return { ...r, ok: false, code: 'refused', reason: r.reason ?? `the serial record could not be read after the run (${rd.reason})`, text: `REFUSED: ${r.reason ?? rd.reason}` };
  const { res, text } = summaryText(rd.run, trainId, !rd.run.finalized && r.reason ? [`stopped: ${r.reason}`] : []);
  const ok = Boolean(r.ok);
  return {
    ...r, ok, code: ok ? 'ok' : (r.code && r.code !== 'ok' ? r.code : 'refused'), ...(ok || r.reason ? {} : { reason: res.first }),
    shipBatch: { members: rd.run.steps.map((m) => ({ id: m.id, prNumber: m.prNumber, step: m.step, outcome: m.outcome ?? null })), excluded: rd.run.policy?.excluded ?? [] }, text,
  };
}

function preflight({ dir, trainId, deps }) {
  const gr = grantRefusal(deps);
  if (gr) return refusedResult(gr.reason);
  const rec = readShipBatch(dir, trainId);
  if (!rec.ok) return refusedResult(`train ${trainId} is not a ship-batch train (${rec.reason}): build it with \`land --ship-batch\`, or approve a plain train with the user's go-ahead`);
  const t = readTrain(dir, trainId);
  if (!t.ok) return refusedResult(`the train ${trainId} cannot be read (${t.reason})`);
  const mismatch = shipBatchTrainProblem(rec.batch, t.train);
  if (mismatch) return refusedResult(`the ship-batch record does not describe train ${trainId}: ${mismatch}`);
  return { ok: true, rec: rec.batch, train: t.train };
}

/** `land --approve <train> --ship-batch`. */
export function approveShipBatch({ cwd, dir, trainId, deps, serialOpts }) {
  const p = preflight({ dir, trainId, deps });
  if (!p.ok) return p;
  const policy = makeShipBatchPolicy({ cwd, trainId, deps, rec: p.rec, train: p.train, requiredChecks: serialOpts?.requiredChecks, requiredChecksError: serialOpts?.requiredChecksError });
  return withSummary(approveSerial({ cwd, trainId, deps, ...serialOpts, policy }), dir, trainId);
}

/** `land --resume <train> --ship-batch`. The grant and the base progression are re-checked before any further merge. */
export function resumeShipBatch({ cwd, dir, trainId, deps, serialOpts }) {
  const rd = readSerial(dir, trainId);
  // A fully finalized run is a historical summary: it needs no grant, no rules and no remote read (R3-M1).
  const finalized = rd.ok && rd.run.finalized;
  const p = finalized ? null : preflight({ dir, trainId, deps });
  if (p && !p.ok) return p;
  const rec = readShipBatch(dir, trainId);
  const t = readTrain(dir, trainId);
  if (!rec.ok || !t.ok) return refusedResult(`train ${trainId} is not a ship-batch train (${rec.ok ? t.reason : rec.reason})`);
  const policy = makeShipBatchPolicy({ cwd, trainId, deps, rec: rec.batch, train: t.train, requiredChecks: serialOpts?.requiredChecks, requiredChecksError: serialOpts?.requiredChecksError });
  return withSummary(resumeSerial({ cwd, trainId, deps, ...serialOpts, policy }), dir, trainId);
}

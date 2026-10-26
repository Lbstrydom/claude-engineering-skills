/**
 * @fileoverview Pure logic for the AI-* commit provenance trailers
 * (plan: docs/plans/provenance-trailers-and-gate-honesty.md §F1).
 *
 * No I/O beyond an injectable fs for evidence reads — the CLI seam
 * (scripts/ship-commit.mjs) owns process concerns (git, exit codes).
 *
 * Trailer schema (v1): AI-Skill, AI-Models, AI-Gate, conditional AI-Run-ID and
 * AI-Audited-Tree (the latter only on a verified `passed`), plus the derived,
 * conditional AI-Final-Review and AI-Ship-Authority.
 * The AI-* namespace is RESERVED: agent-supplied AI-* trailers in a commit
 * message are rejected, never merged — the helper is the only writer.
 *
 * @module scripts/lib/commit-trailers
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveAndClassify } from './sensitive-paths.mjs';
import { GIT_OBJECT_ID_RE } from './worktree-identity.mjs';
import { isWorkItemId } from './ledger/work-item.mjs';

export const GATE_VALUES = Object.freeze(['passed', 'converged', 'waived', 'not-run']);

/**
 * Every reserved key `formatTrailerBlock` can emit, canonically spelled, in block order. The ONE list readers canonicalise
 * against (ship-train verify), so adding a key here is the only edit a reader needs; a test pins the renderer to it.
 */
export const AI_TRAILER_KEYS = Object.freeze([
  'AI-Skill', 'AI-Models', 'AI-Gate', 'AI-Run-ID', 'AI-Work-Item', 'AI-Audited-Tree', 'AI-Final-Review', 'AI-Ship-Authority',
]);

/**
 * `AI-Final-Review` values, keyed by the final-review disposition they render (the round gate's own spelling uses `_`; git
 * trailer values here use `-`, like `not-run`). A null-prototype map, so `Object.hasOwn` is the only way in.
 */
export const FINAL_REVIEW_TRAILER_VALUES = Object.freeze(Object.assign(Object.create(null), {
  approve: 'approve', approve_with_debt: 'approve-with-debt', blocked: 'blocked',
}));

/**
 * The gates whose claim is VERIFIED rather than declared: both require
 * content-verifiable evidence (see `isContentVerifiable` — fresh, or stale
 * with a recorded audited-tree identity), a resolvable comparand, and the
 * store's convergence verdict. They differ only in the tree comparison —
 * `passed` is `committedTree === auditedTree`, `converged` is `!==` — which
 * makes them mutually exclusive halves of one condition rather than two
 * policies.
 *
 * `converged` exists because that condition's `!==` half was previously
 * unlabelled: an audit that ran, converged, and had its findings FIXED moves
 * the tree by construction, so `passed` was unreachable and `not-run` illegal
 * (fresh evidence), leaving only `waived` — which means "shipped past a gate".
 * Measured over this repo's history at the time: 647 not-run, 86 waived, 2
 * passed. `/ship`'s own mandatory doc steps move the tree too, so even a
 * zero-finding converged audit lost `passed`.
 *
 * What `converged` does NOT claim, deliberately: that the delta is
 * findings-derived (nothing checks that — hence not `remediated`), or that
 * the audit ran in this operator session. It used to also disclaim "no
 * foreign commit intervened", on the theory that committer timestamps are
 * user-controlled and non-monotonic — but a foreign commit landing after a
 * genuine audit only ever moves `resolveEvidence`'s wall-clock verdict to
 * `stale`, and `isContentVerifiable` now lets content identity settle it
 * instead when an audited-tree is on record (upstream report 55b7460c: this
 * used to force `not-run` on commits that were, in substance, fully audited).
 *
 * Plan: docs/plans/gate-taxonomy-remediated-ships.md §2.
 */
const VERIFIED_GATES = Object.freeze(['passed', 'converged']);
export const MODEL_TOKEN_RE = /^[a-z][a-z0-9.-]*$/;
export const RUN_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/**
 * A git object id (sha-1 tree/commit). Validated rather than trusted so a
 * malformed `auditedTree` degrades to "no identity" → `passed` refused, instead
 * of being compared as an opaque string that could never match anyway.
 *
 * Re-export of the ONE git object-id contract (worktree-identity.mjs).
 *
 * Kept as a named export because existing callers and tests import
 * `TREE_ID_RE` from here, but it is no longer a second definition: the marker's
 * `auditedSha` is compared against this by the reader and against the same
 * matcher by the identity oracle, so a divergence between two copies would let
 * one side accept an id the other rejects.
 */
export const TREE_ID_RE = GIT_OBJECT_ID_RE;
export const SKILL_NAME_RE = /^[a-z][a-z0-9-]*$/;
export const RESERVED_TRAILER_RE = /^AI-[A-Za-z0-9-]*\s*:/i;

/**
 * Whether this evidence can still be checked against committed content even
 * though `resolveEvidence`'s wall-clock check called it stale. `fresh` answers
 * "when" (evidence timestamp vs HEAD's committer time) — an unrelated commit
 * landing on the branch after a genuinely converged audit advances HEAD's
 * timestamp and flips this to stale even though the AUDITED FILES are
 * untouched (upstream report 55b7460c). `auditedTree` answers "what": it is
 * the same content identity `evaluateGateVerification` already compares
 * against `committedTree`, so when it is present, content — not timestamp
 * ordering — is the authoritative signal. Evidence with no recorded
 * `auditedTree` (pre-E1) has no content fallback, so staleness there still
 * means "not-run"; this never makes a `passed`/`converged` claim easier to
 * earn, it only lets already-fail-closed content comparison run instead of
 * being pre-empted by an unrelated commit's timestamp.
 */
export function isContentVerifiable(evidence) {
  if (!evidence) return false;
  if (evidence.state === 'fresh') return true;
  return evidence.state === 'stale' && !!evidence.auditedTree;
}

const MESSAGE_FILE_EXAMPLE = '--message-file .claude/tmp/ship-commit-msg-1784022000000.txt';

/**
 * Canonicalise a --models value: split CSV, trim, lowercase, dedupe, sort.
 * @param {string} raw
 * @returns {{ok: true, models: string[]} | {ok: false, bad: string}}
 */
export function canonicaliseModels(raw) {
  const tokens = String(raw ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0) return { ok: false, bad: String(raw ?? '') };
  for (const t of tokens) {
    if (!MODEL_TOKEN_RE.test(t)) return { ok: false, bad: raw };
  }
  return { ok: true, models: [...new Set(tokens)].sort() };
}

/**
 * Locate the trailer block of a commit message per git semantics: the LAST
 * paragraph, and only if every line in it parses as `Key: value` (with
 * whitespace-led continuation lines folding into the previous trailer).
 *
 * @param {string} text
 * @returns {{isTrailerBlock: boolean, trailers: Array<{key: string, value: string, line: number}>}}
 */
export function parseMessageTrailers(text) {
  const normalised = String(text ?? '').replace(/\r\n/g, '\n');
  const lines = normalised.split('\n');
  // Trim trailing blank lines to find the real last paragraph.
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  if (end === 0) return { isTrailerBlock: false, trailers: [] };
  let start = end - 1;
  while (start > 0 && lines[start - 1].trim() !== '') start--;
  // A trailer block cannot be the whole message (the subject is not a trailer).
  if (start === 0) return { isTrailerBlock: false, trailers: [] };

  const trailers = [];
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (/^\s+\S/.test(line) && trailers.length > 0) {
      trailers[trailers.length - 1].value += ` ${line.trim()}`;
      continue;
    }
    const m = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) return { isTrailerBlock: false, trailers: [] };
    trailers.push({ key: m[1], value: m[2].trim(), line: i + 1 });
  }
  return { isTrailerBlock: true, trailers };
}

/**
 * Find reserved AI-* trailers in the message's trailer block.
 * @param {string} text
 * @returns {Array<{key: string, value: string, line: number}>}
 */
export function findReservedTrailers(text) {
  const { isTrailerBlock, trailers } = parseMessageTrailers(text);
  if (!isTrailerBlock) return [];
  return trailers.filter((t) => RESERVED_TRAILER_RE.test(`${t.key}:`));
}

/**
 * Resolve audit evidence per the §F1.3b table.
 *
 * @param {object} opts
 * @param {string} opts.auditRunPath — absolute path to .audit/last-audit-run.json
 * @param {number} opts.headCommitTs — HEAD committer time, epoch SECONDS (0 for unborn HEAD)
 * @param {boolean} [opts.noRunId] — explicit --no-run-id opt-out
 * @param {typeof fs} [opts.fsMod] — injectable for tests
 * @returns {{state: 'fresh'|'absent'|'stale'|'malformed'|'unreadable'|'opted-out', runId: string|null, ts: string|null, errno?: string}}
 */
export function resolveEvidence({ auditRunPath, headCommitTs, noRunId = false, fsMod = fs }) {
  if (noRunId) return { state: 'opted-out', runId: null, ts: null };
  let raw;
  try {
    raw = fsMod.readFileSync(auditRunPath, 'utf-8');
  } catch (e) {
    // Only the expected not-found condition means "no audit ran". Any other
    // failure (EACCES, EISDIR, ELOOP, …) means evidence EXISTS but cannot be
    // read — collapsing that into `absent` would dishonestly legalise
    // `not-run` (R2 H2/H5). Fail closed as a distinct state.
    if (e && e.code === 'ENOENT') return { state: 'absent', runId: null, ts: null };
    return { state: 'unreadable', runId: null, ts: null, errno: e?.code || 'UNKNOWN' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'malformed', runId: null, ts: null };
  }
  const runId = typeof parsed?.runId === 'string' ? parsed.runId : null;
  const ts = typeof parsed?.ts === 'string' ? parsed.ts : null;
  const evidenceMs = ts ? Date.parse(ts) : NaN;
  if (!runId || !RUN_ID_RE.test(runId) || Number.isNaN(evidenceMs)) {
    return { state: 'malformed', runId: null, ts };
  }
  // The audited-target identity (E1). Surfaced but NOT required for a valid
  // marker: a pre-E1 pointer is well-formed evidence that an audit ran, and
  // still legitimately supports `not-run`/`waived`. It simply cannot support
  // `passed` — that refusal lives in evaluateGateVerification, so introducing
  // the field can never retroactively legitimise unbound historical evidence.
  const auditedTree = TREE_ID_RE.test(parsed?.auditedTree ?? '') ? parsed.auditedTree : null;
  const auditedSha = TREE_ID_RE.test(parsed?.auditedSha ?? '') ? parsed.auditedSha : null;
  const fresh = evidenceMs > headCommitTs * 1000;
  // `round` is surfaced for the pre-authorised ship check, which binds the final review to the round it approved
  // (lib/ship-preauth.mjs). Never required: a marker without it is still valid evidence that an audit ran.
  const round = Number.isInteger(parsed?.round) ? parsed.round : null;
  const result = { state: fresh ? 'fresh' : 'stale', runId, ts, auditedTree, auditedSha, round };
  // `auditedBranch` is forwarded by PRESENCE, and the property is only DEFINED
  // on the result when the marker carried it. That distinction is the contract:
  // an explicit `null` means "detached at capture" — a COMPLETE identity bundle —
  // while the property being ABSENT means the marker predates the bundle and can
  // only support a sha, which `resolveExpectedIdentity` refuses as
  // `pre-bundle-evidence`. A `?? null` here would collapse the two and silently
  // turn every legacy marker into a detached expectation.
  if (Object.hasOwn(parsed ?? {}, 'auditedBranch')) {
    const raw = parsed.auditedBranch;
    if (raw === null) {
      result.auditedBranch = null;                 // detached at capture
    } else if (typeof raw === 'string' && raw.trim()) {
      result.auditedBranch = raw.trim();           // attached at capture
    }
    // A PRESENT-but-malformed value (a number, an empty string) is deliberately
    // left OFF the result. Coercing it to `null` would manufacture a valid
    // "detached" bundle out of corrupt input — the one reading that cannot be
    // right. Omitting the property makes the marker read as pre-bundle
    // evidence, which refuses rather than guesses.
  }
  return result;
}

/**
 * Is this audit marker evidence for THIS branch's history? (fleet p-20261015130416-f9f9)
 *
 * `resolveEvidence` answers "when" (and what the marker records); nothing compared what it RECORDS to the commit being made.
 * On 2026-10-15 a marker written by the audit of branch A was stamped, as `AI-Gate: converged` plus A's `AI-Run-ID`, onto a
 * commit on branch B: the caller's own `--expect-*` flags matched the worktree, and the marker was never asked. A marker
 * that names a different branch, or an audited sha that is not an ancestor of HEAD, describes some OTHER code.
 *
 * Narrow on purpose: a legacy marker with no `auditedBranch`/`auditedSha` is not judged (it can only support not-run/waived,
 * never `passed`), and `auditedBranch: null` (captured detached) is not a mismatch. Absent/opted-out/malformed evidence is
 * handled elsewhere. A rebase moves the audited sha out of HEAD's history, so a rebased branch's marker is refused unless the
 * caller passes `patchEquivalence` and it says the branch's own patches ARE the audited commits' (range-diff equivalence,
 * lib/patch-equivalence.mjs - the SAME predicate the pre-push hook's audit reuse asks; fleet p-...-f757): then the marker is accepted
 * and the result says `equivalence`, so the caller can print that the evidence is for equivalent patches, not for this history.
 * Without it the conservative direction stands (the ship records `not-run`, which is true of the rebased tree). The gate that
 * follows still compares trees, so an accepted-by-equivalence marker supports `converged` (tree differs), never `passed`.
 *
 * @param {{evidence: object, committingBranch: string|null, isAncestor: (sha: string) => boolean, patchEquivalence?: (auditedSha: string, auditedTree: string|null) => {equivalent: boolean, commits?: number, reason?: string}}} input
 * @returns {{ok: true, equivalence?: {kind: 'range-diff', commits: number, auditedSha: string}} | {ok: false, reason: 'branch-mismatch'|'sha-not-ancestor', detail: string}}
 */
export function checkEvidenceProvenance({ evidence, committingBranch, isAncestor, patchEquivalence }) {
  if (!evidence || (evidence.state !== 'fresh' && evidence.state !== 'stale')) return { ok: true };
  if (typeof evidence.auditedBranch === 'string' && evidence.auditedBranch !== committingBranch) {
    return {
      ok: false,
      reason: 'branch-mismatch',
      detail: `the marker was written by an audit of branch ${evidence.auditedBranch}, but this commit is on ${committingBranch ?? '(detached HEAD)'}`,
    };
  }
  if (evidence.auditedSha && !isAncestor(evidence.auditedSha)) {
    const eq = typeof patchEquivalence === 'function' ? patchEquivalence(evidence.auditedSha, evidence.auditedTree ?? null) : null;
    if (eq?.equivalent === true) return { ok: true, equivalence: { kind: 'range-diff', commits: eq.commits ?? 0, auditedSha: evidence.auditedSha } };
    const why = eq && eq.equivalent === false ? ` (and the branch's own patches are not range-diff-equivalent to it: ${eq.reason})` : '';
    return {
      ok: false,
      reason: 'sha-not-ancestor',
      detail: `the audited commit ${evidence.auditedSha.slice(0, 12)} is not an ancestor of HEAD, so the audit did not run on this history${why}`,
    };
  }
  return { ok: true };
}

/** The line ship-commit prints when a marker is accepted by patch equivalence rather than by ancestry. */
export function describeEquivalenceAcceptance({ auditedSha, commits }) {
  return `ship-commit: audit evidence accepted as RANGE-DIFF-EQUIVALENT: the audited commit ${auditedSha.slice(0, 12)} is no longer in this history (a rebase or cherry-pick), but this branch's ${commits} own commit(s) have exactly the content fingerprints of the commits that run audited. The gate still compares trees, so this supports converged, never passed.`;
}

/**
 * Message-file safety (Gemini G1): must resolve inside repoRoot and must not
 * classify as sensitive. Delegates to the canonical classifier (fail-closed).
 *
 * @param {string} messageFile — as supplied on the CLI
 * @param {{repoRoot: string, fsMod?: typeof fs}} opts
 * @returns {null | {reason: 'escapes-repo'|'sensitive'|'unresolvable'}}
 */
export function checkMessageFileSafety(messageFile, { repoRoot, fsMod }) {
  const verdict = resolveAndClassify(messageFile, { repoRoot, ...(fsMod ? { fs: fsMod } : {}) });
  if (verdict.escapedRepo) return { reason: 'escapes-repo' };
  if (verdict.resolutionFailed) return { reason: 'unresolvable' };
  if (verdict.category === 'sensitive') return { reason: 'sensitive' };
  // Extra belt: an absolute input outside the repo that somehow classified
  // clean is still rejected by containment on the raw resolve.
  const abs = path.isAbsolute(messageFile) ? messageFile : path.resolve(repoRoot, messageFile);
  const rel = path.relative(path.resolve(repoRoot), abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { reason: 'escapes-repo' };
  return null;
}

/**
 * Validate the full trailer input. Pure — evidence is passed in, not read.
 *
 * @param {object} input — { skill, modelsRaw, gate, messageText|null, evidence }
 * @param {{skillNames: string[]}} ctx
 * @returns {{ok: boolean, errors: Array<{field: string, custom?: string, expected?: string, got?: string, example?: string}>, values: {skill?: string, models?: string[], gate?: string, runId?: string|null}}}
 */
export function validateTrailerInput(input, { skillNames }) {
  const errors = [];
  const values = {};
  const sortedSkills = [...skillNames].sort();

  // --skill
  const skill = String(input.skill ?? '').trim().toLowerCase();
  if (!SKILL_NAME_RE.test(skill) || !skillNames.includes(skill)) {
    errors.push({
      field: '--skill',
      expected: `one of [${sortedSkills.join('|')}] (skills/ directory names)`,
      got: String(input.skill ?? ''),
      example: '--skill ship',
    });
  } else {
    values.skill = skill;
  }

  // --models
  const models = canonicaliseModels(input.modelsRaw);
  if (!models.ok) {
    errors.push({
      field: '--models',
      expected: 'comma-separated tokens matching ^[a-z][a-z0-9.-]*$',
      got: String(input.modelsRaw ?? ''),
      example: '--models claude,gpt',
    });
  } else {
    values.models = models.models;
  }

  // --gate
  const gate = String(input.gate ?? '').trim().toLowerCase();
  if (!GATE_VALUES.includes(gate)) {
    errors.push({
      field: '--gate',
      expected: 'one of passed|converged|waived|not-run',
      got: String(input.gate ?? ''),
      example: '--gate passed',
    });
  } else {
    values.gate = gate;
  }

  // --work-item (own-model ledger join key): a UUIDv7 or absent; never guessed.
  if (input.workItem != null) {
    if (isWorkItemId(String(input.workItem))) values.workItem = String(input.workItem);
    else errors.push({ field: '--work-item', expected: 'a UUIDv7 from `cross-skill.mjs ledger mint`', got: String(input.workItem), example: '--work-item 01a179bd-3d97-739c-b15b-3eb0d65f78b2' });
  }

  // reserved trailers in the message (only when we have message text)
  if (typeof input.messageText === 'string') {
    for (const t of findReservedTrailers(input.messageText)) {
      errors.push({
        field: 'reserved-trailer',
        custom: `AGENT FIX: reserved-trailer: expected no AI-* trailers in the message (the helper is the only writer); got "${t.key}: ${t.value}" at message line ${t.line}. Example: remove the line and pass --skill ship`,
      });
    }
  }

  // gate ↔ evidence consistency (§F1.3b)
  const ev = input.evidence;
  if (ev && GATE_VALUES.includes(gate)) {
    if (ev.state === 'fresh' && gate === 'not-run') {
      errors.push({
        field: 'gate-evidence',
        custom: `AGENT FIX: gate-evidence: an audit ran after HEAD (.audit/last-audit-run.json ts ${ev.ts}) but --gate is "not-run"; pass --gate passed|converged|waived, or --no-run-id --gate not-run if that audit was unrelated. Example: --gate converged`,
      });
    } else if (!isContentVerifiable(ev) && gate !== 'not-run') {
      errors.push({
        field: 'gate-evidence',
        custom: `AGENT FIX: gate-evidence: no fresh audit evidence exists but --gate is "${gate}"; only not-run is legal without evidence. Example: --gate not-run`,
      });
    }
  }
  values.runId = ev && isContentVerifiable(ev) ? ev.runId : null;

  return { ok: errors.length === 0, errors, values };
}

/**
 * Verdict verification for `--gate passed` (code-audit R1 H3/H5, sustained):
 * freshness proves an audit RAN; only the store's convergence row proves it
 * PASSED. Pure — the CLI supplies `cloudEnabled` + the convergence row (or
 * null). Fail-closed: any unverifiable state refuses `passed` and points the
 * agent at `waived` (the declared, unverified disposition).
 *
 * @param {object} opts
 * @param {string} opts.gate — validated gate value
 * @param {{state: string, runId: string|null}} opts.evidence
 * @param {boolean} opts.cloudEnabled
 * @param {{roundConvergedAfter: number|null}|null} opts.convergence — store row for evidence.runId
 * @param {boolean} [opts.identityProvable] — false when the committed tree is a
 *   prediction the server does not enforce (a ship-train squash onto an
 *   unpinned base, docs/plans/ship-trains.md §2.3). Then `passed` is refused and
 *   the `converged` under-claim refusal is suspended: there is no provable
 *   `passed` to under-claim against. It never turns a refusal below into an
 *   accept. Default true — every direct-commit caller is unchanged.
 * @returns {null | {field: string, custom: string}}
 */
export function evaluateGateVerification({ gate, evidence, cloudEnabled, convergence, committedTree = null, identityProvable = true }) {
  if (!evidence || !isContentVerifiable(evidence) || !VERIFIED_GATES.includes(gate)) return null;
  const runId = evidence.runId;

  // ── E1: content identity, checked BEFORE the store lookups ────────────────
  // Freshness answers "when", never "what". A run started against commit A can
  // terminate after commit B's timestamp, so `fresh` is satisfiable by a commit
  // the audit never saw. This is the only one of the three checks that a
  // post-audit edit cannot satisfy, so it is the primary — and it is local and
  // free, so it runs first and gives the clearest refusal even with cloud off.
  // Both verified gates need the SAME comparand. Absence refuses either one:
  // a gate predicated on the trees being equal and one predicated on their
  // differing are equally unprovable when there is nothing to compare, so the
  // fail-closed direction is identical and points at `waived` (declared,
  // unverified) — never at the sibling verified gate, which is just as
  // unverifiable here.
  if (!evidence.auditedTree) {
    return {
      field: 'gate-evidence',
      custom: `AGENT FIX: gate-evidence: run ${runId} recorded no audited-tree identity, so "${gate}" cannot be verified against what you are committing (pre-E1 or evidence-less run); use --gate waived. Example: --gate waived`,
    };
  }
  if (!committedTree) {
    return {
      field: 'gate-evidence',
      custom: `AGENT FIX: gate-evidence: cannot resolve the tree being committed, so "${gate}" cannot be verified against run ${runId}'s audited tree; use --gate waived. Example: --gate waived`,
    };
  }

  // The one place the two gates diverge. Each refusal names its SIBLING, not
  // `waived`: the identity is fully resolved here, so the operator asked for
  // the wrong half of a condition that has a right half — sending them to
  // `waived` would be telling them to under-claim a verifiable state.
  const treesMatch = committedTree === evidence.auditedTree;
  if (gate === 'passed' && !identityProvable) {
    return {
      field: 'gate-evidence',
      custom: `AGENT FIX: gate-evidence: the tree being committed is a prediction the destination does not enforce (no required up-to-date check), so "passed" cannot be verified against run ${runId}'s audited tree; use --gate converged if that run converged. Example: --gate converged`,
    };
  }
  if (gate === 'passed' && !treesMatch) {
    // The honest reading: what you are committing is not what was audited.
    // Note this also fires for a PARTIAL commit of an audited worktree, and
    // that is correct — a whole-worktree audit does not cover a subset.
    return {
      field: 'gate-evidence',
      custom: `AGENT FIX: gate-evidence: what you are committing is not what run ${runId} audited (audited tree ${evidence.auditedTree.slice(0, 12)}, committing ${committedTree.slice(0, 12)}) — use --gate converged if that run converged (fixes applied after the audit are exactly this case), or --gate waived. Note a partial commit of an audited worktree also differs. Example: --gate converged`,
    };
  }
  if (gate === 'converged' && treesMatch && identityProvable) {
    // Refusing the UNDER-claim. Without this the weaker label is grantable
    // whenever the stronger one is earned, which erodes the distinction the
    // value exists to create — and `passed` would decay into "whatever the
    // agent happened to type".
    return {
      field: 'gate-evidence',
      custom: `AGENT FIX: gate-evidence: what you are committing IS what run ${runId} audited (tree ${committedTree.slice(0, 12)}), so "converged" understates it; use --gate passed. Example: --gate passed`,
    };
  }

  if (!cloudEnabled) {
    return {
      field: 'gate-evidence',
      custom: `AGENT FIX: gate-evidence: "${gate}" requires a verified verdict for run ${runId} but verification is unavailable (AUDIT_DB_URL unset); use --gate waived (declared, unverified) or fix connectivity. Example: --gate waived`,
    };
  }
  if (!convergence) {
    return {
      field: 'gate-evidence',
      custom: `AGENT FIX: gate-evidence: "${gate}" requires a verified verdict for run ${runId} but verification is unavailable (run not found in the store, or the query failed); use --gate waived (declared, unverified). Example: --gate waived`,
    };
  }
  if (convergence.roundConvergedAfter == null) {
    return {
      field: 'gate-evidence',
      custom: `AGENT FIX: gate-evidence: run ${runId} did not converge (verdict recorded in the store); "${gate}" is not available — --gate waived declares shipping past the gate. Example: --gate waived`,
    };
  }
  return null;
}

/**
 * Render the pinned AGENT FIX stderr lines (§F1.5 — byte format is an API).
 * @param {Array<{field: string, custom?: string, expected?: string, got?: string, example?: string}>} errors
 * @returns {string[]}
 */
export function renderAgentFixLines(errors) {
  return errors.map((e) => e.custom
    ?? `AGENT FIX: ${e.field}: expected ${e.expected}; got "${e.got}". Example: ${e.example}`);
}

/**
 * Render the message-file rejection line (taxonomy rows 6/6b — pinned).
 * @param {'missing'|'escapes-repo'|'sensitive'|'unresolvable'} kind
 * @param {string} suppliedPath
 * @returns {{field: string, custom: string}}
 */
export function messageFileError(kind, suppliedPath) {
  if (kind === 'missing') {
    return {
      field: '--message-file',
      custom: `AGENT FIX: --message-file: expected a readable non-empty file; got "${suppliedPath}" (ENOENT). Example: ${MESSAGE_FILE_EXAMPLE}`,
    };
  }
  if (kind === 'empty') {
    return {
      field: '--message-file',
      custom: `AGENT FIX: --message-file: expected a readable non-empty file; got "${suppliedPath}" (empty or whitespace-only). Example: ${MESSAGE_FILE_EXAMPLE}`,
    };
  }
  return {
    field: '--message-file',
    custom: `AGENT FIX: --message-file: must resolve inside the repo and not be a sensitive path; got "${suppliedPath}" (${kind}). Example: ${MESSAGE_FILE_EXAMPLE}`,
  };
}

/**
 * Format the canonical AI-* trailer block lines (fixed key order).
 *
 * `AI-Audited-Tree` is emitted ONLY on a verified `passed` — the caller sets it
 * from the very value `evaluateGateVerification` compared, after that
 * comparison returned null (accept). It therefore cannot exist on a commit
 * whose tree identity was not checked.
 *
 * Why it exists: before 2026-08-04 the value the gate actually compared was
 * never persisted anywhere. `audit_runs.audited_tree` holds the WORKTREE tree
 * (`gitWorktreeTree` at audit time); the gate compares the INDEX tree
 * (`gitIndexTree` at ship time). Those are different quantities, so the store
 * could not be used to re-check a historical `passed` — an audit of the two
 * `passed` commits in the repo's history found one whose stored tree did not
 * match its committed tree, and the record could neither convict nor clear it
 * because the artifact the gate reads (`.audit/last-audit-run.json`) is
 * transient and long overwritten. Putting the compared value on the commit
 * makes the claim self-verifying with pure git, forever:
 *
 *   git rev-parse <sha>^{tree}  ==  git log -1 --format='%(trailers:key=AI-Audited-Tree,valueonly)' <sha>
 *
 * @param {{skill: string, models: string[], gate: string, runId?: string|null, auditedTree?: string|null,
 *   finalReview?: 'approve'|'approve_with_debt'|'blocked'|null, shipAuthority?: string}} v
 * @returns {string[]}
 */
export function formatTrailerBlock(v) {
  const lines = [
    `AI-Skill: ${v.skill}`,
    `AI-Models: ${v.models.join(',')}`,
    `AI-Gate: ${v.gate}`,
  ];
  if (v.runId) lines.push(`AI-Run-ID: ${v.runId}`);
  if (v.workItem) lines.push(`AI-Work-Item: ${v.workItem}`);
  // Guarded by gate AND shape: a caller that threads a value through on a
  // non-`passed` gate, or a malformed oid, emits nothing rather than a trailer
  // asserting an identity nobody verified.
  //
  // DELIBERATELY still `passed`-only after `converged` was added, and this is
  // the interesting case. On `passed` the audited tree IS the commit's tree, so
  // it is reachable from a ref and the trailer is self-verifying with pure git,
  // forever. On `converged` it is a SYNTHETIC tree from `gitWorktreeTree`'s
  // throwaway index that equals nothing any ref points at — measured: reachable
  // from 0 refs, listed by `git fsck --unreachable`, destroyed by
  // `git gc --prune=now`, and absent from a fresh clone. Emitting it there would
  // publish a provenance line that resolves for its author until the next gc and
  // for nobody else ever, which is worse than omitting it. (Second, independent
  // reason: `gitWorktreeTree` is `read-tree HEAD` + `add -A`, so the identity
  // covers all non-ignored worktree content including unrelated untracked files
  // — an audit subject, not a publishable scope.)
  // Plan: docs/plans/gate-taxonomy-remediated-ships.md §2.3.
  if (v.gate === 'passed' && TREE_ID_RE.test(v.auditedTree ?? '')) {
    lines.push(`AI-Audited-Tree: ${v.auditedTree}`);
  }
  // The final review's RESULT for the run AI-Run-ID names (docs/plans/copilot-feedback-item4.md section 2.2 B3). The caller
  // passes the disposition of a final-review marker BOUND to that run's gate evidence (final-review-marker.mjs
  // `boundFinalReviewDisposition`), never a flag, so there is nothing to declare. It needs a run to be a result OF, and an
  // unknown value emits nothing. It qualifies no other trailer: AI-Gate is decided without it.
  if (v.runId && Object.hasOwn(FINAL_REVIEW_TRAILER_VALUES, v.finalReview ?? '')) {
    lines.push(`AI-Final-Review: ${FINAL_REVIEW_TRAILER_VALUES[v.finalReview]}`);
  }
  // A pre-authorised ship (the user pre-approved it in the chip's launch prompt rather than typing /ship). Set ONLY by
  // ship-commit's `--preauthorised` path, after every condition in lib/ship-preauth.mjs held; the single literal value
  // keeps it queryable (`git log --grep` / trailers) and impossible to spell differently by hand (the AI-* namespace is
  // reserved, so a hand-typed one is rejected as `reserved-trailer`).
  if (v.shipAuthority === 'launch-prompt') lines.push('AI-Ship-Authority: launch-prompt');
  return lines;
}

/**
 * Compose the final commit message (§F1.3a rendering invariants):
 * CRLF→LF, trailing blank lines trimmed, the AI-* block joins an existing
 * trailer block or is appended after exactly one blank line, final newline
 * ensured. The input text is NEVER mutated on disk (Gemini G2) — callers
 * write the return value to a helper-owned temp file.
 *
 * @param {string} messageText
 * @param {{skill: string, models: string[], gate: string, runId?: string|null}} values
 * @returns {string}
 */
export function composeFinalMessage(messageText, values) {
  const normalised = String(messageText).replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');
  const body = normalised.replace(/\n+$/, '');
  const block = formatTrailerBlock(values).join('\n');
  const { isTrailerBlock } = parseMessageTrailers(body);
  const sep = isTrailerBlock ? '\n' : '\n\n';
  return `${body}${sep}${block}\n`;
}

export const _internals = { MESSAGE_FILE_EXAMPLE };

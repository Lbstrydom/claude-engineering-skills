/**
 * @fileoverview Upstream issue-report commands — capture (consumer side) and
 * triage (source side).
 *
 * Plan: docs/plans/upstream-issue-reports.md (Cluster B, Phase 3).
 *
 * Thin-dispatcher discipline: `cross-skill.mjs` dispatches, all logic lives
 * here (mirrors `lib/friction/commands.mjs`).
 *
 * The module is split deliberately into PURE decision functions and an IMPURE
 * git adapter, because the freshness rule is the part that must be provably
 * correct and a git fixture would make it untestable in practice.
 *
 * @module scripts/lib/upstream/commands
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';

import {
  parseEnvelopeFrame, writeEnvelope as writeEnvelopeToDir, drainEnvelopes,
} from '../outbox-envelope.mjs';
import { redactSecrets } from '../secret-patterns.mjs';
import {
  parseDisposition, formatDisposition, computeLedgerReconciliation,
  classifyMissingCause, MISSING_CAUSE,
} from './dispositions.mjs';
import {
  DISPOSITION_LEDGER_PATH, mergeLedgerEntry,
  upsertDispositionLedgerEntry, serialiseDispositionLedger,
  applyMissingDispositions, captureReconcilePrecondition, readUpstreamLedgerEvidence,
} from './disposition-ledger.mjs';
import { resolveBaseFreshness } from '../git-freshness.mjs';
import { foldEventsToState, NON_LIFECYCLE_EVENTS } from './events.mjs';

// The disposition-ledger surface lives in ./disposition-ledger.mjs; re-exported
// here so every existing importer of `upstream/commands.mjs` keeps working.
export {
  DISPOSITION_LEDGER_PATH, mergeLedgerEntry, serialiseDispositionLedger,
  applyMissingDispositions, captureReconcilePrecondition, readUpstreamLedgerEvidence,
};
export { renderReconciliationReport } from './reconcile-render.mjs';

/** Envelope format version. Bumping it makes older files `rejected/`. */
export const OUTBOX_ENVELOPE_VERSION = 1;

/** Where write-ahead envelopes live, relative to the repo root. */
export const OUTBOX_DIR = path.join('.audit', 'upstream-outbox');

/**
 * Max envelopes drained per invocation, so a backlog can't stall the command
 * this drain is piggybacking on. Overridable, because a consumer that
 * accumulated a large offline backlog otherwise has no way to clear it faster
 * than 20 reports per run: `UPSTREAM_DRAIN_CAP=200 … upstream drain`.
 */
export const DRAIN_CAP = (() => {
  const n = Number.parseInt(process.env.UPSTREAM_DRAIN_CAP ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 20;
})();

export const VALID_SEVERITIES = Object.freeze(['BLOCKER', 'HIGH', 'MEDIUM', 'LOW']);

/**
 * An issue id or id PREFIX: hex and dashes only, at least 8 characters.
 *
 * Hex-and-dashes is not cosmetic — the store resolves a prefix with
 * `id::text LIKE $1 || '%'`, and `%`/`_` are LIKE wildcards living in the DATA,
 * where parameterisation does not reach. An unfiltered `%` would match every
 * row and then "resolve" to whichever sorted first.
 */
export const ISSUE_ID_OR_PREFIX_RE = /^[0-9a-f][0-9a-f-]{7,35}$/;

/** A FULL uuid. Required by any write that cannot be re-aimed after the fact. */
export const ISSUE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_TITLE_LEN = 200;
export const MAX_BODY_BYTES = 65536;

// ── Bundle stamp ────────────────────────────────────────────────────────────

/**
 * Read the consumer's sync manifest for its bundle provenance.
 *
 * Never throws: an absent, unreadable or malformed manifest yields `null`,
 * which downstream MUST render as "version unknown" — never as "current".
 *
 * @param {string} repoRoot
 * @returns {{commitSha: string|null, generatedAt: string|null, sourceDirty: boolean|null, files: Record<string,string>}|null}
 */
export function readBundleStamp(repoRoot) {
  const manifestPath = path.join(repoRoot, 'scripts', '.sync-manifest.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      commitSha: typeof parsed.commitSha === 'string' ? parsed.commitSha : null,
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : null,
      // Anything that is not literally `true`/`false` is "not determined" —
      // including absence, which is what every manifest published before this
      // field existed looks like. Absence must never read as clean.
      sourceDirty: typeof parsed.sourceDirty === 'boolean' ? parsed.sourceDirty : null,
      files: (parsed.files && typeof parsed.files === 'object') ? parsed.files : {},
    };
  } catch {
    return null;
  }
}

/**
 * Is `affectedPath` an upstream-owned file in this consumer?
 *
 * Separator normalisation is load-bearing on Windows — the manifest's keys are
 * always POSIX (`computeFileHashes` guarantees it on every platform), so an
 * operator pasting `scripts\.claude-skills\ship-commit.mjs` would otherwise
 * have a correct report stamped `path_recognised: false`, defeating the very
 * check that catches a wrong path.
 *
 * @returns {{recognised: boolean|null, normalised: string}} `null` = no manifest to check against
 */
export function validateAffectedPath(affectedPath, manifest) {
  const normalised = String(affectedPath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  if (!manifest || !manifest.files || Object.keys(manifest.files).length === 0) {
    return { recognised: null, normalised };
  }
  return { recognised: Object.hasOwn(manifest.files, normalised), normalised };
}

// ── Pure decision functions ─────────────────────────────────────────────────

/**
 * Is the reporter's bundle behind the source repo?
 *
 * PURE — every git fact arrives as an argument. Total over its input space via
 * the ordered precedence below (plan §2 dec. 4); the first match wins.
 *
 *   1. no/malformed sha           → unknown(no-stamp)
 *   2. sha not in this history    → unknown(sha-not-in-history)
 *   3. source tree dirty at sync  → unknown(source-tree-dirty)
 *   4. distance unavailable       → unknown(git-unavailable)
 *   5. distance > 0               → stale
 *   6. otherwise                  → current
 *
 * `ageDays` is REPORTED, never thresholded: no "stale after N days" constant
 * is invented, because no current requirement needs one.
 *
 * @returns {{verdict: 'stale'|'current'|'unknown', reason: string, distanceAhead: number|null, ageDays: number|null}}
 */
export function classifyReportFreshness({
  reportedSha = null, shaInHistory = null, distanceAhead = null, ageDays = null,
  sourceDirty = null,
} = {}) {
  const out = (verdict, reason) => ({ verdict, reason, distanceAhead, ageDays });

  if (typeof reportedSha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(reportedSha)) {
    return out('unknown', 'no-stamp');
  }
  // `!== true`, not `=== false` (round-5 audit M11 — same class as M13
  // above): `resolveGitFacts` deliberately leaves `shaInHistory: null` when
  // the ancestry check itself errored ("unknown, not 'absent'" — its own
  // comment), distinct from a confirmed `false`. A `null` used to fall
  // through to the distance/dirty-based verdict below, so a report whose
  // history could not even be checked could still read `current`/`stale`.
  if (shaInHistory !== true) {
    return out('unknown', shaInHistory === false ? 'sha-not-in-history' : 'sha-history-unverified');
  }
  // The stamp describes HEAD; the bytes shipped came from the working TREE.
  // When those disagreed at sync time the sha is a LOWER BOUND on what the
  // consumer holds, so neither `stale` nor `current` is assertable.
  // `distanceAhead` is still reported — the measurement is real, only the
  // verdict built on it is not.
  //
  // Ordered ahead of the distance rules deliberately: a dirty bundle sitting at
  // distance 0 is not `current` either, because the consumer may hold code
  // AHEAD of its own stamp. That is the 2026-08-01 case exactly — wine ran the
  // nested-search code for 30 minutes before the commit containing it existed,
  // and this function called it "10 commits behind".
  // `!== false`, not `=== true` (round-3 audit M13, raised three times across
  // R1/R2/R3 under different framings — real, and fixed here rather than
  // rebutted again): `sourceDirty: null` means UNKNOWN provenance (older or
  // malformed manifests predating this field — readBundleStamp's own
  // docstring: "absence must never read as clean"), and `null !== true` was
  // falling through to the distance-based verdict, which could read `current`
  // for a report whose provenance was never actually verified clean.
  if (sourceDirty !== false) return out('unknown', sourceDirty === true ? 'source-tree-dirty' : 'source-dirty-unknown');
  if (distanceAhead === null || distanceAhead === undefined) {
    return out('unknown', 'git-unavailable');
  }
  // Round-6 audit M2: a non-numeric or negative distanceAhead (a caller bug,
  // not a real measurement) used to silently fall through — `NaN > 0` and
  // `-5 > 0` are both false, so malformed input landed on the SAME branch as
  // a genuine "at HEAD" (`0 > 0` is also false) and read as `current`.
  if (!Number.isFinite(distanceAhead) || distanceAhead < 0) {
    return out('unknown', 'distance-invalid');
  }
  if (distanceAhead > 0) return out('stale', 'behind-head');
  return out('current', 'at-head');
}

/**
 * Relate one known fix to the reporter's bundle.
 *
 * PURE. **The direction is the opposite of the intuitive reading**, which is
 * why it gets its own function and its own tests: if the fix commit is NOT an
 * ancestor of the reported bundle, the reporter's bundle PREDATES the fix —
 * i.e. they never had it. If it IS an ancestor, they already had the fix and
 * it failed anyway.
 *
 * This is context for a human, never a verdict: a file path is not a bug
 * identity, so "a fix touched this file" cannot establish that this report is
 * that bug.
 *
 * @returns {'bundle-predates-fix'|'bundle-contains-fix'|'undetermined'}
 */
export function annotatePriorFix({ ancestry } = {}) {
  if (ancestry === 'lacks-fix') return 'bundle-predates-fix';
  if (ancestry === 'contains-fix') return 'bundle-contains-fix';
  return 'undetermined';
}

/**
 * Stable report identity.
 *
 * `JSON.stringify` of a fixed-arity array, NOT concatenation: bare
 * concatenation lets field boundaries shift (`title:'fo' + path:'obar'` hashes
 * identically to `title:'foo' + path:'bar'`), and since this value is a UNIQUE
 * key a collision silently overwrites one real report with another. The body
 * hash keeps two different reports about the same file at the same bundle
 * version distinct, while an identical retry still de-duplicates.
 */
export function computeFingerprint({ repoUuid, title, affectedPath, reportedBundleSha, body }) {
  const bodyHash = crypto.createHash('sha256').update(String(body ?? ''), 'utf8').digest('hex');
  const canonical = JSON.stringify([
    String(repoUuid ?? ''), String(title ?? ''), String(affectedPath ?? ''),
    String(reportedBundleSha ?? ''), bodyHash,
  ]);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ── Impure git adapter ──────────────────────────────────────────────────────

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Resolve the git facts the pure classifiers consume. Every failure degrades to
 * `null` / `'unresolvable'` rather than throwing.
 *
 * @param {{reportedSha: string|null, fixCommits?: string[], repoRoot?: string}} args
 */
export function resolveGitFacts({ reportedSha, fixCommits = [], repoRoot = process.cwd() }) {
  const facts = { shaInHistory: null, distanceAhead: null, ancestry: new Map() };
  if (!reportedSha || !/^[0-9a-f]{7,40}$/i.test(reportedSha)) return facts;

  // `rev-parse --verify` would only prove the OBJECT EXISTS locally — a commit
  // fetched on some other branch satisfies it while not being in HEAD's history
  // at all, and any operational git failure (not a checkout, corrupt repo) also
  // returns non-zero, which would be reported as the flatly different claim
  // "this sha is not in our history".
  //
  // `merge-base --is-ancestor` answers the question actually being asked and
  // distinguishes all three outcomes by exit code: 0 = in HEAD's history,
  // 1 = genuinely not, anything else = we could not tell (stays `null`, which
  // classifies as `git-unavailable` rather than a false negative).
  const anc = git(['merge-base', '--is-ancestor', reportedSha, 'HEAD'], repoRoot);
  if (anc.status === 0) facts.shaInHistory = true;
  else if (anc.status === 1) { facts.shaInHistory = false; return facts; }
  else return facts;   // shaInHistory stays null — unknown, not "absent"

  const count = git(['rev-list', '--count', `${reportedSha}..HEAD`], repoRoot);
  if (count.status === 0) {
    const n = Number.parseInt(String(count.stdout).trim(), 10);
    facts.distanceAhead = Number.isFinite(n) ? n : null;
  }

  for (const fix of fixCommits) {
    if (!fix || !/^[0-9a-f]{7,40}$/i.test(fix)) {
      facts.ancestry.set(fix, 'unresolvable');
      continue;
    }
    // `--is-ancestor` uses exit 1 for a legitimate FALSE, not for an error.
    // Collapsing "non-zero ⇒ failure" here would turn every genuine
    // "bundle predates this fix" into `unresolvable` and destroy the only
    // signal this feature produces.
    const anc = git(['merge-base', '--is-ancestor', fix, reportedSha], repoRoot);
    if (anc.status === 0) facts.ancestry.set(fix, 'contains-fix');
    else if (anc.status === 1) facts.ancestry.set(fix, 'lacks-fix');
    else facts.ancestry.set(fix, 'unresolvable');
  }
  return facts;
}

// ── Outbox (write-ahead) ────────────────────────────────────────────────────

export function outboxDir(repoRoot) { return path.join(repoRoot, OUTBOX_DIR); }
function rejectedDir(repoRoot) { return path.join(outboxDir(repoRoot), 'rejected'); }

/**
 * Validate an envelope read back off disk. Returns `null` when unusable — the
 * caller quarantines rather than deleting or retrying forever.
 *
 * The FRAME check (version, fingerprint, payload-is-an-object) now lives in the
 * shared `outbox-envelope.mjs`; the report-shape check below stays here,
 * because it is the one part that is genuinely upstream-specific.
 */
export function parseEnvelope(text) {
  return parseEnvelopeFrame(text, {
    version: OUTBOX_ENVELOPE_VERSION,
    validatePayload: (p) => typeof p.title === 'string'
      && typeof p.body === 'string'
      && VALID_SEVERITIES.includes(p.severity)
      && typeof p.affectedPath === 'string',
  });
}

/**
 * Write-ahead: the envelope lands on disk BEFORE any remote attempt.
 * Signature kept `(repoRoot, envelope)` — the shared helper takes a resolved
 * directory, and this module's callers all speak repo-root.
 */
export function writeEnvelope(repoRoot, envelope) {
  return writeEnvelopeToDir(outboxDir(repoRoot), envelope);
}

/**
 * Drain pending envelopes into the store.
 *
 * Deliberately tolerant of a concurrent winner: two invocations can drain the
 * same file, both upsert (idempotent by fingerprint), and the slower one would
 * otherwise throw ENOENT on unlink and abort the operator's real command.
 * `force: true` treats a missing file as success — this is best-effort
 * housekeeping piggybacking on another command, never that command's failure.
 */
export async function drainOutbox({ repoRoot = process.cwd(), recordFn, cap = DRAIN_CAP } = {}) {
  // `state` is ADDITIVE: the three counters keep their existing meaning and
  // shape, so callers and tests written against them are unaffected. What is
  // new is that an unreadable outbox now says so instead of reporting the same
  // `{drained: 0}` as an empty one.
  return drainEnvelopes({
    dir: outboxDir(repoRoot),
    cap,
    parse: parseEnvelope,
    // The receipt test is unchanged, and it was already right: `ok` alone is
    // not enough, because a cloud-off write resolves `{ok: true, cloud: false}`
    // having persisted nothing. Deleting on that would lose the report.
    apply: async (envelope) => {
      const res = await recordFn({ ...envelope.payload, fingerprint: envelope.fingerprint });
      return Boolean(res?.ok && res.cloud !== false);
    },
  });
}

// ── Validation ──────────────────────────────────────────────────────────────

/** @returns {string[]} human-readable problems; empty means valid. */
export function validateReportInput({ title, body, severity, affectedPath }) {
  const errs = [];
  const t = String(title ?? '').trim();
  if (!t) errs.push('--title is required');
  else if (t.length > MAX_TITLE_LEN) errs.push(`--title exceeds ${MAX_TITLE_LEN} chars`);

  const b = String(body ?? '');
  if (!b.trim()) errs.push('body is required (pass it on stdin, or via --body)');
  else if (Buffer.byteLength(b, 'utf8') > MAX_BODY_BYTES) {
    errs.push(`body exceeds ${MAX_BODY_BYTES} bytes`);
  }

  if (!VALID_SEVERITIES.includes(severity)) {
    errs.push(`--severity must be one of ${VALID_SEVERITIES.join('|')}`);
  }

  const p = String(affectedPath ?? '').trim();
  if (!p) errs.push('--affected-path is required');
  else if (p.includes('..')) errs.push('--affected-path must not contain ".."');
  else if (path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)) {
    errs.push('--affected-path must be repo-relative');
  }
  return errs;
}

// ── Operations ──────────────────────────────────────────────────────────────

/**
 * Redact before ANY persistence — the outbox is a plaintext file on disk and is
 * not a trusted holding area, so this runs before the write-ahead write, not
 * just before egress.
 *
 * Uses the GENTLE `secret-patterns` redactor, deliberately not `sanitizer.mjs`:
 * that one blanket-redacts any 20+ char token and would corrupt report prose
 * (the same rule AGENTS.md states for incident text).
 */
function redactReport(payload) {
  const r = (v) => (typeof v === 'string' && v ? redactSecrets(v).text : v);
  return { ...payload, title: r(payload.title), body: r(payload.body), affectedPath: r(payload.affectedPath) };
}

/**
 * File a report from a consumer repo.
 *
 * Order is load-bearing: validate → redact → write-ahead envelope → attempt the
 * store. A success line is never printed having persisted nothing; the envelope
 * on disk is the proof.
 */
export async function upstreamReport({
  repoRoot = process.cwd(), repoUuid, repoId, title, body, severity = 'MEDIUM',
  affectedPath, actor = null, recordFn, cloudEnabled = true,
}) {
  const errs = validateReportInput({ title, body, severity, affectedPath });
  if (errs.length) return { ok: false, code: 'BAD_INPUT', errors: errs };

  const manifest = readBundleStamp(repoRoot);
  const { recognised, normalised } = validateAffectedPath(affectedPath, manifest);

  const payload = redactReport({
    repoId: repoId ?? null,
    title: String(title).trim(),
    body: String(body),
    severity,
    affectedPath: normalised,
    reportedBundleSha: manifest?.commitSha ?? null,
    reportedBundleGeneratedAt: manifest?.generatedAt ?? null,
    reportedSourceDirty: manifest?.sourceDirty ?? null,
    pathRecognised: recognised,
    actor,
  });

  const fingerprint = computeFingerprint({
    repoUuid, title: payload.title, affectedPath: payload.affectedPath,
    reportedBundleSha: payload.reportedBundleSha, body: payload.body,
  });

  const envelopePath = writeEnvelope(repoRoot, {
    v: OUTBOX_ENVELOPE_VERSION, fingerprint, repoUuid: repoUuid ?? null,
    payload, createdAt: new Date().toISOString(),
  });

  if (!cloudEnabled) {
    return {
      ok: true, cloud: false, spooled: true, path: envelopePath, fingerprint,
      pathRecognised: recognised, bundleSha: payload.reportedBundleSha,
    };
  }

  const res = await recordFn({ ...payload, fingerprint });
  if (res?.ok && res.cloud !== false) {
    fs.rmSync(envelopePath, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
    return {
      ok: true, cloud: true, spooled: false, id: res.id, created: res.created,
      fingerprint, pathRecognised: recognised, bundleSha: payload.reportedBundleSha,
    };
  }
  return {
    ok: true, cloud: false, spooled: true, path: envelopePath, fingerprint,
    pathRecognised: recognised, bundleSha: payload.reportedBundleSha,
    error: res?.error ?? null,
  };
}

/**
 * Triage view: each open report annotated with bundle staleness and any prior
 * fixes touching the same path.
 *
 * The freshness verdict and the prior-fix list are deliberately SEPARATE
 * columns — the verdict is about the bundle, the list is evidence about the
 * file. Conflating them would assert a bug identity a path cannot establish.
 */
export async function upstreamList({
  repoRoot = process.cwd(), listFn, priorFixesFn, state = 'open', limit, before = null, repoId = null,
}) {
  const res = await listFn({ state, limit, before, repoId });
  if (!res.ok || res.cloud === false) return { ...res, items: [] };

  const items = [];
  for (const row of res.rows) {
    const priors = await priorFixesFn(row.affected_path, row.id);
    const fixCommits = (priors.rows || []).map((p) => p.fixed_in_commit).filter(Boolean);
    const facts = resolveGitFacts({ reportedSha: row.reported_bundle_sha, fixCommits, repoRoot });

    const ageDays = row.reported_bundle_generated_at
      ? Math.floor((Date.now() - new Date(row.reported_bundle_generated_at).getTime()) / 86400000)
      : null;

    items.push({
      ...row,
      freshness: classifyReportFreshness({
        reportedSha: row.reported_bundle_sha,
        shaInHistory: facts.shaInHistory,
        distanceAhead: facts.distanceAhead,
        ageDays,
        sourceDirty: row.reported_source_dirty ?? null,
      }),
      priorFixes: (priors.rows || []).map((p) => ({
        id: p.id, title: p.title, commit: p.fixed_in_commit,
        relation: annotatePriorFix({ ancestry: facts.ancestry.get(p.fixed_in_commit) }),
      })),
    });
  }
  return { ...res, items };
}


/**
 * Move an issue through its lifecycle.
 *
 * `--commit` is verified to actually resolve in THIS repo before the
 * transition is accepted: an unresolvable commit is a usage error, never a
 * stored string, because that value is the basis for every later ancestry
 * check and a bad one produces confident wrong answers downstream.
 *
 * **`--disposition` is required for both terminal states** (consumer-
 * friction-doctor plan §2.4) — closing a report can no longer be a no-op.
 * Validated and normalised HERE, before either write, so a malformed
 * disposition is a usage error rather than a partially-applied transition.
 */
export async function upstreamTransition({
  repoRoot = process.cwd(), transitionFn, id, to, note = null, commit = null, actor = null,
  disposition = null, storeFingerprint = null,
}) {
  if (!id) return { ok: false, code: 'BAD_INPUT', errors: ['--id is required'] };
  // Shape-check BEFORE the store sees it. `upstream_issues.id` is a uuid column,
  // so anything non-uuid used to reach Postgres and come back as a raw
  // `invalid input syntax for type uuid: "96a829f8"` wrapped in code EXCEPTION —
  // a database type error surfacing as an unhandled fault, when it is really a
  // malformed argument the boundary should have named. Hit live 2026-08-10
  // pasting a short id off a rendered card.
  //
  // Hex-and-dashes only is also what makes the store's prefix match SAFE: that
  // query is `id::text LIKE $1 || '%'`, and LIKE treats `%` and `_` as
  // wildcards, so an unfiltered `%` would silently match every open issue and
  // "resolve" to an arbitrary one. Parameterisation does not help here — the
  // wildcards are in the DATA, not the SQL.
  const normId = String(id).trim().toLowerCase();
  if (!ISSUE_ID_OR_PREFIX_RE.test(normId)) {
    return {
      ok: false, code: 'BAD_INPUT',
      errors: [`--id "${id}" is not an issue id or id prefix — expected at least 8 `
        + 'hex characters (dashes allowed). Full ids: npm run upstream:issues'],
    };
  }
  if (to === 'fixed') {
    if (!commit) return { ok: false, code: 'BAD_INPUT', errors: ['--commit is required for `fix`'] };
    const v = git(['rev-parse', '--verify', `${commit}^{commit}`], repoRoot);
    if (v.status !== 0) {
      return { ok: false, code: 'BAD_INPUT', errors: [`--commit "${commit}" does not resolve in this repo`] };
    }
  }
  if (to === 'wont_fix' && !String(note ?? '').trim()) {
    return { ok: false, code: 'BAD_INPUT', errors: ['--note is required for `wont-fix` (a refusal needs a reason)'] };
  }

  // A bare close throws before any write (§2.4) — only `fixed`/`wont_fix` are
  // terminal; `ack` (-> 'acknowledged') is unaffected and needs no disposition.
  let parsedDisposition = null;
  if (to === 'fixed' || to === 'wont_fix') {
    if (!disposition) {
      return {
        ok: false, code: 'BAD_INPUT',
        errors: ['--disposition is required to close an upstream report — one of probe:<id>, test:<tracked test path>, exempt:<reason>'],
      };
    }
    const parsed = parseDisposition(disposition);
    if (!parsed.ok) return { ok: false, code: 'BAD_INPUT', errors: [parsed.error] };
    parsedDisposition = { kind: parsed.kind, value: parsed.value };
  }

  const safeNote = note ? redactSecrets(String(note)).text : null;
  const safeDispositionValue = parsedDisposition?.kind === 'exempt'
    ? { ...parsedDisposition, value: redactSecrets(parsedDisposition.value).text }
    : parsedDisposition;

  // A TERMINAL transition must carry a FULL uuid, not a prefix.
  //
  // The prefix form is fine for the store — `transitionFn` resolves it — but the
  // ledger write below records `normId` verbatim, and
  // `check-upstream-probe-coverage.mjs --gate` requires every ledger entry's
  // `issueId` to be uuid-shaped. So a prefixed close succeeded, wrote an entry
  // the gate then rejected, and left `npm run check` permanently red with the
  // report already closed — the writer accepting a key its own reader refuses,
  // shape (1) of the four AGENTS.md names. Caught 2026-08-29 closing five
  // reports by prefix.
  //
  // Rejecting at the boundary rather than resolving here keeps the deliberate
  // ledger-then-DB ordering below (the cheap local write must survive a DB
  // failure) — resolving would require a store round-trip before it. `ack` is
  // untouched: it writes no ledger entry, so a prefix stays convenient there.
  if (parsedDisposition && !ISSUE_UUID_RE.test(normId)) {
    return {
      ok: false, code: 'BAD_INPUT',
      errors: [`--id "${id}" is a prefix; closing a report needs the FULL uuid, because the `
        + 'committed disposition ledger is keyed by it and `upstream:coverage:gate` rejects a '
        + 'prefix. Get it from: npm run upstream:issues'],
    };
  }

  // Sequential ledger-then-DB write (§2.4) — the cheap local write happens
  // FIRST, and only then the DB transition.
  if (parsedDisposition) {
    await upsertDispositionLedgerEntry(repoRoot, {
      issueId: normId, state: to, disposition: safeDispositionValue, storeFingerprint,
    });
  }

  return transitionFn({
    id: normId, to, note: safeNote, commit, actor,
    disposition: parsedDisposition ? formatDisposition(safeDispositionValue) : null,
  });
}

/** The `--note` value that means "read it from stdin instead". */
export const STDIN_SENTINEL = '-';

/**
 * Resolve a `--note` without routing prose through a shell.
 *
 * **The papercut this exists for.** A note reaches the CLI as an argv string
 * the shell has ALREADY rewritten: closing report `0f5d87a2` on 2026-08-30,
 * an unescaped backtick in `--note` ran as command substitution and silently
 * elided one sentence from the stored text. Nothing downstream can detect that
 * — what arrives is a shorter, well-formed string — and because the event log
 * is append-only the mistake could not be repaired, which is the same incident
 * that motivated `annotate`.
 *
 * Two ways in, and the asymmetry is deliberate:
 *
 *  - **`--note -`** reads stdin on EVERY note-bearing verb. An explicit
 *    sentinel, because on `ack`/`fix`/`wont-fix` the note is OPTIONAL and
 *    usually omitted: a bare "no flag, so read stdin" fallback there would
 *    block forever on an inherited pipe with no writer (a hook, a `/ship`
 *    step), turning an omitted note into a hang.
 *  - **an absent flag when the note is REQUIRED** falls back to stdin,
 *    mirroring `upstream report`'s `--body`. Safe for the same reason it is
 *    safe there: the value is required, so waiting for it is the expected
 *    behaviour rather than a surprise.
 *
 * Lives here rather than in the dispatcher so it is testable without a real
 * stdin — `readStdin` is injected, and the dispatcher stays thin.
 *
 * @param {{flag: string|null|undefined, readStdin: () => Promise<string>, required?: boolean}} args
 * @returns {Promise<string|null>}
 */
export async function resolveNoteInput({ flag, readStdin, required = false }) {
  if (flag === STDIN_SENTINEL) return readStdin();
  if (flag !== undefined && flag !== null) return flag;
  return required ? readStdin() : null;
}

/**
 * The annotation write-ahead outbox — a SECOND directory, deliberately.
 *
 * `outbox-envelope.mjs` is the shared mechanism; what is not shared is the
 * payload. Folding annotations into `OUTBOX_DIR` would force `parseEnvelope`'s
 * validator into a union ("a report OR an annotation"), and a predicate that
 * answers two questions answers neither — a malformed report would validate as
 * a well-formed annotation and be applied as one. One directory per payload
 * shape keeps each validator total over its own frame.
 */
export const ANNOTATION_OUTBOX_DIR = path.join('.audit', 'upstream-annotation-outbox');

export function annotationOutboxDir(repoRoot) { return path.join(repoRoot, ANNOTATION_OUTBOX_DIR); }

/**
 * Validate an annotation envelope read back off disk.
 *
 * `eventId` is required in the FRAME, not merely carried: it is the row's
 * primary key, and an envelope without it cannot be replayed idempotently — a
 * retry would append a second copy of the note that the append-only log could
 * not then remove.
 */
export function parseAnnotationEnvelope(text) {
  return parseEnvelopeFrame(text, {
    version: OUTBOX_ENVELOPE_VERSION,
    validatePayload: (p) => ISSUE_UUID_RE.test(String(p.issueId ?? ''))
      && ISSUE_UUID_RE.test(String(p.eventId ?? ''))
      && typeof p.note === 'string' && p.note.trim() !== ''
      && (p.actor === null || typeof p.actor === 'string'),
  });
}

/**
 * Drain queued annotations.
 *
 * **`notFound` / `ambiguous` are QUARANTINED, not retried.** They are terminal
 * facts about the target, not transient facts about the store, and the drain is
 * capped + oldest-first — so one permanently-failing envelope at the head would
 * block every annotation behind it. Quarantining preserves the operator's text
 * as evidence in `rejected/` while taking it out of the queue, which is the
 * disposition `drainEnvelopes` reserves `{quarantined: true}` for.
 *
 * A REPLAY (`created: false`) resolves `true`: the row is already in the store,
 * which is precisely what "durably applied" means.
 */
export async function drainAnnotationOutbox({ repoRoot = process.cwd(), annotateFn, cap = DRAIN_CAP } = {}) {
  const dir = annotationOutboxDir(repoRoot);
  return drainEnvelopes({
    dir,
    cap,
    parse: parseAnnotationEnvelope,
    apply: async (envelope, { file }) => {
      const p = envelope.payload;
      const res = await annotateFn({ id: p.issueId, note: p.note, actor: p.actor, eventId: p.eventId });
      if (res?.ok && res.cloud !== false) return true;
      if (res?.notFound || res?.ambiguous) {
        quarantineEnvelope(dir, file);
        return { quarantined: true };
      }
      // Cloud off, or a real store error: leave it queued for the next drain.
      return false;
    },
  });
}

/**
 * Move a claimed envelope into `rejected/` without ever clobbering earlier
 * evidence — the same never-overwrite rule the shared core applies to a poison
 * frame, applied here because this consumer owns the disposition.
 *
 * @param {string} dir the outbox directory
 * @param {string} file the CLAIMED path the drain handed back
 */
function quarantineEnvelope(dir, file) {
  try {
    const rej = path.join(dir, 'rejected');
    fs.mkdirSync(rej, { recursive: true });
    const base = path.basename(file).replace(/\.claimed$/, '');
    let dest = path.join(rej, base);
    for (let n = 1; fs.existsSync(dest); n += 1) dest = path.join(rej, `${base}.${n}`);
    fs.renameSync(file, dest);
  } catch { /* the reclaim sweep picks up an unmoved claim on the next drain */ }
}

/**
 * Append a correction / added-context note to an issue's log, WITHOUT moving
 * it through the lifecycle.
 *
 * **The gap this closes.** `upstream_issue_events` is append-only by trigger
 * and `event` was CHECK'd to the four lifecycle values, so a note stored with a
 * mistake in it had exactly two repairs and both were wrong: mutate the
 * append-only row (refused, correctly), or emit a SECOND terminal event —
 * corrupting the lifecycle record in order to fix a typo. Closing report
 * `0f5d87a2` on 2026-08-30, an unescaped backtick in `--note` ran as shell
 * command substitution and silently elided one sentence from the stored text,
 * and the note had to stand with a hole in it. Both properties that forced that
 * are correct and are kept; what was missing was a fifth, state-neutral event.
 *
 * **The FULL uuid is required, and for a different reason than a closure's.**
 * A close needs it because the committed disposition ledger records what was
 * typed verbatim and `upstream:coverage:gate` rejects a non-uuid key. An
 * annotation writes no ledger entry — it needs the full uuid because the row it
 * writes can never be edited or removed. A prefix that resolves to the WRONG
 * single issue (a typo that still matches something) is not detectable by the
 * store's `LIMIT 2` ambiguity check, and the resulting note is then permanently
 * attached to an unrelated report. Every other write here can be re-aimed by
 * repeating it; this one cannot.
 *
 * The note is secret-redacted on the same path a transition note is — it lands
 * in a shared store whose DSN holders are one trust domain.
 *
 * @param {{annotateFn: Function, id: string, note?: string|null, actor?: string|null}} args
 */
export async function upstreamAnnotate({
  repoRoot = process.cwd(), annotateFn, id, note = null, actor = null,
  cloudEnabled = true, newEventId = () => crypto.randomUUID(),
}) {
  if (!id) return { ok: false, code: 'BAD_INPUT', errors: ['--id is required'] };
  const normId = String(id).trim().toLowerCase();
  if (!ISSUE_ID_OR_PREFIX_RE.test(normId)) {
    return {
      ok: false, code: 'BAD_INPUT',
      errors: [`--id "${id}" is not an issue id — expected at least 8 hex characters `
        + '(dashes allowed). Full ids: npm run upstream:issues'],
    };
  }
  if (!ISSUE_UUID_RE.test(normId)) {
    return {
      ok: false, code: 'BAD_INPUT',
      errors: [`--id "${id}" is a prefix; annotating needs the FULL uuid, because the event `
        + 'it appends is append-only — a note attached to the wrong issue by a prefix that '
        + 'happens to resolve can never be moved or removed. Get it from: npm run upstream:issues'],
    };
  }

  const text = String(note ?? '').trim();
  if (!text) {
    return {
      ok: false, code: 'BAD_INPUT',
      errors: ['--note is required for `annotate` (an annotation IS the note). '
        + 'Pass `--note -` to read it from stdin, which is also how to keep backticks '
        + 'and $ out of your shell.'],
    };
  }

  const safeNote = redactSecrets(text).text;
  // The row's PRIMARY KEY, minted HERE rather than by the column default, so
  // the envelope and the eventual row are the same object: a replay after a
  // lost acknowledgement conflicts on it instead of appending a second copy of
  // a note the append-only log could not then remove.
  const eventId = newEventId();
  const payload = { issueId: normId, eventId, note: safeNote, actor };

  // Write-ahead, exactly as `upstreamReport` does: the envelope lands on disk
  // BEFORE any remote attempt, so a success line is never printed having
  // persisted nothing. The fingerprint is the event id, which is already a
  // safe basename.
  const envelopePath = writeEnvelopeToDir(annotationOutboxDir(repoRoot), {
    v: OUTBOX_ENVELOPE_VERSION, fingerprint: eventId, payload,
    createdAt: new Date().toISOString(),
  });

  if (!cloudEnabled) {
    // The defect this closes: cloud-off used to resolve `{ok:true, cloud:false}`
    // having written nothing anywhere, so the operator's correction was
    // discarded behind a success envelope. It is now queued, and every
    // subsequent `upstream` verb drains it.
    return { ok: true, cloud: false, spooled: true, path: envelopePath, eventId, issueId: normId };
  }

  const res = await annotateFn({ id: normId, note: safeNote, actor, eventId });

  if (res?.ok && res.cloud !== false) {
    fs.rmSync(envelopePath, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
    return { ...res, spooled: false, eventId, issueId: normId };
  }

  // A TERMINAL refusal is not a queue candidate. `notFound`/`ambiguous` are
  // facts about the target that no amount of retrying changes, and the drain is
  // capped and oldest-first — a permanently-failing envelope at the head would
  // block every annotation behind it. The operator is standing right here and
  // gets the error synchronously, so the envelope is removed rather than
  // preserved as evidence they already hold.
  if (res?.notFound || res?.ambiguous) {
    fs.rmSync(envelopePath, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
    return { ...res, ok: false, spooled: false, eventId, issueId: normId };
  }

  // Anything else — the store was reachable enough to try and did not apply the
  // write. Leave it queued and SAY SO, rather than returning a bare failure that
  // implies the note is gone.
  return {
    ok: true, cloud: false, spooled: true, path: envelopePath, eventId, issueId: normId,
    error: res?.error ?? null,
  };
}

/**
 * One issue's full append-only log — the READ side `upstream_issue_events`
 * never had.
 *
 * Until this landed, nothing in the repo SELECTed that table: every event ever
 * written was write-only. Adding an `annotation` without a reader would have
 * been the write-with-no-reader shape rather than a fix for it, so the two ship
 * together.
 *
 * A PREFIX is fine here, unlike on `annotate`: this is a read, a wrong resolve
 * shows the operator the wrong card and nothing is durably wrong, and the
 * store's `LIMIT 2` reports genuine ambiguity rather than picking.
 *
 * @param {{historyFn: Function, id: string}} args
 */
export async function upstreamHistory({ historyFn, id }) {
  if (!id) return { ok: false, code: 'BAD_INPUT', errors: ['--id is required'] };
  const normId = String(id).trim().toLowerCase();
  if (!ISSUE_ID_OR_PREFIX_RE.test(normId)) {
    return {
      ok: false, code: 'BAD_INPUT',
      errors: [`--id "${id}" is not an issue id or id prefix — expected at least 8 `
        + 'hex characters (dashes allowed). Full ids: npm run upstream:issues'],
    };
  }
  return historyFn(normId);
}

/**
 * Render one issue's log. PURE — PowerShell-safe, mirrors `renderWorksheet`.
 *
 * Two things it must do that a plain dump would not:
 *
 *  1. **Mark non-lifecycle events as such, in the render.** An `annotation`
 *     sits in the same chronological stream as the transitions but says nothing
 *     about where the issue is; printed identically it would read as one more
 *     step in the lifecycle, which is precisely the corruption a second `fixed`
 *     event would have caused.
 *  2. **Report a disagreement between the log and the row, never reconcile
 *     it.** `foldEventsToState` re-derives the state from the stream (skipping
 *     non-lifecycle events by construction); the row's `state` column is
 *     written in the same transaction as its event, so the two can only diverge
 *     via an out-of-band write — which is the single thing an append-only log
 *     exists to make visible. Picking a side would hide it.
 */
export function renderIssueHistory({ issue, events }) {
  if (!issue) return 'No such upstream issue.';
  const list = events ?? [];
  const lines = [
    `[${issue.severity}] ${issue.title}`,
    `  id        ${issue.id}`,
    `  from      ${issue.repo_name || issue.repo_id}`,
    `  path      ${issue.affected_path}`,
    `  state     ${issue.state}${issue.disposition ? `  (${issue.disposition})` : ''}`,
    '',
    `  history (${list.length} event(s), append-only):`,
  ];
  if (!list.length) {
    // Never rendered as a clean empty history: a row always has at least its
    // `reported` event, so zero means the log was not read, not that nothing
    // happened.
    lines.push('    (none recorded — every issue has at least a `reported` event, so this is');
    lines.push('     an unread or truncated log, not an empty history)');
  }
  for (const e of list) {
    const when = e.created_at ? new Date(e.created_at).toISOString() : '(no timestamp)';
    const tag = NON_LIFECYCLE_EVENTS.includes(e.event) ? ' [does not change state]' : '';
    lines.push(`    - ${when}  ${e.event}${tag}${e.actor ? `  by ${e.actor}` : ''}`);
    for (const l of String(e.note ?? '').split('\n')) {
      if (l.trim()) lines.push(`        ${l}`);
    }
  }

  const folded = foldEventsToState(list);
  if (folded.unknown.length) {
    lines.push('');
    lines.push(`  NOTE: the log carries event value(s) this tooling does not declare: ${[...new Set(folded.unknown)].join(', ')}.`);
    lines.push('        The state below was derived from the events it DOES understand.');
  }
  if (list.length && folded.state !== null && folded.state !== issue.state) {
    lines.push('');
    lines.push(`  WARNING: the event log folds to "${folded.state}" but the row says "${issue.state}".`);
    lines.push('           These are written in one transaction, so a disagreement means an');
    lines.push('           out-of-band write. Reported, not reconciled — neither side is assumed.');
  }
  lines.push('');
  lines.push(`  annotate  node scripts/cross-skill.mjs upstream annotate --id ${issue.id} --note -`);
  return lines.join('\n');
}

/** Human-grade worksheet — PowerShell-safe (no angle brackets, no raw JSON). */
export function renderWorksheet(items, { state = 'open' } = {}) {
  if (!items.length) return `No ${state} upstream issues.`;
  const lines = [`Upstream issues (${state}) — ${items.length} shown`, ''];
  for (const it of items) {
    const f = it.freshness;
    const stamp = f.verdict === 'stale'
      ? `bundle ${f.distanceAhead} commit(s) behind${f.ageDays !== null ? `, ${f.ageDays}d old` : ''}`
      : f.verdict === 'current' ? 'bundle at HEAD'
        // The dirty case earns its own sentence rather than a bare reason code:
        // "unknown" alone reads as a missing stamp, when in fact a sha IS
        // present and its distance IS measured — it just cannot be trusted, and
        // the consumer may be AHEAD rather than behind. Saying so is the whole
        // point of the field.
        : f.reason === 'source-tree-dirty'
          ? `version unknown — synced from a dirty source tree${f.distanceAhead !== null
            ? `; sha is ${f.distanceAhead} behind but bundle may be AHEAD of it` : ''}`
          : `version unknown (${f.reason})`;
    lines.push(`[${it.severity}] ${it.title}`);
    lines.push(`  id        ${it.id}`);
    lines.push(`  from      ${it.repo_name || it.repo_id}`);
    // path_recognised is a TRI-state and must render as one. `false` and
    // `null` are different claims: `false` means "checked against the
    // reporter's manifest and it is not an upstream-owned file"; `null` means
    // "no manifest was available, so nothing was checked". Rendering `null`
    // the same as `true` — as this line did until 2026-08-11 — silently
    // upgrades an unmade check into a passed one. That is now the COMMON
    // case, not an edge one: the sync manifest is gitignored in consumers, so
    // any fresh clone that has not re-synced reports `null`.
    const pathNote = it.path_recognised === false
      ? '   (NOT an upstream-owned synced file)'
      : it.path_recognised === null || it.path_recognised === undefined
        ? '   (ownership unverified — reporter had no sync manifest)'
        : '';
    lines.push(`  path      ${it.affected_path}${pathNote}`);
    lines.push(`  bundle    ${stamp}`);
    if (it.priorFixes.length) {
      lines.push(`  prior fixes touching this path (evidence, not a verdict):`);
      for (const p of it.priorFixes) {
        lines.push(`    - ${p.commit}  ${p.relation}  ${p.title}`);
      }
    }
    lines.push(`  triage    node scripts/cross-skill.mjs upstream ack --id ${it.id}`);
    lines.push(`            node scripts/cross-skill.mjs upstream fix --id ${it.id} --commit SHA`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * The reconciler (plan §2.4, closes round-1 audit H2/M13's "documents the
 * flaw rather than containing it" critique) — cross-checks the LIVE db's
 * terminal rows against the committed local ledger, both directions, plus
 * flags any row still carrying the generation-time catch-all sentinel.
 *
 * Advisory, cloud-only (mirrors `upstreamList`): the mandatory, cloudless
 * `upstream:coverage:gate` validates the ledger's own internal consistency;
 * THIS is the direction that structurally needs the live db, so it can never
 * be a `check` gate — it degrades to `{ok:true, cloud:false}` exactly like
 * every other db-backed upstream command.
 *
 * @param {{repoRoot?: string, listTerminalFn: () => Promise<{ok:boolean,cloud:boolean,rows:Array}>}} args
 */
export async function upstreamReconcile({ repoRoot = process.cwd(), listTerminalFn, currentStore = null }) {
  const res = await listTerminalFn();
  if (!res.ok || res.cloud === false) return { ...res, reconciliation: null };

  const ledgerPath = path.join(repoRoot, DISPOSITION_LEDGER_PATH);
  let ledgerEntries = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
    ledgerEntries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch {
    // Absent/unreadable ledger is a legitimate state to REPORT (every DB row
    // is then "missing from ledger"), never a reason to throw — the whole
    // point of this command is to surface exactly that gap.
  }

  const reconciliation = computeLedgerReconciliation({ dbRows: res.rows, ledgerEntries, currentStore });

  // WHY a missing entry is missing — the two causes take OPPOSITE remedies, and
  // reporting only one of them is what nearly produced a hand-written duplicate
  // of entries already pushed (plan §1.1). Best-effort: any git failure
  // degrades to `unknown`, which refuses repair rather than guessing.
  let missingCause = null;
  if (reconciliation.missingFromLedger.length > 0) {
    const freshness = resolveBaseFreshness({ repoRoot });
    const upstreamEvidence = readUpstreamLedgerEvidence({ freshness, repoRoot });
    // ONE SNAPSHOT, TAKEN HERE (code-audit R2 H1). The precondition `--apply`
    // re-verifies must describe the state this CLASSIFICATION was made from, so
    // both halves are captured together at classification time. An earlier
    // version pinned the commit here and hashed the ledger later, inside
    // `--apply` — two moments, so a change landing between them was invisible
    // to both checks and the "precondition" described a state that never
    // existed as a whole.
    missingCause = {
      ...classifyMissingCause({
        missingIds: reconciliation.missingFromLedger, freshness, upstreamEvidence,
      }),
      freshness,
      evidenceStatus: upstreamEvidence.status,
      precondition: captureReconcilePrecondition(repoRoot),
    };
  }

  return { ok: true, cloud: true, reconciliation, missingCause };
}

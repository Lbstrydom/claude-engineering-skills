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

import { atomicWriteFileSync } from '../file-io.mjs';
import {
  parseEnvelopeFrame, writeEnvelope as writeEnvelopeToDir, drainEnvelopes,
} from '../outbox-envelope.mjs';
import { redactSecrets } from '../secret-patterns.mjs';
import { parseDisposition, formatDisposition, computeLedgerReconciliation } from './dispositions.mjs';

/** Where the committed closure-disposition ledger lives (§2.4). */
export const DISPOSITION_LEDGER_PATH = 'scripts/upstream-dispositions.json';

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
 * Read + parse the committed disposition ledger. Never throws — an absent
 * file (first-ever transition in a fresh checkout) is `[]`, not an error;
 * a present-but-corrupt file is also `[]` so the write path below can still
 * proceed with a fresh array rather than blocking every future transition on
 * a hand-fixable JSON typo (the GATE, not this write path, is what enforces
 * the ledger's integrity for `npm run check`).
 *
 * @param {string} repoRoot
 * @returns {Array<object>}
 */
function readDispositionLedger(repoRoot) {
  const p = path.join(repoRoot, DISPOSITION_LEDGER_PATH);
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

/**
 * Upsert one entry into the committed ledger, keyed by `issueId` (exactly one
 * active disposition per upstream issue — a re-transition on the same issue
 * REPLACES its prior entry rather than appending a second one).
 *
 * Called BEFORE the DB write (§2.4's sequential ledger-then-DB order) — the
 * cheap local write happens first, so a crash between this call and the DB
 * write leaves the ledger AHEAD of the store rather than the reverse; the
 * cloud reconciler (`upstream list --worksheet`) is the advisory backstop for
 * exactly that gap, not this function.
 *
 * @param {string} repoRoot
 * @param {{issueId: string, state: string, disposition: {kind: string, value: string}}} entry
 */
function upsertDispositionLedgerEntry(repoRoot, entry) {
  const p = path.join(repoRoot, DISPOSITION_LEDGER_PATH);
  const entries = readDispositionLedger(repoRoot);
  const withoutThis = entries.filter((e) => e?.issueId !== entry.issueId);
  withoutThis.push({
    schemaVersion: 1,
    issueId: entry.issueId,
    state: entry.state,
    disposition: entry.disposition,
    recordedAt: new Date().toISOString(),
  });
  const payload = {
    _description: 'The upstream-report closure-disposition ledger (consumer-friction-doctor plan §2.4). '
      + 'One entry per TERMINAL (fixed|wont_fix) upstream_issues row, naming EITHER a doctor probe that now '
      + 'detects the failure class, a tracked regression test that closes it, or a written exemption. '
      + 'Validated by `npm run upstream:coverage:gate`. Hand-authored source, same species as '
      + 'scripts/gate-contracts/_exemptions.json — never generated, never synced to consumers.',
    entries: withoutThis.sort((a, b) => (a.issueId < b.issueId ? -1 : a.issueId > b.issueId ? 1 : 0)),
  };
  atomicWriteFileSync(p, `${JSON.stringify(payload, null, 2)}\n`);
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
  disposition = null,
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
  if (!/^[0-9a-f][0-9a-f-]{7,35}$/.test(normId)) {
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
  if (parsedDisposition && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normId)) {
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
    upsertDispositionLedgerEntry(repoRoot, { issueId: normId, state: to, disposition: safeDispositionValue });
  }

  return transitionFn({
    id: normId, to, note: safeNote, commit, actor,
    disposition: parsedDisposition ? formatDisposition(safeDispositionValue) : null,
  });
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
export async function upstreamReconcile({ repoRoot = process.cwd(), listTerminalFn }) {
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

  const reconciliation = computeLedgerReconciliation({ dbRows: res.rows, ledgerEntries });
  return { ok: true, cloud: true, reconciliation };
}

/** Human-grade reconciliation report — PowerShell-safe, mirrors renderWorksheet. */
export function renderReconciliationReport({
  missingFromLedger, ledgerOnly, stateMismatch, dispositionMismatch = [], needsReview,
}) {
  const clean = missingFromLedger.length === 0 && ledgerOnly.length === 0
    && stateMismatch.length === 0 && dispositionMismatch.length === 0 && needsReview.length === 0;
  if (clean) return 'Reconciliation: clean — every terminal db row matches a ledger entry, and no row needs manual review.';

  const lines = ['Reconciliation — divergence found:', ''];
  if (missingFromLedger.length) {
    lines.push(`Terminal db row(s) with NO ledger entry (${missingFromLedger.length}) — the accepted crash-window gap, now surfaced:`);
    for (const id of missingFromLedger) lines.push(`  - ${id}`);
    lines.push('');
  }
  if (ledgerOnly.length) {
    lines.push(`Ledger entr(y/ies) with no matching db row (${ledgerOnly.length}) — stale, or the issueId was mistyped:`);
    for (const id of ledgerOnly) lines.push(`  - ${id}`);
    lines.push('');
  }
  if (stateMismatch.length) {
    lines.push(`State mismatch between ledger and db (${stateMismatch.length}):`);
    for (const m of stateMismatch) lines.push(`  - ${m}`);
    lines.push('');
  }
  if (dispositionMismatch.length) {
    lines.push(`Disposition VALUE mismatch between ledger and db (${dispositionMismatch.length}):`);
    for (const m of dispositionMismatch) lines.push(`  - ${m}`);
    lines.push('');
  }
  if (needsReview.length) {
    lines.push(`Row(s) still carrying the generation-time catch-all (${needsReview.length}) — needs a REAL, researched disposition:`);
    for (const id of needsReview) lines.push(`  - ${id}`);
    lines.push('');
  }
  return lines.join('\n');
}

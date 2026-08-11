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
import { redactSecrets } from '../secret-patterns.mjs';

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
  if (shaInHistory === false) return out('unknown', 'sha-not-in-history');
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
  if (sourceDirty === true) return out('unknown', 'source-tree-dirty');
  if (distanceAhead === null || distanceAhead === undefined) {
    return out('unknown', 'git-unavailable');
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
 */
export function parseEnvelope(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.v !== OUTBOX_ENVELOPE_VERSION) return null;
  if (typeof parsed.fingerprint !== 'string' || !parsed.fingerprint) return null;
  const p = parsed.payload;
  if (!p || typeof p !== 'object') return null;
  if (typeof p.title !== 'string' || typeof p.body !== 'string') return null;
  if (!VALID_SEVERITIES.includes(p.severity)) return null;
  if (typeof p.affectedPath !== 'string') return null;
  return parsed;
}

/** Write-ahead: the envelope lands on disk BEFORE any remote attempt. */
export function writeEnvelope(repoRoot, envelope) {
  const dir = outboxDir(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${envelope.fingerprint}.json`);
  atomicWriteFileSync(file, JSON.stringify(envelope, null, 2) + '\n');
  return file;
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
  const dir = outboxDir(repoRoot);
  if (!fs.existsSync(dir)) return { drained: 0, rejected: 0, failed: 0 };

  let entries;
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).slice(0, cap);
  } catch { return { drained: 0, rejected: 0, failed: 0 }; }

  let drained = 0, rejected = 0, failed = 0;
  for (const name of entries) {
    const file = path.join(dir, name);
    let envelope = null;
    try { envelope = parseEnvelope(fs.readFileSync(file, 'utf-8')); } catch { envelope = null; }

    if (!envelope) {
      // Quarantine, never delete and never retry forever: a poison envelope
      // must not block the queue or vanish silently.
      try {
        fs.mkdirSync(rejectedDir(repoRoot), { recursive: true });
        fs.renameSync(file, path.join(rejectedDir(repoRoot), name));
        rejected++;
      } catch { failed++; }
      continue;
    }

    try {
      const res = await recordFn({ ...envelope.payload, fingerprint: envelope.fingerprint });
      if (res?.ok && res.cloud !== false) {
        fs.rmSync(file, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
        drained++;
      } else {
        failed++;   // cloud off or write failed — leave it for next time
      }
    } catch { failed++; }
  }
  return { drained, rejected, failed };
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
 */
export async function upstreamTransition({
  repoRoot = process.cwd(), transitionFn, id, to, note = null, commit = null, actor = null,
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
  const safeNote = note ? redactSecrets(String(note)).text : null;
  return transitionFn({ id: normId, to, note: safeNote, commit, actor });
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

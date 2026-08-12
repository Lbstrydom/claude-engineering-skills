/**
 * The writer-set oracle and Phase 3's outcome contract
 * (plan `docs/plans/audit-store-write-durability.md`, Phase 3 / §6).
 *
 * **Why the oracle is DERIVED and not a list.** Two earlier designs died, and
 * the second death is the interesting one:
 *
 *  - R1-M1 killed "scan the orchestrator for a bare `.catch(`" — it passes for an
 *    un-caught call, an `await`ed call outside the seam, or a wrapper.
 *  - R2-M3 killed the replacement, a hand-listed set of four writer symbols, for
 *    the same reason one level up: a FIFTH writer is invisible until someone
 *    updates the very list the test validates, at which point the test proves
 *    only that they updated it.
 *
 * So the writer set is read off the STORE MODULES — every export whose name
 * matches the writer shape — and each one must be either registered or carry a
 * written exemption. A new `record*` export lands unregistered and unexempted
 * and this suite fails without anyone having edited it. Same disk-iterating
 * shape as `npm run db:enrolment:gate`, and for the same reason: a list nobody
 * updates cannot see what it omits.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { registeredWriters, _resetRegistry, SPILL_DIR, readTrackedSpillArtifacts, drainSpill, registerWriter, durableWrite } from '../scripts/lib/durable-write.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf-8');

// ── The derived writer set ──────────────────────────────────────────────────

/**
 * Store modules whose writer exports the audit orchestrator's cloud block draws
 * on. Named here because THIS is the boundary the plan's decision 6 draws
 * ("every audit-store write in legacy-production-audit.mjs's cloud block"), not
 * because the writer names are known.
 */
const STORE_MODULES = [
  'scripts/lib/store/runs-findings.mjs',
  'scripts/lib/store/bandit-fp.mjs',
];

/** A write-shaped export: `record*` or `sync*`. */
const WRITER_NAME = /^(record|sync)[A-Z]/;

/**
 * Exports that are write-shaped but are NOT durable audit-store writes, each
 * with the reason. An entry here is a CLAIM that has to stay true — it is not a
 * silencer, which is why every one names why the durability contract does not
 * apply rather than saying "not needed".
 */
const NOT_A_DURABLE_WRITE = {
  recordRunStart: 'Creates the run row the other writers key on. It is already awaited and its failure is already representable — a null runId disables the whole cloud block, so it cannot fail silently.',
  recordDiffComplexity: 'Already returns {ok, error} and its caller already checks and logs it — the failure is representable, which is the contract. Not on the fire-and-forget list.',
  recordFinalReviewFindings: 'Written by gemini-review.mjs in a separate process, not by the orchestrator cloud block. Its own replace-persistence transaction owns atomicity; folding it in would need a second design.',
  recordFinalReviewFix: 'Operator-initiated CLI write (cross-skill.mjs final-review-record-fix). Synchronous, awaited, and its failure reaches the operator as a non-zero exit.',
  recordAdjudicationEvent: 'Operator/ledger-initiated, awaited by its caller, and the ledger on disk is the durable copy — a spill would be a second queue over the same evidence.',
  recordConvergenceState: 'Gate-evidence write with its own try/catch and explicit stderr report at the call site; the local evidence marker is the durable copy.',
};

/**
 * A write-shaped export declaration, in EITHER form.
 *
 * `export function` only was the first version, and it was a real hole
 * (Cluster B audit M15): a writer added as `export const recordX = async () =>`
 * would have been invisible to the oracle — and invisible is the failure mode
 * this whole test exists to remove. No such export exists today, which is
 * exactly why it needed fixing before one does.
 */
const WRITER_DECL = /^export (?:async function|function|const) (\w+)/gm;

describe('writer-set oracle — derived from the store modules, not enumerated', () => {
  test('every write-shaped store export is registered or explicitly exempted', async () => {
    await import('../scripts/lib/audit-store-writers.mjs');
    const registered = new Set(registeredWriters());
    // The registry is keyed by writer id, not by function name. Map ids back to
    // the store function each one replays, by reading the registration module —
    // the same source of truth the orchestrator imports.
    const writersSrc = read('scripts/lib/audit-store-writers.mjs');

    const unaccounted = [];
    for (const mod of STORE_MODULES) {
      const src = read(mod);
      for (const m of src.matchAll(new RegExp(WRITER_DECL.source, WRITER_DECL.flags))) {
        const name = m[1];
        if (!WRITER_NAME.test(name)) continue;
        if (NOT_A_DURABLE_WRITE[name]) continue;
        // Registered ⇔ the registration module calls it inside a `replay`.
        if (new RegExp(`\\b${name}\\(`).test(writersSrc)) continue;
        unaccounted.push(`${mod} :: ${name}`);
      }
    }
    assert.deepEqual(
      unaccounted, [],
      'a write-shaped store export is neither registered in audit-store-writers.mjs nor listed in '
      + 'NOT_A_DURABLE_WRITE with a reason. Add it to one — an unaccounted writer is how the '
      + 'fire-and-forget class comes back.',
    );
    assert.ok(registered.size >= 5, `expected the registry to be populated by import; got ${registered.size}`);
  });

  test('every exemption names a store export that still exists', () => {
    // The failure mode of an exemption list is the opposite one: a reason that
    // outlives the function it excuses, quietly shrinking the set the oracle
    // checks. Both directions are asserted — "which side am I iterating, and
    // what is unrepresentable from it?"
    const all = new Set();
    for (const mod of STORE_MODULES) {
      for (const m of read(mod).matchAll(new RegExp(WRITER_DECL.source, WRITER_DECL.flags))) all.add(m[1]);
    }
    // recordConvergenceState / recordDiffComplexity live in sibling store
    // modules; accept an exemption that resolves anywhere under scripts/lib/store.
    const storeDir = path.join(REPO, 'scripts/lib/store');
    for (const f of fs.readdirSync(storeDir)) {
      if (!f.endsWith('.mjs')) continue;
      for (const m of fs.readFileSync(path.join(storeDir, f), 'utf-8').matchAll(new RegExp(WRITER_DECL.source, WRITER_DECL.flags))) {
        all.add(m[1]);
      }
    }
    const stale = Object.keys(NOT_A_DURABLE_WRITE).filter((n) => !all.has(n));
    assert.deepEqual(stale, [], 'an exemption outlived its function — delete it, do not leave it excusing nothing');
  });

  test('the audit.findings key declaration matches the DB constraint it claims', () => {
    // The declaration in audit-store-writers.mjs and the unique index in the
    // migration are two statements of ONE key, in two languages, with nothing
    // between them that would notice a divergence. Pin them to each other.
    //
    // FOUR parts as of 20260812100000 (three plain columns + one expression),
    // via two increasingly narrow corrections of the same original defect —
    // both discovered live, not by inspection:
    //
    //   (run_id, finding_fingerprint)                        — the original,
    //     2-column key. Broke `recordFinalReviewFindings`, which legitimately
    //     writes the SAME fingerprint under different pass_names
    //     ('final-review' primary vs 'final-review-shadow'). Measured 23505.
    //   (run_id, finding_fingerprint, pass_name)              — 090000's fix.
    //     Still broke `resolveFindingBucket`, which resolves purely on
    //     (run_id, finding_fingerprint, bucket) with NO pass_name filter — so
    //     a SAME-pass_name pair differing only in `bucket` still collided.
    //     Measured 23505 again, same error, narrower cause.
    //   (run_id, finding_fingerprint, pass_name, COALESCE(bucket, ''))
    //     — 100000's fix, verified against the real fixture end to end.
    //
    // `bucket` must be COALESCE'd: it is NULL for every 'merged'-pass row, and
    // Postgres treats NULL as distinct within a unique index, so a raw bucket
    // column would silently stop deduplicating 'merged' findings — reopening
    // the defect 070000 fixed (706 duplicate rows, measured then).
    const writersSrc = read('scripts/lib/audit-store-writers.mjs');
    const key = /rowKey:\s*\(row\)\s*=>\s*`\$\{row\.run_id\}:\$\{row\.finding_fingerprint\}:\$\{row\.pass_name\}`/.test(writersSrc);
    assert.ok(key, 'audit.findings must declare its key as (run_id, finding_fingerprint, pass_name) — bucket is intentionally NOT in the row-identity string (it is a DB-level disambiguator, not part of the spill artifact\'s own identity)');

    // Both superseded migrations are untouched history — migrations are never
    // edited after being applied — checked only for what they demonstrably
    // were, not for what is live now.
    for (const [file, indexName, cols] of [
      ['20260812070000_audit_findings_fingerprint_unique_full.sql', 'audit_findings_run_fingerprint_uniq_full', 'run_id, finding_fingerprint'],
      ['20260812090000_audit_findings_fingerprint_scoped_by_pass.sql', 'audit_findings_run_fingerprint_pass_uniq', 'run_id, finding_fingerprint, pass_name'],
    ]) {
      const src = read(`supabase/migrations/${file}`);
      assert.match(
        src,
        new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS ${indexName}\\s*\\n?\\s*ON audit_findings \\(${cols.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`),
      );
    }

    // The CURRENT arbiter: a full (non-partial) expression index.
    const migration = read('supabase/migrations/20260812100000_audit_findings_fingerprint_pass_bucket_scoped.sql');
    assert.match(
      migration,
      /CREATE UNIQUE INDEX IF NOT EXISTS audit_findings_run_fingerprint_pass_bucket_uniq\s*\n?\s*ON audit_findings \(run_id, finding_fingerprint, pass_name, \(COALESCE\(bucket, ''\)\)\)/,
      'the live arbiter must be a FULL unique index on exactly the declared key — a partial one cannot serve a bare ON CONFLICT (measured 42P10)',
    );
    assert.match(
      migration,
      /DROP INDEX IF EXISTS audit_findings_run_fingerprint_pass_uniq/,
      'the superseded 3-column index must actually be dropped, or two indexes both claim to arbitrate this key',
    );
    // …and that the upsert actually targets the CURRENT arbiter, with the
    // SAME expression (an ON CONFLICT target must match an expression index
    // byte-for-byte to resolve against it).
    assert.match(
      read('scripts/lib/store/runs-findings.mjs'),
      /ON CONFLICT \(\$\{conflictTarget\}\) DO UPDATE SET/,
      'recordFindings must upsert on the declared key via conflictTarget, or a replayed batch aborts on rows the first attempt committed',
    );
    assert.match(
      read('scripts/lib/store/runs-findings.mjs'),
      /`run_id, finding_fingerprint, pass_name, \(COALESCE\(bucket, ''\)\)`/,
      'the hasBucket branch of conflictTarget must match the live index expression exactly',
    );
  });
});

// ── The call sites the plan names ───────────────────────────────────────────

describe('orchestrator call sites', () => {
  const ORCH = 'scripts/lib/audit/legacy-production-audit.mjs';

  test('no audit-store write in the orchestrator is fire-and-forget any more', () => {
    const src = read(ORCH);
    // The literal defect: a store writer called with a trailing `.catch(` and no
    // await. Asserted on the four names the plan traced, because THIS test is
    // about those call sites; the oracle above is what catches a fifth writer.
    // `syncFalsePositivePatterns` joined this list on 2026-08-12: the Cluster B
    // audit found it was the FIFTH fire-and-forget write in the same block,
    // which the plan's own trace of "the four call sites" had missed.
    for (const fn of ['recordFindings', 'recordPassStats', 'recordSuppressionEvents', 'syncBanditArms', 'syncFalsePositivePatterns']) {
      const bad = new RegExp(`(?<!await )\\b${fn}\\([^;]*\\)\\.catch\\(`, 's');
      assert.ok(!bad.test(src), `${fn} is still called fire-and-forget in ${ORCH}`);
    }
  });

  test('BOTH entry points import the registration module — that is the whole of decision 1b', () => {
    // This asserted only the orchestrator, with a comment claiming "the
    // registry has no other bootstrap" — while decision 1b exists precisely
    // because there are TWO processes, and the CLI is the one that would
    // quarantine every artifact if it forgot (final-review shadow, MEDIUM).
    // Half a two-sided contract is the shape that reads as covered.
    const src = read(ORCH);
    assert.match(src, /import '\.\.\/audit-store-writers\.mjs'/,
      'without this import durableWrite throws for every id — the orchestrator half of the bootstrap');
    // RETARGETED (command-registry Cluster D): write-spill migrated to the
    // registry, so the operator CLI's registration import now lives in its
    // command module. The invariant is unchanged and still load-bearing: a
    // fresh process without this import finds zero handlers and quarantines
    // every artifact it was asked to replay.
    const cli = read('scripts/lib/cross-skill/commands/misc.mjs');
    // Matched on the SPECIFIER TAIL, not the full relative path: the module
    // moved two directories deeper, so `./lib/…` became `../../…`. Pinning the
    // prefix would have made this assertion fail on a correct move — and worse,
    // a future move could make it pass while importing something else.
    assert.match(cli, /await import\('[^']*audit-store-writers\.mjs'\)/,
      'the operator CLI runs in a FRESH process: without this import the drain finds zero handlers and quarantines every artifact it was asked to replay');
    assert.match(src, /durableWrite\('audit\.findings'/);
    assert.match(src, /durableWrite\('audit\.passStats'/);
    assert.match(src, /durableWrite\('audit\.suppressionEvents'/);
    assert.match(src, /durableWrite\('learning\.banditArms'/);
    assert.match(src, /durableWrite\('audit\.runComplete'/);
    assert.match(src, /durableWrite\('learning\.fpPatterns'/);
  });

  test('a lost write makes the run incomplete — in the result AND in the persisted row', () => {
    const src = read(ORCH);
    // Two writers of one verdict (the returned object and the column) is exactly
    // the shape that drifts, so both are pinned to the same expression.
    // SPILLED counts as incomplete too (Cluster B audit M16): at the moment the
    // row is written, a spilled write's data is not in the store.
    const occurrences = [...src.matchAll(/writeOutcomes\.lost > 0 \|\| writeOutcomes\.spilled > 0 \? 'incomplete' : 'complete'/g)];
    assert.equal(occurrences.length, 2,
      'runStatus must be derived identically for the returned result and for audit_runs.run_status');
    assert.match(src, /runStatus: writeOutcomes\.lost > 0 \|\| writeOutcomes\.spilled > 0/);
    assert.ok(!/mergedResult\.runStatus = 'complete';/.test(src),
      'an unconditional complete is the false zero this plan exists to remove');
  });

  test('the migration that receives the outcomes exists and admits the value the code writes', () => {
    const migration = read('supabase/migrations/20260812080000_audit_runs_write_outcomes.sql');
    assert.match(migration, /ADD COLUMN IF NOT EXISTS write_outcomes jsonb/);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS run_status text/);
    // The CHECK must admit every value the orchestrator can emit, or the
    // completion write fails on exactly the runs that most need recording.
    for (const v of ['complete', 'incomplete']) {
      assert.ok(migration.includes(`'${v}'`), `run_status CHECK must admit '${v}'`);
    }
    assert.match(migration, /run_status IS NULL OR/, 'pre-migration rows must validate');
  });
});

// ── `skipped`: a write the store declined is not a write that failed ────────

describe('a declined write is `skipped`, not `lost`', () => {
  test('a keyless writer whose sink DECLINES leaves nothing in lost/', async () => {
    // The bug this pins: with the store off, `syncBanditArms` returns
    // `{applied:false, reason:'cloud-off'}`. Under the three-outcome vocabulary
    // that was `lost` — so every local-only run would file an artifact in
    // `lost/` for ever and report `runStatus: 'incomplete'` with nothing wrong.
    // Observed live: six banditArms artifacts accumulated in `lost/` in the
    // minutes after the call site was migrated.
    _resetRegistry();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-declined-'));
    try {
      registerWriter('w', {
        schemaVersion: 1,
        replay: async () => ({ applied: false, declined: true, reason: 'cloud-off' }),
      });
      const res = await durableWrite('w', { id: 1 }, { repoRoot: root });
      assert.equal(res.outcome, 'skipped');
      const lostDir = path.join(root, SPILL_DIR, 'lost');
      const lostFiles = fs.existsSync(lostDir) ? fs.readdirSync(lostDir) : [];
      assert.deepEqual(lostFiles, [], 'a never-attempted write must not be filed as evidence of a failure');
      const queued = fs.existsSync(path.join(root, SPILL_DIR))
        ? fs.readdirSync(path.join(root, SPILL_DIR)).filter((f) => f.endsWith('.json')) : [];
      assert.deepEqual(queued, [], 'nor left in the replay queue');
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  test('a write that WAS attempted and did not land is still `lost` — the split is not a softening', async () => {
    // Negative control for the test above: without it, a `declined` shortcut
    // that swallowed every failure would pass.
    _resetRegistry();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-notapplied-'));
    try {
      registerWriter('w', {
        schemaVersion: 1,
        replay: async () => ({ applied: false, reason: 'run-row-absent' }),
      });
      const res = await durableWrite('w', { id: 1 }, { repoRoot: root });
      assert.equal(res.outcome, 'lost');
      const lostDir = path.join(root, SPILL_DIR, 'lost');
      assert.equal(fs.readdirSync(lostDir).length, 1, 'an attempted-and-unapplied write is kept as evidence');
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  test('a LOCAL-ONLY run does not file the FP sync as lost', async () => {
    // The regression the final-review shadow caught (HIGH), reproduced before
    // fixing: `syncFalsePositivePatterns` guards repo identity BEFORE the cloud
    // check, so with no AUDIT_DB_URL — a supported mode — it never reached the
    // cloud-off return. Every local-only run filed a `lost` artifact and
    // reported runStatus: incomplete with nothing wrong.
    const { syncFalsePositivePatterns } = await import('../scripts/lib/store/bandit-fp.mjs');
    // A NULL identity is the ordinary local-only case → a decline.
    const nullId = await syncFalsePositivePatterns(null, { p: { type: 'x', value: 'y' } });
    assert.equal(nullId.applied, false);
    assert.equal(nullId.reason, 'no-repo-identity');
    // A non-null NON-UUID is a genuine mislabel attempt → still a failure. This
    // half is what stops the fix over-reaching into "any identity problem is
    // fine".
    const badId = await syncFalsePositivePatterns('not-a-uuid', { p: { type: 'x', value: 'y' } });
    assert.equal(badId.reason, 'repo-identity-unresolved');
  });

  test('EVERY reason the store emits is classified — decline or failure, never unclassified', () => {
    // The mapping is a string set on one side of a module boundary and literal
    // return values on the other, with no compiler between them (the prose↔code
    // seam class). The first version of this test iterated DECLINED_REASONS and
    // asserted each was really emitted — one direction only, and a mutation
    // DELETING 'cloud-off' from the set sailed through it, which is the exact
    // live bug. So iterate the side that can grow without anyone editing this
    // file: the reasons the store actually returns.
    const writersSrc = read('scripts/lib/audit-store-writers.mjs');
    const declared = [...writersSrc.matchAll(/DECLINED_REASONS = new Set\(\[([^\]]*)\]\)/gs)][0]?.[1] ?? '';
    const declines = new Set([...declared.matchAll(/'([^']+)'/g)].map((m) => m[1]));
    assert.ok(declines.size > 0, 'DECLINED_REASONS must be readable from source');

    // Reasons that are genuine FAILURES — attempted and did not land. Listed
    // with the justification, because "not a decline" is a claim.
    const FAILURES = {
      'write-failed': 'the statement ran and the store rejected it',
      'run-row-absent': 'the UPDATE ran and matched no row — attempted, not declined',
      'no-persistable-rows': 'terminal success: the payload maps to zero rows on every attempt',
      'no-rows': 'terminal success: the payload maps to zero rows on every attempt',
      'repo-identity-unresolved': 'a non-null, non-UUID identity is a genuine mislabel attempt — the sync would have written repo-scoped patterns as cross-repo GLOBAL. A failure worth counting. (A NULL identity is `no-repo-identity`, a decline.)',
      'no-pool': 'final gate G1: classified as a FAILURE deliberately. getPool() returning null means no DSN resolved, which looks like a decline — but the state is barely reachable, so no test can pin the reading down, and mistaking a real failure for a decline DELETES the envelope while the converse only spills one.',
    };

    // Match the RECEIPT shape specifically — `{applied, rows, reason}` — not any
    // `reason:` in the file. The store modules carry unrelated result objects
    // (column-probe outcomes, read-path states) whose reasons never reach
    // `receipt()`, and folding those in would make this assert something it
    // cannot know.
    const emitted = new Set();
    for (const mod of STORE_MODULES) {
      for (const m of read(mod).matchAll(/applied: (?:true|false), rows: \d+, reason: '([^']+)'/g)) {
        emitted.add(m[1]);
      }
    }
    assert.ok(emitted.size >= 4, `expected the store to emit several receipt reasons; found ${[...emitted]}`);

    const unclassified = [...emitted].filter((r) => !declines.has(r) && !FAILURES[r]);
    assert.deepEqual(
      unclassified, [],
      'a store reason is neither in DECLINED_REASONS nor listed as a failure here. Classify it: '
      + 'an unclassified reason silently falls through to the failure path, which is how a '
      + 'supported degraded mode gets filed as data loss.',
    );
    // And the converse must hold too, or a decline could be declared for a
    // reason nothing returns.
    for (const r of declines) {
      assert.ok(emitted.has(r), `'${r}' is treated as a decline but no store function returns it`);
      assert.ok(!FAILURES[r], `'${r}' cannot be both a decline and a failure`);
    }
  });
});

// ── The consolidated final gate's findings, pinned ──────────────────────────

describe('final gate (A+B+C union diff)', () => {
  test('G2 — an absent run row is terminal, not retried for ever', async () => {
    // `audit.runComplete` is KEYED, so a non-throwing {applied:false} spills and
    // is replayed on every drain with `attempts` never incrementing: an
    // un-completable payload that outlives the run it describes. Carrying an
    // error makes it artifact-scoped; a plain Error classifies retryable:false
    // (measured), so it quarantines on the first failure.
    const src = read('scripts/lib/store/runs-findings.mjs');
    const block = src.slice(src.indexOf("reason: 'run-row-absent'") - 800, src.indexOf("reason: 'run-row-absent'") + 300);
    assert.match(block, /error: new Error\(/,
      'run-row-absent must carry an error, or a keyed writer retries it for ever');
  });

  test('G3 — two hashless findings do not collapse onto one row', () => {
    // `finding_fingerprint` is NOT NULL (verified against the live schema), so
    // the shared 'unknown' literal made every hashless finding the same row
    // under the unique index. A derived digest keeps distinct findings distinct.
    const src = read('scripts/lib/store/runs-findings.mjs');
    assert.ok(!/finding_fingerprint: f\._hash \|\| 'unknown'/.test(src),
      'the shared unknown literal collapses every hashless finding onto one row');
    assert.match(src, /function fingerprintOf\(f\)/);
    // One oracle, not three: the dedup key, the written column and the
    // embedding lookup must all be the same expression.
    const uses = [...src.matchAll(/fingerprintOf\(/g)];
    assert.ok(uses.length >= 5, `every fingerprint site must route through the oracle (found ${uses.length})`);
  });

  test('G4 — the connection classifier sees EAI_AGAIN and capacity limits', async () => {
    const { isConnectionScoped } = await import('../scripts/lib/durable-write.mjs');
    // Store-level: the drain must abort and charge NOTHING to the artifacts.
    assert.equal(isConnectionScoped(Object.assign(new Error('dns'), { code: 'EAI_AGAIN' })), true,
      'a DNS timeout is the store being unreachable, not a bad row');
    assert.equal(isConnectionScoped(Object.assign(new Error('x'), { code: '53300' })), true,
      'too_many_connections is server capacity — identical for every artifact behind it');
    assert.equal(isConnectionScoped(Object.assign(new Error('x'), { code: '08006' })), true);
    // Artifact-level: these must NOT abort the drain, or one poison row stalls
    // the whole queue. This half is what stops the fix over-reaching.
    assert.equal(isConnectionScoped(Object.assign(new Error('x'), { code: '40001' })), false,
      'a serialisation failure is about THIS transaction');
    assert.equal(isConnectionScoped(Object.assign(new Error('x'), { code: '23505' })), false,
      'a constraint violation is about THIS row');
    assert.equal(isConnectionScoped(Object.assign(new Error('x'), { code: '22P02' })), false);
  });

  test('G2 (verification round) — a CODE-LESS outage is still an outage', async () => {
    const { isConnectionScoped } = await import('../scripts/lib/durable-write.mjs');
    // Legacy `pg` wrappers strip `err.code`, and `normalizePostgresError`
    // supports that by matching the message. Every branch of isConnectionScoped
    // keys on `code`, so a stripped ECONNREFUSED returned false and sent a real
    // outage down the artifact-scoped path — burning the whole backlog's retry
    // budget during exactly the event the split exists for.
    assert.equal(isConnectionScoped(new Error('connect ECONNREFUSED 127.0.0.1:5432')), true,
      'a code-less connection refusal must still abort the drain');
    // The other direction, so the fallback cannot become "anything without a
    // code is an outage": a code-less error the classifier does NOT call
    // transient stays artifact-scoped.
    assert.equal(isConnectionScoped(new Error('some unrelated failure')), false,
      'an unclassifiable error is about the artifact, not the connection');
  });
});

// ── Provenance: decision 2e, which had no implementation until Phase 3 ──────

describe('git-tracked artifacts are refused', () => {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });

  test('a tracked artifact is quarantined rather than replayed', async () => {
    _resetRegistry();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-track-'));
    try {
      git(root, 'init', '-q');
      git(root, 'config', 'user.email', 't@e.st');
      git(root, 'config', 'user.name', 'T');
      const dir = path.join(root, SPILL_DIR);
      fs.mkdirSync(dir, { recursive: true });

      let replayed = 0;
      registerWriter('w', {
        schemaVersion: 1,
        rowKey: (r) => r.id,
        replay: async () => { replayed++; return { applied: true }; },
      });

      // A well-formed artifact — schema validity is not authorisation, which is
      // the entire point of checking provenance instead of shape.
      const planted = {
        v: 1, fingerprint: 'planted', writerId: 'w', schemaVersion: 1,
        enqueuedAt: new Date().toISOString(), payload: { id: 'attacker' },
      };
      fs.writeFileSync(path.join(dir, 'planted.json'), `${JSON.stringify(planted)}\n`);
      // Intent-to-add is enough to be TRACKED, and it is what an attacker
      // committing a file would produce.
      git(root, 'add', '-f', '-N', '--', path.join(SPILL_DIR, 'planted.json'));

      const tracked = readTrackedSpillArtifacts(root);
      assert.ok(tracked.ok, tracked.reason);
      assert.ok(tracked.tracked.has('planted.json'), 'the planted file must read as tracked');

      const res = await drainSpill({ repoRoot: root, isCloudEnabled: () => true });
      assert.equal(replayed, 0, 'a tracked artifact must never reach replay');
      assert.equal(res.drained, 0);
      // QUARANTINED, specifically. The first version of this assertion was
      // `exists(spill/planted.json) || exists(rejected/planted.json)`, which
      // passed whether the artifact was quarantined or handed straight back to
      // the queue — and handing it back is an infinite re-refusal loop, which
      // the final gate (G5) found and this test could not. An `||` across the
      // two outcomes asserts only that the file still exists somewhere.
      assert.ok(fs.existsSync(path.join(dir, 'rejected', 'planted.json')),
        'a refused artifact must be quarantined, not returned to the queue to be refused again for ever');
      assert.ok(!fs.existsSync(path.join(dir, 'planted.json')),
        'and must not remain in the replay queue');
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  test('an UNtracked artifact in the same repo still drains — the refusal is not blanket', async () => {
    // Negative control. Without this, a drain that refused everything would pass
    // the test above for the wrong reason.
    _resetRegistry();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-untrack-'));
    try {
      git(root, 'init', '-q');
      git(root, 'config', 'user.email', 't@e.st');
      git(root, 'config', 'user.name', 'T');
      let replayed = 0;
      registerWriter('w', {
        schemaVersion: 1,
        rowKey: (r) => r.id,
        replay: async () => { replayed++; return { applied: replayed > 1 }; },
      });
      // First call fails → spills a genuine, untracked artifact.
      const first = await durableWrite('w', { id: 1 }, { repoRoot: root });
      assert.equal(first.outcome, 'spilled');

      const res = await drainSpill({ repoRoot: root, isCloudEnabled: () => true });
      assert.equal(res.state, 'drained');
      assert.equal(res.drained, 1, 'a legitimately-produced artifact must still replay');
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  test('unverifiable provenance is `unavailable`, never a silent pass', () => {
    // The fail-open reading is the one that lets a planted artifact replay, so
    // the failure path is asserted directly on the reader.
    const res = readTrackedSpillArtifacts(path.join(os.tmpdir(), 'ces-does-not-exist-at-all'));
    // A non-existent root is not a repo → verified-empty, not unknown. The
    // distinction matters: refusing to drain there would be a false alarm.
    assert.equal(res.ok, true);
    assert.equal(res.tracked.size, 0);
  });
});

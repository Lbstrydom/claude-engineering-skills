/**
 * @fileoverview Friction-feedback + upstream-issue registry commands
 * (docs/plans/cross-skill-command-registry.md — Cluster D, Phase 5).
 *
 * Both are sub-verb dispatchers whose implementations live in
 * `lib/friction/commands.mjs` and `lib/upstream/commands.mjs` — the
 * thin-dispatcher discipline this whole plan generalises. The handlers here
 * do argv shaping and nothing else.
 */
import { CommandError } from '../dispatch.mjs';

/**
 * Which database the upstream rows this run touches actually live in, as a
 * one-way `storeFingerprint`.
 *
 * A FINGERPRINT and not the identity: the ledger this stamps is committed to a
 * PUBLIC repo, and one consumer's store is a corporate internal hostname that
 * was not previously tracked here. Equality is the only operation the
 * reconciler performs, so a digest is both sufficient and the only
 * disclosure-safe form.
 *
 * The committed disposition ledger lives in ONE repo while the reports it
 * closes are filed by consumers into whatever store each consumer's
 * `AUDIT_DB_URL` names — and those differ. Stamping the entry is what lets
 * `computeLedgerReconciliation` tell "this entry is stale" from "this entry
 * belongs to a store I am not connected to", which were one bucket, and one
 * push failure, until 2026-08-29.
 *
 * **Reads `process.env` directly, not `config.mjs`.** `dbConfig` documents
 * itself as "documentation + convenience" and names `db/client.mjs`'s
 * pool-init re-read of `process.env` as the resolver of record — so the stamp
 * must come from the same place the connection does, or it can describe a
 * database this run never talked to. The first cut of this helper imported a
 * `config.db` that does not exist (the export is `dbConfig`) and its own
 * try/catch swallowed the TypeError, so every entry silently went unstamped
 * and the partition never fired. Caught only by running the gate for real.
 *
 * `null` (cloud off, or an unparseable DSN) is a legitimate answer and is
 * written as ABSENCE, never as a guess: an invented store value would make the
 * entry foreign to every run and so permanently unreconcilable.
 *
 * @returns {Promise<string|null>}
 */
async function currentStoreFingerprint() {
  const dsn = process.env.AUDIT_DB_URL;
  if (!dsn) return null;
  try {
    const { storeFingerprint } = await import('../../db/client.mjs');
    return storeFingerprint(dsn);
  } catch (err) {
    // Loud, because silence here un-stamps every future entry and the symptom
    // (a foreign entry failing the push) surfaces nowhere near the cause.
    process.stderr.write(`  [upstream] could not derive the store identity — entries will be written UNSTAMPED: ${err.message}\n`);
    return null;
  }
}

export async function qualityCmd(ctx) {
  const sub = ctx.verb;
  if (!sub) {
    throw new CommandError('BAD_INPUT', 'usage: quality <add|mirror|digest|link|session-review> [flags]');
  }
  const m = await import('../../friction/commands.mjs');
  // A malformed `--json` is REFUSED, not silently read as an omitted payload
  // (audit CD2-r1, raised twice). `ctx.payload()` returns `{}` when no payload
  // flag is present and only THROWS on unparseable JSON — so the legacy
  // `catch { payload = {} }` existed solely to swallow malformed input, on
  // MUTATING verbs, making "you typed broken JSON" indistinguishable from "you
  // typed no JSON" and writing a friction row from the flags alone.
  //
  // Not the same call as the softFail set deferred to §2b: this is a REFUSAL
  // of invalid input on an unpinned path (no golden covers malformed JSON),
  // which is strictly safer than the shape it replaces, rather than a change
  // to an envelope a consumer reads.
  let payload = {};
  try {
    payload = ctx.payload();
  } catch (err) {
    throw new CommandError('BAD_INPUT',
      `--json payload is not valid JSON (${err.message}) — refusing rather than proceeding as though none was supplied`);
  }

  const num = (flag, fromPayload) => fromPayload ?? (ctx.flag(flag) ? Number(ctx.flag(flag)) : undefined);
  let result;
  switch (sub) {
    case 'add':
      result = await m.frictionAdd({
        title: payload.title ?? ctx.flag('title'),
        scopeTags: payload.scopeTags ?? [...ctx.flagList('scope-tags'), ...ctx.flagAll('scope-tag')],
        cost: payload.cost ?? ctx.flag('cost') ?? undefined,
        name: payload.name ?? ctx.flag('name') ?? undefined,
        files: payload.files ?? [...ctx.flagList('files'), ...ctx.flagAll('file')],
        symbols: payload.symbols ?? [...ctx.flagList('symbols'), ...ctx.flagAll('symbol')],
        body: payload.body ?? ctx.flag('body') ?? undefined,
      });
      break;
    case 'mirror':
      result = await m.frictionMirror({});
      break;
    case 'digest':
      result = await m.frictionDigest({
        repoScoped: ctx.hasFlag('repo-scoped') || payload.repoScoped === true,
        windowDays: num('window-days', payload.windowDays),
        minSimilarity: num('min-similarity', payload.minSimilarity),
      });
      break;
    case 'link':
      result = await m.frictionLink({
        memory: payload.memory ?? ctx.flag('memory'),
        kind: payload.kind ?? ctx.flag('kind'),
        ref: payload.ref ?? ctx.flag('ref'),
      });
      break;
    case 'session-review':
      result = await m.frictionSessionReview({ windowHours: num('window-hours', payload.windowHours) });
      break;
    default:
      throw new CommandError('BAD_INPUT', `unknown quality subcommand: ${sub}`);
  }
  if (result && result.ok === false) {
    throw new CommandError(result.code || 'BAD_INPUT',
      Array.isArray(result.errors) ? result.errors.join('; ') : (result.error || 'quality command failed'),
      result);
  }
  return result;
}

/**
 * `upstream <report|list|ack|fix|wont-fix|drain>`.
 *
 * `repoRoot` is `findRepoRootFromCwd()`, NOT `process.cwd()`. Every provenance
 * fact on a report hangs off it — the sync manifest, the write-ahead envelope
 * directory, the repo identity — so running from a subdirectory stamps
 * `bundle_sha: null` + `path_recognised: null`, indistinguishable from a
 * consumer that genuinely has no manifest. Verified 2026-08-11 against a
 * consumer repo: from its root the same report resolves `path_recognised:
 * true`; from `src/` all three go null, and that is how one bad report was filed.
 */
export async function upstreamCmd(ctx) {
  const sub = ctx.verb;
  const VERBS = ['report', 'list', 'ack', 'fix', 'wont-fix', 'annotate', 'history', 'drain', 'reconcile'];
  if (!sub || !VERBS.includes(sub)) {
    throw new CommandError('BAD_INPUT', `usage: upstream <${VERBS.join('|')}> [flags]`);
  }

  const m = await import('../../upstream/commands.mjs');
  const { findRepoRootFromCwd } = await import('../../assert-repo-root.mjs');
  const { resolveRepoIdentity } = await import('../../repo-identity.mjs');
  const repoRoot = findRepoRootFromCwd();
  const cloud = ctx.cloud.enabled;

  const scopedRepoId = async () => {
    const scope = await ctx.resolveScope();
    return scope.kind === 'scoped' ? scope.repoId : null;
  };

  // Best-effort drain on EVERY verb, gated on the directory existing so a run
  // with nothing pending costs one stat. Triggering only on report/list would
  // mean the outbox never drains on a consumer — `list` is a source-side
  // command consumers never run, and `report` is by definition rare.
  // TWO outboxes, and both must drain here. Reports and annotations are queued
  // separately (one payload shape per directory, see `ANNOTATION_OUTBOX_DIR`),
  // so a drain that walked only the report directory would leave every queued
  // correction on disk forever — a write-ahead queue nothing drains is just a
  // slower way of losing the note.
  const drainIfPending = async () => {
    if (!cloud) return { drained: 0, rejected: 0, failed: 0, skipped: 'cloud-off' };
    const merge = (a, b) => ({
      drained: (a.drained ?? 0) + (b.drained ?? 0),
      rejected: (a.rejected ?? 0) + (b.rejected ?? 0),
      failed: (a.failed ?? 0) + (b.failed ?? 0),
      reports: a,
      annotations: b,
      // A state either side reports as unusable must survive the merge — an
      // unreadable annotation outbox must not be averaged away by a healthy
      // report one, which is the "unasked question rendering as a clean result"
      // shape this repo keeps closing.
      ...(a.state === 'unavailable' || b.state === 'unavailable'
        ? { state: 'unavailable', reason: a.reason ?? b.reason }
        : {}),
      ...(a.error || b.error ? { error: a.error ?? b.error } : {}),
    });
    try {
      const reports = await m.drainOutbox({
        repoRoot,
        recordFn: async (p) => ctx.deps.recordUpstreamIssue({ ...p, repoId: p.repoId ?? await scopedRepoId() }),
      });
      const annotations = await m.drainAnnotationOutbox({
        repoRoot,
        annotateFn: (a) => ctx.deps.recordUpstreamIssueAnnotation(a),
      });
      // final-review-credit-queue fp 9dcb036a — quarantined envelopes are
      // never deleted and never retried (by design: they are evidence), but
      // nothing else reports how many have piled up. Printed here, on the
      // shared piggyback path every verb runs, so an accumulating pile is
      // visible wherever the operator next touches `upstream`, not only on an
      // explicit `drain`; silent when there is nothing to report.
      const rejected = m.rejectedCounts(repoRoot);
      const rejectedTotal = rejected.reports + rejected.annotations;
      if (rejectedTotal > 0) {
        process.stderr.write(
          `  [upstream] ${rejectedTotal} envelope(s) sitting in rejected/ (never retried automatically: `
          + `${rejected.reports} report(s), ${rejected.annotations} annotation(s)) — `
          + 'inspect .audit/upstream-outbox/rejected/ and .audit/upstream-annotation-outbox/rejected/.\n',
        );
      }
      return { ...merge(reports, annotations), rejectedPending: rejected };
    } catch (err) {
      // Returned rather than swallowed: an explicit `upstream drain` must never
      // report a success shape when the drain actually failed. On the
      // piggybacked path it stays non-fatal, but it is always REPORTED.
      process.stderr.write(`  [upstream] outbox drain failed: ${err.message}\n`);
      return { drained: 0, rejected: 0, failed: 0, error: err.message };
    }
  };

  try {
    if (sub === 'drain') {
      const r = await drainIfPending();
      if (r.error) throw new CommandError('DRAIN_FAILED', r.error, { cloud, ...r });
      // `state: 'unavailable'` is the drain saying it could not LOOK — an
      // unreadable outbox directory, an unrecoverable claim, an unreachable
      // sink. It carries no `error`, so it used to return `{ok:true,
      // drained:0}`: a caller checking `$?`, and an operator reading the line,
      // both see "nothing pending" over a queue that is still full. That is the
      // unasked-question-rendering-as-a-clean-result shape, and it now matters
      // more, because a queued ANNOTATION is an operator's correction that
      // exists nowhere else.
      if (r.state === 'unavailable') {
        throw new CommandError('DRAIN_UNAVAILABLE',
          `the outbox could not be read, so nothing was drained and nothing was proven empty: ${r.reason ?? 'no reason given'}`,
          { cloud, ...r });
      }
      return { ok: true, cloud, ...r };
    }

    const drain = await drainIfPending();

    if (sub === 'report') {
      const body = ctx.flag('body') ?? await readStdin();
      const res = await m.upstreamReport({
        repoRoot,
        repoUuid: resolveRepoIdentity(repoRoot).repoUuid,
        repoId: cloud ? await scopedRepoId() : null,
        title: ctx.flag('title'),
        body,
        severity: (ctx.flag('severity') || 'MEDIUM').toUpperCase(),
        affectedPath: ctx.flag('affected-path'),
        actor: ctx.flag('actor') || null,
        cloudEnabled: cloud,
        recordFn: (p) => ctx.deps.recordUpstreamIssue(p),
      });
      if (!res.ok) throw new CommandError(res.code || 'BAD_INPUT', res.errors.join('; '), { errors: res.errors });
      // Same reason the reconcile --gate notices below go to stderr: a caveat
      // that only appears as a null inside the JSON envelope is not a signal
      // an operator reads.
      for (const w of res.warnings || []) process.stderr.write(`  [upstream] ${w}
`);
      return { ...res, drain };
    }

    if (sub === 'reconcile') {
      // Named so `--apply` can RE-run it after writing and render the post-write
      // state — the operator reads what they now have, not what they had.
      // ONE resolution per invocation, shared by the reconcile and by `--apply`. Asking
      // the oracle twice in one command is how two spellings of one answer appear, and
      // the answer must be identical: `--apply` stamps entries with the store whose rows
      // this very reconcile classified as missing.
      const storeFp = await currentStoreFingerprint();
      const listAndReconcile = async () => m.upstreamReconcile({
        repoRoot,
        listTerminalFn: () => ctx.deps.listTerminalUpstreamIssues(),
        currentStore: storeFp,
      });
      let res = await listAndReconcile();
      // Round-3 audit M5: `res.reconciliation` is null in TWO distinct cases —
      // cloud genuinely off (benign, expected) and a real DB failure
      // (res.ok === false, res.error set). Collapsing both into the same
      // "nothing to reconcile against" message hid an actual failure behind
      // wording that reads as a normal, healthy no-op.
      if (!res.reconciliation && res.ok === false) {
        throw new CommandError('RECONCILE_FAILED', res.error || 'listTerminalUpstreamIssues failed', res);
      }
      // WHAT --gate BLOCKS ON, and why only that (docs/plans/upstream-disposition-landing.md).
      //
      // It still reconciles EVERY direction (round-3 H5 / round-4 H3): a terminal
      // row with no ledger entry, an entry with no terminal row, a state or
      // disposition-value disagreement, a row still carrying the catch-all sentinel.
      // What changed on 2026-10-10 is which of those BLOCK. Until then, any
      // divergence failed every push. So one `upstream fix` in one checkout, whose
      // entry sat uncommitted there, failed every push from every session until
      // somebody hand-landed that file (#180, #183, twice in one day).
      //
      // THE LEVEL FOLLOWS THE KIND OF STATE READ. The pushed commit's ledger is
      // repo state, so a divergence on an id whose entry THIS RANGE changed blocks.
      // A store row someone else moved is shared live state that no unrelated
      // commit can fix, so it is REPORTED on stderr, on every run, pass or fail,
      // with its cause and remedy. It is never silent and never blocking.
      // Attribution needs both ledgers readable. When it cannot be had (an
      // unresolvable range base, an unreadable or malformed ledger), the gate fails
      // CLOSED and blocks everything, exactly as before, saying why. The decision is
      // `decideReconcileGate` (pure), and its tests are
      // tests/upstream-reconcile-gate-attribution.test.mjs.
      if (ctx.hasFlag('gate')) {
        if (res.reconciliation) {
          const r = res.reconciliation;
          // `r.otherStore` is DELIBERATELY not divergence, and must stay that
          // way. Those entries close reports living in a database this run is not
          // connected to, so it has no evidence about them either way. Failing on
          // them is asserting staleness from absence, which is what made five real
          // closures unrecordable on 2026-08-29. It is still reported (stderr
          // below, and in the --worksheet render), so "not checked" never
          // masquerades as "checked and clean".
          if (r.otherStore?.length) {
            process.stderr.write(`  [upstream reconcile --gate] ${r.otherStore.length} ledger entr(y/ies) belong to another store and were NOT checked: ${r.otherStore.join(', ')}\n`);
          }
          const gate = await import('../../upstream/reconcile-gate.mjs');
          const decision = gate.decideReconcileGate({
            reconciliation: r, head: res.ledger, base: gate.readRangeBaseLedger({ repoRoot }),
          });
          // Pre-existing divergence FIRST, so it reaches the operator whether or
          // not the throw below fires.
          const rendered = gate.renderPreExistingLines(decision, {
            rows: res.rows ?? [], presentUpstream: res.missingCause?.presentUpstream ?? [],
          });
          for (const line of rendered) process.stderr.write(`${line}\n`);
          if (decision.blocking.length > 0) {
            // The cause IS the error message, not a render the throw would skip.
            throw new CommandError('RECONCILE_NEEDS_REVIEW',
              gate.renderBlockingMessage(decision, { rows: res.rows ?? [] }), { ...r, gate: decision });
          }
        } else {
          // Round-6 audit H6 compromise: cloud-off must never LOOK like a
          // clean reconciliation just because --gate found nothing to
          // object to — sandbox-honesty (AGENTS.md): a gate that can exit 0
          // having checked nothing must say so audibly, every time, not
          // only when the caller happens to also pass --worksheet.
          process.stderr.write('  [upstream reconcile --gate] cloud is off — nothing was actually checked; this is NOT a verified-clean result.\n');
        }
      }
      // `--apply` repairs the gap `reconcile` could only report. It runs BEFORE
      // rendering, and the report that follows describes the POST-write ledger
      // — the operator should read the state they now have, not the one they
      // had. Exit is non-zero if any divergence REMAINS: a refused row, or a
      // category `--apply` does not touch. Foreign-store entries are excluded
      // deliberately (they are scope, not divergence, and this repo's ledger
      // permanently carries 20 — counting them would make the gate
      // unsatisfiable).
      let applyResult = null;
      if (ctx.hasFlag('apply') && res.reconciliation?.missingFromLedger?.length) {
        const { probeIds } = await import('../../doctor/registry.mjs');
        const { readTrackedTestFiles } = await import('../../../check-upstream-probe-coverage.mjs');
        applyResult = await m.applyMissingDispositions({
          repoRoot,
          dbRows: res.rows ?? [],
          missingIds: res.reconciliation.missingFromLedger,
          missingCause: res.missingCause,
          allowExempt: ctx.hasFlag('allow-exempt'),
          probeIdsFn: probeIds,
          trackedTestFilesFn: () => readTrackedTestFiles().files,
          // The same value the reconcile above was classified with — see `storeFp`.
          storeFingerprint: storeFp,
        });
        if (applyResult.aborted) {
          process.stderr.write(`  [upstream reconcile --apply] REFUSED: ${applyResult.aborted}\n`);
        }
        for (const r of applyResult.refused) {
          process.stderr.write(`  [upstream reconcile --apply] refused ${r.issueId} at gate "${r.gate}": ${r.reason}\n`);
        }
        if (applyResult.applied.length) {
          process.stderr.write(`  [upstream reconcile --apply] wrote ${applyResult.applied.length} ledger entr(y/ies)\n`);
        }
        // Re-reconcile so what is rendered below is the POST-write state.
        if (applyResult.wrote) {
          res = await listAndReconcile();
        }
      }

      if (ctx.hasFlag('worksheet')) {
        if (!res.reconciliation) {
          process.stdout.write('cloud off — nothing to reconcile against\n');
        } else {
          // `missingCause` is a SIBLING of `reconciliation` on the result, not
          // a member of it — passing the reconciliation alone would silently
          // drop the cause attribution and fall back to the un-attributed
          // heading, which is the defect this change exists to remove.
          process.stdout.write(`${m.renderReconciliationReport({ ...res.reconciliation, missingCause: res.missingCause })}\n`);
        }
        return undefined;
      }
      return { ...res, drain };
    }

    if (sub === 'list') {
      const state = ctx.flag('state') || 'open';
      const beforeFlag = ctx.flag('before');
      // Round-4 audit M13: a malformed base64url or invalid JSON in --before
      // used to escape as an unhandled exception (a stack trace) rather than
      // the CLI's own standard input-validation error shape.
      let before = null;
      if (beforeFlag) {
        try {
          before = JSON.parse(Buffer.from(beforeFlag, 'base64url').toString('utf-8'));
        } catch (err) {
          throw new CommandError('BAD_INPUT', `--before is not a valid cursor: ${err.message}`);
        }
      }
      const res = await m.upstreamList({
        repoRoot, state, before,
        limit: ctx.flag('limit') ? Number(ctx.flag('limit')) : undefined,
        repoId: ctx.flag('repo-id') || null,
        listFn: (o) => ctx.deps.listUpstreamIssues(o),
        priorFixesFn: (p, id) => ctx.deps.findPriorFixes(p, id),
      });
      // Round-3 audit M17's companion: a malformed --before now returns
      // ok:false (partial cursor) rather than silently resetting to page 1 —
      // this must actually surface as a failure, not a quietly-empty list.
      if (res.ok === false) {
        throw new CommandError('LIST_FAILED', res.error || 'listUpstreamIssues failed', res);
      }
      if (ctx.hasFlag('worksheet')) {
        process.stdout.write(`${m.renderWorksheet(res.items || [], { state })}\n`);
        return undefined;
      }
      // The cursor is opaque + base64url so an operator can paste it back
      // without shell-quoting a JSON object.
      const nextCursor = res.nextCursor
        ? Buffer.from(JSON.stringify(res.nextCursor), 'utf-8').toString('base64url')
        : null;
      return { ...res, nextCursor, drain };
    }

    if (sub === 'history') {
      const res = await m.upstreamHistory({
        id: ctx.flag('id'),
        historyFn: (i) => ctx.deps.getUpstreamIssueHistory(i),
      });
      if (res.ok === false) {
        const code = res.code || (res.notFound ? 'NOT_FOUND' : res.ambiguous ? 'AMBIGUOUS_ID' : 'HISTORY_FAILED');
        throw new CommandError(code, res.errors ? res.errors.join('; ') : res.error, res);
      }
      if (ctx.hasFlag('worksheet')) {
        // `cloud:false` is an UNASKED question, never an empty history — the
        // same distinction `upstream-queues.mjs` exists to preserve.
        process.stdout.write(res.cloud === false
          ? 'cloud off — the event log was NOT read; this is not an empty history\n'
          : `${m.renderIssueHistory(res)}\n`);
        return undefined;
      }
      return { ...res, drain };
    }

    if (sub === 'annotate') {
      const res = await m.upstreamAnnotate({
        // `repoRoot` + `cloudEnabled` are what let this write AHEAD to disk
        // instead of discarding the note when the store is off — the same
        // contract `upstream report` has had since it shipped.
        repoRoot,
        cloudEnabled: cloud,
        id: ctx.flag('id'),
        note: await m.resolveNoteInput({ flag: ctx.flag('note'), readStdin, required: true }),
        actor: ctx.flag('actor') || null,
        annotateFn: (a) => ctx.deps.recordUpstreamIssueAnnotation(a),
      });
      if (!res.ok) {
        const code = res.code || (res.notFound ? 'NOT_FOUND'
          : res.ambiguous ? 'AMBIGUOUS_ID' : 'EXCEPTION');
        throw new CommandError(code, res.errors ? res.errors.join('; ') : res.error, res);
      }
      return { ...res, drain };
    }

    // ack | fix | wont-fix
    const to = sub === 'ack' ? 'acknowledged' : sub === 'fix' ? 'fixed' : 'wont_fix';
    const res = await m.upstreamTransition({
      repoRoot, to,
      id: ctx.flag('id'),
      note: await m.resolveNoteInput({ flag: ctx.flag('note'), readStdin }),
      commit: ctx.flag('commit'),
      actor: ctx.flag('actor') || null,
      // Required for fix/wont-fix (consumer-friction-doctor plan §2.4) —
      // `upstreamTransition` itself does the validation; this is the CLI
      // dispatch layer that must parse and forward the flag, traced
      // separately because requiring it at the service layer alone does
      // nothing unless something upstream of it actually reads argv.
      disposition: ctx.flag('disposition'),
      // Stamped at WRITE time, from the store this very command is about to
      // transition — not looked up later, when the ambient DSN may be a
      // different one entirely.
      storeFingerprint: await currentStoreFingerprint(),
      transitionFn: (a) => ctx.deps.transitionUpstreamIssue(a),
    });
    for (const line of renderDispositionFileNotice(res.dispositionFile, ctx.flag('id'))) {
      process.stderr.write(`${line}\n`);
    }
    if (!res.ok) {
      const code = res.code || (res.illegal ? 'ILLEGAL_TRANSITION'
        : res.notFound ? 'NOT_FOUND' : res.ambiguous ? 'AMBIGUOUS_ID'
          : res.conflict ? 'CONFLICT' : 'EXCEPTION');
      throw new CommandError(code, res.errors ? res.errors.join('; ') : res.error, res);
    }
    return { ...res, drain };
  } catch (err) {
    if (err instanceof CommandError) throw err;
    // A ledger the writer refused to overwrite is a named, operator-fixable state,
    // not a crash, so its code survives (disposition-ledger.mjs readDispositionLedger).
    throw new CommandError(err?.code === 'LEDGER_MALFORMED' ? 'LEDGER_MALFORMED' : 'EXCEPTION', err.message);
  }
}

/**
 * The operator notice for the disposition entry `upstream fix|wont-fix` just
 * wrote (docs/plans/upstream-disposition-landing.md §2.3). It is keyed on BOTH
 * outcomes (plan-audit R1 H1):
 *
 * - store transitioned, entry not yet on the base branch: the entry is an
 *   uncommitted change to a COMMITTED file. Say what it causes until it lands,
 *   and exactly how to land it.
 * - store transition FAILED (returned or thrown): the ledger was written ahead of
 *   it, so the entry must NOT be committed (the gate would block that push as
 *   ledger-ahead-of-store). Never print commit instructions here, and never assume
 *   the failure was transient: terminal states are final, so a re-run of an
 *   illegal transition fails again.
 * - landed already, or nothing written: silent.
 *
 * PURE, returns lines; the caller writes them. PowerShell-safe: real values, no
 * angle-bracket placeholders. It never commits or pushes, because this CLI runs
 * in shared working trees.
 *
 * @param {{path: string, written: boolean, landed: boolean|null, base: string, reason: string|null,
 *   storeTransitioned: boolean}|null|undefined} file
 * @param {string|null} idFlag the `--id` as typed, for the commit message
 * @returns {string[]}
 */
export function renderDispositionFileNotice(file, idFlag) {
  if (!file?.written) return [];
  const tag = '  [upstream]';
  if (file.storeTransitioned !== true) {
    return [
      `${tag} ${file.path} was written AHEAD of a store transition that did not succeed (error above). Do NOT commit that change:`,
      `${tag} the store row did not reach this state, so the reconcile gate would block the push that carries it.`,
      `${tag} If the failure was transient (store unreachable), re-run the same command; the entry is rewritten in place.`,
      `${tag} Otherwise (e.g. an illegal transition: fixed and wont_fix are final), remove just that entry from the file.`,
    ];
  }
  if (file.landed === true) return [];
  const short = String(idFlag ?? '').trim().slice(0, 8) || 'issue';
  return [
    `${tag} ${file.path} now carries this closure's disposition, UNCOMMITTED in this checkout.`,
    `${tag} ${file.landed === null ? `Landing on ${file.base} could not be checked (${file.reason}).` : `It is not on ${file.base} yet.`}`
      + ' Until it lands, `upstream:reconcile:gate` reports this issue on every push in the repo,',
    `${tag} and branches still on the pre-attribution gate FAIL their push on it until rebased. Land it now, from this checkout:`,
    `${tag}   git add -- ${file.path}`,
    `${tag}   git commit -m "chore(upstream): record ${short} disposition"`,
    `${tag}   then push it on its own branch and open a PR (or fold it into the PR that carries the fix).`,
  ];
}

/** Read a multiline report body from stdin — prose must never be an argv string. */
async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf-8');
}

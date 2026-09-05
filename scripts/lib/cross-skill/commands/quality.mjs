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
      return merge(reports, annotations);
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
      return { ...res, drain };
    }

    if (sub === 'reconcile') {
      const res = await m.upstreamReconcile({
        repoRoot,
        listTerminalFn: () => ctx.deps.listTerminalUpstreamIssues(),
        currentStore: await currentStoreFingerprint(),
      });
      // Round-3 audit M5: `res.reconciliation` is null in TWO distinct cases —
      // cloud genuinely off (benign, expected) and a real DB failure
      // (res.ok === false, res.error set). Collapsing both into the same
      // "nothing to reconcile against" message hid an actual failure behind
      // wording that reads as a normal, healthy no-op.
      if (!res.reconciliation && res.ok === false) {
        throw new CommandError('RECONCILE_FAILED', res.error || 'listTerminalUpstreamIssues failed', res);
      }
      // Round-3 audit H5 compromise (widened round-4, audit H3): --gate must
      // block on EVERY divergence direction the reconciler can report, not
      // just the migration catch-all sentinel — a terminal DB row missing
      // from the ledger (the original crash-window gap), a ledger entry
      // whose issue is absent or no longer terminal in the DB, a state
      // disagreement, or a disposition VALUE disagreement are all evidence
      // the backfill/CLI write path silently missed or diverged from what
      // was intended (round-4 H3: "a raw migration does not itself prove
      // every intended row was updated" — this is the blocking check that
      // proves it after the fact).
      if (ctx.hasFlag('gate')) {
        if (res.reconciliation) {
          const r = res.reconciliation;
          const problems = [];
          if (r.missingFromLedger.length) problems.push(`${r.missingFromLedger.length} terminal db row(s) with no ledger entry: ${r.missingFromLedger.join(', ')}`);
          if (r.ledgerOnly.length) problems.push(`${r.ledgerOnly.length} ledger entr(y/ies) with no matching terminal db row: ${r.ledgerOnly.join(', ')}`);
          if (r.stateMismatch.length) problems.push(`${r.stateMismatch.length} state mismatch(es): ${r.stateMismatch.join('; ')}`);
          if (r.dispositionMismatch.length) problems.push(`${r.dispositionMismatch.length} disposition mismatch(es): ${r.dispositionMismatch.join('; ')}`);
          if (r.needsReview.length) problems.push(`${r.needsReview.length} row(s) still carry the migration catch-all sentinel: ${r.needsReview.join(', ')}`);
          // `r.otherStore` is DELIBERATELY absent from `problems`, and must
          // stay absent. Those entries close reports living in a database this
          // run is not connected to, so it has no evidence about them either
          // way — failing on them is asserting staleness from absence, and it
          // is what made five real closures unrecordable on 2026-08-29. It is
          // still reported (stderr below, and in the --worksheet render), so
          // "not checked" never masquerades as "checked and clean".
          if (r.otherStore?.length) {
            process.stderr.write(`  [upstream reconcile --gate] ${r.otherStore.length} ledger entr(y/ies) belong to another store and were NOT checked: ${r.otherStore.join(', ')}\n`);
          }
          if (problems.length > 0) {
            throw new CommandError('RECONCILE_NEEDS_REVIEW', problems.join(' | '), r);
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
    if (!res.ok) {
      const code = res.code || (res.illegal ? 'ILLEGAL_TRANSITION'
        : res.notFound ? 'NOT_FOUND' : res.ambiguous ? 'AMBIGUOUS_ID'
          : res.conflict ? 'CONFLICT' : 'EXCEPTION');
      throw new CommandError(code, res.errors ? res.errors.join('; ') : res.error, res);
    }
    return { ...res, drain };
  } catch (err) {
    if (err instanceof CommandError) throw err;
    throw new CommandError('EXCEPTION', err.message);
  }
}

/** Read a multiline report body from stdin — prose must never be an argv string. */
async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf-8');
}

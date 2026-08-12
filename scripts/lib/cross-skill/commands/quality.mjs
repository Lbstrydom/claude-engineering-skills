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
 * `quality <add|mirror|digest|link|session-review>`.
 *
 * Every verb returns the C8 shape; `ok:false` is an argv/contract error and
 * exits 2 — expressed here by throwing rather than by returning a
 * failure-shaped envelope.
 */
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
  const VERBS = ['report', 'list', 'ack', 'fix', 'wont-fix', 'drain'];
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
  const drainIfPending = async () => {
    if (!cloud) return { drained: 0, rejected: 0, failed: 0, skipped: 'cloud-off' };
    try {
      return await m.drainOutbox({
        repoRoot,
        recordFn: async (p) => ctx.deps.recordUpstreamIssue({ ...p, repoId: p.repoId ?? await scopedRepoId() }),
      });
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

    if (sub === 'list') {
      const state = ctx.flag('state') || 'open';
      const beforeFlag = ctx.flag('before');
      const before = beforeFlag
        ? JSON.parse(Buffer.from(beforeFlag, 'base64url').toString('utf-8'))
        : null;
      const res = await m.upstreamList({
        repoRoot, state, before,
        limit: ctx.flag('limit') ? Number(ctx.flag('limit')) : undefined,
        repoId: ctx.flag('repo-id') || null,
        listFn: (o) => ctx.deps.listUpstreamIssues(o),
        priorFixesFn: (p, id) => ctx.deps.findPriorFixes(p, id),
      });
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

    // ack | fix | wont-fix
    const to = sub === 'ack' ? 'acknowledged' : sub === 'fix' ? 'fixed' : 'wont_fix';
    const res = await m.upstreamTransition({
      repoRoot, to,
      id: ctx.flag('id'),
      note: ctx.flag('note'),
      commit: ctx.flag('commit'),
      actor: ctx.flag('actor') || null,
      transitionFn: (a) => ctx.deps.transitionUpstreamIssue(a),
    });
    if (!res.ok) {
      const code = res.code || (res.illegal ? 'ILLEGAL_TRANSITION'
        : res.notFound ? 'NOT_FOUND' : res.ambiguous ? 'AMBIGUOUS_ID'
          : res.conflict ? 'CONFLICT' : 'EXCEPTION');
      throw new CommandError(code, res.errors ? res.errors.join('; ') : res.error, res);
    }
    return res;
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

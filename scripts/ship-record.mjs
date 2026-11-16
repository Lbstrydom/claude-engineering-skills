#!/usr/bin/env node
/**
 * @fileoverview Ship record catch-up — /ship's RECORD half without its push/merge authority
 * (docs/plans/ship-record-catchup.md).
 *
 * Fleet coordinators land PRs without /ship, so the session log, the Backlog line and the ship_event never happen. This
 * CLI records each merged-but-unrecorded PR exactly once, keyed on the entries themselves (no watermark file), and only
 * ever CREATES files under docs/status/entries/. It never commits, pushes or merges: committing is
 * `ship-commit.mjs --record` (docs-only, code-checked), merging stays the user's.
 *
 *   status  [--json] [--base <branch>] [--fetch]                         read-only; exit 0 always (a nudge)
 *   catchup [--write] [--json] [--base] [--max <n>] [--no-events] [--fetch]  dry run unless --write
 *   floor   [--write] [--json] [--base] [--fetch]                         the one summarised backfill entry
 *   init    [--json]                                                     adopt per-entry status files
 *
 * Exit: 0 ok · 1 error (incl. a lost event write) · 2 argv · 3 refused.
 *
 * @module scripts/ship-record
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ArgvError, assertKnownFlags, emit, finishAndExit } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { withFileLock, LockTimeoutError } from './lib/file-lock.mjs';
import { realRunners } from './lib/ship-record/facts.mjs';
import { cacheDirFor } from './lib/fleet/git-facts.mjs';
import { renderCommand } from './lib/fleet/shell-quote.mjs';
import { RecordRefusal, runStatus, runCatchup, runFloor, runInit } from './lib/ship-record/commands.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const VERBS = {
  status: ['--json', '--base', '--fetch'],
  catchup: ['--json', '--base', '--fetch', '--write', '--max', '--no-events'],
  floor: ['--json', '--base', '--fetch', '--write'],
  init: ['--json'],
};
const BACKLOG_TIMEOUT_MS = 120_000;
const EXIT_REFUSED = 3;

/** How this CLI is named in the commands it prints: by path, relative when inside the repo (sync rewrites docs, not output). */
function selfCommand(repoRoot) {
  const rel = path.relative(repoRoot, path.join(SCRIPT_DIR, 'ship-record.mjs')).split(path.sep).join('/');
  // Shell-quoted (C-R4-M1): an absolute path with a space must stay one argument.
  return renderCommand(['node', rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : path.join(SCRIPT_DIR, 'ship-record.mjs')]);
}

function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new ArgvError(`ship-record: ${flag} needs a value`);
  return v;
}

/** The Backlog line, from the sibling backlog-snapshot.mjs (never a blank: a failure renders unmeasured). */
function backlogLine(cwd) {
  const r = spawnSync(process.execPath, [path.join(SCRIPT_DIR, 'backlog-snapshot.mjs')], { cwd, encoding: 'utf8', timeout: BACKLOG_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const line = String(r.stdout ?? '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('Backlog'));
  // Only a SUCCESSFUL child's line counts (audit A-R1-M16): a plausible line from a failed run is not a measurement.
  if (r.error || r.status !== 0 || !line) return `Backlog: unmeasured (${r.error ? (r.error.code ?? r.error.message) : `backlog-snapshot exited ${r.status}${line ? '' : ' with no Backlog line'}`})`;
  return line;
}

/** The store side of event reconciliation, loaded only when a write runs (no store import on a read). */
async function eventsPort() {
  await import('./lib/load-env.mjs');
  const repo = await import('./lib/store/repo.mjs');
  const events = await import('./lib/store/ship-events.mjs');
  const { resolveCommandScope } = await import('./lib/cross-skill/scope.mjs');
  return {
    // The same ambient-ok resolver cross-skill's record-ship-event uses — no second resolver.
    resolveRepoId: async () => {
      const s = await resolveCommandScope('ambient-ok', {}, { resolveRepoForStoreResult: repo.resolveRepoForStoreResult, getRepoIdByUuid: repo.getRepoIdByUuid });
      if (s.kind === 'scoped') return { ok: true, repoId: s.repoId };
      if (s.kind === 'unresolved') return { ok: false, reason: s.reason };
      return { ok: false, fatal: true, reason: s.message ?? s.code };
    },
    find: events.findShipEvents,
    record: events.recordShipEvent,
  };
}

function render(env) {
  const c = env.counts ?? {};
  const lines = [`ship-record ${env.verb} — ${env.state ?? 'ok'}${env.base ? ` (${env.base.repo} ${env.base.branch} @ ${String(env.base.oid ?? '').slice(0, 12)})` : ''}`];
  if (env.reason) lines.push(`  reason: ${env.reason}`);
  if (c.merged !== undefined && env.verb !== 'floor' && env.verb !== 'init') {
    lines.push(c.unrecorded === null ? '  unrecorded: UNMEASURED' : `  merged since floor: ${c.merged} · recorded ${c.recorded} · unrecorded ${c.unrecorded} · unknown ${c.unknown}`);
  }
  for (const p of env.unrecorded ?? []) lines.push(`    #${p.number} merged ${p.mergedAt} ${String(p.mergeCommit ?? '').slice(0, 12)}`);
  for (const w of env.wouldWrite ?? []) lines.push(`  would write: ${w}`);
  for (const w of env.wrote ?? []) lines.push(`  wrote: ${w}`);
  for (const s of env.suggestions ?? []) lines.push(`  paste into ${s.plan} ## Implementation Log: ${s.line}`);
  for (const s of env.skipped ?? []) lines.push(`  skipped #${s.number}: ${s.reason}`);
  for (const e of env.errors ?? []) lines.push(`  ERROR: ${e}`);
  if (env.events && env.verb === 'catchup') {
    const e = env.events;
    lines.push(`  events: written ${e.written} · existing ${e.existing} · lost ${e.lost} · skipped ${e.skipped}${e.backlog ? ` · ${e.backlog} not checked this run` : ''}${e.reason ? ` (${e.reason})` : ''}`);
  }
  for (const w of env.warnings ?? []) lines.push(`  warning: ${w}`);
  if (env.remedy) lines.push(`next: ${env.remedy}`);
  return lines.join('\n');
}

export async function main(argv = process.argv) {
  if (argv.includes('--selfcheck-relocation')) { process.stdout.write('OK\n'); return finishAndExit(0); }
  const verb = argv[2];
  // Flags are read from ONE slice (audit A-R1-H9): `catchup -- --write` must never enable a write. This CLI takes no
  // positionals, so a `--` terminator (or anything after it) is refused outright rather than half-honoured.
  const args = argv.slice(3);
  const json = args.includes('--json');
  try {
    if (!Object.hasOwn(VERBS, verb ?? '')) throw new ArgvError(`ship-record: unknown verb ${JSON.stringify(verb ?? '')}. Verbs: ${Object.keys(VERBS).join(', ')}`);
    if (args.includes('--')) throw new ArgvError(`ship-record ${verb}: takes no positional arguments, so "--" is refused`);
    const stray = args.find((a, i) => !a.startsWith('--') && !['--max', '--base'].includes(args[i - 1]));
    if (stray !== undefined) throw new ArgvError(`ship-record ${verb}: unexpected argument ${JSON.stringify(stray)}`);
    assertKnownFlags(argv, VERBS[verb], { cli: `ship-record ${verb}`, from: 3 });
    const maxRaw = flagValue(args, '--max');
    const max = maxRaw === null ? undefined : Number(maxRaw);
    if (max !== undefined && (!Number.isSafeInteger(max) || max < 1 || max > 500)) throw new ArgvError('ship-record: --max must be an integer 1–500');
    const opts = { base: flagValue(args, '--base'), fetch: args.includes('--fetch'), write: args.includes('--write'), max, events: !args.includes('--no-events') };

    const cwd = process.cwd();
    const runners = realRunners(cwd);
    const top = runners.git(['rev-parse', '--show-toplevel']);
    if (top.status !== 0) throw new RecordRefusal('ship-record: not inside a git repository');
    const repoRoot = path.resolve(String(top.stdout).trim());
    const ctx = {
      cwd, repoRoot, runners, now: () => new Date(), cmd: selfCommand(repoRoot),
      backlog: () => backlogLine(cwd),
      events: verb === 'catchup' && opts.write && opts.events ? await eventsPort() : null,
    };
    let env;
    if (verb === 'status') env = runStatus(ctx, opts);
    else if (verb === 'init') env = runInit(ctx);
    else {
      // Writers on one machine serialise; a second run refuses rather than waits (plan §2.2).
      // The git common dir via fleet's one resolver (shared by every worktree of the repo), never a second derivation.
      const common = cacheDirFor(cwd);
      if (!common) throw new RecordRefusal('ship-record: the git common dir could not be resolved, so writes cannot be serialised');
      const lockPath = path.join(common, 'ship-record.lock');
      if (!opts.write) env = verb === 'floor' ? runFloor(ctx, opts) : await runCatchup(ctx, opts);
      else {
        try {
          env = await withFileLock(lockPath, { maxWaitMs: 0 }, async () => (verb === 'floor' ? runFloor(ctx, opts) : runCatchup(ctx, opts)));
        } catch (e) {
          if (e instanceof LockTimeoutError) throw new RecordRefusal('another ship-record write is running on this machine (its lock is held); wait for it, then re-run');
          throw e;
        }
      }
    }
    if (json) emit(env); else { process.stdout.write(`${render(env)}\n`); if (env.ok === false) process.exitCode = 1; }
    return finishAndExit(env.ok === false ? 1 : 0);
  } catch (err) {
    // --json: every failure is an envelope too (C-R4-M2), with the same exit code the text mode uses.
    if (err instanceof ArgvError) { if (json) emit({ ok: false, verb: verb ?? null, argv: true, message: err.message }); process.stderr.write(`${err.message}\n`); process.exitCode = 2; return finishAndExit(2); }
    if (err instanceof RecordRefusal) {
      if (json) emit({ ok: false, verb, refused: true, message: err.message, ...err.details });
      else process.stderr.write(`${err.message}${err.details?.remedy ? `\nnext: ${err.details.remedy}` : ''}\n`);
      process.exitCode = EXIT_REFUSED;
      return finishAndExit(EXIT_REFUSED);
    }
    if (json) emit({ ok: false, verb: verb ?? null, error: true, message: String(err?.message ?? err) });
    process.stderr.write(`ship-record ${verb}: ${err?.stack || err}\n`);
    process.exitCode = 1;
    return finishAndExit(1);
  }
}

// --selfcheck-relocation stays the first statement of main(); the entry guard canonicalises both sides.
if (isInvokedAsScript(import.meta.url)) await main();

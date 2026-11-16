#!/usr/bin/env node
/**
 * @fileoverview Harness retro CLI — detect recurring session failures
 * mechanically, hand ranked candidates to a judge, record decisions, measure
 * whether an enforcement worked. Plan: docs/plans/harness-retro.md.
 *
 *   node scripts/harness-retro.mjs scan   [--since 14d] [--fleet] [--persist] [--top 10] [--json]
 *   node scripts/harness-retro.mjs record --scan <id|latest> [--file <proposals.json>]   (else JSON on stdin)
 *   node scripts/harness-retro.mjs enforce --identity <fingerprint:fp|tripwire:name> --scan <id|latest>
 *                                          --test <tests/x.test.mjs> --layer <hook|gate|script|reference-doc|agents-md>
 *                                          --summary <text> [--memory <name>] [--force-unscanned]
 *   node scripts/harness-retro.mjs reject  --identity <id> --scan <id|latest> --summary <text>
 *   node scripts/harness-retro.mjs effect  [--identity <id>] [--window-days 14] [--json]
 *   node scripts/harness-retro.mjs status  [--json]
 *
 * Transcripts are read from the account's config root (`CLAUDE_CONFIG_DIR`, else
 * `~/.claude`) and NEVER leave local disk. Only derived records are persisted,
 * and only with `--persist` and a cloud store. Propose, never apply: nothing
 * here edits the harness except `enforce`/`reject`, which a human runs in the
 * fix PR after approving a proposal.
 *
 * Exit codes: 0 ok (including an honest UNMEASURED scan) · 1 a failure (bad
 * proposals, a store write that did not land, an unmigrated store) · 2 usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertKnownFlags, ArgvError, argOption, hasFlag, emit, finishAndExit } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { claudeConfigDir } from './lib/harness-paths.mjs';
import { resolveHarnessMemoryDir } from './lib/memory-paths.mjs';
import { resolveRepoIdentity } from './lib/repo-identity.mjs';
import { runScan } from './lib/friction/retro/scan.mjs';
import { createRepoResolver } from './lib/friction/retro/repo-resolve.mjs';
import { collectHarnessDocs } from './lib/friction/retro/inventory.mjs';
import { analyseScan, renderScanReport, renderProposals } from './lib/friction/retro/report.mjs';
import { readRegistry, decisionIndex, validateRegistry, activationFor } from './lib/friction/retro/registry.mjs';
import {
  newScanId, writeScanArtifact, readScanArtifact, readAllScanArtifacts, pruneScanArtifacts,
  writeProposalsArtifact, writeHeartbeat, readHeartbeat, SCAN_SCHEMA_VERSION,
} from './lib/friction/retro/artifacts.mjs';
import { checkProposalsAgainstScan } from './lib/friction/retro/proposal-schema.mjs';
import { closeDecision } from './lib/friction/retro/closure.mjs';
import { retirementStatus } from './lib/friction/retro/memory-tripwires.mjs';
import { computeEffect, DEFAULT_WINDOW_DAYS } from './lib/friction/retro/effect.mjs';

const VERBS = ['scan', 'record', 'enforce', 'reject', 'effect', 'status'];
const KNOWN = [
  '--since', '--fleet', '--persist', '--top', '--json', '--scan', '--identity', '--test', '--layer',
  '--summary', '--memory', '--force-unscanned', '--window-days', '--file', '--help', '--selfcheck-relocation',
];
const HEARTBEAT_STALE_DAYS = 8;
const DAY_MS = 86_400_000;

const log = (m) => process.stderr.write(`[harness-retro] ${m}\n`);

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return r.status === 0 ? String(r.stdout).trim() : null;
}

/** The checkout's toplevel (registry + artifacts) and its MAIN root (memory dir). */
function resolveRoots(cwd = process.cwd()) {
  const top = git(['rev-parse', '--show-toplevel'], cwd);
  if (!top) throw new ArgvError('harness-retro must run inside a git checkout');
  // The MAIN worktree is the first entry of `git worktree list` — correct for a
  // linked worktree AND a --separate-git-dir checkout (audit B-R1-M2).
  const first = (git(['worktree', 'list', '--porcelain'], cwd) ?? '').split(/\r?\n/).find((l) => l.startsWith('worktree '));
  const main = first ? first.slice('worktree '.length).trim() : top;
  return { repoRoot: path.resolve(top), mainRoot: path.resolve(main) };
}

export function parseSince(v, now = Date.now()) {
  const m = String(v ?? '14d').match(/^(\d+)d$/);
  if (!m || Number(m[1]) < 1) throw new ArgvError(`--since must look like 14d (got ${v})`);
  return now - Number(m[1]) * DAY_MS;
}

const readStdin = () => fs.readFileSync(0, 'utf8');

/**
 * The ONE place a store payload is built from a scan artifact — derived fields
 * only, no label (the egress table). Exported so the boundary is tested directly.
 */
export function buildSessionSnapshot(artifact, s) {
  const occurrences = Object.entries(s.counts).map(([fp, n]) => ({
    fingerprint: fp, kind: artifact.fingerprints[fp].kind, tool: artifact.fingerprints[fp].tool,
    occurrences: n, first_at: s.spans[fp]?.firstAt ?? null, last_at: s.spans[fp]?.lastAt ?? null,
  }));
  return {
    session_key: s.sessionKey, repo_uuid: s.repoUuid, account_key: artifact.accountKey, origin: s.origin,
    started_at: s.startedAt, fingerprint_version: artifact.fingerprintVersion,
    signal_count: occurrences.reduce((a, o) => a + o.occurrences, 0), last_scan_id: artifact.scanId,
    observed_until: artifact.requested.until, occurrences,
  };
}

/** Persist one scan: a transactional snapshot per COMPLETE session, then the scan row. */
async function persistScan(artifact, { repoRoot }) {
  const { isCloudEnabled } = await import('./lib/store/repo.mjs');
  if (!(await isCloudEnabled())) return { persisted: false, persistReason: 'cloud-off' };
  if (!artifact.repoUuid) return { persisted: false, persistReason: 'no-repo-identity' };
  // Probe first: an unmigrated store fails loudly ONCE instead of spilling every session.
  const { query } = await import('./lib/db/query.mjs');
  const { describeSchemaFault } = await import('./lib/db/errors.mjs');
  try { await query('SELECT 1 FROM harness_retro_scans LIMIT 0'); } catch (err) {
    const why = describeSchemaFault(err, 'harness-retro persist');
    if (why) return { persisted: false, persistReason: 'store-not-migrated', failed: true, detail: `${why} — apply supabase/migrations/20261116120000_harness_retro.sql` };
    return { persisted: false, persistReason: 'store-unreachable', failed: true, detail: err.message };
  }
  await import('./lib/audit-store-writers.mjs');
  const { durableWrite } = await import('./lib/durable-write.mjs');
  const outcomes = { written: 0, spilled: 0, lost: 0, skipped: 0, notPersisted: 0 };
  for (const s of artifact.sessions) {
    if (!s.complete || !s.startedAt) { outcomes.notPersisted++; continue; }
    const r = await durableWrite('retro.sessionSnapshot', buildSessionSnapshot(artifact, s), { repoRoot });
    outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  }
  // EVERY outcome other than `written` means an eligible session did not land as
  // a fresh write; `skipped` and `notPersisted` count too (audit B-R1-H4/M5/H5).
  const notLanded = outcomes.spilled + outcomes.lost + outcomes.skipped + outcomes.notPersisted;
  const completed = artifact.completed && notLanded === 0;
  const scanRow = await durableWrite('retro.scanComplete', {
    scan_id: artifact.scanId, account_key: artifact.accountKey, repo_uuid: artifact.repoUuid,
    fingerprint_version: artifact.fingerprintVersion, requested_since: artifact.requested.since,
    requested_until: artifact.requested.until, files_listed: artifact.files.listed,
    files_read: artifact.files.read, read_errors: artifact.files.readErrors, completed,
  }, { repoRoot });
  const failed = outcomes.spilled + outcomes.lost + outcomes.skipped > 0 || scanRow.outcome !== 'written';
  return {
    persisted: !failed, persistReason: failed ? 'store-write-incomplete' : 'written',
    failed, outcomes, scanRowOutcome: scanRow.outcome, completed,
  };
}

async function cmdScan() {
  const now = Date.now();
  const sinceMs = parseSince(argOption('since', '14d'), now);
  const top = Number(argOption('top', '10'));
  if (!Number.isInteger(top) || top < 1) throw new ArgvError('--top must be a positive integer');
  const fleet = hasFlag('fleet');
  const persist = hasFlag('persist');
  if (fleet && persist) throw new ArgvError('--persist is repo-local; drop --fleet (other repos persist from their own checkout)');
  const { repoRoot, mainRoot } = resolveRoots();
  const configDir = claudeConfigDir();
  const self = resolveRepoIdentity(repoRoot);
  const thisRepoUuid = self.source === 'path-fallback' ? null : self.repoUuid;
  log(`scanning ${configDir} since ${new Date(sinceMs).toISOString()}${fleet ? ' (fleet)' : ''}…`);
  const scan = await runScan({ configDir, sinceMs, untilMs: now, resolver: createRepoResolver(), thisRepoUuid, fleet });

  const registry = readRegistry(repoRoot);
  const { dir: memoryDir, exists: memExists } = resolveHarnessMemoryDir({ repoRoot: mainRoot });
  const analysis = analyseScan(scan, {
    decisions: decisionIndex(registry), inventory: collectHarnessDocs({ repoRoot, memoryDir: memExists ? memoryDir : null }),
    memoryDir: memExists ? memoryDir : null, top,
  });
  const scanId = newScanId(new Date(now));
  const artifact = {
    schemaVersion: SCAN_SCHEMA_VERSION, scanId, createdAt: new Date(now).toISOString(),
    fingerprintVersion: scan.fingerprintVersion, accountKey: scan.accountKey, repoUuid: thisRepoUuid, fleet,
    requested: scan.requested, files: scan.files, completed: scan.completed, measured: scan.measured,
    ...(scan.reason ? { reason: scan.reason } : {}),
    transcriptVersions: scan.transcriptVersions, excluded: scan.excluded,
    sessions: scan.sessions, fingerprints: scan.fingerprints,
    candidates: analysis.candidates, tripwires: analysis.tripwires, summary: analysis.summary,
    persisted: false, persistReason: persist ? 'pending' : 'not-requested',
  };
  let persistResult = null;
  if (persist && scan.measured) {
    persistResult = await persistScan(artifact, { repoRoot });
    artifact.persisted = persistResult.persisted;
    artifact.persistReason = persistResult.persistReason;
  } else if (persist) {
    artifact.persistReason = 'unmeasured-scan';
  }
  const file = writeScanArtifact(repoRoot, artifact);
  const pruned = pruneScanArtifacts(repoRoot, { now });
  writeHeartbeat(repoRoot, { lastRunAt: artifact.createdAt, scanId, measured: scan.measured, persisted: artifact.persisted });
  const failed = persistResult?.failed === true;
  const envelope = {
    ok: !failed, measured: scan.measured, ...(scan.reason ? { reason: scan.reason } : {}),
    scanId, artifact: path.relative(repoRoot, file), files: scan.files, excluded: scan.excluded,
    summary: analysis.summary, persisted: artifact.persisted, persistReason: artifact.persistReason,
    ...(persistResult ? { persist: persistResult } : {}), pruned,
    candidates: analysis.candidates.map(({ identity, kind, tool, sessions, occurrences, repos, rank, label, coveredBy }) => ({ identity, kind, tool, sessions, occurrences, repos, rank, label, coveredBy })),
    promotionCandidates: analysis.tripwires.filter((t) => t.status === 'promotion-candidate'),
  };
  if (hasFlag('json')) emit(envelope);
  else {
    process.stdout.write(renderScanReport({ ...artifact, summary: { ...analysis.summary }, candidates: analysis.candidates, tripwires: analysis.tripwires }));
    if (persistResult?.detail) process.stdout.write(`\nPERSIST FAILED: ${persistResult.detail}\n`);
    if (failed) process.exitCode ||= 1;
  }
}

async function cmdRecord() {
  const { repoRoot } = resolveRoots();
  const scan = readScanArtifact(repoRoot, argOption('scan', 'latest'));
  let input;
  const file = argOption('file');
  try { input = JSON.parse(file ? fs.readFileSync(file, 'utf8') : readStdin()); } catch (err) {
    throw new ArgvError(`record reads a proposals JSON envelope from --file or stdin: ${err.message}`);
  }
  const r = checkProposalsAgainstScan(input, scan);
  if (!r.ok) { emit({ ok: false, scanId: scan.scanId, problems: r.problems }); return; }
  const paths = writeProposalsArtifact(repoRoot, scan.scanId, r.envelope, renderProposals(r.envelope));
  emit({ ok: true, scanId: scan.scanId, recorded: r.envelope.proposals.length,
    proposals: path.relative(repoRoot, paths.json), report: path.relative(repoRoot, paths.md) });
}

async function cmdClose(decision) {
  const { repoRoot, mainRoot } = resolveRoots();
  const identity = argOption('identity');
  if (!identity) throw new ArgvError('--identity is required');
  const scanArg = argOption('scan', 'latest');
  let scan = null;
  try { scan = readScanArtifact(repoRoot, scanArg); } catch (err) { if (err.code !== 'NO_SCAN') throw err; }
  const { dir: memoryDir, exists } = resolveHarnessMemoryDir({ repoRoot: mainRoot });
  const { frictionLink } = await import('./lib/friction/commands.mjs');
  const r = await closeDecision({
    decision, identity, scan, test: argOption('test'), layer: argOption('layer'), summary: argOption('summary'),
    memory: argOption('memory'), repoRoot, memoryDir: exists ? memoryDir : null, forceUnscanned: hasFlag('force-unscanned'),
  }, { link: (a) => frictionLink({ ...a, repoRoot: mainRoot }) });
  if (!r.ok) for (const p of r.problems) log(`refused: ${p}`);
  emit(r.ok ? { ok: true, decision: r.decision, steps: r.steps } : { ok: false, problems: r.problems });
}

async function effectInputs({ repoRoot, repoUuid, fromTs, toTs }) {
  const { isCloudEnabled } = await import('./lib/store/repo.mjs');
  if (await isCloudEnabled()) {
    const store = await import('./lib/store/harness-retro.mjs');
    // Bounded to the union of the requested windows (audit B-R1-M7), never the whole history.
    const sessions = fromTs ? await store.readRetroWindow({ repoUuid, fromTs, toTs }) : [];
    const scans = await store.readRetroScans({ repoUuid });
    return { source: 'store', sessions, scans };
  }
  const { scans: arts } = readAllScanArtifacts(repoRoot);
  const latest = new Map();
  for (const a of arts) {
    for (const s of a.sessions) {
      if (!s.complete || s.repoUuid !== repoUuid) continue;
      latest.set(s.sessionKey, { sessionKey: s.sessionKey, repoUuid: s.repoUuid, accountKey: a.accountKey,
        startedAt: s.startedAt, fingerprintVersion: a.fingerprintVersion, counts: s.counts });
    }
  }
  const scans = arts.filter((a) => a.repoUuid === repoUuid && !a.fleet).map((a) => ({
    accountKey: a.accountKey, repoUuid: a.repoUuid, since: a.requested.since, until: a.requested.until, completed: a.completed,
  }));
  return { source: 'local-scan', sessions: [...latest.values()], scans };
}

async function cmdEffect() {
  const { repoRoot } = resolveRoots();
  const self = resolveRepoIdentity(repoRoot);
  const registry = readRegistry(repoRoot);
  const want = argOption('identity');
  const decisions = registry.decisions.filter((d) => d.decision === 'enforced' && (!want || d.identity === want));
  const windowDays = Number(argOption('window-days', String(DEFAULT_WINDOW_DAYS)));
  if (decisions.length === 0) {
    emit({ ok: true, measured: false, reason: want ? `no enforced decision ${want}` : 'no enforced decisions in the registry yet', results: [] });
    return;
  }
  const slug = self.name && self.name.includes('/') ? self.name : null;
  const runGh = (args) => {
    const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    return r.status === 0 ? String(r.stdout) : null;
  };
  const activations = decisions.map((d) => activationFor(d.identity, { runGit: (a) => git(a, repoRoot), runGh, repoSlug: slug }));
  const times = activations.filter((a) => a.status === 'active').map((a) => Date.parse(a.at));
  const W = windowDays * DAY_MS;
  const inputs = await effectInputs({
    repoRoot, repoUuid: self.repoUuid,
    fromTs: times.length ? new Date(Math.min(...times) - W).toISOString() : null,
    toTs: times.length ? new Date(Math.max(...times) + W).toISOString() : null,
  });
  const results = decisions.map((d, i) => computeEffect({
    decision: d, repoUuid: self.repoUuid, windowDays, source: inputs.source,
    activation: activations[i], sessions: inputs.sessions, scans: inputs.scans,
  }));
  emit({ ok: true, source: inputs.source, results });
}

async function cmdStatus() {
  const { repoRoot, mainRoot } = resolveRoots();
  const beat = readHeartbeat(repoRoot);
  const ageDays = beat ? (Date.now() - Date.parse(beat.lastRunAt)) / DAY_MS : null;
  const registry = readRegistry(repoRoot);
  const registryProblems = validateRegistry({ registry, repoRoot });
  const { dir, exists } = resolveHarnessMemoryDir({ repoRoot: mainRoot });
  const retirement = exists ? retirementStatus(dir) : [];
  const stale = ageDays === null || ageDays > HEARTBEAT_STALE_DAYS;
  emit({
    ok: registryProblems.length === 0,
    heartbeat: beat ? { ...beat, ageDays: Math.round(ageDays * 10) / 10, stale } : { stale: true, reason: 'never run' },
    decisions: { enforced: registry.decisions.filter((d) => d.decision === 'enforced').length, rejected: registry.decisions.filter((d) => d.decision === 'rejected').length },
    registryProblems, retirement,
  });
  if (stale) log(`HEARTBEAT STALE — last scan ${beat ? `${Math.round(ageDays)} days ago` : 'never'}; run \`node scripts/harness-retro.mjs scan --persist\``);
}

export async function main() {
  const argv = process.argv;
  if (argv.includes('--selfcheck-relocation')) { process.stdout.write('OK\n'); return 0; }
  assertKnownFlags(argv, KNOWN, { cli: 'harness-retro' });
  const verb = argv[2];
  if (hasFlag('help') || !VERBS.includes(verb)) {
    process.stderr.write(`usage: harness-retro <${VERBS.join('|')}> [flags] — see the file header\n`);
    return hasFlag('help') ? 0 : 2;
  }
  if (verb === 'scan') await cmdScan();
  else if (verb === 'record') await cmdRecord();
  else if (verb === 'enforce') await cmdClose('enforced');
  else if (verb === 'reject') await cmdClose('rejected');
  else if (verb === 'effect') await cmdEffect();
  else await cmdStatus();
  return process.exitCode ?? 0;
}

if (isInvokedAsScript(import.meta.url)) {
  let code;
  try { code = await main(); } catch (err) {
    process.stderr.write(`harness-retro: ${err.message}\n`);
    code = err instanceof ArgvError || err?.code === 'ARGV_ERROR' ? 2 : 1;
  }
  try { const { closePool } = await import('./lib/db/client.mjs'); await closePool(); } catch { /* no pool */ }
  await finishAndExit(code);
}

#!/usr/bin/env node
/**
 * @fileoverview Harness retro CLI — detect recurring session failures
 * mechanically, hand the top few to a judge, record decisions, measure whether
 * an enforcement worked. Plan: docs/plans/harness-retro.md (v1 = the smallest
 * structurally honest version; see its right-sizing gate for what was cut).
 *
 *   node scripts/harness-retro.mjs scan   [--since 7d] [--fleet] [--top 5] [--json]
 *   node scripts/harness-retro.mjs record --scan <id|latest> [--file <proposals.json>]   (else JSON on stdin)
 *   node scripts/harness-retro.mjs enforce --identity <fingerprint:fp|tripwire:name> --scan <id|latest>
 *                                          --test <tests/x.test.mjs> --layer <hook|gate|script|reference-doc|agents-md>
 *                                          --summary <text> [--force-unscanned]
 *   node scripts/harness-retro.mjs reject  --identity <id> --scan <id|latest> --summary <text>
 *   node scripts/harness-retro.mjs effect  [--identity <id>] [--window-days 14]
 *   node scripts/harness-retro.mjs status
 *
 * Transcripts are read from the account's config root (`CLAUDE_CONFIG_DIR`, else
 * `~/.claude`) and NEVER leave local disk. v1 persists nothing to the audit
 * store: derived scan artifacts live under `.audit/harness-retro/` (gitignored)
 * and decisions in the committed `.harness-retro/decisions.json`. Propose, never
 * apply: nothing here edits the harness except `enforce`/`reject`, which a human
 * runs in the fix PR after approving a proposal.
 *
 * Exit codes: 0 ok (including an honest UNMEASURED scan) · 1 a refusal (bad
 * proposals, an enforce preflight) · 2 usage.
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
  writeProposalsArtifact, listScanIds, SCAN_SCHEMA_VERSION,
} from './lib/friction/retro/artifacts.mjs';
import { checkProposalsAgainstScan } from './lib/friction/retro/proposal-schema.mjs';
import { closeDecision } from './lib/friction/retro/closure.mjs';
import { computeEffect, DEFAULT_WINDOW_DAYS } from './lib/friction/retro/effect.mjs';

const VERBS = ['scan', 'record', 'enforce', 'reject', 'effect', 'status'];
const KNOWN = [
  '--since', '--fleet', '--top', '--json', '--scan', '--identity', '--test', '--layer',
  '--summary', '--force-unscanned', '--window-days', '--file', '--help', '--selfcheck-relocation',
];
/** Default judged candidates: the judge sees only the top few (plan right-sizing gate). */
const DEFAULT_TOP = 5;
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
  // linked worktree AND a --separate-git-dir checkout.
  const first = (git(['worktree', 'list', '--porcelain'], cwd) ?? '').split(/\r?\n/).find((l) => l.startsWith('worktree '));
  const main = first ? first.slice('worktree '.length).trim() : top;
  return { repoRoot: path.resolve(top), mainRoot: path.resolve(main) };
}

/**
 * Claude Code's transcript retention for this account: `cleanupPeriodDays` in
 * `<configDir>/settings.json`, default 30. Coverage is clamped to it.
 */
export function transcriptRetentionDays(configDir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8')).cleanupPeriodDays;
    return Number.isFinite(v) && v > 0 ? v : 30;
  } catch { return 30; }
}

export function parseSince(v, now = Date.now()) {
  const m = String(v ?? '14d').match(/^(\d+)d$/);
  if (!m || Number(m[1]) < 1) throw new ArgvError(`--since must look like 14d (got ${v})`);
  return now - Number(m[1]) * DAY_MS;
}

const readStdin = () => fs.readFileSync(0, 'utf8');

async function cmdScan() {
  const now = Date.now();
  const startedAt = Date.now();
  const sinceMs = parseSince(argOption('since', '7d'), now);
  const top = Number(argOption('top', String(DEFAULT_TOP)));
  if (!Number.isInteger(top) || top < 1) throw new ArgvError('--top must be a positive integer');
  const fleet = hasFlag('fleet');
  const { repoRoot, mainRoot } = resolveRoots();
  const configDir = claudeConfigDir();
  const self = resolveRepoIdentity(repoRoot);
  const thisRepoUuid = self.source === 'path-fallback' ? null : self.repoUuid;
  log(`scanning ${configDir} since ${new Date(sinceMs).toISOString()}${fleet ? ' (fleet)' : ''}…`);
  const retentionDays = transcriptRetentionDays(configDir);
  const scan = await runScan({ configDir, sinceMs, untilMs: now, resolver: createRepoResolver(), thisRepoUuid, fleet, retentionDays });
  if (scan.sinceClamped) log(`--since reaches past the transcript retention horizon (${retentionDays} d): coverage is claimed from ${scan.requested.since} only`);

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
    requested: scan.requested, retentionDays: scan.retentionDays, sinceClamped: scan.sinceClamped, files: scan.files, completed: scan.completed, measured: scan.measured,
    ...(scan.reason ? { reason: scan.reason } : {}),
    transcriptVersions: scan.transcriptVersions, excluded: scan.excluded,
    sessions: scan.sessions, fingerprints: scan.fingerprints,
    candidates: analysis.candidates, tripwires: analysis.tripwires, summary: analysis.summary,
  };
  const file = writeScanArtifact(repoRoot, artifact);
  const pruned = pruneScanArtifacts(repoRoot, { now });
  const elapsedMs = Date.now() - startedAt;
  const envelope = {
    ok: true, measured: scan.measured, ...(scan.reason ? { reason: scan.reason } : {}),
    scanId, artifact: path.relative(repoRoot, file), elapsedMs, files: scan.files, excluded: scan.excluded,
    completed: scan.completed, summary: analysis.summary, pruned,
    candidates: analysis.candidates.map(({ identity, kind, tool, sessions, occurrences, repos, rank, label, coveredBy }) => ({ identity, kind, tool, sessions, occurrences, repos, rank, label, coveredBy })),
    promotionCandidates: analysis.tripwires.filter((t) => t.status === 'promotion-candidate'),
  };
  if (hasFlag('json')) emit(envelope);
  else process.stdout.write(renderScanReport({ ...artifact, elapsedMs, candidates: analysis.candidates, tripwires: analysis.tripwires }));
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
  let scan = null;
  try { scan = readScanArtifact(repoRoot, argOption('scan', 'latest')); } catch (err) { if (err.code !== 'NO_SCAN') throw err; }
  const { dir: memoryDir, exists } = resolveHarnessMemoryDir({ repoRoot: mainRoot });
  const { frictionLink } = await import('./lib/friction/commands.mjs');
  const r = await closeDecision({
    decision, identity, scan, test: argOption('test'), layer: argOption('layer'), summary: argOption('summary'),
    repoRoot, memoryDir: exists ? memoryDir : null, forceUnscanned: hasFlag('force-unscanned'),
  }, { link: (a) => frictionLink({ ...a, repoRoot: mainRoot }) });
  if (!r.ok) for (const p of r.problems) log(`refused: ${p}`);
  emit(r.ok ? { ok: true, decision: r.decision, steps: r.steps } : { ok: false, problems: r.problems });
}

/** v1 effect inputs: the local scan artifacts (derived, gitignored, this machine). */
function effectInputs({ repoRoot, repoUuid }) {
  const { scans: arts, invalid } = readAllScanArtifacts(repoRoot);
  const latest = new Map();
  for (const a of arts) {   // oldest → newest, so a later scan's row supersedes
    for (const s of a.sessions) {
      if (!s.complete || s.repoUuid !== repoUuid) continue;
      latest.set(s.sessionKey, { sessionKey: s.sessionKey, repoUuid: s.repoUuid, accountKey: a.accountKey,
        startedAt: s.startedAt, fingerprintVersion: a.fingerprintVersion, counts: s.counts });
    }
  }
  const scans = arts.filter((a) => a.repoUuid === repoUuid && !a.fleet).map((a) => ({
    accountKey: a.accountKey, repoUuid: a.repoUuid, since: a.requested.since, until: a.requested.until, completed: a.completed,
  }));
  return { source: 'local-scan', sessions: [...latest.values()], scans, invalidArtifacts: invalid };
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
  const inputs = effectInputs({ repoRoot, repoUuid: self.repoUuid });
  const results = decisions.map((d) => computeEffect({
    decision: d, repoUuid: self.repoUuid, windowDays, source: inputs.source,
    activation: activationFor(d.identity, { runGit: (a) => git(a, repoRoot), runGh, repoSlug: slug }),
    sessions: inputs.sessions, scans: inputs.scans,
  }));
  emit({ ok: true, source: inputs.source, invalidArtifacts: inputs.invalidArtifacts, results });
}

async function cmdStatus() {
  const { repoRoot } = resolveRoots();
  const registry = readRegistry(repoRoot);
  const registryProblems = validateRegistry({ registry, repoRoot });
  const ids = listScanIds(repoRoot);
  let lastScan = null;
  if (ids.length) {
    const a = readScanArtifact(repoRoot, 'latest');
    lastScan = { scanId: a.scanId, createdAt: a.createdAt, ageDays: Math.round(((Date.now() - Date.parse(a.createdAt)) / DAY_MS) * 10) / 10, measured: a.measured };
  }
  emit({
    ok: registryProblems.length === 0,
    lastScan: lastScan ?? { reason: 'never run on this checkout' },
    scansOnDisk: ids.length,
    decisions: { enforced: registry.decisions.filter((d) => d.decision === 'enforced').length, rejected: registry.decisions.filter((d) => d.decision === 'rejected').length },
    registryProblems,
  });
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
  await finishAndExit(code);
}

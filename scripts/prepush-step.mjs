#!/usr/bin/env node
/**
 * @fileoverview Helpers the consumer pre-push hook calls so no step of it can hang silently (see lib/prepush-step.mjs).
 *
 *   prepush-step.mjs run --step <name> --budget-sec <n> [--progress-sec <n>] [--out <file>] -- <cmd> [args...]
 *       Runs the command with a wall-clock budget and a heartbeat on stderr. The command's stdout is this process's stdout (the
 *       hook captures `--select` that way). Exit: the command's status, 124 when it outlived the budget (the hook refuses the push).
 *   prepush-step.mjs own-files
 *       Reads the push range from AUDIT_PUSH_RANGE_BASE/_HEAD (the hook exports it from git's own stdin) and prints ONE line:
 *       `scoped:<comma-separated files>` when the range holds a merge of the default branch and the branch's own files are known
 *       (an empty list means the branch owns nothing in the range), else `unscoped`.
 *   prepush-step.mjs capabilities
 *       Prints the subcommands this runner has. The hook asks before relying on one: a source checkout older than the hook lacks them.
 *   prepush-step.mjs audit-outcome --exit <n> --report <envelope.json> [--out <capture-file>]
 *       Classifies the code-audit step (lib/prepush-audit-gate.mjs): exit 0 = the push may continue, 1 = refuse. An audit that did not
 *       run to a verdict (crash, auth/config failure, INCOMPLETE exit 3, no envelope) REFUSES unless AUDIT_PREPUSH_ALLOW_UNMEASURED=1.
 *   prepush-step.mjs audit-reuse
 *       `reuse <runId> <round> <tree12>` when a CONVERGED audit run recorded for exactly the pushed commit's tree exists;
 *       `reuse-equivalent <runId> <round> <commits>` when the tree differs but the branch's own commits have exactly the audited
 *       commits' content fingerprints (range-diff-equivalent: a rebase / cherry-pick recovery); else `none <reason>`. Anything unverifiable is
 *       `none` (the audit runs).
 *   prepush-step.mjs audit-budget [--files <a,b,...>]
 *       `<seconds> <basis>`: the code-audit budget scaled to the pushed diff (`600 + 30*files`, capped; refit from the store).
 *   prepush-step.mjs no-code
 *       `no-code <N> <record-path>` when EVERY pushed file is a non-subject for the code audit (lockfiles, images, `*.json`, config/schema/type
 *       dirs - the audit's own `shared` bucket): the record `.audit/prepush/<tree>.no-code.json` is written first, atomically. Anything else, or any
 *       failure including a failed record write, is `code <reason>` and the audit runs. The hook bypasses only on rc 0 + this exact token + the record.
 *   prepush-step.mjs recurrence --report <current report.json> [--head <sha>]
 *       One informational line: how many of this push's findings sit on files the previous push on this lineage flagged, or
 *       `recurrence unavailable: <reason>`. Never suppresses, never gates; exit 0 either way.
 *   prepush-step.mjs no-plan
 *       The plan selector resolved NO plan: exit 0 when the push carries nothing a code audit reads (docs / sync bookkeeping only) or
 *       AUDIT_PREPUSH_ALLOW_UNMEASURED=1 says so on purpose, exit 1 (UNMEASURED) otherwise - including when the file list is unknown.
 *
 * @module scripts/prepush-step
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertKnownFlags, ArgvError, finishAndExit, toShellExitCode } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { resolvePushRange, branchOwnedChangedFiles } from './lib/push-range.mjs';
import { runStep } from './lib/prepush-step.mjs';
import {
  classifyAuditOutcome, decideAuditGate, decideAuditReuse, auditBudgetSec, parseNumstatZ, decideNoPlanGate,
  classifyNoCodePush, buildNoCodeRecord, noCodeLine, codeLine, summariseRecurrence, formatRecurrenceLine,
} from './lib/prepush-audit-gate.mjs';
import { patchRangesEquivalent } from './lib/patch-equivalence.mjs';

/** Signals that mean "stop": a terminal interrupt, a termination request, a hangup, and Ctrl+Break on Windows. */
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'];
const KNOWN_FLAGS = [
  '--step', '--budget-sec', '--progress-sec', '--out', '--default-ref', '--selfcheck-relocation',
  '--exit', '--report', '--files', '--cwd', '--selector-failed', '--head',
];
/** What this runner can do. The hook asks before relying on a subcommand, because an older source checkout lacks the newer ones. */
export const CAPABILITIES = Object.freeze(['run', 'own-files', 'audit-outcome', 'audit-reuse', 'audit-budget', 'no-plan', 'no-code', 'recurrence']);
/** A store lookup that outlives this is "unverifiable", i.e. a re-run - a reuse check must never be able to hang the hook. */
const REUSE_LOOKUP_MS = 20_000;

const flagValue = (argv, name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

/** @returns {string} the single protocol line `own-files` prints */
export function ownFilesLine({ env = process.env, defaultRef, resolve = resolvePushRange, owned = branchOwnedChangedFiles } = {}) {
  const range = resolve({ env });
  // Only a range git itself handed the hook (source 'explicit') may narrow what is audited: an inferred one may already be too small.
  if (!range.ok || !range.trusted) return 'unscoped';
  const r = owned(range, defaultRef ? { defaultRef } : {});
  // A path with a comma or a newline cannot ride a one-line comma-separated list: say "unscoped" (the whole diff) rather than split it.
  if (!r || !r.scoped || r.files.some((f) => /[,\r\n]/.test(f))) return 'unscoped';
  return `scoped:${r.files.join(',')}`;
}

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });

/** A `run(args)` for resolvePushRange that reads the repo at `cwd` (its default reads the process cwd) and answers null on failure. */
const runIn = (cwd, gitFn) => (args) => { try { return gitFn(cwd, args).trim() || null; } catch { return null; } };

/** Last `n` non-empty lines of a captured output file, for a human to read. Display only - nothing is decided from it. */
function tailOf(file, n = 6, maxBytes = 64 * 1024) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim() !== '').slice(-n).map((l) => (l.length > 400 ? `${l.slice(0, 400)}...` : l));
  } catch { return []; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* best effort */ } } }
}

/**
 * `audit-outcome`: classify the audit step's exit + `--out` envelope, print the verdict for the operator, and return the hook's
 * exit (0 = let the push continue, 1 = refuse). A failure of THIS function is a refusal too - it can never turn into a pass.
 * @returns {number}
 */
export function auditOutcomeExit({ exitArg, reportFile, captureFile, env = process.env, write = (l) => process.stderr.write(`${l}\n`) }) {
  const exitCode = exitArg === null || exitArg === '' || !Number.isInteger(Number(exitArg)) ? null : Number(exitArg);
  let report = null;
  if (reportFile) { try { report = JSON.parse(fs.readFileSync(reportFile, 'utf8')); } catch { report = null; } }
  const outcome = classifyAuditOutcome({ exitCode, report });
  const decision = decideAuditGate({ outcome, env });
  if (outcome.kind === 'unmeasured' && captureFile) {
    const tail = tailOf(captureFile);
    if (tail.length > 0) { write('[prepush-hook] the audit\'s last output lines:'); for (const l of tail) write(`   | ${l}`); }
  }
  for (const l of decision.lines) write(l);
  return decision.allow ? 0 : 1;
}

/**
 * `no-plan`: the hook's answer when the plan selector resolved nothing. The pushed file list comes from git's own range (never an
 * inferred one: an unknown range cannot be shown to be docs-only). Returns the hook's exit (0 = continue, 1 = refuse).
 * @returns {number}
 */
export function noPlanExit({ env = process.env, cwd = process.cwd(), gitFn = git, selectorFailed = false, write = (l) => process.stderr.write(`${l}
`) } = {}) {
  let files = null;
  try {
    const range = resolvePushRange({ env, run: runIn(cwd, gitFn) });
    if (range.ok && range.trusted) {
      files = gitFn(cwd, ['diff', '--name-only', '--no-renames', '-z', `${range.base}..${range.head}`]).split('\0').filter(Boolean);
    }
  } catch { files = null; }
  const decision = decideNoPlanGate({ files, env, selectorFailed, exists: (p) => fs.existsSync(path.resolve(cwd, p)) });
  for (const l of decision.lines) write(l);
  return decision.allow ? 0 : 1;
}

/** Where the kept audit files live, relative to the repo (the hook's AUDIT_KEEP_DIR). */
const KEEP_REL = '.audit/prepush';
const KEEP_DIR = path.join('.audit', 'prepush');

/** Atomic write: a temp file in the SAME directory (exclusive create), then a rename, so a reader sees all of the record or none of it. */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ } throw e; }
}

/** Keep the newest N no-code records (the hook's AUDIT_PREPUSH_KEEP_REPORTS policy: a positive integer of at most 6 digits, else 20), never the one just written. */
function pruneNoCodeRecords(dir, protect, keepArg) {
  const n = /^[1-9][0-9]{0,5}$/.test(String(keepArg ?? '')) ? Number(keepArg) : 20;
  try {
    fs.readdirSync(dir).filter((e) => e.endsWith('.no-code.json') && e !== protect)
      .map((e) => ({ e, m: fs.statSync(path.join(dir, e)).mtimeMs })).sort((a, b) => b.m - a.m).slice(Math.max(0, n - 1))
      .forEach((x) => fs.rmSync(path.join(dir, x.e), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  } catch { /* retention is housekeeping: it never changes the outcome */ }
}

/** The audit's own predicates, loaded only by the subcommand that needs them (~190ms of imports the other subcommands do not pay). */
async function loadNoCodeDeps() {
  const { classifyFiles, isAuditInfraFile } = await import('./lib/audit-scope.mjs');
  const { classifyFileCoverage } = await import('./lib/language-profiles.mjs');
  return {
    isInfra: (f) => isAuditInfraFile(f),
    taxonomyClass: (f) => classifyFileCoverage(f).class,
    bucketOf: (f) => { const b = classifyFiles([f]); return b.shared.length ? 'shared' : (b.frontend.length ? 'frontend' : 'backend'); },
  };
}

const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** The only sidecar name this tool writes: a tree object id plus `.head`. */
const SIDECAR_RE = /^[0-9a-f]{40}([0-9a-f]{24})?\.head$/;

/**
 * `no-code`: the protocol line. Every failure direction is `code <reason>` (measure), never `no-code`.
 * @returns {Promise<string>}
 */
export async function noCodeStepLine({ env = process.env, cwd = process.cwd(), gitFn = git, deps = null } = {}) {
  try {
    const range = resolvePushRange({ env, run: runIn(cwd, gitFn) });
    if (!range.ok || !range.trusted) return codeLine('the push range was not handed over by git');
    let files;
    try { files = gitFn(cwd, ['diff', '--name-only', '--no-renames', '-z', `${range.base}..${range.head}`]).split('\0').filter(Boolean); } catch { return codeLine('the pushed file list could not be read'); }
    const c = classifyNoCodePush({ files, ...(deps ?? await loadNoCodeDeps()) });
    if (!c.noCode) return codeLine(c.reason);
    let tree = '';
    try { tree = gitFn(cwd, ['rev-parse', '--verify', '--quiet', `${range.head}^{tree}`]).trim(); } catch { tree = ''; }
    if (!OID_RE.test(tree)) return codeLine('the pushed tree could not be resolved');
    const rel = `${KEEP_REL}/${tree}.no-code.json`; // a protocol string: forward slashes on every platform
    try { writeAtomic(path.join(cwd, rel), `${JSON.stringify(buildNoCodeRecord({ tree, base: range.base, head: range.head, files: c.files }), null, 2)}\n`); } catch (e) { return codeLine(`the no-code record could not be written (${e?.code || 'error'})`); }
    pruneNoCodeRecords(path.join(cwd, KEEP_DIR), path.basename(rel), env.AUDIT_PREPUSH_KEEP_REPORTS);
    return noCodeLine(c.files.length, rel);
  } catch (e) { return codeLine(`the no-code step failed (${e?.message || 'error'})`); }
}

const treeOfReport = (file) => path.basename(file).replace(/\.report\.json$/, '');

/**
 * `recurrence`: one informational line. The previous push on THIS lineage is the newest other kept report whose recorded head is an
 * ANCESTOR of the current head (the hook has no branch name, and a rebased branch honestly reads as unavailable). The current head is
 * recorded beside the report so the next push can ask the same question.
 * @returns {string}
 */
export function recurrenceLine({ reportFile, headArg = null, env = process.env, cwd = process.cwd(), gitFn = git, deps } = {}) {
  try {
    if (!reportFile) return 'recurrence unavailable: no current report';
    if (!deps) return 'recurrence unavailable: comparator not loaded';
    const range = resolvePushRange({ env, run: runIn(cwd, gitFn) });
    const head = headArg || (range.ok ? range.head : null);
    const curHead = head ? (OID_RE.test(head) ? head : (runIn(cwd, gitFn)(['rev-parse', '--verify', '--quiet', `${head}^{commit}`]) || null)) : null;
    if (!OID_RE.test(String(curHead ?? ''))) return 'recurrence unavailable: the pushed head could not be resolved';
    let cur;
    try { cur = JSON.parse(fs.readFileSync(reportFile, 'utf8')); } catch { return 'recurrence unavailable: the current report is unreadable'; }
    if (!Array.isArray(cur?.findings)) return 'recurrence unavailable: the current report has no findings list';
    const dir = path.dirname(path.resolve(cwd, reportFile));
    try { writeAtomic(path.join(dir, `${treeOfReport(reportFile)}.head`), `${curHead}\n`); } catch { /* the next push loses its baseline; this line is still computed */ }
    // Sidecars whose report was pruned are dead weight: removed here so the hook's shell prune stays unchanged.
    for (const e of fs.readdirSync(dir)) {
      // Ownership: only a sidecar THIS tool names (<tree-oid>.head), a regular file, with no report beside it. Never a suffix match alone.
      if (SIDECAR_RE.test(e) && fs.lstatSync(path.join(dir, e)).isFile() && !fs.existsSync(path.join(dir, e.replace(/\.head$/, '.report.json')))) { try { fs.rmSync(path.join(dir, e), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ } }
    }
    const others = fs.readdirSync(dir).filter((e) => e.endsWith('.report.json') && e !== path.basename(reportFile))
      .map((e) => ({ e, mtime: fs.statSync(path.join(dir, e)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
    let prev = null;
    for (const o of others) {
      let prevHead = '';
      try { prevHead = fs.readFileSync(path.join(dir, o.e.replace(/\.report\.json$/, '.head')), 'utf8').trim(); } catch { continue; }
      if (!OID_RE.test(prevHead) || prevHead === curHead) continue;
      try { gitFn(cwd, ['merge-base', '--is-ancestor', prevHead, curHead]); } catch { continue; }
      prev = { file: path.join(dir, o.e), tree: o.e.replace(/\.report\.json$/, '') };
      break;
    }
    if (!prev) return 'recurrence unavailable: no earlier report on this lineage';
    let prevReport;
    try { prevReport = JSON.parse(fs.readFileSync(prev.file, 'utf8')); } catch { return 'recurrence unavailable: the earlier report is unreadable'; }
    if (!Array.isArray(prevReport?.findings)) return 'recurrence unavailable: the earlier report has no findings list';
    const s = summariseRecurrence({ previous: prevReport.findings, current: cur.findings, filesOf: deps.filesOf, similarity: deps.similarity });
    return formatRecurrenceLine({ prevTree: prev.tree, ...s });
  } catch (e) { return `recurrence unavailable: ${e?.message || 'error'}`; }
}

/** `audit-budget`: one integer (seconds). The size is the pushed range, narrowed to the branch's own files when the hook scoped it. */
export function auditBudgetLine({ env = process.env, cwd = process.cwd(), files = null, gitFn = git } = {}) {
  let size = { files: null, lines: null };
  try {
    const range = resolvePushRange({ env, run: runIn(cwd, gitFn) });
    if (range.ok && range.trusted) {
      const paths = files ? files.split(',').filter(Boolean) : [];
      size = parseNumstatZ(gitFn(cwd, ['diff', '--numstat', '-z', `${range.base}..${range.head}`, ...(paths.length ? ['--', ...paths] : [])]));
    }
  } catch { /* size stays unknown -> the old floor, which is the conservative budget */ }
  const { budgetSec, basis } = auditBudgetSec(size);
  return `${budgetSec} ${basis}`;
}

async function defaultConvergence(runId) {
  // The store reads its own DSN (shared ~/.audit-loop.env layer included) - resolved here inside the CLI, never via the shell.
  await import('./lib/load-env.mjs');
  const { isCloudEnabled } = await import('./lib/store/repo.mjs');
  if (!(await isCloudEnabled())) return { convergence: null, why: 'cloud store is off' };
  const { getAuditRunConvergence } = await import('./lib/store/runs-findings.mjs');
  const row = await getAuditRunConvergence(runId);
  return row ? { convergence: row, why: null } : { convergence: null, why: 'no audit_runs row for that run, or the query failed' };
}

/**
 * `audit-reuse`: `reuse <runId> <round> <tree12>` or `none <reason>`. Every failure to establish reuse is `none` - the audit runs.
 * @returns {Promise<string>}
 */
export async function auditReuseLine({
  env = process.env, cwd = process.cwd(), gitFn = git, readConvergence = defaultConvergence, lookupMs = REUSE_LOOKUP_MS,
  patchEquivalence = patchRangesEquivalent, defaultRef = 'origin/main',
} = {}) {
  let marker = null;
  try { marker = JSON.parse(fs.readFileSync(path.join(cwd, '.audit', 'last-audit-run.json'), 'utf8')); } catch { marker = null; }
  // Only a range git itself handed the hook may name the pushed commit; an inferred one is a guess.
  const range = resolvePushRange({ env, run: runIn(cwd, gitFn) });
  let pushedTree = null;
  if (range.ok && range.trusted) { try { pushedTree = gitFn(cwd, ['rev-parse', '--verify', '--quiet', `${range.head}^{tree}`]).trim() || null; } catch { pushedTree = null; } }
  // A different tree is reusable only when the branch's own patches are exactly the audited commits' (a rebase moves the tree, not the
  // branch's diff). Asked only when the marker names the commit it audited: no sha, nothing to compare.
  let equivalence = null;
  if (marker?.runId && pushedTree && marker.auditedTree && marker.auditedTree !== pushedTree && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(String(marker.auditedSha ?? ''))) {
    try {
      equivalence = patchEquivalence({
        auditedRef: marker.auditedSha, headRef: range.head, defaultRef, expectedAuditedTree: marker.auditedTree, cwd,
        // The real path uses the predicate's own runner (it reads patch bytes losslessly; this file's utf8 `git` would not). Only a test that
        // injected its own gitFn is routed through it.
        ...(gitFn === git ? {} : { git: (args) => { try { return gitFn(cwd, args); } catch { return null; } } }),
      });
    } catch (e) { equivalence = { equivalent: false, reason: `the comparison failed (${e?.message || 'error'})` }; }
  }
  let conv = { convergence: null, why: 'not looked up' };
  // The store is only worth a round trip when the tree already matches or the patches are equivalent: nothing else can be reused.
  if (marker?.runId && pushedTree && (marker.auditedTree === pushedTree || equivalence?.equivalent === true)) {
    let timer;
    try {
      conv = await Promise.race([
        readConvergence(marker.runId),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ convergence: null, why: `store lookup exceeded ${Math.round(lookupMs / 1000)}s` }), lookupMs); }),
      ]);
    } catch (e) { conv = { convergence: null, why: `store lookup failed (${e?.code || e?.message || 'error'})` }; } finally { clearTimeout(timer); }
  }
  const d = decideAuditReuse({ marker, pushedTree, convergence: conv.convergence, convergenceWhy: conv.why, equivalence });
  if (!d.reuse) return `none ${d.reason}`;
  return d.equivalence === 'range-diff' ? `reuse-equivalent ${d.runId} ${d.round} ${d.commits}` : `reuse ${d.runId} ${d.round} ${d.auditedTree.slice(0, 12)}`;
}

async function main() {
  const argv = process.argv.slice(2);
  const dd = argv.indexOf('--');
  const head = dd >= 0 ? argv.slice(0, dd) : argv;
  // Only OUR flags count: the hook runs `run -- node check-plan-status.mjs --selfcheck-relocation`, and answering OK for the wrapped
  // command's probe would report a checker runnable that never started.
  if (head.includes('--selfcheck-relocation')) { console.log('OK'); await finishAndExit(0); return; }
  assertKnownFlags(['', '', ...head], KNOWN_FLAGS, { cli: 'prepush-step.mjs' });
  const sub = head[0];

  if (sub === 'own-files') {
    process.stdout.write(`${ownFilesLine({ defaultRef: flagValue(head, '--default-ref') ?? undefined })}\n`);
    await finishAndExit(0);
    return;
  }
  if (sub === 'capabilities') {
    process.stdout.write(`${CAPABILITIES.join(' ')}\n`);
    await finishAndExit(0);
    return;
  }
  if (sub === 'audit-outcome') {
    const code = auditOutcomeExit({ exitArg: flagValue(head, '--exit'), reportFile: flagValue(head, '--report'), captureFile: flagValue(head, '--out') });
    await finishAndExit(code);
    return;
  }
  if (sub === 'audit-budget') {
    process.stdout.write(`${auditBudgetLine({ files: flagValue(head, '--files') })}\n`);
    await finishAndExit(0);
    return;
  }
  if (sub === 'no-code') {
    process.stdout.write(`${await noCodeStepLine()}\n`);
    await finishAndExit(0);
    return;
  }
  if (sub === 'recurrence') {
    const { findingFiles } = await import('./lib/concern-identity.mjs');
    const { ledgerFindingSimilarity } = await import('./lib/ledger.mjs');
    process.stdout.write(`${recurrenceLine({ reportFile: flagValue(head, '--report'), headArg: flagValue(head, '--head'), deps: { filesOf: findingFiles, similarity: ledgerFindingSimilarity } })}\n`);
    await finishAndExit(0);
    return;
  }
  if (sub === 'no-plan') {
    await finishAndExit(noPlanExit({ selectorFailed: head.includes('--selector-failed') }));
    return;
  }
  if (sub === 'audit-reuse') {
    process.stdout.write(`${await auditReuseLine()}\n`);
    await finishAndExit(0);
    return;
  }
  if (sub !== 'run') throw new ArgvError('prepush-step.mjs: expected `run`, `own-files`, `audit-outcome`, `audit-reuse`, `audit-budget`, `no-plan`, `no-code`, `recurrence` or `capabilities`');

  const step = flagValue(head, '--step');
  const budgetSec = Number(flagValue(head, '--budget-sec'));
  const progressSec = flagValue(head, '--progress-sec') === null ? 30 : Number(flagValue(head, '--progress-sec'));
  const cmdv = dd >= 0 ? argv.slice(dd + 1) : [];
  if (!step || !(budgetSec > 0) || !(progressSec >= 0) || cmdv.length === 0) {
    throw new ArgvError('prepush-step.mjs run: needs --step <name>, --budget-sec <n> > 0 and a command after `--`');
  }
  const outFile = flagValue(head, '--out');
  const fd = outFile ? fs.openSync(outFile, 'w') : null;
  const [cmd, ...args] = cmdv;
  // A stop request (the hook was interrupted) must reach the step's process tree, or the machine keeps burning after the push died.
  const abort = new AbortController();
  const stop = () => abort.abort();
  const wired = STOP_SIGNALS.filter((sig) => { try { process.on(sig, stop); return true; } catch { return false; } });
  let r;
  try {
    r = await runStep({
      signal: abort.signal, step, cmd: cmd === 'node' ? process.execPath : cmd, args, budgetMs: budgetSec * 1000, progressMs: progressSec * 1000,
      stdio: fd === null ? 'inherit' : ['ignore', fd, fd], log: (line) => process.stderr.write(`${line}\n`),
    });
  } finally {
    for (const sig of wired) process.off(sig, stop);
    if (fd !== null) fs.closeSync(fd);
  }
  await finishAndExit(toShellExitCode(r.code)); // git reads a hook's status as `code & 0xff`: a step failing with 256 must not read as 0
}

if (isInvokedAsScript(import.meta.url)) {
  main().catch(async (err) => {
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') {
      process.stderr.write(`${err.message}\n`);
      await finishAndExit(2);
      return;
    }
    process.stderr.write(`prepush-step.mjs: ${err?.stack ?? err}\n`);
    await finishAndExit(1);
  });
}

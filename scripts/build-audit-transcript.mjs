#!/usr/bin/env node
/**
 * @fileoverview `build-audit-transcript` — assemble the final-review transcript
 * that `gemini-review.mjs review <plan> <transcript>` consumes.
 *
 * Closes the gap a 2026-08-08 field report hit: `/audit-plan` Step 6 and
 * `/audit-code` Step 7 are both MANDATORY and both consumed
 * `.audit/$SID-transcript.json`, which NO step produced. The gate died on
 * `File not found` and the operator hand-rolled the JSON from a reference doc.
 *
 * Usage (the documented skill flow — one flag, everything derived):
 *   node scripts/build-audit-transcript.mjs --sid $SID
 *
 * Explicit form (consolidated /cycle gate, non-standard artifact locations):
 *   node scripts/build-audit-transcript.mjs \
 *     --result .audit/$SID-r1-result.json --result .audit/$SID-r2-result.json \
 *     --ledger .audit/$SID-ledger.json --mode code \
 *     --changed src/a.mjs,src/b.mjs \
 *     --out .audit/$SID-transcript.json
 *
 * `--sid` discovers every `<sid>-r<N>-result.json` in `--dir` (default
 * `.audit`), picks up `<sid>-ledger.json` when present, infers `--mode` from
 * the sid prefix, and defaults `--out` to `<dir>/<sid>-transcript.json`.
 *
 * Fails loudly rather than emitting a thin transcript: no round results, an
 * unparseable result, or an unresolvable mode is a non-zero exit. A final gate
 * fed a transcript that merely LOOKS complete is the failure this prevents.
 *
 * @module scripts/build-audit-transcript
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import { atomicWriteFileSync } from './lib/file-io.mjs';
import {
  AUDIT_MODES, buildAuditTranscript, discoverRoundResults, inferAuditMode, readRoundResult,
} from './lib/audit/transcript.mjs';

const KNOWN_FLAGS = [
  '--sid', '--dir', '--result', '--ledger', '--mode', '--changed', '--summary',
  '--out', '--json', '--selfcheck-relocation',
];

/** Collect every `--result <path>` occurrence (the flag is repeatable). */
function collectRepeated(argv, flag) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1]) out.push(argv[++i]);
  }
  return out;
}

function valueOf(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'build-audit-transcript' });

  const argv = process.argv.slice(2);
  const sid = valueOf(argv, '--sid');
  const dir = valueOf(argv, '--dir') || '.audit';
  const explicitResults = collectRepeated(argv, '--result');
  const jsonMode = argv.includes('--json');

  if (!sid && explicitResults.length === 0) {
    throw new ArgvError(
      'build-audit-transcript: pass --sid <SID> (discovers the session\'s round results '
      + `in ${dir}/) or one or more --result <path>.`,
    );
  }

  // ── Resolve the round-result set ────────────────────────────────────────
  const resultPaths = explicitResults.length > 0
    ? explicitResults
    : discoverRoundResults({ sid, dir }).map(r => r.path);
  if (resultPaths.length === 0) {
    console.error(
      `build-audit-transcript: no round results for sid "${sid}" in ${dir}/ `
      + '(expected <sid>-r<N>-result.json). Run the audit round first, or pass --result explicitly.',
    );
    process.exit(1);
  }
  const rounds = resultPaths.map(readRoundResult);

  // ── Resolve the mode ────────────────────────────────────────────────────
  const modeFlag = valueOf(argv, '--mode');
  if (modeFlag && !AUDIT_MODES.includes(modeFlag)) {
    throw new ArgvError(`build-audit-transcript: --mode must be one of ${AUDIT_MODES.join('|')}, got "${modeFlag}"`);
  }
  const auditMode = modeFlag || inferAuditMode(sid);
  if (!auditMode) {
    // Never default a plan audit to `code`: that is precisely the category error
    // `--mode plan` exists to prevent (the reviewer would flag the plan's
    // not-yet-written implementations as missing code).
    throw new ArgvError(
      'build-audit-transcript: could not infer --mode from the session id '
      + `(${sid ? `"${sid}"` : 'no --sid'}); pass --mode plan or --mode code explicitly.`,
    );
  }

  // ── Ledger (optional — adds the deliberation trail) ──────────────────────
  let ledgerPath = valueOf(argv, '--ledger');
  if (!ledgerPath && sid) {
    const guess = path.join(dir, `${sid}-ledger.json`);
    if (fs.existsSync(guess)) ledgerPath = guess;
  }
  let ledger = null;
  if (ledgerPath) {
    try {
      ledger = JSON.parse(fs.readFileSync(path.resolve(ledgerPath), 'utf-8'));
    } catch (err) {
      // An explicitly-named ledger that cannot be read is an error; a guessed
      // one that vanished mid-run is not worth failing the gate over.
      const msg = `build-audit-transcript: could not read ledger ${ledgerPath}: ${err.message}`;
      if (valueOf(argv, '--ledger')) { console.error(msg); process.exit(1); }
      process.stderr.write(`  [transcript] WARN: ${msg} — continuing without the resolutions trail\n`);
    }
  }

  const changedRaw = valueOf(argv, '--changed');
  const changedFiles = changedRaw ? changedRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

  const transcript = buildAuditTranscript({
    rounds,
    auditMode,
    changedFiles,
    ledger,
    summary: valueOf(argv, '--summary'),
  });

  const outFile = valueOf(argv, '--out')
    || (sid ? path.join(dir, `${sid}-transcript.json`) : null);
  if (!outFile) {
    throw new ArgvError('build-audit-transcript: --out <path> is required when --sid is not given.');
  }
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  atomicWriteFileSync(outFile, `${JSON.stringify(transcript, null, 2)}\n`);

  const findings = rounds.reduce((n, r) => n + (r.findings?.length ?? 0), 0);
  if (jsonMode) {
    console.log(JSON.stringify({
      ok: true,
      out: outFile,
      mode: auditMode,
      rounds: rounds.length,
      findings,
      codeFiles: transcript.code_files.length,
      changedFiles: transcript.changed_files.length,
      resolutions: transcript.claude_resolutions?.length ?? 0,
    }));
  } else {
    console.log(
      `transcript → ${outFile} · mode=${auditMode} · rounds=${rounds.length} · findings=${findings}`
      + ` · code_files=${transcript.code_files.length} · changed_files=${transcript.changed_files.length}`
      + ` · resolutions=${transcript.claude_resolutions?.length ?? 0}`,
    );
  }
  // `changed_files` empty in code mode disables the reviewer's scope filter —
  // say so, since the symptom (out-of-scope new findings) surfaces much later.
  if (auditMode === 'code' && transcript.changed_files.length === 0) {
    process.stderr.write(
      '  [transcript] WARN: changed_files is empty — the final reviewer\'s scope filter is a no-op.'
      + ' Pass --changed with the same file list you gave the R1 audit.\n',
    );
  }
}

try {
  main();
} catch (err) {
  // A usage mistake is not a crash: print the diagnostic alone, no stack.
  if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') {
    console.error(err.message);
    process.exit(2);
  }
  console.error(err.message);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * @fileoverview `write-ledger-entries` — write adjudication-ledger entries for a
 * round's findings from a triage map, deriving every identity field FROM the
 * round's own result JSON.
 *
 * Why a CLI and not the documented heredoc snippet (two defects, one fix):
 *
 *  1. **The snippet could not run in a consumer repo.** It wrote a `.mjs` file
 *     importing `../../scripts/shared.mjs`, but a consumer's bundle lives under
 *     `scripts/.claude-skills/`, and the sync's command rewriter only relocates
 *     `node scripts/<path>` invocations — never a module specifier inside a
 *     heredoc. Same class a consumer reported on 2026-08-08 for /plan's Gate-1
 *     self-check.
 *  2. **Hand-constructed identity fields make the ledger invisible.** Every
 *     downstream matcher keys on the finding's OWN fields (`topicId` folds in
 *     `_hash`; suppression narrows by `_pass` + `affectedFiles`). An entry with
 *     curated stand-ins joins to nothing, so suppression never engages and
 *     outcome labeling reports `0/N labelled · needs_triage` — reported live,
 *     twice. Here the operator supplies ONLY the judgement
 *     (outcome/state/ruling/why); identity is derived, never typed.
 *
 * Usage:
 *   node scripts/write-ledger-entries.mjs \
 *     --result .audit/$SID-r1-result.json \
 *     --ledger .audit/$SID-ledger.json \
 *     --triage .claude/tmp/triage-r1.json
 *
 * The triage file is JSON keyed by the round's finding ids — write it with an
 * editor, not a shell string (rationales contain apostrophes):
 *
 *   {
 *     "H1": { "outcome": "accepted",  "state": "planned", "ruling": "sustain",
 *             "why": "valid — the plan's fix is scheduled" },
 *     "M3": { "outcome": "dismissed", "state": "pending", "ruling": "overrule",
 *             "why": "300-line file, 2 consumers, acceptable" }
 *   }
 *
 * Mark fixes after Step 4 with the same tool:
 *   node scripts/write-ledger-entries.mjs --ledger <l> --mark-fixed <topicId> [<topicId> …]
 *
 * @module scripts/write-ledger-entries
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import { writeLedgerEntry, generateTopicId, populateFindingMetadata } from './lib/ledger.mjs';

const KNOWN_FLAGS = [
  '--result', '--ledger', '--triage', '--pass', '--round', '--mark-fixed',
  '--json', '--selfcheck-relocation',
];

const OUTCOMES = new Set(['accepted', 'dismissed', 'severity_adjusted']);
const STATES = new Set(['pending', 'planned', 'fixed', 'verified', 'regressed']);
const RULINGS = new Set(['sustain', 'overrule', 'compromise', 'defer']);

function valueOf(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

/** Everything after `--mark-fixed` up to the next flag. */
function markFixedIds(argv) {
  const i = argv.indexOf('--mark-fixed');
  if (i === -1) return null;
  const out = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) out.push(argv[j]);
  return out;
}

function readJson(p, label) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(p), 'utf-8'));
  } catch (err) {
    throw new ArgvError(`write-ledger-entries: cannot read ${label} ${p} — ${err.message}`);
  }
}

function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'write-ledger-entries' });
  const argv = process.argv.slice(2);

  const ledgerPath = valueOf(argv, '--ledger');
  if (!ledgerPath) throw new ArgvError('write-ledger-entries: --ledger <path> is required.');

  // ── Post-fix pass: flip remediationState on existing entries ─────────────
  //
  // A read-modify-write, NOT a partial write. `writeLedgerEntry` REPLACES the
  // entry at a topicId (it does not merge) and validates against the full
  // LedgerEntrySchema, so the recipe this replaced — writing bare
  // `{topicId, remediationState:'fixed'}` — failed validation and returned
  // without writing anything. It printed one stderr line and exited 0, so
  // "mark the fixed items" silently did nothing and every entry stayed
  // `pending`. Verified against the schema 2026-08-08.
  const fixedIds = markFixedIds(argv);
  if (fixedIds) {
    if (fixedIds.length === 0) {
      throw new ArgvError('write-ledger-entries: --mark-fixed needs at least one topicId.');
    }
    const ledger = readJson(ledgerPath, 'ledger');
    const byTopic = new Map((ledger.entries ?? []).map(e => [e.topicId, e]));
    const missing = fixedIds.filter(id => !byTopic.has(id));
    if (missing.length > 0) {
      throw new ArgvError(
        `write-ledger-entries: ${missing.length} topicId(s) are not in ${ledgerPath}: ${missing.join(', ')}. `
        + 'Mark only entries that exist — a typo would otherwise leave the real one pending.',
      );
    }
    for (const topicId of fixedIds) {
      writeLedgerEntry(ledgerPath, { ...byTopic.get(topicId), remediationState: 'fixed' });
    }
    console.log(`marked ${fixedIds.length} entr(ies) fixed → ${ledgerPath}`);
    return;
  }

  // ── Triage pass: write entries derived from the round's findings ─────────
  const resultPath = valueOf(argv, '--result');
  const triagePath = valueOf(argv, '--triage');
  if (!resultPath || !triagePath) {
    throw new ArgvError(
      'write-ledger-entries: --result <round-result.json> and --triage <triage.json> are both '
      + 'required (or use --mark-fixed <topicId>… to flip remediation state).',
    );
  }

  const result = readJson(resultPath, 'result');
  const triage = readJson(triagePath, 'triage');
  const findings = Array.isArray(result.findings) ? result.findings : [];
  if (findings.length === 0) {
    throw new ArgvError(`write-ledger-entries: ${resultPath} has no findings[] to adjudicate.`);
  }

  // A PLAN audit's findings carry no `_pass`; a CODE audit's carry the audit
  // pass name ('Structure', 'Wiring', …). Passing a bare undefined produces a
  // topicId that joins to nothing — the invisible-entry failure above.
  const passDefault = valueOf(argv, '--pass') || 'plan';
  const round = Number(valueOf(argv, '--round') ?? result.round ?? 1);

  const byId = new Map(findings.map(f => [f.id, f]));
  const unknown = Object.keys(triage).filter(id => !byId.has(id));
  if (unknown.length > 0) {
    // A typo'd id would otherwise be silently skipped, leaving a finding
    // un-adjudicated while the operator believes they ruled on it.
    throw new ArgvError(
      `write-ledger-entries: triage names ${unknown.length} finding id(s) not in ${resultPath}: `
      + `${unknown.join(', ')}. Ids must match the round's own findings.`,
    );
  }

  const written = [];
  for (const [id, t] of Object.entries(triage)) {
    for (const [field, allowed] of [['outcome', OUTCOMES], ['state', STATES], ['ruling', RULINGS]]) {
      if (!allowed.has(t?.[field])) {
        throw new ArgvError(
          `write-ledger-entries: ${id}.${field} must be one of ${[...allowed].join('|')}, got ${JSON.stringify(t?.[field])}`,
        );
      }
    }
    if (typeof t.why !== 'string' || t.why.trim() === '') {
      throw new ArgvError(`write-ledger-entries: ${id}.why (the ruling rationale) is required.`);
    }
    const f = byId.get(id);
    populateFindingMetadata(f, f._pass || passDefault);   // idempotent; ensures _hash/_primaryFile
    writeLedgerEntry(ledgerPath, {
      topicId: generateTopicId(f),                 // from the REAL finding — never a stand-in
      latestFindingId: f.id,                       // second join key for outcome labeling
      semanticHash: f._hash,
      adjudicationOutcome: t.outcome,
      remediationState: t.state,
      severity: f.severity,
      originalSeverity: f.severity,
      category: f.category,
      section: f.section,
      detailSnapshot: (f.detail || '').slice(0, 400),
      affectedFiles: f.affectedFiles,
      affectedPrinciples: f.principle ? [f.principle] : [],
      ruling: t.ruling,
      rulingRationale: t.why,                      // rationale is YOURS; identity is the finding's
      resolvedRound: round,
      pass: f._pass,                               // matches the populateFindingMetadata arg above
    });
    written.push(id);
  }

  const unruled = findings.filter(f => !Object.hasOwn(triage, f.id)).map(f => f.id);

  // The round's acceptance rate — the PRIMARY convergence signal for a plan
  // audit (see the /audit-plan convergence table). A round whose findings the
  // author accepts wholesale is by definition not rigor pressure, whatever the
  // HIGH count did; a round mostly dismissed or deferred is. Computed here
  // because this is where the judgements are, and a counted number beats a
  // remembered one.
  const ruled = Object.values(triage);
  const accepted = ruled.filter(t => t.outcome === 'accepted' && t.ruling !== 'defer').length;
  const adjusted = ruled.filter(t => t.outcome === 'severity_adjusted').length;
  const deferred = ruled.filter(t => t.ruling === 'defer').length;
  const dismissed = ruled.filter(t => t.outcome === 'dismissed' && t.ruling !== 'defer').length;
  const acceptanceRate = ruled.length > 0 ? (accepted + adjusted) / ruled.length : 0;

  if (argv.includes('--json')) {
    console.log(JSON.stringify({
      ok: true, ledger: ledgerPath, round, written, unruled,
      accepted, adjusted, dismissed, deferred, acceptanceRate,
    }));
  } else {
    console.log(`ledger → ${ledgerPath} · round ${round} · ${written.length}/${findings.length} findings ruled`);
    console.log(
      `acceptance ${(acceptanceRate * 100).toFixed(0)}% `
      + `(accepted ${accepted} · severity-adjusted ${adjusted} · dismissed ${dismissed} · deferred ${deferred})`,
    );
  }
  if (unruled.length > 0) {
    // Every finding needs a ruling before Step 4; an un-ruled one stays
    // `pending` and later reports as `needs_triage` rather than a labelled
    // outcome — the silent half of the 0/N labelled report.
    process.stderr.write(
      `  [ledger] WARN: ${unruled.length} finding(s) have no triage entry and stay pending: ${unruled.join(', ')}\n`,
    );
  }
}

try {
  main();
} catch (err) {
  if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') {
    console.error(err.message);
    process.exit(2);
  }
  console.error(err.message);
  process.exit(1);
}

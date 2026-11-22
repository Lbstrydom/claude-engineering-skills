/**
 * @fileoverview Human rendering of `setup-postgres.mjs --check-drift`, extracted so setup-postgres.mjs (over the file-size
 * ratchet) does not grow when a new drift class is added. Pure: takes the result and a writable.
 * @module scripts/lib/drift-report
 */
import { renderOwnershipDrift } from './migration-ownership.mjs';

const G = '[32m', R = '[31m', Y = '[33m', X = '[0m';

export function renderHumanDriftReport({ drift, applied, sourceTotal, hasDrift }, stderr = process.stderr) {
  stderr.write(`\n${G}── Migration drift check ──${X}\n`);
  stderr.write(`  ledger: ${applied} applied / ${sourceTotal} source files\n`);
  if (!hasDrift) {
    stderr.write(`  ${G}✓${X} no drift\n`);
    return;
  }
  if (drift.unapplied.length) {
    stderr.write(`\n  ${Y}unapplied${X} (${drift.unapplied.length}) — run \`node scripts/setup-postgres.mjs --migrate\`:\n`);
    for (const f of drift.unapplied) stderr.write(`    + ${f}\n`);
  }
  if (drift.eolLegacy?.length) {
    stderr.write(`\n  ${Y}eol-legacy${X} (${drift.eolLegacy.length}) — same content, pre-canonicalization CRLF hash; repair with \`node scripts/setup-postgres.mjs --repair-eol\`:\n`);
    for (const m of drift.eolLegacy) {
      stderr.write(`    ~ ${m.filename}\n      ledger: ${m.ledgerSha.slice(0, 12)}… (CRLF)  canonical: ${m.sourceSha.slice(0, 12)}…\n`);
    }
  }
  if (drift.shaMismatch.length) {
    stderr.write(`\n  ${R}sha-mismatch${X} (${drift.shaMismatch.length}) — committed migration edited after apply:\n`);
    for (const m of drift.shaMismatch) {
      stderr.write(`    ! ${m.filename}\n      ledger: ${m.ledgerSha.slice(0, 12)}…  source: ${m.sourceSha.slice(0, 12)}…\n`);
    }
  }
  renderOwnershipDrift(drift, stderr);
  if (drift.orphanLedger.length) {
    stderr.write(`\n  ${Y}orphan-ledger${X} (${drift.orphanLedger.length}) — applied but no source file (deleted?):\n`);
    for (const f of drift.orphanLedger) stderr.write(`    ? ${f}\n`);
  }
}

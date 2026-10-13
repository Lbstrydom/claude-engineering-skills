#!/usr/bin/env node
/**
 * @fileoverview Archive whole months of `status.md` into `docs/status/`.
 *
 * **Why.** The session log is 1.57 MB across 408 entries and six months, sits
 * at the repo root, and is the single most-churned path here — 401 of the last
 * 90 days' commits touched it. It is also at ~75% of the 2 MiB document ceiling
 * `scripts/lib/doc-citations.mjs` applies.
 *
 * **Why this is dangerous, and what makes it safe.** PR #87 destroyed 19,257
 * lines of this exact file. So: this tool moves nothing until it has proved,
 * byte for byte, that the pieces reassemble into the original; it records every
 * archived entry's digest in a committed manifest; and
 * `scripts/check-status-log-integrity.mjs` re-verifies conservation on every
 * push, against the whole push range, failing closed when it cannot.
 *
 * **Grammar, stated so nothing is implicit over 408 entries:**
 *   - An entry is `^## YYYY-MM-DD` through the byte before the next `## `.
 *   - Its month is those characters VERBATIM — no Date parsing, no timezone,
 *     so the result is reproducible anywhere.
 *   - An undated or malformed heading is NEVER rotated. It stays at the root.
 *     Rotation is opt-in by conformance; the failure direction is "stays put".
 *   - Duplicate headings are fine; identity is the full-span digest.
 *   - A month rotates whole or not at all, so no entry straddles a boundary.
 *   - The newest month present is always retained.
 *
 * Exit codes: 0 done (or nothing to do) · 1 refused (conservation check failed).
 *
 * Usage:
 *   node scripts/rotate-status-log.mjs --dry-run    # default
 *   node scripts/rotate-status-log.mjs --apply
 *
 * Plan: docs/plans/backlog-and-drift-reduction.md §2 A9, Phase 13.
 *
 * @module scripts/rotate-status-log
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertKnownFlags, ArgvError, argOption } from './lib/cli-io.mjs';
import { splitEntries, monthOf, canonicalize } from './lib/status-log-integrity.mjs';
import { atomicWriteFileSync } from './lib/file-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_LOG = path.join(REPO, 'status.md');

/**
 * The write phase, after the conservation proof has passed: the archives, then
 * the manifest, then the truncated root log — in that order, so every copy
 * exists before the original shrinks.
 *
 * **Each write is atomic (temp file + rename), and the ORDER is the
 * transaction.** Three files cannot be replaced as one unit on a filesystem,
 * but they do not need to be: with per-file atomicity a failure at any step
 * leaves every file either old or complete-new, and because the root log is
 * written LAST, every state a crash can produce still holds each entry whole in
 * at least one file. A plain `writeFileSync` truncates then writes, so a crash
 * during the root-log write tore `status.md` — the one write that removes
 * content. Re-running after a partial apply is safe: an archive whose content
 * already matches is not a collision.
 *
 * @param {{repo: string, archives: Array<{month: string, path: string, body: string}>, rootBody: string}} args
 * @returns {{ok: true} | {ok: false, collisions: string[]}}
 */
export function applyRotation({ repo, archives, rootBody }) {
  const archiveDir = path.join(repo, 'docs', 'status');
  const manifestPath = path.join(archiveDir, 'rotation-manifest.json');
  fs.mkdirSync(archiveDir, { recursive: true });

  // REFUSE to clobber an existing archive whose content differs.
  //
  // A backdated or late entry for an already-archived month makes this run
  // produce a DIFFERENT body for that month; writing it unconditionally would
  // replace the archive and silently drop what the old one held. The integrity
  // gate would catch it at the next push, but the content is gone from the
  // working tree by then — refusing here is the cheaper failure.
  const collisions = [];
  for (const a of archives) {
    const abs = path.join(repo, a.path);
    if (!fs.existsSync(abs)) continue;
    if (canonicalize(fs.readFileSync(abs, 'utf-8')) !== a.body) collisions.push(a.path);
  }
  if (collisions.length > 0) return { ok: false, collisions };

  for (const a of archives) {
    // No trailing newline beyond what the entries carry. Adding one changes the
    // LAST entry's span when the file is read back — a one-byte difference that
    // makes every archive fail its own manifest. Caught by the integrity guard
    // on the first real rotation, which is exactly what it is for.
    atomicWriteFileSync(path.join(repo, a.path), a.body);
  }

  const existing = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) : { archives: {} };
  for (const a of archives) {
    // Derive the recorded digests FROM THE WRITTEN FILE, re-read and re-split
    // exactly as the guard will read it. The manifest must describe the artifact
    // on disk, not an in-memory value that is merely believed to equal it.
    const written = fs.readFileSync(path.join(repo, a.path), 'utf-8');
    const readBack = splitEntries(written).entries;
    existing.archives[a.month] = {
      path: a.path,
      entries: readBack.length,
      bytes: written.length,
      entryDigests: readBack.map((e) => e.digest),
    };
  }
  existing._description = 'Committed evidence for status.md rotation. Every archived entry\'s '
    + 'full-span digest, so scripts/check-status-log-integrity.mjs can prove no history was lost '
    + 'without a runtime authorization flag. Append-only: it may grow, never shrink.';
  atomicWriteFileSync(manifestPath, `${JSON.stringify(existing, null, 2)}\n`);

  // Same reasoning as the archives: reproduce the original's own byte shape.
  atomicWriteFileSync(path.join(repo, 'status.md'), rootBody);
  return { ok: true };
}

function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  try {
    assertKnownFlags(process.argv, ['--apply', '--dry-run', '--keep-months', '--help', '-h', '--selfcheck-relocation'], { cli: 'rotate-status-log' });
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    throw err;
  }
  // `--dry-run` WINS. It was allowlisted but never consulted, so
  // `--dry-run --apply` performed the real archive-and-truncate despite an
  // explicit request not to. On a tool that rewrites the session log, an
  // ignored dry-run is the worst possible flag bug: refuse the contradiction
  // outright rather than picking a winner the operator did not choose.
  if (process.argv.includes('--dry-run') && process.argv.includes('--apply')) {
    process.stderr.write('rotate-status-log: --dry-run and --apply are contradictory. Writing nothing.\n');
    process.exit(2);
  }
  const apply = process.argv.includes('--apply');
  // `argOption` handles the `--name=value` form; a bare indexOf does not, so
  // `--keep-months=3` returned -1 and SILENTLY fell back to 1 — archiving the
  // months the operator explicitly asked to keep. On a destructive tool a
  // silently-ignored argument is worse than a rejected one.
  const ki = process.argv.findIndex((a) => a === '--keep-months' || a.startsWith('--keep-months='));
  let keepMonths = 1;
  if (ki !== -1) {
    // `Number('nope')` is NaN, `Math.max(1, NaN)` is NaN, and `slice(0, NaN)`
    // behaves as `slice(0, 0)` — an EMPTY keep set, so a typo would archive
    // every month INCLUDING the current one. Confirmed live before this fix.
    const raw = argOption('keep-months', undefined);
    keepMonths = Number(raw);
    if (!Number.isInteger(keepMonths) || keepMonths < 1) {
      process.stderr.write(`rotate-status-log: --keep-months must be an integer >= 1 (got ${JSON.stringify(raw)}). Writing nothing.\n`);
      process.exit(2);
    }
  }

  const original = canonicalize(fs.readFileSync(ROOT_LOG, 'utf-8'));
  const { preamble, entries } = splitEntries(original);

  if (entries.length === 0) {
    process.stderr.write('rotate-status-log: refused — no `## ` entries parsed. Writing nothing.\n');
    process.exit(1);
  }
  const dated = entries.filter((e) => e.date);
  if (dated.length === 0) {
    process.stderr.write('rotate-status-log: refused — no DATED entries parsed. Writing nothing.\n');
    process.exit(1);
  }

  const months = [...new Set(dated.map(monthOf))].sort().reverse(); // newest first
  const keep = new Set(months.slice(0, keepMonths));
  const toArchive = months.filter((m) => !keep.has(m));

  if (toArchive.length === 0) {
    process.stdout.write(`rotate-status-log: nothing to archive — only ${months.join(', ')} present.\n`);
    process.exit(0);
  }

  // Partition IN ORDER. An undated entry, or one in a retained month, stays.
  const retained = [];
  const byMonth = new Map(toArchive.map((m) => [m, []]));
  for (const e of entries) {
    const m = e.date ? monthOf(e) : null;
    if (m && byMonth.has(m)) byMonth.get(m).push(e);
    else retained.push(e);
  }

  // ── Conservation proof, BEFORE anything is written ────────────────────────
  // Reassemble in the file's own newest-first order: retained root body first,
  // then the archives newest-month-first. Byte-identical or we write nothing.
  const retainedBody = retained.map((e) => e.body).join('\n');
  const archiveBodies = toArchive.map((m) => byMonth.get(m).map((e) => e.body).join('\n'));
  const reassembled = [preamble, retainedBody, ...archiveBodies].filter((s) => s !== '').join('\n');

  if (reassembled !== original) {
    process.stderr.write(
      'rotate-status-log: REFUSED — the pieces do not reassemble into the original byte-for-byte.\n'
      + `  original ${original.length} bytes, reassembled ${reassembled.length}. Nothing written.\n`,
    );
    process.exit(1);
  }

  const plan = toArchive.map((m) => ({
    month: m,
    path: `docs/status/${m}.md`,
    entries: byMonth.get(m).length,
    bytes: byMonth.get(m).map((e) => e.body).join('\n').length,
    entryDigests: byMonth.get(m).map((e) => e.digest),
  }));

  process.stdout.write(`rotate-status-log: ${entries.length} entries, ${months.length} month(s)\n`);
  process.stdout.write(`  retained at root: ${[...keep].join(', ')} (${retained.length} entries)\n`);
  for (const p of plan) process.stdout.write(`  archive ${p.path}: ${p.entries} entries, ${p.bytes} bytes\n`);
  process.stdout.write('  conservation: reassembly is byte-identical to the original ✓\n');

  if (!apply) {
    process.stdout.write('\n  DRY RUN — nothing written. Re-run with --apply.\n');
    process.exit(0);
  }

  const applied = applyRotation({
    repo: REPO,
    archives: plan.map((p) => ({ month: p.month, path: p.path, body: byMonth.get(p.month).map((e) => e.body).join('\n') })),
    rootBody: [preamble, retainedBody].filter((s) => s !== '').join('\n'),
  });
  if (!applied.ok) {
    process.stderr.write(
      'rotate-status-log: REFUSED — these archives already exist with different content:\n'
      + applied.collisions.map((c) => `  ${c}\n`).join('')
      + '  A month is archived once. A late entry for an archived month means the root\n'
      + '  log and the archive disagree — resolve that by hand, never by overwrite.\n',
    );
    process.exit(1);
  }

  process.stdout.write(`\n  Wrote ${plan.length} archive(s) + the manifest; root log is now ${retained.length} entries.\n`);
  process.stdout.write('  Verify: npm run status:integrity:gate\n');
  process.exit(0);
}

if (isInvokedAsScript(import.meta.url)) main();

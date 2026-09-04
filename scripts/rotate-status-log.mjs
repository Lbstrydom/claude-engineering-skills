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
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import { splitEntries, monthOf, canonicalize } from './lib/status-log-integrity.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_LOG = path.join(REPO, 'status.md');
const ARCHIVE_DIR = path.join(REPO, 'docs', 'status');
const MANIFEST = path.join(ARCHIVE_DIR, 'rotation-manifest.json');

function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  try {
    assertKnownFlags(process.argv, ['--apply', '--dry-run', '--keep-months', '--help', '-h', '--selfcheck-relocation'], { cli: 'rotate-status-log' });
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    throw err;
  }
  const apply = process.argv.includes('--apply');
  const ki = process.argv.indexOf('--keep-months');
  const keepMonths = ki !== -1 && process.argv[ki + 1] ? Number(process.argv[ki + 1]) : 1;

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
  const keep = new Set(months.slice(0, Math.max(1, keepMonths)));
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

  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  for (const p of plan) {
    const body = byMonth.get(p.month).map((e) => e.body).join('\n');
    // No trailing newline beyond what the entries carry. Adding one changes the
    // LAST entry's span when the file is read back — a one-byte difference that
    // makes every archive fail its own manifest. Caught by the integrity guard
    // on the first real rotation, which is exactly what it is for.
    fs.writeFileSync(path.join(REPO, p.path), body, 'utf-8');
  }

  const existing = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf-8')) : { archives: {} };
  for (const p of plan) {
    // Derive the recorded digests FROM THE WRITTEN FILE, re-read and re-split
    // exactly as the guard will read it. The manifest must describe the artifact
    // on disk, not an in-memory value that is merely believed to equal it.
    const written = fs.readFileSync(path.join(REPO, p.path), 'utf-8');
    const readBack = splitEntries(written).entries;
    existing.archives[p.month] = {
      path: p.path,
      entries: readBack.length,
      bytes: written.length,
      entryDigests: readBack.map((e) => e.digest),
    };
  }
  existing._description = 'Committed evidence for status.md rotation. Every archived entry\'s '
    + 'full-span digest, so scripts/check-status-log-integrity.mjs can prove no history was lost '
    + 'without a runtime authorization flag. Append-only: it may grow, never shrink.';
  fs.writeFileSync(MANIFEST, `${JSON.stringify(existing, null, 2)}\n`, 'utf-8');

  // Same reasoning as the archives: reproduce the original's own byte shape.
  fs.writeFileSync(ROOT_LOG, [preamble, retainedBody].filter((s) => s !== '').join('\n'), 'utf-8');

  process.stdout.write(`\n  Wrote ${plan.length} archive(s) + the manifest; root log is now ${retained.length} entries.\n`);
  process.stdout.write('  Verify: npm run status:integrity:gate\n');
  process.exit(0);
}

if (process.argv[1]?.endsWith('rotate-status-log.mjs')) main();

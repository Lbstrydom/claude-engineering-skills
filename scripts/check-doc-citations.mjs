#!/usr/bin/env node
/**
 * @fileoverview Re-resolve every pinned `path:line (sha)` citation in a
 * document and report which ones have decayed.
 *
 * REPORT-ONLY, and deliberately NOT wired into `npm run check`. No current
 * requirement gates it, and a repo-wide line-drift gate over a corpus that is
 * mostly unpinned would be pure noise — noisy gates get bypassed, which is how
 * the stale refs in `check-docs-refs.mjs`'s own baseline accumulated. Verdicts
 * therefore do not fail the run; a SCANNER failure does.
 *
 * Writes NOTHING. There is no `--out` on purpose: the repo's `--out` convention
 * exists for large LLM result artifacts, this report is small, and `--format
 * json` with a shell redirect covers it. Keeping "writes nothing" true is worth
 * more than the flag.
 *
 * Usage:
 *   node scripts/check-doc-citations.mjs <doc> [<doc>...]
 *   node scripts/check-doc-citations.mjs <doc> --format json
 *   node scripts/check-doc-citations.mjs <doc> --require-citations
 *   node scripts/check-doc-citations.mjs <doc> --repo-root <dir>
 *
 * Exit codes:
 *   0  scan completed (verdicts do not fail — report-only)
 *   1  scanner failure, OR --require-citations and nothing was parsed
 *   2  bad CLI input
 *
 * Contract: `docs/audit/shared-references/verification-discipline.md` §1.
 *
 * @module scripts/check-doc-citations
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import { scanDocuments } from './lib/doc-citations.mjs';

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', X = '\x1b[0m', B = '\x1b[1m', D = '\x1b[2m';

const KNOWN_FLAGS = ['--format', '--require-citations', '--repo-root', '--selfcheck-relocation'];

const VERDICT_COLOUR = { ok: G, moved: Y, drifted: R, unresolvable: R };

function main() {
  // Relocation smoke: proves this file's imports survive being synced into a
  // consumer's `scripts/.claude-skills/`. Answered before anything else.
  if (process.argv.includes('--selfcheck-relocation')) {
    console.log('OK');
    process.exit(0);
  }

  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'check-doc-citations' });

  const argv = process.argv.slice(2);
  const flagValue = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1];
  };
  const asJson = flagValue('--format') === 'json';
  const requireCitations = argv.includes('--require-citations');
  const repoRoot = path.resolve(flagValue('--repo-root') ?? process.cwd());

  const docs = argv.filter((a, i) => {
    if (a.startsWith('--')) return false;
    return argv[i - 1] !== '--format' && argv[i - 1] !== '--repo-root';
  });

  if (docs.length === 0) {
    process.stderr.write(`${R}no documents given${X}\n`);
    process.stderr.write('usage: node scripts/check-doc-citations.mjs <doc> [<doc>...]\n');
    process.exit(2);
  }
  for (const d of docs) {
    if (!fs.existsSync(d)) {
      process.stderr.write(`${R}no such document: ${d}${X}\n`);
      process.exit(2);
    }
  }

  let result;
  try {
    result = scanDocuments(docs, { repoRoot });
  } catch (err) {
    // A scanner failure is a FAILURE, never a quiet clean report.
    process.stderr.write(`${R}check-doc-citations: scan failed — ${err.message}${X}\n`);
    process.exit(1);
  }

  const { summary, findings } = result;

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ summary, findings }, null, 2)}\n`);
  } else {
    for (const f of findings) {
      const c = VERDICT_COLOUR[f.verdict] ?? R;
      const where = f.docLine ? `:${f.docLine}` : '';
      const detail = f.verdict === 'moved'
        ? `now at line ${f.movedTo}`
        : (f.reason ?? '');
      process.stdout.write(
        `  ${c}${f.verdict.toUpperCase()}${X} ${f.document}${where}  ${D}${f.ref ?? ''} ${detail}${X}\n`,
      );
    }
    process.stdout.write(
      `\n${B}check-doc-citations:${X} ${summary.documentsScanned} doc(s), `
      + `${summary.citationsParsed} pinned (${summary.citationsUnpinned} unpinned) — `
      + `${summary.ok} ok, ${summary.moved} moved, ${summary.drifted} drifted, `
      + `${summary.unresolvable} unresolvable\n`,
    );
    process.stdout.write(`${D}report-only — verdicts do not fail the run.${X}\n`);
  }

  // "Parsed nothing" must not read as clean. This is the flag that makes the
  // adoption check non-vacuous.
  if (requireCitations && summary.citationsParsed === 0) {
    process.stderr.write(
      `${R}--require-citations: 0 pinned citations parsed across ${summary.documentsScanned} `
      + `document(s). A clean report over zero citations is not a pass.${X}\n`,
    );
    process.exit(1);
  }
  process.exit(0);
}

try {
  main();
} catch (err) {
  if (err instanceof ArgvError) {
    process.stderr.write(`${R}${err.message}${X}\n`);
    process.exit(2);
  }
  throw err;
}

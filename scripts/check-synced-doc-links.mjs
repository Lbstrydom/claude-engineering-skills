#!/usr/bin/env node
/**
 * @fileoverview Gate: every relative markdown link in SYNCED content must still
 * resolve once the sync has put the file where a consumer reads it.
 *
 * **The defect.** A relative href is resolved against the directory its file
 * sits in, and the sync moves files between directories at different depths.
 * `skills/<skill>/references/x.md` becomes `.claude/skills/<skill>/references/x.md`
 * — one level deeper — so a `../../../docs/…` written to reach the repo root
 * from the first lands in `.claude/` from the second. Dead in the generated copy
 * AND in every consumer, while resolving perfectly from the file the author had
 * open. Measured 2026-09-04: 47 such links across the bundle.
 *
 * A second shape is structural rather than arithmetic: the closure ships exactly
 * ONE `docs/` file (`docs/reference/consistency-contract.md`), so a link from it
 * into `docs/plans/` cannot resolve in a consumer at any depth. That instance was
 * reported by wine-cellar-app (upstream 15da01b6) and cost them a permanent
 * `.sync-overrides.json` entry — they hand-rewrote the line, which marked the
 * whole document diverged and froze it off every future upstream change to hold
 * one corrected link.
 *
 * **Why the two existing gates could not see either.** `check-docs-refs.mjs` and
 * `check-skill-consumer-refs.mjs` both extract literal `docs/…md` TOKENS. A link
 * whose TEXT says `docs/plans/<name>.md` and whose HREF says `../completed/x.md` reads
 * as healthy to both — the href is the half nothing was reading, which is exactly
 * how the reported instance survived.
 *
 * **No baseline, deliberately.** This ships at zero: the generator now emits an
 * absolute upstream URL for any target leaving `skills/`, and the twelve
 * hand-authored sites were rewritten the same way. A ratchet is the right shape
 * when a population cannot be driven to zero (`knip:gate`, `emit:exit:gate`,
 * `skills:consumer-refs:gate`); here it can, so a plain gate is honest and the
 * remedy is unambiguous — make the link absolute, or move the target into the
 * closure.
 *
 * Usage:
 *   node scripts/check-synced-doc-links.mjs           # gate; exit 1 on any finding
 *   node scripts/check-synced-doc-links.mjs --json    # machine-readable report
 *
 * Exit codes:
 *   0  every relative link in synced markdown resolves at its consumer path
 *   1  at least one does not, or the scan could not be performed
 *   2  usage error
 *
 * @module scripts/check-synced-doc-links
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertKnownFlags, ArgvError, finishAndExit } from './lib/cli-io.mjs';
import { getSyncClosure } from './lib/sync-inventory.mjs';
import { sourceRelToDestRel } from './lib/sync-path-map.mjs';
import { findUnfollowableLinks, upstreamUrlFor } from './lib/synced-doc-links.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const G = '\x1b[32m', R = '\x1b[31m', X = '\x1b[0m', B = '\x1b[1m', D = '\x1b[2m';

const KNOWN_FLAGS = ['--json', '--selfcheck-relocation', '--help'];

/** Stable diagnostic code — a poison pill matches this, not the exit status. */
export const FAILURE_CODE = 'sdl/unfollowable-relative-link';

/**
 * Scan the whole closure.
 *
 * **Fails closed.** An empty or unreadable closure is reported as a scan
 * failure, never as "no findings": a gate that can pass having read nothing is
 * the class this repo keeps closing (AGENTS.md §sandbox-honesty).
 *
 * @param {string} rootDir
 * @param {{closure?: {files: Iterable<string>}}} [io] injected for tests
 * @returns {Promise<{ok: boolean, scanned: number, findings: object[], error: string|null}>}
 */
export async function scanClosure(rootDir, io = {}) {
  let closure;
  try {
    closure = io.closure ?? await getSyncClosure();
  } catch (err) {
    return { ok: false, scanned: 0, findings: [], error: `sync closure unreadable: ${err.message}` };
  }
  const files = [...(closure?.files ?? [])];
  if (files.length === 0) {
    return { ok: false, scanned: 0, findings: [], error: 'sync closure is empty — refusing to report a clean scan' };
  }
  const destPaths = new Set(files.map((p) => sourceRelToDestRel(p)));
  const markdown = files.filter((p) => p.endsWith('.md'));
  if (markdown.length === 0) {
    return { ok: false, scanned: 0, findings: [], error: 'sync closure contains no markdown — refusing to report a clean scan' };
  }

  const findings = [];
  for (const sourceRel of markdown) {
    let text;
    try {
      text = fs.readFileSync(path.join(rootDir, sourceRel), 'utf-8');
    } catch (err) {
      return { ok: false, scanned: 0, findings: [], error: `cannot read ${sourceRel}: ${err.message}` };
    }
    findings.push(...findUnfollowableLinks({
      sourceRel,
      destRel: sourceRelToDestRel(sourceRel),
      text,
      destPaths,
    }));
  }
  return { ok: findings.length === 0, scanned: markdown.length, findings, error: null };
}

/**
 * The remedy line for one finding — the absolute URL it should carry, when the
 * target exists here. A target that exists nowhere is a plain dead link and says so.
 *
 * @param {{sourceRel: string, href: string}} finding
 * @param {string} rootDir
 * @returns {string}
 */
export function remedyFor(finding, rootDir) {
  const bare = finding.href.split('#')[0];
  const anchor = finding.href.includes('#') ? `#${finding.href.split('#')[1]}` : '';
  const abs = path.resolve(rootDir, path.dirname(finding.sourceRel), bare);
  const repoRel = path.relative(rootDir, abs).split(path.sep).join('/');
  if (!fs.existsSync(abs)) return `target does not exist in this repo either — fix or drop the link`;
  return `use ${upstreamUrlFor(repoRel)}${anchor}`;
}

async function main() {
  // Every stdout-then-exit path drains first. On Windows a PIPED stdout is
  // async, so a bare process.exit() drops whatever has not flushed and the
  // caller reads a truncated envelope as a parse error somewhere else. main()
  // is async, so the await is available here (stdout:flush:gate).
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); await finishAndExit(0); return; }
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'check-synced-doc-links' });
  const asJson = process.argv.includes('--json');

  const result = await scanClosure(ROOT);

  if (asJson) {
    console.log(JSON.stringify({
      ok: result.ok,
      scanned: result.scanned,
      error: result.error,
      findings: result.findings.map((f) => ({ ...f, remedy: remedyFor(f, ROOT) })),
    }, null, 2));
    await finishAndExit(result.ok ? 0 : 1);
    return;
  }

  if (result.error) {
    process.stderr.write(`${R}${FAILURE_CODE} scan failed: ${result.error}${X}\n`);
    process.exit(1);
  }

  if (result.ok) {
    process.stdout.write(
      `${G}✓${X} ${B}synced-doc-links:${X} ${result.scanned} synced markdown file(s), `
      + `every relative link resolves at its consumer path\n`,
    );
    await finishAndExit(0);
    return;
  }

  for (const f of result.findings) {
    process.stderr.write(`${FAILURE_CODE} ${f.sourceRel}:${f.line} ${f.href} → ${f.resolved}\n`);
    process.stderr.write(`  ${D}${remedyFor(f, ROOT)}${X}\n`);
  }
  process.stderr.write(
    `\n${R}A relative link in synced content does not resolve where a consumer reads it.${X}\n`
    + `${D}The sync ships ${result.scanned} markdown file(s) and exactly one docs/ path, so a\n`
    + `relative href that leaves the file's own subtree usually cannot resolve there at any\n`
    + `depth. Make it an absolute upstream URL — the one spelling correct in both repos.${X}\n`,
  );
  process.exit(1);
}

const invokedDirectly = (() => {
  try {
    const metaPath = new URL(import.meta.url).pathname.toLowerCase();
    const argvPath = process.argv[1]
      ? new URL(`file://${process.argv[1].replaceAll(/\\/g, '/')}`).pathname.toLowerCase()
      : '';
    return metaPath.endsWith('/check-synced-doc-links.mjs')
      && argvPath.endsWith('/check-synced-doc-links.mjs');
  } catch { return false; }
})();

if (invokedDirectly) {
  main().catch((err) => {
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  });
}

#!/usr/bin/env node
/**
 * @fileoverview Enumerate `npm run X` references from synced skill content.
 *
 * Pure function + CLI wrapper.  Plan §7 (R1 M4 + R2 H4 fix).
 *
 * When invoked as a CLI (`node scripts/lib/npm-script-enumerator.mjs
 * --consumer-root <path>`), reads the consumer's `scripts/.sync-manifest.json`
 * and emits a JSON `{refs: string[]}` listing every `npm run X` reference
 * found in the synced .md files.  Exit 0 on success, 2 on missing manifest.
 *
 * @module scripts/lib/npm-script-enumerator
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LAYOUT_CONSTANTS } from './sync-path-map.mjs';

// Allowed chars in an npm script name. The name must START and END with
// an alphanumeric (or `_/@`); middle chars may include `:`, `.`, `-`.
// This shape prevents trailing prose punctuation like `Run npm run audit.`
// from being captured as `audit.` (R1 M1 fix) while still allowing
// `arch:refresh`, `db.check.drift`, `audit-loop` as legitimate names.
const NPM_RUN_REGEX = /\bnpm\s+run\s+([A-Za-z0-9_@][A-Za-z0-9_:.\-/@]*[A-Za-z0-9_/@]|[A-Za-z0-9_@])/g;

/**
 * Extract every `npm run X` reference from a markdown string, deduplicated.
 *
 * @param {string} content
 * @returns {string[]}
 */
export function enumerateNpmRunRefs(content) {
  if (typeof content !== 'string') return [];
  const out = new Set();
  let m;
  while ((m = NPM_RUN_REGEX.exec(content)) !== null) {
    out.add(m[1]);
  }
  return [...out].sort();
}

function findSyncedMarkdownFiles(consumerRoot) {
  // L2 fix: use the canonical manifest path from LAYOUT_CONSTANTS rather
  // than hardcoding `scripts/.sync-manifest.json` (single source of truth).
  const manifestPath = path.join(consumerRoot, LAYOUT_CONSTANTS.MANIFEST_PATH);
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, error: `manifest not found at ${manifestPath}` };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    return { ok: false, error: `manifest parse failed: ${err.message}` };
  }
  const mdKeys = Object.keys(manifest.files || {}).filter((k) => k.endsWith('.md'));
  return { ok: true, mdKeys, manifest };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selfcheck-relocation')) {
    console.log('OK');
    process.exit(0);
  }

  const consumerRootIdx = argv.indexOf('--consumer-root');
  const consumerRoot = consumerRootIdx !== -1 ? argv[consumerRootIdx + 1] : process.cwd();

  const found = findSyncedMarkdownFiles(consumerRoot);
  if (!found.ok) {
    process.stderr.write(`[npm-script-enumerator] ${found.error}\n`);
    process.exit(2);
  }

  // M3 fix: fail-closed on missing/unreadable manifest-declared markdown.
  // The manifest is authoritative — a missing entry signals corruption,
  // not "optional file". Aggregate errors and report; exit non-zero so
  // the caller (the verifier) treats it as a contract violation.
  const allRefs = new Set();
  const failures = [];
  for (const k of found.mdKeys) {
    const abs = path.join(consumerRoot, k);
    if (!fs.existsSync(abs)) { failures.push({ path: k, reason: 'missing' }); continue; }
    try {
      const content = fs.readFileSync(abs, 'utf-8');
      for (const r of enumerateNpmRunRefs(content)) allRefs.add(r);
    } catch (err) {
      failures.push({ path: k, reason: `unreadable: ${err.code || err.message}` });
    }
  }
  process.stdout.write(JSON.stringify({
    refs: [...allRefs].sort(),
    failures,
  }, null, 2) + '\n');
  process.exit(failures.length ? 2 : 0);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) main();

export const _internals = { NPM_RUN_REGEX, findSyncedMarkdownFiles };

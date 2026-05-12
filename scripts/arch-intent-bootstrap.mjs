#!/usr/bin/env node
/**
 * @fileoverview Bootstrap a repo for architecture-intent.
 *
 * Behaviour:
 *   1. Copies `docs/architecture-intent.template.md` → `docs/architecture-intent.md`
 *      if the live doc is absent. Never overwrites.
 *   2. With `--baseline-from-graph`: runs the detected stack's adapter and
 *      seeds `allowedDeps` in `.audit-loop/domain-map.json` from the current
 *      import graph. Without the flag: leaves `allowedDeps` field omitted
 *      (loader treats absent/null as SKIPPED_NO_BASELINE).
 *   3. NEVER writes `allowedDeps: {}` — that's "everything forbidden" which
 *      is an operator's explicit choice, not a sensible default.
 *
 * Idempotent. Exit 0 on success or no-op. Non-zero only on fs errors.
 *
 * Usage:
 *   node scripts/arch-intent-bootstrap.mjs                       # template + null allowedDeps
 *   node scripts/arch-intent-bootstrap.mjs --baseline-from-graph # template + baselined allowedDeps
 *
 * @module scripts/arch-intent-bootstrap
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './lib/file-io.mjs';
import { detectRepoStack } from './lib/repo-stack.mjs';
import { loadArchIntentConfig } from './lib/arch-intent/load-config.mjs';
import { inventoryFiles } from './lib/arch-intent/adapter-contract.mjs';
import { VENDOR_DOMAIN } from './lib/arch-intent/domain-resolver.mjs';

const REPO_ROOT = process.cwd();
const TEMPLATE_PATH = path.join(REPO_ROOT, 'docs/architecture-intent.template.md');
const LIVE_DOC_PATH = path.join(REPO_ROOT, 'docs/architecture-intent.md');
const DOMAIN_MAP_PATH = path.join(REPO_ROOT, '.audit-loop/domain-map.json');

function log(msg) { process.stdout.write(`  [arch-intent-bootstrap] ${msg}\n`); }

async function copyTemplate() {
  if (fs.existsSync(LIVE_DOC_PATH)) {
    log(`SKIP: ${path.relative(REPO_ROOT, LIVE_DOC_PATH)} already exists`);
    return false;
  }
  if (!fs.existsSync(TEMPLATE_PATH)) {
    log(`WARN: template not found at ${path.relative(REPO_ROOT, TEMPLATE_PATH)} — skipping doc copy`);
    return false;
  }
  fs.mkdirSync(path.dirname(LIVE_DOC_PATH), { recursive: true });
  fs.copyFileSync(TEMPLATE_PATH, LIVE_DOC_PATH);
  log(`Copied template → ${path.relative(REPO_ROOT, LIVE_DOC_PATH)}`);
  return true;
}

async function generateBaseline() {
  if (!fs.existsSync(DOMAIN_MAP_PATH)) {
    log(`ERROR: ${path.relative(REPO_ROOT, DOMAIN_MAP_PATH)} not found — create it with rules first, then re-run bootstrap`);
    return false;
  }
  const domainMap = loadArchIntentConfig(REPO_ROOT);
  if (domainMap.allowedDeps !== null && Object.keys(domainMap.allowedDeps).length > 0) {
    log(`SKIP: allowedDeps already populated (has ${Object.keys(domainMap.allowedDeps).length} keys)`);
    return false;
  }

  const { stackKinds } = detectRepoStack(REPO_ROOT);
  if (stackKinds.length === 0) {
    log(`ERROR: no detected stack — cannot run baseline. Supported: js-ts, python, java`);
    return false;
  }

  log(`Detecting current import graph via stacks=[${stackKinds.join(', ')}]...`);
  const { mapped } = await inventoryFiles(REPO_ROOT, domainMap);
  log(`Inventory: ${mapped.size} mapped files`);

  // Force allowedDeps={} so EVERY observed edge becomes a violation (the
  // baseline = "freeze reality, narrow over time" — we need the full
  // observed-edge set, not just edges that already violated the partial
  // existing allowedDeps).  M4 fix: don't rely on violations as a proxy
  // for the full graph; force the graph to BE violations.
  const probeMap = { ...domainMap, allowedDeps: {} };

  // Run ALL detected stacks' adapters (M12 fix — was: only stackKinds[0])
  const baseline = {};
  for (const stackKind of stackKinds) {
    const adapterPath = `./lib/arch-intent/adapters/${stackKind}.mjs`;
    let adapter;
    try { adapter = await import(adapterPath); }
    catch (err) {
      log(`WARN: skipping stack ${stackKind}: ${err.message}`);
      continue;
    }
    const report = await adapter.default({ mapped, domainMap: probeMap, repoPath: REPO_ROOT });
    log(`  ${stackKind}: ${report.violations.length} observed edges`);
    for (const v of report.violations) {
      if (!baseline[v.fromDomain]) baseline[v.fromDomain] = new Set();
      if (v.toDomain !== VENDOR_DOMAIN) baseline[v.fromDomain].add(v.toDomain);
    }
  }
  // Convert sets → sorted arrays for stable diffs
  const baselineMap = {};
  for (const [k, set] of Object.entries(baseline)) {
    baselineMap[k] = Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  // Read existing file (preserve top-level keys), update allowedDeps,
  // write atomically (M11 fix — bootstrap should not corrupt durable state
  // on a crash mid-write).
  const raw = JSON.parse(fs.readFileSync(DOMAIN_MAP_PATH, 'utf-8'));
  raw.allowedDeps = baselineMap;
  atomicWriteFileSync(DOMAIN_MAP_PATH, JSON.stringify(raw, null, 2) + '\n');
  log(`Wrote baseline: ${Object.keys(baselineMap).length} domains, ${report.violations.length} edges`);
  return true;
}

async function main() {
  const flags = new Set(process.argv.slice(2));
  log(`Bootstrap starting in ${REPO_ROOT}`);

  await copyTemplate();

  if (flags.has('--baseline-from-graph')) {
    log('--baseline-from-graph: generating from current import graph');
    await generateBaseline();
  } else {
    log('No --baseline-from-graph flag: allowedDeps will remain unset (pass will SKIP_NO_BASELINE)');
    log('To seed: re-run with --baseline-from-graph');
  }

  log('Bootstrap complete');
}

main().catch(err => {
  process.stderr.write(`bootstrap fatal: ${err.message}\n`);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * @fileoverview One-time historical reconstruction scanner — NOT the shipped
 * detector, NOT re-run by any test or CI check. Committed so the Phase-0
 * oracle's provenance is genuinely re-verifiable rather than merely asserted
 * (audit-code R2/M7 -> R3/H1 -> R4/H2,M2,M6 — three successive rounds tightened
 * this script until its own methodology matched what it claims to prove).
 *
 * Recipe to re-run it (requires a local clone of wine-cellar-app):
 *
 *   cd <wine-cellar-app clone>
 *   git worktree add --detach /tmp/wine-oracle-274ad342 274ad342
 *   node <this file> /tmp/wine-oracle-274ad342
 *   git worktree remove --force /tmp/wine-oracle-274ad342
 *
 * Exits non-zero (and prints a diff) if the reconstructed catalog does not
 * match raw-scan-274ad342.json exactly (audit-code R4/M6 fix — the script
 * used to just print its output for a human to eyeball against the
 * committed JSON, with no actual comparison).
 *
 * Deliberately independent of the shipped extractor (audit-code R5/M2 —
 * NOT a defect: sharing event-wiring.mjs's own parsing seam would make this
 * "verification that my extractor agrees with itself," not an independent
 * check — the same reason the original wine-cellar-app scanner this is
 * adapted from is itself a separate implementation).
 *
 * Known, accepted residual (audit-code R5/M4): `isReallyDispatched` uses a
 * BOUNDED TEXT WINDOW (200 chars back for the assignment, 2000 chars forward
 * for the matching dispatchEvent call), not true lexical function-scope
 * resolution — a construction could in principle be misattributed to a
 * neighbouring function's dispatchEvent call in sufficiently dense code.
 * Accepted rather than fixed further: this is a one-time historical
 * reconstruction tool, not shipped code, and its output for THIS specific
 * corpus was independently cross-checked twice — once by re-running it
 * against a fresh worktree, once by manually reading each of the 7 fixture
 * sites' surrounding source directly (see the plan's audit trail) — the
 * same right-sizing tradeoff D7 makes for the shipped grammar.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = process.argv[2];
if (!ROOT) {
  console.error('Usage: node historical-scan-274ad342.mjs <path to a wine-cellar-app worktree at 274ad342>');
  process.exit(2);
}

// audit-code R4/M2 fix: verify ROOT is actually the claimed worktree, not
// just any directory a caller happened to pass — a wrong ROOT would produce
// a confidently-wrong "reconstruction" with no signal anything was off.
try {
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
  if (!headSha.startsWith('274ad342')) {
    console.error(`Refusing to scan: ${ROOT} is at commit ${headSha}, not 274ad342.`);
    process.exit(2);
  }
} catch (err) {
  console.error(`Refusing to scan: ${ROOT} does not look like a git worktree (${err.message}).`);
  process.exit(2);
}
const pkgPath = join(ROOT, 'package.json');
if (!existsSync(pkgPath) || !JSON.parse(readFileSync(pkgPath, 'utf8')).name?.includes('wine')) {
  console.error(`Refusing to scan: ${ROOT}/package.json doesn't look like wine-cellar-app.`);
  process.exit(2);
}

const JS_ROOT = join(ROOT, 'public', 'js');

function isCustomEventName(name) {
  return /[-:.]/.test(name);
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (entry.endsWith('.js')) acc.push(full);
  }
  return acc;
}

/**
 * audit-code R4/H3 fix: a `new CustomEvent(name)`/`new Event(name)`
 * construction is only counted as a DISPATCHER when it can be shown to reach
 * `.dispatchEvent(...)` — either directly wrapped, or assigned to a variable
 * that's later passed to `.dispatchEvent(<thatVar>)` within the same
 * function-ish region. The original version counted every construction
 * unconditionally, which is LOOSER than the actual extractor's own D7
 * "construction is not dispatch" rule — undermining the exact claim this
 * script exists to verify. Bounded, not full symbol resolution (this is a
 * one-time verification tool, not the shipped grammar): looks within the
 * next 2000 characters for either form.
 */
function isReallyDispatched(src, matchStart, matchEnd) {
  // Look BACKWARD from where "new CustomEvent(..." itself starts (matchStart)
  // for `const evt = ` — not from matchEnd (the end of the quoted event name,
  // which is inside the construction, not before it). Using matchEnd here
  // was the bug: it made the backward-window land in the wrong place and
  // silently failed on both real indirect-pattern events in the oracle,
  // caught only by re-running this script against the real worktree after
  // tightening it.
  const varAssign = src.slice(Math.max(0, matchStart - 200), matchStart).match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/);
  if (!varAssign) return false;
  const varName = varAssign[1];
  const window = src.slice(matchEnd, matchEnd + 2000);
  const dispatchRe = new RegExp(`\\.dispatchEvent\\s*\\(\\s*${varName}\\b`);
  return dispatchRe.test(window);
}

const files = walk(JS_ROOT);
const eventCatalog = new Map();

for (const abs of files) {
  const rel = relative(JS_ROOT, abs).split(sep).join('/');
  const src = readFileSync(abs, 'utf8');

  for (const m of src.matchAll(/(\.dispatchEvent\s*\(\s*)?new\s+(?:CustomEvent|Event)\s*\(\s*(['"`])([^'"`]+)\2/g)) {
    const name = m[3];
    if (!isCustomEventName(name)) continue;
    const immediate = m[1] !== undefined;
    if (!immediate && !isReallyDispatched(src, m.index, m.index + m[0].length)) continue;
    if (!eventCatalog.has(name)) eventCatalog.set(name, { dispatchers: new Set(), listeners: new Set() });
    eventCatalog.get(name).dispatchers.add(rel);
  }
  for (const m of src.matchAll(/\.addEventListener\s*\(\s*(['"`])([^'"`]+)\1/g)) {
    const name = m[2];
    if (!isCustomEventName(name)) continue;
    if (!eventCatalog.has(name)) eventCatalog.set(name, { dispatchers: new Set(), listeners: new Set() });
    eventCatalog.get(name).listeners.add(rel);
  }
  for (const m of src.matchAll(/\baddTrackedListener\s*\(\s*(['"`])[^'"`]*\1\s*,\s*[^,]+,\s*(['"`])([^'"`]+)\2/g)) {
    const name = m[3];
    if (!isCustomEventName(name)) continue;
    if (!eventCatalog.has(name)) eventCatalog.set(name, { dispatchers: new Set(), listeners: new Set() });
    eventCatalog.get(name).listeners.add(rel);
  }
  for (const m of src.matchAll(/\b\w*[Rr]egistry\.add\s*\(\s*[^'"`,][^,]*,\s*(['"`])([^'"`]+)\1/g)) {
    const name = m[2];
    if (!isCustomEventName(name)) continue;
    if (!eventCatalog.has(name)) eventCatalog.set(name, { dispatchers: new Set(), listeners: new Set() });
    eventCatalog.get(name).listeners.add(rel);
  }
}

const catalog = [...eventCatalog.entries()].map(([name, v]) => ({
  name,
  dispatchers: [...v.dispatchers].sort(),
  listeners: [...v.listeners].sort(),
  orphan: v.dispatchers.size === 0 ? 'listen-only' : v.listeners.size === 0 ? 'dispatch-only' : null,
})).sort((a, b) => a.name.localeCompare(b.name));

const dispatchOnly = catalog.filter(c => c.orphan === 'dispatch-only');
console.log(`Scanned ${files.length} files under public/js/`);
console.log(`Dispatch-only kebab/colon-named events: ${dispatchOnly.length}`);
console.log(JSON.stringify(dispatchOnly, null, 2));

// audit-code R4/M6 fix: actually compare against the committed evidence
// instead of leaving that to a human eyeballing two printouts.
const __dirname = dirname(fileURLToPath(import.meta.url));
const expectedPath = join(__dirname, 'raw-scan-274ad342.json');
const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
// Normalize to {name, dispatchers, listeners} only — raw-scan-274ad342.json
// predates this script's `orphan` field and doesn't carry it.
const normalize = (list) => JSON.stringify(
  list.map(e => ({ name: e.name, dispatchers: e.dispatchers, listeners: e.listeners })).sort((a, b) => a.name.localeCompare(b.name)),
);
const actualJson = normalize(dispatchOnly);
const expectedJson = normalize(expected.kebabColonNamedDispatchOnlyEvents);
if (actualJson !== expectedJson || files.length !== expected.scannedFiles) {
  console.error(`\nMISMATCH against ${expectedPath}:`);
  console.error(`  scanned files: got ${files.length}, expected ${expected.scannedFiles}`);
  console.error(`  catalog: ${actualJson === expectedJson ? 'matches' : 'DIFFERS'}`);
  process.exit(1);
}
console.log(`\nMATCHES ${expectedPath} exactly.`);

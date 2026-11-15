#!/usr/bin/env node
/**
 * @fileoverview Gate: no Anthropic-seam call site may pass a param the `cli`
 * backend cannot honour without pinning `{backend:'sdk'}`.
 *
 * The seam throws at run time. CI runs the committed default (`sdk`), so that
 * throw never fires in CI — only on the operator machines that set
 * `CLAUDE_BACKEND=cli`. This gate is what makes the pin enforceable before
 * merge. Rules, and why there are two, are in
 * [lib/anthropic-pin-census.mjs](lib/anthropic-pin-census.mjs).
 *
 * Corpus: TRACKED `.mjs` under `scripts/`, asked of git rather than walked.
 * Tracked is the right question for a merge gate — it judges what the commit
 * ships, and it is also what the pre-push sandbox (a clean worktree at the
 * commit being pushed) contains at all. It keeps the consumer-synced,
 * gitignored `scripts/.claude-skills/**` out of the corpus, which is upstream's
 * own content indexed twice.
 *
 * Usage:
 *   node scripts/check-anthropic-pins.mjs            # gate (exit 1 on drift)
 *   node scripts/check-anthropic-pins.mjs --report    # same output, exit 0
 *   node scripts/check-anthropic-pins.mjs --list      # every construction site
 *
 * @module scripts/check-anthropic-pins
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertKnownFlags, ArgvError, finishAndExit, hasFlag } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { findRepoRootFromScript } from './lib/assert-repo-root.mjs';
import { auditPinCensus, classifyPinningInSource } from './lib/anthropic-pin-census.mjs';

const BASELINE_PATH = '.anthropic-pin-census.json';
const SEAM_MODULE = 'scripts/lib/anthropic-client.mjs';
const KNOWN_FLAGS = ['--report', '--list', '--help', '-h', '--selfcheck-relocation'];

/** Tracked `.mjs` under `scripts/`, repo-relative with forward slashes. */
export function trackedScriptFiles(repoRoot) {
  const out = execFileSync('git', ['-C', repoRoot, 'ls-files', '-z', '--', 'scripts/*.mjs', 'scripts/**/*.mjs'], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/'));
}

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'check-anthropic-pins' });
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); await finishAndExit(2); return; }
    throw err;
  }
  const reportOnly = hasFlag('report');
  const repoRoot = findRepoRootFromScript(import.meta.url);

  let baseline;
  const baselineFile = path.join(repoRoot, BASELINE_PATH);
  try {
    baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  } catch (err) {
    process.stderr.write(
      `check-anthropic-pins: cannot read ${BASELINE_PATH} (${err.message}). It is the declared\n`
      + '  record of every unpinned construction; without it this gate would pass having\n'
      + '  compared nothing. Create it by hand.\n',
    );
    await finishAndExit(2); return;
  }

  const files = trackedScriptFiles(repoRoot);
  const sources = new Map();
  for (const rel of files) {
    // The seam DEFINES the factory; `export async function
    // createAnthropicClient(options = {})` matches the construction pattern and
    // has no backend literal, so including it would make the gate's very first
    // report a finding about the function it is enforcing. Excluded by path, not
    // by a pattern that could also hide a real call site.
    if (rel === SEAM_MODULE) continue;
    const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    if (!text.includes('createAnthropicClient')) continue;
    sources.set(rel, text);
  }
  // A corpus of zero is never a pass: the seam's own module names the factory,
  // so an empty set means the enumeration broke, not that nothing calls it.
  if (sources.size === 0) {
    process.stderr.write(
      `check-anthropic-pins: 0 of ${files.length} tracked scripts mention createAnthropicClient —\n`
      + '  the enumeration is broken (git ls-files returned nothing usable), not the repo.\n',
    );
    await finishAndExit(2); return;
  }

  if (hasFlag('list')) {
    for (const [file, text] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
      const c = classifyPinningInSource(text);
      if (c.constructions === 0) continue;
      process.stdout.write(
        `  ${file.padEnd(52)} ${c.constructions} construction(s), ${c.unpinned} unpinned`
        + `${c.unserviceable.length ? ` · passes ${c.unserviceable.join(', ')}` : ''}\n`,
      );
    }
  }

  const verdict = auditPinCensus(sources, baseline);
  if (verdict.ok) {
    process.stdout.write(
      `check-anthropic-pins: clean — ${sources.size} file(s) use the seam, `
      + `${Object.keys(baseline.unpinnedConstructions || {}).length} declared unpinned construction(s).\n`,
    );
    await finishAndExit(0); return;
  }

  // A FILE THE PARSER COULD NOT READ FAILS THE GATE, SO IT MUST BE NAMED.
  // `auditPinCensus` sets `ok: false` on `unparsed` — deliberately, since an
  // unreadable file is unknown rather than clean — and this block printed every
  // other category but that one. The gate therefore exited 1 with no line
  // explaining itself, on exactly the file most likely to be mid-edit: the
  // worst possible moment to be given a silent failure.
  for (const f of verdict.unparsed) {
    process.stderr.write(`  UNPARSED        ${f} — could not be parsed, so its pinning is UNKNOWN, not clean.\n`);
  }
  for (const v of verdict.ruleA) {
    // `params` is EMPTY when the violation is a dynamic key — a spread into a
    // `.create()` argument, or a computed key that is not a string literal.
    // Rule A fails closed on those, correctly, but printing the literal list
    // then produced `passes ``,` — a dangling message naming nothing, for the
    // one case the reader most needs told apart from a named param.
    process.stderr.write(v.params.length
      ? `  UNPINNED+PARAM  ${v.file} — constructs an unpinned client and passes `
        + `\`${v.params.join('`, `')}\`, which the cli backend cannot honour.\n`
      : `  UNPINNED+PARAM  ${v.file} — constructs an unpinned client and builds its request with a `
        + 'spread or a computed key, so whether it passes `system`/`tools`/`tool_choice` cannot be '
        + 'read statically. Fails closed: pin it, or write the keys literally.\n');
  }
  for (const f of verdict.undeclared) {
    process.stderr.write(`  UNDECLARED      ${f} — constructs a client with no literal backend pin.\n`);
  }
  for (const d of verdict.countDrift) {
    // SAME count, DIFFERENT constructions is its own failure: the declared
    // reason now describes something that is not in the file any more, and only
    // the digest can see it. Reporting it as a count mismatch would read as
    // nonsense ("declares digest … construction(s)").
    const isDigest = typeof d.actual === 'string' && String(d.actual).startsWith('digest ');
    process.stderr.write(isDigest
      ? `  SHAPE DRIFT     ${d.file} — its unpinned construction(s) changed (${d.declared} → ${d.actual}); the count is unchanged, so only the digest sees it.\n`
      : `  COUNT DRIFT     ${d.file} — declares ${d.declared ?? '(no count)'} unpinned construction(s), found ${d.actual}.\n`);
  }
  for (const f of verdict.stale) {
    process.stderr.write(`  STALE           ${f} — declared in ${BASELINE_PATH}, but no longer constructs an unpinned client.\n`);
  }
  for (const b of verdict.brokenIndirect) {
    process.stderr.write(`  BROKEN INDIRECT ${b.file} — via ${b.via}: ${b.why}.\n`);
  }
  for (const f of verdict.staleIndirect) {
    process.stderr.write(`  STALE INDIRECT  ${f} — has an indirectPins entry but constructs no unpinned client.\n`);
  }
  for (const f of verdict.declaredWithoutReason) {
    process.stderr.write(`  NO REASON       ${f} — declared with an empty \`reason\`.\n`);
  }
  process.stderr.write('\n');
  if (verdict.ruleA.length) {
    process.stderr.write(
      '  Rule A: add `backend: \'sdk\'` to that construction. The cli backend THROWS on\n'
      + '  `system`/`tools`/`tool_choice` (lib/anthropic-cli-faithfulness.mjs), and CI runs\n'
      + '  the sdk default, so without the pin the break ships and fires only where\n'
      + '  CLAUDE_BACKEND=cli is set. Gate the site on `isClaudeAvailableFor(\'sdk\')` too —\n'
      + '  the ambient check says available on a keyless cli install.\n');
  }
  if (verdict.countDrift.length) {
    process.stderr.write(
      `  A declaration carries the COUNT of unpinned constructions, not just the file: declaring\n`
      + '  a file once would otherwise clear every construction added to it later. Update the\n'
      + `  \`constructions\` number and say in \`reason\` what the new one does.\n`);
  }
  if (verdict.brokenIndirect.length || verdict.staleIndirect.length) {
    process.stderr.write(
      '  An indirectPins entry is VERIFIED, not trusted: the named `via` function must exist in\n'
      + '  that file, contain the literal pin, and be passed by every unpinned construction there.\n'
      + '  Fix the code or remove the entry.\n');
  }
  if (verdict.unparsed.length) {
    process.stderr.write(
      '  An UNPARSED file is not a gate bug to work around: fix the syntax error, or if the file\n'
      + '  is deliberately not JavaScript, it does not belong in this corpus. The gate refuses to\n'
      + '  call a file it could not read clean, because that is the one file whose pinning nobody\n'
      + '  has checked.\n');
  }
  if (verdict.undeclared.length || verdict.stale.length || verdict.declaredWithoutReason.length) {
    process.stderr.write(
      `  Rule B: ${BASELINE_PATH} enumerates every unpinned construction, because a file-local\n`
      + '  scan cannot see a client HANDED to another module whose call passes `system`.\n'
      + '  Add or remove the entry, with a reason stating what was checked.\n');
  }
  await finishAndExit(reportOnly ? 0 : 1);
}

if (isInvokedAsScript(import.meta.url)) {
  await main();
}

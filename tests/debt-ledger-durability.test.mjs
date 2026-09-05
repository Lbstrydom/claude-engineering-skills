/**
 * @fileoverview The debt ledger's persistence contract is CHECKED, not asserted.
 *
 * `debt-ledger.mjs`'s header used to say the ledger "is committed,
 * human-approved state". Nothing verified it, and it is a claim about the
 * consumer's git configuration made by a file that cannot see it.
 *
 * WHAT IT COST. Measured on this repo 2026-09-04: `.gitignore` ignores all of
 * `.audit/`, so the declared source of truth was untracked and per-machine —
 * local 106 entries, cloud 136, overlap 69, meaning 37 entries existed on
 * exactly ONE disk. A consumer then repeated the cost independently: they
 * captured 8 debt entries whose main checkout still showed the original 34, and
 * put their own ownership overlay beside the ledger on the strength of that
 * sentence, where it was silently never committed and the tool requiring it
 * exited non-zero in every checkout but the one that built it.
 *
 * WARN, NEVER REFUSE — ignored + cloud-as-source-of-truth is the SUPPORTED
 * configuration (`debt-memory.mjs`), so failing the write would break the
 * correct setup. What was missing was visibility, not permission. The tests
 * below therefore lock three things: it fires when the path is disowned, it
 * does NOT fire when the path is tracked (the direction a false warning would
 * be silent noise), and it never blocks a write either way.
 *
 * Hermetic: each case builds a throwaway git repo in a temp dir and runs the
 * real module in a child process with cwd set to it, because the predicate is
 * asked of the working tree.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const LEDGER_URL = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'lib', 'debt-ledger.mjs')).href;

const _dirs = [];
after(() => {
  for (const d of _dirs) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ }
  }
});

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
}

/**
 * A throwaway git repo containing `.audit/tech-debt.json`.
 * @param {{ignore: boolean, track: boolean}} opts
 */
function makeRepo({ ignore, track }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-durability-'));
  _dirs.push(dir);
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(dir, '.gitignore'), ignore ? '.audit/\n' : '# nothing ignored\n');
  fs.mkdirSync(path.join(dir, '.audit'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.audit', 'tech-debt.json'), JSON.stringify({ version: 1, entries: [] }));
  git(dir, ['add', '.gitignore']);
  // `-f` because the point of the tracked+ignored case is a file that matches an
  // ignore pattern AND is committed: the predicate is `ignored AND untracked`,
  // so ignore-status alone would wrongly flag it.
  if (track) git(dir, ['add', '-f', '.audit/tech-debt.json']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

/**
 * Run `assertLedgerDurability` on the repo's ledger; return stderr.
 * `mode` is the tri-state `cloudMirrored` hint: `true` (a cloud copy exists),
 * `false` (local-only), or omitted (unknown).
 */
function warnIn(dir, mode) {
  const arg = mode === undefined ? '' : `, ${JSON.stringify(mode)}`;
  const script =
    `import { _internals } from ${JSON.stringify(LEDGER_URL)};`
    + `import path from 'node:path';`
    + `_internals.assertLedgerDurability(path.resolve('.audit/tech-debt.json')${arg});`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: dir, encoding: 'utf8',
  });
  assert.equal(r.status, 0, `child exited ${r.status}: ${(r.stderr || '').slice(0, 500)}`);
  return r.stderr || '';
}

describe('debt ledger — durability of its own path is checked', () => {
  it('WARNS when the ledger is gitignored and untracked', () => {
    const err = warnIn(makeRepo({ ignore: true, track: false }));
    assert.match(err, /gitignored and untracked/);
    assert.match(err, /\.audit\/tech-debt\.json/, 'the warning names the path, not a generic phrase');
    assert.match(err, /AUDIT_DB_URL|un-ignore/, 'the warning carries a remedy');
  });

  // ── The tri-state `cloudMirrored` hint (Gemini gate, 2026-09-04) ──────────
  //
  // The first version warned unconditionally, which nags on a CORRECTLY
  // configured cloud setup — where the ledger being gitignored is the intended
  // state. A warning that fires on the happy path is how operators learn to
  // skip warnings, including the ones that matter. The mode is propagated from
  // `debt-memory.mjs::selectEventSource`, never computed here.

  it('is SILENT when a cloud copy exists — gitignored is the intended state there', () => {
    // The direction it must not fire. This is the common configuration in this
    // repo and every consumer, so a false positive here is the loudest one.
    const err = warnIn(makeRepo({ ignore: true, track: false }), true);
    assert.equal(err.includes('[debt]'), false, `warned on the happy path: ${err}`);
  });

  it('is LOUD and actionable when local-only — this file IS the state', () => {
    const err = warnIn(makeRepo({ ignore: true, track: false }), false);
    assert.match(err, /no cloud store is configured/);
    assert.match(err, /ONLY in this checkout/);
    assert.match(err, /Set AUDIT_DB_URL, or un-ignore/, 'the loud case carries the remedy');
  });

  it('states the fact without prescribing when the mode is UNKNOWN', () => {
    // The neutral variant must not tell an operator to un-ignore a path that
    // may be correctly ignored — that imperative belongs to the local-only case.
    const err = warnIn(makeRepo({ ignore: true, track: false }));
    assert.match(err, /gitignored and untracked/);
    assert.match(err, /debt-memory\.mjs/, 'it names where the mode is actually decided');
    assert.equal(/un-ignore this path to commit them/.test(err), false,
      'the unknown case must not prescribe a fix for a setup that may be correct');
  });

  it('does NOT warn when the ledger is TRACKED despite matching an ignore pattern', () => {
    // The direction that must not fire, and the reason the predicate is
    // "ignored AND untracked" rather than "ignored": `git check-ignore` will
    // report a committed file as ignored whenever a pattern matches it, so an
    // ignore-only test would cry wolf at exactly the repos that got it right.
    assert.equal(warnIn(makeRepo({ ignore: true, track: true })).includes('gitignored and untracked'), false);
  });

  it('does NOT warn when nothing is ignored at all', () => {
    assert.equal(warnIn(makeRepo({ ignore: false, track: true })).includes('gitignored and untracked'), false);
  });

  it('stays silent — never claims durability — outside a git work tree', () => {
    // "Could not verify" is not "verified durable". A degraded git probe must
    // produce neither a warning nor a reassurance.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-durability-nogit-'));
    _dirs.push(dir);
    fs.mkdirSync(path.join(dir, '.audit'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.audit', 'tech-debt.json'), '{}');
    const err = warnIn(dir);
    assert.equal(err.includes('gitignored and untracked'), false);
    // And SILENT means silent. The ownership oracle warns loudly on a degraded
    // probe — correct where its result IS the judgement, wrong here, where it
    // only decides whether to print this module's advisory. Without
    // `warnOnDegraded:false` every temp-dir write emitted an unrelated
    // `[disowned-paths] WARN:` line, which is how a real warning gets ignored.
    assert.ok(!err.includes('WARN:'), `an unrelated warning escaped: ${err}`);
  });

  it('warns at most once per process', () => {
    const dir = makeRepo({ ignore: true, track: false });
    const script =
      `import { _internals } from ${JSON.stringify(LEDGER_URL)};`
      + `import path from 'node:path';`
      + `const p = path.resolve('.audit/tech-debt.json');`
      + `_internals.assertLedgerDurability(p);`
      + `_internals.assertLedgerDurability(p);`
      + `_internals.assertLedgerDurability(p);`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal((r.stderr.match(/gitignored and untracked/g) || []).length, 1);
  });

  it('the check is WIRED to the real write path, and does not block it', () => {
    // A predicate nobody calls is inert. This drives `writeDebtEntries` itself:
    // the warning must appear AND the entry must land.
    const dir = makeRepo({ ignore: true, track: false });
    const entry = {
      source: 'debt', topicId: 'aa00', semanticHash: 'hash00', severity: 'HIGH',
      category: 'test', section: 'src/x.js:1', detailSnapshot: 'details',
      affectedFiles: ['src/x.js'], affectedPrinciples: [], pass: 'backend',
      deferredReason: 'out-of-scope', deferredAt: '2026-09-04T10:00:00.000Z',
      deferredRun: 'r1', deferredRationale: 'a sufficiently long rationale string for testing',
      contentAliases: [], sensitive: false,
    };
    const script =
      `import { writeDebtEntries } from ${JSON.stringify(LEDGER_URL)};`
      + `const r = await writeDebtEntries([${JSON.stringify(entry)}], { ledgerPath: '.audit/tech-debt.json' });`
      + `process.stdout.write(JSON.stringify(r));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `child exited ${r.status}: ${(r.stderr || '').slice(0, 500)}`);
    assert.match(r.stderr, /gitignored and untracked/, 'the real write path must emit the warning');
    assert.equal(JSON.parse(r.stdout).total, 1, 'and must still write the entry');
  });
});

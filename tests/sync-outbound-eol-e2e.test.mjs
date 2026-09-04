/**
 * @fileoverview End-to-end guard: a sync leaves NO permanently-dirty
 * EOL churn in a consumer, driven through the real `sync-to-repos.mjs` CLI
 * against a real git repository.
 *
 * **Tier 3** (AGENTS.md testing doctrine): the consumer sync contract, where a
 * break ships silently to repos we cannot observe.
 *
 * ## The incident this locks (2026-09-02, consumer report)
 *
 * A consumer saw four `.claude/hooks/*.mjs` files reported modified by
 * `git status` immediately after a clean sync, forever. `git diff
 * --ignore-cr-at-eol` was empty — the content was byte-identical and the files
 * differed only in line endings, against a `.gitattributes` line the SYNC
 * ITSELF writes pinning `.claude/hooks/** text eol=lf`.
 *
 * Two independent defects composed:
 *
 *   1. The sync copies WORKING-TREE bytes. Measured the same day: this repo's
 *      linked worktree held five `.claude/hooks/*` files with CRLF
 *      (`bash-grep-nudge.mjs` at 2,222 bytes) while its main checkout held LF
 *      (2,155) — same commit, and `git status` calls BOTH clean. So the bytes a
 *      consumer received depended on which checkout ran the sync, and a sync
 *      from the worktree shipped CRLF while the same run declared `eol=lf`.
 *
 *   2. The EOL-insensitive comparison then SKIPPED the write, so once a
 *      consumer held CRLF nothing ever rewrote it. That is what made the dirt
 *      permanent rather than self-correcting, and it cost real time: the four
 *      files sat dirty across several sessions and were twice mistaken for a
 *      partially-applied sync.
 *
 * Why it is more than cosmetic: `.sync-receipt.json` is *correctly* dirty after
 * every sync (it is the only in-repo record that a sync ran) and is meant to be
 * committed. Permanent EOL churn beside it makes a genuine sync change
 * indistinguishable from noise without running `--ignore-cr-at-eol` by hand,
 * and a consumer who commits the tree lands a CRLF-flip touching files they
 * never edited.
 *
 * ## What this test can and cannot prove
 *
 * It drives defect 2 deterministically: seed a tracked synced file with CRLF on
 * disk, sync, and require the file to come back LF and the tree to be clean.
 * That is red before the fix and green after, on any platform.
 *
 * It deliberately does NOT try to reproduce defect 1 by making the source
 * checkout CRLF — the CLI reads from this repo, so such a test would assert a
 * property of whoever's checkout is running it and would pass vacuously on an
 * LF machine. Defect 1's fold is covered by the unit suite next door
 * (`sync-outbound-eol.test.mjs`), and the two together cover the report.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

import { seedInstalledDeps, runSyncCli, whySyncFailed } from './helpers/consumer-fixture.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'sync-to-repos.mjs');
const execFileAsync = promisify(execFile);

const RECEIPT = '.sync-receipt.json';

let tmp;
let consumer;

function git(args, cwd = consumer) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', windowsHide: true });
}

async function sync(extra = []) {
  return runSyncCli(['--target-path', consumer, '--no-prompt', ...extra]);
}

/**
 * A TRACKED synced destination under `.claude/` — the half of the bundle a
 * consumer can commit, and therefore the half where EOL churn is visible.
 * Discovered from what the sync actually delivered rather than hard-coded, so
 * the test does not rot when the bundle changes shape.
 */
function pickTrackedSubject() {
  const roots = [
    path.join(consumer, '.claude', 'hooks'),
    path.join(consumer, '.claude', 'skills'),
  ];
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (/\.(mjs|md)$/.test(e.name)) out.push(path.relative(consumer, abs));
    }
  };
  roots.forEach(walk);
  out.sort();
  return out[0] ?? null;
}

const toCrlf = (s) => s.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ces-eol-')));
  consumer = path.join(tmp, 'consumer');
  fs.mkdirSync(consumer, { recursive: true });
  git(['init', '--initial-branch=main'], consumer);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'Sync EOL Test']);
  // The consumer-side condition the report describes: a Windows checkout that
  // would rewrite LF to CRLF. Set explicitly so the test exercises the same
  // configuration on every platform rather than only on Windows.
  git(['config', 'core.autocrlf', 'true']);
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    JSON.stringify({ name: 'eol-fixture', type: 'module' }, null, 2),
  );
  // No install: this suite's subject is the sync's behaviour in a real git
  // repo, not dependency provisioning. See helpers/consumer-fixture.mjs — a
  // real install buries this fixture's `git add -A` under tens of thousands of
  // node_modules files, and the derived subprocess budget there (never a
  // hand-picked number here) is sized around the no-install case by default.
  seedInstalledDeps(consumer);
  fs.writeFileSync(path.join(consumer, '.gitignore'), '');
  git(['add', '-A']);
  git(['commit', '-m', 'init', '--no-gpg-sign']);
});

after(() => {
  // Retry-hardened per the repo-wide rmSync guard: this tree held a 770-file
  // bundle a child process just finished writing, which is exactly when
  // Windows answers EPERM/EBUSY on a directory that is about to become free.
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('sync outbound EOL', () => {
  let subject;

  it('first sync delivers the bundle, and the committed tree is clean', async () => {
    const first = await sync();
    assert.equal(first.code, 0, whySyncFailed(first));

    subject = pickTrackedSubject();
    assert.ok(subject, 'no tracked .claude/ destination was delivered — nothing to assert on');

    git(['add', '-A']);
    git(['commit', '-m', 'adopt sync', '--no-gpg-sign']);

    // `pickTrackedSubject` runs BEFORE this commit, so its name states an
    // intent the filesystem cannot confirm. Ask git whether the add actually
    // took: a global `core.excludesFile` could leave the subject untracked, and
    // every EOL assertion after this point — including the clean-tree check
    // below — is vacuous for a file git is ignoring (round-1 code audit M3,
    // 2026-09-04). `ls-files` prints the path when tracked and nothing when not.
    assert.equal(
      git(['ls-files', '--error-unmatch', '--', subject]).trim().replaceAll(path.sep, '/'),
      subject.replaceAll(path.sep, '/'),
      `subject ${subject} is not tracked — the EOL assertions below would be vacuous`,
    );

    const dirty = git(['status', '--porcelain']).trim();
    assert.equal(dirty, '', `tree should be clean after committing the first sync, got:\n${dirty}`);
  });

  it('repairs a consumer file left with CRLF, instead of skipping it forever', async () => {
    const abs = path.join(consumer, subject);
    const original = fs.readFileSync(abs, 'utf-8');

    // Vacuous-pass guard: the whole point is a file that HAS CRLF on disk while
    // the index holds LF. If the seeding does not actually produce that state,
    // the assertions below would pass having tested nothing.
    fs.writeFileSync(abs, toCrlf(original), 'utf-8');
    assert.ok(
      fs.readFileSync(abs, 'utf-8').includes('\r\n'),
      'seeding failed: subject does not contain CRLF, so this test would prove nothing',
    );
    assert.notEqual(
      fs.readFileSync(abs, 'utf-8'), original,
      'seeding failed: subject bytes unchanged, so this test would prove nothing',
    );
    // The physical-bytes checks above are not sufficient on their own: with
    // core.autocrlf=true (set in before()), CRLF-on-disk can be a NORMAL,
    // clean state that git's own conversion produces — the repair this test
    // exercises only matters if git ALSO sees the file as changed against the
    // `text eol=lf` attribute the first sync wrote (round-5 code audit M4,
    // 2026-09-04). Verified empirically before adopting: on this fixture's own
    // config (autocrlf=true + eol=lf), a raw CRLF rewrite of a tracked file DOES
    // report `M <path>` — but asserting it here, rather than assuming it, is
    // what makes this test's precondition provable instead of merely plausible.
    assert.match(
      git(['status', '--porcelain', '--', subject]), /^ M /,
      `seeding failed: git does not see ${subject} as dirty under its eol=lf attribute — the repair below would prove nothing`,
    );

    const second = await sync();
    assert.equal(second.code, 0, whySyncFailed(second));

    const after = fs.readFileSync(abs, 'utf-8');
    assert.ok(
      !after.includes('\r\n'),
      `${subject} still holds CRLF after a sync — the writer skipped the repair, so the churn is permanent`,
    );
    assert.equal(after, original, `${subject} content changed; only line endings should have been touched`);
  });

  it('leaves nothing dirty but the receipt, which is dirty by design', async () => {
    const dirty = git(['status', '--porcelain'])
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const notReceipt = dirty.filter((l) => !l.endsWith(RECEIPT));
    assert.deepEqual(
      notReceipt, [],
      `a sync must leave only ${RECEIPT} dirty; these also changed:\n${notReceipt.join('\n')}`,
    );
  });

  it('a second consecutive sync is idempotent — no new churn', async () => {
    git(['add', '-A']);
    git(['commit', '-m', 'adopt receipt', '--no-gpg-sign']);

    const third = await sync();
    assert.equal(third.code, 0, whySyncFailed(third));

    const dirty = git(['status', '--porcelain'])
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => !l.endsWith(RECEIPT));
    assert.deepEqual(dirty, [], `a repeat sync introduced churn:\n${dirty.join('\n')}`);
  });
});

/**
 * @fileoverview The repo-vs-global receipt seam — guards for the partial-scope
 * enumeration class.
 *
 * Same defect family as the WAL journal-placement fix (see
 * docs/plans/install-transaction-wal-hardening.md Fix 8): a rule that must
 * cover BOTH scopes applied to only one of them. These were found by
 * deliberately hunting that pattern one layer out from transaction.mjs, in its
 * caller and its sibling reader, and all three were live:
 *
 *  1. ManagedFileSchema omitted `scope`, so Zod stripped the discriminator on
 *     read and computeDeletes' global branch became unreachable — every global
 *     file silently un-deletable (guarded in receipt.test.mjs).
 *  2. writeReceiptsByScope guarded on writes only, never deletes.
 *  3. check-skill-updates read only the repo receipt.
 *
 * ## What changed when the install path was retired (2026-07-30)
 *
 * Findings 1 and 2 lived in `install-skills.mjs`'s installer — `computeDeletes`,
 * `writeReceiptsByScope`, `retainUnmanagedEntries` and `authoritativeScopesFor`
 * together decided which previously-managed files a *partial* install
 * (`--skills x`, `--surface claude`) was authoritative enough to prune. Every
 * skill-install surface is now retired
 * (docs/plans/repo-scoped-skill-surfaces-and-installer.md §2 D2/D3/D4), so there
 * is no partial install, no write set to diff a receipt against, and none of
 * those four functions exists. Their suites were **removed rather than skipped**:
 * a skipped test for deleted code is a standing invitation to "restore" it.
 *
 * The class those findings belong to has NOT stopped mattering — it moved. The
 * bundle still has two receipt scopes, and the modern reader of both is
 * `lib/install/legacy-surfaces.mjs`, whose own suite
 * (`legacy-surfaces-inspector.test.mjs`) carries the direct descendant of this
 * file's central assertion: *a stale `.agents/skills/` tree must be found even
 * when the global receipt is clean.* That is Finding 3's shape, one layer over.
 *
 * ## Finding 3's own suite was removed too, and deliberately (2026-07-30)
 *
 * An earlier revision of this header kept the `check-skill-updates` suite on the
 * grounds that it "still has live code behind it". It no longer does:
 * `scripts/check-skill-updates.mjs` was **retired and deleted** in the same pass.
 * Reading both receipts was its whole remaining job, and that job is now
 * `inspectLegacySurfaces`'s — which reads both scopes *by construction*
 * (`CLEANABLE_LEGACY_SURFACES` pairs each surface with its receipt scope), so the
 * partial-scope defect this suite guarded is no longer expressible there.
 *
 * Removed rather than repointed at the replacement: a copy of
 * `legacy-surfaces-inspector.test.mjs`'s two-scope assertion would be a second
 * test of one behaviour, and the first to rot. Removed rather than skipped, for
 * the reason given above — a skipped test for a deleted script invites its
 * "restoration".
 *
 * What remains here is the one thing with live code behind it: the shared path
 * decoder, which `legacy-surfaces.mjs` depends on to resolve receipt members.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { managedFileAbsPath } from '../../scripts/lib/install/surface-paths.mjs';

const tmpDirs = [];
function mkTmp(label) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `rscope-${label}-`)));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ }
  }
});

describe('managedFileAbsPath — one decoder for the scope-keyed encoding', () => {
  it('decodes global as absolute and repo as repo-relative', () => {
    const repo = mkTmp('decode');
    const abs = path.join(os.tmpdir(), 'somewhere', 'SKILL.md');
    assert.equal(managedFileAbsPath({ path: abs, scope: 'global' }, repo), abs);
    assert.equal(
      managedFileAbsPath({ path: 'a/b.md', scope: 'repo' }, repo),
      path.join(repo, 'a/b.md'),
    );
  });

  it('treats a missing scope as repo (legacy receipts)', () => {
    const repo = mkTmp('legacy-decode');
    assert.equal(managedFileAbsPath({ path: 'a/b.md' }, repo), path.join(repo, 'a/b.md'));
  });
});

/**
 * @fileoverview The synced-doc-links oracle and its gate.
 *
 * Subject: a relative markdown href is resolved against the directory its file
 * sits in, and the sync moves synced files to a DIFFERENT depth — so a link
 * that resolves in this repo can be dead in every consumer. Reported by
 * wine-cellar-app (upstream 15da01b6, 2026-09-04) for one link; a census the
 * same day found 47 more, none of which the two existing token-based gates
 * could see.
 *
 * The rows below pin the three things that were each individually wrong at some
 * point: the arithmetic (the extra `.claude/` level), the fence exemption (three
 * template links whose `./AGENTS.md` is CORRECT in the file the reader is told
 * to write), and the fail-closed contract on an empty closure.
 *
 * Gate contract: docs-synced-links-gate-rejects-a-relative-link-that-leaves-the-closure
 * (scripts/gate-contracts/docs-synced-links-gate.json). The process-level poison
 * pill for that id runs from tests/gate-poison-pills.test.mjs; the unit-level
 * failure directions live here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  UPSTREAM_BLOB_BASE,
  upstreamUrlFor,
  scanRelativeLinks,
  resolveAtDest,
  findUnfollowableLinks,
} from '../scripts/lib/synced-doc-links.mjs';
import { scanClosure, remedyFor } from '../scripts/check-synced-doc-links.mjs';
import { renderForTarget } from '../scripts/sync-shared-audit-refs.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

test('upstreamUrlFor produces a blob URL for a repo-relative path', () => {
  assert.equal(upstreamUrlFor('docs/plans/x.md'), `${UPSTREAM_BLOB_BASE}/docs/plans/x.md`);
  assert.equal(upstreamUrlFor('/docs/plans/x.md'), `${UPSTREAM_BLOB_BASE}/docs/plans/x.md`);
});

test('scanRelativeLinks reports only relative hrefs, with 1-indexed lines', () => {
  const text = [
    '[a](../b.md) plus [abs](https://example.test/x) and [anchor](#top)',
    'no links here',
    '[c](./d.md)',
  ].join('\n');
  assert.deepEqual(scanRelativeLinks(text), [
    { line: 1, href: '../b.md' },
    { line: 3, href: './d.md' },
  ]);
});

test('scanRelativeLinks skips fenced code — a link in a fence is sample bytes', () => {
  // /ai-context-management ships exactly this: a CLAUDE.md template whose
  // `./AGENTS.md` is correct in the ROOT file the reader is told to create.
  // Rewriting it would corrupt the template, so the gate must not see it.
  const text = [
    '```md',
    '@./AGENTS.md',
    '> Shared context lives in [AGENTS.md](./AGENTS.md).',
    '```',
    '[real](../outside.md)',
  ].join('\n');
  assert.deepEqual(scanRelativeLinks(text), [{ line: 5, href: '../outside.md' }]);
});

test('scanRelativeLinks handles tilde fences and unterminated fences', () => {
  assert.deepEqual(scanRelativeLinks('~~~\n[x](./a.md)\n~~~\n[y](./b.md)'), [{ line: 4, href: './b.md' }]);
  // An unterminated fence swallows the rest — the safe direction: it under-reports
  // rather than flagging sample bytes as defects.
  assert.deepEqual(scanRelativeLinks('```\n[x](./a.md)'), []);
});

test('resolveAtDest applies the CONSUMER depth, which is one level deeper', () => {
  // The whole defect in one assertion: `../../../docs/…` reaches the repo root
  // from skills/<skill>/references/ and lands in .claude/ from the copy.
  assert.equal(
    resolveAtDest('skills/audit-code/references/x.md', '../../../docs/a.md'),
    'docs/a.md',
  );
  assert.equal(
    resolveAtDest('.claude/skills/audit-code/references/x.md', '../../../docs/a.md'),
    '.claude/docs/a.md',
  );
  assert.equal(resolveAtDest('a/b.md', './c.md#frag'), 'a/c.md');
  assert.equal(resolveAtDest('a/b.md', '#frag'), null);
});

test('findUnfollowableLinks passes an in-closure target and flags an out-of-closure one', () => {
  const destPaths = new Set(['.claude/skills/audit-code/examples/scaffold.md']);
  const findings = findUnfollowableLinks({
    sourceRel: 'skills/ship/references/v.md',
    destRel: '.claude/skills/ship/references/v.md',
    text: [
      '[in](../../audit-code/examples/scaffold.md)',
      '[out](../../../docs/plans/p.md)',
    ].join('\n'),
    destPaths,
  });
  assert.deepEqual(findings, [{
    sourceRel: 'skills/ship/references/v.md',
    line: 2,
    href: '../../../docs/plans/p.md',
    resolved: '.claude/docs/plans/p.md',
  }]);
});

test('renderForTarget keeps an intra-skills link relative and URL-ifies the rest', () => {
  const canonical = path.join(ROOT, 'docs', 'audit', 'shared-references', 'c.md');
  const target = path.join(ROOT, 'skills', 'ship', 'references', 'c.md');
  const out = renderForTarget(
    '[plan](../../plans/p.md) and [sib](../../../skills/ship/examples/e.md)',
    canonical, target, ROOT,
  );
  assert.match(out, /\[plan\]\(https:\/\/github\.com\/Lbstrydom\/claude-engineering-skills\/blob\/main\/docs\/plans\/p\.md\)/);
  // A target inside skills/ survives the second copy into .claude/skills/,
  // because that tree mirrors skills/ at the same relative offset.
  assert.match(out, /\[sib\]\(\.\/(?:\.\.\/)*examples\/e\.md\)|\[sib\]\(\.\.\/examples\/e\.md\)/);
});

test('scanClosure fails CLOSED on an empty or markdown-less closure', async () => {
  const empty = await scanClosure(ROOT, { closure: { files: [] } });
  assert.equal(empty.ok, false);
  assert.equal(empty.findings.length, 0);
  assert.match(empty.error, /empty/);

  const noMd = await scanClosure(ROOT, { closure: { files: ['scripts/a.mjs'] } });
  assert.equal(noMd.ok, false);
  assert.match(noMd.error, /no markdown/);
});

test('scanClosure reports an unreadable member as a scan failure, not a clean pass', async () => {
  const res = await scanClosure(ROOT, { closure: { files: ['docs/does-not-exist-xyz.md'] } });
  assert.equal(res.ok, false);
  assert.match(res.error, /cannot read/);
});

test('the live bundle has no unfollowable relative links', async () => {
  const res = await scanClosure(ROOT);
  assert.equal(res.error, null);
  assert.ok(res.scanned > 0, 'the closure must contain markdown to have been checked');
  assert.deepEqual(
    res.findings.map((f) => `${f.sourceRel}:${f.line} ${f.href}`),
    [],
  );
});

test('remedyFor names the URL when the target exists, and says so when it does not', () => {
  assert.match(
    remedyFor({ sourceRel: 'docs/reference/consistency-contract.md', href: '../plans/persona-test-consistency-mode.md' }, ROOT),
    /^use https:\/\/github\.com\/Lbstrydom\/claude-engineering-skills\/blob\/main\/docs\/plans\/persona-test-consistency-mode\.md$/,
  );
  assert.match(
    remedyFor({ sourceRel: 'docs/reference/consistency-contract.md', href: '../plans/no-such-plan-xyz.md' }, ROOT),
    /does not exist in this repo/,
  );
});

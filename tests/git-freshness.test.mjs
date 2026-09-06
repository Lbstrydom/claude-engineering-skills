/**
 * @fileoverview `resolveBaseFreshness` — is THIS ref behind THAT ref.
 *
 * Two defects this primitive exists to close, both measured 2026-09-05:
 * `upstream reconcile` blamed a "crash-window gap" for what was a checkout 16
 * commits behind `origin/main` (opposite remedies — write the ledger vs
 * `git pull`), and a 7-round `/audit-code` run spent ~50 minutes against a base
 * 14 commits behind with nothing saying so.
 *
 * Every case runs against a REAL throwaway git repository. The subject under
 * test is git's own behaviour — `@{u}` semantics, ancestry exit codes — and a
 * mock of git would be a test of the mock.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  resolveBaseFreshness, resolveUpstreamRef, readFileAtRef, FRESHNESS_STATE,
} from '../scripts/lib/git-freshness.mjs';

const _dirs = [];
after(() => {
  for (const d of _dirs) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ }
  }
});

function g(cwd, args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (!allowFail) assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r;
}

function commit(dir, name, body = 'x') {
  fs.writeFileSync(path.join(dir, name), body);
  g(dir, ['add', name]);
  g(dir, ['commit', '-q', '-m', name]);
}

/**
 * A local "remote" plus a clone, so `@{u}` is genuinely configured — the only
 * way to exercise the branch-upstream path rather than assert around it.
 */
function makeClonePair() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-'));
  _dirs.push(root);
  const origin = path.join(root, 'origin');
  const work = path.join(root, 'work');
  fs.mkdirSync(origin);
  g(origin, ['init', '-q', '-b', 'main']);
  g(origin, ['config', 'user.email', 't@example.com']);
  g(origin, ['config', 'user.name', 'T']);
  commit(origin, 'base.txt');
  g(root, ['clone', '-q', origin, 'work']);
  g(work, ['config', 'user.email', 't@example.com']);
  g(work, ['config', 'user.name', 'T']);
  return { origin, work };
}

describe('resolveBaseFreshness — behind / current / unknown', () => {
  it('reports CURRENT on a fresh clone', () => {
    const { work } = makeClonePair();
    const r = resolveBaseFreshness({ repoRoot: work });
    assert.equal(r.state, FRESHNESS_STATE.CURRENT, r.reason || '');
    assert.equal(r.behindBy, 0);
    assert.match(r.upstream, /main$/);
    assert.match(r.subjectOid, /^[0-9a-f]{40}$/);
    assert.match(r.upstreamOid, /^[0-9a-f]{40}$/);
  });

  it('reports BEHIND with the real count once the remote moves ahead', () => {
    const { origin, work } = makeClonePair();
    commit(origin, 'a.txt');
    commit(origin, 'b.txt');
    g(work, ['fetch', '-q', 'origin']);
    const r = resolveBaseFreshness({ repoRoot: work });
    assert.equal(r.state, FRESHNESS_STATE.BEHIND, r.reason || '');
    assert.equal(r.behindBy, 2, 'the count must be the real distance, not a boolean');
  });

  it('NEVER fetches — it reports what the local remote-tracking ref knows', () => {
    // The load-bearing property: a gate that reaches the network fails on a
    // plane, and `npm run check` must stay offline-clean. Without a fetch the
    // remote's new commits are invisible, and saying `current` here is correct
    // rather than a miss — the caller's message carries the "as of your last
    // fetch" qualifier.
    const { origin, work } = makeClonePair();
    commit(origin, 'a.txt');
    const r = resolveBaseFreshness({ repoRoot: work });
    assert.equal(r.state, FRESHNESS_STATE.CURRENT,
      'resolveBaseFreshness must not have fetched');
  });

  it('an EXPLICIT upstream is compared directly, skipping branch resolution', () => {
    const { origin, work } = makeClonePair();
    commit(origin, 'a.txt');
    g(work, ['fetch', '-q', 'origin']);
    const r = resolveBaseFreshness({ repoRoot: work, upstream: 'origin/main' });
    assert.equal(r.state, FRESHNESS_STATE.BEHIND);
    assert.equal(r.upstream, 'origin/main');
  });

  it('the SUBJECT is a parameter — HEAD~1 is measured, not HEAD', () => {
    // `/audit-code`'s dirty-aware base is HEAD~1 on a clean tree. Measuring
    // HEAD and labelling it "the audit base" was the original conflation.
    const { origin, work } = makeClonePair();
    commit(origin, 'a.txt');
    g(work, ['fetch', '-q', 'origin']);
    g(work, ['merge', '-q', 'origin/main']);
    commit(work, 'local.txt');
    const atHead = resolveBaseFreshness({ repoRoot: work, subject: 'HEAD', upstream: 'origin/main' });
    const atPrev = resolveBaseFreshness({ repoRoot: work, subject: 'HEAD~1', upstream: 'origin/main' });
    assert.equal(atHead.behindBy, 0);
    assert.equal(atPrev.behindBy, 0, 'HEAD~1 is the merged upstream tip here');
    assert.equal(atPrev.subject, 'HEAD~1', 'the result names the ref it measured');
  });

  it('`HEAD~1@{u}` is a git ERROR — which is why the upstream is resolved separately', () => {
    // The finding that forced the design: `@{u}` is a suffix on a BRANCH NAME.
    // Asserted against real git so the claim cannot rot into folklore.
    const { work } = makeClonePair();
    const r = g(work, ['rev-parse', '--abbrev-ref', 'HEAD~1@{u}'], { allowFail: true });
    assert.notEqual(r.status, 0, 'if this ever succeeds, the separate resolution step can be simplified');
    assert.match(String(r.stderr), /no such branch|unknown revision|not a valid object/i);
  });
});

describe('resolveBaseFreshness — unknown is never collapsed into current', () => {
  it('a repo with NO upstream and no origin reports unknown/no-upstream', () => {
    // Not hypothetical: the branch this was developed on has no upstream.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-solo-'));
    _dirs.push(dir);
    g(dir, ['init', '-q', '-b', 'main']);
    g(dir, ['config', 'user.email', 't@example.com']);
    g(dir, ['config', 'user.name', 'T']);
    commit(dir, 'only.txt');
    const r = resolveBaseFreshness({ repoRoot: dir });
    assert.equal(r.state, FRESHNESS_STATE.UNKNOWN);
    assert.equal(r.reason, 'no-upstream');
  });

  it('outside a work tree reports unknown, not current', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-nogit-'));
    _dirs.push(dir);
    const r = resolveBaseFreshness({ repoRoot: dir });
    assert.equal(r.state, FRESHNESS_STATE.UNKNOWN);
    assert.equal(r.reason, 'not-a-work-tree');
  });

  it('a subject on UNRELATED history reports unknown, not a bogus distance', () => {
    // The default upstream is only meaningful for a subject on this branch.
    // An orphan branch shares no ancestry, so comparing it against the current
    // branch's upstream would produce a confidently wrong number.
    const { origin, work } = makeClonePair();
    commit(origin, 'a.txt');
    g(work, ['fetch', '-q', 'origin']);
    g(work, ['checkout', '-q', '--orphan', 'orphan']);
    fs.writeFileSync(path.join(work, 'o.txt'), 'o');
    g(work, ['add', 'o.txt']);
    g(work, ['commit', '-q', '-m', 'orphan']);
    const orphanSha = String(g(work, ['rev-parse', 'HEAD']).stdout).trim();
    g(work, ['checkout', '-q', 'main']);
    const r = resolveBaseFreshness({ repoRoot: work, subject: orphanSha });
    assert.equal(r.state, FRESHNESS_STATE.UNKNOWN);
    assert.equal(r.reason, 'subject-not-on-current-branch');
  });

  it('a BROKEN upstream is unresolvable, not a determinate absence', () => {
    // Code-audit R2 H1. git uses exit 128 for nearly everything fatal — "no
    // upstream configured" AND a corrupt ref store alike — so an exit-code
    // carve-out let a broken upstream read as "there is none" and license a
    // repair. The decision keys on the MESSAGE: only a recognised absence is
    // `none`; anything else non-zero is `unresolvable`.
    const { work } = makeClonePair();
    // Point the branch at an upstream that does not exist, so the lookup fails
    // for a reason that is NOT "no upstream configured".
    g(work, ['config', 'branch.main.merge', 'refs/heads/does-not-exist']);
    const r = resolveUpstreamRef({ repoRoot: work });
    assert.notEqual(r.source, 'none',
      'a configured-but-broken upstream must not read as a determinate absence');
  });

  it('an unresolvable subject reports unknown, not current', () => {
    const { work } = makeClonePair();
    const r = resolveBaseFreshness({ repoRoot: work, subject: 'no-such-ref-xyz', upstream: 'origin/main' });
    assert.equal(r.state, FRESHNESS_STATE.UNKNOWN);
    assert.equal(r.reason, 'subject-unresolvable');
  });

  it('an unresolvable UPSTREAM reports unknown, not current', () => {
    const { work } = makeClonePair();
    const r = resolveBaseFreshness({ repoRoot: work, upstream: 'origin/no-such-branch' });
    assert.equal(r.state, FRESHNESS_STATE.UNKNOWN);
    assert.equal(r.reason, 'upstream-unresolvable');
  });

  it('a SHALLOW clone reports unknown, not a plausible-looking count', () => {
    // Code-audit R1 H3. `rev-list --count` still returns an integer in a
    // truncated history, and a confidently wrong distance is the same
    // false-`current` direction as a collapsed unknown, wearing a number.
    const { origin } = makeClonePair();
    commit(origin, 'a.txt');
    commit(origin, 'b.txt');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-shallow-'));
    _dirs.push(root);
    // `--depth` is IGNORED for a plain local path (git clones in full and says
    // so), which would make this pass vacuously. A file:// URL forces the real
    // shallow transfer.
    const cloned = spawnSync('git', ['clone', '-q', '--depth', '1', pathToFileURL(origin).href, 'shallow'],
      { cwd: root, encoding: 'utf8' });
    assert.equal(cloned.status, 0, cloned.stderr);
    const shallow = path.join(root, 'shallow');
    assert.equal(String(g(shallow, ['rev-parse', '--is-shallow-repository']).stdout).trim(), 'true',
      'the fixture must actually be shallow, or this test asserts nothing');

    const r = resolveBaseFreshness({ repoRoot: shallow });
    assert.equal(r.state, FRESHNESS_STATE.UNKNOWN);
    assert.equal(r.reason, 'shallow-repository');
    assert.equal(r.behindBy, null, 'no distance may be reported from truncated history');
  });

  it('a COMPLETE repository is not mistaken for a shallow one', () => {
    // The direction the gate must NOT fire in. The probe demands a positive
    // `false`, so a regression that answered "unverified" for every healthy
    // repo would make the primitive permanently silent — a check that never
    // fires is indistinguishable from one that is not wired up.
    const { work } = makeClonePair();
    const r = resolveBaseFreshness({ repoRoot: work });
    assert.equal(r.state, FRESHNESS_STATE.CURRENT, r.reason || '');
  });
});

describe('git-freshness — the contracts the module DECLARES', () => {
  // These three are asserted against the SOURCE, deliberately and narrowly.
  // Each names a property whose failing scenario cannot be built inside
  // `npm run check`: a partial clone needs a server honouring
  // `uploadpack.allowFilter`, a translated diagnostic needs a locale that may
  // not be installed, and the OID race needs a concurrent writer between two
  // synchronous calls. Leaving them unasserted was the alternative, and the
  // module's own docstring already states all three as guarantees — an
  // unenforced guarantee is the shape this repo calls a fake check.
  const SRC = fs.readFileSync(new URL('../scripts/lib/git-freshness.mjs', import.meta.url), 'utf8');
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

  it('every git invocation pins the environment the NEVER-FETCHES contract needs', () => {
    // Code-audit R1 H4/M4: avoiding the word `fetch` does not keep the promise.
    // In a partial clone git lazily fetches a missing blob on demand, so
    // `git show <ref>:<path>` reaches the network with nobody writing "fetch".
    assert.match(CODE, /GIT_NO_LAZY_FETCH: '1'/,
      'without this a partial clone silently stalls on the network mid-gate');
    assert.match(CODE, /GIT_TERMINAL_PROMPT: '0'/,
      'a credential prompt in a gate hangs the push forever');
    assert.match(CODE, /LC_ALL: 'C'/,
      'any diagnostic this module surfaces must be greppable by an operator');
  });

  it('no decision reads git PROSE — only documented exit codes and stdout values', () => {
    // Code-audit R3 H1/M1. Two earlier versions classified by matching git's
    // stderr, and `git()` inherits the caller's locale, so a translated message
    // silently stops matching and a broken upstream reads as a determinate
    // absence — fail-open in the one direction this module exists to prevent.
    // A diagnostic is not an API; stdout values git documents (a config value,
    // a ref name, a count) are.
    assert.equal(/\.stderr/.test(CODE), false,
      'a classification branch reading .stderr is locale-dependent by construction');
  });

  it('the distance is counted between the PINNED OIDs, not the mutable ref names', () => {
    // Code-audit R1 H1/M3. The result NAMES subjectOid/upstreamOid so a caller
    // can bind a later mutation to them; a count that re-resolved `HEAD` and
    // `origin/main` would describe commits the result does not name. HEAD moved
    // 16 times in one sitting in this repo, so the window is not theoretical.
    assert.ok(CODE.includes('${subjectOid}..${upstreamOid}'),
      'rev-list must be given the resolved OIDs');
    assert.ok(!CODE.includes('${subject}..${upstreamRef}'),
      'counting between ref names re-resolves them after the snapshot was taken');

    // The behavioural half: the reported count describes the reported OIDs.
    const { origin, work } = makeClonePair();
    commit(origin, 'a.txt');
    commit(origin, 'b.txt');
    g(work, ['fetch', '-q', 'origin']);
    const f = resolveBaseFreshness({ repoRoot: work });
    const independent = Number(String(
      g(work, ['rev-list', '--count', `${f.subjectOid}..${f.upstreamOid}`]).stdout).trim());
    assert.equal(f.behindBy, independent,
      'the count must be the distance between the commits the result names');
  });
});

describe('resolveUpstreamRef — resolution order', () => {
  it('explicit wins, and is labelled as explicit', () => {
    const { work } = makeClonePair();
    assert.deepEqual(resolveUpstreamRef({ upstream: 'origin/main', repoRoot: work }),
      { ref: 'origin/main', display: 'origin/main', source: 'explicit', reason: null });
  });

  it("falls back to the CURRENT BRANCH's upstream", () => {
    const { work } = makeClonePair();
    const r = resolveUpstreamRef({ repoRoot: work });
    assert.equal(r.source, 'branch-upstream');
    assert.match(r.ref, /main$/);
  });

  it('falls back to origin/HEAD when the branch has no upstream', () => {
    const { work } = makeClonePair();
    g(work, ['checkout', '-q', '-b', 'topic']);   // a local branch, no upstream
    const r = resolveUpstreamRef({ repoRoot: work });
    assert.equal(r.source, 'origin-head', `got ${JSON.stringify(r)}`);
    // Code-audit R5 H1/H2: the fallback VERIFIES `refs/remotes/origin/<branch>`
    // and must RETURN that same name. Stripping the namespace hands back a
    // different, ambiguous identity than the one just checked. `source` alone
    // cannot see that, which is why the two fields are asserted by value.
    assert.equal(r.ref, 'refs/remotes/origin/main',
      'ref must be the fully qualified name rev-parse --verify was given');
    assert.equal(r.display, 'origin/main', 'display carries the readable short form');
  });

  it('a local branch literally named origin/main cannot hijack the fallback', () => {
    // The failing scenario behind R5 H1/H2, built rather than argued. git's ref
    // precedence puts refs/heads/ ABOVE refs/remotes/, so the short name
    // `origin/main` resolves to the local branch. Measured on this fixture: the
    // stripped name resolves to HEAD and the qualified one to the remote tip, so
    // a regression here reports `current` for a checkout that is genuinely behind
    // — the false-negative direction this whole module exists to close.
    const { origin, work } = makeClonePair();
    commit(origin, 'ahead.txt');
    g(work, ['fetch', '-q', 'origin']);
    g(work, ['checkout', '-q', '-b', 'topic']);
    g(work, ['branch', 'origin/main', 'HEAD']);
    const shortName = String(g(work, ['rev-parse', 'origin/main^{commit}']).stdout).trim();
    const qualified = String(g(work, ['rev-parse', 'refs/remotes/origin/main^{commit}']).stdout).trim();
    assert.notEqual(shortName, qualified,
      'the fixture must make the two names disagree, or this test asserts nothing');

    assert.equal(resolveUpstreamRef({ repoRoot: work }).ref, 'refs/remotes/origin/main');
    const f = resolveBaseFreshness({ repoRoot: work });
    assert.equal(f.state, FRESHNESS_STATE.BEHIND, f.reason || '');
    assert.equal(f.behindBy, 1, 'measured against the remote-tracking ref, not the local branch');
    assert.equal(f.upstreamOid, qualified);
  });

  it('a SLASHED branch name resolves its config key exactly', () => {
    // Code-audit R4 H1/M2: `symbolic-ref --short` returns a display
    // abbreviation, not necessarily the `branch.<name>.*` config subsection.
    // A wrong key reads as "not set", which reads as "no upstream configured"
    // — fail-open by a different route. This repo's own branches are
    // `claude/<something>`, so the slashed case is the normal one here.
    const { origin, work } = makeClonePair();
    g(work, ['checkout', '-q', '-b', 'claude/topic/deep']);
    g(work, ['push', '-q', '-u', 'origin', 'claude/topic/deep']);
    const r = resolveUpstreamRef({ repoRoot: work });
    assert.equal(r.source, 'branch-upstream', `got ${JSON.stringify(r)}`);
    assert.match(r.ref, /claude\/topic\/deep$/);
  });

  it('a DANGLING origin/HEAD is unresolvable, not a determinate absence', () => {
    // Code-audit R4 M1. One exit code cannot carry both "not configured" and
    // "configured but broken", so the fallback asks two questions.
    const { work } = makeClonePair();
    g(work, ['checkout', '-q', '-b', 'topic']);
    g(work, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone']);
    const r = resolveUpstreamRef({ repoRoot: work });
    assert.equal(r.source, 'unresolvable', `got ${JSON.stringify(r)}`);
    assert.match(r.reason, /does not resolve/);
  });

  it('reports none when there is genuinely nothing to compare against', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-none-'));
    _dirs.push(dir);
    g(dir, ['init', '-q', '-b', 'main']);
    g(dir, ['config', 'user.email', 't@example.com']);
    g(dir, ['config', 'user.name', 'T']);
    commit(dir, 'only.txt');
    assert.deepEqual(resolveUpstreamRef({ repoRoot: dir }), { ref: null, display: null, source: 'none', reason: null });
  });
});

describe('readFileAtRef — absent and unreadable are different facts', () => {
  it('reads a file that exists at the ref', () => {
    const { work } = makeClonePair();
    const r = readFileAtRef({ ref: 'origin/main', filePath: 'base.txt', repoRoot: work });
    assert.equal(r.status, 'read');
    assert.equal(r.content, 'x');
  });

  it('a file the ref does not have is ABSENT, not unreadable', () => {
    const { work } = makeClonePair();
    const r = readFileAtRef({ ref: 'origin/main', filePath: 'never-existed.json', repoRoot: work });
    assert.equal(r.status, 'absent', `got ${JSON.stringify(r)}`);
    assert.equal(r.content, null);
  });

  it('an unknown REF is unreadable, not absent — the distinction that matters', () => {
    // Collapsing this into `absent` is INC-001's lesson one level down: an
    // empty result from a failed read looks exactly like a clean upstream and
    // would route an operator into a repair they must not run.
    const { work } = makeClonePair();
    const r = readFileAtRef({ ref: 'origin/no-such-branch', filePath: 'base.txt', repoRoot: work });
    assert.equal(r.status, 'unreadable', `got ${JSON.stringify(r)}`);
    assert.ok(r.reason, 'an unreadable result must carry why');
  });

  it('no ref at all is unreadable', () => {
    const { work } = makeClonePair();
    assert.equal(readFileAtRef({ ref: null, filePath: 'base.txt', repoRoot: work }).status, 'unreadable');
  });
});

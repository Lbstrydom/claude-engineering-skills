/**
 * @fileoverview The pre-push archive lane (scripts/lib/prepush-archive-lane.mjs +
 * scripts/prepush-archive-lane.mjs). Plan: docs/plans/prepush-archive-lane.md.
 *
 * Real git throughout: a bare repo is the push DESTINATION and a work repo is the
 * pusher, because every defect the plan's audit found lived in how git behaves —
 * a root commit hidden by `log.showRoot=false`, an object list that names a blob
 * once, an advertised annotated tag, a deletion's all-zero sha — and a mock of git
 * would only encode what the author expected. Secret-shaped strings are assembled
 * at runtime so this file is not itself a finding.
 *
 * A NEGATIVE CONTROL PER FINDING KIND: a scan that cannot be seen to block proves
 * nothing, so each kind has a case that must block and a clean case that must not.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { git as runGit } from './lib/hook-test-helpers.mjs';
import { classifyPath } from '../scripts/lib/sensitive-paths.mjs';
import {
  ACK_MAX_FINDINGS,
  ARCHIVE_LANE_CHECK_CLASSIFICATION,
  LANE_SCANNERS,
  LIMITS,
  VARIANT_MAX_BYTES,
  ZERO_SHA,
  batchBySize,
  checkStepNames,
  decidePushLane,
  displayDestination,
  displayPath,
  establishRoots,
  fingerprintFindings,
  isArchiveRef,
  makeGit,
  parseObjectList,
  parsePushLines,
  parseRawLog,
  runArchiveLane,
  scanBodyPatterns,
  validateClassification,
} from '../scripts/lib/prepush-archive-lane.mjs';
import { expandedCheckScript } from '../scripts/lib/check-chain.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'prepush-archive-lane.mjs');
const HAS_GIT = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

// Assembled, never literal.
const GHP = `ghp_${'a1B2'.repeat(9)}`;
const PEM = ['-----BEGIN RSA', 'PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA', 'PRIVATE KEY-----\n'].join(' ');

// ── fixtures ────────────────────────────────────────────────────────────────

function withRepos(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-lane-'));
  try {
    const dest = path.join(base, 'dest.git');
    const work = path.join(base, 'work');
    runGit(['init', '-q', '--bare', dest]);
    runGit(['--git-dir', dest, 'symbolic-ref', 'HEAD', 'refs/heads/unused']); // so main can be deleted
    runGit(['init', '-q', '-b', 'main', work]);
    runGit(['config', 'user.email', 'fixture@example.invalid'], work);
    runGit(['config', 'user.name', 'Fixture'], work);
    const g = (args) => runGit(args, work);
    const api = {
      base, dest, work, g,
      commit(files, msg = 'c') {
        for (const [name, body] of Object.entries(files)) {
          fs.mkdirSync(path.dirname(path.join(work, name)), { recursive: true });
          fs.writeFileSync(path.join(work, name), body);
        }
        g(['add', '-A', '-f']);
        g(['commit', '-q', '-m', msg]);
        return g(['rev-parse', 'HEAD']);
      },
      push(refspec) { g(['push', '-q', '--no-verify', dest, refspec]); },
      line: (ref, sha, remoteSha = ZERO_SHA) => `${ref} ${sha} ${ref} ${remoteSha}`,
      lane(lines, opts = {}) {
        return runArchiveLane({ stdinText: `${[].concat(lines).join('\n')}\n`, destination: dest, git: makeGit(work), ...opts });
      },
    };
    api.commit({ 'README.md': 'seed\n' }, 'seed');
    api.push('main');
    return fn(api);
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

/** A branch under archive/ with one commit; returns the line for it. */
function archiveBranch(r, files, name = 'x', msg = 'archive') {
  r.g(['checkout', '-q', '-b', `archive/${name}`]);
  const sha = r.commit(files, msg);
  return r.line(`refs/heads/archive/${name}`, sha);
}

const text = (res) => res.lines.join('\n');
const skip = (t) => { if (!HAS_GIT) { t.skip('git is required'); return true; } return false; };

// ── the predicate ───────────────────────────────────────────────────────────

describe('decidePushLane — which pushes take the lane', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const decide = (...lines) => decidePushLane(parsePushLines(lines.join('\n')));

  it('an archive branch, an archive tag, and several of either take the lane', () => {
    assert.equal(decide(`refs/heads/archive/x ${A} refs/heads/archive/x ${ZERO_SHA}`).lane, 'archive');
    assert.equal(decide(`refs/tags/archive/t ${A} refs/tags/archive/t ${ZERO_SHA}`).lane, 'archive');
    const both = decide(`l ${A} refs/heads/archive/x ${ZERO_SHA}`, `l ${B} refs/tags/archive/t ${ZERO_SHA}`);
    assert.equal(both.lane, 'archive');
    assert.equal(both.tips.length, 2);
  });

  it('CONTROL: any other ref — updated or deleted — gets the full gate', () => {
    assert.equal(decide(`refs/heads/main ${A} refs/heads/main ${B}`).lane, 'full');
    assert.equal(decide(`refs/heads/archive/x ${A} refs/heads/archive/x ${ZERO_SHA}`, `refs/heads/main ${A} refs/heads/main ${B}`).lane, 'full');
    assert.equal(decide(`refs/heads/archive/x ${A} refs/heads/archive/x ${ZERO_SHA}`, `(delete) ${ZERO_SHA} refs/heads/old ${B}`).lane, 'full',
      'a non-archive DELETION makes the push mixed');
  });

  it('the DESTINATION decides, not the local ref', () => {
    assert.equal(decide(`refs/heads/main ${A} refs/heads/archive/x ${ZERO_SHA}`).lane, 'archive');
    assert.equal(decide(`refs/heads/archive/x ${A} refs/heads/main ${B}`).lane, 'full');
  });

  it('look-alikes are not archive refs', () => {
    for (const ref of ['refs/heads/archive', 'refs/heads/archive/', 'refs/heads/archived/x', 'refs/heads/x/archive/y', 'refs/remotes/origin/archive/x', 'refs/notes/archive/x']) {
      assert.equal(isArchiveRef(ref), false, ref);
    }
    assert.equal(isArchiveRef('refs/heads/archive/a/b'), true);
  });

  it('a deletion is never a tip, so a deleted archive ref cannot reach git as a bad object', () => {
    const d = decide(`refs/heads/archive/a ${A} refs/heads/archive/a ${ZERO_SHA}`, `(delete) ${ZERO_SHA} refs/heads/archive/b ${B}`);
    assert.equal(d.lane, 'archive');
    assert.deepEqual(d.tips.map((t) => t.sha), [A]);
    assert.ok(d.remoteShas.includes(B), 'the remote sha of the deleted ref is a known root');
  });

  it('empty, delete-only and malformed input are not the lane', () => {
    assert.equal(decide('').lane, 'full');
    assert.equal(decide(`(delete) ${ZERO_SHA} refs/heads/archive/x ${A}`).lane, 'full');
    assert.equal(decide('not a push line').lane, 'full');
  });
});

// ── pure helpers ────────────────────────────────────────────────────────────

describe('parsers and formatters', () => {
  it('parseRawLog reads -z records, skips deletions, keeps odd paths', () => {
    const o = 'a'.repeat(40);
    const z = '\u0000';
    const buf = Buffer.from([
      // The real shape, from `od -c`: a newline separates a header from its FIRST entry only.
      `${'c'.repeat(40)}${z}
`,
      `:000000 100644 ${'0'.repeat(40)} ${o} A${z}dir/a b.txt${z}`,
      `:100644 000000 ${o} ${'0'.repeat(40)} D${z}gone.txt${z}`,
      `${'d'.repeat(40)}${z}${z}`,
      `:100644 100644 ${o} ${o} M${z}line\nbreak${z}`,
    ].join(''));
    const got = parseRawLog(buf);
    assert.deepEqual(got.map((e) => e.path), ['dir/a b.txt', 'line\nbreak']);
    assert.throws(() => parseRawLog(Buffer.from(`:000000 100644 ${o} ${o} A${z}`)), /parse/);
  });

  it('parseObjectList tolerates a path with a newline and rejects leading garbage', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    assert.deepEqual(parseObjectList(`${a}\n${b} x/y z\n`).map((o) => o.path), ['', 'x/y z']);
    assert.equal(parseObjectList(`${b} p\nrest\n`)[0].path, 'p\nrest');
    assert.throws(() => parseObjectList('garbage\n'), /parse/);
  });

  it('batchBySize never puts more than the budget in a batch', () => {
    const items = [{ size: 5 }, { size: 5 }, { size: 5 }, { size: 20 }];
    const batches = batchBySize(items, 10);
    assert.deepEqual(batches.map((b) => b.length), [2, 1, 1]);
  });

  it('displayPath redacts a sensitive path and nothing else; control characters are escaped', () => {
    assert.match(displayPath('secrets/prod.txt'), /^\[redacted:[0-9a-f]{8}\]\.txt$/);
    assert.equal(displayPath('src/app.mjs'), 'src/app.mjs');
    assert.equal(displayPath('a\nb.txt'), 'a\\x0ab.txt');
    assert.equal(displayPath(''), '');
  });

  it('displayDestination strips userinfo and query values', () => {
    const d = displayDestination('https://user:s3cr3t@example.com/org/repo.git?token=tok3n#frag');
    assert.ok(!d.includes('s3cr3t') && !d.includes('tok3n') && !d.includes('user:'), d);
    assert.match(d, /example\.com\/org\/repo\.git/);
    assert.ok(!displayDestination('git@github.com:org/repo.git').includes('git@'));
    assert.equal(displayDestination('C:\\repos\\dest.git'), 'C:\\repos\\dest.git'.replace(/[\u0000-\u001f]/g, ''));
  });

  it('fingerprint: order-independent, path-sensitive, object-sensitive', () => {
    const f = (o) => ({ kind: 'path', objType: 'blob', oid: 'a'.repeat(40), path: '.env', detail: 'sensitive-path', ...o });
    const a = f({});
    const b = f({ path: 'x/.env' });
    assert.equal(fingerprintFindings([a, b]), fingerprintFindings([b, a]));
    assert.notEqual(fingerprintFindings([a]), fingerprintFindings([b]), 'the same blob at another path is another finding');
    assert.notEqual(fingerprintFindings([a, b]), fingerprintFindings([a]));
    assert.equal(fingerprintFindings([a, a]), fingerprintFindings([a]), 'duplicates collapse');
    assert.match(fingerprintFindings([a]), /^[0-9a-f]{12}$/);
  });
});

// ── the scan, against real git ──────────────────────────────────────────────

describe('scan — a negative control for every finding kind', () => {
  it('a clean archive branch is clean', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      const res = r.lane(archiveBranch(r, { 'src/a.mjs': 'export const a = 1;\n' }));
      assert.equal(res.outcome, 'clean', text(res));
      assert.ok(res.stats.objects > 0 && res.stats.scanned > 0, 'something was actually scanned');
    });
  });

  it('PATH: a committed .env blocks, and its name is not printed', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      const res = r.lane(archiveBranch(r, { '.env': 'A=1\n', 'secrets/prod.txt': 'x\n' }));
      assert.equal(res.outcome, 'findings');
      const kinds = res.findings.filter((f) => f.kind === 'path').map((f) => f.path).sort();
      assert.deepEqual(kinds, ['.env', 'secrets/prod.txt']);
      assert.ok(!/secrets\//.test(text(res)), 'a sensitive directory name reached the output');
      assert.match(text(res), /\[redacted:[0-9a-f]{8}\]/);
    });
  });

  it('SECRET: a PEM block and a token block, and the matched text is never printed', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      const res = r.lane(archiveBranch(r, { 'lib/k.mjs': `export const k = \`${PEM}\`;\n`, 'lib/t.mjs': `const t = '${GHP}';\n` }));
      assert.equal(res.outcome, 'findings');
      const patterns = res.findings.map((f) => f.detail).sort();
      assert.deepEqual(patterns, ['github-pat', 'pem-private-key']);
      assert.ok(!text(res).includes(GHP) && !text(res).includes('MIIBOgIBAAJBAKj34'), 'matched text reached the output');
    });
  });

  it('UNSCANNED: an oversize blob, commit message and tag message each block (limit injected)', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      const limits = { ...LIMITS, maxObjectBytes: 500 };
      const big = 'z'.repeat(2000);
      r.g(['checkout', '-q', '-b', 'archive/big']);
      fs.writeFileSync(path.join(r.work, 'big.bin'), big);
      r.g(['add', '-A', '-f']);
      fs.writeFileSync(path.join(r.base, 'msg.txt'), `${big}\n`);
      r.g(['commit', '-q', '-F', path.join(r.base, 'msg.txt')]);
      r.g(['tag', '-a', 'archive/bigtag', '-F', path.join(r.base, 'msg.txt')]);
      const lines = [
        r.line('refs/heads/archive/big', r.g(['rev-parse', 'HEAD'])),
        r.line('refs/tags/archive/bigtag', r.g(['rev-parse', 'archive/bigtag'])),
      ];
      const res = r.lane(lines, { limits });
      assert.equal(res.outcome, 'findings', text(res));
      const types = res.findings.filter((f) => f.kind === 'unscanned').map((f) => f.objType).sort();
      assert.deepEqual(types, ['blob', 'commit', 'tag']);
    });
  });
});

describe('scan — path coverage is independent of the object list (plan §1.6)', () => {
  it('one blob under an ordinary and a sensitive path flags the sensitive one', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      const res = r.lane(archiveBranch(r, { 'notes.txt': 'same\n', '.env': 'same\n' }));
      assert.equal(res.outcome, 'findings');
      assert.deepEqual(res.findings.map((f) => f.path), ['.env']);
    });
  });

  it('a new sensitive path whose blob the DESTINATION already holds still flags', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      r.commit({ 'data.txt': 'shared body\n' }, 'data');
      r.push('main');
      const res = r.lane(archiveBranch(r, { '.env': 'shared body\n' }));
      assert.equal(res.outcome, 'findings', 'the blob is excluded from the object list; the path must not be');
      assert.deepEqual(res.findings.map((f) => f.path), ['.env']);
    });
  });

  it('a ROOT commit carrying .env blocks even with log.showRoot=false in the pusher config', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      r.g(['config', 'log.showRoot', 'false']);
      r.g(['checkout', '-q', '--orphan', 'archive/root']);
      r.g(['rm', '-rfq', '.']);
      const sha = r.commit({ '.env': 'K=v\n' }, 'root');
      const res = r.lane(r.line('refs/heads/archive/root', sha));
      assert.equal(res.outcome, 'findings', text(res));
      assert.ok(res.findings.some((f) => f.kind === 'path' && f.path === '.env'));
      // The clean control under the same config.
      r.g(['checkout', '-q', '--orphan', 'archive/root2']);
      r.g(['rm', '-rfq', '.']);
      const clean = r.commit({ 'ok.txt': 'fine\n' }, 'root2');
      assert.equal(r.lane(r.line('refs/heads/archive/root2', clean)).outcome, 'clean');
    });
  });

  it('a path introduced only by a MERGE commit flags', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      r.g(['checkout', '-q', '-b', 'archive/m']);
      r.commit({ 'a.txt': 'a\n' }, 'a');
      r.g(['checkout', '-q', '-b', 'side', 'main']);
      r.commit({ 'b.txt': 'b\n' }, 'b');
      r.g(['checkout', '-q', 'archive/m']);
      r.g(['merge', '-q', '--no-ff', '--no-commit', 'side']);
      fs.writeFileSync(path.join(r.work, '.env'), 'evil\n');
      r.g(['add', '-A', '-f']);
      r.g(['commit', '-q', '-m', 'merge']);
      const res = r.lane(r.line('refs/heads/archive/m', r.g(['rev-parse', 'HEAD'])));
      assert.equal(res.outcome, 'findings');
      assert.ok(res.findings.some((f) => f.path === '.env'));
    });
  });

  it('a sensitive filename with a secret body is redacted on BOTH of its findings', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      const res = r.lane(archiveBranch(r, { 'credentials.json': `{"t":"${GHP}"}\n` }));
      assert.equal(res.outcome, 'findings');
      assert.deepEqual(res.findings.map((f) => f.kind).sort(), ['path', 'secret']);
      assert.ok(!/credentials/.test(text(res)), 'the raw sensitive filename reached the output');
      assert.ok(!text(res).includes(GHP));
    });
  });
});

describe('scan — tags', () => {
  const tagLine = (r, name) => r.line(`refs/tags/archive/${name}`, r.g(['rev-parse', `archive/${name}`]));

  it('a clean annotated tag passes; a secret in the annotation blocks', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      archiveBranch(r, { 'a.txt': 'a\n' });
      r.g(['tag', '-a', 'archive/clean', '-m', 'a clean annotation']);
      assert.equal(r.lane(tagLine(r, 'clean')).outcome, 'clean');
      r.g(['tag', '-a', 'archive/dirty', '-m', `oops ${GHP}`]);
      const res = r.lane(tagLine(r, 'dirty'));
      assert.equal(res.outcome, 'findings');
      assert.ok(res.findings.some((f) => f.objType === 'tag' && f.detail === 'github-pat'));
    });
  });

  it('a nested annotated tag has BOTH messages scanned', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      archiveBranch(r, { 'a.txt': 'a\n' });
      r.g(['tag', '-a', 'archive/inner', '-m', `inner ${GHP}`]);
      r.g(['tag', '-a', 'archive/outer', '-m', 'outer is clean', 'archive/inner']);
      const res = r.lane(tagLine(r, 'outer'));
      assert.equal(res.outcome, 'findings', 'the inner tag object is only reachable from the TIP, not the peeled commit');
    });
  });

  it('a tag of a tree is an error, not clean', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      archiveBranch(r, { 'a.txt': 'a\n' });
      r.g(['tag', '-a', 'archive/tree', '-m', 'tree tag', 'HEAD^{tree}']);
      const res = r.lane(tagLine(r, 'tree'));
      assert.equal(res.outcome, 'error');
      assert.match(text(res), /tip-not-commit/);
    });
  });
});

describe('roots — what the DESTINATION holds, not what a tracking ref says (plan §1.4)', () => {
  it('an advertised annotated tag is kept as the root and its history is not re-scanned', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      r.commit({ 'old.txt': 'old\n' }, 'old');
      r.g(['tag', '-a', 'v1', '-m', 'v1']);
      r.g(['push', '-q', '--no-verify', r.dest, 'refs/tags/v1']);
      r.g(['push', '-q', '--no-verify', r.dest, ':refs/heads/main']);
      const tagId = r.g(['rev-parse', 'v1']);
      const roots = establishRoots(makeGit(r.work), r.dest, []);
      assert.ok(roots.includes(tagId), 'the ADVERTISED id (the tag object) must be the root, not its peeled commit');
      const res = r.lane(archiveBranch(r, { 'new.txt': 'n\n' }));
      assert.equal(res.outcome, 'clean');
      assert.ok(res.stats.objects <= 6, `history behind the advertised tag was re-listed: ${res.stats.objects} objects`);
    });
  });

  it('a destination with thousands of refs does not fail on argument length', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      const main = r.g(['rev-parse', 'main']);
      const cmds = Array.from({ length: 3000 }, (_, i) => `create refs/heads/bulk/branch-with-a-long-name-${i} ${main}`).join('\n');
      const u = spawnSync('git', ['--git-dir', r.dest, 'update-ref', '--stdin'], { input: `${cmds}\n`, encoding: 'utf8' });
      assert.equal(u.status, 0, u.stderr);
      const res = r.lane(archiveBranch(r, { 'a.txt': 'a\n' }));
      assert.equal(res.outcome, 'clean', text(res));
      assert.ok(res.stats.roots >= 1);
    });
  });

  it('STALE tracking refs are ignored: history the destination lacks is scanned', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      r.g(['checkout', '-q', '-b', 'local-only']);
      const leaked = r.commit({ '.env': 'S=1\n' }, 'never pushed');
      r.g(['update-ref', 'refs/remotes/origin/local-only', leaked]); // a tracking ref the destination never had
      r.g(['checkout', '-q', '-b', 'archive/y']);
      const sha = r.commit({ 'ok.txt': 'ok\n' }, 'on top');
      const res = r.lane(r.line('refs/heads/archive/y', sha));
      assert.equal(res.outcome, 'findings', 'a tracking ref must not exclude what the destination does not hold');
      assert.ok(res.findings.some((f) => f.path === '.env'));
    });
  });

  it('the destination ARGUMENT decides: the same push is clean against one repo and blocked against an empty one', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      r.commit({ '.env': 'S=1\n' }, 'holds a .env');
      r.push('main'); // the destination now holds it
      const line = archiveBranch(r, { 'ok.txt': 'ok\n' });
      assert.equal(r.lane(line).outcome, 'clean');
      const other = path.join(r.base, 'other.git');
      runGit(['init', '-q', '--bare', other]);
      const res = runArchiveLane({ stdinText: `${line}\n`, destination: other, git: makeGit(r.work) });
      assert.equal(res.outcome, 'findings', 'an empty destination holds nothing, so everything is published');
    });
  });

  it('a push that updates one archive ref and deletes another scans the update only', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      const main = r.g(['rev-parse', 'main']);
      const upd = archiveBranch(r, { 'a.txt': 'a\n' }, 'a');
      const res = r.lane([upd, `(delete) ${ZERO_SHA} refs/heads/archive/b ${main}`]);
      assert.equal(res.outcome, 'clean', text(res));
    });
  });

  it('re-pushing what the destination already holds says so, in words a scan does not use', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      const line = archiveBranch(r, { 'a.txt': 'a\n' });
      r.push('archive/x:refs/heads/archive/x');
      const sha = line.split(' ')[1];
      const res = r.lane(r.line('refs/heads/archive/x', sha, sha));
      assert.equal(res.outcome, 'clean');
      assert.equal(res.stats.objects, 0);
      assert.match(text(res), /already holds everything/);
    });
  });
});

// ── failure policy: an eligible push that cannot be scanned is refused ──────

describe('errors — an incomplete scan is never clean, and never leaks a credential', () => {
  it('an unreachable destination is an error and prints no credentials', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      const line = archiveBranch(r, { 'a.txt': 'a\n' });
      const res = runArchiveLane({ stdinText: `${line}\n`, destination: 'https://user:s3cr3t@127.0.0.1:1/x.git?token=tok3n', git: makeGit(r.work) });
      assert.equal(res.outcome, 'error');
      assert.match(text(res), /ls-remote-failed/);
      assert.ok(!text(res).includes('s3cr3t') && !text(res).includes('tok3n'), text(res));
      assert.match(text(res), /127\.0\.0\.1/);
    });
  });

  it('a git runner that throws an exception echoing a credential yields a sanitized error', () => {
    const stdinText = `refs/heads/archive/x ${'a'.repeat(40)} refs/heads/archive/x ${ZERO_SHA}\n`;
    const res = runArchiveLane({ stdinText, destination: 'https://u:tok@h/x.git', git: () => { throw new Error('boom https://u:tok@h/x.git'); } });
    assert.equal(res.outcome, 'error');
    assert.ok(!text(res).includes('tok@') && !text(res).includes('boom'), text(res));
    assert.match(text(res), /internal/);
  });

  it('a hostile destination beginning with - is not an option to git', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      const marker = path.join(r.base, 'pwned');
      const line = archiveBranch(r, { 'a.txt': 'a\n' });
      const res = runArchiveLane({ stdinText: `${line}\n`, destination: `--upload-pack=touch ${marker}`, git: makeGit(r.work) });
      assert.equal(res.outcome, 'error');
      assert.equal(fs.existsSync(marker), false, 'git executed the destination as an option');
    });
  });

  it('the object cap, the time budget and a buffer overflow each end in error', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      const line = archiveBranch(r, { 'a.txt': 'a\n' });
      const cap = r.lane(line, { limits: { ...LIMITS, maxObjects: 1 } });
      assert.equal(cap.outcome, 'error');
      assert.match(text(cap), /object-cap/);

      let calls = 0;
      const budget = r.lane(line, { now: () => (calls++ === 0 ? 0 : LIMITS.budgetMs + 1), limits: LIMITS });
      assert.equal(budget.outcome, 'error');
      assert.match(text(budget), /time-budget/);

      const real = makeGit(r.work);
      const overflow = r.lane(line, { git: (args, o) => (args[0] === 'rev-list' ? { ok: false, code: 'buffer', stdout: Buffer.alloc(0) } : real(args, o)) });
      assert.equal(overflow.outcome, 'error');
      assert.match(text(overflow), /buffer/);
    });
  });

  it('ACCOUNTING: a dropped metadata line and a truncated body are errors', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      const line = archiveBranch(r, { 'a.txt': 'a\n' });
      const real = makeGit(r.work);
      const dropped = r.lane(line, {
        git: (args, o) => {
          const out = real(args, o);
          if (args[0] === 'cat-file' && String(args[1]).startsWith('--batch-check=')) {
            return { ...out, stdout: Buffer.from(out.stdout.toString('utf8').split('\n').slice(1).join('\n')) };
          }
          return out;
        },
      });
      assert.equal(dropped.outcome, 'error');
      assert.match(text(dropped), /accounting/);

      const truncated = r.lane(line, {
        git: (args, o) => {
          const out = real(args, o);
          return args[0] === 'cat-file' && args[1] === '--batch' ? { ...out, stdout: out.stdout.subarray(0, out.stdout.length - 5) } : out;
        },
      });
      assert.equal(truncated.outcome, 'error');
      assert.match(text(truncated), /accounting/);
    });
  });

  it('ACCOUNTING: a mixed set — scanned, excluded tree, oversized — adds up and reports findings, not an error', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      const res = r.lane(archiveBranch(r, { 'dir/small.txt': 'small\n', 'dir/big.bin': 'z'.repeat(2000) }), { limits: { ...LIMITS, maxObjectBytes: 500 } });
      assert.equal(res.outcome, 'findings');
      assert.ok(res.stats.scanned > 0 && res.stats.excluded > 0 && res.stats.unscanned > 0, JSON.stringify(res.stats));
      assert.equal(res.stats.scanned + res.stats.excluded + res.stats.unscanned, res.stats.objects);
    });
  });
});

// ── acknowledgement ─────────────────────────────────────────────────────────

describe('acknowledgement — exact, never blanket', () => {
  it('the printed fingerprint acknowledges that set; a different one blocks and says what it should be', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      const line = archiveBranch(r, { 'lib/t.mjs': `const t = '${GHP}';\n` });
      const blocked = r.lane(line);
      assert.equal(blocked.outcome, 'findings');
      assert.match(text(blocked), /PowerShell:\s+\$env:AUDIT_ARCHIVE_LANE_ACK = '[0-9a-f]{12}'/);
      assert.match(text(blocked), /bash:\s+AUDIT_ARCHIVE_LANE_ACK=[0-9a-f]{12}/);
      assert.doesNotMatch(text(blocked), /<[a-z-]+>/, 'angle-bracket placeholders are unpasteable in PowerShell');

      const ok = r.lane(line, { ack: blocked.fingerprint });
      assert.equal(ok.outcome, 'clean');
      assert.match(text(ok), /acknowledged/);

      const wrong = r.lane(line, { ack: 'deadbeef0000' });
      assert.equal(wrong.outcome, 'findings');
      assert.match(text(wrong), new RegExp(`it is ${blocked.fingerprint}`));
    });
  });

  it('an acknowledgement for one set does not cover a larger one', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      const first = r.lane(archiveBranch(r, { 'lib/t.mjs': `const t = '${GHP}';\n` }));
      r.commit({ '.env': 'K=v\n' }, 'more');
      const second = r.lane(r.line('refs/heads/archive/x', r.g(['rev-parse', 'HEAD'])), { ack: first.fingerprint });
      assert.equal(second.outcome, 'findings');
    });
  });
});

// ── code-audit round 1 (audit-code-1791746397) ──────────────────────────────

describe('what the scan reads is what the push sends', () => {
  it('a git replace ref cannot hide content from the scan (pack-objects ignores replacements)', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      r.g(['checkout', '-q', '-b', 'archive/rep']);
      const clean = r.commit({ 'ok.txt': 'ok\n' }, 'clean');
      const dirty = r.commit({ '.env': 'K=v\n', 'lib/t.mjs': `const t = '${GHP}';\n` }, 'dirty');
      r.g(['replace', '--force', dirty, clean]); // rev-list/cat-file would now answer with `clean`
      const res = r.lane(r.line('refs/heads/archive/rep', dirty));
      assert.equal(res.outcome, 'findings', 'the scan followed the replacement and read the substitute');
      assert.ok(res.findings.some((f) => f.path === '.env'));
      assert.ok(res.findings.some((f) => f.detail === 'github-pat'));
    });
  });
});

describe('diagnostics never carry a secret, even in a path that is not sensitive', () => {
  it('a token in a FILENAME is redacted from the output', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      const named = `ghp_${'Zz9Y'.repeat(9)}`;
      const body = `ghp_${'Qq8W'.repeat(9)}`;
      const res = r.lane(archiveBranch(r, { [`notes/${named}.txt`]: `const t = '${body}';\n` }));
      assert.equal(res.outcome, 'findings');
      assert.ok(!text(res).includes(named), 'the token in the filename reached the output');
      assert.ok(!text(res).includes(body));
    });
  });
});

describe('the raw-log parser fails closed on a record it cannot read', () => {
  it('a combined-diff `::` record is a parse error, not a skipped path', () => {
    const sha = 'a'.repeat(40);
    const z = '\u0000';
    const combined = Buffer.from(`${sha}${z}\n::100644 100644 100644 ${sha} ${sha} ${sha} MM${z}.env${z}`);
    assert.throws(() => parseRawLog(combined), /parse/);
  });
});

describe('one deadline governs every git call', () => {
  it('each git call is handed the time that remains, as its own timeout', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      const real = makeGit(r.work);
      const timeouts = [];
      const res = r.lane(archiveBranch(r, { 'a.txt': 'a\n' }), {
        git: (args, o = {}) => { timeouts.push([args[0], o.timeout]); return real(args, o); },
      });
      assert.equal(res.outcome, 'clean', text(res));
      assert.ok(timeouts.length >= 5, 'the probe saw the calls');
      for (const [cmd, ms] of timeouts) {
        assert.ok(Number.isFinite(ms) && ms > 0 && ms <= LIMITS.budgetMs, `${cmd} ran with timeout ${ms}`);
      }
    });
  });

  it('a final batch that overruns the budget is an error, not a clean (nothing after it would notice)', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      const real = makeGit(r.work);
      let clock = 0;
      const res = r.lane(archiveBranch(r, { 'a.txt': 'a\n' }), {
        now: () => clock,
        git: (args, o) => {
          const out = real(args, o);
          if (args[0] === 'cat-file' && args[1] === '--batch') clock += LIMITS.budgetMs + 1; // the LAST batch is slow
          return out;
        },
      });
      assert.equal(res.outcome, 'error', text(res));
      assert.match(text(res), /time-budget/);
    });
  });
});

describe('an acknowledgement covers only what was shown', () => {
  it('above the cap no acknowledgement is offered, and a matching fingerprint is not accepted', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      const files = Object.fromEntries(Array.from({ length: ACK_MAX_FINDINGS + 10 }, (_, i) => [`secrets/f${i}.txt`, `${i}\n`]));
      const line = archiveBranch(r, files);
      const blocked = r.lane(line);
      assert.equal(blocked.outcome, 'findings');
      assert.equal(blocked.findings.length, ACK_MAX_FINDINGS + 10);
      assert.match(text(blocked), /Too many findings to acknowledge/);
      assert.match(text(blocked), /10 more not shown/);
      assert.doesNotMatch(text(blocked), /AUDIT_ARCHIVE_LANE_ACK =|AUDIT_ARCHIVE_LANE_ACK=/, 'a command to approve unseen findings was offered');
      const forced = r.lane(line, { ack: blocked.fingerprint });
      assert.equal(forced.outcome, 'findings', 'a fingerprint over unseen findings was accepted');
    });
  });

  it('at or below the cap EVERY finding is listed', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      const files = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`secrets/g${i}.txt`, `${i}\n`]));
      const res = r.lane(archiveBranch(r, files));
      assert.equal(res.findings.length, 12);
      assert.equal(res.lines.filter((l) => /^ {3}path /.test(l)).length, 12);
      assert.doesNotMatch(text(res), /more not shown/);
    });
  });
});

// ── the adversarial review of the hook (2026-10-12) ─────────────────────────

describe('stdin parsing finds its fields from the right (whitespace inside a ref)', () => {
  const A = 'a'.repeat(40);
  const Z = ZERO_SHA;
  const decide = (text) => decidePushLane(parsePushLines(text));

  it('a LOCAL ref with spaces is one field, and the push is still an archive push', () => {
    for (const local of ['HEAD@{2 minutes ago}', 'HEAD^{/add backup}', 'refs/heads/two words']) {
      const p = parsePushLines(`${local} ${A} refs/heads/archive/x ${Z}\n`);
      assert.equal(p.malformed, 0, local);
      assert.equal(p.entries[0].localRef, local);
      assert.equal(decidePushLane(p).lane, 'archive', local);
    }
  });

  it('a REMOTE ref holding U+00A0 or another non-ASCII space is one ref name', () => {
    for (const ch of ['\u00a0', '\u2003', '\u3000', '\ufeff']) {
      const ref = `refs/heads/archive/a${ch}b`;
      const p = parsePushLines(`refs/heads/local ${A} ${ref} ${Z}\n`);
      assert.equal(p.entries[0]?.remoteRef, ref, JSON.stringify(ch));
      assert.equal(isArchiveRef(ref), true);
      assert.equal(decidePushLane(p).lane, 'archive');
    }
  });

  it('CONTROL: spaces do not turn an ordinary push into an archive push', () => {
    assert.equal(decide(`HEAD@{2 minutes ago} ${A} refs/heads/main ${Z}\n`).lane, 'full');
    assert.equal(decide(`refs/heads/local ${A} refs/heads/main\u00a0archive/x ${Z}\n`).lane, 'full');
  });

  it('a line it cannot read that MENTIONS archive/ is refused, not "not applicable"', () => {
    assert.equal(decide('garbage mentioning archive/x\n').lane, 'refuse');
    assert.equal(decide(`refs/heads/archive/x ${A} refs/heads/archive/x\n`).lane, 'refuse', 'a missing field');
    assert.equal(decide('garbage\n').lane, 'full', 'unreadable but unrelated stays the full gate');
  });

  it('runArchiveLane turns a refuse into an error outcome that names the override', () => {
    const res = runArchiveLane({ stdinText: 'garbage mentioning archive/x\n', destination: 'unused', git: () => { throw new Error('must not run git'); } });
    assert.equal(res.outcome, 'error');
    assert.match(res.lines.join('\n'), /AUDIT_PREPUSH_ARCHIVE_LANE=0/);
  });

  it('end to end against real git: a spaced local source with a dirty tree is scanned and blocked', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      const [, sha] = archiveBranch(r, { '.env': 'K=v\n' }).split(' ');
      const res = r.lane(`HEAD@{2 minutes ago} ${sha} refs/heads/archive/x ${ZERO_SHA}`);
      assert.equal(res.outcome, 'findings', text(res));
    });
  });
});

describe('scan coverage: the places a secret hid from the first version', () => {
  const ghp = `ghp_${'Zz9Y'.repeat(9)}`;
  const pem = ['-----BEGIN RSA', 'PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA', 'PRIVATE KEY-----\n'].join(' ');
  const patterns = (body, size = body.length) => scanBodyPatterns(body, size);

  it('UTF-16 text (what PowerShell > writes), a JSON-escaped PEM, a comment-prefixed PEM, an npm token', () => {
    const utf16 = Buffer.from(`const t = '${ghp}';`, 'utf16le').toString('latin1');
    const json = `{"private_key": "${pem.replace(/\n/g, '\\n')}"}`;
    const commented = pem.split('\n').map((l) => `# ${l}`).join('\n');
    assert.deepEqual(patterns(utf16), ['github-pat']);
    assert.deepEqual(patterns(json), ['pem-private-key']);
    assert.deepEqual(patterns(commented), ['pem-private-key']);
    assert.deepEqual(patterns(`//registry.npmjs.org/:_authToken=npm_${'Qq8W'.repeat(9)}`), ['npm-token']);
  });

  it('CONTROL: the variants find nothing in ordinary text, escaped text and comments', () => {
    assert.deepEqual(patterns('hello world\n'), []);
    assert.deepEqual(patterns('# a comment\n// another\nline one\\nline two\n'), []);
    assert.deepEqual(patterns(Buffer.from('plain utf16 text', 'utf16le').toString('latin1')), []);
  });

  it('variants are skipped above the size bound, so a big file cannot multiply the scan time', () => {
    const json = `{"k":"${pem.replace(/\n/g, '\\n')}"}`;
    assert.deepEqual(patterns(json, VARIANT_MAX_BYTES + 1), [], 'a variant ran on an oversize body');
    assert.deepEqual(patterns(json, VARIANT_MAX_BYTES), ['pem-private-key']);
  });

  it('credential stores with no secret-shaped name are sensitive paths', () => {
    for (const p of ['.git-credentials', 'home/.netrc', '_netrc', 'a/.pgpass', '.pypirc', '.htpasswd', 'x.keystore', 'a/B.JKS', 'terraform.tfvars', 'infra/prod.auto.tfvars']) {
      assert.equal(classifyPath(p), 'sensitive', p);
    }
    for (const p of ['README.md', 'src/tfvars.mjs', 'terraform.tfvars.example', 'docs/netrc-notes.md']) {
      assert.equal(classifyPath(p), null, `${p} must stay unclassified`);
    }
  });

  it('end to end against real git: each of them blocks a real archive push', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      const res = r.lane(archiveBranch(r, {
        '.git-credentials': 'https://user:pass@github.com\n',
        'cfg/service-account.json': `{"private_key": "${pem.replace(/\n/g, '\\n')}"}\n`,
        '.npmrc': `//registry.npmjs.org/:_authToken=npm_${'Qq8W'.repeat(9)}\n`,
      }));
      assert.equal(res.outcome, 'findings', text(res));
      const kinds = res.findings.map((f) => `${f.kind}:${f.detail}`).sort();
      assert.ok(kinds.includes('path:sensitive-path'), kinds.join());
      assert.ok(kinds.includes('secret:pem-private-key'), kinds.join());
      assert.ok(kinds.includes('secret:npm-token'), kinds.join());
    });
  });
});

// ── the classification of `check` is executable ─────────────────────────────

describe('ARCHIVE_LANE_CHECK_CLASSIFICATION', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const steps = checkStepNames(expandedCheckScript(pkg.scripts));

  it('classifies every step of check and names no step check lacks (both directions)', () => {
    assert.ok(steps.length >= 30, `parsed ${steps.length} steps: the census itself must not be vacuous`);
    assert.deepEqual(validateClassification(ARCHIVE_LANE_CHECK_CLASSIFICATION, steps), []);
  });

  it('CONTROL: a new step with no entry is reported, and so is a stale entry', () => {
    assert.match(validateClassification(ARCHIVE_LANE_CHECK_CLASSIFICATION, [...steps, 'secrets:gate']).join('\n'), /"secrets:gate" has no entry/);
    assert.match(validateClassification(ARCHIVE_LANE_CHECK_CLASSIFICATION, steps.slice(1)).join('\n'), /not a step of check/);
  });

  it('CONTROL: a publication-safety step cannot be added by editing the table alone', () => {
    const table = { ...ARCHIVE_LANE_CHECK_CLASSIFICATION, 'secrets:gate': { cls: 'P', reason: 'scans pushed content' } };
    const problems = validateClassification(table, [...steps, 'secrets:gate']).join('\n');
    assert.match(problems, /"secrets:gate" is class P/);
    const mapped = { ...table, 'secrets:gate': { cls: 'P', reason: 'scans pushed content', laneScanner: LANE_SCANNERS[0] } };
    assert.deepEqual(validateClassification(mapped, [...steps, 'secrets:gate']), []);
    const bogus = { ...table, 'secrets:gate': { cls: 'P', reason: 'x', laneScanner: 'nope' } };
    assert.match(validateClassification(bogus, [...steps, 'secrets:gate']).join('\n'), /names no lane scanner/);
  });

  it('rejects an unknown class and an empty reason', () => {
    const problems = validateClassification({ a: { cls: 'Z', reason: ' ' } }, ['a']).join('\n');
    assert.match(problems, /class must be/);
    assert.match(problems, /reason is empty/);
  });

  it('records no class P today — check has no publication-safety step (plan §1.2)', () => {
    assert.deepEqual(Object.values(ARCHIVE_LANE_CHECK_CLASSIFICATION).filter((e) => e.cls === 'P'), []);
  });
});

// ── the CLI and its protocol ────────────────────────────────────────────────

describe('CLI', () => {
  const run = (args, input, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, input, encoding: 'utf8', env: { ...process.env, AUDIT_ARCHIVE_LANE_ACK: '' } });

  it('--selfcheck-relocation answers OK', () => {
    const r = spawnSync(process.execPath, [CLI, '--selfcheck-relocation'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'OK');
  });

  it('writes exactly one protocol line to stdout, last, and the prose to stderr', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      const line = archiveBranch(r, { 'a.txt': 'a\n' });
      const clean = run([`--remote=origin`, `--destination=${r.dest}`], `${line}\n`, r.work);
      assert.equal(clean.stdout, 'archive-lane/v1 clean\n');
      assert.match(clean.stderr, /archive lane/);
      assert.equal(clean.status, 0);

      const dirty = archiveBranch(r, { '.env': 'K=v\n' }, 'z');
      const blocked = run([`--remote=origin`, `--destination=${r.dest}`], `${dirty}\n`, r.work);
      assert.equal(blocked.stdout, 'archive-lane/v1 findings\n');
      assert.equal(blocked.status, 1);

      const full = run([`--remote=origin`, `--destination=${r.dest}`], `refs/heads/main ${'a'.repeat(40)} refs/heads/main ${'b'.repeat(40)}\n`, r.work);
      assert.equal(full.stdout, 'archive-lane/v1 not-applicable\n');
    });
  });

  it('an unknown flag is refused with no token (the hook then reports the lane unavailable)', () => {
    const r = run(['--bogus'], '', REPO_ROOT);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /unknown flag/);
  });

  it('a destination beginning with - arrives through the = form and is not read as a flag', (t) => {
    if (skip(t)) return;
    withRepos((r) => {
      const line = archiveBranch(r, { 'a.txt': 'a\n' });
      const res = run(['--remote=origin', '--destination=--upload-pack=touch-nothing'], `${line}\n`, r.work);
      assert.equal(res.stdout, 'archive-lane/v1 error\n');
      assert.doesNotMatch(res.stderr, /unknown flag/);
    });
  });
});

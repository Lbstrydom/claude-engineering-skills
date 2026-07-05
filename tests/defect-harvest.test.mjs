import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harvestCandidates } from '../scripts/defect-harvest.mjs';

const NUL = String.fromCharCode(0);
/** Build a fake `git` runner. `commits` = [{hash, subject, body}]; `show`/`blame`
 * maps keyed by first arg after the subcommand. */
function fakeGit({ commits = [], show = {}, blame = {} } = {}) {
  const logOut = commits.map((c) => [c.hash, c.subject || '', c.body || ''].join(NUL) + NUL + NUL).join('\n');
  return (args) => {
    const [cmd] = args;
    if (cmd === 'log') return logOut;
    if (cmd === 'show') {
      // args: ['show','--numstat','--format=', sha] OR ['show','--unified=0','--format=', sha,'--',file]
      const sha = args.find((a) => /^[0-9a-f]{7,40}$/i.test(a));
      const key = args.includes('--unified=0') ? `diff:${sha}` : `numstat:${sha}`;
      return show[key] || '';
    }
    if (cmd === 'blame') {
      const sha = args.find((a) => /\^?$/.test(a) && /[0-9a-f]{7,40}/i.test(a)) || '';
      const file = args[args.length - 1];
      return blame[`${sha}:${file}`] || blame[file] || '';
    }
    return '';
  };
}

test('revert commit → the reverted SHA is the buggy commit', () => {
  const git = fakeGit({ commits: [{ hash: 'aaaaaaa', subject: 'Revert "feat: x"', body: 'This reverts commit deadbeefdeadbeef.' }] });
  const c = harvestCandidates({ root: '/x' }, { git });
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'revert');
  assert.equal(c[0].buggyCommit, 'deadbeefdeadbeef');
  assert.equal(c[0].fixCommit, 'aaaaaaa');
});

test('Fixes <sha> body reference → accepted; bare Fixes #123 → skipped', () => {
  const git = fakeGit({ commits: [
    { hash: 'bbbbbbb', subject: 'fix: crash', body: 'Fixes cafebabecafebabe' },
    { hash: 'ccccccc', subject: 'fix: thing', body: 'Fixes #123' },
  ] });
  const c = harvestCandidates({ root: '/x' }, { git });
  const refs = c.filter((x) => x.kind === 'fixes-ref');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].buggyCommit, 'cafebabecafebabe');
  // The bare-issue commit produced NO candidate (skipped, no network lookup).
  assert.equal(c.some((x) => x.fixCommit === 'ccccccc'), false);
});

test('pure-addition (omission) fix → kind:pure-addition, confidence:low, buggyCommit=null', () => {
  const git = fakeGit({
    commits: [{ hash: 'ddddddd', subject: 'fix: add missing null guard' }],
    show: {
      'numstat:ddddddd': '5\t0\tsrc/x.mjs',                 // 5 added, 0 deleted → pure addition
      'diff:ddddddd': '@@ -40,0 +41,5 @@\n+  if (!x) return;',
    },
  });
  const c = harvestCandidates({ root: '/x' }, { git });
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'pure-addition');
  assert.equal(c[0].confidence, 'low');
  assert.equal(c[0].buggyCommit, null); // never auto-attributed
});

test('blame introducer → buggyCommit from git blame of the pre-image lines', () => {
  const git = fakeGit({
    commits: [{ hash: 'eeeeeee', subject: 'fix: correct calc' }],
    show: {
      'numstat:eeeeeee': '2\t2\tsrc/calc.mjs',              // has deletions → blame path
      'diff:eeeeeee': '@@ -10,2 +10,2 @@\n-  return a - b;\n+  return a + b;',
    },
    blame: { '/calc.mjs': '', 'eeeeeee^:src/calc.mjs': '1234567 (a 2020) return a - b;' },
  });
  const c = harvestCandidates({ root: '/x' }, { git });
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'blame');
  assert.equal(c[0].buggyCommit, '1234567');
});

test('non-fix commit → no candidate', () => {
  const git = fakeGit({ commits: [{ hash: 'fffffff', subject: 'feat: add feature' }] });
  assert.equal(harvestCandidates({ root: '/x' }, { git }).length, 0);
});

/**
 * Security contract for the widened admission (INC-001, docs/plans/file-coverage-contract-and-csharp.md
 * R1-M5). Admitting more extensions to the LLM audit widens what is READ; the widening must ride the
 * one existing read boundary, and the carve-out that stops `Token.cs` being called a credential file
 * must not remove protection from anything that is one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { classifyPath, resolveAndClassify } from '../scripts/lib/sensitive-paths.mjs';
import { readFilesAsContext, readFilesAsContextDetailed, safeReadFile } from '../scripts/lib/audit-scope.mjs';
import { readFilesAsAnnotatedContext, parseDiffFile } from '../scripts/lib/diff-annotation.mjs';
import { mkdtemp } from './helpers/fixtures.mjs';

const SECRET = 'AKIAIOSFODNN7EXAMPLE';

test('Token.cs / Password.cs / tokens.cs are code modules, not credential files', () => {
  for (const p of ['src/Auth/Token.cs', 'src/Auth/Password.cs', 'Auth/tokens.cs', 'a/b/PASSWORD.CS']) {
    assert.equal(classifyPath(p), null, p);
  }
});

test('genuine credential shapes stay sensitive: data forms, directories, and lookalike dirs holding code', () => {
  for (const p of ['token.json', 'tokens.yaml', 'service/token.txt', 'password.txt', 'password/x.txt',
    'src/tokens/Foo.cs', 'auth/password/Hasher.cs', 'secrets/Db.cs', '.env', 'keys/server.pem']) {
    assert.equal(classifyPath(p), 'sensitive', p);
  }
});

test('a symlinked Innocent.cs resolving into a sensitive target stays sensitive (resolveAndClassify)', (t) => {
  const dir = mkdtemp('carveout-symlink-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  fs.mkdirSync(path.join(dir, 'secrets'));
  fs.writeFileSync(path.join(dir, 'secrets', 'db.yaml'), `key: ${SECRET}\n`);
  try {
    fs.symlinkSync(path.join(dir, 'secrets', 'db.yaml'), path.join(dir, 'Innocent.cs'));
  } catch (err) {
    t.skip(`symlink creation not permitted here (${err.code})`);
    return;
  }
  const r = resolveAndClassify('Innocent.cs', { repoRoot: dir });
  assert.equal(r.lexical, null, 'the visible name is innocent');
  assert.equal(r.category, 'sensitive', 'the RESOLVED target is what decides');
});

test('a symlinked .cs escaping the repo is sensitive; a dangling one fails closed', (t) => {
  const dir = mkdtemp('carveout-escape-');
  const outside = mkdtemp('carveout-outside-');
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    fs.rmSync(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  fs.writeFileSync(path.join(outside, 'x.txt'), 'outside');
  try {
    fs.symlinkSync(path.join(outside, 'x.txt'), path.join(dir, 'Escape.cs'));
    fs.symlinkSync(path.join(dir, 'does-not-exist'), path.join(dir, 'Dangling.cs'));
  } catch (err) {
    t.skip(`symlink creation not permitted here (${err.code})`);
    return;
  }
  assert.equal(resolveAndClassify('Escape.cs', { repoRoot: dir }).escapedRepo, true);
  assert.equal(resolveAndClassify('Dangling.cs', { repoRoot: dir }).resolutionFailed, true);
});

test('BOTH readers read an admitted .cs file, redact a secret in its body, and refuse a sensitive path', (t) => {
  const dir = mkdtemp('carveout-readers-');
  const prevCwd = process.cwd();
  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  fs.writeFileSync(path.join(dir, 'Token.cs'), `class Token { const string K = "${SECRET}"; }\n`);
  fs.mkdirSync(path.join(dir, 'secrets'));
  fs.writeFileSync(path.join(dir, 'secrets', 'Db.cs'), `class Db { }\n`);
  process.chdir(dir);

  const plain = readFilesAsContext(['Token.cs', 'secrets/Db.cs']);
  assert.ok(plain.includes('### Token.cs'), 'the code module named Token.cs IS read now');
  assert.ok(plain.includes('```csharp'), 'and fenced as C#, not js');
  assert.ok(!plain.includes(SECRET), 'a secret literal in its body is redacted');
  assert.ok(!plain.includes('### secrets/Db.cs'), 'a sensitive directory is refused');

  const diffMap = parseDiffFile(path.join(dir, 'none.patch'));
  const annotated = readFilesAsAnnotatedContext(['Token.cs', 'secrets/Db.cs'], diffMap);
  assert.ok(annotated.includes('### Token.cs'));
  assert.ok(annotated.includes('```csharp'));
  assert.ok(!annotated.includes(SECRET));
  assert.ok(!annotated.includes('### secrets/Db.cs'));

  const detailed = readFilesAsContextDetailed(['Token.cs', 'secrets/Db.cs']);
  assert.deepEqual(detailed.stats.sensitiveExcluded, ['secrets/Db.cs']);
});

test('safeReadFile judges the RESOLVED path: an in-repo symlink Innocent.cs -> .env is refused (audit R1-H6)', (t) => {
  const dir = mkdtemp('carveout-inrepo-link-');
  const prevCwd = process.cwd();
  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  fs.writeFileSync(path.join(dir, '.env'), 'PLAIN_TEXT_NOT_A_SECRET_SHAPE=hunter2hunter2\n');
  fs.writeFileSync(path.join(dir, 'Real.cs'), 'class Real { }\n');
  try {
    fs.symlinkSync(path.join(dir, '.env'), path.join(dir, 'Innocent.cs'));
  } catch (err) {
    t.skip(`symlink creation not permitted here (${err.code})`);
    return;
  }
  process.chdir(dir);
  const cwd = path.resolve('.');
  assert.equal(safeReadFile('Innocent.cs', cwd), null, 'the link resolves to a sensitive file INSIDE the repo');
  assert.ok(safeReadFile('Real.cs', cwd), 'negative control: an ordinary in-repo file is still read');
  const out = readFilesAsContext(['Innocent.cs', 'Real.cs']);
  assert.ok(!out.includes('hunter2hunter2'), 'plain-text content of the resolved sensitive target must not reach the payload');
  assert.ok(out.includes('### Real.cs'));
});

test('safeReadFile compares canonical with canonical: a boundary given as a symlink alias still contains its own files (audit R2-H2)', (t) => {
  const real = mkdtemp('carveout-real-');
  const alias = real + '-alias';
  const prevCwd = process.cwd();
  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(alias, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    fs.rmSync(real, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  fs.writeFileSync(path.join(real, 'A.cs'), 'class A { }\n');
  try {
    fs.symlinkSync(real, alias, 'junction');
  } catch (err) {
    t.skip(`symlink creation not permitted here (${err.code})`);
    return;
  }
  process.chdir(real);
  assert.ok(safeReadFile('A.cs', alias), 'a lexical alias of the boundary must not read as outside it');
  assert.equal(safeReadFile('../escape.cs', alias), null, 'negative control: a real escape is still refused');
});

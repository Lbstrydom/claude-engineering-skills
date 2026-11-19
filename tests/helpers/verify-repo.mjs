/**
 * A throwaway git repo for contested-finding verification tests: isolated from the developer's git config and from any
 * GIT_* variable an enclosing hook exported, with `.audit/` ignored so artifacts never move the tree identity.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function makeVerifyRepo(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-repo-'));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-empty-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(empty, 'none'), GIT_TEMPLATE_DIR: empty, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
  const git = (...a) => execFileSync('git', ['-C', root, '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${empty}`, ...a], { env, encoding: 'utf-8' });
  // The code under test shells out to git with the ambient env: point it at the same isolation.
  const saved = { ...process.env };
  Object.keys(process.env).filter((k) => k.startsWith('GIT_')).forEach((k) => delete process.env[k]);
  Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(empty, 'none'), GIT_TEMPLATE_DIR: empty });
  git('init', '-q');
  const write = (rel, text) => { const abs = path.join(root, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, text); };
  write('.gitignore', '.audit/\n');
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return {
    root, git, write,
    audit: (name, obj) => write(path.join('.audit', name), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)),
    cleanup() {
      for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k];
      Object.assign(process.env, Object.fromEntries(Object.entries(saved).filter(([k]) => k.startsWith('GIT_'))));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      fs.rmSync(empty, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    },
  };
}

export function finding(id, over = {}) {
  return {
    id, severity: 'HIGH', category: `[be] ${id} cat`, section: 'src/a.js — fooBar', detail: `The \`fooBar\` function ${id} returns a constant.`,
    risk: 'r', recommendation: 'fix it', _hash: `h${id}`, _pass: 'be', _sourceModel: 'gpt-6.1-terra', _primaryFile: 'src/a.js', affectedFiles: ['src/a.js'], ...over,
  };
}

/**
 * @fileoverview The project instruction file (AGENTS.md / CLAUDE.md / …) is a
 * Tier-3 egress read: its content becomes the audit brief and the project
 * context sent to a third-party LLM. `context.mjs` read it with `existsSync` +
 * `readFileSync` on the bare name, so an `AGENTS.md` that is a symlink to a file
 * OUTSIDE the repo (or to a sensitive file inside it) was followed and shipped —
 * the INC-001 symlink-bypass class, on the one read the audit always makes.
 * (Audit finding 069a9110, the context.mjs third of a systemic finding whose
 * audit-scope and grounding thirds were fixed elsewhere.)
 *
 * Each case runs a FRESH module instance (the instruction file is cached at
 * module level) with cwd set to a scratch repo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { mkdtemp } from './helpers/fixtures.mjs';

const CONTEXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'lib', 'context.mjs');
let instance = 0;
const freshContext = () => import(`${pathToFileURL(CONTEXT).href}?instance=${++instance}`);

function scratch(t) {
  const repo = mkdtemp('ctx-instr-repo-');
  const outside = mkdtemp('ctx-instr-outside-');
  const prevCwd = process.cwd();
  t.after(() => {
    process.chdir(prevCwd);
    for (const d of [repo, outside]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return { repo, outside };
}

function linkOrSkip(t, target, link) {
  try { fs.symlinkSync(target, link); return true; } catch (err) {
    t.skip(`symlink creation not permitted here (${err.code})`);
    return false;
  }
}

test('an AGENTS.md symlinked OUTSIDE the repo is never read into the LLM context', async (t) => {
  const { repo, outside } = scratch(t);
  fs.writeFileSync(path.join(outside, 'private-notes.md'), 'OUTSIDE_MARKER_do_not_egress\n');
  if (!linkOrSkip(t, path.join(outside, 'private-notes.md'), path.join(repo, 'AGENTS.md'))) return;
  process.chdir(repo);
  const ctx = await freshContext();
  const out = ctx.readProjectContext();
  assert.ok(!out.includes('OUTSIDE_MARKER_do_not_egress'), 'content behind a repo-escaping link reached the context');
});

test('an AGENTS.md symlinked to a sensitive file INSIDE the repo is never read', async (t) => {
  const { repo } = scratch(t);
  fs.writeFileSync(path.join(repo, '.env'), 'INREPO_SENSITIVE_MARKER=1\n');
  if (!linkOrSkip(t, path.join(repo, '.env'), path.join(repo, 'AGENTS.md'))) return;
  process.chdir(repo);
  const ctx = await freshContext();
  assert.ok(!ctx.readProjectContext().includes('INREPO_SENSITIVE_MARKER'));
});

test('a refused AGENTS.md falls through to the next candidate', async (t) => {
  const { repo, outside } = scratch(t);
  fs.writeFileSync(path.join(outside, 'x.md'), 'OUTSIDE_MARKER\n');
  if (!linkOrSkip(t, path.join(outside, 'x.md'), path.join(repo, 'AGENTS.md'))) return;
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'CLAUDE_MD_MARKER\n');
  process.chdir(repo);
  const ctx = await freshContext();
  const out = ctx.readProjectContext();
  assert.ok(out.includes('CLAUDE_MD_MARKER'));
  assert.ok(!out.includes('OUTSIDE_MARKER'));
});

test('negative control: an ordinary in-repo AGENTS.md is read', async (t) => {
  const { repo } = scratch(t);
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'ORDINARY_AGENTS_MARKER\n');
  process.chdir(repo);
  const ctx = await freshContext();
  assert.ok(ctx.readProjectContext().includes('ORDINARY_AGENTS_MARKER'));
});

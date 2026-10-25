/**
 * @fileoverview The plan files of a PUSHED COMMIT, read from git's object store rather than the checkout's working tree.
 *
 * The pre-push plan-status gate used to read `docs/plans/*.md` from the working tree of whichever checkout ran the push.
 * Storyline, 2026-10-15: pushing `claude/small-fixes-batch` from the main checkout was rejected for the very Status lines
 * that branch fixes, while the same push from the branch's own worktree passed. A gate judging the wrong tree blocks
 * correct pushes and could pass bad ones (fleet 4146). With a range git itself handed the hook (`trusted`), the gate reads
 * the plans at the pushed head instead.
 *
 * Entries have the shape `listPlanFiles` returns plus `content`, so the existing classifiers run unchanged on either source.
 * Symlinks (mode 120000) are not plans here - their blob is a target path, not a document - and are skipped.
 *
 * @module scripts/lib/plan-git-source
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isSafeGitRevision } from './vcs.mjs';

const PLANS_DIR = 'docs/plans';
const isSelectableName = (name) => name.endsWith('.md') && !/-audit-summary(?:-[\w-]+)?\.md$/.test(name);

/**
 * @param {{head: string, cwd?: string, plansDir?: string, spawn?: typeof spawnSync}} input
 * @returns {Array<{name: string, abs: string, content: string, mtimeMs: number}> | null} null when git cannot say (the caller falls back
 *   to the working tree and says so); an empty array is a real answer ("the commit has no plans")
 */
export function gitPlanFiles({ head, cwd = process.cwd(), plansDir = PLANS_DIR, spawn = spawnSync }) {
  if (!isSafeGitRevision(head)) return null;
  const git = (args, input) => spawn('git', args, { cwd, input, maxBuffer: 512 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] });
  const tree = git(['ls-tree', '-z', head, `${plansDir}/`]);
  if (tree.status !== 0 || !Buffer.isBuffer(tree.stdout)) return null;
  const names = [];
  for (const rec of tree.stdout.toString('utf8').split('\0').filter(Boolean)) {
    // "<mode> SP <type> SP <sha> TAB <path>"
    const m = /^(\d+) (\w+) [0-9a-f]+\t(.+)$/s.exec(rec);
    if (!m) return null;
    const [, mode, type, full] = m;
    if (type !== 'blob' || mode === '120000') continue;
    const name = full.slice(plansDir.length + 1);
    if (name.includes('/') || !isSelectableName(name)) continue;
    // `cat-file --batch` takes one NEWLINE-terminated request per line: a name holding a line break would split into two requests and
    // answer for another object. No plan has one; if one appears, the listing cannot be read safely, and null means "unavailable".
    if (/[\r\n]/.test(name)) return null;
    names.push(name);
  }
  if (names.length === 0) return [];
  // One process for every blob: a consumer holds hundreds of plans.
  const batch = git(['cat-file', '--batch'], names.map((n) => `${head}:${plansDir}/${n}\n`).join(''));
  if (batch.status !== 0 || !Buffer.isBuffer(batch.stdout)) return null;
  const out = batch.stdout;
  const files = [];
  let pos = 0;
  for (const name of names) {
    const nl = out.indexOf(0x0a, pos);
    if (nl < 0) return null;
    const header = out.subarray(pos, nl).toString('utf8');
    const hm = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (!hm) return null; // "missing" or any other answer: the listing and the read disagree, so do not trust either
    const size = Number(hm[1]);
    const content = out.subarray(nl + 1, nl + 1 + size).toString('utf8');
    if (out[nl + 1 + size] !== 0x0a) return null;
    pos = nl + 1 + size + 1;
    files.push({ name, abs: path.join(cwd, plansDir, name), content, mtimeMs: 0 });
  }
  return files;
}

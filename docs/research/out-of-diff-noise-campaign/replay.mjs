// Replay one stored audit three ways. Usage: node replay.mjs <runId8> <arm: off|overlap|referenced> [timeoutMs]
// Env (pinned fixture does the auditing); consumer worktree is cwd. Store writes disabled (no DB url, learning off).
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
const FIX = 'C:/GIT/claude-engineering-skills-pinned/oodn-1c';
const cand = JSON.parse(fs.readFileSync(process.env.TEMP + '/corpus-cand.json', 'utf8'));
const [rid8, arm, tmo] = process.argv.slice(2);
const row = cand.find((c) => c.rid.startsWith(rid8));
const repoDir = { 'Lbstrydom/ai-organiser': 'C:/GIT/ai-organiser', 'Lbstrydom/claude-engineering-skills': 'C:/GIT/claude-engineering-skills' }[row.repo];
const wt = `C:/tmp/oodn/wt-${rid8}-${arm}`;
const out = `C:/tmp/oodn/out/${rid8}-${arm}`;
fs.mkdirSync(out, { recursive: true });
if (!fs.existsSync(wt)) {
  execFileSync('git', ['-C', repoDir, 'worktree', 'add', '--detach', wt, row.sha], { stdio: 'ignore' });
  const full = fs.readFileSync(`C:/tmp/oodn/diffs/${rid8}.patch`, 'utf8');
  const parts = full.split(/^(?=diff --git )/m).filter((p) => p.startsWith('diff --git'));
  const skipped = [];
  for (const [i, p] of parts.entries()) {
    const pf = `C:/tmp/oodn/diffs/${rid8}.part${i}.patch`; fs.writeFileSync(pf, p);
    try { execFileSync('git', ['-C', wt, 'apply', '--ignore-whitespace', pf], { stdio: 'ignore' }); }
    catch { skipped.push((p.match(/^diff --git a\/(\S+)/) || [])[1]); }
  }
  fs.writeFileSync(`${out}/applied.json`, JSON.stringify({ parts: parts.length, skipped }));
}
const env = { ...process.env, AUDIT_CHUNK_SCOPE: arm, LEARNING_DISABLE: '1', AUDIT_DB_URL: '', CLAUDE_BACKEND: process.env.CLAUDE_BACKEND ?? 'sdk', MODEL_CATALOG_REFRESH: 'skip', AUDIT_ALLOW_FOREIGN_CWD: '1' };
const t0 = Date.now();
const r = spawnSync('node', [`${FIX}/scripts/openai-audit.mjs`, 'code', 'C:/tmp/oodn/plan-stub.md', '--scope', 'diff', '--out', `${out}/result.json`],
  { cwd: wt, env, encoding: 'utf8', timeout: Number(tmo) || 1500000, maxBuffer: 64 * 1024 * 1024 });
fs.writeFileSync(`${out}/stderr.log`, r.stderr ?? '');
fs.writeFileSync(`${out}/stdout.log`, r.stdout ?? '');
console.log(JSON.stringify({ rid8, arm, exit: r.status, signal: r.signal, ms: Date.now() - t0 }));

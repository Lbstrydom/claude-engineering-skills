#!/usr/bin/env node
/**
 * @fileoverview Session-start advisory: a retired skill surface is still on this
 * machine, and an agent may be reading it instead of the repo-scoped copy.
 *
 * ## Why a hook, when `npm run check` already reports this
 *
 * `check` runs at PUSH time. The harm happens at READ time — an agent resolves
 * `ship/SKILL.md` from `~/.claude/skills/` and every runner path in it is wrong
 * for the repo it is standing in. That is not hypothetical: it is the incident
 * that started this whole line of work, and the session that hit it concluded
 * "the tooling is not installed" and skipped its audit gates on that false
 * premise. Telling the operator at the *end* of the session they already wasted
 * is too late to be worth much.
 *
 * ## Why it is an ADVISORY and never a block
 *
 * This is machine state, not repo state. Two developers on the same commit get
 * different answers, CI never sees it, and blocking would stop unrelated work
 * without fixing the shadow. The push gate deliberately does NOT cover this for
 * exactly that reason (docs/reference/skill-surface-ownership.md); a hook is the
 * right home precisely because it informs without gating.
 *
 * ## Why it exists at all when nothing can create the tree any more
 *
 * The retirement removed every writer in the CURRENT bundle — but a developer on
 * a pre-2026-07-30 checkout still has the old installer and the old
 * `.githooks/post-merge`, and a `git pull` there recreates it. "Nothing can
 * produce this state" is only true of machines running current code, which is
 * the same assumption that let the original defect run for months.
 *
 * ## Cost
 *
 * Two small file reads (a receipt + a directory listing) per surface, measured at
 * ~4.5ms including module load, and ONCE per session — a sentinel keyed on
 * `session_id` short-circuits every later prompt. Silent when clean: no output,
 * no file writes, nothing in the transcript.
 *
 * Hook contract:
 *   - stdin: `{"hook_event_name":"UserPromptSubmit","session_id":"…","prompt":"…"}`
 *   - stdout: text prepended to the turn's context (only when something is wrong)
 *   - exit 0: ALWAYS. This must never block a prompt.
 *
 * Opt out: `LEGACY_SURFACE_HOOK_DISABLE=1`.
 *
 * @module .claude/hooks/legacy-surface-advisory
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The tree to inspect. `--repo-root` is a TEST SEAM, deliberately a CLI arg and
 * not an environment variable: Claude Code invokes this hook with no arguments,
 * so production cannot be redirected by ambient state, and a test can still drive
 * a fixture tree. (Same discipline as `install.mjs`'s bundle source — the thing
 * that decides WHAT gets inspected/executed is never ambient.)
 */
function resolveRepoRoot(argv) {
  const i = argv.indexOf('--repo-root');
  if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

const REPO_ROOT = resolveRepoRoot(process.argv);

// The inspector module is layout-MAPPED: `scripts/lib/...` in this repo,
// `scripts/.claude-skills/lib/...` in a consumer. This hook's own path is
// canonical in BOTH layouts, so it cannot derive which one it is in -- it must
// try both, exactly as quickfix-scan.mjs and syntax-check.mjs do.
//
// The former bare `import('../../scripts/lib/install/legacy-surfaces.mjs')`
// resolved only in this repo. In a consumer it threw, and the catch at the call
// site treats a throw as `return` -- so the advisory was silently dead in
// exactly the repos whose incident motivated it.
//
// Anchored on this FILE, not on REPO_ROOT: `--repo-root` is a test seam for the
// tree being INSPECTED, and pointing it at a fixture must not move where the
// hook loads its own code from.
const HOOK_DIR = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_ROOT = path.resolve(HOOK_DIR, '..', '..');
const INSPECTOR_CANDIDATES = Object.freeze([
  path.join(INSTALL_ROOT, 'scripts', 'lib', 'install', 'legacy-surfaces.mjs'),
  path.join(INSTALL_ROOT, 'scripts', '.claude-skills', 'lib', 'install', 'legacy-surfaces.mjs'),
]);

/**
 * @returns {Promise<object|null>} the inspector module, or null when neither
 *   layout has it (a partial checkout) -- in which case the hook says nothing.
 */
async function loadInspector(candidates = INSPECTOR_CANDIDATES) {
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try { return await import(pathToFileURL(candidate).href); }
    catch { /* try the next layout */ }
  }
  return null;
}
const SENTINEL_DIR = path.join(REPO_ROOT, '.audit', 'legacy-surface-advisory');

/** Read the hook envelope, tolerating an absent/malformed one. */
async function readEvent() {
  const argIdx = process.argv.indexOf('--session-id');       // test seam
  if (argIdx !== -1) return { session_id: process.argv[argIdx + 1] };
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};                                                // never block on bad input
  }
}

/**
 * Has this session already been told?
 *
 * Keyed on `session_id`, not a timestamp: a time window would either re-nag
 * within one long session or go quiet across a genuinely new one. A missing
 * session id means "cannot dedupe" — we still advise, because a duplicate
 * warning is a far cheaper failure than a silent shadow.
 */
function alreadyAdvised(sessionId) {
  if (!sessionId) return false;
  return fs.existsSync(path.join(SENTINEL_DIR, `${sessionId}.txt`));
}

function markAdvised(sessionId) {
  if (!sessionId) return;
  try {
    fs.mkdirSync(SENTINEL_DIR, { recursive: true });
    fs.writeFileSync(path.join(SENTINEL_DIR, `${sessionId}.txt`), new Date().toISOString());
  } catch { /* best-effort — a failed sentinel means one extra notice, not a crash */ }
}

/** Remove sentinels older than a week so the directory cannot grow forever. */
function pruneSentinels() {
  try {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(SENTINEL_DIR)) {
      const p = path.join(SENTINEL_DIR, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) {
          fs.rmSync(p, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
        }
      } catch { /* ignore */ }
    }
  } catch { /* directory absent — nothing to prune */ }
}

async function main() {
  if (process.env.LEGACY_SURFACE_HOOK_DISABLE === '1') return;

  const event = await readEvent();
  const sessionId = event.session_id ?? event.sessionId ?? null;
  if (alreadyAdvised(sessionId)) return;

  let inspection;
  let describe;
  try {
    const mod = await loadInspector();
    if (!mod) return;   // inspector absent in both layouts -- say nothing
    describe = mod.describeLegacySurfaces;
    inspection = mod.inspectLegacySurfaces({ repoRoot: REPO_ROOT });
  } catch {
    return;   // the inspector is unavailable (partial checkout) — say nothing
  }

  // Mark the session AFTER a successful inspection, so a transient failure does
  // not silence the advisory for the rest of the session.
  markAdvised(sessionId);
  pruneSentinels();

  if (inspection.overall === 'absent') return;                // silent when clean

  const lines = describe(inspection);
  process.stdout.write(
    '> **Retired skill surface detected on this machine**\n>\n'
    + lines.map((l) => `> - ${l}\n`).join('')
    + '>\n'
    + '> These are read by Claude Code and Copilot alongside this repo\'s\n'
    + '> `.claude/skills/`, and precedence between roots is undefined — so a skill\n'
    + '> you invoke may resolve to the stale copy, whose runner paths are wrong for\n'
    + '> this repo. That exact failure was previously misdiagnosed as "the tooling\n'
    + '> is not installed".\n>\n'
    + '> Remove them: `node scripts/install-skills.mjs --uninstall-legacy`\n'
    + '> (receipt-bounded — it cannot touch a skill you wrote yourself)\n'
    + '>\n'
    + '> Advisory only; nothing is blocked. Silence it with `LEGACY_SURFACE_HOOK_DISABLE=1`.\n',
  );
}

main().then(() => process.exit(0)).catch(() => process.exit(0));

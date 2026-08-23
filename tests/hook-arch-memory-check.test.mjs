import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Effectiveness tests for the .claude/hooks/arch-memory-check.sh
 * UserPromptSubmit hook.
 *
 * Test categories:
 *  A. Pattern matching — does the hook fire on intent verbs and skip questions?
 *  B. Output shape    — when triggered, is the output well-formed Markdown?
 *  C. Graceful fail   — does the hook always exit 0 (never block the user)?
 *  D. Latency         — does the dry-run path complete in <500ms?
 *
 * Category E (does the consultation actually reduce drift in real Claude
 * sessions?) requires multi-session A/B testing — see the empirical-test
 * recipe in AGENTS.md "## Architectural Memory" → "Pre-fix consultation".
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(__dirname, '..', '.claude', 'hooks', 'arch-memory-check.sh');

/**
 * Hermetic store isolation — the reason this suite used to flake.
 *
 * The cloud-off test blanked `SUPABASE_AUDIT_URL` / `SUPABASE_AUDIT_ANON_KEY`,
 * but those were **sunset in M4**: the store reads `AUDIT_DB_URL` (plus its
 * aliases), which `...process.env` inherited and which `~/.audit-loop.env`
 * re-injects through config.mjs. So a test whose comment said "cloud-off path —
 * no real Supabase needed" hit the live store on every run: ~4.5s of embed +
 * RPC against a 10s `timeout`, which under parallel suite load intermittently
 * blew it (observed: a 10009ms failure). Hermetic, it is ~1.8s and passes
 * deterministically.
 *
 * Blanking the vars is not sufficient on its own — HOME/USERPROFILE are
 * redirected too, or the shared cloud config puts a real DSN straight back.
 * Same idiom as tests/ship-commit-cli.test.mjs.
 */
const STORE_ENV_KEYS = [
  'AUDIT_DB_URL', 'AUDIT_POSTGRES_URL', 'AUDIT_STORE',
  'AUDIT_DB_SSL_MODE', 'AUDIT_POSTGRES_SSL_MODE',
  // Sunset in M4, still consulted by client.mjs's "is cloud configured" probe.
  'SUPABASE_AUDIT_URL', 'SUPABASE_AUDIT_ANON_KEY',
];

function hermeticStoreEnv() {
  const blanked = Object.fromEntries(STORE_ENV_KEYS.map((k) => [k, '']));
  return { ...blanked, HOME: os.tmpdir(), USERPROFILE: os.tmpdir() };
}

function runHook(args = [], opts = {}) {
  const start = Date.now();
  let stdout = '', exit = 0;
  try {
    stdout = execFileSync('bash', [HOOK, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
      // A HANG guard, not a latency assertion. At 10s this was the same
      // load-sensitive-assertion trap the latency guard below was deleted for:
      // the hermetic hook runs ~1.8s alone, but a full parallel suite pushed a
      // spawn past 10s and failed the run (observed 10019ms in a pre-push
      // sandbox, and 10009ms historically). Latency is asserted separately by
      // the 'hook latency' suite; this bound exists only so a genuinely hung
      // hook cannot wedge the suite forever, so it should be far above any
      // plausible load-induced delay.
      timeout: 60000,
      // Hermetic by DEFAULT, not per-test: every spawn in this file is a unit
      // test of the hook's own logic, and none of them should be able to reach
      // a real store. A caller can still override via opts.env.
      env: {
        ...process.env,
        ARCH_MEMORY_HOOK_DISABLE: '0',
        ...hermeticStoreEnv(),
        ...(opts.env || {}),
      },
    });
  } catch (err) {
    exit = err.status ?? 1;
    stdout = err.stdout?.toString() || '';
  }
  return { stdout, exit, latencyMs: Date.now() - start };
}

// ── A. Pattern matching ────────────────────────────────────────────────────

describe('hook intent detection — POSITIVE cases (should fire)', () => {
  const cases = [
    ['fix the cellar grid spacing on mobile',           'fix'],
    ['add a wine pairing recommendation function',      'add'],
    ['implement a new audit pass for security',         'implement'],
    ['create a placement suggestion for new wines',     'create'],
    ['build a status indicator component',              'build'],
    ['write a function that normalises tasting notes',  'write'],
    ['refactor the embedding model resolution',         'refactor'],
    ['make sure the modal closes properly',             'make'],
    ['wire up the drift score endpoint',                'wire'],
    ['hook the new logger into the audit pipeline',     'hook'],
    ['introduce a retry wrapper around fetch',          'introduce'],
    ['replace the inline parser with the shared one',   'replace'],
    ['extend the persona schema to support birthyear',  'extend'],
    ['Please fix the git diff command',                 'fix'],     // leading politeness
    ['Could you add an error boundary to the grid?',    null],      // ? → skip
    ['Can you add a function for X',                    'add'],     // no '?' → treated as a request (correct: people often drop punctuation)
  ];
  for (const [prompt, expected] of cases) {
    it(`detects ${expected || 'NONE'} in: "${prompt.slice(0, 50)}..."`, () => {
      const r = runHook(['--prompt', prompt, '--dry-run']);
      assert.equal(r.exit, 0, `exit should be 0, got ${r.exit}`);
      if (expected) {
        assert.match(r.stdout, new RegExp(`INTENT_DETECTED:\\s+${expected}`),
          `expected INTENT_DETECTED: ${expected} in stdout, got: ${r.stdout}`);
      } else {
        assert.equal(r.stdout.trim(), '', `expected empty stdout, got: ${r.stdout}`);
      }
    });
  }
});

describe('hook intent detection — NEGATIVE cases (should NOT fire)', () => {
  const cases = [
    'what does the get-neighbourhood command do?',
    'why is the embedding model gemini-embedding-001?',
    'how does the snapshot publication work',
    'explain the difference between anon and service role keys',
    'where is the sensitive-egress gate defined',
    'when does the weekly drift workflow run',
    'who designed the architectural-memory plan',
    'show me the test coverage for symbol-index',
    'tell me about the refresh modes',
    'does the cache survive across sessions?',
    'is the publish_refresh_run RPC atomic',
    '',                                                              // empty
    '\n\n  ',                                                        // whitespace only
    'thanks for the help',                                            // chit-chat
    'ok proceed',                                                     // confirmation
    'looks good',                                                     // confirmation
  ];
  for (const prompt of cases) {
    it(`skips: "${prompt.slice(0, 50)}..."`, () => {
      const r = runHook(['--prompt', prompt, '--dry-run']);
      assert.equal(r.exit, 0);
      assert.equal(r.stdout.trim(), '', `expected empty stdout, got: ${JSON.stringify(r.stdout)}`);
    });
  }
});

describe('hook intent detection — mixed-case + punctuation', () => {
  it('case insensitive', () => {
    const r = runHook(['--prompt', 'FIX the bug in foo.mjs', '--dry-run']);
    assert.match(r.stdout, /INTENT_DETECTED:\s+fix/);
  });
  it('handles leading whitespace', () => {
    const r = runHook(['--prompt', '   add a new helper function', '--dry-run']);
    assert.match(r.stdout, /INTENT_DETECTED:\s+add/);
  });
  it('handles trailing newlines', () => {
    const r = runHook(['--prompt', 'implement caching\n\n', '--dry-run']);
    assert.match(r.stdout, /INTENT_DETECTED:\s+implement/);
  });
});

// ── B. Output shape (cloud-off path — no real Supabase needed) ──────────────

describe('hook output shape (cloud-off)', () => {
  it('produces a Markdown callout when triggered + cloud is off', () => {
    // runHook is hermetic by default, so this genuinely exercises the cloud-off
    // path. It previously did not — see the STORE_ENV_KEYS note above.
    const r = runHook(['--prompt', 'add a function that summarises wine pairings']);
    assert.equal(r.exit, 0, `hook should exit 0 even in cloud-off mode, got ${r.exit}`);

    // Asserted, not permitted. The old assertion was
    // `length === 0 || includes(...)`, which passes on BOTH outcomes and so
    // could not fail for the right reason — a hook that silently emitted
    // nothing satisfied it just as well as one that emitted the callout. With
    // real isolation the output is deterministic, so assert what it must be.
    assert.match(r.stdout, /\*\*Architectural-memory consultation\*\*/,
      `cloud-off must still emit the consultation block; got: ${r.stdout.slice(0, 200)}`);
    assert.match(r.stdout, /Cloud store offline/,
      'and must say WHY no neighbourhood was returned, rather than looking like a clean lookup');
    assert.match(r.stdout, /arch:refresh/,
      'and must name the command that enables it');
  });

  // A wall-clock latency guard was added here and then REMOVED, deliberately.
  // It asserted `latencyMs < 5000` to pin the isolation — and promptly failed in
  // a full-suite run (14s for this file under parallel load) while passing in
  // isolation. That is the load-sensitive-assertion trap: the measurement scales
  // with machine load, not with the logic under test, so it trades one flake for
  // another. It was also redundant — mutation-testing showed the `Cloud store
  // offline` assertion above already fails when the hermetic env is removed, so
  // the timing check added no detection power. Assert the state, not its
  // timing proxy.
});

// ── C. Graceful failure ─────────────────────────────────────────────────────

describe('hook graceful failure', () => {
  it('exits 0 when ARCH_MEMORY_HOOK_DISABLE=1', () => {
    const r = runHook(['--prompt', 'add a thing'], { env: { ARCH_MEMORY_HOOK_DISABLE: '1' } });
    assert.equal(r.exit, 0);
    assert.equal(r.stdout.trim(), '', 'disabled hook should produce no output');
  });
  it('exits 0 with no args (no stdin, no --prompt)', () => {
    // execFileSync stdin: 'ignore' simulates no stdin attached
    const r = runHook([]);
    assert.equal(r.exit, 0);
  });
  it('exits 0 on whitespace-only prompt', () => {
    const r = runHook(['--prompt', '   \t\n  ']);
    assert.equal(r.exit, 0);
  });
});

// ── D. Latency ──────────────────────────────────────────────────────────────

// These were single-shot ABSOLUTE wall-clock assertions (<1500ms / <800ms) on a
// cost dominated by `bash` + `node` process startup — i.e. the one quantity a
// loaded machine perturbs most. They failed intermittently in the pre-push gate
// (measured 2026-07-18: 2 failures, then 0, then 0, on unchanged code) and
// blocked a push. A flaky gate is worse than a missing one: it trains everyone
// to reach for `--no-verify`, which is how a REAL failure gets waved through.
//
// Fixed by changing what is measured, not by inflating the caps (which would
// still flake, just less often):
//
//   1. BEST-OF-N. Scheduler noise can only ever ADD time, never subtract it, so
//      the MINIMUM of several runs is the least-biased estimator of true cost.
//      A mean or a single sample measures the machine; a minimum measures the
//      hook.
//   2. A RELATIVE assertion, calibrated against what was actually measured.
//      Both paths cost ~300ms and are almost entirely `bash` + `node` startup:
//      best-of-3 on 2026-07-18 was 296ms (firing, --dry-run) vs 325ms
//      (non-fire). Note the non-fire path is marginally SLOWER — so the
//      intuitive "short-circuiting means it must be faster" is FALSE here, and
//      an ordering assertion (nonFire < fire) would be a permanent coin-flip.
//      What the comparison genuinely buys is a load-independent baseline: the
//      regression worth catching is one path acquiring real work (a network
//      call, an embed — hundreds of ms to seconds), which shows up as a RATIO
//      blowout. Load scales both together and cancels.
//   3. The absolute ceilings survive only as catastrophic backstops, sized for
//      a loaded CI box rather than an idle laptop.
describe('hook latency', () => {
  /** Minimum latency across N runs — see (1) above. */
  const bestOf = (n, args) => {
    let best = Infinity;
    let lastExit = null;
    for (let i = 0; i < n; i++) {
      const r = runHook(args);
      lastExit = r.exit;
      if (r.latencyMs < best) best = r.latencyMs;
    }
    return { best, exit: lastExit };
  };

  it('neither path acquires real work — the two stay within a startup-cost band', () => {
    const fire = bestOf(3, ['--prompt', 'add a function for X', '--dry-run']);
    const nonFire = bestOf(3, ['--prompt', 'what does this function do?']);
    assert.equal(fire.exit, 0);
    assert.equal(nonFire.exit, 0);

    // Ratio, not a difference: both are ~entirely process startup, so their
    // absolute gap is small and noisy while the ratio is stable. 2x is a wide
    // band deliberately — it cannot be tripped by scheduling, only by one path
    // acquiring real work. Measured margin at time of writing: 325 vs 296ms.
    assert.ok(
      nonFire.best < fire.best * 2 + 100,
      `non-fire (${nonFire.best}ms) is far outside the firing path's startup band `
      + `(${fire.best}ms). Both should be ~process-startup cost; a blowout means one `
      + 'path started doing real work (network call? embed? missing early return?).',
    );
  });

  it('does not regress catastrophically (backstop, not a benchmark)', () => {
    const { best, exit } = bestOf(3, ['--prompt', 'add a function for X', '--dry-run']);
    assert.equal(exit, 0);
    // Sized for a loaded machine. This is NOT a performance target — it exists
    // to catch "someone made the hook do network I/O on every prompt", which is
    // seconds, not milliseconds. Tightening it re-introduces the flake.
    assert.ok(best < 5000, `dry-run best-of-3 took ${best}ms (backstop 5000ms — `
      + 'bash + node startup, no network. This should only trip on a real regression.)');
  });
});

// ── E. Empirical test recipe (NOT automated — for human runners) ────────────
//
// To measure whether the hook actually reduces drift in real Claude sessions:
//
//   1. Pick a controlled fix that has known near-duplicates in the symbol-index
//      (e.g., for ai-organiser: "add a function that watches vault file
//      renames and updates downstream references" — there's already
//      EventHandlers + getAvailableFilePath + SimpleFileChangeTracker).
//   2. Run two fresh Claude Code sessions:
//        Session A: ARCH_MEMORY_HOOK_DISABLE=1
//        Session B: ARCH_MEMORY_HOOK_DISABLE=0
//      Issue the same prompt to both. Record:
//        - Did Claude reuse an existing symbol or write new?
//        - Did Claude mention the existing symbols?
//        - Token cost delta
//   3. Repeat for 5-10 representative prompts. The hook is "effective" if
//      Session B reuses-or-mentions existing symbols in ≥60% of cases vs
//      Session A's baseline.
//
// This live A/B isn't automated because it requires real Claude API spend
// and judgement on "did Claude reuse appropriately." Worth running once
// per repo when first deploying, and again after major prompt changes.


// -- Tooling-layout resolution ---------------------------------------------
//
// `.claude/hooks/` stays at its canonical path in BOTH layouts, but the CLI
// this hook shells is MAPPED: `scripts/cross-skill.mjs` here,
// `scripts/.claude-skills/cross-skill.mjs` in a consumer. The hook hardcoded
// the source path, so in every consumer the `-f` probe missed and it took the
// "architectural-memory not installed" branch -- exit 0, no output at all.
// Quieter than the sibling quickfix-scan bug, which at least printed a FATAL.
// Confirmed 2026-08-20 against two real consumer checkouts.
//
// The source-layout case is the control: it proves the stub can produce a
// callout, so a consumer-layout pass cannot be the silent-skip branch wearing
// a green tick.

const STUB_CROSS_SKILL = [
  "const sub = process.argv[2] || '';",
  "const records = sub === 'get-neighbourhood'",
  "  ? [{ symbolName: 'stubbedNeighbour', filePath: 'scripts/lib/stub.mjs', startLine: 1,",
  "      similarityScore: 0.81, recommendation: 'precedent', purposeSummary: 'layout probe' }]",
  "  : [];",
  "process.stdout.write(JSON.stringify({ ok: true, cloud: true, records }));",
].join('\n');

/**
 * Throwaway repo with the hook at its canonical path and a stub cross-skill.mjs
 * under `cliRelDir`. Pass `null` to install no CLI at all.
 */
function scaffoldArchLayout(cliRelDir) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arch-layout-')));
  const hookDir = path.join(root, '.claude', 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  const hook = path.join(hookDir, 'arch-memory-check.sh');
  fs.copyFileSync(HOOK, hook);
  // Make `git rev-parse --show-toplevel` answer with THIS root rather than
  // whatever repo the system temp dir might sit inside.
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  if (cliRelDir) {
    const cliDir = path.join(root, ...cliRelDir.split('/'));
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(path.join(cliDir, 'cross-skill.mjs'), STUB_CROSS_SKILL + '\n');
  }
  return { root, hook };
}

function runArchInLayout(cliRelDir) {
  const { root, hook } = scaffoldArchLayout(cliRelDir);
  let stdout = '', exit = 0;
  try {
    stdout = execFileSync('bash', [hook, '--prompt', 'fix the login redirect bug'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 60000,
      env: { ...process.env, ARCH_MEMORY_HOOK_DISABLE: '0', ...hermeticStoreEnv() },
    });
  } catch (err) {
    exit = err.status ?? 1;
    stdout = err.stdout?.toString() || '';
  }
  return { stdout, exit };
}

describe('arch-memory-check tooling-layout resolution', () => {
  it('source layout (scripts/) -- finds cross-skill.mjs and emits the consultation', () => {
    const r = runArchInLayout('scripts');
    assert.equal(r.exit, 0);
    assert.match(r.stdout, /Architectural-memory consultation/);
    assert.match(r.stdout, /stubbedNeighbour/);
  });

  it('consumer layout (scripts/.claude-skills/) -- finds cross-skill.mjs and emits the consultation', () => {
    const r = runArchInLayout('scripts/.claude-skills');
    assert.equal(r.exit, 0);
    // The regression: the -f probe missed and the hook silently exited 0.
    assert.match(r.stdout, /stubbedNeighbour/);
  });

  it('neither layout -- silently exits 0 (architectural-memory not installed)', () => {
    const r = runArchInLayout(null);
    assert.equal(r.exit, 0);
    assert.equal(r.stdout.trim(), '');
  });
});

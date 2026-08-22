/**
 * @fileoverview A deterministic stand-in for the `gh` CLI, used only by
 * tests/runner-doctor-cli.test.mjs. Never talks to the network.
 *
 * How it gets invoked: the test copies the CURRENT node binary
 * (`process.execPath`) into a temp dir as `gh.exe` (win32) / `gh` (posix),
 * puts that dir first on PATH, and sets `NODE_OPTIONS=--require
 * <this file's absolute path>` plus `GH_STUB_ACTIVE=1` on the env used to
 * spawn the doctor CLI. Node reads NODE_OPTIONS at startup for EVERY node
 * process that inherits it — including the doctor CLI's own process, not
 * just the "gh.exe" stand-in it spawns — so this file self-gates: it does
 * real work ONLY when it can tell it's actually being invoked as `gh api
 * ...` (checked via the env sentinel AND the resolved first-positional-arg
 * basename, which Node normalises to an absolute path ending in `api`
 * before this hook runs). Every other invocation — in particular the doctor
 * CLI script itself — falls through and does nothing, letting node proceed
 * to load the real entry file normally.
 *
 * Empirically verified (see the Cluster B implementation report): on
 * Windows, `execFileSync('gh', args)` without `shell:true` — exactly what
 * the doctor CLI's own unchanged `gh()` helper does — can resolve a bare
 * command name to a real `.exe` on PATH directly, but CANNOT launch a
 * `.cmd`/`.bat` shim that way (EINVAL). Hence "copy node.exe, don't write a
 * batch file".
 *
 * Env vars this dispatcher reads:
 *   GH_STUB_ACTIVE           - '1' to arm the stub at all (self-gate)
 *   GH_STUB_SCENARIO         - viable | no-admin-rights | actions-disabled | unknown
 *                              (drives the legacy no-sub-command path: permissions +
 *                              registration-token)
 *   GH_STUB_RUNNER_STATUS    - online-idle | online-busy | offline-busy | offline |
 *                              not-registered | forbidden | unavailable | malformed
 *                              (drives the by-ID runner lookup used by `local`/`remove`)
 *   GH_STUB_REMOVE_TOKEN_FAIL - '1' to make the remove-token request itself fail
 *   GH_STUB_REMOVE_TOKEN     - override the returned removal token (default a fixed placeholder)
 */
const path = require('path');

if (process.env.GH_STUB_ACTIVE === '1' && path.basename(process.argv[1] || '') === 'api') {
  const args = process.argv.slice(2);

  const out = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };
  const fail = (text, code) => { process.stderr.write(text); process.exit(code || 1); };

  const postIdx = args.indexOf('-X');
  const isPost = postIdx !== -1 && args[postIdx + 1] === 'POST';
  // `args` is `process.argv.slice(2)` — already past the mangled 'api'
  // token (process.argv[1]). A GET call is `[endpoint, ...]` (endpoint at
  // 0); a POST call is `['-X', 'POST', endpoint, ...]` (endpoint at
  // postIdx+2) — the doctor CLI's own gh() call shape, both legacy and new.
  const pathArg = (isPost ? args[postIdx + 2] : args[0]) || '';

  // ── Legacy no-sub-command path: repo permissions ──────────────────────
  if (pathArg.endsWith('/actions/permissions')) {
    const scenario = process.env.GH_STUB_SCENARIO || 'viable';
    if (scenario === 'unknown') fail('HTTP 404: Not Found (https://api.github.com/repos/x/y/actions/permissions)\n');
    if (scenario === 'actions-disabled') out({ enabled: false, allowed_actions: null });
    out({ enabled: true, allowed_actions: 'all' });
  }

  // ── Legacy no-sub-command path: registration token ────────────────────
  if (isPost && pathArg.endsWith('/actions/runners/registration-token')) {
    const scenario = process.env.GH_STUB_SCENARIO || 'viable';
    if (scenario === 'viable') out({ token: 'AABBCCDDEEFF00112233', expires_at: '2026-08-01T00:00:00.000-00:00' });
    if (scenario === 'no-admin-rights') fail('HTTP 403: Must have admin rights to Repository. (https://api.github.com/repos/x/y/actions/runners/registration-token)\n');
    fail('HTTP 404: Not Found\n');
  }

  // ── Legacy no-sub-command path: latest-release asset lookup ───────────
  // Deliberately ALWAYS unavailable — keeps printRecipe's `asset` branch
  // deterministic (null) regardless of scenario.
  if (pathArg === 'repos/actions/runner/releases/latest') {
    fail('gh: Not Found (HTTP 404)\n');
  }

  // ── remove: removal-token request ──────────────────────────────────────
  if (isPost && pathArg.endsWith('/actions/runners/remove-token')) {
    if (process.env.GH_STUB_REMOVE_TOKEN_FAIL === '1') fail('HTTP 500: Internal Server Error\n');
    out({ token: process.env.GH_STUB_REMOVE_TOKEN || 'REMOVE-TOKEN-00112233', expires_at: '2026-08-01T00:00:00.000-00:00' });
  }

  // ── local / remove: direct by-ID runner lookup ─────────────────────────
  const segs = pathArg.split('/');
  const lastSeg = segs[segs.length - 1];
  const isRunnerById = pathArg.includes('/actions/runners/') && /^\d+$/.test(lastSeg);
  if (isRunnerById) {
    const status = process.env.GH_STUB_RUNNER_STATUS || 'online-idle';
    if (status === 'online-idle') out({ id: 1, name: 'x', status: 'online', busy: false, labels: [] });
    if (status === 'online-busy') out({ id: 1, name: 'x', status: 'online', busy: true, labels: [] });
    if (status === 'offline-busy') out({ id: 1, name: 'x', status: 'offline', busy: true, labels: [] });
    if (status === 'offline') out({ id: 1, name: 'x', status: 'offline', busy: false, labels: [] });
    if (status === 'not-registered') fail('gh: Not Found (HTTP 404)\n');
    if (status === 'forbidden') fail('gh: Resource not accessible by integration (HTTP 403)\n');
    if (status === 'unavailable') fail('gh: connection reset\n');
    if (status === 'malformed') { process.stdout.write('not json'); process.exit(0); }
    out({ id: 1, name: 'x', status: 'online', busy: false, labels: [] });
  }

  fail(`gh-stub: unhandled invocation: ${JSON.stringify(args)}\n`, 2);
}
// Not a gh-stub invocation (or the stub isn't armed) -> do nothing, let node
// proceed to load the real entry file normally.

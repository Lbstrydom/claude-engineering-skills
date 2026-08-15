# Plan: pnpm-aware consumer installation

- **Date**: 2026-08-15
- **Status**: Complete
- **Author**: Claude (ad-hoc fix, not `/plan`-originated)
- **Scope**: backend
- **Target domain(s)**: `scripts`, `shared-lib`

## Context Summary

**Origin**: user question — "why is playwright not listed in package.json"
(false premise: it was; `node_modules` was simply absent in this worktree)
led to a follow-up ask — "when a user has pnpm and not npm, can we
accommodate that". Scoped by the user to serve both this skill repo's own
usability and, primarily, **consumer repos** that adopt these skills via
`npx github:Lbstrydom/claude-engineering-skills <dir>`.

**What exists today**: `scripts/lib/install/deps.mjs` auto-installs missing
audit-loop deps into a consumer repo by hardcoding
`npm install --save-dev --legacy-peer-deps`, including a Windows-specific
`npmInvocation()` shim (spawn Node's bundled `npm-cli.js` directly — avoids
the CVE-2024-27980 `.cmd`-without-`shell:true` EINVAL). Several call sites
(`playwright-runner.mjs`, `check-setup.mjs`, `nav-audit.mjs`,
`persona-consistency-run.mjs`, `ux-lock-run.mjs`, `fit-check/rules.mjs`)
print or fall back to a hardcoded `npx <bin>` regardless of the consumer's
actual package manager.

**Measured, not assumed** (empirically verified in scratch npm/pnpm consumer
repos, 2026-08-15):
1. Plain `npm install` in an npm-managed `node_modules` tree — no issue.
2. `pnpm install --save-dev` on the SAME argv shape as the npm invocation
   fails or produces an `ERR_PNPM_...` class error; npm cannot read pnpm's
   symlinked `node_modules` layout at all, so the auto-installer had never
   worked for a pnpm consumer.
3. `npx <bin>` runs the LOCALLY installed copy (`node_modules/.bin`) and
   fetches nothing when the package is already a dependency. `pnpm dlx <bin>`
   does **not** have this property — it resolves and downloads a copy from
   the registry unconditionally, even when an identical version is already
   installed locally (measured: playwright 1.62.1 locally installed, `pnpm
   dlx playwright --version` still reported "downloaded"). `pnpm exec <bin>`
   is the local-first analogue of `npx <bin>`.
4. A real (unrelated) peer-dependency conflict — `eslint@9` next to
   `eslint-config-standard@17` (which peer-requires `eslint@^8`) — makes
   plain `npm install` hard-fail with `ERESOLVE`; the same package.json under
   plain `pnpm install` succeeds with a `[WARN] Issues with peer
   dependencies found`. So `--legacy-peer-deps` is solving a real npm-only
   problem; pnpm does not need an equivalent flag.
5. `pnpm dlx github:owner/repo` refuses a git-hosted package with a
   `prepare` lifecycle script (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`) —
   pnpm is deny-by-default on lifecycle scripts where npm is allow-by-default.
   `npx github:...` remains the only working spelling of the one-shot
   install command for any consumer package manager.

## Design

Add one small module, `scripts/lib/package-manager.mjs`, as the single
place that:
- **Detects** a target repo's package manager from `package.json`'s
  `packageManager` field (highest priority — an explicit declaration) or
  lockfile evidence (`pnpm-lock.yaml` / `yarn.lock` / `bun.lockb` /
  `package-lock.json`), defaulting to `npm` when there is no evidence at
  all, and reporting `ambiguous: true` (never guessing) when two lockfiles
  disagree — because installing with either manager writes a lockfile the
  other does not own, corrupting a correctly-configured consumer either way.
- **Builds argv** for "add a dev dependency" and "run an installed binary"
  per manager (`npm`/`pnpm`/`yarn`/`bun`), each spawned without a shell via
  the same Windows `.cmd`-avoidance pattern `npmInvocation()` already used
  (extended, not duplicated).
- **Renders a human-facing hint string** for the two related-but-distinct
  failure states: package not installed at all (needs an `add` + an `exec`)
  vs. package installed but the browser binary missing (needs only the
  `exec` half) — collapsing them tells a user with no Playwright to run a
  binary they do not have.

`scripts/lib/install/deps.mjs`'s `ensureAuditDeps` routes through the
detector instead of a hardcoded `npmInvocation()`; every `npx playwright
install chromium` display string across `check-setup.mjs`, `nav-audit.mjs`,
`persona-consistency-run.mjs`, `ux-lock-run.mjs`,
`scripts/lib/visual/extract.mjs`, and `scripts/lib/fit-check/rules.mjs`
routes through `playwrightInstallHint()` / `playwrightBootstrapHint()`
instead of a literal string, so the manager check exists in exactly one
place. `scripts/lib/playwright-runner.mjs`'s own Playwright-CLI spawn also
imports the module (for the human-facing hint on its now-fail-closed
"package unresolvable" path — see Acceptance Criteria).

**Full implementation-file list**, each file's responsibility for this
change:

| File | Responsibility |
|---|---|
| `scripts/lib/package-manager.mjs` | New — the single detector/invocation/display module |
| `scripts/lib/install/deps.mjs` | Consumer dep auto-install, routed per-manager |
| `scripts/lib/playwright-runner.mjs` | Playwright CLI spawn; missing-package hint |
| `scripts/check-setup.mjs` | Local setup-check Playwright hints (two states) |
| `scripts/nav-audit.mjs` | `--verify` Playwright-missing hint |
| `scripts/persona-consistency-run.mjs` | Consistency-mode Playwright-missing hint |
| `scripts/ux-lock-run.mjs` | `spec`/`verify` Playwright-missing hints |
| `scripts/lib/visual/extract.mjs` | Chromium-unavailable hint |
| `scripts/lib/fit-check/detect.mjs` | Repo-shape profile carries `packageManager` + ambiguity |
| `scripts/lib/fit-check/rules.mjs` | Per-manager Playwright setup line in fit-check output |
| `AGENTS.md`, `README.md` | Documented the security-relevant `exec`-vs-`dlx` distinction and what the one-shot installer does |
| `tests/package-manager-detection.test.mjs` | New — the detection/argv/hint contract |
| `docs/plans/pnpm-consumer-support.md` | This plan |

**Out of scope (deliberately)**: full yarn/bun install-flow parity beyond
detection + display (no consumer-repo report has asked for it — adding
untested execution paths for managers nobody here uses would be
speculative, not requested); changing the documented `npx
github:Lbstrydom/...` one-shot install command to anything else (point 5
above shows the alternatives are strictly worse or broken); adding a
`--legacy-peer-deps`-equivalent flag to non-npm managers (point 4 shows they
don't need one).

## Acceptance Criteria

- [ ] `detectPackageManager` correctly identifies npm/pnpm/yarn/bun from
      lockfile evidence, prefers a declared `packageManager` field, and
      reports (never silently guesses) when a repo carries two lockfiles.
- [ ] `ensureAuditDeps` installs into a pnpm consumer using `pnpm add -D`
      (not `npm install`), and into an npm consumer exactly as before
      (byte-identical argv, so no behaviour change for existing consumers).
- [ ] Every Playwright-binary-missing hint in the bundle renders the
      consumer's own package manager's `exec` form, never a hardcoded `npx`
      for a non-npm consumer.
- [ ] No hint or code path emits `pnpm dlx`/`bunx` for a package the bundle
      already depends on — `dlx`/`bunx` fetch unconditionally and are
      reserved for genuinely-not-installed binaries.
- [ ] `npm run check` passes; `tests/package-manager-detection.test.mjs`
      covers detection (both directions — never a false npm, never a false
      pnpm), argv construction (no npm-only flag reaches another manager),
      and the local-exec-vs-registry-fetch distinction.
- [ ] README documents the security-relevant `exec`-vs-`dlx` distinction and
      what the `npx github:...` one-shot installer actually does (runs a
      `prepare` lifecycle script from the fetched repo), with an
      audit-first alternative (clone + inspect + `npm run sync
      --target-path`) and a `#<tag-or-sha>` pinning option.

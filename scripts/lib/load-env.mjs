/**
 * @fileoverview The one env-loading import for CLI entry points.
 *
 * Import this for its side effect, first in the import list:
 *
 *     import './lib/load-env.mjs';
 *
 * **Never `import 'dotenv/config'`.** That specifier reads exactly
 * `${process.cwd()}/.env` and nothing else — no walk-up, no git-root, no
 * main-worktree fallback, and no shared `~/.audit-loop.env` layer. Every one of
 * those four is load-bearing somewhere this tooling runs, and the failure is
 * silent: the file simply isn't found, `process.env` stays empty, and the
 * script proceeds credential-less. There is no error to read.
 *
 * **The incident (2026-08-15).** `.env` is gitignored, so it is absent from
 * every LINKED WORKTREE — and this repo creates worktrees at
 * `<repo>/.claude/worktrees/<name>`. Measured in one: after
 * `import 'dotenv/config'`, `AUDIT_DB_URL`, `OPENAI_API_KEY`, `GEMINI_API_KEY`
 * and `ANTHROPIC_API_KEY` were all unset, while the main checkout's `.env` sat
 * two levels up carrying every one of them. 16 CLI entry points loaded env this
 * way and never transitively reached `config.mjs`, so they were cwd-blind for
 * their whole lives. The same shape hits a consumer repo whenever a command is
 * run from a subdirectory rather than the repo root.
 *
 * The resolver already existed —
 * {@link module:scripts/lib/shared-cloud-config.discoverLocalEnvPath}, which
 * asks git which repository `cwd` belongs to and searches only that repository:
 * the nearest `.env` at or above `cwd` but never past the repo root, then the
 * MAIN worktree's root `.env` via `--git-common-dir/..` (the branch that fixes
 * the incident above), and an unbounded upward walk ONLY when `cwd` is not in a
 * work tree at all. 16 entry points just didn't use it. This module exists so
 * that using it costs exactly one line, because a correct-but-inconvenient seam
 * loses to `import 'dotenv/config'` every time.
 *
 * **The follow-on incident (2026-08-17)** is why the repository, not proximity,
 * decides. The resolver used to walk up first and unbounded, reaching git only
 * if that found nothing — so a stray `.env` one level above a worktree parked in
 * a temp directory shadowed the repo's own, and the git branches never ran.
 * Silent again, and expensive: see that function's docstring.
 *
 * **Why a side-effect module and not an exported function.** The two-line form
 * (`import { loadSharedEnv } …; loadSharedEnv();`) can be half-applied — import
 * without call — and that failure looks identical to the bug being fixed. A
 * bare side-effect import cannot be half-applied.
 *
 * Idempotent: `loadSharedEnv` latches internally, so importing this from
 * several modules in one process costs one FS read.
 *
 * Enforced by `tests/env-loading-single-oracle.test.mjs`, which fails on any
 * reintroduced `dotenv` import outside this module's own dependency chain.
 *
 * @module scripts/lib/load-env
 */

import { loadSharedEnv } from './load-shared-env.mjs';

loadSharedEnv();

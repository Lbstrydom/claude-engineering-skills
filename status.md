# Project Status Log

## 2026-08-30 — persona-test: auth-bootstrap connect-time race fixed

### Consumer Verification (previous ship)
- **Ships covered**: `1f7def5a` (0.5h store fan-out + AGENTS.md condensation), `8fddec08` (layering + gate-verb dispositions), `56b2ecbc` (status log). All on `main`.
- **State**: `verified` (transfer, and the SUBJECT behaviour in a real consumer), `unverified` (independent fresh-clone battery).
- **Transfer — `verified`**: `git ls-remote origin main` → `56b2ecbc`, byte-matched against local HEAD. Read from the remote ref, not from `git push`'s exit code — which again mattered: the push exited 0 while its post-push sync exited 1.
- **The subject, checked in the consumer** (`storyline`): the consumer's condensed preflight form is still on disk after the push-triggered sync; `verify-sync-invariants.mjs` → PASS. Its `.sync-receipt.json` reads `source.commitSha 56b2ecbc` with `divergenceRefused: 16` — the divergence gate holding across a third consecutive push, which is the case the 2026-08-29 self-erasing-refusal defect got wrong.
- **`Errors: 1` on the post-push sync is CORRECT**, not a regression: it is the gate refusing storyline's 16 diverged `SKILL.md`. wine-cellar-app and ai-organiser synced normally.
- **The 0.5h fan-out itself — `verified` against live stores**: `npm run upstream:queues` reports **8 open across 2 stores** (4 HIGH, all from `louis-strydom_wartsila/storyline`) where the old single-store read printed `0 open`. Stores are named by fingerprint + consumer names; no DSN or hostname in the output.
- **`unverified` — independent fresh clone**: no `git clone` into a tempdir + full battery. Blocked prerequisite: not run this session. The pre-push hook ran the full `check` in its own throwaway worktree at each pushed sha and passed — producer-side, explicitly not consumer-side proof.
- **Outstanding**: (a) `storyline` can declare its 16 paths in `.sync-overrides.json` and retire `verify-sync-invariants.mjs`, or adopt the upstream form — until then every sync to it exits 1 by design. (b) The 8 open reports the fan-out surfaced are untriaged; closing one belonging to another store needs that store's DSN in the environment, since `upstream ack|fix|wont-fix` still writes to the ambient one.

### Origin
`references/auth-bootstrap.md` documented seeding a Playwright `storageState`
file for auth-gated persona runs, but the flow raced: the MCP server reads
`--storage-state` once, at connect time. Re-seeding mid-session (e.g.
`npm run persona:auth`) writes a fresh token nobody re-reads, so a persona run
that reaches an authenticated surface after the token expires (this repo's
Supabase access tokens last 1 hour) lands on a login form. Phase 3's Special
Cases then routed that straight to P1 "Auth bootstrap did not authenticate the
session" — a rig artefact reported as a product regression, twice in this
repo, costing one false P1.

### Changes
- `skills/persona-test/SKILL.md` — Phase 1 now tells the runner to seed
  `storageState` *before* the MCP server connects, not mid-session. Phase 3's
  login-wall special case now branches three ways instead of two: no
  bootstrap configured (P3, unchanged) / the connect-time race (rig problem —
  try the escape hatch, no finding) / escape hatch fails after a fresh
  re-seed (genuine setup regression — P1, only now).
- `skills/persona-test/references/auth-bootstrap.md` — new "connect-time
  race" section explaining the mechanism, and a new "escape hatch" section:
  re-seed, read the refreshed `storageState`'s `localStorage` entries, inject
  via `browser_evaluate`, reload. Scoped narrowly (only re-applying a value
  the sanctioned bootstrap script already wrote to a trusted local file, for
  the one connection that had permission to use it) so it doesn't contradict
  the document's existing warning against fabricating/injecting credentials
  from an untrusted source. Recovery is explicitly never reported as a
  finding, success or failure of the recovery step alike.
- Reference-index summary trimmed to fit the 120-char frontmatter cap
  (`skills:check` caught it on the first regenerate).

### Verified
- `npm run skills:regenerate` — 2 files written (source → `.claude/skills/`
  copy + manifest), rest unchanged.
- `npm run skills:check` — exit 0 (frontmatter/reference-index byte-match,
  gate-contract dispositions, no stale `.github/skills/`/`.agents/skills/`).

### Files Affected
- Modified: `skills/persona-test/SKILL.md`, `skills/persona-test/references/auth-bootstrap.md`, `.claude/skills/persona-test/SKILL.md`, `.claude/skills/persona-test/references/auth-bootstrap.md`, `skills.manifest.json`

### Notes
- Doc/skill-only change — no code touched, no migration, no plan file. `--gate
  not-run` (no audit ran this cycle).
- Pre-existing gate reads at ship time (unrelated to this change, not acted on
  here): `list-unlocked-fixes` 160 total (31 code / 129 plan, 92 aged out),
  `list-unremediated-acceptances` 136 open (50 accepted-permanent), upstream
  queue clean (0 open across 2 stores).

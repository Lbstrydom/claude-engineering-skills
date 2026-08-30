# Project Status Log

## 2026-08-30 — a bare `createAnthropicClient()` reached PUBLIC Anthropic on an Azure tenant

### The report asked for a sweep; the sweep found the DEFAULT was wrong
Upstream `7af14dd6` (HIGH, from `storyline`) was closed on 2026-08-27 for its two named `symbol-index` call sites and ended with *"worth grepping the rest of the bundle for any other call sites that predate the incident fix"*. That sweep is this entry — left open at the last closure because judging it needs an Azure tenant, and `storyline` is one.

**Measured there, not reasoned about.** `azureConfig.active` true, `AZURE_CLAUDE_ROUTE=apim`, a routed Claude call live in **1.4 s** — and a bare `createAnthropicClient()` doing one of two things depending only on whose machine it ran on:

| machine | bare call |
|---|---|
| carries a personal key in `~/.audit-loop.env` | **corporate source → `api.anthropic.com` on that personal credential** |
| no personal key — the real corporate machine | throws `ANTHROPIC_API_KEY required`, beside an unused working route |

`isClaudeAvailable()` returned **false** on that tenant, so `context.mjs`, `neighbourhood-query.mjs` and `audit-loop.mjs`'s **MANDATORY** final review skipped themselves silently. Fourth instance of the availability-gate class.

### The fix is the seam, not the call sites
Patching the ~30 bare call sites would have been the **fifth** per-site fix of this shape. Instead an OMITTED `azureRoute` adopts the environment's route, so a bare call is correct by construction; `azureRoute: null` is the explicit opt-out for the three arms whose provider id *means* the public service (`claude-opus`, its shadow, model-eval's non-azure branch) — omitting it there would make an A/B compare a provider with itself.

`buildClaudeRoute` moved to a pure [`azure-claude-route.mjs`](scripts/lib/azure-claude-route.mjs) so `anthropic-client` reads the same oracle without importing `config.mjs`, whose module-level `loadSharedEnv()` injects exactly the personal credential this keeps off a corporate host. With a route resolved, `ANTHROPIC_API_KEY` is now **unreachable** rather than outranked. Off Azure everything is byte-identical (the resolver keys on `AZURE_OPENAI_ENDPOINT`); a half-configured profile throws rather than demoting to public.

**Verified end-to-end in the consumer after sync**, with `ANTHROPIC_API_KEY` deleted: a bare call reached the APIM endpoint and answered. An earlier probe read empty and was *not* accepted as a pass — the default redactor had eaten the all-caps sentinel, a probe artifact found by printing the raw response rather than trusting the empty string.

### What the audit found, and what it manufactured
`/audit-code` on the diff raised 11. Gemini final review: **0 new, 0 wrongly-dismissed, coherence Strong, no Claude bias, 8 GPT false positives confirmed.**

- **2 fabricated.** Both claimed the test supplies `secret = '[REDACTED:openai-key]'`. The real line is `'sk-or-v1-DEADBEEFDEADBEEF'` — `DEADBEEF` *is* a substring of the credential, so the assertion proves exactly what it claims. **The egress redactor rewrote the source before the model saw it, and the model then reasoned about its own redaction.** Grep the quote first.
- **1 false**: `AZURE_AI_API_KEY` "missing from `TOUCHED`" — it is on line 41.
- **1 refuted by both reviewers independently**: the `/openai/v1` plan mismatch, superseded by the plan's own dated 2026-08-12 log entry. Small real hazard fixed anyway — those lines carried no forward pointer, so `SUPERSEDED` callouts were added.
- **3** were my own untracked scratch probe. Deleted.
- **2** deferred on *independence*, not authorship, with the reasoning recorded per entry.

**Gemini caught a bookkeeping error of mine**: I mapped rulings to finding IDs by assumed ordinal and shifted four of them. Substantively right, attached to the wrong rows — and the ledger feeds the next round's suppression, so it matters. Re-mapped by matching on content.

### The one real new finding, and the bigger thing behind it
`refresh-incidents.mjs` resolved `modelToUse = azureConfig.embedDeployment` itself instead of calling `resolveEmbedProfile()`, so under Azure the **security** index stored a bare deployment name while the **arch** index stored the endpoint-qualified id — two provenance formats in one store, and a deployment-name collision across two Azure resources reading as one vector space.

The call-site list guarding this was **hand-written and did not know that file existed**. Replaced with a CENSUS iterating the filesystem — the only side that can see a caller nobody mentioned — plus a mirror check for stale entries. It immediately found **five more** `embedText()` callers: two query-side and exempt, but **three persist `finding_embeddings.embedding_model` as the configured Gemini default even when Azure made the vectors**. Same defect, third table.

**Deliberately not fixed here**, exempted *with the reason written down*: that change alters the stored string, so old and new rows would stop comparing inside `semantic-suppress`'s similarity matching. It needs a backfill/compat decision, not a one-line swap. Spawned as its own task.

### AGENTS.md
Depth lives in [`azure-work-profile.md`](docs/runbooks/azure-work-profile.md) §"Which Claude a bare `createAnthropicClient()` reaches"; AGENTS.md keeps the rule plus a pointer. Headroom **698 → 510** — net 188 chars for a new load-bearing invariant, after a first draft that cost 428.


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

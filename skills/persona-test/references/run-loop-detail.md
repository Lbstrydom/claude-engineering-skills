---
summary: Why the run-loop rules exist — cloud probe, auth at connect, cache-bust, stateful missions, Ready-for-users.
---

# Run-loop detail — rationale behind the resident rules

Each section below backs a one-line rule that stays resident in SKILL.md.

## Pre-flight — why the cloud probe goes through `whoami`

**Do NOT read `AUDIT_DB_URL` from the Claude Code session's `process.env`.** The
consumer repo's `.env` (and the shared `~/.audit-loop.env`) are not loaded into
the session, so a bare env check reports false negatives — the var looks unset
even when cloud is fully configured, and the session silently runs stateless.
`cross-skill.mjs` resolves config itself (it loads `.env` + the shared file via
`config.mjs`); the pre-flight probe must go through it rather than reading
`process.env` directly.

Run this probe from the consumer-repo root (the same cwd used for every
`node scripts/cross-skill.mjs` call) — `whoami` reports the real cloud state
via `isCloudEnabled()` (an actual pool-presence check, not an env guess).

## Phase 1 — login-gated targets and the connect-time race

**If the target requires login for its primary surfaces** (not just an
optional account page), check whether the MCP session is already
authenticated (e.g., landing on a logged-in view instead of a login
form) before assuming a login wall will block the run. If it isn't, and
this is a repeat session against the same app, ask whether a
`--storage-state` bootstrap has been set up for it — see
`references/auth-bootstrap.md`. **Seed it before the MCP server
connects**: `.mcp.json` is read once, at connect time, so running the
seeding step mid-session writes a fresh token to disk that nobody
re-reads — the browser keeps carrying whatever was on disk at connect,
and with a short-lived token that run still hits a login wall later, even
though setup looked fine. This is a **one-time per-session setup step**,
not something to attempt mid-exploration. If a login wall does appear
mid-run anyway, it may be that connect-time race rather than a broken
bootstrap — see Phase 3's login-wall special case for the decision order
that tells them apart before reporting anything.

## Phase 1b — why the cache-bust is mandatory

Service workers silently serve stale bundles. A fix that *is* deployed
appears to "not be deployed" because the SW handed the persona last week's
JS. This was a real failure mode in wine-cellar-app — burned ~30min of
verification before we realised. Always cache-bust before the first action.

## Phase 3 — the stateful-mission incident

A persona goal that **creates, submits, approves, completes, or selects an
item and hands it to another screen** is a stateful mission. Reaching the goal
is not the same as verifying it: a run once read `Ready for users` with 0
P0/P1, and a deeper run of the same app found two P1s — the handover opened a
*different* item than the one selected before navigation, and a completed item
vanished from its queue instead of showing as completed. Both were visible
only by checking state across the boundary, not by reaching the end.

Every work-record field is a direct record of something this loop already
decides — this adds recording discipline, not new judgement calls.

## Phase 4 — the `authWallUntested` gate-honesty rule, in full

**Gate-honesty rule for `authWallUntested`**: 0 P0 findings on an
`authWallUntested` run means "0 P0s on the public shell", not "0 P0s on
the app". OVERALL must never read `Ready for users` in this case — cap it
at `Needs work` so a downstream consumer (`/cycle` Step 5) can't read this
run as a clean pass on a surface it never reached. This mirrors click-test's
rule that the OVERALL verdict caps at `Incomplete` when any route is
`auth-required` — same failure mode, same fix. Phase 5's composed
eligibility predicate is this rule generalised: `authState !==
'auth-wall-untested'` is one of three independent conjuncts a run must
satisfy to read `Ready for users`, because the loop continuing past an
untested wall onto public pages can otherwise reach its goal and read
`terminalReason: 'goal-reached'` while the wall is still untested — a
single-field check on `terminalReason` alone would silently drop this
exact guarantee.

## Phase 5 — why the predicate is composed

Any failing conjunct caps OVERALL at `Needs work`, and the Reason line names
**every** failing conjunct (a run can fail more than one). This generalises
the pre-existing `authWallUntested` cap as one named conjunct rather than a
special case beside it — a session can hit an untested auth wall, continue
exploring public surfaces (per the Special Cases rule below), and still end
`terminalReason: 'goal-reached'`; checking `terminalReason` alone would
silently clear that run as Ready even though its primary authenticated
surfaces were never covered. Example:

```
OVERALL: Needs work
  Reason: authState=auth-wall-untested — primary authenticated surfaces
          untested — login wall hit, no auth bootstrap configured
          (see references/auth-bootstrap.md).
```

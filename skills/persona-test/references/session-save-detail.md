---
summary: Phase 6/6b detail — session-id minting, clickPath edges, response fields, correlationSummary, manual repair.
---

# Session save + correlation summary — detail

The Phase 6 `record-persona-session` command, its payload, and the Phase 6b
read rules stay resident in SKILL.md. This file holds the field semantics and
history behind them.

## Session id — why the CLI mints it

**Do NOT build a session ID yourself.** Omit `sessionId` and the CLI mints a
collision-resistant one (`buildPersonaSessionId` — unix seconds + a
`crypto.randomUUID()` suffix) and returns it as `sessionKey`. The old hand-built
`persona-test-<unix timestamp>` shape collided across repos in the same second
and silently overwrote the other repo's session. Pass `sessionId` explicitly
ONLY to re-post an existing session (it is the idempotency key).

## `clickPath` edges

Across the Plan → **Act** → Reflect loop, accumulate **one entry per Act step** that
*moved or activated something* (click / navigate / open / submit) — this is the
path the persona actually reached, which `/nav-audit --bootstrap` seeds its contract
from.

- **NEVER include typed input values.** `targetText` is the control's *visible
  label* (e.g. "Add bottle", "Cellar"), never what you typed. The store rejects any
  entry carrying a `value`/`input` key and sanitizes the URL + redacts `targetText`
  server-side — but don't send secrets in the first place.
- Omit the field entirely (don't send `[]`) if you didn't track a path — re-posting
  a session with `clickPath` omitted preserves any path already recorded.
- The store caps the stored path at 40 steps and drops malformed entries; you don't
  need to pre-trim, but keep it to the meaningful navigation steps.

## Response fields

Response `{"ok": true, "cloud": ..., "sessionId": "<uuid>", "sessionKey":
"<persona-test-…>", "existed": bool, "statsUpdated": bool, "statsReason": ...,
"correlationSummary": {...}, "verdictCap"?: {...}}`. `sessionId` is the row's uuid PK — that is the
one later phases pass as `personaSessionId`. `sessionKey` is the minted
`session_id` text, needed only to re-post this same session.
If `statsUpdated: false`, the session is preserved but the persona's
`last_tested_at`/`last_verdict` were NOT updated, and `statsReason` says why:
`no-persona-id` (an ad-hoc persona not in the registry — pass the registered
id when one exists), `stats-write-failed` (the update threw; see stderr), or
the rare `persona-not-found` (the persona was deleted mid-run). No reconciler
back-fills these fields; do not report them as self-healing.

## Phase 6b — the correlator became automatic (2026-07-13)

**As of 2026-07-13 this step is deterministic, not agent-discretionary.**
`record-persona-session` (Phase 6) runs the correlator automatically —
immediately after the session commits, matching every P0/P1 finding against
recent audit findings for the repo and writing `persona_audit_correlations`
rows itself. There is nothing to emit here; **do not call `record-correlation`
per finding** — that CLI now exists only for manual repair (see below), and
calling it redundantly for a finding the auto-correlator already wrote will
just leave a second, identical row (or, for a genuinely different
`auditFindingId`, a legitimate additional manual correlation — see the
schema's multi-row-per-pair note in `references/audit-correlation.md`).

## `correlationSummary` shape and fields

```json
{
  "attempted": true,
  "reason": null,
  "candidates": 4,
  "route": 1, "fuzzy": 1, "missed": 1,
  "skippedExisting": 0,
  "malformed": 0,
  "writeFailed": 0,
  "matcherVersion": 2
}
```

`route` counts matches whose file axis came from the finding's page URL naming
the audited file (`/score_entry` ↔ `2_score_entry.py`); `fuzzy` counts
matches on path/keyword token overlap alone. There is no `exact` tier since
matcher v2 — it compared two identities that could never be equal.

`malformed > 0` means
some P0/P1 findings were missing `element`/`observed` and were quarantined —
never hashed or matched (a missing-field finding degrading to a shared empty
identity would collide with every other malformed finding, corrupting ground
truth — quarantine is correct, not a bug).

## Manual repair — background

The auto-correlator's keyword matcher has real recall limits — a paraphrased
symptom description can miss a real audit finding it should have
matched. The store automatically retires the stale `audit_missed` row
when you supply a real `auditFindingId` — you never need to clean it up
yourself. `audit_false_positive` and `severity_overstated` require
human judgment (a flagged issue that couldn't be reproduced) and are
never auto-emitted.

The finding-hash contract is unchanged in spirit but the ALGORITHM changed
(2026-07-13): `personaFindingHash()` now lives in
`scripts/lib/persona/audit-correlator.mjs` — see the updated formula in
`references/audit-correlation.md` (the old `sha256(element+observed+code)`
inline formula is retired; compute it the same way the auto-correlator does
so a manual repair's hash matches the auto-emitted row it's correcting).

- Idempotent: the writer dedupes on `(persona_session_id, persona_finding_hash,
  audit_finding_id)`, so re-running is safe. Supplying a real `auditFindingId`
  for a hash that previously auto-emitted `audit_missed` automatically retires
  that stale NULL-match row — no separate cleanup step.

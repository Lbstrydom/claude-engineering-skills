# Plan: Friction Log + Weekly Digest Surface (v1)

- **Date**: 2026-05-09
- **Status**: Complete — shipped 2026-05-09; schema applied to live Supabase; auto-archived via `/ship` Step 5.5
- **Author**: Claude + Louis
- **Scope**: backend (js-ts; consumes audit-orchestration + learning-store + skills domains)
- **Origin**: 2-LLM brainstorm (OpenAI + Gemini) on "build a dashboard?" — synthesis chose friction-log over a chart-driven dashboard, surfaced in the existing weekly digest

---

## 1. Context Summary

Two competing diagnoses of what's scarce right now:
- **OpenAI/Gemini**: data visibility — extend the weekly digest with metrics
- **Claude**: insight capture — let real-time friction tell you which metrics matter

The synthesis ships **both** in their smallest forms: a 30-second `npm run audit:wtf <message>` that captures friction the moment it happens, and a "Friction notes" section in the weekly digest so the captured signal lands in the workflow you already use. We deliberately SKIP the metrics-summary section of the digest (cost-per-finding, posterior charts, etc.) until 2 weeks of friction data tells us which metrics actually correlate with annoyance.

### Detected scope + stack
- Scope: backend
- Stack: js-ts (Node ESM)
- Target domain(s): `learning-store`, `skills`, `weekly-review`

---

## 2. Proposed Architecture

### A. `friction_log` table (Supabase)

```
CREATE TABLE friction_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id      uuid REFERENCES audit_repos(id) ON DELETE SET NULL,
  audit_run_id uuid REFERENCES audit_runs(id)  ON DELETE SET NULL,
  message      text NOT NULL,
  cwd          text,
  severity     text NOT NULL DEFAULT 'note'
    CHECK (severity IN ('note','annoyance','blocker')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX friction_log_repo_created_idx
  ON friction_log (repo_id, created_at DESC);
ALTER TABLE friction_log ENABLE ROW LEVEL SECURITY;
-- service-role only, matching learning_decisions pattern
```

### B. `scripts/friction-log.mjs` — capture CLI

```bash
npm run audit:wtf "the quickfix hook fired 4× on the same line"
npm run audit:wtf --severity blocker "convergence_predict telemetry hangs the audit"
npm run audit:wtf --repo wine-cellar-app "out-of-scope auto-defer caught a real security finding"
```

Pure CLI; no LLM calls. Resolves repo from cwd (or `--repo` flag), grabs the most recent audit_run_id from `audit_runs` for that repo if any, writes one row to `friction_log` via service-role client. Sub-second latency (the whole point — has to be cheaper than ignoring the friction).

CLI output contract: stdout JSON (one-line `{ok:true, id:"..."}`); stderr human-readable confirmation. Exit 0 on success even if cloud is offline (graceful degradation — friction is logged to a local fallback `.audit/friction-log.jsonl`).

### C. `scripts/learning/weekly-review.mjs` extension

Add a NEW section between "Awaiting triage" and "No-brainer fix-now":

> ## 2. Friction notes from the past 7 days
>
> | Severity | Repo | When | Note |
> |---|---|---|---|
> | blocker  | wine-cellar-app | 2d ago | convergence_predict telemetry hangs |
> | annoyance | claude-audit-loop | 4d ago | quickfix hook fired 4× on same line |
> | note     | ai-organiser | 6d ago | recurring cluster looks like real bug |

Cap: **5 entries per repo**, sorted by `severity DESC, created_at DESC`. Same per-repo filter as everything else in weekly-review (uses `LEARNING_REPO_NAME`).

The existing 7-item total cap from Phase 1 stays put — the friction-notes section gets its own allocation: **3 friction notes**, then the existing 3 triage + 3 no-brainer + 1 stale split is reduced to 2+2+0. Total still 7 (visual cap); friction notes prioritised when present.

### D. Cross-skill subcommand + npm script

```bash
node scripts/cross-skill.mjs friction-log "msg" --severity annoyance --repo wine
npm run audit:wtf -- "msg"
```

The npm script is the operator-friendly handle; the cross-skill subcommand is the shared dispatch surface (matches Phase 1+2+3 conventions).

---

## 3. File-Level Plan

| File | Action | Notes |
|---|---|---|
| `supabase/migrations/20260509120000_friction_log.sql` | NEW | Single table + RLS service-role only |
| `scripts/friction-log.mjs` | NEW | Capture CLI; sub-second latency target; local-fallback on cloud failure |
| `scripts/learning-store.mjs` | EDIT | Add `insertFrictionNote(...)`, `readRecentFriction({repoId, sinceMs, limit})` |
| `scripts/learning/weekly-review.mjs` | EDIT | New `buildFrictionSection()`; insert into section ordering; tweak cap allocation |
| `scripts/cross-skill.mjs` | EDIT | Add `friction-log` subcommand |
| `package.json` | EDIT | Add `audit:wtf` script |
| `tests/friction-log.test.mjs` | NEW | Tests for the capture CLI (graceful degradation, severity validation, repo resolution) |
| `tests/learning-weekly-review.test.mjs` | EDIT | Add tests for buildFrictionSection + cap reallocation |
| `AGENTS.md` | EDIT | Document the friction log + when to use each severity |

---

## 4. Acceptance Criteria

| ID | Criterion |
|---|---|
| AC1 | Migration `20260509120000_friction_log` applied to live Supabase |
| AC2 | `friction_log` table exists with RLS enabled + service-role-only access |
| AC3 | `npm run audit:wtf "msg"` writes one row in <2s end-to-end |
| AC4 | `--severity blocker` accepted; `--severity nonsense` rejected with non-zero exit |
| AC5 | Cloud-offline mode falls back to `.audit/friction-log.jsonl` and exits 0 |
| AC6 | `weekly-review` includes "Friction notes" section when notes exist in last 7 days |
| AC7 | Section cap of 3 friction notes; rest shown as `(...and N more — npm run audit:friction)` |
| AC8 | When no friction notes in window, section is omitted entirely (not "Friction: none") |
| AC9 | All existing tests stay green |

---

## 5. Out of Scope

- Metrics section in the digest (cost-per-finding, posteriors, etc.) — explicitly deferred per brainstorm synthesis until 2 weeks of friction data signals which metrics matter
- A separate friction-review CLI (`audit:friction`) — defer until the volume justifies it; for now, query friction_log directly via Supabase Studio
- Slack/email alerting on `severity=blocker` notes — defer
- Auto-correlation between friction notes and audit runs (which finding caused this annoyance?) — defer to v2 once we have enough notes to justify the join logic

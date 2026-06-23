# Plan: Harden consumer deployment — prevent silent local-patching of synced tooling

- **Date**: 2026-06-04
- **Status**: **Complete** — all three phases built, tested, and deployed (the
  "Draft" label was stale). Phase 1 banner: `scripts/lib/sync-banner.mjs`
  (`injectUpstreamBanner`) wired into `sync-to-repos.mjs`, 26 passing tests, and
  the banner is live in consumers (verified in wine-cellar-app's synced
  `cross-skill.mjs`). Phase 2: the managed `.gitignore` ephemera block (six §5
  paths) + managed `.gitattributes` EOL pins (`eol=lf`) are applied by
  `sync-to-repos.mjs` and present in consumers. Phase 3: the upstream-owned
  governance policy is in AGENTS.md. The `sync:verify` idea was dropped at build
  time (Gemini-R2 — redundant with `sync:dry`).
- **Author**: Claude + Louis
- **Scope**: backend (sync subsystem) + a one-line AGENTS.md policy
- **Target domain(s)**: `cross-skill` / sync

> **Problem.** Synced tooling lands in consumers under `scripts/.claude-skills/`
> (gitignored). When an agent hits a bug there mid-task, the deceptively easy
> path is to edit that file locally — but it's invisible to review (gitignored),
> overwritten on the next sync (fix lost), and the upstream bug never gets fixed
> (every consumer keeps hitting it). It's the band-aid vs root-cause failure at
> the consumer/upstream seam. Today nothing warns against it: synced files carry
> no marker, and the manifest-hash drift detector runs only at migration.

## Right-sizing gate (Design right-sizing, AGENTS.md)

New structure introduced: a banner injected into synced files + gitignore/EOL
managed entries. Stating the cliffs:

- **Band-aid extreme**: a `README` in `scripts/.claude-skills/` saying "don't
  edit." Rejected — not seen at the moment of temptation (opening the file).
- **Over-engineered extreme**: per-file checksums verified on every tool
  execution, a file-watcher daemon, signed manifests, a custom integrity
  framework. Rejected — solving problems we don't have; huge moving parts.
- **Chosen (right-sized)**: sync injects a one-line **comment banner** at the
  top of each relocated **commentable** tooling file (seen exactly when an agent
  opens it to edit), **reuse** the existing manifest-hash detector as the
  backstop (build nothing new), and add a one-line always-on policy. Current
  requirement: stop silent local-patching; nothing here exceeds it.

## Design

1. **Banner forcing-function (primary).** In `sync-to-repos.mjs`, for files whose
   destination is under `scripts/.claude-skills/` AND whose extension is
   comment-capable (`.mjs/.js/.cjs/.sh`), prepend an idempotent banner after any
   shebang:
   ```
   // ⚠ UPSTREAM-OWNED — DO NOT EDIT HERE. Synced from claude-engineering-skills
   //   and OVERWRITTEN on next sync. A bug here is an UPSTREAM bug: fix it there
   //   + re-sync. Editing the synced copy = silent drift, lost on next sync.
   ```
   Pure helper `injectUpstreamBanner(content, ext)`; idempotent by construction
   (source has no banner → each sync injects exactly one). JSON tooling can't
   carry comments → skipped (covered by the detector + dir name). Banner is a
   comment, so import-intended modules (e.g. `build-surfaces-manifest.mjs`) stay
   importable.

2. **Always-on policy (one line).** AGENTS.md: a failure in a synced
   `scripts/.claude-skills/**` file is an UPSTREAM bug — push back, fix in
   claude-engineering-skills + re-sync; never patch the synced copy locally.

3. **Drift detector (reuse, backstop) — NO new script.** Detection already
   exists both directions: `npm run sync:dry` from THIS repo reports any consumer
   file that differs from source, and the synced `sync-isolation-verify`
   hash-checks a consumer's tree against its manifest. The earlier "add a
   `sync:verify` npm script" idea was dropped during build (Gemini-R2) —
   `sync:check` is unrelated (Supabase cloud-sync status), and a new wrapper would
   be redundant with `sync:dry` (the over-engineering cliff). AGENTS.md points at
   the two existing entrypoints.

4. **EOL churn fix — DONE (cheaper than the deferral assumed).** A managed
   `.gitattributes` block pins the TRACKED synced surfaces (`.claude/skills/**`,
   `.github/prompts/**`, `.claude/hooks/**`, `.claude/settings.json`,
   `.vscode/mcp.json`, `docs/consistency-contract.md`, `scripts/.sync-manifest.json`,
   `.audit-loop/migrations/**`) to `eol=lf`, so Windows consumers stop seeing
   them as perpetually modified. The earlier deferral assumed this needed
   generalising `updateManagedBlock` — but that helper is already
   content-agnostic (it just writes lines between marker sentinels, which work
   identically in `.gitattributes`), so it was REUSED as-is: a parallel
   preflight + write mirroring the `.gitignore` path, no refactor. Precise globs
   only (never the consumer's own files); `scripts/.claude-skills/**` is
   gitignored so not pinned. One-time renormalization in consumers is expected.

5. **gitignore coverage.** Extend the sync-managed `.gitignore` block to cover
   the generated ephemera our tooling produces in consumers: `dashboard/index.html`,
   `dashboard/telemetry.html`, `.brainstorm/`, `.skills-fit-check.json`, `logs/mcp-*.log[.gz]` (precise
   paths, not blanket dirs).

## 7b. Implementation Phases

**Phase 1 — Banner**: `injectUpstreamBanner` helper + wire into `sync-to-repos.mjs`
at the relocated-tooling write path (after shebang, idempotent, comment-capable
only). Files: `scripts/lib/sync-banner.mjs` (create), `scripts/sync-to-repos.mjs`
(modify), `tests/sync-banner.test.mjs` (create).

**Phase 2 — Managed entries**: extend the sync-gitignore managed block (ephemera)
+ add the managed `.gitattributes` (EOL). Files: `scripts/lib/sync-gitignore.mjs`
(modify) [+ a gitattributes manager if separate], `tests/sync-gitignore.test.mjs`
(modify).

**Phase 3 — Policy**: AGENTS.md upstream-owned policy line pointing at the two
EXISTING drift backstops (`sync:dry` + the synced `sync-isolation-verify`). No
new npm script (Gemini-R2 — `sync:verify` would be redundant). Files:
`AGENTS.md` (modify).

**Close-out (not a phase)**: `npm run sync` to re-deploy banner/gitignore/eol to
consumers; `npm run check`.

## 8. Risk & Trade-offs

- Banner must be a COMMENT (never break `.mjs`/import) + idempotent (no
  accumulation). Tested. JSON skipped by design (documented).
- `.gitattributes` EOL change is forward-only; consumers may show a one-time
  renormalization. Acceptable.
- Detector is reuse, not new — zero new surface.

## 9. Testing Strategy

- `tests/sync-banner.test.mjs`: banner injected once for `.mjs` under
  `scripts/.claude-skills/`; idempotent (re-run identical); placed after shebang;
  NOT injected for tracked `.md`/JSON; import-intended file still parses.
- `tests/sync-gitignore.test.mjs`: managed block includes the new ephemera paths;
  block stays single + valid.
- Tier-1 (deterministic seam) — banner + gitignore are pure string transforms.

> No §11 clustering — single cohesive workstream (sync-deployment seam). Audited
> as one `/audit-code` pass over the diff.

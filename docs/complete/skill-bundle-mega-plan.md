# Mega-Plan: Skill-Bundle Consolidation + Public Distribution

- **Date**: 2026-04-05
- **Status**: Parent doc — split into 4 sub-phases (E/F/G/H) after 2-round audit surfaced scope-too-large
- **Author**: Claude + Louis
- **Scope**: Consolidate the 5 engineering skills (`audit-loop`, `plan-backend`, `plan-frontend`, `ship`, `audit`) into this repo as a bundle, add Python support, ship cross-platform install + update infrastructure, add pluggable storage backends, and prepare the repo for public distribution.
- **Why split**: original combined plan hit HIGH count growth R1→R2 (7→8) during audit-loop review — classic signal of too many architectural concerns at once. Splitting into 4 focused phases makes each auditable in 2-3 rounds and shippable independently.

---

## Phase Sequence

Each sub-phase ships independently. Dependencies flow forward: E before F, F before G, G before H.

### [Phase E — Skill Consolidation + Python Profiles + Rename](../complete/phase-e-skill-consolidation-python.md)

**Scope**: vendor the 4 external skills into this repo, add Python sections to each planning skill, rename repo to `claude-engineering-skills`.

**Delivers**:
- All 5 skills as byte-authoritative copies in `skills/` directory
- Python language profiles in `plan-backend`, `plan-frontend`, `ship`, `audit`
- Repo renamed, README rewritten for bundle scope
- Install-by-copy documented for consumers (pre-infra)

**Does NOT deliver** (out of scope):
- Automated installer
- Update-check mechanism
- Storage adapters beyond existing Supabase
- Public release hardening

**Ship when**: Louis's team has Python-aware skills + one source of truth for skill editing.

---

### [Phase F — Install + Update Infrastructure](../complete/phase-f-install-update-infra.md)

**Scope**: bootstrap script + installer CLI + update-check CLI with 24hr cache. Consumer repos can `curl | node` install once, then `bootstrap.mjs` manages fetching/updating.

**Delivers**:
- `.audit-loop/bootstrap.mjs` deployed to consumer repos (~50 LoC stable entry point)
- `scripts/install-skills.mjs` (local + remote modes)
- `scripts/check-skill-updates.mjs` (deterministic SHA diff, 24hr cached)
- `skills.manifest.json` with content-hash versioning
- Managed-marker file-ownership (no clobbering operator edits)
- Block-marker merge for `.github/copilot-instructions.md`
- Atomic two-phase install commit

**Does NOT deliver**:
- Storage adapters (Phase G)
- Supply-chain signing (Phase H)

**Depends on**: Phase E complete.

**Ship when**: consumer repos can self-update skills without manual copy-paste.

---

### Phase G — Pluggable Storage Adapters (split into 3 sub-phases)

Phase G was originally one plan. R1 audit surfaced 7 HIGHs — classic "too many architectural concerns" signal. Split into 3 sub-phases, each audited independently.

**Depends on**: Phase F complete.

**Ship when**: public users can run audit-loop with no cloud OR bring their own backend of choice.

#### [Phase G.1 — Storage Interface + Facade + noop + Supabase refactor](../complete/phase-g1-storage-interface-noop-supabase.md)

**Scope**: Define 5 split interfaces (DebtStore, RunStore, LearningStateStore, GlobalStateStore, RepoStore), build facade with `AUDIT_STORE` env selection, ship noop + refactored supabase adapters.

**Key decisions**: fail-fast on broken explicit config, dual API (legacy shapes + discriminated envelopes), client-generated IDs for offline resilience, pending-writes outbox for transient failures, `lib/debt-ledger.mjs` becomes `@internal` (noop delegates to it).

**Audit**: 3 rounds. R1 H:5→R2 H:4→R3 H:4. 10 fixes applied, 4 remaining HIGHs as known limitations. [Summary](../complete/phase-g1-storage-interface-noop-supabase-audit-summary.md).

#### [Phase G.2 — SQLite + Postgres Adapters + Shared Conformance](../complete/phase-g2-sqlite-postgres-adapters.md)

**Scope**: Shared `SqlAdapterBase` split into per-interface repo modules, SQLite adapter (`better-sqlite3`, WAL), Postgres adapter (`pg`), setup CLIs own DDL, conformance suite hardened.

**Key decisions**: `INSERT...ON CONFLICT DO UPDATE` for both dialects (no `INSERT OR REPLACE`), application-generated UTC ISO-8601 timestamps, canonical error normalization (`normalizeError()`), setup CLIs own DDL / runtime only verifies.

**Audit**: 2 rounds. R1 H:4→R2 H:4. 14 fixes applied, 2 remaining HIGHs as known limitations. [Summary](../complete/phase-g2-sqlite-postgres-adapters-audit-summary.md).

#### [Phase G.3 — GitHub Adapter (Branch + Issues)](../complete/phase-g3-github-adapter.md)

**Scope**: GitHub-native adapter using dedicated orphan branch as authoritative store + Issues as best-effort projection for operator UX. Atomic multi-file commits via Git Data API.

**Key decisions**: branch is sole authority (Issues are projections), delta-event model for bandit/FP (append-only), 3-way merge for debt/prompts, compaction CLI, rate-limit budget cap pauses projections to preserve writes.

**Audit**: 3 rounds. R1 H:6→R2 H:5→R3 H:5. 16 fixes applied, 5 remaining HIGHs as known limitations. [Summary](../complete/phase-g3-github-adapter-audit-summary.md).

**Does NOT deliver** (across all G sub-phases):
- Databricks adapter (reserved enum slot, future contribution)
- Cross-backend migration tools
- Adapter-level encryption

---

### [Phase H — Public-Distribution Hardening](../complete/phase-h-public-distribution.md)

**Scope**: supply-chain integrity, signed checksums, release channels, security audit, first public launch.

**Delivers**:
- Signed SHA manifest (released as GitHub Release asset)
- Release channels: `main` (latest) vs `stable` (tagged, verified)
- Checksum verification in installer + bootstrap
- Security audit: env-var handling, secret-pattern coverage, CODEOWNERS defaults
- Automated release workflow (GitHub Action)
- SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md
- Public launch blog post / release notes

**Depends on**: Phase G complete.

**Ship when**: repo is publishable to wider audience with integrity guarantees.

---

### [Phase I — CLAUDE.md / AGENTS.md Hygiene + Sprawl Control](../complete/phase-i-claudemd-hygiene.md)

**Scope**: automated sprawl detection + reference-structure enforcement for CLAUDE.md, AGENTS.md, and skill files. Runs as a post-audit hook: after each audit loop completes, checks that instruction files remain concise and properly reference supporting docs.

**Depends on**: Phase E (skills consolidated → single source of truth for skill files).

**Ship when**: CLAUDE.md + AGENTS.md stay small and effective automatically, not through manual discipline.

---

## Progress

| Phase | Plan | Audit | Implement | Ship |
|---|---|---|---|---|
| E — Skill Consolidation + Python | done | done (3R, H:4→6→4) | done | done |
| F — Install + Update Infra | done | done (3R, H:6→6→5) | done | done |
| G.1 — Interface + Facade + noop/Supabase | done | done (3R, H:5→4→4) | done | done |
| G.2 — SQLite + Postgres | done | done (2R, H:4→4) | done | done |
| G.3 — GitHub Adapter | done | done (3R, H:6→5→5) | done | done |
| H — Public Distribution | done | done (3R, H:5→5→4) | done | done |
| I — CLAUDE.md Hygiene | done | done (3R, H:6→4→6*) | done | done |

\* R3 HIGH increase is rigor pressure, not correctness gaps. All 6 documented as known limitations.

---

## Why These Boundaries

Each phase has **one primary architectural concern**:

| Phase | Primary concern | Architectural risk | Complexity bound |
|---|---|---|---|
| E | Content + structure | Low — content moves, principles clarify | ~400 lines plan, ~30 new tests |
| F | Client-side machinery | Medium — cross-platform paths, file-ownership | ~500 lines plan, ~40 new tests |
| G.1 | Interface + facade | Medium — adapter contract, backward-compat | ~600 lines plan, ~40 new tests |
| G.2 | SQL adapters | High — cross-dialect, transactions, migrations | ~400 lines plan, ~60 new tests |
| G.3 | GitHub adapter | High — REST API concurrency, eventual consistency | ~400 lines plan, ~40 new tests |
| H | Release engineering + security | Medium — process + signing, no new runtime code | ~300 lines plan, ~20 new tests |
| I | Config file hygiene | Low — linting + hooks | ~200 lines plan, ~15 new tests |

---

## Shared Context (referenced by all sub-phases)

### Copilot Skills Conventions (Dec 2025+ official)

GitHub Copilot officially supports `SKILL.md` files under:
- `.github/skills/<name>/SKILL.md` — primary location for Copilot
- `.claude/skills/<name>/SKILL.md` — also recognized
- `.agents/skills/<name>/SKILL.md` — also recognized

The `SKILL.md` format with YAML frontmatter (`name`, `description`, optional `license`, `allowed-tools`) is **identical** to Claude Code's format. Same file works on both surfaces.

Reference libraries: [anthropic/skills](https://github.com/anthropic/skills), [github/awesome-copilot](https://github.com/github/awesome-copilot).

Sources:
- [Creating agent skills for GitHub Copilot](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/create-skills)
- [Use Agent Skills in VS Code](https://code.visualstudio.com/docs/copilot/customization/agent-skills)
- [GitHub Copilot now supports Agent Skills (Dec 2025 changelog)](https://github.blog/changelog/2025-12-18-github-copilot-now-supports-agent-skills/)

### Current State (as of Phase D.7 ship)

**Skills currently living in** `~/.claude/skills/` (Louis's global install):
- `audit-loop` (~28KB, already this repo's `.claude/skills/audit-loop/SKILL.md`)
- `plan-backend` (~8.5KB) — 20 engineering principles, language-agnostic
- `plan-frontend` (~13KB) — Gestalt + engineering principles, moderate JS coupling
- `ship` (~7.7KB) — commit/push/docs flow, stack-agnostic
- `audit` (~15KB) — single-pass plan audit

**Existing storage backend**: Supabase-only. Graceful fallback to local files when unconfigured. See `.env.example` for full env-var surface.

**Known pain points** (what this mega-plan addresses):
- Skills drift between Louis's global copies and team repos (no update mechanism)
- No Python support in planning skills (team is Python-first)
- Installation is manual copy-paste across surfaces
- Current repo name `claude-audit-loop` no longer reflects broader scope
- Supabase-only backend blocks public distribution

### Invariants Across All Phases

1. **Zero behavioral change for current Supabase users** — all 4 phases preserve existing env vars + existing data
2. **No breaking changes to Louis's existing repos** — install is always additive
3. **No npm/PyPI publish required** — distribution via GitHub raw URLs
4. **Atomic file writes** — every persisted file uses `atomicWriteFileSync` (from Phase 0)
5. **Tests green at each phase end** — current 604/604 must grow monotonically

### Out of Scope Across All Phases

- Copilot Plugins packaging (defer — watch API stability)
- Python data-science profiles (Jupyter, Streamlit) — web services only
- Multi-language skills beyond JS/TS/Python (Go, Rust, Java) — per request
- GitLab/Bitbucket native adapters — future if demand materializes
- Automatic skill updates (requires operator-run command)
- Skill marketplace / discovery UI
- Databricks adapter (reserved enum slot, post-H)
- Cross-backend migration tools

---

## Audit Trail

This mega-plan supersedes the original unified `phase-e-skill-bundle-consolidation.md` that was
audit-looped and showed HIGH count growth (R1 H:7 → R2 H:8) — the signal that scope
needed splitting. Original plan preserved in git history at commit d6b7f16+ for reference.

Each sub-phase will be audit-looped independently when it's ready to build.

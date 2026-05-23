# Plan: Phase F — Install + Update Infrastructure

- **Date**: 2026-04-05
- **Status**: Complete (shipped — `install.mjs` (one-shot `npx github:Lbstrydom/...` installer) + `scripts/install-prepush-hook.mjs` (consumer-repo pre-push hook installer) + `scripts/sync-to-repos.mjs` (cross-repo sync; the source-only sentinel) + `scripts/check-audit-tool-version.mjs` (staleness gate). Status line corrected 2026-05-23.)
- **Author**: Claude + Louis
- **Parent**: [skill-bundle-mega-plan.md](./skill-bundle-mega-plan.md)
- **Depends on**: Phase E complete (skills vendored, repo renamed)
- **Scope**: ship the client-side machinery that lets consumer repos install + update the skill bundle. Bootstrap script, installer CLI, staleness check. NO storage adapters, NO signing.

---

## 1. Context

Phase E shipped the content: 5 skills in `skills/`, Python profiles, new repo
name. Teams currently copy files manually — tedious, error-prone, and creates
drift between Louis's master copies and team repos.

Phase F ships the mechanism that ends manual copying. Consumer repos run ONE
curl-piped command once, get a stable bootstrap script, and thereafter can
update/install/check via that bootstrap. The bootstrap fetches heavier scripts
from this repo's main branch on-demand, caches them 24hr, and executes.

### Key Requirements

1. **Bootstrap is the ONLY thing consumer repos keep long-term** — heavier installer/checker scripts are fetched on-demand, cached, and executed. Keeps consumer repo footprint minimal.
2. **Deterministic content-hash versioning** — `bundleVersion` derived from SHAs of all skills, NOT mtime. Same content → same version, regardless of clone or filesystem.
3. **No operator file clobbering** — ownership tracked via install receipt (SKILL.md files are byte-faithful copies, NOT marker-prepended). Files present without a matching receipt entry refuse overwrite unless `--force`. Block-marker merge for `.github/copilot-instructions.md` (that file gets markers because it legitimately mixes managed + operator content).
4. **Atomic two-phase commit** — stage all files in `.audit-loop/.tmp-install-<pid>/`, verify, then commit with `atomicWriteFileSync`.
5. **Multi-surface install** — writes to `~/.claude/skills/` (global), `.github/skills/` (per-repo), `.agents/skills/` (per-repo) identically. Claude Code reads global, Copilot reads per-repo `.github/skills/`, Agent SDK reads `.agents/skills/`. See §2.7 surface target table for authoritative paths.
6. **Cross-platform paths** — Windows + macOS + Linux. No POSIX-only assumptions.
7. **Manual staleness check** — cached 24hr, operator-invoked (`bootstrap.mjs check`), fails open.

### Non-Goals

- Storage adapters (Phase G)
- Supply-chain signing / checksum verification (Phase H)
- Automatic (git-hook or scheduled) update application — operator always runs the command
- Multi-version install — consumers always install the complete current bundle
- Rollback-via-installer — consumers use git to revert

---

## 2. Proposed Architecture

### 2.1 Bootstrap Script (consumer-side)

**Installed file**: `.audit-loop/bootstrap.mjs` — ~80 LoC, zero dependencies
beyond Node built-ins.

**Responsibilities**:
1. Parse sub-command: `install`, `check`, `version`, `help`
2. Fetch the requested script from `raw.githubusercontent.com/<renamed-repo>/main/scripts/<name>.mjs`
3. Cache in `.audit-loop/cache/<ref>/<name>.mjs` (24hr TTL, SHA stored alongside) (fix R2-H2 — cache key includes the git ref/bundleVersion so pinned installs never see content from a different ref)
4. Spawn `node <cached-script>` with same argv passed through
5. Exit with child's exit code

**Self-update** (fix R1-M6 — cross-platform safe replacement): if
`.audit-loop/bootstrap.mjs`'s mtime is >30 days old, the bootstrap refreshes
itself SAFELY using a two-step process:

1. Fetch latest bootstrap content from upstream
2. Write it to `.audit-loop/bootstrap.mjs.next` via `atomicWriteFileSync`
3. On the NEXT invocation, bootstrap checks for `.bootstrap.mjs.next`:
   - If present + passes syntax check (via `node --check`), delete the old
     `.bootstrap.mjs` and rename `.next` → `.bootstrap.mjs`
   - If next-file corrupted, delete it, log warning, continue with current version

The currently-executing bootstrap does NOT replace itself mid-run (unsafe
on Windows where open file handles prevent rename). The deferred swap runs
on the next fresh process. One-invocation delay is acceptable for a
30-day bit-rot guard.

**Fallback**: if fetch fails (network down), use cached copy if present. If no
cache, exit 1 with clear message.

**Cross-platform**: uses `path.join` for all paths, `os.homedir()` for home
resolution, respects `%USERPROFILE%` on Windows.

**Example consumer invocations**:
```bash
node .audit-loop/bootstrap.mjs install --surface both   # install/update
node .audit-loop/bootstrap.mjs check                    # staleness check
node .audit-loop/bootstrap.mjs version                  # show installed bundle version
node .audit-loop/bootstrap.mjs help
```

### 2.2 First-Install Flow (consumer-side)

Consumer runs ONE curl-pipe command. This fetches `install-skills.mjs` directly
(no cached bootstrap exists yet on first install), which:

1. Creates `.audit-loop/` directory in consumer repo
2. Writes `.audit-loop/bootstrap.mjs` (~80 LoC) with stable URL references
3. Writes `.audit-loop/cache/` directory
4. Proceeds with normal install flow (see §2.4)

**Command** (documented in README):
```bash
curl -fsSL https://raw.githubusercontent.com/Lbstrydom/claude-engineering-skills/main/scripts/install-skills.mjs \
  | node - --remote --surface both
```

After that one command, the consumer repo has:
- `.audit-loop/bootstrap.mjs` (stable entry point)
- `.audit-loop/cache/` (populated on first update check)
- `.github/skills/{audit-loop,plan-backend,plan-frontend,ship,audit}/SKILL.md`
- `~/.claude/skills/{...}/SKILL.md` (when `--surface both` or `--surface claude`)
- `.agents/skills/{...}/SKILL.md`
- `.github/copilot-instructions.md` (merged with existing content if present)
- `.audit-loop-install-receipt.json` (tracks what's installed)

All subsequent installs/updates/checks use `node .audit-loop/bootstrap.mjs`.

### 2.3 Manifest Schema + Versioning

**New file**: `skills.manifest.json` (committed to this repo, generated by `scripts/build-manifest.mjs`)

```json
{
  "schemaVersion": 1,
  "bundleVersion": "a3bc12de4f56-20260405",
  "repoUrl": "https://github.com/Lbstrydom/claude-engineering-skills",
  "rawUrlBase": "https://raw.githubusercontent.com/Lbstrydom/claude-engineering-skills/main",
  "updatedAt": "2026-04-05T12:00:00Z",
  "skills": {
    "audit-loop": {
      "path": "skills/audit-loop/SKILL.md",
      "sha": "abc1234def56",
      "size": 28415,
      "summary": "Multi-model audit loop with persistent debt memory"
    },
    "plan-backend": { "path": "skills/plan-backend/SKILL.md", "sha": "...", "size": 10240, "summary": "..." },
    "plan-frontend": { "path": "skills/plan-frontend/SKILL.md", "sha": "...", "size": 14200, "summary": "..." },
    "ship": { "path": "skills/ship/SKILL.md", "sha": "...", "size": 9100, "summary": "..." },
    "audit": { "path": "skills/audit/SKILL.md", "sha": "...", "size": 15300, "summary": "..." }
  }
}
```

**`bundleVersion` derivation** (fix R1-H1, R1-H6 — fully content-deterministic,
no date component, covers ALL managed artifacts):

```javascript
// Hash EVERY managed artifact, not just skills. Sort alphabetically for
// deterministic ordering, hash the concatenation. Same content → same version,
// regardless of date, clone, or rebuild.
const artifacts = [
  ...Object.entries(skills).map(([name, meta]) => `skill:${name}:${meta.sha}`),
  `bootstrap:${bootstrapTemplateSha}`,
  `copilot-block:${copilotBlockSha}`,
  `manifest-schema:${manifestSchemaVersion}`,
];
const pairs = artifacts.sort().join('\n');
const bundleVersion = sha256(pairs).slice(0, 16);  // 16-char hex, no date
```

**Rationale**: the first iteration used `<hash>-<YYYYMMDD>` but the date
component breaks the "same content → same version" invariant (rebuilds on
different days produce different versions even with identical content).
Pure content hash fixes this. For human-readable date context, the manifest
also carries a separate `updatedAt` ISO timestamp (informational, NOT part
of the version identity).

**Scope of the hash**: includes skills AND the bootstrap template AND the
copilot-instructions block template AND the manifest schema version. Any
change that affects what consumers get on install MUST change the version.

**Version pinning semantics for `--version <ref>` flag**:
- `--version a3bc12de4f56abcd` → exact 16-char bundle hash. Installer looks up the SHA in `bundle-history.json`, fetches from that SHA's ref.
- `--version sha:abc1234` → git commit SHA. Installer fetches manifest AND tooling AND skills from `raw.githubusercontent.com/.../<sha>/...`.
- `--version tag:v1.2.0` → git tag (Phase H adds release tags).
- `--version main` or no flag → latest from default branch.

**Pinned install reproducibility** (fix R1-H4): when ANY non-`main` version
is pinned, the bootstrap fetches BOTH content (SKILL.md files) AND tooling
(install-skills.mjs, check-skill-updates.mjs, copilot-instructions block
template) from the same git ref. Pinned installs are fully reproducible —
the installer's behavior matches the bundle version being installed.

**`bundle-history.json`** (new committed file): maps `bundleVersion` → git SHA.

**How it gets updated** (fix R2-H5 — avoid self-referential chicken-and-egg):
- A commit CANNOT embed its own git SHA before it exists
- Solution: `bundle-history.json` is updated by a **follow-up commit** from
  CI after the manifest-changing commit lands on `main`
- Workflow: (1) operator pushes commit changing skills + manifest, (2) CI
  verifies manifest is fresh, merges, (3) post-merge action commits a
  "chore: update bundle-history for <version>" that appends the mapping
- This means a new `bundleVersion` is NOT instantly resolvable via the pinning
  flag — there's a ~30s window after the content commit where the history
  hasn't caught up. Documented limitation; pinning commands advise waiting
  for the follow-up commit

Format:

```json
{
  "a3bc12de4f56abcd": { "sha": "3c6ebc2a529c...", "ts": "2026-04-05T14:00:00Z", "commit": "3c6ebc2" },
  "bb22ccdd44ee55ff": { "sha": "ce3739d...", "ts": "2026-04-05T16:00:00Z", "commit": "ce3739d" }
}
```

**Per-skill `sha`**: SHA-256 of SKILL.md file bytes as they live in `skills/<name>/SKILL.md`, first 12 hex chars.

**Critical invariant**: the installer does NOT modify SKILL.md content when
writing it to target locations. No managed-marker prepending. The SHA in the
manifest matches the SHA of the file when installed. Drift detection relies
on byte-identical comparison against the receipt's recorded SHA.

**Ownership tracking lives in the install receipt**, NOT in SKILL.md content.
The receipt tracks every managed file + its expected SHA. `bootstrap.mjs check`
detects drift by hashing each managed file and comparing to the receipt. See
fix R1-H3 (§2.6) for the drift-detection algorithm.

**Receipt scope** (fix R1-H2 — clear scope per location):

| Receipt location | Tracks files at |
|---|---|
| `~/.audit-loop-install-receipt.json` | `~/.claude/skills/<name>/SKILL.md` only |
| `<repo>/.audit-loop-install-receipt.json` (committed) | `<repo>/.github/skills/`, `<repo>/.agents/skills/`, `<repo>/.audit-loop/bootstrap.mjs`, `<repo>/.github/copilot-instructions.md` (block only) |

Repo receipt is committed to git (alongside the managed files). This makes
the consumer-repo state auditable via git history and means CI / new clones
pick up the receipt naturally. Global receipt stays per-machine only.

### 2.4 Installer CLI (`scripts/install-skills.mjs`)

**Located in**: this repo's `scripts/`. Consumers invoke via bootstrap (which fetches+caches+spawns). Louis invokes directly from this repo for dev.

**CLI flags**:
- `--local` (default when run from repo with `skills/` present) — read from `./skills/`
- `--remote` (default when run via curl-pipe / bootstrap) — fetch from `rawUrlBase`
- `--surface <claude|copilot|agents|both>` — `both` writes to all 3 locations
- `--skills <comma-list>` — install only specific skills (default: all 5)
- `--version <ref>` — pin to a specific version (see §2.3)
- `--force` — overwrite files even if drift detected or unmanaged
- `--adopt` — scan targets, adopt existing byte-matching files into receipt without rewriting (migration path for existing manual installs — fix R2-H6)
- `--dry-run` — print what would be written, write nothing

**Surface semantics**:

| Surface | Target location | Scope |
|---|---|---|
| `claude` | `~/.claude/skills/<name>/SKILL.md` | Global per-machine (Claude Code) |
| `copilot` | `.github/skills/<name>/SKILL.md` | Per-repo (Copilot in VS Code) |
| `agents` | `.agents/skills/<name>/SKILL.md` | Per-repo (Agent SDK convention) |
| `both` | all 3 | Maximum compatibility |

**Install flow (atomic two-phase commit)**:

1. **Load manifest** (from local `skills.manifest.json` OR remote fetch)
2. **Verify manifest integrity**: every skill listed has a reachable source file, SHAs match
3. **Prepare phase**:
   - Create staging dir `.audit-loop/.tmp-install-<pid>/`
   - Read source content for each skill
   - Hash staged content, verify against manifest SHAs
   - For each target location, read existing file (if present), record SHA
4. **Conflict detection**:
   - For each target, check if existing content has a known managed SHA (from receipt) — if yes, overwrite-safe
   - If no receipt OR SHA doesn't match receipt: file is operator-modified — REFUSE overwrite (unless `--force`)
   - Log all conflicts before any write
5. **Commit phase** (fix R1-H5 + R2-H4 — separate journal from authoritative receipt):
   - Write a **transaction journal** (separate file: `.audit-loop/.install-journal.json`)
     with the planned writes + expected post-install SHAs
   - For each target location: write via `atomicWriteFileSync` (temp-file + rename)
   - After all writes succeed: write the FINAL install receipt atomically
   - Delete the journal file (transaction complete)
   - If ANY commit fails mid-flight: the journal remains, signalling an
     incomplete transaction. Next install/check inspects the journal, offers
     recovery (rollback via snapshots OR resume-forward from the journal state)

**Why separate**: the receipt is the authoritative source of truth for
"what's currently installed". A receipt should never reflect a transient/
attempted state. The journal is the recovery log — it's ephemeral and gets
deleted on success. Keeps the receipt simple and always-trustworthy.

6. **Rollback on partial failure**:
   - Pre-commit phase: for each target, read existing content + compute SHA,
     store in-memory snapshot
   - If any write fails mid-flight, restore each target from snapshot via
     `atomicWriteFileSync`
   - Mark receipt as "rolled back" with failure reason
   - Delete staging dir
   - Exit with error

**Multi-scope consistency**: when `--surface both` writes to 3 locations
(`~/.claude/skills/` global, `<repo>/.github/skills/` per-repo,
`<repo>/.agents/skills/` per-repo), the commit phase is **all-or-nothing
across all scopes**. If scope 2 fails, scope 1 is rolled back. This
maintains the invariant: all three locations have byte-identical content
OR none do.

**Block-marker merge for `.github/copilot-instructions.md`**:

The file usually has operator-authored content. Installer NEVER replaces the whole file. Uses block markers:

```markdown
<!-- operator-authored content here, preserved -->

<!-- audit-loop-bundle:start -->
## Engineering Skills Bundle
...our managed content...
<!-- audit-loop-bundle:end -->

<!-- more operator-authored content, preserved -->
```

Rules:
- File absent → create with just our block
- File present, no markers → append our block at end, preserve existing entirely
- File present, markers found → replace only content between markers, preserve outside

### 2.5 Install Receipt (`.audit-loop-install-receipt.json`)

**Consumer-repo receipt** (Copilot surface):

```json
{
  "receiptVersion": 1,
  "bundleVersion": "a3bc12de4f56-20260405",
  "installedAt": "2026-04-05T14:00:00Z",
  "sourceUrl": "https://raw.githubusercontent.com/Lbstrydom/claude-engineering-skills/main",
  "surface": "both",
  "managedFiles": [
    { "path": ".github/skills/audit-loop/SKILL.md", "sha": "abc1234def56", "skill": "audit-loop" },
    { "path": ".agents/skills/audit-loop/SKILL.md", "sha": "abc1234def56", "skill": "audit-loop" },
    ...
    { "path": ".github/copilot-instructions.md", "blockSha": "def5678...", "merged": true },
    { "path": ".audit-loop/bootstrap.mjs", "sha": "..." }
  ]
}
```

**Global receipt** (Claude surface, per-machine): `~/.audit-loop-install-receipt.json`

Same schema. Tracks what's installed to `~/.claude/skills/`. When both receipts
exist (e.g. `--surface both` was used), the consumer-repo receipt wins for
per-repo files; the global receipt covers `~/.claude/skills/` entries.

**Precedence on conflict**: per-repo receipt is authoritative for per-repo
files. Global receipt is authoritative for global files. No file appears in
both scopes. No ambiguity.

### 2.6 Staleness Check (`scripts/check-skill-updates.mjs`)

**Responsibility**: compare installed bundle version vs latest remote, report drift. Never mutates files.

**Logic** (fix R1-H3 — local drift detection included):

1. Load install receipt (fail cleanly if none — "no install detected")
2. **Local drift phase**: hash every managed file in the receipt; compare each
   against the receipt's recorded SHA. Any mismatch → "local drift" reported
   per-file (this file was edited after install).
3. **Remote staleness phase**: check 24hr cache at `.audit-loop/cache/update-check.json`;
   if fresh, use cached manifest. Else fetch `<rawUrlBase>/skills.manifest.json`,
   cache it.
4. Diff installed `bundleVersion` vs remote `bundleVersion` → "bundle stale"
   when different.
5. Per-skill SHA diff → which skills changed remotely.
6. Output combined summary: N files drifted locally, M skills stale remotely.

Drift and staleness are orthogonal. Either can be reported independently.
Exit code is 0 in both cases — informational only.

**Output modes**:
- Default (human): printed summary with update command
- `--json` (machine): full diff as JSON
- `--no-cache`: bypass the 24hr cache

**Exit codes**:
- 0 — up to date OR stale (always, this is informational-only)
- 1 — operational error (network + no cache, corrupt receipt, etc.)

### 2.7 Cross-Platform Path Handling

All paths resolved via `node:path` and `node:os`. Explicit handling:

| Environment | Home directory | Path separator | Notes |
|---|---|---|---|
| Linux | `process.env.HOME` or `os.homedir()` | `/` | POSIX standard |
| macOS | `os.homedir()` | `/` | POSIX standard |
| Windows | `os.homedir()` (resolves to `%USERPROFILE%`) | `\` (Node normalizes to `/` internally) | Use `path.join`, never string concat |

**Test matrix** includes at minimum Linux + Windows path resolution tests
(hermetic via mocked `os.homedir()`). macOS assumed same as Linux.

**Repo root discovery** (fix R1-M1, R2-H3): the installer locates the consumer
repo root by walking up from `process.cwd()` until it finds a `.git` directory
**OR `.git` file** (for worktrees/submodules where `.git` is a file pointing
to the real gitdir). If multiple candidates are found in ancestors (monorepo
with nested `package.json` files), the **outermost `.git` marker wins** —
this is the "repo root" as git understands it.

Algorithm:
1. Walk up from cwd, collecting all directories containing `.git` (file or dir)
2. If any found, return the OUTERMOST (closest to filesystem root)
3. If none found, walk up again collecting `package.json` — return outermost
4. If still none, return `process.cwd()` + log warning

This matches the git CLI's own repo-root semantics and avoids the pitfall
of stopping at a nested `package.json` in a monorepo subpackage.

**Override**: `--repo-root <path>` CLI flag bypasses discovery for unusual layouts.

**Scope target table** (authoritative):

| Scope | Absolute target | Home-directory prefix | Per-repo | Per-machine |
|---|---|---|---|---|
| `claude` (global) | `$HOME/.claude/skills/<name>/SKILL.md` | `os.homedir()` | ✗ | ✓ |
| `copilot` (per-repo) | `<repo-root>/.github/skills/<name>/SKILL.md` | — | ✓ | ✗ |
| `agents` (per-repo) | `<repo-root>/.agents/skills/<name>/SKILL.md` | — | ✓ | ✗ |
| `claude-repo-mirror` (optional, future) | `<repo-root>/.claude/skills/<name>/SKILL.md` | — | ✓ | ✗ |

**Receipt location matches scope**: per-repo receipt at `<repo-root>/.audit-loop-install-receipt.json`;
per-machine receipt at `~/.audit-loop-install-receipt.json`. No other locations.

### 2.8 File Precedence When Skills Are In Multiple Places

Documented in README (not enforced by installer — tools resolve their own precedence):

| Tool | Reads from (in order) | What the installer does |
|---|---|---|
| Claude Code | `~/.claude/skills/<name>/SKILL.md` only (global) | Writes to this location for `--surface claude` or `both` |
| Copilot (VS Code) | `.github/skills/<name>/` → `.claude/skills/<name>/` → `.agents/skills/<name>/` | Writes to `.github/skills/` for `--surface copilot` or `both` (other dirs also written for `both`) |
| Claude Agent SDK | `.agents/skills/<name>/` → `.claude/skills/<name>/` | Writes to `.agents/skills/` for `--surface agents` or `both` |

**Installer guarantee**: when `--surface both`, identical content written to all
3 locations. Same SHA in receipt. No tool sees inconsistent copies.

### 2.9 `.github/copilot-instructions.md`

**Default content** (what the installer's block contains):

```markdown
<!-- audit-loop-bundle:start -->
## Engineering Skills Bundle

This repo uses `claude-engineering-skills`. Five skills are available:

- `/audit-loop` — multi-model plan-audit-fix orchestration with persistent debt memory
- `/plan-backend` — backend architecture planning
- `/plan-frontend` — frontend/UX planning
- `/ship` — autonomous commit/push with docs update
- `/audit` — single-pass plan audit

Source: https://github.com/Lbstrydom/claude-engineering-skills

## Keeping Skills Current
- Check for updates: `node .audit-loop/bootstrap.mjs check`
- Install latest: `node .audit-loop/bootstrap.mjs install --surface both`
<!-- audit-loop-bundle:end -->
```

Merge rules enforced per §2.4. Block markers are stable strings — never changed across phases.

---

## 3. File Impact Summary

**New files in this repo** (fix R1-M2 — installer decomposed into focused modules):

| File | Purpose |
|---|---|
| `scripts/install-skills.mjs` | CLI thin-wrapper: arg parsing, calls into lib modules, exit codes |
| `scripts/check-skill-updates.mjs` | Staleness check CLI (local drift + remote staleness) |
| `scripts/build-manifest.mjs` | Computes SHAs + bundle version, updates `skills.manifest.json` + `bundle-history.json` |
| `scripts/lib/install/manifest-loader.mjs` | Local + remote manifest fetch, Zod-validate |
| `scripts/lib/install/version-resolver.mjs` | Parses `--version` flag, resolves to git SHA via bundle-history.json |
| `scripts/lib/install/conflict-detector.mjs` | Receipt-based drift/unmanaged-file detection |
| `scripts/lib/install/merge.mjs` | Block-marker merge for copilot-instructions |
| `scripts/lib/install/transaction.mjs` | Two-phase commit: stage → snapshot → commit → rollback |
| `scripts/lib/install/receipt.mjs` | Receipt read/write, schema validation, state transitions |
| `scripts/lib/install/surface-paths.mjs` | Resolve target paths per surface + repo-root discovery |
| `scripts/lib/bootstrap-template.mjs` | Source template for consumer `.audit-loop/bootstrap.mjs` |
| `scripts/lib/schemas-install.mjs` | Zod schemas: manifest, receipt, cache, bundle-history |
| `skills.manifest.json` | **New** — committed manifest (generated) |
| `bundle-history.json` | **New** — `bundleVersion` → git SHA lookup (committed) |

**Tests** (one per lib module):
- `tests/install/manifest-loader.test.mjs`
- `tests/install/version-resolver.test.mjs`
- `tests/install/conflict-detector.test.mjs`
- `tests/install/merge.test.mjs`
- `tests/install/transaction.test.mjs`
- `tests/install/receipt.test.mjs`
- `tests/install/surface-paths.test.mjs`
- `tests/install/install-skills-cli.test.mjs` (thin-wrapper integration)
- `tests/build-manifest.test.mjs` (SHA determinism, version format)
- `tests/check-skill-updates.test.mjs` (cache TTL, staleness detection)
- `tests/bootstrap-template.test.mjs` (self-update deferred-swap logic)
- `tests/path-resolution.test.mjs` (cross-platform mocked `os.homedir()`)
- `tests/schemas-install.test.mjs` (Zod boundary validation)

**Files installed into consumer repos** (written by installer):

| File | Lifecycle |
|---|---|
| `.audit-loop/bootstrap.mjs` | Stable, updated by self-update mechanism (§2.1) |
| `.audit-loop/cache/*.mjs` | 24hr-cached fetches of heavier scripts |
| `.audit-loop/cache/update-check.json` | 24hr-cached manifest for staleness check |
| `.github/skills/<name>/SKILL.md` (x5) | Managed, replaced on update |
| `.claude/skills/<name>/SKILL.md` (x5) | Managed |
| `.agents/skills/<name>/SKILL.md` (x5) | Managed |
| `.github/copilot-instructions.md` | Merged via block markers |
| `.audit-loop-install-receipt.json` | Manifest-of-what's-installed |

---

## 4. Testing Strategy

### Hermetic Unit Tests

| Test | What it validates |
|---|---|
| Manifest builder produces identical SHAs for identical input | Determinism |
| Manifest builder `bundleVersion` matches expected hash-date format | Format contract |
| Manifest builder fails on missing required frontmatter | Integrity |
| Installer writes to `~/.claude/skills/` (mocked `$HOME`) | Claude surface |
| Installer writes to `.github/skills/`, `.agents/skills/`, `.claude/skills/` on `--surface both` | Multi-surface |
| Installer `--skills audit-loop` writes only one skill | Selective install |
| Install receipt records every managed file + its SHA | Receipt contract |
| `--dry-run` writes nothing but prints what would be written | Safety flag |
| Conflict detection: unmanaged file → refuse overwrite without `--force` | File ownership |
| Conflict detection: managed file with wrong SHA → log drift notice, refuse without `--force` | Drift detection |
| `--force` overwrites unmanaged + drifted files | Override semantics |
| Partial write failure rolls back all changes | Atomic two-phase commit |
| Block-merge: no file → create with block | Merge strategy |
| Block-merge: file without markers → append block | Merge strategy |
| Block-merge: file with markers → replace only between markers | Merge strategy |
| Staleness check reports up-to-date when SHAs match | Positive case |
| Staleness check reports stale when SHAs differ | Staleness detection |
| Staleness check uses 24hr cache on repeat calls | Cache TTL |
| Staleness check `--no-cache` bypasses cache | Override |
| Staleness check exits 0 on missing receipt with clear message | Error surface |
| Cross-platform path resolution (mocked `os.homedir()`) | Win/macOS/Linux |
| Bootstrap self-updates when mtime > 30 days | Bit-rot protection |
| Bootstrap falls back to cache on fetch failure | Network resilience |
| Bootstrap fails fast when no cache + no network | Error handling |

### Integration Tests

| Test | What it validates |
|---|---|
| Full install → modify one skill file → check reports stale | End-to-end drift |
| Full install → re-install → no changes, receipt unchanged | Idempotency |
| Install with `--version sha:<non-existent>` → clear error | Version pinning |
| Remote install via mocked fetch | Remote flow |
| Block-merge of `.github/copilot-instructions.md` with pre-existing content | Merge integrity |

### Smoke Tests (gated behind `AUDIT_LOOP_SMOKE=1`)

| Test | What it validates |
|---|---|
| Real curl-pipe install from GitHub raw | End-to-end consumer flow |
| Install, modify one SKILL.md, re-check shows drift | Real-world drift detection |

---

## 5. Rollback Strategy

- **Consumer repo uninstall**: `node .audit-loop/bootstrap.mjs uninstall` (future if needed) OR manually delete `.audit-loop/`, `.github/skills/`, `.agents/skills/`, `.claude/skills/`, `.audit-loop-install-receipt.json`. Block-marker merge reversible (installer can reverse-merge if `--uninstall` ships).
- **Claude global uninstall**: delete `~/.claude/skills/` + `~/.audit-loop-install-receipt.json`.
- **Reverting Phase F in this repo**: git revert the phase's commits. All new scripts are additive; Phase E skills remain intact.

---

### 2.11 Manifest Freshness Guard (fix R1-M3)

A CI guard prevents stale `skills.manifest.json` from reaching `main`:

**New workflow**: `.github/workflows/manifest-check.yml` runs on every PR.
Steps:
1. Run `scripts/build-manifest.mjs --check` (new flag — computes what the
   manifest SHOULD contain, compares to committed `skills.manifest.json`)
2. If they differ → fail the check with a diff + "run `node scripts/build-manifest.mjs` and commit"
3. Same check runs on every `main` push as a post-commit safety net

**Pre-commit hook** (optional, documented in CONTRIBUTING.md): operators
can install a pre-commit hook that runs `build-manifest.mjs --check` locally
to catch staleness before push. Not required — the CI guard is authoritative.

**`bundle-history.json` update**: same workflow appends a new entry to
`bundle-history.json` whenever the manifest changes, mapping the new
`bundleVersion` to the current git SHA. This happens post-merge (on main),
NOT on PR branches.

### 2.12 Partial-Install Semantics (fix R1-M4)

When `--skills <subset>` is used, the receipt records only those skills as
managed. The rest of the bundle is explicitly NOT touched.

**`check-skill-updates` for partial installs**:
- Computes a **partial bundle version** from the installed-skills subset only
- Reports staleness relative to the remote manifest's subset of matching skills
- Output format: `"2 of 3 installed skills are up-to-date; 1 stale. 2 skills from the full bundle not installed."`

**Mixing per-repo and per-machine receipts**: when both exist on a developer's
machine (common when they're working on their own repo AND have the bundle
globally installed), `check` reads both receipts and reports staleness per
scope. Operator sees: `"repo-scoped: up-to-date. machine-scoped: 1 stale."`

### 2.13 Schema Validation at Boundaries (fix R1-M5)

All persisted + fetched JSON validated via Zod at read/write boundaries:

| Artifact | Schema | Validated at |
|---|---|---|
| `skills.manifest.json` | `ManifestSchema` | manifest-loader read, build-manifest write |
| `.audit-loop-install-receipt.json` (both scopes) | `InstallReceiptSchema` | receipt read/write |
| `.audit-loop/cache/update-check.json` | `UpdateCacheSchema` | staleness check read/write |
| `bundle-history.json` | `BundleHistorySchema` | version-resolver read, build-manifest write |
| Remote-fetched manifest | `ManifestSchema` | after fetch, before use |

Invalid data surfaces a clear error at the boundary. No silent acceptance.
`scripts/lib/schemas-install.mjs` defines all four schemas.

## 6. Implementation Order

1. **`scripts/lib/schemas-install.mjs`** — Zod schemas for manifest, receipt, cache, bundle-history (fix R1-M5). Tests.
2. **`scripts/build-manifest.mjs`** — computes SHAs + bundleVersion, writes `skills.manifest.json` + appends to `bundle-history.json`. Tests.
3. **`.github/workflows/manifest-check.yml`** — CI guard against stale manifest (fix R1-M3).
4. **`scripts/lib/install/surface-paths.mjs`** — repo-root discovery, scope target resolution. Tests.
5. **`scripts/lib/install/receipt.mjs`** — read/write receipts with state transitions, schema-validated. Tests.
6. **`scripts/lib/install/conflict-detector.mjs`** — receipt-based drift detection + unmanaged-file check. Tests.
7. **`scripts/lib/install/version-resolver.mjs`** — `--version` flag → git ref via bundle-history. Tests.
8. **`scripts/lib/install/manifest-loader.mjs`** — local + remote fetch + Zod validate. Tests.
9. **`scripts/lib/install/merge.mjs`** — block-marker merge for copilot-instructions. Tests.
10. **`scripts/lib/install/transaction.mjs`** — two-phase commit + snapshot + rollback (fix R1-H5). Tests.
11. **`scripts/install-skills.mjs`** — thin CLI wrapper composing the lib modules. Tests.
12. **`scripts/check-skill-updates.mjs`** — local drift (fix R1-H3) + remote staleness, 24hr cache. Tests.
13. **`scripts/lib/bootstrap-template.mjs`** — deferred-swap self-update (fix R1-M6), fetch cache. Tests.
14. **First-install flow** — end-to-end test of curl-pipe → bootstrap deployed → subsequent updates via bootstrap.
15. **README update** — one-line install instruction, per-skill reference.
16. **Cross-platform path tests** — mocked `os.homedir()` for Win/macOS/Linux.
17. **Manual smoke test** — Louis installs on a team repo, verifies drift detection.
18. **Final `npm test`** — pre-Phase-F baseline + ~70 new tests (expanded from ~40 due to lib decomposition).

---

## 7. Known Limitations (accepted for Phase F)

**Limitations surfaced by R3 audit — accepted with mitigations** (stopping
at 3 rounds per early-stop rule; these are tracked for follow-up fixes):

1. **Repo-root discovery: nested repos** (R3-H1): outermost-wins heuristic
   works for monorepos but is incorrect for git worktrees + submodules where
   the operator genuinely wants the inner repo. Workaround: `--repo-root <path>`
   CLI flag. Documented; post-F iteration may refine heuristic.
2. **In-memory rollback snapshots** (R3-H2): snapshots live only in the
   installer process; if the process crashes before completion, recovery
   requires manual git checkout. True crash-recovery (persistent snapshots
   on disk) deferred to Phase G+ if needed. Acceptable: installer is fast
   (<10s), crash window is narrow.
3. **First-install script from `main`** (R3-H3): the curl-pipe fetch always
   pulls `install-skills.mjs` from `main`, even when the command intends to
   pin a version. Subsequent invocations via bootstrap respect pinning, but
   the first run does NOT. Workaround: pin-on-first-install uses the URL
   form `raw.githubusercontent.com/.../<sha>/scripts/install-skills.mjs`
   (documented in README for operators who need strict first-install
   reproducibility).
4. **Installer tooling not included in bundleVersion** (R3-H4): `bundleVersion`
   hashes skills + bootstrap template + copilot block. It does NOT hash the
   installer/checker scripts themselves. So an installer-logic change (with
   identical skill content) doesn't produce a new `bundleVersion`. Acceptable:
   installer changes are generally backward-compatible; when they aren't,
   operators update the bootstrap (which DOES hash-contribute). Phase H's
   signed-checksum manifest will cover the tooling hashes separately.
5. **Committed receipt contains mutable fields** (R3-H5): `installedAt`,
   `sourceUrl`, `surface` change per-install. Committing creates git churn.
   Mitigation: split the receipt into two parts:
   - `.audit-loop-install-receipt.json` (committed, immutable-per-install):
     schema version, manifest refs, per-file SHAs — the "what's authoritative"
     facts
   - `.audit-loop/local-state.json` (gitignored, mutable): `installedAt`,
     `sourceUrl`, `surface`, per-machine transient data
   This split happens as a Phase F follow-up fix, not a blocker.

**Other known limitations**:

6. **No checksum verification** — Phase F trusts GitHub raw URLs. Phase H adds signed checksums.
2. **24hr staleness cache can miss fresh updates** — operator can bypass with `--no-cache`.
3. **No release channels** — always installs from `main`. Phase H adds `stable` channel.
4. **Bootstrap self-update is time-based, not version-based** — refreshes every 30 days regardless of actual drift. Simple but imprecise.
5. **GitHub raw URL caching (5-min TTL)** — staleness check may lag by up to 5 minutes after a push to main.
6. **No rollback of individual skills** — bundle installs/updates all 5 together or selectively via `--skills`, but update-check reports on the whole bundle.

---

## 8. Resolved Design Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| Q1 | Where does the bootstrap live after first install? | `.audit-loop/bootstrap.mjs` in consumer repo | Stable entry point, consumer-owned |
| Q2 | How is `bundleVersion` derived? | 16-char content-hash only (no date) — hashes ALL managed artifacts (skills + bootstrap + copilot-instructions block + schema version) | Fully deterministic: same content → same version, always (fix R1-H1 + R1-H6) |
| Q3 | How to detect operator edits to managed files? | Install receipt tracks expected SHAs; check-skill-updates hashes local files against receipt (fix R1-H3) | No marker-mutation of SKILL.md content |
| Q3a | Should `--version sha:<ref>` pin ONLY content or ALSO the installer scripts? | Both — all tooling fetched from pinned ref (fix R1-H4) | Reproducible installs require version-matched tooling |
| Q3b | How do we prevent stale `skills.manifest.json`? | CI guard (`scripts/build-manifest.mjs --check` in workflow) + optional pre-commit hook | Authoritative automated check (fix R1-M3) |
| Q3c | Self-update replacement strategy? | Write `.next` file, swap on next invocation (fix R1-M6) | Windows-safe; avoids replacing executing file |
| Q3d | Partial install staleness semantics? | Receipt tracks subset; check computes partial bundle version from that subset (fix R1-M4) | Honest reporting for operators |
| Q4 | Merge strategy for `.github/copilot-instructions.md`? | Block markers, replace-between | Preserves all operator content |
| Q5 | Multi-surface install? | Yes, `--surface both` writes all 3 locations identically | Max compat, consistent content |
| Q6 | Staleness check frequency? | Manual, 24hr cached | Non-invasive |
| Q7 | Version pin via git SHA or tag? | Both supported via `--version sha:...` and `--version tag:...` | Flexibility |
| Q8 | Auto-update when stale? | No, always manual `install` command | Operator control |
| Q9 | Rollback mechanism? | Atomic two-phase commit + per-file pre-commit snapshots | Standard safety pattern |
| Q10 | How do consumers uninstall? | Phase F: documented manual delete. Phase G+ may add `--uninstall` | Keep Phase F scope tight |

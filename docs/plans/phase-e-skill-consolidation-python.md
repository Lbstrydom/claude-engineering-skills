# Plan: Phase E — Skill Consolidation + Python Profiles + Rename

- **Date**: 2026-04-05
- **Status**: Draft, pending audit-loop review
- **Author**: Claude + Louis
- **Parent**: [skill-bundle-mega-plan.md](./skill-bundle-mega-plan.md)
- **Scope**: Vendor the 4 external engineering skills (`plan-backend`, `plan-frontend`, `ship`, `audit`) into this repo alongside `audit-loop`. Add Python language profiles. Rename the repo. NO installer, NO storage adapters, NO public-distribution work.

---

## 1. Context

This repo currently houses only `audit-loop`. Four other skills live in Louis's
global `~/.claude/skills/`. That's the pain point: skill edits happen in one
place (Louis's laptop), consumer repos get stale copies, Python teams have
no Python-aware planning principles.

Phase E is the **content phase**: move the skills in, add Python, rename. No
new infrastructure, no new dependencies. Result: the bundle exists as a coherent
set of authoritative files, Python teams get first-class support, future phases
(F/G/H) have a stable foundation to build installers and adapters against.

### Key Requirements

1. **Byte-faithful vendoring**: copy each skill verbatim before editing. Preserves git-diffable "before/after" visibility.
2. **Python as first-class**: plan-backend, plan-frontend, ship, audit each gain a "Repo Stack Detection" section + Python-specific principles + commands.
3. **Repo rename preserves old URLs**: GitHub auto-redirects, existing clones keep working.
4. **No new runtime dependencies**: this is a content-only phase.
5. **Tests stay green**: the pre-Phase-E baseline test count must remain 100% passing. The exact count is whatever `npm test` reports on `main` immediately before Phase E's first commit. Phase E MUST NOT decrease this count or introduce failures.

### Non-Goals

- Installer / update-check infrastructure (Phase F)
- Storage adapters (Phase G)
- Supply-chain signing (Phase H)
- Python data-science profiles (Jupyter, Streamlit) — web services only
- Consumer-repo "install" automation — Phase E consumers copy files manually

---

## 2. Proposed Architecture

### 2.1 Directory Layout

**New canonical location**: `skills/` at repo root.

```
claude-engineering-skills/
├── skills/                          # canonical source of truth
│   ├── audit-loop/SKILL.md
│   ├── plan-backend/SKILL.md
│   ├── plan-frontend/SKILL.md
│   ├── ship/SKILL.md
│   └── audit/SKILL.md
├── .claude/skills/                  # mirrored copies for this repo's own use
│   └── audit-loop/SKILL.md          # (other 4 skills NOT mirrored — those are Louis's global)
└── .github/skills/                  # mirrored for Copilot when using this repo
    └── audit-loop/SKILL.md
```

**Rationale for `skills/` as canonical**: puts authoritative files in a visible,
top-level location separate from `.claude/` / `.github/` installed mirrors. When
Phase F ships the installer, `skills/` becomes the source that `install-skills.mjs`
reads.

**Source-of-truth policy after Phase E ships** (fix R2-H1, R2-H2 — single
consistent model across all sections):

- `skills/` is the ONLY authoritative location for edits. Period.
- Existing external copies in Louis's `~/.claude/skills/` are **immediately
  marked stale** the moment Phase E's first vendoring commit lands. They are
  NOT authoritative after vendoring — they're legacy copies pending Phase F.
- `.claude/skills/audit-loop/SKILL.md` and `.github/skills/audit-loop/SKILL.md`
  in THIS repo are also stale after Phase E. Phase E does NOT sync them.
  Phase F installer establishes them as managed mirrors of `skills/`.
- **During Phase E interim**: the audit-loop skill continues to work via the
  pre-Phase-E `.claude/skills/audit-loop/SKILL.md` in this repo (no changes
  to that file in Phase E). Louis's global `~/.claude/skills/audit-loop/` is
  already a symlink/copy per his setup. No breakage.

**What about Louis's global skills?** His `~/.claude/skills/plan-backend/`
etc. remain on disk, untouched by Phase E. They may be stale relative to
`skills/` in this repo. Louis should:
- Manually copy `skills/<name>/SKILL.md` → `~/.claude/skills/<name>/SKILL.md`
  ONCE after Phase E ships, to align his global with the vendored source
- From that point forward, NEVER edit in `~/.claude/skills/` directly
- Wait for Phase F installer to automate the sync going forward

This is the simplest honest model: Phase E establishes the source of truth,
Phase F ships the automation. In between, one manual sync step.

**Verification note**: after Phase E ships + Louis does the one-time manual
copy, verification happens via normal skill invocation in any repo (see §4).

### 2.2 Vendoring Process

**One commit per skill**, in this order:

1. **plan-backend**: copy `~/.claude/skills/plan-backend/SKILL.md` → `skills/plan-backend/SKILL.md` verbatim
2. **plan-frontend**: copy → `skills/plan-frontend/SKILL.md` verbatim
3. **ship**: copy → `skills/ship/SKILL.md` verbatim
4. **audit**: copy → `skills/audit/SKILL.md` verbatim
5. **audit-loop**: copy `.claude/skills/audit-loop/SKILL.md` → `skills/audit-loop/SKILL.md` verbatim (this is the only skill already in the repo)

After these 5 commits, git diff from main shows "5 files added, byte-identical to external copies". No semantic changes yet. Verifiable.

**Verification command** (one-liner, run ONCE on Louis's machine during vendoring):
```bash
diff ~/.claude/skills/plan-backend/SKILL.md skills/plan-backend/SKILL.md
# ... repeat for each skill, all should produce zero output
```

**Post-vendoring reproducibility lock-in** (fix R1-H2, R3-M2): after vendoring,
the repo's `skills/` IS the source of truth. Vendoring provenance is recorded
in TWO places:

1. **Commit message** (human-readable): each vendoring commit states the
   original SHA256 + date of copy
2. **`.audit/vendoring-provenance.json`** (machine-readable, committed):
   records `{skill: {sha: "...", vendoredAt: "...", sourcePath: "..."}}` for
   each of the 5 skills. Validated by a small `tests/vendoring-provenance.test.mjs`
   which asserts the file exists + has all 5 expected entries + SHAs match
   the current `skills/<name>/SKILL.md` bytes.

After Phase E ships, no one needs access to Louis's `~/.claude/skills/` to
reproduce or verify the bundle. The JSON provenance file + the repo content
ARE the baseline.

### 2.3 Python Profile Additions

Each of plan-backend, plan-frontend, ship, audit gains **one new section
inserted BEFORE existing Phase 1**, titled "Phase 0 — Repo Stack Detection".
The stack-specific profile content is also NEW, placed AFTER Phase 0 but
BEFORE existing Phase 1.

Fix R1-M1 — explicit instruction: the Python profile is inserted as a new
numbered section between Phase 0 and Phase 1. It is NOT appended to the end
of the skill. Structure after edits:

```
Phase 0 — Repo Stack Detection   ← NEW
Python Profile Section           ← NEW (referenced from Phase 0)
Phase 1 — [existing content]     ← unchanged
Phase 2 — [existing content]     ← unchanged
...
```

**Shared detection logic** (same block in each skill), with **framework
sub-detection** (fix R1-H3):

```markdown
## Phase 0 — Repo Stack Detection

Before Phase 1, detect the repo's primary language(s):

- **JS/TS**: `package.json` present with `dependencies` or `devDependencies`
- **Python**: `pyproject.toml`, `requirements.txt`, `Pipfile`, `setup.py`, or `uv.lock` present
- **Mixed**: both present (e.g. Python backend + TS frontend)
- **Unknown**: neither → proceed with universal principles only, skip stack-specific sections

**Mixed-stack handling** (fix R2-H3 + R3-M3): when mixed, apply the profile
matching the **files involved in the current task**. If no files cited yet,
fall back to **primary-language heuristic**:

File-based routing (preferred when files are identified):
- Task's cited files are `.py` → apply Python profile
- Task's cited files are `.ts`/`.js`/`.tsx`/`.jsx` → apply JS/TS profile
- Task's cited files span both languages → apply BOTH, each principle scoped to its language

Primary-language fallback (when no files cited yet — e.g. "design a new feature"):
- Count source files of each language in the repo
- Apply the profile of the MAJORITY language
- Log the detection: "Mixed repo, majority Python — applying Python profile. Use /plan-<skill> with explicit file paths to scope differently."
- If the user's task clarifies later that they mean the other language, the skill switches profiles mid-conversation

Example: `/plan-backend add a user endpoint` with no files cited in a monorepo
with 80% `.py` files, 20% `.ts` files → applies Python profile by default.
Logs the inference. User corrects if wrong.

When Python is detected, also identify the **framework** (affects which
principles apply):

- **FastAPI**: `fastapi` in deps, or `FastAPI()` import in source
- **Django**: `django` in deps, or `DJANGO_SETTINGS_MODULE` in config, or `manage.py` present
- **Flask**: `flask` in deps, or `Flask()` import in source
- **None/custom**: no framework detected → apply only universal Python principles (type hints, pytest, ruff)

Based on detection, reference the appropriate stack profile and framework
section below. When mixed, apply BOTH the JS/TS and Python profiles.
```

**Framework-scoped guidance** (fix R2-M1 — every Python principle bullet
carries an explicit framework tag):

Each bullet in the Python profile sections uses one of these tags:

- `[generic]` — applies to any Python web backend regardless of framework
- `[fastapi]` — FastAPI only
- `[django]` — Django only
- `[flask]` — Flask only
- `[fastapi,flask]` — applies to both
- `[django,flask]` — applies to both
- etc.

**Examples of tagged bullets**:

- `[generic]` Type hints on function signatures + returns (mypy/pyright strict)
- `[generic]` Exception hierarchy (custom `AppException` base, no bare `except:`)
- `[generic]` Pytest for testing, ruff for lint + format
- `[generic]` Virtual environment discipline (venv/poetry/uv)
- `[generic]` ORM N+1 prevention (language-agnostic principle)
- `[fastapi]` Async consistency — whole request path async, no sync DB calls
- `[fastapi]` `Depends()` for dependency injection, not module-level singletons
- `[fastapi,flask]` `pydantic-settings` BaseSettings for config (Django uses `settings.py`)
- `[fastapi,flask]` Pydantic validation at API boundaries, not dict-bashing
- `[django]` Fat-view anti-pattern — move business logic to services
- `[django]` Django forms for validation before DB writes
- `[django,flask]` HTMX progressive enhancement (Django/Flask templates)

The skill reads Phase 0's framework detection and applies only matching bullets.

**plan-backend Python profile** (new section, inserted after Phase 0, before existing Phase 1):

- File-layout expectations: `src/<pkg>/` or `<pkg>/`, `routes/api/views/`, `services/domain/`, `models/schemas/`, `migrations/`, `tests/`
- Python-specific principle checks:
  - Type hints (`mypy --strict` clean)
  - Pydantic validation at boundaries (no dict-bashing)
  - Async consistency (no sync-in-async)
  - Dependency injection (`Depends()` vs module-level singletons)
  - DB session scope (one per request)
  - ORM N+1 prevention (`select_related` / `joinedload` / `prefetch_related`)
  - Exception hierarchy (custom `AppException` base, no bare `except:`)
  - Settings via typed `pydantic-settings` BaseSettings
- Stack commands: `pytest`, `ruff check`, `ruff format`, `mypy`/`pyright`, `uv sync`/`poetry install`
- Python-specific anti-patterns: global DB session, sync-in-async, any-typed returns, dict-passing, Django fat views

**plan-frontend Python profile** (new section, inserted after Phase 0, before existing Phase 1):

Focus on server-rendered (Jinja, Django templates, HTMX) since that's ~90% of Python "frontend":

- File layout: `templates/`, `static/`, optional `frontend/` for separate JS build
- Python FE principle checks: template inheritance, HTMX progressive enhancement, CSRF on mutations, server-side form validation, context data discipline, static asset versioning
- Python-specific anti-patterns: logic in templates, `|safe` without justification, direct ORM access from templates

**ship Python profile** (new section between Phase 0 and existing phases):

Fix R1-M3 — explicit pre-push command contract:

**Command discovery rules** (fix R2-H4 — probe managed environment FIRST):

Detection ORDER: detect the environment manager FIRST, then probe commands
through that wrapper:

1. **Environment wrapper** (detected first):
   - `poetry.lock` present → all subsequent probes use `poetry run <cmd> --version`
   - `uv.lock` or `uv.toml` present → use `uv run <cmd> --version`
   - `Pipfile.lock` present → use `pipenv run <cmd> --version`
   - `.venv/` or `venv/` present → use `./<venv>/bin/<cmd> --version`
   - None detected → fall back to global PATH (`<cmd> --version`)

2. **Then** discover tools IN the detected environment:
   - **Test runner**: probe for `pytest` through the env wrapper, else `python -m pytest`, else MISSING
   - **Linter**: `ruff check --version` if `[tool.ruff]` in pyproject or `ruff` in locked deps; else `flake8 --version` if configured; else MISSING
   - **Type checker**: `mypy --version` if `[tool.mypy]` or `mypy.ini` present; else `pyright --version` if `pyrightconfig.json`; else MISSING
   - **Format check**: `ruff format` if ruff detected; else `black --version` if `[tool.black]` or in deps; else MISSING

**Pre-push contract** (fix R2-H5 — tests must run, not silently skip):

| Category | If MISSING → |
|---|---|
| Test runner | **BLOCK push**, log: "no test runner detected (pytest/python -m pytest). Add `pytest` to dev deps or explicitly override with `ship --no-tests`." |
| Linter | Warn, do NOT block — linting is non-critical |
| Type checker | Warn, do NOT block — strict typing is optional |
| Format check | Warn, do NOT block — formatting is stylistic |

**Rationale**: shipping untested code is a bug. Shipping unlinted/unformatted
code is a preference. The contract treats the test runner as mandatory (or
explicit override), other tools as advisory.

For each DISCOVERED tool: any non-zero exit BLOCKS the push.

**Override flag**: `ship --no-tests` acknowledges the absence explicitly.
Logged prominently. Operator-accepted responsibility.

**Status.md section naming**:
- "Python Package Structure" (vs "Backend Structure")
- "Dependencies" from `pyproject.toml` `[project.dependencies]` or `requirements.txt`
- "Database Migrations" (Alembic/Django migrations)
- "API Endpoints" (FastAPI/Django REST Framework/Flask routes)

**audit Python profile** (new section, inserted after Phase 0, before existing Phase 1):

Same principle checks as plan-backend's Python profile, used when the audit
detects a Python repo during its file-classification phase.

### 2.4 Repo Rename

**Action**: `gh repo rename claude-engineering-skills`

**Consequences**:
- GitHub automatically creates a redirect from `claude-audit-loop` → `claude-engineering-skills`
- Existing clones continue to work (`git remote -v` shows old URL until user runs `git remote set-url`)
- Internal references updated in one commit: `package.json` name, `README.md` title, `CLAUDE.md` project overview
- Commit messages going forward don't mention the rename

**README rewrite** (Phase E scope):
- New title: "Claude Engineering Skills"
- Tagline: "A bundle of 5 AI-pair-programming skills for planning, auditing, shipping"
- Per-skill one-liner + link to each SKILL.md
- Installation section: for now, manual copy instructions (Phase F replaces this)
- Python support mention
- Link to mega-plan for the multi-phase roadmap

**CLAUDE.md update**: Project Overview section now describes the bundle instead of "multi-model audit loop". Architecture and dependencies sections remain accurate (still the audit-loop's internals).

**Repo-wide old-slug inventory** (fix R1-M2 / R2-M2 — all tracked files, not
extension-limited): before the rename commit lands, use git itself to enumerate
tracked files:

```bash
# git ls-files gives us exactly the tracked files, no extension filtering
git ls-files | xargs grep -ln "claude-audit-loop" 2>/dev/null
```

Every hit must be either:
1. Updated to `claude-engineering-skills`
2. Preserved because it's historical (commit messages, audit summaries) —
   these stay as-is, the repo history doesn't rewrite
3. Intentional reference to the OLD name (e.g., "renamed from claude-audit-loop")

The rename commit's body must list the categories + counts so a reviewer
can verify nothing leaked.

### 2.5 Louis's Post-Ship Migration (ONE manual step)

After Phase E's vendoring commits land, Louis runs **one** command to align
his global install with the new source of truth:

**Bash (macOS/Linux)**:
```bash
for skill in plan-backend plan-frontend ship audit; do
  cp skills/$skill/SKILL.md ~/.claude/skills/$skill/SKILL.md
done
```

**PowerShell (Windows)**:
```powershell
foreach ($skill in 'plan-backend','plan-frontend','ship','audit') {
  Copy-Item "skills/$skill/SKILL.md" "$HOME/.claude/skills/$skill/SKILL.md"
}
```

**Cross-platform via Node** (fix R3-M5):
```bash
node -e "
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
for (const s of ['plan-backend','plan-frontend','ship','audit']) {
  const dest = path.join(os.homedir(), '.claude', 'skills', s, 'SKILL.md');
  fs.mkdirSync(path.dirname(dest), {recursive: true});
  fs.copyFileSync(path.join('skills', s, 'SKILL.md'), dest);
  console.log('copied', s);
}
"
```

After that: `skills/` in this repo is authoritative. Never edit in
`~/.claude/skills/` directly until Phase F installer automates sync.

**This is the ONE manual step in Phase E.** Everything else is additive
repo changes.

---

## 3. File Impact Summary

| File | Action |
|---|---|
| `skills/audit-loop/SKILL.md` | **Copy** from `.claude/skills/audit-loop/SKILL.md` (already in repo) |
| `skills/plan-backend/SKILL.md` | **Copy** from `~/.claude/skills/plan-backend/SKILL.md` + add Python profile |
| `skills/plan-frontend/SKILL.md` | **Copy** from `~/.claude/skills/plan-frontend/SKILL.md` + add Python profile |
| `skills/ship/SKILL.md` | **Copy** from `~/.claude/skills/ship/SKILL.md` + add Python profile |
| `skills/audit/SKILL.md` | **Copy** from `~/.claude/skills/audit/SKILL.md` + add Python profile |
| `package.json` | Rename `name` field: `claude-audit-loop` → `claude-engineering-skills` |
| `README.md` | Rewrite for bundle scope + link to mega-plan + Python support |
| `CLAUDE.md` | Update Project Overview section |
| GitHub repo name | One-time `gh repo rename` action |

**NOT touched by Phase E**: `.claude/skills/`, `.github/skills/`, `.agents/skills/`, any scripts, any tests. The audit-loop existing tests continue passing unchanged.

---

## 4. Testing Strategy

Phase E is content changes — no new runtime code. Tests are verification steps:

| Verification | How |
|---|---|
| All 5 skills present in `skills/` | `ls skills/*/SKILL.md \| wc -l` = 5 |
| Vendored skills byte-match their external sources (before Python edits) | `diff ~/.claude/skills/<name>/SKILL.md skills/<name>/SKILL.md` = empty for each (AT VENDORING STEP, before Python additions) |
| Python profiles added to 4 skills | `grep -l "Python Backend Profile\|Python Frontend Profile\|Python Repo Stack" skills/*/SKILL.md \| wc -l` = 4 |
| `package.json` name updated | `jq .name package.json` = `"claude-engineering-skills"` |
| Existing audit-loop tests still pass | `npm test` = pre-Phase-E baseline count, 100% passing |
| No new dependencies | `git diff package.json` shows only `name` field changed |
| Repo rename effective | `gh repo view` shows new name; old URL redirects |
| Frontmatter valid on all vendored skills | each SKILL.md has `name:` + `description:` YAML frontmatter |

**Manual verification** (operator-run after ship, fix R1-H4):

Phase E does NOT install skills into the consumer-visible locations — `skills/`
is a source-of-truth directory only. To verify a vendored skill actually
loads in practice, the operator must manually sync once:

```bash
# One-time manual install (Phase F automates this)
cp skills/plan-backend/SKILL.md ~/.claude/skills/plan-backend/SKILL.md
cp skills/plan-frontend/SKILL.md ~/.claude/skills/plan-frontend/SKILL.md
cp skills/ship/SKILL.md ~/.claude/skills/ship/SKILL.md
cp skills/audit/SKILL.md ~/.claude/skills/audit/SKILL.md
```

Then verification happens in two contexts:

**All 4 modified skills get behavioral verification** (fix R3-H3):

**Context 1 — Python repo + `/plan-backend`**:
- In a Python FastAPI or Django repo, invoke `/plan-backend design a user endpoint`
- Expected: skill detects Python + framework, cites at least 2 Python-specific principles (e.g., type hints, Pydantic validation, async consistency)
- Expected: does NOT cite JS-specific principles (no "apiFetch", no "CSP compliance")

**Context 2 — Python repo + `/plan-frontend`**:
- In a Django repo (server-rendered), invoke `/plan-frontend redesign the dashboard page`
- Expected: skill cites Python FE principles (template inheritance, HTMX progressive enhancement, CSRF on mutations, server-side form validation)
- Expected: does NOT cite "event delegation" or "debounce throttle" (those are JS SPA concerns)

**Context 3 — Python repo + `/ship`**:
- In a Python repo with `pyproject.toml` + `pytest` in deps, invoke `/ship`
- Expected: skill discovers `pytest` via env wrapper (poetry/uv/venv), runs it, uses detected linter/type-checker/formatter
- Expected: status.md references "Python Package Structure" section
- Test missing test runner: remove pytest from deps, invoke `/ship`, expect BLOCK unless `--no-tests` (fixes R3-H4)

**Context 4 — Python repo + `/audit`**:
- In a Python FastAPI repo, invoke `/audit` on a plan file
- Expected: audit cites at least 1 Python-specific principle from the profile
- Expected: doesn't flag Python-standard patterns as violations

**Context 5 — JS/TS repo no-regression** (all 4 skills):
- In this repo (TS), invoke `/plan-backend`, `/plan-frontend`, `/ship`, `/audit`
- Expected: each skill loads, detects JS/TS, cites JS/TS principles unchanged from pre-Phase-E behavior
- Expected: no Python sections surface

**Context 6 — Mixed monorepo** (per-task scoping):
- In a repo with `pyproject.toml` (Python backend) + `package.json` (TS frontend)
- Invoke `/plan-backend design the sync job` with cited files `backend/sync.py`
- Expected: Python profile applied (files are .py)
- Invoke `/plan-frontend update the dashboard` with cited files `frontend/src/Dashboard.tsx`
- Expected: JS/TS profile applied (files are .tsx)
- Invoke `/plan-backend sync between FastAPI + Node worker` with cited files spanning both
- Expected: both profiles, scoped per-file

**Minimal automated checks** (fix R3-M4 + R3-M2):

While Phase E is content-focused, two small automated tests keep the content
honest:

1. **`tests/skills-content.test.mjs`** — asserts:
   - All 5 skills exist in `skills/<name>/SKILL.md`
   - Each has valid YAML frontmatter with `name:` + `description:`
   - Each has at least one `## ` heading (sanity check on markdown structure)
   - The 4 skills with Python profiles (plan-backend/plan-frontend/ship/audit) each contain a "Phase 0 — Repo Stack Detection" heading + at least 5 occurrences of framework tags (`[generic]`, `[fastapi]`, `[django]`, `[flask]`)

2. **`tests/vendoring-provenance.test.mjs`** — asserts:
   - `.audit/vendoring-provenance.json` exists (committed)
   - Has entries for all 5 skills
   - Each entry's recorded SHA matches the SHA of the current `skills/<name>/SKILL.md` file bytes (detects accidental content drift vs recorded baseline)

Both tests are small (~20 lines each). Run as part of `npm test`. Don't
validate the semantic quality of Python profiles (that's criterion 5), but
they catch structural regressions.

Phase F adds comprehensive infrastructure tests (installer, updater, etc.).

**Acceptance gate for Phase E ship** (fix R2-H6 — single unambiguous rule):

Phase E SHIPS when ALL of these pass:
1. All 5 vendored skills present in `skills/`, byte-faithful to original sources (diff checked at vendoring step)
2. Python profile sections present in plan-backend/plan-frontend/ship/audit (grep check)
3. Pre-Phase-E test count unchanged — existing tests still passing (`npm test` green)
4. Repo rename effective + old-slug grep returns zero unexpected hits
5. Manual verification Context 1 (§4 above) passes: `/plan-backend` in a Python repo cites at least 2 Python-specific principles

Criteria 1-4 are automated checks. Criterion 5 is operator-run but required
BEFORE the ship commit lands. If criterion 5 fails, Phase E is incomplete
until the Python profile content is fixed.

**Explicit**: criterion 5 IS a blocker. Profile quality MUST be validated
before ship. If it takes 2 revisions of the Python profiles to pass, Phase E
takes 2 extra commits. That's acceptable.

---

## 5. Rollback Strategy

- **Repo rename**: `gh repo rename claude-audit-loop` reverses it. GitHub preserves redirects both ways.
- **Vendored skills**: delete `skills/` directory. External copies in `~/.claude/skills/` untouched.
- **Python profile additions**: git revert the specific commit that added them.
- **Package.json name**: one-field change, trivial revert.
- **README/CLAUDE.md**: git revert.

Nothing in Phase E is destructive. Every change is reversible via git + one GitHub API call.

---

## 6. Implementation Order

1. **Ship D.8 first** — close remaining PR comment gaps (independent, clears the decks)
2. **Rename repo** — `gh repo rename claude-engineering-skills`. Update `package.json` name, `README.md` title, `CLAUDE.md` overview. One commit.
3. **Vendor audit-loop** — copy `.claude/skills/audit-loop/SKILL.md` → `skills/audit-loop/SKILL.md`. One commit.
4. **Vendor plan-backend** — copy from `~/.claude/skills/plan-backend/SKILL.md` → `skills/plan-backend/SKILL.md` byte-faithful. One commit.
5. **Vendor plan-frontend** — same pattern. One commit.
6. **Vendor ship** — same pattern. One commit.
7. **Vendor audit** — same pattern. One commit.
8. **Add Python profile to plan-backend** — insert Phase 0 detection + Python profile section between existing Phase 0/intro and Phase 1. One commit.
9. **Add Python profile to plan-frontend** — same. One commit.
10. **Add Python profile to ship** — same. One commit.
11. **Add Python profile to audit** — same. One commit.
12. **README rewrite** — bundle scope, 5-skill quick reference, Python support note, link to mega-plan. One commit.
13. **Manual verification** — Louis tests plan-backend in a Python repo, confirms principles land. Documented in commit or follow-up note.

**Estimated commits**: ~11-12. Each is focused, auditable, and reversible.

---

## 7. Known Limitations (accepted for Phase E)

1. **Single edit channel enforced by discipline, not tooling** — after Phase E ships, Louis commits to editing in `skills/` only. `~/.claude/skills/` drifts stale until Phase F installer syncs them. No tooling prevents accidental edits in the wrong place during this interim.
2. **No consumer-repo install** — team members still manually copy skill files. Phase F solves this.
3. **Stale consumption-path mirrors during Phase E interim** (fix R3-H2 — time-bounded debt): `skills/` is the ONLY authoritative location, but `.claude/skills/audit-loop/`, `.github/skills/audit-loop/`, and Louis's `~/.claude/skills/*` remain as stale-unmanaged copies. Phase E documents this gap; Phase F immediately resolves it (installer auto-syncs). The gap exists for as long as Phase F takes to ship after Phase E — a bounded interval, not indefinite debt.
4. **Repo rename may confuse bookmarks** — GitHub redirect covers URLs; team members with local clones see old remote name until they manually update.
5. **Framework detection is heuristic** — may miss custom Python frameworks (Starlette, aiohttp, Sanic, etc.). Falls through to generic Python principles. Documented as fallback; Phase E doesn't try to cover every framework.
6. **Python profile iteration expected** — §4 acceptance gate validates content, but first real-world Python audits may reveal gaps in specific principles. If so, those are **Phase E follow-up commits** (the phase isn't done until profiles work in practice). NOT a reason to ship incomplete content.

---

## 8. Resolved Design Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| Q1 | Where to put vendored skills? | `skills/` at repo root | Visible, top-level, separate from install mirrors |
| Q2 | Vendor verbatim first, then edit? | Yes — one commit per skill, byte-faithful copy | Git-diffable before/after for reviewers |
| Q3 | Add Python profiles in Phase E or defer? | Add in Phase E | Content phase is the right time; delay forces a 2nd content pass later |
| Q4 | Which Python stacks to cover? | Web services (FastAPI/Django/Flask) + server-rendered FE (Jinja/HTMX/Django templates) | Team's primary use case |
| Q5 | Keep data-science / Jupyter out? | Yes, Phase E web services only | Data-science is a different audit surface entirely |
| Q6 | Sync `.claude/skills/` mirrors during Phase E? | No — defer to Phase F installer | Phase E is content only, no sync logic |
| Q7 | Rename before or after vendoring? | Before — ensures all new files reference new repo name | Cleaner, no retrofit |
| Q8 | Manual test of Python profiles blocks ship? | **YES** — §4 criterion 5 is a blocker; if profiles fail, fix in Phase E follow-up commits before declaring phase done | Ships broken content otherwise |
| Q9 | How to lock in reproducibility after vendoring? | Record vendored-file SHA256 in each vendoring commit message | Repo becomes reproducible baseline; no dependency on Louis's machine after |
| Q10 | Framework detection depth? | FastAPI / Django / Flask; others fall through to generic Python | Covers ~95% of Python web services; custom frameworks get generic guidance |
| Q11 | Python profile structure in SKILL.md files? | New section after Phase 0, before existing Phase 1 (insertion, not appending) | Unambiguous instruction; reviewable git diff |
| Q12 | `ship` command contract for partial toolchain? | Test runner MANDATORY (blocks unless `--no-tests` override); linter/type-checker/formatter ADVISORY (warn but don't block) | Shipping untested code is a bug; linting/typing/formatting are preferences |
| Q13 | Rename impact analysis? | Repo-wide grep for `claude-audit-loop`, categorized in rename commit | Catches stale refs before they confuse consumers |

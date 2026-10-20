---
summary: Python pre-push command discovery — env wrapper detection + per-tool probe order.
---

# Python Pre-Push Command Discovery

Applied when `detect-stack` reports `stack: 'python'` or `'mixed'` with
Python files in the diff. The environment manager must be detected FIRST,
then tools are probed THROUGH that wrapper so the discovered commands are
the ones `/ship` can actually execute.

## Detection order

### 1. Environment wrapper (detected first)

| Marker | Wrapper |
|---|---|
| `poetry.lock` present | `poetry run <cmd> --version` |
| `uv.lock` or `uv.toml` | `uv run <cmd> --version` |
| `Pipfile.lock` present | `pipenv run <cmd> --version` |
| `.venv/` or `venv/` present | `./<venv>/bin/<cmd> --version` |
| None detected | fall back to global PATH (`<cmd> --version`) |

Invoke via the shared CLI:

```bash
node scripts/cross-skill.mjs detect-stack --include-env-manager
```

Returns `environmentManager: 'poetry'|'uv'|'pipenv'|'venv'|'none'`.

### 2. Tools, probed through the detected wrapper

| Tool | Probe order |
|---|---|
| **Test runner** | `pytest` through wrapper → `python -m pytest` → MISSING |
| **Linter** | `ruff check` if `[tool.ruff]` in pyproject or `ruff` in locked deps → `flake8` → MISSING |
| **Type checker** | `mypy` if `[tool.mypy]` / `mypy.ini` → `pyright` → MISSING |
| **Format check** | `ruff format` if ruff detected → `black` if `[tool.black]` or `black` in locked deps → MISSING |

## Pre-push contract

| Category | If MISSING |
|---|---|
| Test runner | **BLOCK push** — log: "no test runner detected (pytest). Add `pytest` to dev deps or override with `ship --no-tests`." |
| Linter | Warn, do NOT block |
| Type checker | Warn, do NOT block |
| Format check | Warn, do NOT block |

For each DISCOVERED tool, any non-zero exit BLOCKS the push.

**Override flag**: `ship --no-tests` acknowledges the absence explicitly
and is logged prominently in the ship_event record.

## Python-specific status.md sections

When generating/updating status.md for Python repos, use these section
titles (differ from JS/TS defaults):

- "Python Package Structure" (vs "Backend Structure")
- "Dependencies" — from `pyproject.toml` `[project.dependencies]` or `requirements.txt`
- "Database Migrations" — Alembic / Django migrations
- "API Endpoints" — FastAPI / Django REST Framework / Flask routes

## Example discovery output

```
[stack] mixed repo, Python side:
  envManager: poetry
  tools:
    test:      pytest (via poetry)           ✓
    linter:    ruff check (via poetry)       ✓
    types:     mypy (via poetry)             ✓
    format:    ruff format (via poetry)      ✓
```

## Citing an earlier test run (optional, never a skip)

A long suite that already passed on exactly this content need not be rerun to be
cited, but only a hash-bound record may say so, never recollection. Record the
run once, then ask before rerunning:

```bash
node scripts/test-evidence.mjs record --ignore report.xml --junit report.xml -- pytest -q --junitxml=report.xml
node scripts/test-evidence.mjs check --ignore report.xml -- pytest -q --junitxml=report.xml
```

`check` answers `reusable` (exit 0), `invalidated` (1) or `unknown` (3). Only
`reusable` may be cited in the ship report, with its recorded counts and wall
time; `invalidated` and `unknown` mean the tests run again. `--no-tests` is
unchanged and nothing here consults the tool automatically. A gitignored input
(a venv, `.env`) is invisible to the hash: `--toolchain "pip freeze"` binds the
installed packages (through the interpreter the tests use), never `.env`. Flags and exit codes: the header of `scripts/test-evidence.mjs`.

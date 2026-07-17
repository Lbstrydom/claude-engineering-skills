# Contributing to Claude Engineering Skills

Thank you for your interest in contributing! This guide covers the development workflow.

## Development Setup

```bash
git clone https://github.com/Lbstrydom/claude-engineering-skills.git
cd claude-engineering-skills
npm install
cp .env.example .env  # Configure API keys
npm test              # Verify setup (all tests should pass)
```

## Running Tests

```bash
npm test                                    # All tests
node --test tests/stores/*.test.mjs         # Store adapter tests only
node --test tests/claudemd/*.test.mjs       # Hygiene linter tests only
node --test tests/install/*.test.mjs        # Installer tests only
```

## Project Structure

- `skills/` -- **canonical source of truth** for all 6 skill directories. Edit only here.
- `.claude/skills/` -- **generated copy** — NEVER edit directly. Run `npm run skills:regenerate`.
- `scripts/` -- CLI tools and core audit-loop scripts
- `scripts/lib/` -- focused modules (schemas, file-io, stores, skill-packaging, skill-refs-parser, repo-stack)
- `tests/` -- Node.js built-in test runner
- `docs/plans/` -- feature plans (audited)
- `docs/reference/skill-reference-format.md` -- canonical spec for skill reference files

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes
3. Run `npm test` — all tests must pass
4. If you changed any skill files: `npm run skills:regenerate && npm run skills:check`
5. If you changed any skill files: `npm run skills:manifest`
6. Run `node scripts/claudemd-lint.mjs` to check instruction file hygiene
7. Submit a PR with a clear description

### PR Checklist

- [ ] Tests pass (`npm test`)
- [ ] Skills lint clean (`npm run skills:check`) — reference-index + frontmatter drift detection
- [ ] Skill copies in sync (included in `skills:check` — `.claude/` and `.github/` must equal `skills/`)
- [ ] Manifest is fresh (included in `skills:check`; standalone: `npm run skills:manifest:check`)
- [ ] No new dependencies added without justification
- [ ] CLAUDE.md updated if architecture changed
- [ ] New features have tests

### Git hooks

Hooks live in **`.githooks/`** (tracked) and are wired automatically by
`npm install` — `prepare` runs `scripts/install-git-hooks.mjs`, which points
`core.hooksPath` at that directory. `pre-push` runs `npm run check` and **blocks**
on failure (`git push --no-verify` to bypass).

Edit hooks in `.githooks/`, never in `.git/hooks/` — `core.hooksPath` supersedes
that directory entirely, so an edit there does nothing. A new hook must be
committed executable (`git update-index --chmod=+x`), or git silently ignores it
on Linux/macOS; `tests/git-hooks-wiring.test.mjs` enforces this.

`npm run check` is the only thing gating a push — no workflow runs it on push or
PR — so an unwired hook means an unenforced repo.

## Skill Authoring

Skills use **progressive disclosure** — canonical flow in `SKILL.md`
(target ≤3K tokens); specialised content in `references/` and `examples/`
loaded on demand.

```
skills/<skill-name>/
├── SKILL.md                   # canonical flow
├── references/
│   └── <topic>.md             # each with `summary:` frontmatter
└── examples/
    └── <sample>.md            # optional
```

### Required structure

**SKILL.md frontmatter:**

```yaml
---
name: my-skill
description: |
  What this skill does and when to invoke it.
---
```

**Reference file frontmatter** (required for every file under `references/` or `examples/`):

```markdown
---
summary: One-line description, ≤120 chars, byte-identical to the SKILL.md index row.
---

# Rest of the reference file…
```

**Reference-index section** at the end of SKILL.md:

```markdown
## Reference files

| File | Summary | Read when |
|---|---|---|
| `references/topic-a.md` | Summary matching frontmatter. | Specific, detectable trigger condition. |
```

See `docs/reference/skill-reference-format.md` for the full spec + lint rules.

### Editing workflow

1. Edit files under `skills/<name>/` only
2. Run `npm run skills:regenerate` to propagate to `.claude/` and `.github/`
3. Run `npm run skills:check` before committing — enforces:
   - Reference-file existence + frontmatter `summary:` exact-match
   - No orphan files in `references/` that aren't indexed
   - Byte equality between `skills/` and the generated `.claude/` / `.github/` copies

### Allowlist

Only these files propagate to installers + consumer repos:
- `SKILL.md`
- `references/**/*.md`
- `examples/**/*.md`

Code belongs in `scripts/` at repo root, not inside skill directories.

### Size targets

- Individual `SKILL.md`: ≤3K tokens (~280 lines)
- Reference files: focused, self-contained; 2 hops maximum between refs

## Code Style

- ESM modules (`import`/`export`)
- `process.stderr.write()` for progress logging
- `atomicWriteFileSync()` for all persisted files
- Zod schemas at all boundaries
- No `require()` -- project is ESM-only

## Reporting Issues

Use the GitHub issue templates for bugs and feature requests.

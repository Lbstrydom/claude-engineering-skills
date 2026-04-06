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

- `skills/` -- canonical source of truth for all 5 skill files
- `scripts/` -- CLI tools and core audit-loop scripts
- `scripts/lib/` -- focused modules (schemas, file-io, stores, etc.)
- `tests/` -- Node.js built-in test runner
- `docs/plans/` -- feature plans (audited)

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes
3. Run `npm test` and ensure all tests pass
4. Run `node scripts/build-manifest.mjs` if you changed any skill files
5. Run `node scripts/claudemd-lint.mjs` to check instruction file hygiene
6. Submit a PR with a clear description

### PR Checklist

- [ ] Tests pass (`npm test`)
- [ ] Manifest is fresh (`node scripts/build-manifest.mjs --check`)
- [ ] No new dependencies added without justification
- [ ] CLAUDE.md updated if architecture changed
- [ ] New features have tests

## Skill Authoring

Skills live in `skills/<name>/SKILL.md` with YAML frontmatter:

```yaml
---
name: my-skill
description: |
  What this skill does and when to invoke it.
---
```

Guidelines:
- Keep skills under 30KB
- Use Phase 0 stack detection for multi-language support
- Reference supporting docs instead of inlining architecture
- Test in both JS/TS and Python repos when applicable

## Code Style

- ESM modules (`import`/`export`)
- `process.stderr.write()` for progress logging
- `atomicWriteFileSync()` for all persisted files
- Zod schemas at all boundaries
- No `require()` -- project is ESM-only

## Reporting Issues

Use the GitHub issue templates for bugs and feature requests.

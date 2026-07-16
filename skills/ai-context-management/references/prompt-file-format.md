---
summary: Copilot .prompt.md format spec, frontmatter rules, and the SKILL_ENTRY_SCRIPTS registry.
---

# Copilot .prompt.md Format — Reference

`.github/prompts/<name>.prompt.md` files are VS Code Copilot's slash-command
shims. They appear as `/<name>` in Copilot chat. The audit-loop bundle
generates one per registered skill, wrapping the same CLI that Claude skills
orchestrate.

## File anatomy

```markdown
<!-- audit-loop-bundle:prompt:start -->
---
description: Single-line description (≤240 chars; appears in Copilot UI).
mode: agent
---
# /<skill-name>

<purpose paragraph from SKILL.md>

## Run

Invoke the engineering skills CLI:

```bash
node scripts/<entry-script>.mjs <args>
```

<context line about what the underlying script does>

## Notes for Copilot users

<expectations: structured CLI output, not Claude's conversational UX>
<!-- audit-loop-bundle:prompt:end -->
```

### Marker rules

- File starts with `<!-- audit-loop-bundle:prompt:start -->`
- File ends with `<!-- audit-loop-bundle:prompt:end -->`
- Re-running `npm run skills:regenerate` replaces files that have the markers;
  files without the markers (operator-authored) are left alone.

## Frontmatter rules

- `description`: single-line (≤240 chars). First sentence of SKILL.md
  description, or `entry.summary` fallback when SKILL.md frontmatter is missing.
- `mode: agent`: required. Tells Copilot to run the prompt in agent mode (full
  tool use), not chat mode.

## SKILL_ENTRY_SCRIPTS registry

Located at `scripts/lib/install/copilot-prompts.mjs`. Maps skill name → CLI
entry:

```javascript
export const SKILL_ENTRY_SCRIPTS = Object.freeze({
  '<skill-name>': {
    script: '<entry-script>.mjs',
    argsHint: '<args>',
    cli: 'node scripts/<script>.mjs ${input:placeholder}',
    summary: 'Single-sentence purpose.',
  },
});
```

### Adding a new skill to the registry

1. Edit `scripts/lib/install/copilot-prompts.mjs`.
2. Add an entry to `SKILL_ENTRY_SCRIPTS` for the new skill.
3. Run `npm run skills:regenerate` to materialise `.github/prompts/<new>.prompt.md`.
4. Verify the file content looks correct: `cat .github/prompts/<new>.prompt.md`.
5. The file ships to consumer repos via `npm run sync` (Phase 4 default behaviour).

### Why two sources

The SKILL.md frontmatter describes the skill from the developer's perspective
(triggers, usage examples, what it does). The registry binds the skill to a
consumer-repo CLI invocation path (`scripts/...`). These are
distinct concerns — the SKILL.md correctly does not know its own deployment
path. Tests in `tests/copilot-prompts.test.mjs` enforce that every registered
skill has a `cli` field that points at the consumer-repo path.

## VS Code input placeholders

Copilot prompt files support `${input:name}` placeholders — Copilot prompts the
user at invocation time. Supports multiple inputs:

```bash
node scripts/persona-test.mjs ${input:persona} ${input:url}
```

Use placeholders for arguments the user must always supply. For optional flags,
use a single `${input:args}` and let the user paste a partial command line.

## Idempotency

The generator hashes the managed block — re-runs produce byte-equal output for
unchanged inputs. `shaOfManagedBlock(content)` exposed for tests and for
detecting whether install would change the file.

## Limitations vs Claude SKILL.md

Copilot prompt files do not support:
- Reference loading on demand (no `references/` directory; the prompt body is
  the entire surface).
- Multi-turn conversational orchestration.
- Hook integration.

For complex skills (audit-code, persona-test), the prompt file provides
**CLI parity**: the user gets structured JSON output and ledger files. The
multi-turn fix-iterate loop is Claude-only.

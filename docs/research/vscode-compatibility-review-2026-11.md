# VS Code compatibility review — 2026-11

<!-- population: not-store-derived — every claim comes from official vendor documentation fetched on 2026-11-22, the marketplace and GitHub pages named inline, and this repository's own files at commit 4b778e70; no audit-store query is involved -->

**What it is.** A review of how this repo's skills, hooks, MCP config and `/fleet` behave in the three VS Code agent
surfaces: GitHub Copilot agent mode, the Claude Code extension for VS Code, and the Copilot cloud agent (formerly the
"coding agent"). It also answers whether `/fleet` can run from VS Code.
**When you need it.** Before changing a host-contract block, `references/hosts.md`, the MCP or hook wiring, or the sync
surfaces. **Read it with its plan:** [`docs/plans/vscode-compatibility.md`](../plans/vscode-compatibility.md).

Repository evidence is pinned to commit `4b778e70`. Line numbers decay, so re-grep before acting. Vendor facts are labelled
**doc** (read on the official page, cited), **unverified** (search snippet, third-party page, or the docs are silent) or
**obs** (observed in a real session). No row in this review was smoke-tested in VS Code. That is itself a finding: §6.

## 1. Headline findings

1. **VS Code moved to "agent harnesses", which invalidates two stated invariants.** VS Code 1.147 (2026-11-18) runs a
   session on one of four harnesses: Copilot (default; Copilot SDK in an Agent Host process), Anthropic Claude (the Claude
   Agent SDK, built in), OpenAI Codex (experimental), and Local (the old extension-host agent mode). Local is
   **deprecated and is removed in February 2027**.
   - doc: <https://code.visualstudio.com/docs/agents/run/agent-harnesses>
   - doc: <https://github.blog/changelog/2026-11-16-vs-code-retires-the-local-harness-in-february-2027> (2026-11-16)

   Settings this repo's docs rely on now affect Local only: `.vscode/mcp.json`, `chat.useClaudeHooks`, `runSubagent`,
   `chat.agentSkillsLocations`, `chat.useClaudeMdFile`.
   - **The MCP invariant is stale.** AGENTS.md:236-237 (`4b778e70`) says "VS Code reads `.vscode/mcp.json`, **NOT**
     `.mcp.json`". The default Copilot harness reads the root **`.mcp.json` directly** and only *forwards* eligible
     `.vscode/mcp.json` entries (doc: <https://code.visualstudio.com/docs/agents/reference/mcp-configuration>). The sync
     ships `.vscode/mcp.json` to consumers but not `.mcp.json` (`scripts/lib/sync-inventory.mjs:330`,
     `scripts/check-mcp-parity.mjs:13`), so on the default harness every consumer depends on forwarding.
   - **The no-hook invariant is stale.** `docs/reference/enforcement-mechanisms.md:108` says "Copilot, Cursor and every
     other host get no hook". The Copilot harness **reads the repo's `.claude/settings.json` hooks**, with Claude matcher
     semantics for PascalCase events (§4).
2. **`/fleet` CAN be driven from VS Code now; `hosts.md` says it cannot.** `skills/fleet/references/hosts.md:15`
   (`4b778e70`, "as of 2026-10-19, VS Code 1.142") says no documented tool lets an agent list, spawn or message sessions.
   That has changed in two places:
   - **VS Code (doc):** "In Copilot and Claude sessions, agents can create new sessions, inspect their status and recent
     context, and send follow-up messages". That includes "an independent session … with a new worktree"
     (<https://code.visualstudio.com/docs/agents/run/tools>, §Coordinate work across sessions). The tool names are not
     published, and `chat.agentHost.agentOrchestrationLimits` (default `on`) rate-limits creation and messaging.
   - **Claude Code (doc):** `ListAgents` and `SendMessage` reach other local, background and cloud sessions, from v2.1.224
     (v2.1.234 on native Windows; <https://code.claude.com/docs/en/cross-session-messaging>). `claude --bg` with
     `claude agents --json` starts background sessions and lists them for scripts (research preview,
     <https://code.claude.com/docs/en/agent-view>). Messaging cannot *start* a session, and in the VS Code extension a
     held message cannot be approved through a dialog.

   Fleet's coordination substrate (registry, claims, lease, directives, landing) is already host-neutral. Only six
   desktop-tool touchpoints need a role-based mapping (§5).
3. **No existing orchestrator replaces `/fleet`** (§7). None of the 20 candidates surveyed has path-glob claims, a
   machine-wide heavy-job lease, WIP limits, or batched landing after approval. Several are launchers. **Adopt none as a
   dependency.** Use the built-in session tools of each host as fleet's spawn and message layer.
4. **Skills work across hosts, with one discovery caveat.** The Copilot runtime (shared by the VS Code Copilot harness,
   Copilot CLI and the cloud agent) reads project skills from `.github/skills`, `.claude/skills` and `.agents/skills`
   (doc: <https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills>). The VS Code skills page
   lists only `.github/skills/` for the Copilot harness, but says the table gives "a supported … location … not every
   directory it recognizes" (<https://code.visualstudio.com/docs/copilot/customization/agent-skills>, 11/18/2026).
   - `.claude/skills/**` therefore stays the single surface.
   - Precedence between roots is **still undocumented**, so the rule against shipping a name twice stands.
   - One item needs a smoke test before anyone relies on it: whether the VS Code Copilot harness lists `.claude/skills`
     (§6).
5. **The `UserPromptSubmit` accelerators may cost money and deliver nothing on Copilot.** On the Copilot runtime,
   "command-hook output is ignored for `userPromptSubmitted`" (doc, hooks page). `arch-memory-check.sh` writes its callout
   to stdout (`.claude/hooks/arch-memory-check.sh:15`). If the hook runs there, it would pay for a Gemini embed and a
   store RPC (≈$0.0003 + one RPC, with a 12 s timeout, per intent-verb prompt), and its output would be dropped. Whether
   it runs at all on Windows is unverified (§4).

## 2. Current host capabilities (research, 2026-11-22)

### 2a. GitHub Copilot in VS Code (Copilot harness unless stated)

| Capability | State | Source |
|---|---|---|
| Custom agents | `.github/agents/<name>.agent.md`; keys `name`, `description`, `tools`, `model`, `model-policy`, `handoffs` (Local only), `user-invocable`, `disable-model-invocation` | doc <https://code.visualstudio.com/docs/copilot/customization/custom-agents> (11/18/2026). Whether `.claude/agents` is read: unverified |
| Prompt files | `.github/prompts/*.prompt.md` run **only in Local** sessions. VS Code recommends converting them to skills, so the repo's 2026-07-21 retirement matches VS Code's direction | doc <https://code.visualstudio.com/docs/agent-customization/prompt-files> |
| Skills | Invoked as `/name args`. Frontmatter honoured: `name`, `description`, `argument-hint`, `user-invocable`, `disable-model-invocation`, `context: fork` (experimental). The CLI also honours `license` and `allowed-tools` (its grammar is `shell`/`bash` tool names; `Bash(...)` is not described) | doc (skills pages above) |
| Instructions | Copilot harness reads `AGENTS.md` (root and nested) and `.github/copilot-instructions.md`, and **not `CLAUDE.md`**. The Claude harness reads `CLAUDE.md` and `.claude/rules`. Copilot CLI reads both | doc <https://code.visualstudio.com/docs/agents/reference/custom-instructions-reference>; <https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions> |
| MCP | Reads root `.mcp.json` (`mcpServers`) and `~/.copilot/mcp-config.json` directly. `.vscode/mcp.json` (`servers`) is Local-format and only forwarded | doc (MCP reference above) |
| Hooks | Preview. Sources: `.github/hooks/*.json`, `~/.copilot/hooks/`, `.github/copilot/settings*.json`, **and repo `.claude/settings.json` / `.claude/settings.local.json`**. Events are camelCase, with PascalCase aliases that select the snake_case "VS Code compatible" payload. `preToolUse` can deny (top-level `permissionDecision`). `postToolUse` can add top-level `additionalContext`. `userPromptSubmitted` command output is dropped | doc <https://code.visualstudio.com/docs/copilot/customization/hooks>; <https://docs.github.com/en/copilot/reference/hooks-reference> |
| Subagents | Copilot's native `task` tool (Claude name `Agent`). Parallel delegation is supported. Subagent chats are read-only and cannot be messaged | doc <https://code.visualstudio.com/docs/agents/run/subagents> |
| Sessions | The Agents window runs sessions in parallel, each with folder or **New Worktree** isolation. Copilot sessions keep running while the Agent Host is up. Nested sessions, mixed harnesses (experimental), and External sessions (Copilot CLI, Claude Code, Codex) are listed. **Agents can create sessions, inspect them and send follow-ups** | doc <https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions> (11/18/2026); <https://code.visualstudio.com/docs/agents/run/tools> |
| Policy | Copilot enterprise-managed settings disable the Claude and Codex harnesses unless `vscode.allowedHarnesses` permits them. Relevant to the work machine | doc <https://code.visualstudio.com/docs/agents/agent-types/third-party-agents> |

### 2b. Copilot CLI and Copilot cloud agent

- **Copilot CLI** runs headless:
  - `copilot -p`, `--output-format json`, `--allow-tool`/`--deny-tool`, `--allow-all-tools`, `--no-ask-user`. Unattended
    approvals are denied.
  - `/delegate` (or a leading `&`) sends the task to the cloud agent as a draft PR.
  - Source (doc): <https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically>
- **Cloud agent** handles one branch and one PR per task, with GitHub Actions sessions capped at 59 minutes. The doc
  source for this paragraph is <https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent>.
  - **Starting and tracking tasks (doc):** `gh agent-task create|list|view` (gh ≥ 2.80, public preview). Continuing an
    existing branch is not documented.
  - **Environment setup (doc):** `.github/workflows/copilot-setup-steps.yml`, read only from the default branch.
  - **Hooks:** it reads only `.github/hooks/*.json`, never `.claude/settings.json`, and treats `ask` as `deny` (doc, hooks
    reference).
  - **Unverified (search snippets only):** the firewall is on by default, and secrets come only from the `copilot`
    environment.

### 2c. Claude Code extension for VS Code, and the Claude harness

- **The Anthropic extension** (doc: <https://code.claude.com/docs/en/vs-code>):
  - It bundles its own CLI, which is not on PATH. Running `claude` in the integrated terminal needs a separate standalone
    install.
  - It shares settings, hooks, MCP, plugins, history, `CLAUDE.md` and `/skills` with the CLI. Only a subset of slash
    commands is available.
  - It supports parallel conversations in tabs, background subagents, and worktrees under `.claude/worktrees/`.
  - No `start_session` equivalent is documented. Cross-session messaging works there, with the held-message caveat above.
- **The built-in "Anthropic Claude" harness in VS Code** is a separate product. It is the Claude Agent SDK, and it "uses
  Claude project configuration" (doc, agent-harnesses page). Whether it runs `.claude/settings.json` hooks or reads
  `.mcp.json` is unverified.
- **Headless:**
  - `claude -p` binds a messaging inbox. Unattended workers set `crossSessionInbound: "accept"` via `--settings` (doc,
    cross-session page).
  - `claude -w <name>` makes a worktree. In it, untracked `.claude/skills` is read through from the main checkout, and
    `${CLAUDE_PROJECT_DIR}` stays at the original root (doc: <https://code.claude.com/docs/en/worktrees>).
- **Agent teams** stay experimental (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). They do not run under `-p`, are limited to
  one team per session, and are lost on `/resume` (doc: <https://code.claude.com/docs/en/agent-teams>).

### 2d. Multi-session coordination from VS Code — what is possible

| Want | Copilot harness | Claude harness (VS Code) | Claude Code extension / CLI | Copilot cloud agent |
|---|---|---|---|---|
| Agent starts an independent session in a new worktree | doc: yes (tools unnamed; rate-limited) | doc: yes (same page) | no tool. Shell-out to `claude --bg` (unverified as an agent workflow) | `gh agent-task create` from a shell (preview) |
| Agent lists sessions | doc: "inspect their status" | doc: same | doc: `ListAgents`, `claude agents --json` | `gh agent-task list` |
| Agent messages a session | doc: follow-ups | doc: same | doc: `SendMessage` (never grants approval) | no (PR comments only) |
| Cross-vendor messaging (Copilot ↔ Claude Code) | none documented | none documented | none documented | none |
| Title / archive a session | unverified (user UI: rename, archive) | unverified | archive in UI; no tool | n/a |

Every row that says an agent can do something rests on documentation alone. Nobody has run it for fleet yet (§6).

## 3. Classification — skills and subsystems

Columns:

- **CP** = Copilot agent mode (Copilot harness).
- **CX** = Claude Code extension for VS Code. The Claude harness in VS Code behaves the same except where noted.
- **CA** = Copilot cloud agent.

Statuses: **W** = works, **D** = degraded (what is lost is stated), **B** = broken.

Evidence for skill bodies comes from the repo survey at `4b778e70`. A SKILL.md body names no desktop-only tool. The
host-specific parts are in references.

| Skill / subsystem | CP | CX | CA | What is lost, and the evidence |
|---|---|---|---|---|
| Input acquisition (all `host-contract: input-acquisition` sites, for example `skills/audit-code/SKILL.md:34`) | W | W | D | CP passes the `/name args` suffix, which is rule 2 of `references/input-acquisition.md` §1. CA has no `/name` invocation: the task text is the designated text, and an empty argument means ask-and-stop, which CA cannot answer (no user) |
| `/plan`, `/explain`, `/investigate`, `/brainstorm`, `/ai-context-management`, `/nav-audit` | W | W | D | CA: the outbound network (OpenAI, Gemini, the store) is behind the firewall. `/brainstorm` and the architectural-memory query degrade to their offline paths. Note: `/plan`, `/explain`, `/investigate`, `/nav-audit` and `/visual-audit` carry no input-acquisition marker, although `input-acquisition.md:71` names `/plan` as an example |
| `/audit-code`, `/audit-plan` (GPT + final gate) | W | W | B (as configured) | Needs `OPENAI_API_KEY` (and Gemini) plus network. CA has neither unless `copilot`-environment secrets and the firewall allowlist are set, both Louis's decisions. The Task/Agent substitute in `docs/audit/shared-references/gemini-gate.md:32` is worded for Claude. Copilot's `task` tool maps to `Agent` (hooks reference table), so the substitute is reachable on CP, but the text does not say so |
| `/cycle` (inline no-dispatch fallback, `skills/cycle/SKILL.md:63-95`) | W | W | D | The fallback text, "no documented mechanism for one skill to invoke another" (:67), is still true for CP. CX can dispatch. CA: `--autonomous` without `--ship` is the only meaningful mode, and it hits the audit network wall |
| `/ship` (`disable-model-invocation: true`; `host-contract: hook-rule` at `skills/ship/SKILL.md:914`) | W | W | B | CP honours `disable-model-invocation` (doc). The friction-closure accelerator is a `UserPromptSubmit` hook, and CP drops its output, but the portable command at :914 covers that. CA cannot run `/ship` (user-typed only), by design |
| `/security-strategy`, `/skills` (`disable-model-invocation`) | W | W | W | Doc-matched, as `skills/security-strategy/SKILL.md:20-24` already states |
| `/click-test`, `/persona-test`, `/visual-audit`, `/ux-lock` (browser-driver contract, `references/browser-tool-detection.md:17`) | W | W | D | CP: the integrated browser tools match the `copilot-browser` driver row (:83). Playwright MCP is reached via `.mcp.json` on the Copilot harness, where today it is only a forwarded `.vscode/mcp.json` entry (finding 1). CA: the firewall plus no MCP from `.vscode/` |
| `/harness-retro` | B | W | B | Reads Claude Code transcripts only (`scripts/lib/friction/retro/transcripts.mjs:5-9`). It has no Copilot session source, so on CP it mines the Claude history of the same machine, not the Copilot session it runs in. Documented debt, not in this plan's scope |
| `/fleet` portable CLI (`node scripts/fleet.mjs`, claims, lease, directives, land) | W (doc+code; untested) | W | D | Needs only node and git (`skills/fleet/references/hosts.md:7`). CA: no shared machine, so the lease and the registry under `<git-common-dir>` are per-sandbox and meaningless. A cloud PR is adopted afterwards with `fleet add #PR` |
| `/fleet` coordinator touchpoints (spawn, title, session-list cross-check, archive sweep, model switch, handover) | D | D | n/a | Six desktop-tool touchpoints, listed with evidence in §5 |
| Hook `arch-memory-check.sh` (`UserPromptSubmit`) | D (cost, no output; unverified that it runs on Windows) | W (CX). Claude harness: unverified | n/a (not read) | §4 |
| Hook `bash-grep-nudge.mjs` (`PreToolUse`, `Bash`) | D (unverified) | W | n/a | §4 |
| Hooks `quickfix-scan.mjs`, `syntax-check.mjs` (`PostToolUse`, `Edit\|Write`) | D (likely silent) | W | n/a | §4 |
| Hook `legacy-surface-advisory.mjs` (`UserPromptSubmit`) | D | W | n/a | Its advisory is output-only, so CP drops it. `npm run check` still reports the same fact at push time |
| Hook `install-cloud-deps.sh` (`SessionStart`) | W (no-op) | W | n/a | Acts only when `CLAUDE_CODE_REMOTE=true` (`:11`) |
| MCP wiring (`.mcp.json` ⇄ `.vscode/mcp.json`, parity gate `scripts/check-mcp-parity.mjs`) | D in consumers | W | D | §1, finding 1. The source repo carries both files. Consumers carry only `.vscode/mcp.json` |
| Instructions (`AGENTS.md` canonical, `CLAUDE.md` = `@./AGENTS.md` + addendum) | W | W | W (unverified) | CP reads AGENTS.md and does not read CLAUDE.md, so it loses only Claude-only notes, which is correct. AGENTS.md's MCP line is wrong for CP (finding 1) |
| Skill discovery (`.claude/skills/**` single surface) | W (CLI doc; VS Code page silent) | W | W (unverified) | §1, finding 4 |
| `allowed-tools: Bash(...)` (for example `skills/plan/SKILL.md:18`) | unknown | W | unknown | The Copilot CLI grammar is tool names (`shell`). How it reads `Bash(...)` is undocumented: ignored or treated as unknown. It is a pre-approval, so the safe failure is an extra prompt |
| Sync to consumers (`scripts/sync-to-repos.mjs`) | W | W | W | Host-neutral files. The gap is the `.mcp.json` omission |

## 4. Hooks on the Copilot harness, in detail

**What is documented.** The Copilot runtime reads `.claude/settings.json` and `.claude/settings.local.json`
([hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)).

- **Payload.** A PascalCase event name selects the snake_case payload (`hook_event_name`, `session_id`, `cwd`,
  `tool_name`, `tool_input`, `prompt`).
- **`PreToolUse` matchers.** These use Claude's semantics. `Bash` matches the runtime tools `bash` and `powershell`;
  `Edit` matches `edit`, `str_replace_editor` and `apply_patch`; `Write` matches `create`.
- **Outputs.**
  - The deny decision is a **top-level** `permissionDecision`.
  - `postToolUse` takes a **top-level** `additionalContext`.
  - `userPromptSubmitted` output is **dropped** for command hooks.

**What this repo's hooks emit** (`.claude/settings.json:40-101`, `4b778e70`).

| Hook | Emits | Copilot-harness consequence |
|---|---|---|
| `arch-memory-check.sh` | Plain text on stdout (`:15`) | Dropped. Cost incurred if it runs. It runs `"shell": "bash"` on a `.sh` path, so whether Copilot on Windows executes it is **unverified** |
| `legacy-surface-advisory.mjs` | Advisory on stdout | Dropped |
| `bash-grep-nudge.mjs` | Claude-shaped `hookSpecificOutput.permissionDecision: "deny"` (`:60-62`) | Whether the nested Claude shape is honoured is **unverified**. If it is, a leading `rg` in Copilot's shell is denied with a message about "the Grep tool". Copilot has a `grep` tool, so the advice is still roughly right, but the reason names Claude tool names |
| `quickfix-scan.mjs` | `{systemMessage}` (Claude), plus a `.audit/quickfix-hits.jsonl` record | `systemMessage` is not a documented Copilot output, so the nudge is likely invisible. The jsonl log only lands if the hook parses Copilot's `tool_input` field names (`file_path` vs the Copilot edit tool's own names: **unverified**) |
| `syntax-check.mjs` | `node --check` result | Same parsing question as `quickfix-scan.mjs` |

**Consequence.** The accelerator promise in `enforcement-mechanisms.md` still holds: a hook never enforces, and every rule
it accelerates has a portable path. The doc's *factual* sentence is wrong, though. Two hooks may spend money for nothing
on the default VS Code harness, and the three output-bearing hooks need dual-shape output to be useful there. The fix
belongs in the hooks themselves, parsing both payload shapes and emitting both output shapes. It is not a new
`.github/hooks/` surface, which would double-fire because "applicable hooks from multiple sources run together" (VS Code
hooks page).

## 5. `/fleet` in VS Code — today, with changes, impossible

**Today (no changes):**

- **The portable CLI works on every host.** That covers the registry, claim and refusal, the lease and `lease run`,
  directives, `next`, `ready`, `land`, `propose` and `archive-check` (`skills/fleet/SKILL.md:72-73`).
- **The manual recipe in `hosts.md:43-69` works.** Louis opens N sessions in the Agents window with New Worktree and
  pastes the prompts `fleet start` prints. Each session runs `claim`/`next`/`ready`.
- **Coordination is already through the registry, not host messages** (`SKILL.md`, "Coordinate through the registry"). A
  VS Code coordinator session reads `fleet status` and `next` exactly as a desktop one does.

**Desktop-only touchpoints** (each one has a VS Code mapping):

| Touchpoint | Where (`4b778e70`) | VS Code mapping |
|---|---|---|
| Spawn a chip | `skills/fleet/SKILL.md:94-95`; `references/coordination.md:96` (`spawn_task`) | Copilot and Claude harness "create an independent session with a new worktree" tool (doc). CLI: `claude --bg` (unverified as an agent workflow). Fallback: print the prompt and Louis starts the session |
| Title a session | `references/chip-preamble.md:14`; `participant-rules.md:68` (`set_session_title`) | No documented tool. Make the line conditional ("if your host exposes a title tool"), and keep the prefix in the first message, where the session list shows it |
| Session-list cross-check before removing a worktree | `SKILL.md:115-116`; `scripts/lib/fleet/archive.mjs:49`, `prune.mjs:67` (`SESSION_LIST_CHECK` string says "desktop session list") | The harness "inspect status" tool, or the Agents window list. The string must stop naming one host. The user-confirmation fallback in `hosts.md:65-67` stays |
| Archive sweep | `coordination.md:97` (rule 7) | The user's UI action (archive) on VS Code. No archive tool is documented. The coordinator lists candidates and Louis archives them |
| Message budget, model switch | `coordination.md:105-106` (rules 15, 16) | Follow-ups: the VS Code harness tool or `SendMessage` (Claude). Model at spawn: unverified on VS Code. Rule 16 degrades to "ask Louis to pick the model" |
| Handover between Claude accounts | `references/handover*.md`; `scripts/lib/fleet/handover-render.mjs:262` (`get_session`/`list_sessions`) | Claude-account-specific by nature, so out of scope. Mark it Claude Code only |

**With changes (the plan):** one `session-host` host-contract in `hosts.md`, in the same shape as the existing
`browser-driver` contract (`skills/click-test/references/browser-tool-detection.md:17`).

- **What the contract is.** It names roles (spawn, list, message, title, archive, session-list) and maps each role to a
  host's tools by description, never by a guessed tool name.
- **What it requires of the callers.** Every touchpoint in the table cites the role, not the desktop tool. The two
  `SESSION_LIST_CHECK` strings and the `fleet start` prompt become host-neutral.
- **What stays the same.** The registry remains the single authority, so a VS Code harness session and a desktop chip can
  share one fleet. The registry lives in `<git-common-dir>`, not in the host.

**Copilot cloud-agent PRs as chips:** possible as a documented route, not as a coded one.

- **What works.** A cloud PR is adopted with `fleet add #PR` and lands like any branch.
- **What it cannot do:**
  - It cannot hold a claim while it works, because the sandbox has no shared registry.
  - It cannot take the lease.
  - It cannot run `/audit-code` without secrets and a firewall allowlist, both Louis's decisions.
- **Where that leaves it.** The cloud agent fits small, low-risk, audit-later tasks. A `copilot-setup-steps.yml` that
  provisions keys is a new deploy-environment surface and stays Louis's decision.

**Headless workers from a VS Code terminal** work today, with costs and limits:

- **`claude -p`, or `claude --bg`.** The extension's bundled CLI is not on PATH, so these need a standalone install.
- **`copilot -p`.** Workers would `claim` like any chip.

Prefer `claude --bg` (worktree, listable) over hand-rolled `-p` loops. Building a spawner is the over-built option:
rejected.

**Impossible today:**

- Cross-vendor messaging between a Copilot session and a Claude Code session. The registry directive is the bridge, which
  is already the design.
- An agent-driven archive or title on VS Code.
- A coordinator approving another session's permission prompt. This is impossible by design on every host, and it is
  correct.

**Recommended design (right-sizing):**

- **Band-aid:** append a VS Code paragraph to `hosts.md` and leave the six touchpoints naming desktop tools. Every chip
  prompt keeps telling a VS Code session to call `set_session_title`, which does not exist there.
- **Over-built:** a fleet "host adapter" module that spawns sessions itself on each host, or adopting a third-party
  orchestrator.
- **Chosen:** a prose role contract plus host-neutral wording at the six touchpoints, and one smoke test per host that
  turns each "doc" cell into "obs". The current requirement it serves: Louis runs fleet from VS Code on the work machine.

## 6. What nobody has run (the smoke-test gap)

Every VS Code cell above is **doc** or **unverified**, and none is **obs**. `hosts.md:29-37` already demanded a per-host
smoke test, and none has been recorded. The plan's last cluster writes a runbook that Louis runs once per harness:

- skills listed from `.claude/skills`;
- `/name args` delivery;
- `.mcp.json` servers visible;
- each hook's real payload (captured to a scratch file);
- the agent-session tools: create with a worktree, list, message;
- the fleet two-session smoke from `hosts.md:73-75`.

It records the results into the `hosts.md` matrix. Until then, any change that depends on an unverified cell is written
to tolerate both outcomes.

## 7. Existing multi-session tools (survey, checked 2026-11-22)

**Method.** Figures were read from each live page on 2026-11-22. GitHub shows rounded stars. Nothing was installed.

| Candidate | URL | Stars / last commit | Licence | Does | Hosts | Health | Security |
|---|---|---|---|---|---|---|---|
| VS Code Agents window + session tools (built-in) | <https://code.visualstudio.com/docs/agents/run/tools> | docs 11/18/2026 | proprietary | Create, inspect and message sessions; New Worktree | Copilot, Claude, Codex harnesses | several parts preview or experimental | "a worktree … isn't a security boundary" (<https://code.visualstudio.com/docs/copilot/agents/overview>); orchestration rate limits on |
| Claude Code cross-session messaging (built-in) | <https://code.claude.com/docs/en/cross-session-messaging> | docs | proprietary | List and message; cannot start | CLI, `-p`, VS Code extension, desktop | GA | Peer messages cannot approve or change config |
| Claude Code agent view, `claude --bg` | <https://code.claude.com/docs/en/agent-view> | docs | proprietary | Start, list (`--json`), attach, stop; worktree per session | CLI (extension: unverified) | research preview | Refuses to remove a worktree with unpushed commits |
| Claude Code agent teams | <https://code.claude.com/docs/en/agent-teams> | docs | proprietary | Lead spawns teammates; task list with locking; mailbox | interactive CLI only | experimental | Teammates inherit bypass mode |
| CCManager | <https://github.com/kbwo/ccmanager> | 1.3k / 2026-10-27 | MIT | Terminal UI; worktree create, merge, delete; status hooks | Claude Code, Copilot CLI, Gemini, Codex, others | steady; 4 open issues | Optional Haiku-judged auto-approve |
| Claude Squad | <https://github.com/smtg-ai/claude-squad> | 8.8k / 2026-11-13 | **AGPL-3.0** | tmux + worktree per agent; push, no PR | Claude, Codex, Gemini, Aider (not Copilot) | weeks between commits | Needs tmux; `--autoyes` |
| Parallel Code | <https://github.com/johannesjo/parallel-code> | 1.1k / 2026-11-21 | MIT | Electron app; worktree per task; diff review; PR | Claude, Codex, Copilot, any terminal agent | very active | Windows via Git Bash only |
| Vibe Kanban | <https://github.com/BloopAI/vibe-kanban> | 28.8k / 2026-11-15 | Apache-2.0 | Kanban; branch per workspace; PR merge; MCP | many, including Copilot | **sunsetting**; company shut down April 2026 (<https://vibekanban.com/shutdown>) | PostHog (build-time key) |
| claude-flow → Ruflo | <https://github.com/ruvnet/ruflo> | 82.3k / 2026-11-22 | MIT | Swarm meta-harness; large MCP toolsets | Claude, Codex (not Copilot) | 289 issues, 269 open PRs | Large toolset surface |
| container-use (Dagger) | <https://github.com/dagger/container-use> | 4.1k / 2026-08-12 | Apache-2.0 | MCP: a container + branch per agent | any MCP client | early development | Needs Dagger; recent path-traversal fix (#365) |
| Maniple | <https://github.com/Martian-Engineering/maniple> | 48 / 2026-06-08 | MIT | MCP `spawn_workers`/`list_workers`/`message_workers`; worktrees | Claude, Codex | small | tmux/iTerm2 only (no native Windows) |
| claude-swarm | <https://github.com/cj-vana/claude-swarm> | 117 / 2026-02-11 | MIT | MCP; per-file lock files | Claude (WSL on Windows) | stalled | — |
| Agent Farm | <https://github.com/Dicklesworthstone/claude_code_agent_farm> | 925 / 2026-09-21 | MIT + rider | tmux panes; prompt-only coordination registry | Claude | single maintainer | **Requires `--dangerously-skip-permissions`** |
| uzi | <https://github.com/devflowinc/uzi> | 584 / 2025-06-04 | MIT | tmux + worktree; checkpoint merge | several | **dormant** | `uzi auto` presses Enter on every confirmation |
| Crystal (→ Nimbalyst) | <https://github.com/stravu/crystal> | 3.1k | MIT | Desktop parallel sessions | Claude, Codex | **deprecated Feb 2026** | — |
| sudocode | <https://github.com/sudocode-ai/sudocode> | 296 / 2026-03-18 | Apache-2.0 | Specs in git, kanban, MCP, temp worktree | Claude, Codex, Cursor | stalled | — |
| Agntree (VS Code ext.) | <https://marketplace.visualstudio.com/items?itemName=subhashkhileri.agntree> | 318 installs | MIT | Sidebar of sessions by worktree; start, resume, fork | Claude Code ≥2.1.310, Codex (not Copilot) | tiny | — |
| Deck (VS Code ext.) | <https://marketplace.visualstudio.com/items?itemName=a9a4k.deck> | 157 installs | MIT | Worktree tree; persistent tmux terminals | Claude, Codex status only | tiny | tmux 3.2+ |
| Conductor | <https://www.conductor.build/> | release 0.98.0 | unverified | Parallel workspaces, review, merge | Claude, Codex, Cursor; Mac only | closed source (unverified) | No privacy statement on the page |
| Roo Code Orchestrator | <https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks> | docs 2026-05-15 | Apache-2.0 (unverified) | **Sequential** subtasks | Roo only | reportedly pivoting to cloud (unverified) | Subtask creation needs approval |

**Not opened (unverified):** steipete/claude-code-mcp, danpasecinic/claude-orchestrator, missiond, and kargnas's
tmux-worktree extension.

**Against `/fleet`'s needs.** The needs are (1) path-glob claims, (2) a machine-wide heavy-job lease with a queue, (3) WIP
limits, (4) batched landing after approval, (5) host-neutrality, and (6) agent-driven start, list and message.

- **(1)–(4): no candidate covers any of them.**
  - Agent teams lock *tasks*, not paths, and advise "each teammate owns a different set of files".
  - Agent Farm's registry is prompt-only, which is the cooperative-by-prose model fleet already improves on.
  - Every lander merges one branch at a time.
- **(5):** only the VS Code Agents window (Copilot, Claude and Codex harnesses) and CCManager span Copilot and Claude.
- **(6):** the VS Code session tools, Claude `SendMessage`/`ListAgents`, Maniple and claude-swarm.

**Verdict: build nothing new, adopt nothing.** The two host-native layers already supply the start, list and message
primitives fleet lacked on VS Code. Fleet's registry stays the authority for claims, the lease and landing. Third-party
tools mostly assume tmux, which rules them out on the native-Windows work machine, and several are dormant, sunsetting,
AGPL, or require skip-permissions. CCManager is the one tool worth naming in `hosts.md` as an optional user-side
launcher. It is not a dependency.

## 8. Out of scope here (recorded, not planned)

- **`/harness-retro` on Copilot transcripts.** It needs a Copilot session-history source. That is a separate feature with
  its own privacy questions.
- **`copilot-setup-steps.yml` with audit keys.** It is a deploy-environment and secrets write, which is Louis's decision
  (`~/.claude/CLAUDE.md` standing rules).
- **Custom agents (`.github/agents/*.agent.md`).** No current requirement needs one. Skills cover the invocation surface,
  and an agent file would be a new surface.

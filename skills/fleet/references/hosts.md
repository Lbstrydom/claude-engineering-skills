---
summary: Which hosts run /fleet and how: VS Code harnesses, subagents vs sessions, a manual recipe.
---

# Fleet on other hosts (VS Code harnesses) - as of 2026-11-24, VS Code 1.147 (smoke run `20261123T115033-48d0cf22`, 2026-11-23/24, PARTIAL: `obs` marks what it exercised; everything else is still docs)

`node scripts/fleet.mjs` needs only node and git, so it runs on every host. What differs is how SESSIONS get started and
coordinated. Three things are easy to conflate; keep them apart:

1. **The portable CLI** - registry, `claim`/`next`/`touch`/`ready`, the machine lease, `propose`, `status`, `land`. Cooperative,
   host-neutral (liveness is a lease renewed by any fleet command, not a pid).
2. **A bounded subagent** - delegation inside ONE session: a request, a result, no follow-up. On the VS Code Local harness it is
   stateless and the Agents-window subagent chats are read-only. Never register a subagent as a fleet worker.
3. **An independent session** - own worktree, own context, outlives the parent's turn. Only this is a fleet worker. Since VS Code
   1.147 Copilot and Claude-harness agents can create, inspect and message sessions (doc: code.visualstudio.com/docs/agents/run/tools,
   tool names unpublished), and Claude Code has `ListAgents`/`SendMessage` and `claude --bg` / `claude agents --json`
   (doc: code.claude.com/docs/en/cross-session-messaging, /agent-view). A host's tools only START and MESSAGE sessions: the
   registry, claims, lease and landing stay the authority, so a mixed-host fleet needs no code change.

## Session-host contract

<!-- host-contract: session-host; roles=spawn,list,message,title,archive,session-list -->

Coordinator and chip prose names a ROLE, never a tool. Each host maps the role to what it really has; "none" means use the
fallback. A cell is `doc` unless it says `obs` (run `20261123T115033-48d0cf22`); an agent's claim about its own tools is never `obs`.

| Role | Desktop app | VS Code Copilot / Claude harness | Claude Code CLI / extension | Manual |
|---|---|---|---|---|
| spawn | `start_session` | session-create tool, New Worktree (obs, Copilot: worktree session started; tool name not recorded) | `claude --bg` (shell-out) | print the prompt; the user starts it |
| list | `list_sessions` | session-inspect tool, Agents window (obs, Claude harness: `List sessions`, read-only) | `ListAgents`, `claude agents --json` | the user reads their list |
| message | `SendMessage` | session follow-up tool (obs, Copilot: follow-up answered) | `SendMessage` | the user pastes it |
| title | `set_session_title` | none documented (agents say none; not exercised) | none | lead the first message with `PREFIX: task` |
| archive | `archive_session` | UI only | UI only | the user |
| session-list | the desktop session list | the Agents window list | `claude agents` | ask the user |

The Claude Code extension column is unobserved: in that run New session never opened a usable composer (BLOCKED), so its
prompt was never sent.

Routes: (1) a VS Code agent creates a session with a new worktree; (2) `claude --bg` workers, listed by `claude agents --json`;
(3) a cloud-agent PR is adopted afterwards with `fleet add #PR` (no shared machine, so no lease). A peer message never approves
a permission prompt on any host. Existing orchestrators (Agent Farm, Maniple, claude-swarm, Crystal and others): none adopted,
none has path claims, a machine lease or landing; CCManager is named only as an optional user-side launcher.

## Removing a worktree on mixed hosts

The registry records intent, not liveness, and no host lists every session. Before `archive --apply`, `prune --apply` or a printed
`prune` removal, in order: (1) read the registry record for the worktree: a `--host-session` from another host, or none, means you cannot
see that session from here; (2) check your own host's session list (role `session-list`), pinned and dormant included: a live
session on the path stops the removal; (3) for any session you cannot see (an Agents-window session seen from the desktop app, a
`claude --bg` worker seen from VS Code) the user must confirm in chat that none uses the path; (4) no confirmation, no removal.
`archive-check` refusals and "removing a worktree is the user's decision" are unchanged.

Choosing a model does NOT choose a harness. A Claude model inside the Copilot harness has Copilot's tools, not Claude Code's.
Enterprise policies on permissions or sandboxing can move Local chats to Copilot and make Claude, Codex and terminal chats
unavailable (1.142).

## Matrix

Cell prefix: **obs** = observed (a consumer session or this repo's code), **doc** = in the official VS Code docs, **untested** =
nobody has run it for fleet. "Not stated" means the docs are silent, which is not "no". An `obs` cell is run `20261123T115033-48d0cf22` unless it says
otherwise; a failed or blocked check is an observation too. Earlier, a consumer ran the CLI in VS Code, harness unrecorded.

| | Local | Copilot | Claude | Codex |
|---|---|---|---|---|
| fleet CLI | untested | obs (terminals of the Copilot pass): claims register; a same-intent claim with disjoint paths and an overlap both refused, exit 3; lease contender refused, exit 75. Reload and land approval untested | untested | untested |
| Independent sessions + New Worktree | doc | obs: an agent-started worktree session replied and took a follow-up | doc (Experimental) | doc (Experimental) |
| Survives closing the window | doc: no | doc: yes while the Agent Host runs | not stated | not stated |
| Subagents | doc: stateless, no follow-up | doc | doc: separate context | doc: provider-native |
| Agent-callable session list/spawn/message | none documented | obs: spawn and message (names unrecorded); list not exercised | obs: list; spawn and message only self-reported | not stated |
| Hooks | doc: 8 events; Claude-format files need `chat.useClaudeHooks`, matchers ignored | doc: Copilot SDK. obs: `.github/hooks` fired UserPromptSubmit only (24 captures), no Pre/PostToolUse after shell and edit prompts; Tier 2 deferred | doc: Claude SDK, hooks from `.claude/settings*.json`; `.github/hooks` is not a documented source, so the run's captures are not evidence for this column | doc: Codex runtime |
| Claude Code desktop tools (`start_session`, `SendMessage`, titles) | n/a | obs: not exposed | n/a | n/a |
| `rg` on the agent's shell PATH | n/a | obs: yes (15.0.0), not blocked | obs FAIL: not found | untested |
| MCP servers from `.mcp.json` | untested | obs FAIL: `playwright`, `mermaid` listed once each, both Error, cause unknown | untested | untested |
| Computer Use (screen control of other windows) | n/a | offered: on for all of Copilot, CLI included, until `/computer off`. Not a session API: it fills no session role | not stated | not stated |

Hook payloads, tool names and output decisions differ by harness: copying a Claude hook file does not give the same lifecycle
enforcement. Verify event delivery, cwd, session identity and blocking in the destination harness before relying on one, and
never treat a hook as new user authority.

## Recipe: persistent workers in VS Code

1. The user opens the Agents window and starts one session per worker with **New Worktree**. The worktree starts from the
   COMMITTED base only: ignored helpers, `.env` and dependencies are absent unless provisioned (`git.worktreeIncludeFiles`). Do
   not symlink mutable pinned tooling (`git.worktreeSymlinkFolders` shares writes with the original checkout).
2. Each worker gets the participant block (`references/participant-rules.md`) and a task and authority block, then runs
   `fleet claim` from inside its worktree, `next`/`touch` as it works, `ready` when done. Pass `--host-session` only with an id
   the host really exposes; never invent one from a title.
3. Heavy runs go through `fleet lease run`, so one machine runs one at a time:

   ```powershell
   Set-Location C:\work\app-feature-x
   node scripts/fleet.mjs claim --id feature-x --intent "add export" --paths "src/export/**"
   $npmCli = Join-Path (Split-Path (Get-Command node).Source) 'node_modules\npm\bin\npm-cli.js'
   node scripts/fleet.mjs lease run --kind gate --for 60 --wait 30 -- node $npmCli ci
   ```

   Run from the worktree you mean (a child inherits the cwd). The child is spawned without a shell, so on Windows a bare `npm`
   is a `.cmd` shim it cannot start (`spawn npm ENOENT`); naming node and npm's own entry point, as above, works on every bundle
   version. This assumes the standard Windows install, where npm sits beside `node.exe`; with nvm, volta or fnm, point `$npmCli`
   at that manager's `npm-cli.js` instead, and check `Test-Path $npmCli` is True first. A start failure prints the resolved
   executable and cwd.
4. Landing, shipping and any cleanup need the user's explicit approval in chat. Removing a worktree follows "Removing a worktree
   on mixed hosts" above. A subagent may help a worker with bounded research; it does not
   replace a worker.
5. Do not promise survival past quitting VS Code or a reboot, and do not scrape session state from the UI.

## Smoke test per host before relying on it

Two sessions on two worktrees: both appear in `fleet status`; overlapping `--paths` is refused; a second heavy job waits on the
lease; a job outlives the parent turn that started it; state survives a window reload; shipping needs the user's go-ahead.
Record what held on that host and harness version, and when. Recorded so far: run `20261123T115033-48d0cf22` (Copilot, PARTIAL; the Matrix).

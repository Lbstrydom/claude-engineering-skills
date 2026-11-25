# VS Code host smoke test — skills, MCP, hooks, sessions and fleet, per harness

**What it is**: the first real observation of how this repo behaves in each VS Code agent surface. Every VS Code cell in
[`vscode-compatibility-review-2026-11.md`](../research/vscode-compatibility-review-2026-11.md) is **doc** or **unverified**
until this runbook records it (the first run, `20261123T115033-48d0cf22` of 2026-11-23/24, PARTIAL, is in
[`hosts.md`](../../skills/fleet/references/hosts.md)). You run this once per harness, and it turns those cells into **obs** with a date and a version. It also
captures real hook payloads, which Cluster D of [`vscode-compatibility.md`](../plans/vscode-compatibility.md) needs before
it may map any Copilot tool-input field.

**When you need it**: before the hook oracle (plan Phase 4) maps Copilot's `tool_input` keys; before `hosts.md` marks a
VS Code cell **obs**; and again when VS Code or an extension moves a major version (the hooks are Preview).

**Who runs it**: Louis, by hand, in VS Code. It is not a chip's task. About 60-90 minutes for all harnesses; each
harness is independent, so skip one you cannot open and write `unavailable` (the work machine's enterprise policy can
disable the Claude harness, see review §2a, Policy).

**The four harnesses.**

| Label | What it is | Capture host name |
|---|---|---|
| H1 Copilot harness | VS Code 1.147+, Agents window, harness **Copilot** (the default) | `copilot` |
| H2 Claude harness | VS Code, harness **Anthropic Claude** (the Claude Agent SDK, built in) | `claude-harness` |
| H3 Claude Code extension | The Anthropic extension for VS Code | `claude-extension` |
| H4 Copilot cloud agent | Runs on GitHub, not on your machine (optional, §8) | n/a |

The old **Local** harness is removed in February 2027 and is not smoke-tested here.

## 0. Rules for the whole run

- **Nothing here is committed except the fixtures** you review in §6. Raw hook captures never enter the repo: they are
  written to a per-run folder under `$env:LOCALAPPDATA\ces-hook-capture\`, locked to you, SYSTEM and Administrators.
- **The run never touches a file it did not create.** Preflight (§1.3) refuses if the capture hook's config already
  exists. Cleanup (§7) removes only what the **run record** lists, then checks that each of those paths is gone.
- **Cleanup (§7) always runs**, even if you abandon the run half way. If you stop for any reason, jump straight to §7.
- **Stop and ask the coordinator** if a step would need a secret, a deploy setting or a GitHub setting. None of the steps
  here does.
- Every command is PowerShell. Run them from the repo root unless a step says otherwise. Keep ONE PowerShell window open
  for the whole run: the variables set in §1 (`$runId`, `$run`, `$record`) live in it.
- Blocks that guard something are wrapped in `. { ... }` and end in a red error when they refuse. **A red error means
  stop**: do not run the next block; read the message, and if you cannot fix it go to §7.

## 1. Before you start (once)

### 1.1 Use a clean checkout that contains this file

Open the checkout you will run in. It must be clean, so that the cleanup check in §7 can mean something.

```powershell
Set-Location C:\GIT\claude-engineering-skills
$repo = (git rev-parse --show-toplevel)
git status --porcelain
Test-Path docs\runbooks\vscode-host-smoke.md
```

The `git status` line must print nothing and the last line must print `True`. If the tree is not clean, use a fresh
worktree (`git worktree add C:\tmp\ces-smoke main`) and run everything from there.

### 1.2 Record the versions

```powershell
code --version
code --list-extensions --show-versions | Select-String -Pattern 'copilot|claude|anthropic'
node --version
Get-Command claude -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
```

Write down the VS Code version (the first line), the Copilot, Copilot Chat and Anthropic extension versions, and whether
`claude` resolves on PATH. The extension's bundled CLI is **not** on PATH, so an empty last line is normal and means
the `claude --bg` steps in H3 need a standalone install (review §2c).

### 1.3 Preflight, run folder, lockdown, scripts and hook (once)

**Step A: preflight. It refuses, it never overwrites.** These are your files if they exist, so the run stops.

```powershell
$base = Join-Path $env:LOCALAPPDATA 'ces-hook-capture'
$runId = (Get-Date -Format 'yyyyMMddTHHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$run = Join-Path $base $runId
$record = Join-Path $base ($runId + '.created.txt')
$hookConfig = '.github\hooks\payload-capture.json'
. {
  if (Test-Path -LiteralPath $hookConfig) { throw "REFUSED: $hookConfig already exists. It is not this run's file: do not overwrite or delete it. Ask the coordinator." }
  if (Test-Path -LiteralPath 'scratch') { throw 'REFUSED: scratch\ already exists in the repo. Move or rename it yourself, then start again.' }
  if (Test-Path -LiteralPath $run) { throw "REFUSED: $run already exists." }
  if (Test-Path -LiteralPath $record) { throw "REFUSED: $record already exists." }
  "preflight ok: run id $runId"
}
```

**Step B: the run record.** Every artifact the run creates is written here first, and cleanup removes only these.

```powershell
New-Item -ItemType Directory -Force -Path $base | Out-Null
$hookDirExisted = Test-Path -LiteralPath '.github\hooks'
$lines = @("tree|$run", "file|$hookConfig", 'tree|scratch', 'verify-clean|.mcp.json', 'verify-clean|.mcp.json.off')
if (-not $hookDirExisted) { $lines += 'emptydir|.github\hooks' }
Set-Content -LiteralPath $record -Value $lines
Get-Content -LiteralPath $record
```

You will add one line per extra artifact later. Never edit the record by hand to remove a line. A worktree goes in
through this helper only. Cleanup runs `git worktree remove --force` on every recorded worktree, so the helper records a
folder **only** if `git worktree list` names it now **and** it was not a worktree before the run started: the inventory
below is taken once, here, before any session exists. Your checkout and every worktree that already existed (another
session's included) are in it, so a typo or the wrong folder is refused, never recorded. If the window is lost, the
inventory is gone too and the helper refuses everything; record nothing more and go to §7.

```powershell
function Get-WorktreeFolders { @(git worktree list --porcelain | Where-Object { $_ -like 'worktree *' } | ForEach-Object { [IO.Path]::GetFullPath($_.Substring(9)) }) }
$worktreesBefore = Get-WorktreeFolders
"worktrees before the run: $($worktreesBefore.Count)"
function Add-RecordedWorktree {
  if ($null -eq $worktreesBefore -or $worktreesBefore.Count -eq 0) { throw 'REFUSED: no pre-run worktree inventory in this window. Nothing was recorded.' }
  $answer = Read-Host 'Paste the new worktree folder exactly as git worktree list printed it'
  if (-not $answer) { throw 'REFUSED: nothing pasted. Nothing was recorded.' }
  $full = [IO.Path]::GetFullPath($answer.Trim().Trim('"'))
  $match = @(Get-WorktreeFolders | Where-Object { $_ -eq $full })
  if ($match.Count -eq 0) { throw "REFUSED: $full is not a worktree git lists. Nothing was recorded." }
  $full = $match[0]
  if ($worktreesBefore -contains $full) { throw "REFUSED: $full existed before this run, so it is not this run's to remove. Nothing was recorded." }
  Add-Content -LiteralPath $record -Value "worktree|$full"
  "recorded worktree|$full"
}
```

**Step C: create the run folder and lock it to you.** Nothing else on the machine may read your prompts.

```powershell
$operatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
New-Item -ItemType Directory -Path $run | Out-Null
icacls $run /inheritance:r /grant:r "*${operatorSid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null

function Test-RunDirAcl {
  param([string]$Dir, [string]$OperatorSid)
  try {
    $acl = Get-Acl -LiteralPath $Dir
    if (-not $acl.AreAccessRulesProtected) { return $false }
    if (@($acl.Access).Count -eq 0) { return $false }
    $allowed = @($OperatorSid, 'S-1-5-18', 'S-1-5-32-544')
    foreach ($rule in $acl.Access) {
      $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
      if ($allowed -notcontains $sid) { return $false }
    }
    return $true
  } catch { return $false }
}
```

**Step D: prove the check can refuse, then run it for real.** The negative control grants `Users:(R)` (SID
`S-1-5-32-545`), requires the check to refuse, removes the grant, and requires the check to pass. If either does not
happen the run stops before any capture.

```powershell
$aclOk = $false
. {
  icacls $run /grant '*S-1-5-32-545:(R)' | Out-Null
  if (Test-RunDirAcl -Dir $run -OperatorSid $operatorSid) { throw 'STOP: the ACL check passed with Users:(R) granted, so it cannot be trusted. Go to section 7.' }
  icacls $run /remove '*S-1-5-32-545' | Out-Null
  if (-not (Test-RunDirAcl -Dir $run -OperatorSid $operatorSid)) { throw 'STOP: the run folder ACL is not restricted to you, SYSTEM and Administrators. Go to section 7.' }
  $aclOk = $true
  'acl ok: protected, and only the operator, S-1-5-18 and S-1-5-32-544 hold rules'
}
```

**Step E: install the two scripts and the hook.** The scripts are the fenced blocks marked `smoke-script` in §9. This
block extracts them from the file you are reading, so you never copy JavaScript by hand. It refuses unless step D passed.

```powershell
. {
  if (-not $aclOk) { throw 'STOP: step D did not pass.' }
  $md = Get-Content -Raw docs\runbooks\vscode-host-smoke.md
  $fence = ([string][char]96) * 3
  foreach ($name in 'capture.mjs', 'project.mjs') {
    $pattern = '<!-- smoke-script: ' + [regex]::Escape($name) + ' -->\r?\n' + [regex]::Escape($fence) + 'js\r?\n(.*?)\r?\n' + [regex]::Escape($fence)
    $found = [regex]::Match($md, $pattern, 'Singleline')
    if (-not $found.Success) { throw "script $name not found in the runbook" }
    $code = $found.Groups[1].Value -replace "`r`n", "`n"
    [IO.File]::WriteAllText((Join-Path $run $name), $code + "`n", [Text.UTF8Encoding]::new($false))
  }
  New-Item -ItemType Directory -Force -Path '.github\hooks' | Out-Null
  $command = 'node "' + (Join-Path $run 'capture.mjs') + '"'
  $entry = @(@{ matcher = ''; hooks = @(@{ type = 'command'; command = $command; timeout = 5 }) })
  $config = @{ hooks = @{ UserPromptSubmit = $entry; PreToolUse = $entry; PostToolUse = $entry } }
  $config | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 $hookConfig
  Set-Content -NoNewline -Path (Join-Path $run 'current-host.txt') -Value 'copilot'
  Get-ChildItem $run | Select-Object Name
  Get-Content $hookConfig
}
```

You should see `capture.mjs`, `project.mjs` and `current-host.txt`. The config is in `.github/hooks/`, which git does **not**
ignore, so a leftover shows in `git status`. That is deliberate: it cannot hide. The capture script never prints, never
blocks, and writes only under `$run`. Its capture word is `current-host.txt` (you change it at the start of each harness).

### 1.4 Quit VS Code completely, then relaunch with the arch-memory hook disabled

The repo's own `.claude/settings.json` hooks **also fire** under the Copilot harness. Without the variable below, each
prompt you send would pay for an embedding and a store call (`arch-memory-check.sh`) before the plan's skip exists.

1. Close every VS Code window.
2. Confirm nothing is left running (the Copilot Agent Host can outlive a closed window):

   ```powershell
   Get-Process | Where-Object { $_.ProcessName -like 'Code*' } | Select-Object ProcessName, Id
   ```

   It must print nothing. If it lists processes, quit them from Task Manager first; otherwise the next step reattaches to
   the old process and the variable below is **not** inherited.
3. Launch from this same PowerShell window:

   ```powershell
   $env:ARCH_MEMORY_HOOK_DISABLE = '1'
   code .
   ```

Record in your results that `ARCH_MEMORY_HOOK_DISABLE=1` was set. §6.1 verifies that the hooks really saw it.

## 2. Checks to run in each harness

Run this whole section once for each of H1, H2 and H3, in a **new chat session** in the harness. Before each, set the
capture host word (change it to `claude-harness` for H2, `claude-extension` for H3):

```powershell
Set-Content -NoNewline -Path (Join-Path $run 'current-host.txt') -Value 'copilot'
```

For each check, write down **what you saw**, not what you expected. Use these result words: `works`, `degraded` (say
what is lost), `broken`, `not present`, `unclear`. A wrong guess is as useful as a right one; an unrecorded one is not.

### 2.1 Skills are discovered from `.claude/skills`

1. In the chat input, type `/` and read the list. Look for `plan`, `explain`, `fleet`, `ship`, `audit-code`.
2. Record: which of those appear, and whether any name appears **twice** (a duplicate means two roots are read).

If none appear, record `not present` and carry on: the rest of §2 still runs by typing prompts in plain words.

### 2.2 `/name args` delivers the argument

1. Send `/explain scripts/lib/cli-io.mjs`.
2. Read only the agent's first reply. Stop the run with the Stop button once it has named its target.
3. Record: does the agent name `scripts/lib/cli-io.mjs` as the thing to explain (the argument arrived), or does it ask what
   to explain (it did not)?

### 2.3 `disable-model-invocation` is honoured

`/ship` and `/security-strategy` carry `disable-model-invocation: true`. This check never runs them.

1. Send: `List every skill you may start by yourself, without me typing its name. Is ship one of them? Is security-strategy?`
2. Record the agent's answer for both names.

### 2.4 `allowed-tools: Bash(...)` behaviour

`/plan` declares `allowed-tools: Bash(node scripts/cross-skill.mjs detect-stack)`.

1. Send: `/plan smoke test only: run your first command, then stop and write nothing`.
2. Record: did the agent run `node scripts/cross-skill.mjs detect-stack` **without** a permission prompt (the list is
   honoured), **with** a prompt (ignored), or not at all? Quote the prompt text if one appeared.

### 2.5 MCP servers: which file is read

This repo carries both `.mcp.json` (Claude/Copilot harness) and `.vscode/mcp.json` (Local harness). A consumer today has
only the second one. Check what the harness sees in each situation.

**A. As the repo is.** Open the command palette (Ctrl+Shift+P) and run `MCP: List Servers`. Record the server names
(expected: `playwright`, `mermaid`), their state, and whether a name appears **twice** (both files read, not de-duplicated).

**B. The consumer situation: only `.vscode/mcp.json`.** This simulates the file layout a consumer has today.

This block renames `.mcp.json` away, waits for you, and **always renames it back** (also if you press Ctrl+C):

```powershell
. {
  Rename-Item -LiteralPath .mcp.json -NewName .mcp.json.off
  try { Read-Host 'In VS Code: Developer: Reload Window, then MCP: List Servers. Note the servers. Press Enter here when done' }
  finally { Rename-Item -LiteralPath .mcp.json.off -NewName .mcp.json }
  git status --porcelain -- .mcp.json .mcp.json.off
}
```

Record whether `playwright` and `mermaid` were still listed (they are, if the harness forwards `.vscode/mcp.json`). The
`git status` line must print nothing. Reload the window once more so the harness is back to the real layout.

### 2.6 Hooks fire, and what they are shown

The capture hook from §1.3 is already armed. The repo's own hooks also run. Send these four prompts **one at a time**, each
in the same chat, and let each finish. Approve any permission prompt for the exact action described.

1. `Run exactly this shell command and show me its output: rg --version`
   The repo hook `bash-grep-nudge.mjs` tries to **deny** a leading `rg`. Record: was the command blocked? What message
   did you see, if any? Was it allowed? (This shows whether Claude's nested deny shape is honoured.)
2. `Create the file scratch/smoke-a.mjs with exactly one line: export const x = 1;`
3. `In scratch/smoke-a.mjs change 1 to 2.`
4. `Create scratch/smoke-b.mjs containing the text: try { x() } catch {}`
   The repo hook `quickfix-scan.mjs` is meant to flag this shape. Record whether any hook message reached the chat.

For prompts 2-4 also record **which tool the agent used** (the chat usually shows the tool name: `create`, `edit`,
`str_replace_editor`, `apply_patch` or another). Tool names for Copilot are unpublished, so the exact word matters.

Now count what the capture hook caught (it does not print anything into VS Code itself):

```powershell
Get-ChildItem (Join-Path $run (Get-Content (Join-Path $run 'current-host.txt'))) -Filter *.json |
  Where-Object { $_.Name -notlike '*.meta.json' } | Measure-Object | Select-Object -ExpandProperty Count
```

Also count anything the hook could not parse as JSON; it is evidence, not noise:

```powershell
(Get-ChildItem (Join-Path $run (Get-Content (Join-Path $run 'current-host.txt'))) -Filter *.txt | Measure-Object).Count
```

A count of zero in the first command after four prompts means this harness did not run the capture hook. Record `hooks: no capture` and carry
on; that is a finding (it also means `.github/hooks` is not read there). Then check whether the repo's own
`.claude/settings.json` hooks left a trace: `Get-Content .audit\quickfix-hits.jsonl -ErrorAction SilentlyContinue`.
Record whether a new line mentioning `smoke-b.mjs` exists (that proves the quick-fix hook parsed that harness's payload).

The `scratch` folder is in the run record, so §7 removes it. Leave it until then.

### 2.7 Agent sessions: create with a worktree, list, message

Send this to the agent (H1 and H2 use the VS Code session tools; for H3 see the second block):

```text
Start a new independent session in a new worktree. Its task is: reply with the word pong and stop.
Then list your sessions and tell me the new one's status.
Then send that session the follow-up: say ping again.
Finally tell me the EXACT name of the tool you used for each of the three actions (start, list, message).
```

Record: for each of start, list and message, `worked` or `no tool`, and the exact tool name given. Note whether the
new session shows in the Agents window with a worktree, and whether a rate-limit message appeared
(`chat.agentHost.agentOrchestrationLimits`). **Record the worktree the moment it exists**, before you carry on with the other checks, so an interrupted run still
cleans it up: run the two lines below and paste the new worktree's folder when asked (a red `REFUSED` records nothing;
run `Add-RecordedWorktree` again with the right folder). Then, when you finish, archive the new session in the Agents
window:

```powershell
git worktree list
Add-RecordedWorktree
```

Record **only** worktrees the agent created in this check.

**H3 only** (the Claude Code extension; `ListAgents` and `SendMessage` need Claude Code v2.1.224, v2.1.234 on native
Windows). Send: `Use ListAgents to list my sessions, then tell me what you saw. Then try to start one with claude --bg "reply pong".`
Record what `ListAgents` returned, whether `claude` was found, and whether a `--bg` session was created. If you ran
`claude --bg`, stop it afterwards with `claude agents` (it lists them; stop the one you made).

### 2.8 Titles

Record whether the agent exposes a way to **title** or **archive** a session (ask: `Can you rename or archive this
session yourself? Name the tool.`). The answer decides how `fleet` chips are told to set a title on VS Code.

## 3. Repeat for the other harnesses

At the start of H2 and H3 clear the files the previous harness made (`Remove-Item -LiteralPath scratch -Recurse -Force -ErrorAction SilentlyContinue`; it is a recorded path, so this is safe), switch the capture word (§2, first block) and open a new chat in that harness. Run §2.1 to §2.8
again. Do not close VS Code between harnesses (the env variable from §1.4 must stay in force).

## 4. Fleet smoke test (hosts.md two-session test)

Once, in the harness you will actually use for fleet (note which). This is the test from `hosts.md` ("Smoke test per host
before relying on it"). You need two sessions on two worktrees: start two sessions in the Agents window with **New Worktree**
(call them A and B), and open a terminal in each. Run the commands in each session's own worktree.

In A:

```powershell
node scripts/fleet.mjs claim --id smoke-a --intent "smoke test A" --paths "scratch/a/claim.txt"
```

In B:

```powershell
node scripts/fleet.mjs claim --id smoke-b --intent "smoke test B" --paths "scratch/b/claim.txt"
node scripts/fleet.mjs status
```

The intents must differ and the paths are literal files, not globs. Fleet refuses a claim whose intent equals a live
claim's (exit 3) even when the paths are disjoint, by design (an identical intent is a second session for the same work), so
two `smoke test` claims make B fail for the wrong reason; the refusal says `identical intent to live session smoke-a`. A literal
path names exactly one file, so the overlap check below compares two named files rather than two patterns.

Record: both `smoke-a` and `smoke-b` appear in `status`. (A warning that the claim id is not the branch name is
expected.) Now the overlap refusal, in B:

```powershell
node scripts/fleet.mjs claim --id smoke-c --intent "overlap" --paths "scratch/a/claim.txt"
$LASTEXITCODE
```

Record: the claim is **refused** with exit `3`, naming the other session.

The heavy-slot lease (minutes; if the lease reports peak hours, run it outside 14:00-20:00 on a weekday):

```powershell
node scripts/fleet.mjs lease run --kind gate --for 5 --wait 0 --timeout 4 -- node -e 'setTimeout(function(){}, 180000)'
```

Start that in A first, then in B within a minute:

```powershell
node scripts/fleet.mjs lease run --kind gate --for 5 --wait 1 --timeout 4 -- node -e 'setTimeout(function(){}, 1000)'
node scripts/fleet.mjs lease status
```

Record: B **waited and then gave up** (or queued) while A held the slot, and `lease status` names the holder.

Last three checks, in A, with the agent:

1. **A job outlives the turn.** Ask A's agent to start the 180-second `lease run` above in a background terminal and then
   end its turn. While no turn is active, run `node scripts/fleet.mjs lease status` from B. Record whether the holder is
   still A.
2. **State survives a reload.** Run `Developer: Reload Window`, then `node scripts/fleet.mjs status`. Record whether both
   claims are still listed.
3. **Shipping needs your go-ahead.** Tell A's agent: `Land this branch now.` Record that it **asks you** (and does not run
   `node scripts/fleet.mjs land` by itself).

Release when done (each in its own worktree; §7 releases any you forget):

```powershell
node scripts/fleet.mjs release --id smoke-a --abandoned
node scripts/fleet.mjs release --id smoke-b --abandoned
```

Then archive sessions A and B in the Agents window. §7 removes their worktrees and releases the claims, but only if you
recorded them **as you created them**. Record in your **original** PowerShell window (the one from §1, which holds
`$record`, the pre-run inventory and `Add-RecordedWorktree`), never in A's or B's terminal, where none of them exist: right
after starting each session run `Add-RecordedWorktree` (§1.3 step B) there and paste that session's worktree folder, and
right after each `claim` above record the id that session made:

```powershell
Add-RecordedWorktree
Add-Content -LiteralPath $record -Value 'fleet-claim|smoke-a'
```

(`smoke-b` in B.) Record only the two sessions you started for this check.

## 5. Can the Copilot harness run the repo's `.sh` hook on Windows?

One more observation, free, while the capture runs. In H1, the repo's `arch-memory-check.sh` is configured with
`"shell": "bash"`. Whether Copilot on Windows *can* execute a `.sh` hook is unverified. Look
in the VS Code Output panel for the channel named for hooks (`Output: Focus on Output View`, then choose the Copilot or
hooks channel) and record any error mentioning `arch-memory-check.sh`, or `none seen`.

## 6. Turn the captures into fixtures

Raw captures contain your prompts and your paths. They are never committed. A fixture is made **only** by `project.mjs`,
a fail-closed projection driven by a **versioned allowlist**,
[`tests/fixtures/hook-payloads/allowlist.json`](../../tests/fixtures/hook-payloads/allowlist.json)
(`{version, tools: [names], events: {event: {key path: synthetic value}}}`). What it does, so you can review it:

- It walks the whole payload and lists every key path (`tool_input.command`, `tool_input.edits[].old_string`, ...).
- **A key path that is not on the allowlist for that event REFUSES the whole payload**: exit 2, no fixture. It prints the
  unknown **paths** to stderr, never their values. Nothing is dropped silently, so an unpublished field (exactly the
  evidence Tier 2 needs) cannot be lost, and a fixture's key set always equals the recording's key set.
- No original string survives, except `hook_event_name` and `tool_name`, which are checked against a closed list. Every
  other value is replaced by the synthetic value its key path has in the allowlist (a path becomes `src/fixture.mjs`, a
  prompt `fix the fixture bug`, a command `rg fixturePattern src`, edited text `try { x() } catch {}`, the timestamp
  `2026-01-01T00:00:00.000Z`, the session id `fixture-session`).
- It also refuses on an unsupported event, a tool name that is not in the allowlist's `tools` list, a synthetic value of
  the wrong type, or an allowlist it cannot read. An event or tool name that is not on a closed list is never printed.

### 6.1 Check the hooks really saw the disable flag

```powershell
Get-ChildItem $run -Recurse -Filter *.meta.json |
  ForEach-Object { (Get-Content -Raw $_.FullName | ConvertFrom-Json).archMemoryHookDisable } |
  Group-Object | Select-Object Name, Count
```

Every row must be `1`. A row showing nothing or `null` means a hook child did **not** inherit the variable and the repo's
arch-memory hook may have paid for a query during that prompt: write that in your results and do not hide it.

### 6.2 Project each host's captures

Run once per host folder that holds captures (`copilot`, `claude-harness`, `claude-extension`). Change `$hostName` each time.

```powershell
$hostName = 'copilot'
$root = 'tests\fixtures\hook-payloads'
$raw = Get-ChildItem (Join-Path $run $hostName) -Filter *.json | Where-Object { $_.Name -notlike '*.meta.json' }
$refused = 0
$notJson = @(Get-ChildItem (Join-Path $run $hostName) -Filter *.txt -ErrorAction SilentlyContinue).Count
if ($notJson) { Write-Host "$notJson capture(s) were not valid JSON (kept as .txt in the run folder, not projectable): report the count" -ForegroundColor Yellow }
foreach ($file in $raw) {
  node (Join-Path $run 'project.mjs') --host $hostName --root $root --in $file.FullName
  if ($LASTEXITCODE -ne 0) { $refused++ }
}
"projected: $(@($raw).Count - $refused) refused: $refused"
```

The script prints the fixture path it wrote, one line per payload. A fixture is named after the event and tool, for
example `pretooluse.bash.json`. A second payload for the same event and tool with a **different** shape is kept as
`pretooluse.bash-v2.json` (and so on); an **identical** one is skipped with a message. Nothing is overwritten or lost.

### 6.3 A refusal is the expected first result: approve the paths, then re-project

The first projection of a tool event **will refuse**: the allowlist ships with the documented envelope fields only, and
nobody has published Copilot's `tool_input` keys. stderr then lists lines like `unknown key path: tool_input.command`.

1. Read the printed **paths** privately. They hold no values, but a path is built from the payload's own key names, which
   come from the vendor's tool schema. **If any key name looks like your data (a customer name, an id), do not approve it
   and do not paste it anywhere**; tell the coordinator privately. Decide, path by path, whether it is safe to keep.
2. Open `tests\fixtures\hook-payloads\allowlist.json`. Under **each event** where the path appeared (`PreToolUse`,
   `PostToolUse`), add `"path": "synthetic value"`. The refusal prints a suggested synthetic value beside each path; use
   it or your own. **Then raise `version` by one.** The two edits are one step: a path added without a version bump is
   not an approval. The synthetic value must have the same JSON type as the recorded value (string for a string, a number
   for a number, `[]` for an empty array, `{}` for an empty object): a wrong type is refused with `type mismatch at:`. A
   tool name the script refuses (`tool_name ... is not in the allowlist tools`) is approved the same way: add it to the
   `tools` list in the allowlist and raise `version`.
3. Re-run §6.2 on the same raw captures. Repeat until the refusals stop or you decide a path must not be kept.
4. A path you do not approve means **no fixture for that event**. Leave it refused, write the path in your results, and
   the raw capture is deleted at cleanup.

### 6.4 Review before anything is committed

```powershell
git status --short tests/fixtures/hook-payloads
Get-ChildItem tests\fixtures\hook-payloads -Recurse -File | ForEach-Object { "--- $($_.FullName)"; Get-Content $_.FullName }
Get-ChildItem tests\fixtures\hook-payloads -Recurse -File |
  Select-String -Pattern '[A-Za-z]:[\\/]', 'Users[\\/]', 'AppData', '/home/', $env:USERNAME
```

Read every fixture and the allowlist diff. The last command must print **nothing**; any line it prints is a leak, so
delete that fixture and tell the coordinator.

### 6.5 Where the fixtures land (Cluster D reads them from here)

```text
tests/fixtures/hook-payloads/allowlist.json
tests/fixtures/hook-payloads/copilot/
tests/fixtures/hook-payloads/claude-harness/
tests/fixtures/hook-payloads/claude-extension/
```

Cluster D's Tier 2 (the quick-fix, syntax and grep hooks reading Copilot's tool input) needs, under `copilot/`:
`pretooluse.bash.json` or `pretooluse.powershell.json` (the shell command), `posttooluse.edit.json` or
`posttooluse.str_replace_editor.json` (an edit), `posttooluse.create.json` (a write) and `userpromptsubmit.json`. If those
are missing when Cluster D starts, it ships Tier 1 only and reports "Tier 2 deferred: no recorded fixtures". Commit only
after §7 passes, and only these paths by name:

```powershell
git switch -c vscode-hook-fixtures
git add tests/fixtures/hook-payloads
git commit -m "test: recorded VS Code hook payload fixtures (projected, synthetic values)"
git push -u origin vscode-hook-fixtures
```

Do not push to `main`. Tell the CES coordinator the branch name; it lands the PR.

## 7. Cleanup — always run this, even if a step failed

It removes **only what the run record lists** (`$runId.created.txt`), then checks every one of those paths. It leaves any
other file under `.github/hooks/` or `ces-hook-capture\` alone. If you lost the window, set `$runId` to the run folder
name (list them with `Get-ChildItem $env:LOCALAPPDATA\ces-hook-capture`) and run `Set-Location` to the repo root first.

Archive any agent sessions and the fleet sessions in the Agents window first, so their worktrees are not in use. Fleet
claims you recorded (`fleet-claim|id`) are released by this block too.

```powershell
$base = Join-Path $env:LOCALAPPDATA 'ces-hook-capture'
. {
  if (-not $runId) { Get-ChildItem $base -Filter *.created.txt | Select-Object Name; throw 'Set $runId to a run folder name above (without .created.txt), then run this block again.' }
  $record = Join-Path $base ($runId + '.created.txt')
  if (-not (Test-Path -LiteralPath $record)) { throw "no run record at $record" }
  $failed = @()
  $repoPaths = @()
  $lines = @(Get-Content -LiteralPath $record)
  # fleet claims first, so a claim is released before its worktree is removed
  foreach ($line in (@($lines | Where-Object { $_ -like 'fleet-claim|*' }) + @($lines | Where-Object { $_ -notlike 'fleet-claim|*' }))) {
    $kind, $target = $line -split '\|', 2
    if (-not $target) { continue }
    if (($kind -in 'file', 'tree') -and -not [IO.Path]::IsPathRooted($target)) { $repoPaths += $target }
    switch ($kind) {
      'file' { Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue; if (Test-Path -LiteralPath $target) { $failed += $target } }
      'tree' { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue; if (Test-Path -LiteralPath $target) { $failed += $target } }
      'fleet-claim' {
        node scripts/fleet.mjs release --id $target --abandoned 2>$null | Out-Null
        if ((node scripts/fleet.mjs status 2>&1 | Out-String) -match [regex]::Escape($target)) { $failed += "fleet claim $target" }
      }
      'worktree' { git worktree remove --force $target 2>$null; if (Test-Path -LiteralPath $target) { $failed += $target } }
      'emptydir' {
        if ((Test-Path -LiteralPath $target) -and -not (Get-ChildItem -LiteralPath $target -Force)) { Remove-Item -LiteralPath $target -Force }
        if ((Test-Path -LiteralPath $target) -and -not (Get-ChildItem -LiteralPath $target -Force)) { $failed += $target }
      }
      'verify-clean' { if (git status --porcelain -- $target) { $failed += $target } }
    }
  }
  if ($repoPaths) {
    $status = git status --porcelain --ignored -- @($repoPaths)
    if ($status) { $failed += $status }
  }
  if ($failed) { Write-Host 'CLEANUP FAILED for (the run record is KEPT so you can retry):' -ForegroundColor Red; $failed; throw 'cleanup failed: fix each item above, then run this block again. The record is still there.' }
  # only now, with every recorded artifact verified gone, remove the record itself
  Remove-Item -LiteralPath $record -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $record) { throw "cleanup failed: could not remove the record $record" }
  Remove-Item Env:ARCH_MEMORY_HOOK_DISABLE -ErrorAction SilentlyContinue
  'cleanup ok: every recorded path is gone, the record is removed, and git status shows nothing for the recorded repo paths'
}
```

The run record is **kept while any check fails**, so cleanup can always be retried, and is removed only after every recorded
artifact is verified gone. It checks, for every recorded path and for the record itself, that `Test-Path` is `False`; and
`git status --porcelain --ignored --` over only the recorded repo paths must print nothing. **If it prints
`CLEANUP FAILED`, or the block ends in a red error, cleanup failed: stop here, fix each listed item by hand, and run this
section again before you paste anything back.** Fixtures you generated in §6 are not in the record and are not touched.

Then confirm the worktrees you made are gone, and finish:

```powershell
git worktree list
```

Finally quit and relaunch VS Code normally, so the next session is not running with the disable flag.

## 8. Copilot cloud agent (H4) — optional, skip by default

It runs on GitHub and cannot be smoke-tested on your machine. It needs a GitHub write (an issue or task), and may use
premium requests, so it is your call, not the coordinator's. If you want one data point, assign it a one-line task
(for example "list the skills you can see") from a throwaway issue on a **non-production** repo, and paste back what it
reports about skill discovery. Do not add secrets or change the repo's Copilot environment for this. Write `skipped` if you
do not run it.

## 9. The two scripts

`capture.mjs` is the diagnostic hook: it stores each raw payload under the run folder it lives in (outside the repo) and
never blocks. `project.mjs` is the fail-closed projection. Both are extracted by §1.3 step E from the fences below (the
marker comment on the line before each fence is what the extraction matches, so do not edit it). Their own tests are in
[`tests/vscode-host-smoke-scripts.test.mjs`](../../tests/vscode-host-smoke-scripts.test.mjs), which extracts the same fences.

<!-- smoke-script: capture.mjs -->
```js
// capture.mjs - diagnostic hook. Stores the raw hook payload in the run folder it lives in, OUTSIDE the repo.
// Never prints, never blocks (exit 0). CES_CAPTURE_DIR overrides the folder (tests only) and must be absolute.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.env.CES_CAPTURE_DIR || dirname(fileURLToPath(import.meta.url));
if (!isAbsolute(base)) {
  process.stderr.write('[capture] capture dir is not absolute; nothing written\n');
  process.exit(0);
}
try {
  let host = 'unknown';
  try {
    const word = readFileSync(join(base, 'current-host.txt'), 'utf8').trim();
    if (/^[a-z-]{1,30}$/.test(word)) host = word;
  } catch { /* keep unknown */ }
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { /* empty stdin */ }
  const dir = join(base, host);
  mkdirSync(dir, { recursive: true });
  const stem = Date.now() + '-' + process.pid;
  let ext = '.json';
  try { JSON.parse(raw); } catch { ext = '.txt'; }
  writeFileSync(join(dir, stem + ext), raw);
  writeFileSync(join(dir, stem + '.meta.json'), JSON.stringify({
    archMemoryHookDisable: process.env.ARCH_MEMORY_HOOK_DISABLE ?? null,
    host,
    cwd: process.cwd(),
  }) + '\n');
} catch (err) {
  process.stderr.write('[capture] ' + String(err && err.message) + '\n');
}
process.exit(0);
```

<!-- smoke-script: project.mjs -->
```js
// project.mjs - fail-closed, allowlist-driven projection of ONE raw hook payload into a committable fixture.
// usage: node project.mjs --host copilot|claude-harness|claude-extension --root tests/fixtures/hook-payloads --in raw.json
//        [--allowlist file] [--name slug]      (allowlist defaults to ROOT/allowlist.json)
// Exit 0 = wrote (or skipped an identical) fixture. Exit 2 = refused, nothing written.
// stderr carries key PATHS and type names only, never values, and never an event or tool name outside the closed lists.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'userPromptSubmitted', 'preToolUse', 'postToolUse'];
const HOSTS = ['copilot', 'claude-harness', 'claude-extension'];
const KEY_SHAPE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
// Suggestions are computed from the key NAME only, never from a value.
const SUGGEST = [
  [/(^|\.)(file_?path|path|file|file_?name|target_?file)$/i, 'src/fixture.mjs'],
  [/(^|\.)(command|cmd|script|shell_?command)$/i, 'rg fixturePattern src'],
  [/(^|\.)(old_?str(ing)?|old_?text)$/i, 'fixture old text'],
  [/(^|\.)(new_?str(ing)?|content|file_?text|text|insert_?text|code|patch|input)$/i, 'try { x() } catch {}'],
  [/(^|\.)prompt$/i, 'fix the fixture bug'],
];
const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
// A payload-derived name is shown only when it is on a closed list; otherwise it is never echoed.
const shown = (v, list) => (list.includes(v) ? JSON.stringify(v) : '(not on the closed list; not shown)');

function refuse(why, lines = []) {
  for (const l of lines) process.stderr.write(l + '\n');
  process.stderr.write('[project] refused: ' + why + '\n');
  process.exit(2);
}

const args = process.argv.slice(2);
const opt = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const host = opt('--host');
const root = opt('--root');
const input = opt('--in');
let name = opt('--name');
if (!HOSTS.includes(host)) refuse('--host must be one of ' + HOSTS.join(', '));
if (!root || !input) refuse('--root and --in are required');
if (name !== undefined && !/^[a-z0-9][a-z0-9.-]{0,60}$/.test(name)) refuse('--name must match [a-z0-9][a-z0-9.-]*');

let allow;
const allowFile = opt('--allowlist') || join(root, 'allowlist.json');
try { allow = JSON.parse(readFileSync(allowFile, 'utf8')); } catch { refuse('cannot read the allowlist ' + allowFile); }
if (!allow || !Number.isInteger(allow.version) || allow.version < 1 || typeof allow.events !== 'object' || allow.events === null
  || !Array.isArray(allow.tools) || !allow.tools.every((t) => typeof t === 'string')) {
  refuse('allowlist must be {"version": integer >= 1, "tools": [names], "events": {...}}');
}

let payload;
try { payload = JSON.parse(readFileSync(input, 'utf8')); } catch { refuse('input is not valid JSON'); }
if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) refuse('payload is not an object');
const event = payload.hook_event_name;
if (!EVENTS.includes(event)) refuse('unsupported event ' + shown(event, EVENTS));
const spec = Object.hasOwn(allow.events, event) ? allow.events[event] : null;
if (!spec || typeof spec !== 'object') refuse('event ' + event + ' is not in the allowlist');
const isTool = /tooluse/i.test(event);
const toolOk = allow.tools.includes(payload.tool_name);
const toolHint = 'add the tool name to "tools" in the allowlist and raise its version';
if (isTool && !toolOk) refuse('tool_name ' + shown(payload.tool_name, allow.tools) + ' is not in the allowlist tools; ' + toolHint);
if (!isTool && payload.tool_name !== undefined && !toolOk) refuse('tool_name is not in the allowlist tools; ' + toolHint);

const unknown = [];
const mismatched = [];
function leaf(path, value) {
  if (!Object.hasOwn(spec, path)) { unknown.push(path); return undefined; }
  if (kind(spec[path]) !== kind(value)) { mismatched.push(path + '   (recorded type: ' + kind(value) + ', allowlist type: ' + kind(spec[path]) + ')'); return undefined; }
  return spec[path];
}
function project(value, path) {
  if (Array.isArray(value)) {
    if (value.length === 0) return leaf(path, value);
    return value.map((v) => project(v, path + '[]'));
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return leaf(path, value);
    const out = Object.create(null);
    for (const key of keys) {
      if (!KEY_SHAPE.test(key)) { unknown.push((path ? path + '.' : '') + '(unsafe-key)'); continue; }
      out[key] = project(value[key], path ? path + '.' + key : key);
    }
    return out;
  }
  return leaf(path, value);
}

const out = Object.create(null);
for (const key of Object.keys(payload)) {
  if (key === 'hook_event_name' || key === 'tool_name') { out[key] = payload[key]; continue; } // validated above
  if (!KEY_SHAPE.test(key)) { unknown.push('(unsafe-key)'); continue; }
  out[key] = project(payload[key], key);
}
if (unknown.length || mismatched.length) {
  const paths = [...new Set(unknown)];
  const lines = paths.map((p) => 'unknown key path: ' + p + (SUGGEST.find(([re]) => re.test(p)) ? '   (suggested value: ' + JSON.stringify(SUGGEST.find(([re]) => re.test(p))[1]) + ')' : ''))
    .concat([...new Set(mismatched)].map((m) => 'type mismatch at: ' + m));
  refuse(paths.length + ' key path(s) are not on the allowlist for ' + event + ' and ' + new Set(mismatched).size +
    ' have a synthetic value of the wrong type; fix the allowlist (add or correct the path, raise its version), then run again', lines);
}

const base = name === undefined ? (event + (payload.tool_name ? '.' + payload.tool_name : '')).toLowerCase().replace(/[^a-z0-9.]+/g, '-') : name;
const body = JSON.stringify(out, null, 2) + '\n';
const dir = join(root, host);
let candidate = base;
let variant = 1;
while (name === undefined && existsSync(join(dir, candidate + '.json'))) {
  if (readFileSync(join(dir, candidate + '.json'), 'utf8') === body) { process.stdout.write('identical to ' + candidate + '.json, skipped\n'); process.exit(0); }
  variant++;
  candidate = base + '-v' + variant; // a different shape for the same event and tool is kept, never dropped
}
mkdirSync(dir, { recursive: true });
const file = join(dir, candidate + '.json');
writeFileSync(file, body);
process.stdout.write('wrote ' + file + ' (allowlist version ' + allow.version + (variant > 1 ? '; variant ' + variant + ' of this event and tool' : '') + ')\n');
```

## 10. What to paste back

Paste this table, filled in, into the chat with the CES coordinator. One block per harness; use the result words from §2
and quote the exact tool names and message text you saw. Nothing in it should contain a prompt of yours, a path to your
home folder, or a secret. The unknown key **paths** that `project.mjs` printed hold no values and are normally safe to paste, unless a key name looks
like your own data, in which case leave it out and tell the coordinator privately.

```text
Run date / run id:
VS Code version:            Copilot / Copilot Chat / Anthropic extension versions:
ARCH_MEMORY_HOOK_DISABLE=1 set before launch: yes/no     §6.1 result (all rows 1?):
Preflight (§1.3 A) passed: yes/no     ACL check and its Users:(R) negative control passed: yes/no
Machine (home or work):     Enterprise policy limiting harnesses: yes/no/unknown

Harness: H1 Copilot / H2 Claude harness / H3 Claude extension (or unavailable)
2.1 skills listed from .claude/skills:            (which names; any duplicates)
2.2 /name args delivered:
2.3 disable-model-invocation honoured (ship, security-strategy):
2.4 allowed-tools Bash(...) behaviour:
2.5A MCP servers as the repo is:                  (names; duplicates)
2.5B MCP servers with only .vscode/mcp.json:      (still listed?)
2.6 hooks: capture count; rg command blocked? message text; quick-fix message seen? quickfix-hits line?
2.6 tool names used for create / edit:
2.7 session tools: start / list / message          (worked or no tool; exact tool names; rate-limit message?)
2.8 title / archive tool:
5   hook runner errors for arch-memory-check.sh:

Fleet (§4) harness used:
  both claims in status / overlap refused exit 3 / second heavy job waited / job outlived turn /
  state survived reload / shipping asked for go-ahead:
Unknown key paths printed by project.mjs (§6.3), and which you approved (allowlist version after):
Fixtures written (the file list from §6.5) and the §6.4 leak scan result:
Cleanup (§7): printed "cleanup ok"? (or the CLEANUP FAILED list)
Anything that surprised you:
```

**What happens next.** Cluster D reads the fixtures to decide whether the Copilot tool-input fields can be mapped
(Tier 2) or stay deferred. Cluster E, or the coordinator, records your table into the `skills/fleet/references/hosts.md`
matrix, turning each cell from **doc** or **unverified** into **obs**, stamped with the harness version and the run date.
A cell you could not run stays as it is, and is never promoted without your observation.

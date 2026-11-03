---
summary: Worktree preflight remedy — the skills:hydrate npm script to add when a linked worktree lacks the tooling tree.
---

# Worktree preflight — the hydrate remedy

The SKILL.md marker says: in a linked git worktree `scripts/.claude-skills/` is
absent (it is gitignored, so `git worktree add` does not populate it), and every
command that uses it dies on a bare `MODULE_NOT_FOUND`. The fix is the
`skills:hydrate` npm script, which copies the tooling tree in from the main checkout.

This is the canonical copy. Consuming skills carry a
`references/worktree-preflight.md` synced by
`node scripts/sync-shared-audit-refs.mjs` and drift-checked in `npm run check`.
**Edit this file, never a copy.**

## When the repo has no `skills:hydrate` script

It has not adopted the remedy yet. Ask the user before changing their
`package.json`; with their go-ahead, add this entry to its `scripts` and run it — it copies the tooling tree in from the main checkout, and
leans on nothing but node and git:


```json
"skills:hydrate": "node -e \"const{execFileSync}=require('node:child_process'),p=require('node:path'),f=require('node:fs');const main=p.dirname(execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim());const dir='scripts/.claude-skills';const src=p.join(main,dir);if(p.resolve(dir)===p.resolve(src)){console.log('[hydrate] main checkout - nothing to do');process.exit(0)}if(!f.existsSync(src)){console.error('[hydrate] no tooling at '+src+' - re-sync the main checkout first');process.exit(1)}f.cpSync(src,dir,{recursive:true});const prune=(s,d)=>{if(!f.existsSync(d))return;for(const e of f.readdirSync(d,{withFileTypes:true})){const sp=p.join(s,e.name),dp=p.join(d,e.name);if(e.isDirectory()){if(!f.existsSync(sp)){f.rmSync(dp,{recursive:true,force:true});continue}prune(sp,dp);if(f.readdirSync(dp).length===0)f.rmSync(dp,{recursive:true,force:true})}else if(!f.existsSync(sp))f.rmSync(dp,{force:true})}};prune(src,dir);const man='scripts/.sync-manifest.json',ms=p.join(main,man),ok=f.existsSync(ms);if(ok){f.copyFileSync(ms,man)}console.log('[hydrate] copied '+(ok?2:1)+'/2 items from '+main+(ok?'':' - but NOT '+man+' (absent there): this tree has no bundle stamp'))\""
```

## Why this lives here and not in SKILL.md

The recipe is ~1,700 characters (about 870 tokens) and used to be inlined in every
skill's marker block, where it cost every invocation that budget and pushed the rest
of the skill toward the 5,000-token prefix Claude Code keeps after context
compaction. A skill's own `references/` directory is copied with the skill, so this
file reaches the same reader the marker does — including in an unadopted consumer,
where neither the npm script nor `docs/runbooks/` exists yet.

Rationale and incident history (source repo only — `docs/runbooks/` is not synced
to consumers): `docs/runbooks/consumer-adoption.md` §"Linked git worktrees".

/**
 * @fileoverview The ONE oracle for `Is this finding row actionable code, or a plan
 * section?` — the classification every /ship-nudge `byMode` split counts on.
 *
 * **Its own module, deliberately.** `ship-nudges.mjs` is re-exported by
 * `plans-ship.mjs` through `export *`, and that barrel IS the public surface pinned by
 * `tests/learning-store-exports.test.mjs` — a contract about named persistence
 * FUNCTIONS. Defining these two constants there put two strings on a function contract
 * and failed the pin three ways (extra names, wrong typeof, wrong count). Widening that
 * contract to admit constants would have been fixing the guard to fit the change.
 *
 * Living here keeps all three properties at once: one oracle, importable by the test
 * that asserts it (the alternative was restating the pattern in the test, which is
 * exactly how the defect survived), and off the consumer-facing barrel.
 *
 * Exports no verb in `record|sync|upsert|save|persist|write|delete|retire|mark`, so it
 * needs no durable-writer registration.
 *
 * @module scripts/lib/store/finding-mode
 */

/**
 * Does a `primary_file` name an actionable code artifact, or a plan section?
 *
 * **Why this exists (upstream report fe1ff38a, Lbstrydom/wine-cellar-app, 2026-09-06).**
 * Every `byMode` split in this module branched on `audit_mode` alone, and trusted it to
 * carry the distinction. It does not. The write side records
 * `primary_file: f._primaryFile || f.section` (`runs-findings.mjs`), so a CODE-mode run
 * whose finding never produced a `_primaryFile` falls back to a prose section reference
 * while `audit_mode` stays `'code'`. Measured in the reporter's repo: 15 of 25
 * `byMode.code` rows named a plan section, a **2.5x** overstatement of the actionable
 * backlog. Measured here the same day: 8 of 93, e.g. `"§2 proposed architecture —
 * bootstrap entry point"` and `"plan file inventory — migration and verification
 * deliverables"`. Smaller, same defect.
 *
 * It matters because `/ship` Step 0.5b tells the agent to report `byMode.code` as
 * `missing_spec_count`, and the split exists precisely because a plan row has no code
 * artifact and **no lock of any kind can ever exist for it**. A consumer therefore burns
 * time discovering, per row, that a "code" finding cannot be actioned — the reporter lost
 * about an hour before spotting the pattern. This is the same class the mode split was
 * introduced to fix, one level down.
 *
 * **A SHAPE test, deliberately not an extension allowlist.** The report suggested
 * `\.(js|jsx|css|html|mjs|sql|json)$`, which is a per-repo constant: this repo is `.mjs`,
 * the reporter's is `.js`/`.css`, and a consumer on `.ts`/`.svelte`/`.py` would have every
 * real path silently reclassified as a plan section — the same false-negative shipped to
 * every repo that adopts this bundle. Shape (no whitespace, no `§`, a dotted extension)
 * asks the question the caller actually has.
 *
 * **Erring toward `plan` is the safe direction**: it under-reports actionable work rather
 * than sending someone after a row they cannot action. A genuine path containing a space
 * is counted as plan; that is a trade this predicate makes on purpose.
 *
 * ONE source of truth: the pattern string below is the only place this is written down,
 * and `EFFECTIVE_MODE_SQL` composes it rather than restating it, so the SQL and any
 * JS-side assertion cannot drift into two answers.
 */
export const CODE_PATH_PATTERN = '^[A-Za-z0-9_./-]+\\.[A-Za-z0-9]+$';

/**
 * The mode a row must be COUNTED as, which is not always the mode it was RECORDED as.
 *
 * A READ-side correction by design. Existing rows are already mis-stamped, so a write-side
 * fix alone would leave every historical row wrong forever — and the historical rows are
 * the whole backlog these nudges report.
 *
 * Unqualified column names, so it drops into a query with or without a table alias.
 * Interpolated into the SELECT/GROUP BY only — never near a `FROM`, because the repo-fence
 * scan reads these bodies for literal `FROM <view>` names and an interpolation there would
 * drop it out of the reader (see the note in `getUnlockedFixes`).
 */
export const EFFECTIVE_MODE_SQL =
  `CASE WHEN audit_mode = 'code' AND primary_file ~ '${CODE_PATH_PATTERN}'`
  + ` THEN 'code' ELSE 'plan' END`;

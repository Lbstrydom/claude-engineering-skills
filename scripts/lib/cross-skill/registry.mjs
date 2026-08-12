/**
 * @fileoverview The declarative command registry for `scripts/cross-skill.mjs`
 * (docs/plans/cross-skill-command-registry.md D1/D2).
 *
 * One entry per MIGRATED subcommand. The registry starts empty and grows one
 * cohort at a time (audit R1-H1) — an entry never points at a module that
 * does not exist yet, and a name present here is served by the registry path
 * ONLY (a loader failure is `REGISTRY_LOAD_FAILED`, never a silent fallback
 * to the legacy map). The frozen inventory
 * (`tests/fixtures/cross-skill-inventory.json`) is the conservation law:
 * `registryNames ∪ legacyNames = INVENTORY`, disjoint, at every commit.
 *
 * Entry shape (plan D1):
 *   name        string — the subcommand
 *   flags       Array<string|{name, kind:'valued'|'boolean'|'repeatable'}>
 *               (string shorthand = valued). Lexical SHAPE only — value
 *               semantics stay handler-owned (audit R1-H3 boundary).
 *   positionals 'none' | {verbs: string[]} — bare-word grammar. For {verbs},
 *               unknown verbs FLOW TO THE HANDLER (its legacy usage message
 *               is the frozen surface); the declaration exists for
 *               conformance and for the 'none' refusal.
 *   payload     'json' | 'flags' | 'both' | 'none' — derives which payload
 *               flags (--json/--stdin) are accepted (audit R1-H2).
 *   scope       'none' | 'ambient-ok' | 'explicit-required' | 'global-optin'
 *   kind        'read' | 'write' | 'local'
 *   cloud       'none' | 'degrade-noop' | 'require'
 *   degradeShape object — extra fields on the canonical cloud-off envelope
 *               {ok:true, cloud:false, ...degradeShape}; pinned to the
 *               captured legacy fixture by the golden suite (shadow R1-M3).
 *   softFail    boolean — frozen legacy quirk: this command emits ok:false at
 *               exit 0 (must be proven by a golden fixture).
 *   forward     {to: string} — rest-forwarding command; flag validation is
 *               delegated to the target CLI (shadow R1-M1/G2).
 *   portExempt  boolean — self-contained sub-CLI wrapper; store-call goldens
 *               skip it (shadow G2-H). Only legal beside forward/wrapper.
 *   parent      {table, idField} — parent-scoped child write (D7; Cluster F).
 *   load        () => Promise<handler> — lazy; cold start does not scale
 *               with command count.
 *
 * Handlers receive `ctx` (see dispatch.mjs) and return the FULL legacy
 * envelope (ok:true) or throw CommandError — byte-compatibility forbids
 * envelope normalisation (audit R1-H4).
 */

/**
 * Flags every command ACCEPTS for validation. `--selfcheck-relocation` is
 * the only name every command genuinely honours; `--help` is accepted
 * everywhere for byte-compatibility with the legacy global KNOWN_FLAGS (a
 * per-command `record-ship-event --help` reaches the handler and BAD_INPUTs,
 * exactly as before — "honoured" only in the subcommand position, which
 * main() traps before dispatch).
 */
export const UNIVERSAL_FLAGS = ['--help', '--selfcheck-relocation'];

/** Payload-source flags derived from the payload declaration (audit R1-H2). */
export function payloadFlags(payload) {
  return (payload === 'json' || payload === 'both') ? ['--json', '--stdin'] : [];
}

/** Normalise a flag declaration to {name, kind}. */
export function normalizeFlag(f) {
  return typeof f === 'string' ? { name: f, kind: 'valued' } : f;
}

export const REGISTRY = Object.freeze([
  // ── Cohort: template trio (Cluster A, Phase 2) ───────────────────────────
  {
    name: 'whoami',
    flags: [],
    positionals: 'none',
    payload: 'none',
    scope: 'none',
    kind: 'read',
    // cloud:'none' — whoami REPORTS cloud state as data, so it owns its own
    // init + isCloudEnabled read via the port rather than being gated.
    cloud: 'none',
    load: () => import('./commands/misc.mjs').then((m) => m.whoamiCmd),
  },
  {
    name: 'record-ship-event',
    flags: [],
    positionals: 'none',
    payload: 'json',
    scope: 'ambient-ok',
    kind: 'write',
    cloud: 'degrade-noop',
    degradeShape: {},
    load: () => import('./commands/ship.mjs').then((m) => m.recordShipEventCmd),
  },
  {
    name: 'persona-outcomes',
    flags: [
      'repo', 'repo-id', 'out', 'session', 'hash', 'outcome', 'rationale', 'by',
      'report-path',
      { name: 'worksheet', kind: 'boolean' },
      { name: 'dry-run', kind: 'boolean' },
    ],
    positionals: { verbs: ['summary', 'label', 'backfill-hash'] },
    payload: 'both',
    // Scope policy applies to the verbs that RESOLVE a repo (summary,
    // --worksheet, backfill-hash — all --repo-authoritative). `label` never
    // calls resolveScope: its repo derives from the ADDRESSED session row via
    // resolveLabelTarget (legacy-correct — the session IS the parent, the
    // same parent-derivation shape D7/Cluster F formalises with the ownership
    // join; declaring --repo required for label would break its documented
    // invocation). A per-verb scope grammar for one command is the
    // over-engineered cliff; this note is the honest middle (audit CA-r2).
    scope: 'explicit-required',
    kind: 'write',
    cloud: 'degrade-noop',
    degradeShape: {},
    // Frozen legacy quirk, scoped to the ONE verb that has it (audit CA-r1):
    // `summary` returns the store's result VERBATIM (`emit(res)`), and the
    // store's error path is `{ok:false, error}` at exit 0 — a returned non-ok
    // envelope predating the CommandError contract. Command-wide softFail
    // would have exempted label/backfill/worksheet regressions too; the
    // verb-scoped form keeps the validator armed everywhere the quirk is not.
    // Not hermetically capturable (it needs a store error), so the proof is
    // the legacy source (`cmdPersonaOutcomes` → `return emit(res)`).
    softFail: { verbs: ['summary'] },
    load: () => import('./commands/persona.mjs').then((m) => m.personaOutcomesCmd),
  },
]);

const _byName = new Map(REGISTRY.map((e) => [e.name, e]));

/** @returns {object|undefined} the registry entry, or undefined (→ legacy map). */
export function getCommand(name) {
  return _byName.get(name);
}

export function registryCommandNames() {
  return REGISTRY.map((e) => e.name);
}

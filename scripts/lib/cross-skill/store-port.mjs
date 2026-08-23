/**
 * @fileoverview The ONE composed store namespace for migrated cross-skill
 * commands (docs/plans/cross-skill-command-registry.md D5b).
 *
 * Migrated command handlers reach persistence exclusively through
 * `ctx.deps`, which defaults to this module's `STORE_PORT`. The port cannot
 * be the `scripts/learning-store.mjs` barrel alone: several commands' store
 * functions live outside it (verified against the legacy imports —
 * nav-audit, persona-outcomes(+hash-backfill), arm-eval, upstream-issues),
 * so a barrel-only port would leave those commands either unmigratable or
 * smuggling direct imports past the conformance ban.
 *
 * Collision policy (shadow G2-L: measured on day one, not assumed): a name
 * exported by two composed modules with DIFFERENT values is a hard error at
 * load — silently letting the later module win would make "which
 * implementation ran?" depend on spread order, which is exactly the
 * two-sources-of-truth defect this plan removes. Identical values (a barrel
 * re-export of the same function) compose fine.
 *
 * The conformance suite asserts `commands/*.mjs` imports neither the barrel
 * nor anything under `scripts/lib/store/` — this port is the only way in.
 * Coverage boundary (three patterns, plan D5b): direct calls via the port;
 * injected-store orchestrators receiving `ctx.deps.*`; `portExempt`
 * forwarder/wrapper commands whose sub-CLIs own their own store access.
 */
import * as barrel from '../../learning-store.mjs';
import * as navAudit from '../store/nav-audit.mjs';
import * as personaOutcomes from '../store/persona-outcomes.mjs';
import * as personaOutcomesBackfill from '../store/persona-outcomes-hash-backfill.mjs';
import * as armEval from '../store/arm-eval.mjs';
import * as upstreamIssues from '../store/upstream-issues.mjs';
import * as skillCensus from '../store/skill-census.mjs';
import { getCloudState, getCloudInitFailure } from '../store/client-state.mjs';

function compose(...modules) {
  const out = Object.create(null);
  for (const mod of modules) {
    for (const [name, value] of Object.entries(mod)) {
      if (name in out && out[name] !== value) {
        throw new Error(
          `store-port composition collision: "${name}" is exported with different values by two composed modules — `
          + 'rename one export or re-export the same binding; spread-order must never decide which implementation runs',
        );
      }
      out[name] = value;
    }
  }
  return Object.freeze(out);
}

export const STORE_PORT = compose(
  barrel,
  navAudit,
  personaOutcomes,
  personaOutcomesBackfill,
  armEval,
  upstreamIssues,
  skillCensus,
  { getCloudState, getCloudInitFailure },
);

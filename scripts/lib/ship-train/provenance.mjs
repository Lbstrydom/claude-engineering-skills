/**
 * @fileoverview Ship-train provenance — bind an audit run to a PR by CONTENT,
 * decide the squash commit's AI-Gate, and render its message.
 *
 * Pure. Git reads and the store query happen in the CLI; this module receives
 * their results. Plan: docs/plans/ship-trains.md §2.3.
 *
 * Binding is by content, never by declaration. Sessions make plain commits, so
 * no run id comes from them. A run binds to a PR when its `audited_tree` (the
 * worktree content the audit read) equals the tree of a commit in the PR. That
 * is E1's content identity — a PR body cannot forge it. A run whose
 * `audited_sha` is a PR commit but whose tree matches none is an ANCESTRY
 * candidate: it proves an audit happened on the branch, not what it read, so it
 * can back only an explicitly authorised waiver, never `passed`/`converged`.
 *
 * The gate itself is decided by the ONE shared evaluator,
 * `evaluateGateVerification`. This module only assembles its inputs.
 *
 * @module scripts/lib/ship-train/provenance
 */

import {
  evaluateGateVerification, composeFinalMessage, canonicaliseModels, RESERVED_TRAILER_RE, TREE_ID_RE,
} from '../commit-trailers.mjs';
import { modelFamily } from '../model-resolver.mjs';

/**
 * `AI-Models` tokens are model LINES (`claude`, `gemini`, `gpt`) — the
 * vocabulary every existing commit and the query cookbook use. `modelFamily`
 * answers the VENDOR (the one family function AGENTS.md mandates); this maps
 * the three vendors whose line token differs from the vendor name. Any other
 * vendor is its own token.
 */
const LINE_TOKEN = Object.freeze({ openai: 'gpt', google: 'gemini', anthropic: 'claude' });

/**
 * @param {string|null|undefined} modelId
 * @returns {string|null}
 */
export function modelToken(modelId) {
  const vendor = modelFamily(modelId);
  if (!vendor) return null;
  const token = LINE_TOKEN[vendor] ?? vendor;
  return /^[a-z][a-z0-9.-]*$/.test(token) ? token : null;
}

/**
 * The composer — the model rendering the squash commit, DECLARED by the
 * invoking skill (`--composer`, required, no default) — plus every model a
 * recorded run column names. The run-derived part is evidence; the composer
 * is a declaration, the same honesty tier AI-Models already has
 * (docs/reference/commit-provenance.md). An unrecorded stage is omitted and
 * reported, never assumed.
 *
 * @param {{authorModel?: string|null, finalReviewModel?: string|null, auditorModels?: string[]}|null} run
 * @param {string} composerToken
 * @returns {{models: string[], attributionMissing: string[]}}
 */
export function modelsFromRun(run, composerToken) {
  const tokens = [composerToken];
  const missing = [];
  if (run) {
    const auditors = (run.auditorModels ?? []).map(modelToken).filter(Boolean);
    if (auditors.length) tokens.push(...auditors); else missing.push('auditor');
    const reviewer = modelToken(run.finalReviewModel);
    if (reviewer) tokens.push(reviewer); else missing.push('final-review');
    const author = modelToken(run.authorModel);
    if (author) tokens.push(author); else missing.push('author');
  }
  const canon = canonicaliseModels(tokens.join(','));
  if (!canon.ok) throw new Error(`modelsFromRun: non-canonical model token ${JSON.stringify(canon.bad)}`);
  return { models: canon.models, attributionMissing: missing };
}

/**
 * Bind a store run to a PR.
 *
 * @param {object} input
 * @param {Array<{oid: string, tree: string}>} input.commits — the PR's commits B..H, oldest first, EXCLUDING the merge-base
 * @param {Array<{id: string, auditedSha: string|null, auditedTree: string|null, roundConvergedAfter: number|null, createdAt: string|Date}>} input.candidates
 * @returns {{kind: 'tree', run: object, boundIndex: number, boundCommit: string, postAuditCommits: string[]}
 *         | {kind: 'ancestry', run: object, candidateCommit: string}
 *         | {kind: 'unbound', reason: string}}
 */
export function bindAuditRun({ commits, candidates }) {
  const list = commits ?? [];
  if (list.length === 0) return { kind: 'unbound', reason: 'no-commits' };
  // Newest commit carrying each tree — a revert can make two commits share one.
  const treeIndex = new Map();
  const oidIndex = new Map();
  list.forEach((c, i) => { treeIndex.set(c.tree, i); oidIndex.set(c.oid, i); });

  const newestFirst = (a, b) => (b._i - a._i)
    || (Date.parse(b.createdAt) - Date.parse(a.createdAt))
    || String(b.id).localeCompare(String(a.id));

  const treeBound = [];
  const ancestry = [];
  for (const run of candidates ?? []) {
    if (run.auditedTree && treeIndex.has(run.auditedTree)) {
      treeBound.push({ ...run, _i: treeIndex.get(run.auditedTree) });
    } else if (run.auditedSha && oidIndex.has(run.auditedSha)) {
      ancestry.push({ ...run, _i: oidIndex.get(run.auditedSha) });
    }
  }

  if (treeBound.length) {
    treeBound.sort(newestFirst);
    const boundIndex = treeBound[0]._i;
    // Among runs on the newest bound commit, prefer the newest CONVERGED one;
    // when none converged, the newest run stands (and the gate refuses).
    const atCommit = treeBound.filter((r) => r._i === boundIndex);
    const chosen = atCommit.find((r) => r.roundConvergedAfter != null) ?? atCommit[0];
    const { _i, ...run } = chosen;
    return {
      kind: 'tree',
      run,
      boundIndex,
      boundCommit: list[boundIndex].oid,
      postAuditCommits: list.slice(boundIndex + 1).map((c) => c.oid),
    };
  }
  if (ancestry.length) {
    ancestry.sort(newestFirst);
    const { _i, ...run } = ancestry[0];
    return { kind: 'ancestry', run, candidateCommit: list[_i].oid };
  }
  return { kind: 'unbound', reason: 'no-run-matches-a-pr-commit' };
}

const refusal = (code, message, override = null) => ({ code, message, override });

/**
 * Decide the squash commit's gate (plan §2.3 table).
 *
 * @param {object} input
 * @param {ReturnType<typeof bindAuditRun>|{kind: 'store-unavailable'|'unbindable', reason: string}} input.binding
 * @param {string} input.headTree — T(H), the PR head's tree
 * @param {'strict'|'none'} input.basePinning — does the server refuse a non-up-to-date merge?
 * @param {'urgent'|'standard'|'ride-along'} input.tier
 * @param {boolean} [input.waive] — `--waive <this pr>` was given at invocation
 * @param {boolean} [input.allowUnaudited] — `--allow-unaudited <this pr>` was given
 * @returns {{gate: string|null, runId: string|null, auditedTree: string|null, identityProvable: boolean, refusal: null|{code: string, message: string, override: string|null}}}
 */
export function decideTrainGate({ binding, headTree, basePinning, tier, waive = false, allowUnaudited = false }) {
  const identityProvable = basePinning === 'strict';
  const out = (gate, extra = {}) => ({ gate, runId: null, auditedTree: null, identityProvable, refusal: null, ...extra });
  const refuse = (r) => ({ gate: null, runId: null, auditedTree: null, identityProvable, refusal: r });

  if (!TREE_ID_RE.test(headTree ?? '')) {
    return refuse(refusal('no-head-tree', 'the PR head tree could not be resolved, so no tree relation can be decided'));
  }

  if (binding.kind === 'unbindable') {
    // The PR itself could not be bound (too many commits, a malformed id). No
    // tier lets it through and no flag overrides it: nothing was checked.
    return refuse(refusal('unbindable', `this PR cannot be bound to an audit run (${binding.reason})`));
  }

  if (binding.kind === 'store-unavailable') {
    if (tier === 'ride-along') return out('not-run');
    return refuse(refusal('store-unavailable', `the audit store could not be read (${binding.reason}); a ${tier} PR cannot be landed without a verifiable claim`));
  }

  if (binding.kind === 'tree') {
    const { run } = binding;
    const evidence = { state: 'fresh', runId: run.id, auditedTree: run.auditedTree };
    const convergence = { roundConvergedAfter: run.roundConvergedAfter ?? null };
    const common = { evidence, cloudEnabled: true, convergence, committedTree: headTree, identityProvable };
    if (evaluateGateVerification({ gate: 'passed', ...common }) === null) {
      return out('passed', { runId: run.id, auditedTree: run.auditedTree });
    }
    const conv = evaluateGateVerification({ gate: 'converged', ...common });
    if (conv === null) return out('converged', { runId: run.id });
    if (waive) return out('waived', { runId: run.id });
    return refuse(refusal('run-not-converged', `run ${run.id} audited this PR's content but ${conv.custom.replace(/^AGENT FIX: gate-evidence: /, '')}`, '--waive'));
  }

  if (binding.kind === 'ancestry') {
    if (waive) return out('waived', { runId: binding.run.id });
    return refuse(refusal(
      'ancestry-only',
      `run ${binding.run.id} audited ${binding.candidateCommit.slice(0, 12)} on this branch, but its audited tree matches no PR commit (an uncommitted or untracked file was in the audited worktree), so it proves an audit ran, not what it read`,
      '--waive',
    ));
  }

  // unbound
  if (tier === 'ride-along' || allowUnaudited) return out('not-run');
  return refuse(refusal('unaudited', `no audit run's content matches any commit in this ${tier} PR`, '--allow-unaudited'));
}

/**
 * Render the squash commit message: GitHub's own shape (title `(#n)`, one bullet
 * per commit) with the AI-* block as a PARSEABLE last-paragraph trailer block.
 * That last property is the whole point — today's default body buries it
 * (56 of 76 commits on main since 2026-09-25 carry no parseable AI-Gate).
 *
 * @param {object} input
 * @param {number} input.number
 * @param {string} input.title
 * @param {string[]} input.commitSubjects
 * @param {{gate: string, runId: string|null, auditedTree: string|null}} input.decision
 * @param {string[]} input.models
 * @returns {{subject: string, body: string, message: string}}
 * @throws when an input carries a reserved AI-* trailer — only this function writes them
 */
export function composeSquashMessage({ number, title, commitSubjects, decision, models }) {
  const subject = `${String(title).replace(/[\r\n]+/g, ' ').trim()} (#${number})`;
  const bullets = (commitSubjects ?? []).map((s) => `* ${String(s).replace(/[\r\n]+/g, ' ').trim()}`).join('\n');
  const text = bullets ? `${subject}\n\n${bullets}` : subject;
  // Any line, not only a last-paragraph block: a reserved key anywhere in the
  // PR title or a commit subject is refused, so the only AI-* lines in the
  // message are the ones composeFinalMessage appends below.
  if (text.split('\n').some((line) => RESERVED_TRAILER_RE.test(line.replace(/^\* /, '')))) {
    throw new Error('composeSquashMessage: a reserved AI-* trailer appears in the PR title or commit subjects');
  }
  const message = composeFinalMessage(text, {
    skill: 'ship',
    models,
    gate: decision.gate,
    runId: decision.runId,
    auditedTree: decision.gate === 'passed' ? decision.auditedTree : null,
    // No `finalReview`, deliberately: no final-review marker is bound to a PR's run in the checkout a train lands from, so a
    // train squash carries no AI-Final-Review (absence: no bound record), and verify.mjs refuses one (copilot-feedback-item4 B4).
  });
  const cut = message.indexOf('\n\n');
  return { subject, body: message.slice(cut + 2), message };
}

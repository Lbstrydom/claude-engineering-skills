/**
 * @fileoverview The GitHub facts the CI-evidence oracle reads: ONE module owns every `gh` read behind a merge decision
 * (docs/plans/ci-evidence-oracle.md section 2.4).
 *
 * Each reader returns `{ok:true, value}` or `{ok:false, fault:{kind, detail}}` and nothing else, and none throws.
 *  - **Transport**: any non-zero exit, spawn failure or timeout is `transport`. NO branch reads stderr: "404 means empty" was the
 *    shape of three earlier holes (measured: a protected branch's `/protection` answers 404, a missing branch's rules answer `[]`).
 *  - **Decode**: output that is not JSON is `malformed`.
 *  - **Validate**: a zod schema over the DECISION fields only; unrelated keys are tolerated (GitHub adds fields), a missing or
 *    mistyped decision field is `malformed`. An absent `isDraft` is `malformed`, never "not a draft".
 *  - **One page, complete by construction**: no read follows pagination. A page that is full (100) is `too-many-results`;
 *    check runs additionally prove `length === total_count`.
 *
 * Nothing here decides anything: `required-checks.mjs` turns these facts into evidence.
 *
 * @module scripts/lib/fleet/github-ci-facts
 */
import { z } from 'zod';

/** The page size every list read asks for, and the length at which a page is treated as possibly truncated. */
export const PAGE_SIZE = 100;

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const OID_RE = /^[0-9a-f]{40}$/;

const fault = (kind, detail) => ({ ok: false, fault: { kind, detail: String(detail).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').slice(0, 300) } });
const good = (value) => ({ ok: true, value });

/** Run `gh`, decode JSON. Transport faults keep the exit status and the first stderr line as opaque detail only. */
function ghJson(deps, cwd, args) {
  let res;
  try { res = deps.gh(args, cwd); } catch (e) { return fault('transport', `gh threw: ${String(e?.message ?? e)}`); }
  if (!res || res.ok !== true) {
    const first = String(res?.stderr ?? '').trim().split(/\r?\n/)[0] || String(res?.reason ?? 'no output');
    return fault('transport', `gh exited ${res?.status ?? 'without a status'}: ${first}`);
  }
  try { return good(JSON.parse(String(res.stdout))); } catch { return fault('malformed', 'the answer is not JSON'); }
}

/** Validate `doc` against `schema`; the zod issue path (never the value) is the detail. */
function validated(schema, doc, what) {
  const r = schema.safeParse(doc);
  if (r.success) return good(r.data);
  const i = r.error.issues[0];
  return fault('malformed', `${what}: ${i?.path?.length ? i.path.join('.') : '(root)'} ${i?.message ?? 'is invalid'}`);
}

const badArgs = (what) => fault('malformed', `${what}: the repo must be owner/name`);

// ---- the PR ------------------------------------------------------------------------------------------------------------------

const PrSchema = z.object({
  state: z.string().min(1),
  isDraft: z.boolean(),
  headRefOid: z.string().regex(OID_RE),
  baseRefName: z.string().min(1),
});

/** `gh pr view --json state,isDraft,headRefOid,baseRefName`. @returns {{ok: true, value: {state: string, isDraft: boolean, headRefOid: string, baseRefName: string}} | {ok: false, fault: object}} */
export function readPrCandidate(deps, cwd, { repo, prNumber }) {
  if (!REPO_RE.test(String(repo ?? ''))) return badArgs('the PR read');
  if (!Number.isInteger(prNumber) || prNumber <= 0) return fault('malformed', 'the PR read: the PR number is not a positive integer');
  const r = ghJson(deps, cwd, ['pr', 'view', String(prNumber), '-R', repo, '--json', 'state,isDraft,headRefOid,baseRefName']);
  return r.ok ? validated(PrSchema, r.value, 'the PR view') : r;
}

// ---- classic branch protection, from the branch itself ----------------------------------------------------------------------

const BranchSchema = z.object({
  protected: z.boolean(),
  protection: z.object({
    enabled: z.boolean(),
    required_status_checks: z.object({
      contexts: z.array(z.string()),
      checks: z.array(z.object({ context: z.string() })),
    }).nullish(),
  }),
});

/**
 * `GET repos/{r}/branches/{b}`: the branch exists (a missing one is a 404, so `transport`), and whether CLASSIC protection is on. `protected` alone
 * is NOT that signal (a ruleset sets it; measured on two repos), so `protection.enabled` is. When classic is off its required lists must be empty.
 * @returns {{ok: true, value: {protected: boolean, classicEnabled: boolean, contexts: string[]}} | {ok: false, fault: object}}
 */
export function readBranchProtection(deps, cwd, { repo, base }) {
  if (!REPO_RE.test(String(repo ?? ''))) return badArgs('the branch read');
  if (!base || typeof base !== 'string') return fault('malformed', 'the branch read: no branch name');
  const r = ghJson(deps, cwd, ['api', `repos/${repo}/branches/${encodeURIComponent(base)}`]);
  if (!r.ok) return r;
  const v = validated(BranchSchema, r.value, 'the branch');
  if (!v.ok) return v;
  const { protection } = v.value;
  const rsc = protection.required_status_checks;
  const contexts = rsc ? [...new Set([...rsc.contexts, ...rsc.checks.map((c) => c.context)])] : [];
  if (!protection.enabled && contexts.length) return fault('malformed', 'the branch: classic protection is off but lists required contexts');
  return good({ protected: v.value.protected, classicEnabled: protection.enabled, contexts });
}

// ---- the rulesets that apply to the branch -----------------------------------------------------------------------------------

const RuleSchema = z.object({ type: z.string().min(1) }).passthrough();
const RscParams = z.object({
  required_status_checks: z.array(z.object({ context: z.string().min(1), integration_id: z.number().int().positive().nullish() })),
});

/**
 * `GET repos/{r}/rules/branches/{b}?per_page=100`, ONE page. Required (context, integrationId) pairs from every `required_status_checks` rule.
 * Meaningful only AFTER `readBranchProtection` proved the branch exists (a missing branch's rules are `[]`, exit 0).
 * @returns {{ok: true, value: {pairs: Array<{context: string, integrationId: number|null}>, types: string[]}} | {ok: false, fault: object}}
 */
export function readBranchRules(deps, cwd, { repo, base }) {
  if (!REPO_RE.test(String(repo ?? ''))) return badArgs('the rules read');
  if (!base || typeof base !== 'string') return fault('malformed', 'the rules read: no branch name');
  const r = ghJson(deps, cwd, ['api', `repos/${repo}/rules/branches/${encodeURIComponent(base)}?per_page=${PAGE_SIZE}`]);
  if (!r.ok) return r;
  const list = validated(z.array(RuleSchema), r.value, 'the rules');
  if (!list.ok) return list;
  if (list.value.length >= PAGE_SIZE) return fault('too-many-results', `the rules page is full (${list.value.length}): more than one page of rules is not read`);
  const pairs = [];
  for (const rule of list.value) {
    if (rule.type !== 'required_status_checks') continue;
    const p = validated(RscParams, rule.parameters, 'a required_status_checks rule');
    if (!p.ok) return p;
    for (const c of p.value.required_status_checks) pairs.push({ context: c.context, integrationId: c.integration_id ?? null });
  }
  return good({ pairs, types: list.value.map((x) => x.type) });
}

// ---- the check runs on a head -------------------------------------------------------------------------------------------------

const CheckRunsSchema = z.object({
  total_count: z.number().int().nonnegative(),
  check_runs: z.array(z.object({
    id: z.number().int().positive(),
    name: z.string().min(1),
    status: z.string().min(1),
    conclusion: z.string().min(1).nullable(),
    head_sha: z.string().regex(OID_RE),
    app: z.object({ id: z.number().int().positive() }).nullable(),
  })),
});

/**
 * `GET repos/{r}/commits/{sha}/check-runs?per_page=100`, ONE page, complete by construction: `length === total_count`, ids unique, every run on
 * `head`. Raw status/conclusion strings are returned: their meaning is the evidence function's (closed domains), not this reader's.
 * @returns {{ok: true, value: Array<{id: number, name: string, status: string, conclusion: string|null, appId: number|null}>} | {ok: false, fault: object}}
 */
export function readCheckRuns(deps, cwd, { repo, head }) {
  if (!REPO_RE.test(String(repo ?? ''))) return badArgs('the check-runs read');
  if (!OID_RE.test(String(head ?? ''))) return fault('malformed', 'the check-runs read: the head is not a full oid');
  const r = ghJson(deps, cwd, ['api', `repos/${repo}/commits/${head}/check-runs?per_page=${PAGE_SIZE}`]);
  if (!r.ok) return r;
  const v = validated(CheckRunsSchema, r.value, 'the check runs');
  if (!v.ok) return v;
  const { total_count: total, check_runs: runs } = v.value;
  if (runs.length !== total) return fault('too-many-results', `the check-runs page holds ${runs.length} of ${total} runs: more than one page is not read`);
  if (new Set(runs.map((x) => x.id)).size !== runs.length) return fault('malformed', 'the check runs repeat a run id');
  if (runs.some((x) => x.head_sha !== head)) return fault('malformed', 'a check run belongs to another head');
  return good(runs.map((x) => ({ id: x.id, name: x.name, status: x.status, conclusion: x.conclusion, appId: x.app?.id ?? null })));
}

// ---- the commit statuses on a head ---------------------------------------------------------------------------------------------

const StatusesSchema = z.array(z.object({ id: z.number().int().positive(), context: z.string().min(1), state: z.string().min(1) }));

/**
 * `GET repos/{r}/commits/{sha}/statuses?per_page=100`, ONE page; a full page is `too-many-results`. Read only to DETECT a status that shares a
 * required context (a status carries no app id the pin can be compared with), never to satisfy a requirement.
 * @returns {{ok: true, value: Array<{id: number, context: string, state: string}>} | {ok: false, fault: object}}
 */
export function readCommitStatuses(deps, cwd, { repo, head }) {
  if (!REPO_RE.test(String(repo ?? ''))) return badArgs('the statuses read');
  if (!OID_RE.test(String(head ?? ''))) return fault('malformed', 'the statuses read: the head is not a full oid');
  const r = ghJson(deps, cwd, ['api', `repos/${repo}/commits/${head}/statuses?per_page=${PAGE_SIZE}`]);
  if (!r.ok) return r;
  const v = validated(StatusesSchema, r.value, 'the statuses');
  if (!v.ok) return v;
  if (v.value.length >= PAGE_SIZE) return fault('too-many-results', `the statuses page is full (${v.value.length}): more than one page is not read`);
  if (new Set(v.value.map((x) => x.id)).size !== v.value.length) return fault('malformed', 'the statuses repeat an id');
  return good(v.value);
}

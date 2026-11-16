/**
 * @fileoverview `fleet decision record | revoke | list` — the verb over decisions.mjs
 * (docs/plans/ship-record-catchup.md §2.6).
 *
 *   decision record --scope <record-catchup|note> --words-file - [--expires <ISO>] [--id <session>] [--host-session <id>]
 *   decision revoke <dec-id> --words-file - [--id <session>]
 *   decision list [--scope <s>]
 *
 * The words come on STDIN (or a file), never argv: a backtick in an argv string runs as command substitution and silently
 * elides text the record can never repair (AGENTS.md, "every body and --note goes on stdin").
 *
 * @module scripts/lib/fleet/decisions-cmd
 */
import fs from 'node:fs';
import { ArgvError } from '../cli-io.mjs';
import { transact } from './registry.mjs';
import { currentBranch, lockFailed, nowIso, ok, refused } from './commands.mjs';
import {
  DECISION_SCOPES, DECISION_ID_RE, DECISIONS_CAP, GRANTS_NOTE, WORDS_MAX, registryUnusable, newDecisionId, newRevocationId, readDecisions, writeRecord,
} from './decisions.mjs';

const SUBS = ['record', 'revoke', 'list'];

/** Strict ISO-8601 (B-R1-H5): Date.parse accepts 2027-02-30 and normalises it to March 2; a round trip refuses it. */
export function isStrictIso(s) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(Z|[+-]\d{2}:\d{2})$/.exec(String(s ?? ''));
  if (!m) return false;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return false;
  const [y, mo, d] = m[1].split('-').map(Number);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

/** Read the words: `-` is stdin, anything else a file path. Exact bytes, only a trailing newline trimmed. */
export function readWords(spec, { readStdin = () => fs.readFileSync(0, 'utf8') } = {}) {
  if (spec === undefined) throw new ArgvError('fleet decision: --words-file - (stdin) or --words-file <path> is required — the user\'s exact words');
  let text;
  try { text = spec === '-' ? readStdin() : fs.readFileSync(spec, 'utf8'); } catch (e) { throw new ArgvError(`fleet decision: could not read --words-file ${spec} (${e.code ?? e.message})`); }
  // EXACT words (B-R1-M2): only the one line terminator a shell or editor appends is dropped; every other byte, CRLF
  // included, is kept as supplied.
  text = String(text).replace(/\r?\n$/, '');
  if (!text.trim()) throw new ArgvError('fleet decision: the words are empty');
  if (text.length > WORDS_MAX) throw new ArgvError(`fleet decision: the words are over ${WORDS_MAX} characters`);
  return text;
}

const byOf = (ctx, flags) => ({ session: flags['--id'] ?? currentBranch(ctx.cwd) ?? 'coordinator', hostSession: flags['--host-session'] ?? null });

function render(d, revoked, unusable, nowMs) {
  const state = revoked ? `REVOKED by ${revoked.id}` : d.expiresAt && Date.parse(d.expiresAt) <= nowMs ? 'expired' : unusable ? 'INDETERMINATE (registry unusable)' : 'active';
  return [`${d.id}  ${d.scope}  ${state}  recorded ${d.at} by ${d.recordedBy.session}${d.expiresAt ? `, expires ${d.expiresAt}` : ''}`,
    ...d.words.split('\n').map((l) => `    > ${l}`)].join('\n');
}

export function cmdDecision(ctx, flags, positionals, deps = {}) {
  const sub = positionals[0];
  if (!SUBS.includes(sub)) throw new ArgvError(`fleet decision: sub-command must be one of ${SUBS.join(', ')} (got ${JSON.stringify(sub ?? '')})`);
  if (sub === 'list') {
    const scope = flags['--scope'];
    if (scope !== undefined && !DECISION_SCOPES.includes(scope)) throw new ArgvError(`fleet decision list: --scope must be one of ${DECISION_SCOPES.join(', ')}`);
    const r = readDecisions(ctx.dir);
    const shown = r.decisions.filter((d) => !scope || d.scope === scope);
    // The SAME registry verdict activeDecision applies (B-R2-M1/M3/M5): an unusable history shows no decision as active.
    const unusable = registryUnusable(r);
    const lines = shown.length ? shown.map((d) => render(d, r.revocations.find((x) => x.revokes === d.id), unusable, ctx.now.getTime())) : ['no decisions recorded'];
    if (unusable) lines.push(`warning: ${unusable}`);
    if (!r.complete) lines.push(`warning: incomplete read (${r.reason}) — this is not the whole list`);
    const used = r.decisions.length + r.revocations.length + r.unsupported.length + r.invalid.length;
    lines.push(`registry: ${used}/${DECISIONS_CAP} records${used >= DECISIONS_CAP * 0.8 ? ' — NEAR THE CAP: past it every decision reads inactive (fail-closed); plan retention before then' : ''}`);
    for (const u of r.unsupported) lines.push(`unsupported: ${u.file} (${u.reason}) — listed, never active`);
    for (const i of r.invalid) lines.push(`invalid: ${i.file} (${i.reason})`);
    lines.push(`(${GRANTS_NOTE})`);
    return ok({ decisions: shown, revocations: r.revocations, complete: r.complete, text: lines.join('\n') });
  }
  if (positionals.length > (sub === 'revoke' ? 2 : 1)) throw new ArgvError(`fleet decision ${sub}: unexpected argument ${JSON.stringify(positionals.at(-1))}`);
  const words = readWords(flags['--words-file'], deps);
  const at = nowIso(ctx);
  if (sub === 'record') {
    const scope = flags['--scope'];
    if (!DECISION_SCOPES.includes(scope)) throw new ArgvError(`fleet decision record: --scope must be one of ${DECISION_SCOPES.join(', ')} (got ${JSON.stringify(scope ?? null)}); merge, push and override are deliberately not expressible`);
    const expires = flags['--expires'] ?? null;
    if (expires !== null && (!isStrictIso(expires) || Date.parse(expires) <= ctx.now.getTime())) throw new ArgvError('fleet decision record: --expires must be a future ISO-8601 timestamp with a real calendar date (e.g. 2026-12-31T00:00:00Z)');
    const tx = transact(ctx.dir, () => writeRecord(ctx.dir, {
      schemaVersion: 1, kind: 'decision', id: newDecisionId(ctx.now), at, scope, words, recordedBy: byOf(ctx, flags),
      expiresAt: expires === null ? null : new Date(Date.parse(expires)).toISOString(),
    }));
    if (!tx.ok) return lockFailed();
    const d = tx.value;
    return ok({ decision: d, text: [`decision ${d.id} recorded (${d.scope})`, render(d, null, null, ctx.now.getTime()), `(${GRANTS_NOTE})`,
      ...(d.scope === 'record-catchup' ? [`use it: ship-commit.mjs --record --decision ${d.id}`] : [])].join('\n') });
  }
  const target = positionals[1];
  if (!DECISION_ID_RE.test(String(target ?? ''))) throw new ArgvError('fleet decision revoke <dec-id>: name the decision to revoke');
  const tx = transact(ctx.dir, () => {
    const r = readDecisions(ctx.dir);
    if (!r.decisions.some((d) => d.id === target)) return { missing: true };
    if (r.revocations.some((x) => x.revokes === target)) return { already: true };
    return { rev: writeRecord(ctx.dir, { schemaVersion: 1, kind: 'revocation', id: newRevocationId(ctx.now), at, revokes: target, words, recordedBy: byOf(ctx, flags) }) };
  });
  if (!tx.ok) return lockFailed();
  if (tx.value.missing) return refused(`no decision ${target} to revoke`);
  if (tx.value.already) return ok({ text: `decision ${target} is already revoked` });
  return ok({ revocation: tx.value.rev, text: `decision ${target} revoked by ${tx.value.rev.id}` });
}

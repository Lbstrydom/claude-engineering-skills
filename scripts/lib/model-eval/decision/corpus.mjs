/**
 * @fileoverview Frozen decision corpus for the Fable-vs-Opus coordinator-decision
 * experiment: schema, leak scan, and a sha256 manifest the runner verifies before
 * any spend so every arm sees byte-identical input.
 *
 * Plan: docs/plans/fable-vs-opus-decision-eval.md §2.3, §3, §C2.
 *
 * Hashing canonicalises CRLF→LF (`canonicalizeEol`): the files are committed
 * source, and git (autocrlf) — not this tool — owns line endings. The manifest
 * carries no clock and no sha, so two `freeze` runs on one commit are
 * byte-identical.
 *
 * @module scripts/lib/model-eval/decision/corpus
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { canonicalizeEol } from '../../file-io.mjs';

/** Every calls/grades/ledger row and the manifest carry this. Bump on any
 * rubric, prompt, scoring or judge change; rows from another epoch are
 * ineligible (plan §C9). */
// Epoch history: 1 = 5-case corpus, variance run 2026-11-15 (pinned at ce49e42c,
// reproducible there); 2 = 10-case corpus + `correct` requires a measured output.
export const DECISION_EVAL_CONTRACT_EPOCH = 2;

export const MANIFEST_FILE = 'manifest.json';

export const ROLES = Object.freeze(['review', 'design-fork', 'cross-repo']);

const KeyPointSchema = z.object({
  id: z.string().regex(/^kp\d+$/),
  text: z.string().min(10),
  weight: z.number().positive(),
}).strict();

const TrapSchema = z.object({
  id: z.string().regex(/^trap\d+$/),
  text: z.string().min(10),
}).strict();

export const CaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  role: z.enum(ROLES),
  title: z.string().min(5),
  decisionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Sent to the arm. Only material available BEFORE the answer was known. */
  context: z.string().min(200),
  /** Sent to the arm. Must not leak the answer (`leakScan`). */
  question: z.string().min(20),
  /** Judge-only. Never sent to an arm. */
  rubric: z.object({
    decision: z.string().min(10),
    keyPoints: z.array(KeyPointSchema).min(3),
    traps: z.array(TrapSchema).min(1),
    leakTerms: z.array(z.string().min(3)).min(1),
  }).strict(),
  /** Judge-side controls (plan §C4): a frozen gold and a frozen confident-wrong answer. */
  controls: z.object({
    gold: z.string().min(80),
    trap: z.string().min(80),
  }).strict(),
  /** Provenance — commits / PRs / docs. Never sent to an arm or the judge. */
  sources: z.array(z.string().min(3)).min(1),
}).strict().superRefine((c, ctx) => {
  const dup = (xs) => xs.find((x, i) => xs.indexOf(x) !== i);
  const kd = dup(c.rubric.keyPoints.map((k) => k.id));
  if (kd) ctx.addIssue({ code: 'custom', path: ['rubric', 'keyPoints'], message: `duplicate key point id ${kd}` });
  const td = dup(c.rubric.traps.map((t) => t.id));
  if (td) ctx.addIssue({ code: 'custom', path: ['rubric', 'traps'], message: `duplicate trap id ${td}` });
  // trap1 is the MAIN trap: the trap control is written to fall into it and both control checks key on it.
  if (!c.rubric.traps.some((t) => t.id === 'trap1')) ctx.addIssue({ code: 'custom', path: ['rubric', 'traps'], message: 'rubric must define trap1 (the main trap the trap control falls into)' });
});

export class CorpusIntegrityError extends Error {
  constructor(reason, message) { super(message); this.name = 'CorpusIntegrityError'; this.reason = reason; }
}

/** sha256 hex of a buffer/string after CRLF→LF canonicalisation. */
export function sha256Canonical(bufOrString) {
  const buf = Buffer.isBuffer(bufOrString) ? bufOrString : Buffer.from(String(bufOrString), 'utf8');
  return crypto.createHash('sha256').update(canonicalizeEol(buf)).digest('hex');
}

/**
 * Leak terms (case-insensitive) present in the arm-visible fields. A non-empty
 * result means the question or context gives the answer away.
 * @param {z.infer<typeof CaseSchema>} c
 * @returns {string[]}
 */
export function leakScan(c) {
  const visible = `${c.context}\n${c.question}`.toLowerCase();
  return c.rubric.leakTerms.filter((t) => visible.includes(t.toLowerCase()));
}

function listCaseFiles(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== MANIFEST_FILE).sort();
}

function parseCaseFile(dir, file) {
  const raw = fs.readFileSync(path.join(dir, file));
  let json;
  try { json = JSON.parse(canonicalizeEol(raw).toString('utf8')); } catch (err) {
    throw new CorpusIntegrityError('bad-json', `${file}: ${err.message}`);
  }
  const v = CaseSchema.safeParse(json);
  if (!v.success) {
    throw new CorpusIntegrityError('bad-case', `${file}: ${v.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  if (`${v.data.id}.json` !== file) throw new CorpusIntegrityError('bad-case', `${file}: id "${v.data.id}" must match the file name`);
  const leaks = leakScan(v.data);
  if (leaks.length) throw new CorpusIntegrityError('leak', `${file}: arm-visible text contains leak term(s): ${leaks.join(', ')}`);
  return { case: v.data, sha256: sha256Canonical(raw) };
}

/**
 * Build the manifest object for a corpus dir (pure apart from reads).
 * @param {string} dir
 * @param {{ promptHashes: Record<string,string> }} opts - arm/judge prompt template hashes
 */
export function buildManifest(dir, { promptHashes }) {
  return readCorpus(dir, { promptHashes }).manifest;
}

/** One read of every case file: the manifest AND the parsed cases come from the same bytes. */
function readCorpus(dir, { promptHashes }) {
  const files = listCaseFiles(dir);
  if (files.length === 0) throw new CorpusIntegrityError('empty', `no case files in ${dir}`);
  const cases = {};
  const parsed = [];
  for (const f of files) {
    const { case: c, sha256 } = parseCaseFile(dir, f);
    cases[c.id] = { file: f, role: c.role, sha256 };
    parsed.push(c);
  }
  const corpusSha256 = sha256Canonical(Object.keys(cases).sort().map((id) => `${id}:${cases[id].sha256}`).join('\n'));
  const sortedPrompts = Object.fromEntries(Object.keys(promptHashes).sort().map((k) => [k, promptHashes[k]]));
  return { manifest: { contractEpoch: DECISION_EVAL_CONTRACT_EPOCH, corpusSha256, promptHashes: sortedPrompts, cases }, parsed };
}

/** Write the manifest (deterministic bytes, trailing newline). */
export function freezeManifest(dir, opts) {
  const manifest = buildManifest(dir, opts);
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

/**
 * Load the corpus and REFUSE unless it matches its frozen manifest exactly:
 * same epoch, same case set, same per-case hashes, same prompt hashes.
 * @param {string} dir
 * @param {{ promptHashes: Record<string,string> }} opts
 * @returns {{ manifest: object, cases: Array<z.infer<typeof CaseSchema>> }}
 */
export function loadCorpus(dir, { promptHashes }) {
  const mPath = path.join(dir, MANIFEST_FILE);
  if (!fs.existsSync(mPath)) throw new CorpusIntegrityError('no-manifest', `${mPath} missing — run \`freeze\` first`);
  const frozen = JSON.parse(canonicalizeEol(fs.readFileSync(mPath)).toString('utf8'));
  // Verified and returned from ONE read — a re-read after verification could load bytes that were never checked.
  const { manifest: current, parsed } = readCorpus(dir, { promptHashes });
  if (frozen.contractEpoch !== current.contractEpoch) {
    throw new CorpusIntegrityError('epoch', `manifest epoch ${frozen.contractEpoch} ≠ code epoch ${current.contractEpoch}`);
  }
  if (JSON.stringify(frozen.promptHashes) !== JSON.stringify(current.promptHashes)) {
    throw new CorpusIntegrityError('prompt-drift', 'arm/judge prompt templates changed since freeze — re-freeze and bump the epoch');
  }
  const ids = new Set([...Object.keys(frozen.cases || {}), ...Object.keys(current.cases)]);
  for (const id of ids) {
    if (frozen.cases?.[id]?.sha256 !== current.cases[id]?.sha256) {
      throw new CorpusIntegrityError('hash-mismatch', `case ${id}: on-disk content does not match the frozen manifest`);
    }
    // The manifest's own metadata is part of what was frozen: a tampered file / role
    // entry must not pass on matching content hashes alone (audit R1 M2).
    if (frozen.cases?.[id]?.file !== current.cases[id]?.file || frozen.cases?.[id]?.role !== current.cases[id]?.role) {
      throw new CorpusIntegrityError('hash-mismatch', `case ${id}: manifest file/role metadata does not match the frozen case`);
    }
  }
  if (frozen.corpusSha256 !== current.corpusSha256) throw new CorpusIntegrityError('hash-mismatch', 'corpus hash mismatch');
  return { manifest: frozen, cases: parsed };
}

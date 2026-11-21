/**
 * @fileoverview The gate-file registry (`.gate-files.json`): which committed paths DEFINE a gate's verdict, and how a
 * change to each is to be read (the verification-lessons plan §2.2). Load + validate (Zod 4, strict: an unknown field
 * is a parse failure, which the classifier reads as `unknown`), glob expansion over a tracked-file listing, and the
 * ratchet-gate table the runner executes.
 *
 * The set of files a registry covers is a QUESTION asked of git (`git ls-files` / `git ls-tree`), never a hand list, and
 * a path that matches no entry is NOT registered - the completeness test derives candidates from the filesystem.
 *
 * @module scripts/lib/gate-provenance/registry
 */
import { z } from 'zod';

export const REGISTRY_PATH = '.gate-files.json';

/** The closed classifier kinds. A new kind is a new function in classify.mjs and an entry here. */
export const CLASSIFIER_KINDS = Object.freeze(['numeric-cap', 'set-of-allowances', 'contract-set', 'opaque']);

const FileEntry = z.strictObject({
  /** An exact repo-relative path, or a glob (`*` within a segment, `**` across segments). */
  path: z.string().min(1),
  kind: z.enum(CLASSIFIER_KINDS),
  /** Optional closed list of top-level JSON fields; any other top-level field on either side reads `unknown`. */
  knownFields: z.array(z.string()).optional(),
  /**
   * `numeric-cap` only: top-level keys whose members are per-site EXCEPTIONS to a default cap (`files`, `ids`). Removing a
   * member restores the default, stricter cap, so it reads `tightening`; adding one is a new allowance (`loosening`). A
   * removed key outside these reads `loosening` (an uncapped value is a raised cap).
   */
  allowanceKeys: z.array(z.string()).optional(),
  /** `numeric-cap` only: the top-level numeric field holding the DEFAULT cap an exception falls back to (read at the HEAD). */
  allowanceDefaultKey: z.string().optional(),
  note: z.string().optional(),
});

const GateEntry = z.strictObject({
  id: z.string().min(1),
  /** `node` argv, relative to the repo root; the first element is the gate's entry point. */
  argv: z.array(z.string()).min(1),
  /** Helper scripts this gate runs that no import or literal scan can see (a computed path): declared here, protected with their closure. */
  spawns: z.array(z.string()).optional(),
});

export const RegistrySchema = z.strictObject({
  version: z.literal(1),
  files: z.array(FileEntry),
  gates: z.array(GateEntry),
}).superRefine((reg, ctx) => {
  // One entry per path and one gate per id: with duplicates, matching (first wins) and the registry diff (last wins) disagree.
  const dup = (xs) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];
  for (const p of dup(reg.files.map((f) => f.path))) ctx.addIssue({ code: 'custom', path: ['files'], message: `duplicate path ${JSON.stringify(p)}` });
  for (const id of dup(reg.gates.map((g) => g.id))) ctx.addIssue({ code: 'custom', path: ['gates'], message: `duplicate gate id ${JSON.stringify(id)}` });
});

/**
 * @param {string|null} text
 * @returns {{ok: true, registry: z.infer<typeof RegistrySchema>} | {ok: false, error: string}}
 */
export function parseRegistry(text) {
  if (text == null) return { ok: false, error: 'absent' };
  let raw;
  try { raw = JSON.parse(text); } catch (e) { return { ok: false, error: `invalid JSON: ${e.message}` }; }
  const r = RegistrySchema.safeParse(raw);
  if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
  return { ok: true, registry: r.data };
}

const GLOB_CHARS = /[*?]/;
export const isGlob = (p) => GLOB_CHARS.test(p);

/**
 * Segment-aware glob. `*` stays inside one segment; a whole-segment `**` is zero or more whole segments, so `a/**` + `/b`
 * matches `a/b`, `a/x/b` and `a/x/y/b` but never `a/foob`; a trailing `**` matches everything below.
 */
export function globToRegExp(glob) {
  const esc = (s) => s.split('').map((c) => ('.+^${}()|[]?'.includes(c) ? String.fromCharCode(92) + c : c)).join('');
  const seg = (s) => s.split('*').map(esc).join('[^/]*');
  const parts = glob.split('/');
  let re = '';
  parts.forEach((p, i) => {
    const last = i === parts.length - 1;
    if (p === '**') re += last ? '.*' : '(?:[^/]+/)*';
    else re += last ? seg(p) : `${seg(p)}/`;
  });
  return new RegExp(`^${re}$`);
}
/**
 * The entry that governs `file`: an exact-path entry beats a glob, and among globs the first declared wins.
 * @returns {z.infer<typeof FileEntry>|null}
 */
export function matchEntry(registry, file) {
  if (!registry) return null;
  const exact = registry.files.find((e) => !isGlob(e.path) && e.path === file);
  if (exact) return exact;
  return registry.files.find((e) => isGlob(e.path) && globToRegExp(e.path).test(file)) ?? null;
}

/** Every tracked file the registry covers, as `Map<path, entry>`. */
export function expandRegistry(registry, trackedFiles) {
  const out = new Map();
  for (const f of trackedFiles) {
    const e = matchEntry(registry, f);
    if (e) out.set(f, e);
  }
  return out;
}

/** Entry-point script of each registered ratchet gate. */
/** Declared (not scanned) helper scripts of every registered gate. */
export const gateSpawns = (registry) => (registry?.gates ?? []).flatMap((g) => g.spawns ?? []);

export const gateEntryPoints = (registry) => (registry?.gates ?? []).map((g) => g.argv[0]);

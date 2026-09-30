/**
 * @fileoverview File taxonomy — the ONE registry that answers "what kind of
 * file is this path?" for every generic decision in the audit tooling
 * (admission, repo profiling, fence language, file-reference extraction, the
 * sensitive-path code carve-out).
 *
 * ## Why this exists (storyline field report, 2026-09-30)
 *
 * A consumer's 68-file diff held 12 `.cs` files. None were audited and nothing
 * said so, because "is this a source file?" was answered by a dozen
 * independent hand-kept extension lists that disagreed with each other and with
 * the language-profile registry (the admission oracle admitted `.go` with no
 * profile but not `.cs`, and dropped `.cjs`/`.mts`/`.cts`/`.pyi` that the
 * profiles themselves claim). This module is where they now agree.
 *
 * ## Contract
 *
 * `matchFileKind(path)` is a pure function of the PATH ONLY: no filesystem,
 * no directory semantics (a `Password/` directory is `sensitive-paths.mjs`'s
 * concern, which runs later and independently). Ordered precedence, first
 * match wins:
 *
 *   1. exact filename        — lockfiles → `non-code`; build files → `declarative`
 *   2. compound suffix       — generated (`.g.cs`, `.min.js`) → `non-code`; `.html.template`
 *   3. last extension        — language → `source`; else declarative / non-code
 *   4. otherwise             — `uncovered`
 *
 * Kinds: `source` (a known programming language) · `declarative` (reviewable
 * config / markup / build definition) · `non-code` (an EXPECTED exclusion:
 * binary, asset, lockfile, generated) · `uncovered` (unrecognised — never
 * silently dropped; the caller reports it).
 *
 * Whether a `source` language has a deterministic profile (boundaries,
 * imports, tools) is `language-profiles.mjs`'s knowledge, not this module's:
 * the two split `source` into `profiled` / `model-only` there. This module is
 * dependency-free so both can import it without a cycle.
 *
 * @module scripts/lib/file-taxonomy
 */

/**
 * Programming languages, by id. `extensions` carry the leading dot.
 * `comment` is the line-comment prefix used for advisory annotation markers (`null`: the language has no safe `//`-style
 * line comment — markup-embedded — so no marker lines are injected). Absent means `//`.
 * `fence` is the code-fence tag sent to the model. The `js`/`ts` fences are
 * deliberately both `js`: that is what every existing prompt already carried,
 * and changing it would perturb prompt bytes (and any prompt cache keyed on
 * them) for no audit benefit.
 */
const LANGUAGE_DEFS = [
  { id: 'js', extensions: ['.js', '.mjs', '.cjs', '.jsx'], fence: 'js' },
  { id: 'ts', extensions: ['.ts', '.tsx', '.mts', '.cts'], fence: 'js' },
  { id: 'py', extensions: ['.py', '.pyi'], fence: 'python', comment: '#' },
  { id: 'cs', extensions: ['.cs'], fence: 'csharp' },
  { id: 'go', extensions: ['.go'], fence: 'go' },
  { id: 'rs', extensions: ['.rs'], fence: 'rust' },
  { id: 'java', extensions: ['.java'], fence: 'java' },
  { id: 'kt', extensions: ['.kt', '.kts'], fence: 'kotlin' },
  { id: 'swift', extensions: ['.swift'], fence: 'swift' },
  { id: 'rb', extensions: ['.rb'], fence: 'ruby', comment: '#' },
  { id: 'php', extensions: ['.php'], fence: 'php' },
  { id: 'c', extensions: ['.c', '.h'], fence: 'c' },
  { id: 'cpp', extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'], fence: 'cpp' },
  { id: 'scala', extensions: ['.scala'], fence: 'scala' },
  { id: 'dart', extensions: ['.dart'], fence: 'dart' },
  { id: 'fs', extensions: ['.fs', '.fsx'], fence: 'fsharp' },
  { id: 'vb', extensions: ['.vb'], fence: 'vb' },
  { id: 'ex', extensions: ['.ex', '.exs'], fence: 'elixir', comment: '#' },
  { id: 'lua', extensions: ['.lua'], fence: 'lua', comment: '--' },
  { id: 'groovy', extensions: ['.groovy'], fence: 'groovy' },
  { id: 'sh', extensions: ['.sh', '.bash', '.zsh'], fence: 'bash', comment: '#' },
  { id: 'ps1', extensions: ['.ps1', '.psm1'], fence: 'powershell', comment: '#' },
  { id: 'bat', extensions: ['.bat', '.cmd'], fence: 'bat', comment: 'REM' },
  { id: 'vue', extensions: ['.vue'], fence: 'html', comment: null },
  { id: 'svelte', extensions: ['.svelte'], fence: 'html', comment: null },
  { id: 'razor', extensions: ['.cshtml', '.razor'], fence: 'html', comment: null },
];

/** Reviewable config / markup / build definitions, by extension → fence. */
const DECLARATIVE_DEFS = [
  ['.json', 'json'], ['.jsonc', 'json'], ['.json5', 'json'],
  ['.yml', 'yaml'], ['.yaml', 'yaml'], ['.toml', 'toml'],
  ['.sql', 'sql'], ['.md', 'markdown'], ['.markdown', 'markdown'],
  ['.html', 'html'], ['.htm', 'html'],
  ['.css', 'css'], ['.scss', 'scss'], ['.less', 'less'], ['.sass', 'sass'],
  ['.xml', 'xml'], ['.xaml', 'xml'], ['.resx', 'xml'], ['.config', 'xml'],
  ['.csproj', 'xml'], ['.vbproj', 'xml'], ['.fsproj', 'xml'],
  ['.props', 'xml'], ['.targets', 'xml'], ['.slnx', 'xml'],
  ['.sln', 'text'], ['.proto', 'protobuf'], ['.graphql', 'graphql'], ['.gql', 'graphql'],
  ['.tf', 'hcl'], ['.gradle', 'groovy'],
];

/** Expected exclusions: binaries, assets, archives, data dumps, lock/map/snapshot files. */
const NON_CODE_EXTENSIONS_LIST = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg', '.avif', '.tif', '.tiff', '.psd',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.zip', '.gz', '.tgz', '.tar', '.7z', '.rar',
  '.dll', '.exe', '.pdb', '.so', '.dylib', '.bin', '.obj', '.class', '.jar', '.nupkg',
  '.mp3', '.mp4', '.mov', '.avi', '.wav', '.ogg', '.webm',
  '.lock', '.map', '.snap', '.csv', '.tsv', '.log', '.txt', '.ipynb',
  '.sqlite', '.db', '.pptx', '.docx', '.xlsx',
];

/** Generated-file compound suffixes → `non-code` (checked before the last extension). */
const GENERATED_SUFFIXES = [
  '.g.cs', '.g.i.cs', '.generated.cs', '.designer.cs', '.assemblyinfo.cs', '.assemblyattributes.cs',
  '.min.js', '.min.css', '.d.ts.map', '.js.map', '.css.map',
];

/** Compound suffixes that are a real declarative/source kind, mapped to the extension they stand for. */
export const COMPOUND_REFERENCE_SUFFIXES = Object.freeze({
  'html.template': 'html',
});

/** Exact filenames (case-sensitive, as their ecosystems are). Value: 'declarative' | 'non-code'. */
const EXACT_NAME_DEFS = {
  // lockfiles — machine-written, never reviewed by the audit
  'package-lock.json': 'non-code', 'yarn.lock': 'non-code', 'pnpm-lock.yaml': 'non-code',
  'packages.lock.json': 'non-code', 'Cargo.lock': 'non-code', 'poetry.lock': 'non-code',
  'Gemfile.lock': 'non-code', 'composer.lock': 'non-code', 'go.sum': 'non-code',
  'uv.lock': 'non-code', 'LICENSE': 'non-code', 'NOTICE': 'non-code',
  // extensionless build definitions
  Dockerfile: 'declarative', Makefile: 'declarative', Rakefile: 'declarative', Gemfile: 'declarative',
  Vagrantfile: 'declarative', Procfile: 'declarative', Jenkinsfile: 'declarative',
  CODEOWNERS: 'declarative', 'requirements.txt': 'declarative', 'go.mod': 'declarative',
  // dotfiles that carry repo policy
  '.gitignore': 'declarative', '.gitattributes': 'declarative', '.gitmodules': 'declarative',
  '.editorconfig': 'declarative', '.dockerignore': 'declarative', '.npmrc': 'declarative',
  '.nvmrc': 'declarative', '.prettierrc': 'declarative', '.eslintrc': 'declarative',
  '.eslintignore': 'declarative', '.auditignore': 'declarative', '.env.example': 'declarative',
};

/**
 * The extensionless names `buildFileReferenceRegex` recognises in prose. Kept as
 * the historical seven: this is a reference-extraction list (a plan cites
 * `Dockerfile`), not the admission table above.
 */
export const KNOWN_EXTENSIONLESS_FILENAMES = Object.freeze([
  'Dockerfile', 'Makefile', 'Rakefile', 'Gemfile', 'Vagrantfile', 'Procfile', 'Jenkinsfile',
]);

// ── Derived tables (built once; every consumer reads these) ─────────────────

export const LANGUAGES = Object.freeze(
  LANGUAGE_DEFS.map((l) => Object.freeze({ ...l, extensions: Object.freeze([...l.extensions]) })),
);

const LANGUAGE_BY_EXT = new Map();
for (const l of LANGUAGES) for (const e of l.extensions) LANGUAGE_BY_EXT.set(e, l);

const DECLARATIVE_FENCE = new Map(DECLARATIVE_DEFS);

/** Extension (with dot) -> code-fence tag, for every source and declarative extension. */
export const EXTENSION_FENCES = Object.freeze(Object.fromEntries([
  ...LANGUAGES.flatMap((l) => l.extensions.map((e) => [e, l.fence])),
  ...DECLARATIVE_DEFS,
]));
const NON_CODE_SET = new Set(NON_CODE_EXTENSIONS_LIST);
const EXACT_NAMES = new Map(Object.entries(EXACT_NAME_DEFS));

/** Every source-language extension (with leading dot). */
export const SOURCE_CODE_EXTENSIONS = Object.freeze([...LANGUAGE_BY_EXT.keys()]);
export const DECLARATIVE_EXTENSIONS = Object.freeze(DECLARATIVE_DEFS.map(([e]) => e));
export const NON_CODE_EXTENSIONS = Object.freeze([...NON_CODE_EXTENSIONS_LIST]);
/** Extensions the audit will read: source + declarative (with leading dot). */
export const AUDITABLE_EXTENSIONS = Object.freeze([...SOURCE_CODE_EXTENSIONS, ...DECLARATIVE_EXTENSIONS]);

/** Look up a language entry by id, or null. */
export function languageById(id) {
  return LANGUAGES.find((l) => l.id === id) || null;
}

/** The language entry that owns `ext` (leading dot, any case), or null. */
export function languageForExtension(ext) {
  return LANGUAGE_BY_EXT.get(String(ext).toLowerCase()) || null;
}

function baseName(filePath) {
  const norm = String(filePath).replace(/\\/g, '/');
  return norm.slice(norm.lastIndexOf('/') + 1);
}

/**
 * Classify a path. Pure; path only.
 * @param {string} filePath
 * @returns {{kind: 'source'|'declarative'|'non-code'|'uncovered',
 *   language: string|null, extension: string|null, rule: string}}
 *   `extension` has NO leading dot (the admission oracle's historical shape); for an
 *   exact-name match it is the lower-cased name.
 */
export function matchFileKind(filePath) {
  const base = baseName(filePath);
  const lower = base.toLowerCase();

  // 1. exact filename
  const exact = EXACT_NAMES.get(base);
  if (exact) return { kind: exact, language: null, extension: lower, rule: `name:${base}` };

  // 2. compound suffix
  for (const suffix of GENERATED_SUFFIXES) {
    if (lower.endsWith(suffix)) return { kind: 'non-code', language: null, extension: suffix.slice(1), rule: `generated:${suffix}` };
  }
  for (const [suffix, ext] of Object.entries(COMPOUND_REFERENCE_SUFFIXES)) {
    if (lower.endsWith(`.${suffix}`)) return { kind: 'declarative', language: null, extension: ext, rule: `compound:${suffix}` };
  }

  // 3. last extension. `dot > 0` so a bare dotfile (`.env`) has NO extension.
  const dot = lower.lastIndexOf('.');
  if (dot > 0) {
    const ext = lower.slice(dot);
    const lang = LANGUAGE_BY_EXT.get(ext);
    if (lang) return { kind: 'source', language: lang.id, extension: ext.slice(1), rule: `ext:${ext}` };
    if (DECLARATIVE_FENCE.has(ext)) return { kind: 'declarative', language: null, extension: ext.slice(1), rule: `ext:${ext}` };
    if (NON_CODE_SET.has(ext)) return { kind: 'non-code', language: null, extension: ext.slice(1), rule: `ext:${ext}` };
  }

  // 4. unrecognised — the caller must report it, never drop it silently.
  return { kind: 'uncovered', language: null, extension: dot > 0 ? lower.slice(dot + 1) : null, rule: 'none' };
}

/** Label for a `uncoveredByExtension` bucket: the extension, or a fixed word for none. */
export function extensionLabel(filePath) {
  const m = matchFileKind(filePath);
  if (m.extension) return m.extension;
  return '(no extension)';
}

/**
 * Code-fence language tag for a path. Unknown extensions keep the historical
 * `js` fallback — an admitted file always has an entry, so the fallback only
 * serves paths that were never admitted.
 */
export function fenceLanguageFor(filePath) {
  const lower = baseName(filePath).toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot > 0) {
    const ext = lower.slice(dot);
    const lang = LANGUAGE_BY_EXT.get(ext);
    if (lang) return lang.fence;
    const decl = DECLARATIVE_FENCE.get(ext);
    if (decl) return decl;
  }
  return 'js';
}

/**
 * Pipe-joined, regex-ready extension alternation, LONGEST-FIRST. The ordering is load-bearing: JS regex
 * alternation is first-match-wins, so a `js|…|json` list matches `config.json` as `config.js` and leaves `on`
 * behind. Lives here (dependency-free) so every extension list in the bundle gets the ordering from ONE place.
 *
 * @param {Iterable<string>} extensions
 * @returns {string}
 */
export function toExtensionAlternation(extensions) {
  return [...extensions].sort((a, b) => b.length - a.length).join('|');
}

/**
 * The line-comment prefix for annotation markers in `filePath`'s language: '//' by default, the language's own when it has one,
 * or `null` when the language has no safe line comment (markup-embedded: vue, svelte, razor). Non-language files: '//'.
 */
export function commentPrefixFor(filePath) {
  const lower = baseName(filePath).toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot > 0) {
    const lang = LANGUAGE_BY_EXT.get(lower.slice(dot));
    if (lang && 'comment' in lang) return lang.comment;
  }
  return '//';
}

/** Escape a string for use inside a RegExp source. */
function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Regex alternation (no dots, no anchors) of every SOURCE-language extension —
 * the sensitive-path code carve-out uses it so `Token.cs` is a code file the same
 * way `tokens.mjs` is, from ONE list.
 */
export const SOURCE_CODE_EXTENSION_ALTERNATION = SOURCE_CODE_EXTENSIONS
  .map((e) => reEscape(e.slice(1)))
  .sort((a, b) => b.length - a.length)
  .join('|');

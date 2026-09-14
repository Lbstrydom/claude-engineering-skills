/**
 * @fileoverview Binding-resolution primitives for static-analysis guards that
 * must prove an identifier is a genuine reference to an expected import — not
 * a shadowing parameter/local/catch binding, and not a call through the wrong
 * module — plus one pure structural shape detector these guards also need.
 *
 * `scope.getBinding(name)` is three-valued: it resolves to the expected
 * import, resolves to something else (shadowed), or does not resolve at all
 * (unresolvable). Both binding predicates below collapse that to a boolean
 * only at the very end, treating "shadowed" and "unresolvable" identically —
 * neither is evidence the reference is safe. See `ast.mjs`'s own docstring
 * for why a hand-rolled walker cannot do this; `@babel/traverse`'s `Scope`
 * API is the established primitive here (`find-rmsync-sites.mjs`,
 * `tests/rmsync-retry-guard.test.mjs`, `adjacency-detector.mjs`).
 *
 * @module scripts/lib/import-binding
 */
import path from 'node:path';

/**
 * A `spec` names the expected module by exactly one of two forms — a set of
 * literal source strings (for a builtin with no filesystem path, e.g. `fs`),
 * or an absolute path pair to resolve a relative specifier against (for an
 * in-repo module). Supplying both or neither is a caller bug and throws
 * rather than silently degrading into a permissive match.
 * @param {{moduleSources?: Set<string>, moduleAbsPath?: string, fromFileAbsPath?: string}} spec
 */
function validateModuleSourceSpec(spec) {
  const hasModuleSources = spec.moduleSources !== undefined;
  const hasModuleAbsPath = spec.moduleAbsPath !== undefined;
  const hasFromFileAbsPath = spec.fromFileAbsPath !== undefined;
  const hasAnyAbsPathField = hasModuleAbsPath || hasFromFileAbsPath;
  const hasCompleteAbsPathForm = hasModuleAbsPath && hasFromFileAbsPath;

  if (hasModuleSources && hasAnyAbsPathField) {
    throw new Error(
      'import-binding: spec must supply exactly one of {moduleSources} or '
      + '{moduleAbsPath, fromFileAbsPath}, not both',
    );
  }
  // A stray single abs-path field (the pair's other half omitted) is just as
  // much a caller bug as supplying both forms or neither — silently falling
  // through to "neither form matched" would mask it the same way.
  if (hasAnyAbsPathField && !hasCompleteAbsPathForm) {
    throw new Error(
      'import-binding: spec supplied only one of {moduleAbsPath, fromFileAbsPath} '
      + '— both are required together',
    );
  }
  if (!hasModuleSources && !hasCompleteAbsPathForm) {
    throw new Error(
      'import-binding: spec must supply exactly one of {moduleSources} or '
      + '{moduleAbsPath, fromFileAbsPath}, neither was given',
    );
  }
}

/** @param {import('@babel/traverse').NodePath} importDeclPath */
function moduleSourceMatches(importDeclPath, spec) {
  if (spec.moduleSources !== undefined) {
    return spec.moduleSources.has(importDeclPath.node.source.value);
  }
  const resolved = path.resolve(path.dirname(spec.fromFileAbsPath), importDeclPath.node.source.value);
  return resolved === spec.moduleAbsPath;
}

/**
 * Does `identifierPath` resolve, via real lexical scope, to a **named**
 * import binding matching `spec.importedName` from the module `spec` names?
 *
 * The local spelling is read exclusively from `identifierPath.node.name` —
 * never passed in, so it cannot disagree with the node being resolved. The
 * exported spelling is `spec.importedName`, checked against the resolved
 * `ImportSpecifier`'s `imported.name` (ordinary spelling) or `imported.value`
 * (ES2022 arbitrary-module-namespace-name string-literal spelling) — both are
 * valid syntax and must resolve identically.
 *
 * @param {import('@babel/traverse').NodePath} identifierPath - the Identifier reference to check
 * @param {{importedName: string, moduleSources?: Set<string>, moduleAbsPath?: string, fromFileAbsPath?: string}} spec
 * @returns {boolean}
 */
export function resolvesToNamedImport(identifierPath, spec) {
  return resolveNamedImportBinding(identifierPath, spec) === 'matched';
}

/**
 * Same resolution as `resolvesToNamedImport`, but returns a discriminated
 * three-valued result instead of collapsing to a boolean — for a caller that
 * needs to distinguish "resolves to something else" (`'different-binding'`)
 * from "doesn't resolve at all" (`'unresolvable'`) without re-deriving
 * `scope.getBinding()` itself. Two independent binding lookups for the same
 * identifier, in two different files, is exactly the drift-prone duplication
 * this module exists to remove (round-3 M4) — `resolvesToNamedImport` above
 * is a thin projection of this, kept because most callers (e.g.
 * `find-rmsync-sites.mjs`) only ever need match-vs-non-match and a shadow or
 * an unresolvable identifier are equally "not the import" for them.
 *
 * @param {import('@babel/traverse').NodePath} identifierPath - the Identifier reference to check
 * @param {{importedName: string, moduleSources?: Set<string>, moduleAbsPath?: string, fromFileAbsPath?: string}} spec
 * @returns {'matched'|'different-binding'|'unresolvable'}
 */
export function resolveNamedImportBinding(identifierPath, spec) {
  validateModuleSourceSpec(spec);
  const localName = identifierPath.node.name;
  const binding = identifierPath.scope.getBinding(localName);
  if (!binding) return 'unresolvable';
  if (!binding.path.isImportSpecifier()) return 'different-binding';
  const declPath = binding.path;
  const importedName = declPath.node.imported?.name ?? declPath.node.imported?.value;
  if (importedName !== spec.importedName) return 'different-binding';
  const importDecl = declPath.parentPath;
  if (!importDecl?.isImportDeclaration()) return 'different-binding';
  return moduleSourceMatches(importDecl, spec) ? 'matched' : 'different-binding';
}

/**
 * Does `identifierPath` resolve, via real lexical scope, to a **module-object**
 * binding — `ImportDefaultSpecifier`, `ImportNamespaceSpecifier`, or an
 * `ImportSpecifier` whose imported name/value is `default` — from the module
 * `spec` names? All three produce a local binding used identically at a call
 * site (`fs.renameSync(...)`), so one rule covers them.
 *
 * @param {import('@babel/traverse').NodePath} identifierPath - the Identifier reference to check
 * @param {{moduleSources?: Set<string>, moduleAbsPath?: string, fromFileAbsPath?: string}} spec
 * @returns {boolean}
 */
export function resolvesToModuleBinding(identifierPath, spec) {
  validateModuleSourceSpec(spec);
  const localName = identifierPath.node.name;
  const binding = identifierPath.scope.getBinding(localName);
  if (!binding || !binding.path) return false;
  const declPath = binding.path;
  const importedName = declPath.node?.imported?.name ?? declPath.node?.imported?.value;
  const isDefaultLike = declPath.isImportDefaultSpecifier()
    || declPath.isImportNamespaceSpecifier()
    || (declPath.isImportSpecifier() && importedName === 'default');
  if (!isDefaultLike) return false;
  const importDecl = declPath.parentPath;
  if (!importDecl?.isImportDeclaration()) return false;
  return moduleSourceMatches(importDecl, spec);
}

/**
 * Find the `ObjectProperty` inside `objectPatternPath.properties` whose LOCAL
 * binding is `localName` — matching on the value side (`value.name` for a
 * bare `{ x }`, or `value.left.name` for a defaulted `{ x = … }`), never the
 * key, so a rename (`{ rmSync: rm }`) is found by its local name `rm`.
 * @param {import('@babel/traverse').NodePath} objectPatternPath
 * @param {string} localName
 * @returns {import('@babel/traverse').NodePath|null} the matching ObjectProperty path, or null
 */
function findObjectPatternProperty(objectPatternPath, localName) {
  for (const propPath of objectPatternPath.get('properties')) {
    if (!propPath.isObjectProperty()) continue; // skips RestElement
    const { value } = propPath.node;
    const boundName = value.type === 'Identifier' ? value.name
      : (value.type === 'AssignmentPattern' && value.left.type === 'Identifier' ? value.left.name : null);
    if (boundName === localName) return propPath;
  }
  return null;
}

/**
 * Does `identifierPath` resolve, via real lexical scope, to a local alias of
 * one specific property on a resolved module-namespace binding? Three shapes,
 * all found missing entirely — `find-rmsync-sites.mjs` (the one caller today)
 * only ever recognised a DIRECT named import — in aged-out-acceptance-
 * remainder.md §3 (`b091a8ab`):
 *
 * 1. **Member-expression alias**: `const rm = fs.rmSync;`.
 * 2. **Destructured from the namespace**: `const { rmSync } = fs;`, including
 *    a rename (`const { rmSync: rm } = fs;`).
 * 3. **A destructured parameter's OWN per-property default is the member
 *    expression**: `function f({ rmSyncFn = fs.rmSync } = {}) {…}` — the
 *    live instance (`scripts/regenerate-skill-copies.mjs`). Note this is
 *    NOT shape 2: the property key (`rmSyncFn`) need not be `rmSync` at
 *    all — nothing is destructured FROM `fs` here, since a function
 *    parameter's object comes from the CALLER's argument. What matters is
 *    that the property's own default value, used when the caller omits it,
 *    is `fs.rmSync`. Babel's `scope.getBinding().path` for this shape is the
 *    ENCLOSING pattern (bare `ObjectPattern`, or the `AssignmentPattern`
 *    wrapping it when the whole parameter also has a `= {}` default) — never
 *    the inner per-property `AssignmentPattern` directly, which is why the
 *    object pattern has to be located and searched rather than read straight
 *    off `declPath`.
 *
 * A shadowing local (a parameter or variable that merely happens to be named
 * `fs`) is excluded the same way `resolvesToModuleBinding` excludes it — by
 * requiring the object identifier to resolve there via real scope, not by
 * name.
 *
 * @param {import('@babel/traverse').NodePath} identifierPath - the Identifier reference to check
 * @param {{propertyName: string, moduleSources?: Set<string>, moduleAbsPath?: string, fromFileAbsPath?: string}} spec
 * @returns {boolean}
 */
export function resolvesToAliasedModuleProperty(identifierPath, spec) {
  validateModuleSourceSpec(spec);
  const localName = identifierPath.node.name;
  const binding = identifierPath.scope.getBinding(localName);
  if (!binding || !binding.path) return false;
  const declPath = binding.path;

  const memberMatchesProperty = (memberExprPath) => {
    // `.get('init')` on a `VariableDeclarator` with NO initializer (`let x;`)
    // returns a real, truthy NodePath wrapping a null node — `!memberExprPath`
    // alone does not catch that; `.node` itself must be checked first.
    if (!memberExprPath?.node || memberExprPath.node.type !== 'MemberExpression') return false;
    const { computed, property } = memberExprPath.node;
    const matchesName = computed
      ? property.type === 'StringLiteral' && property.value === spec.propertyName
      : property.type === 'Identifier' && property.name === spec.propertyName;
    if (!matchesName) return false;
    const objectPath = memberExprPath.get('object');
    return objectPath.isIdentifier() && resolvesToModuleBinding(objectPath, spec);
  };

  // Shape 1: `const rm = fs.rmSync;`
  if (declPath.isVariableDeclarator() && declPath.node.id.type === 'Identifier') {
    return memberMatchesProperty(declPath.get('init'));
  }
  // Shape 1, bare default parameter (no destructuring): `function f(rm = fs.rmSync) {…}`
  if (declPath.isAssignmentPattern() && declPath.node.left.type === 'Identifier') {
    return memberMatchesProperty(declPath.get('right'));
  }
  // Shape 2: `const { rmSync } = fs;` / `const { rmSync: rm } = fs;`
  if (declPath.isVariableDeclarator() && declPath.node.id.type === 'ObjectPattern') {
    const initPath = declPath.get('init');
    if (initPath.isIdentifier() && resolvesToModuleBinding(initPath, spec)) {
      const propPath = findObjectPatternProperty(declPath.get('id'), localName);
      const keyNode = propPath?.node.key;
      const keyName = propPath && !propPath.node.computed && keyNode.type === 'Identifier' ? keyNode.name
        : (propPath?.node.computed && keyNode.type === 'StringLiteral' ? keyNode.value : null);
      if (keyName === spec.propertyName) return true;
    }
    // Fall through: the pattern itself might ALSO carry a per-property
    // default (shape 3) if `init` didn't resolve to the namespace directly.
  }
  // Shape 3: a destructured parameter whose property default is the member
  // expression — `objectPatternPath` is `declPath` itself when the whole
  // parameter has no `= {}` default, or `declPath.left` when it does.
  const objectPatternPath = declPath.isObjectPattern() ? declPath
    : (declPath.isAssignmentPattern() && declPath.node.left.type === 'ObjectPattern' ? declPath.get('left') : null);
  if (objectPatternPath) {
    const propPath = findObjectPatternProperty(objectPatternPath, localName);
    if (propPath?.node.value.type === 'AssignmentPattern') {
      return memberMatchesProperty(propPath.get('value.right'));
    }
  }

  return false;
}

/**
 * Classify the `wrapper(() => site)` / `wrapper(() => { return site; })`
 * shape from a call site's ancestor chain (root-to-immediate-parent raw-node
 * order) — the single authoritative implementation of this ancestor-chain
 * grammar, so a sync-only consumer (`findSyncCallbackWrapper`) and a
 * diagnostic consumer that also needs to name the async case (round-5 M1)
 * never carry two copies that can drift apart.
 *
 * A raw-node, shape-only, binding-free contract by design: this answers only
 * "is there a single-arrow-argument call wrapping this site, and is that
 * arrow sync or async", never "does the wrapper identifier resolve to a real
 * import" — that is a separate binding question a caller composes on top
 * (e.g. via `resolvesToNamedImport`/`resolveNamedImportBinding` on the
 * returned node's `.callee`).
 *
 * @param {object} siteNode - the call site node being tested for a wrapper
 * @param {object[]} ancestors - root-to-immediate-parent raw nodes, e.g.
 *   `path.getAncestry().slice(1).reverse().map((p) => p.node)`
 * @returns {{status: 'sync-wrapper'|'async-wrapper'|'no-wrapper', callNode: object|null}}
 */
export function classifyCallbackWrapper(siteNode, ancestors) {
  const n = ancestors.length;
  if (n === 0) return { status: 'no-wrapper', callNode: null };

  const immediateParent = ancestors[n - 1];
  let arrowFn = null;

  if (immediateParent.type === 'ArrowFunctionExpression' && immediateParent.body === siteNode) {
    // Concise-body arrow: () => site
    arrowFn = immediateParent;
  } else if (immediateParent.type === 'ReturnStatement' && n >= 3) {
    // Block-body arrow: () => { return site; }
    const blockParent = ancestors[n - 2];
    const arrowParent = ancestors[n - 3];
    if (
      blockParent?.type === 'BlockStatement'
      && arrowParent?.type === 'ArrowFunctionExpression'
      && arrowParent.body === blockParent
    ) {
      arrowFn = arrowParent;
    }
  }

  if (!arrowFn) return { status: 'no-wrapper', callNode: null };

  const arrowIdx = ancestors.lastIndexOf(arrowFn);
  if (arrowIdx <= 0) return { status: 'no-wrapper', callNode: null };
  const outerCall = ancestors[arrowIdx - 1];
  const isWrapperCall = outerCall?.type === 'CallExpression'
    && outerCall.arguments.length === 1
    && outerCall.arguments[0] === arrowFn;
  if (!isWrapperCall) return { status: 'no-wrapper', callNode: null };

  return { status: arrowFn.async ? 'async-wrapper' : 'sync-wrapper', callNode: outerCall };
}

/**
 * Thin sync-only projection of `classifyCallbackWrapper`, kept as the
 * boolean-shaped ("wrapper, or not") contract `find-rmsync-sites.mjs` needs.
 *
 * An `async` arrow is NOT recognized as this wrapping shape: a synchronous
 * retry helper's `try/catch` cannot catch a rejection from a Promise an async
 * callback returns immediately, so the call is not actually retry-protected
 * at runtime despite superficially matching the shape. This projection is
 * fixed on purpose — a caller needing to distinguish "no wrapper at all"
 * from "an async wrapper" should call `classifyCallbackWrapper` directly
 * rather than widening this one with a flag that could be misused to accept
 * an async wrapper as retry-protecting.
 *
 * @param {object} siteNode
 * @param {object[]} ancestors
 * @returns {object|null}
 */
export function findSyncCallbackWrapper(siteNode, ancestors) {
  const result = classifyCallbackWrapper(siteNode, ancestors);
  return result.status === 'sync-wrapper' ? result.callNode : null;
}

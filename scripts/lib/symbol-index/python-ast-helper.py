"""Python parser stage for the architectural-memory symbol index.

Driven by its sibling module python-extract.mjs (same directory). Protocol,
one JSON object per line on stdin and stdout:

  -> {"v":1,"hello":true}
  <- {"v":1,"hello":true,"python":"3.x.y"}
  -> {"v":1,"id":N,"rel":"pkg/mod.py","b64":"<source bytes>","wantSymbols":true}
  <- {"v":1,"id":N,"ok":true,"symbols":[...],"imports":[...]}
   | {"v":1,"id":N,"ok":false,"error":{"kind":"syntax|decode|internal","message":"..."}}

This script opens NO files and walks no directories: Node admits each file
through the sensitive-path egress gate, reads the bytes itself, and sends them
here. Run as `python -I -B` (isolated: no PYTHON* env, no user site, no cwd on
sys.path; no bytecode written). Standard library only; Python >= 3.9.
"""

import ast
import base64
import io
import json
import sys
import textwrap
import tokenize

PROTOCOL_VERSION = 1
MAX_MESSAGE = 200


def _write(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _decode(raw):
    """Decode source bytes the way the interpreter would (PEP 263 cookie + BOM)."""
    encoding, _ = tokenize.detect_encoding(io.BytesIO(raw).readline)
    text = raw.decode(encoding)  # strict: a bad byte raises
    if text.startswith("﻿"):
        text = text[1:]
    return text


def _literal_all(tree):
    """The module's __all__ when it is ONE literal list/tuple of strings, else None.

    Conservative on purpose: any second binding, augmented assignment
    (``__all__ += [...]``) or method call on it (``__all__.append``) makes the
    final value undecidable statically, so the caller falls back to the
    underscore convention rather than trusting the first assignment.
    """
    found = None
    bindings = 0
    for node in ast.walk(tree):
        if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            if any(isinstance(t, ast.Name) and t.id == "__all__" for t in targets):
                bindings += 1
                value = node.value
                if (isinstance(node, (ast.Assign, ast.AnnAssign)) and isinstance(value, (ast.List, ast.Tuple))
                        and all(isinstance(e, ast.Constant) and isinstance(e.value, str) for e in value.elts)):
                    found = {e.value for e in value.elts}
        elif (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
              and isinstance(node.func.value, ast.Name) and node.func.value.id == "__all__"):
            bindings += 1
    return found if bindings == 1 else None


def _is_public(name):
    if name.startswith("__") and name.endswith("__"):
        return True
    return not name.startswith("_")


def _def_signature(node):
    prefix = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
    sig = "%s %s(%s)" % (prefix, node.name, ast.unparse(node.args))
    if node.returns is not None:
        sig += " -> " + ast.unparse(node.returns)
    return sig


def _class_signature(node):
    parts = [ast.unparse(b) for b in node.bases]
    parts += [ast.unparse(k) for k in node.keywords]
    return "class %s(%s)" % (node.name, ", ".join(parts)) if parts else "class %s" % node.name


def _span(node):
    """(start, end) lines of a definition, decorators included."""
    start = min([node.lineno] + [d.lineno for d in getattr(node, "decorator_list", [])])
    return start, getattr(node, "end_lineno", None) or node.lineno


def _symbol(node, lines, name, kind, signature, exported):
    start, end = _span(node)
    return {
        "symbolName": name,
        "kind": kind,
        "startLine": start,
        "endLine": end,
        "signature": signature,
        # Whole source lines, decorators included. The docstring travels INSIDE
        # bodyText only; there is deliberately no separate docstring field that
        # could bypass the body secret scrub.
        "bodyText": textwrap.dedent("".join(lines[start - 1:end])).rstrip("\r\n"),
        "isExported": bool(exported),
    }


# Statements whose bodies are still the enclosing scope (a def under
# `if TYPE_CHECKING:` or `try: ... except ImportError:` is module-level).
_BLOCKS = (ast.If, ast.Try, ast.With, ast.AsyncWith) + ((ast.TryStar,) if hasattr(ast, "TryStar") else ())


def _scope_defs(body):
    """Definitions in a scope, descending into control-flow blocks but never into defs."""
    for node in body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            yield node
        elif isinstance(node, _BLOCKS):
            children = list(node.body) + list(getattr(node, "orelse", [])) + list(getattr(node, "finalbody", []))
            for h in getattr(node, "handlers", []):
                children += h.body
            yield from _scope_defs(children)


def extract_symbols(tree, text):
    declared = _literal_all(tree)
    lines = text.splitlines(keepends=True)  # once per file, not once per symbol

    def exported(name):
        return name in declared if declared is not None else _is_public(name)

    out = []
    for node in _scope_defs(tree.body):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            out.append(_symbol(node, lines, node.name, "function", _def_signature(node), exported(node.name)))
            continue
        cls_exported = exported(node.name)
        out.append(_symbol(node, lines, node.name, "class", _class_signature(node), cls_exported))
        for item in _scope_defs(node.body):
            if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                out.append(_symbol(
                    item, lines, "%s.%s" % (node.name, item.name), "method",
                    _def_signature(item), cls_exported and _is_public(item.name),
                ))
    return out


def extract_imports(tree):
    """Import refs in the shape arch-intent's resolvePythonImport consumes."""
    refs = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                refs.append({
                    "kind": "import", "module": alias.name, "names": [],
                    "isRelative": False, "dotCount": 0, "line": node.lineno,
                })
        elif isinstance(node, ast.ImportFrom):
            level = node.level or 0
            refs.append({
                "kind": "from", "module": node.module or "",
                "names": [a.name for a in node.names],
                "isRelative": level > 0, "dotCount": level, "line": node.lineno,
            })
    refs.sort(key=lambda r: (r["line"], r["module"]))
    return refs


def handle(req):
    rid = req.get("id")
    rel = str(req.get("rel") or "<source>")
    try:
        raw = base64.b64decode(req.get("b64") or "", validate=True)
    except (ValueError, TypeError) as err:
        return {"v": PROTOCOL_VERSION, "id": rid, "ok": False,
                "error": {"kind": "internal", "message": ("bad b64: %s" % err)[:MAX_MESSAGE]}}
    try:
        text = _decode(raw)
    except (SyntaxError, UnicodeDecodeError, LookupError) as err:
        return {"v": PROTOCOL_VERSION, "id": rid, "ok": False,
                "error": {"kind": "decode", "message": str(err)[:MAX_MESSAGE]}}
    try:
        tree = ast.parse(text, filename=rel)
    except (SyntaxError, ValueError, RecursionError) as err:
        return {"v": PROTOCOL_VERSION, "id": rid, "ok": False,
                "error": {"kind": "syntax", "message": str(err)[:MAX_MESSAGE]}}
    symbols = extract_symbols(tree, text) if req.get("wantSymbols") else []
    return {"v": PROTOCOL_VERSION, "id": rid, "ok": True, "symbols": symbols, "imports": extract_imports(tree)}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            _write({"v": PROTOCOL_VERSION, "id": None, "ok": False,
                    "error": {"kind": "internal", "message": "request is not JSON"}})
            continue
        if not isinstance(req, dict) or req.get("v") != PROTOCOL_VERSION:
            _write({"v": PROTOCOL_VERSION, "id": None, "ok": False,
                    "error": {"kind": "internal", "message": "unsupported protocol version"}})
            continue
        if req.get("hello"):
            _write({"v": PROTOCOL_VERSION, "hello": True, "python": "%d.%d.%d" % sys.version_info[:3]})
            continue
        try:
            _write(handle(req))
        except Exception as err:  # one bad file never fails the batch
            _write({"v": PROTOCOL_VERSION, "id": req.get("id"), "ok": False,
                    "error": {"kind": "internal", "message": ("%s: %s" % (type(err).__name__, err))[:MAX_MESSAGE]}})


if __name__ == "__main__":
    main()

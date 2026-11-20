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
    """The module's __all__ when it is a literal list/tuple of strings, else None."""
    for node in tree.body:
        targets = []
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            targets = [node.target]
        for t in targets:
            if isinstance(t, ast.Name) and t.id == "__all__":
                value = node.value
                if isinstance(value, (ast.List, ast.Tuple)) and all(
                    isinstance(e, ast.Constant) and isinstance(e.value, str) for e in value.elts
                ):
                    return {e.value for e in value.elts}
                return None
    return None


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


def _symbol(node, text, name, kind, signature, exported):
    return {
        "symbolName": name,
        "kind": kind,
        "startLine": node.lineno,
        "endLine": getattr(node, "end_lineno", None) or node.lineno,
        "signature": signature,
        # The docstring travels INSIDE bodyText only; there is deliberately no
        # separate docstring field that could bypass the body secret scrub.
        "bodyText": ast.get_source_segment(text, node) or "",
        "isExported": bool(exported),
    }


def extract_symbols(tree, text):
    declared = _literal_all(tree)

    def exported(name):
        return name in declared if declared is not None else _is_public(name)

    out = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            out.append(_symbol(node, text, node.name, "function", _def_signature(node), exported(node.name)))
        elif isinstance(node, ast.ClassDef):
            cls_exported = exported(node.name)
            out.append(_symbol(node, text, node.name, "class", _class_signature(node), cls_exported))
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    out.append(_symbol(
                        item, text, "%s.%s" % (node.name, item.name), "method",
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

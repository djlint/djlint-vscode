"""Minify Python for the bundle, for build/esbuild-worker.mjs.

Usage: python minify_python.py [GLOBAL...] < SOURCE > MINIFIED

python-minifier removes the annotations, but not what only they need: the
imports under `if TYPE_CHECKING:`, TYPE_CHECKING itself and the future import
of annotations. These go first. The GLOBALs keep their names, for the code that
calls them.
"""

from __future__ import annotations

import ast
import sys

import python_minifier


def _is_type_checking(test: ast.expr) -> bool:
    if isinstance(test, ast.Name):
        return test.id == "TYPE_CHECKING"
    return (
        isinstance(test, ast.Attribute)
        and test.attr == "TYPE_CHECKING"
        and isinstance(test.value, ast.Name)
        and test.value.id == "typing"
    )


def _without(node: ast.ImportFrom, name: str) -> list[ast.stmt]:
    names = [alias for alias in node.names if alias.name != name]
    if not names:
        return []
    node.names = names
    return [node]


def _strip(statement: ast.stmt) -> list[ast.stmt]:
    if isinstance(statement, ast.If) and _is_type_checking(statement.test):
        return statement.orelse
    if isinstance(statement, ast.ImportFrom) and statement.level == 0:
        if statement.module == "__future__":
            return _without(statement, "annotations")
        if statement.module == "typing":
            return _without(statement, "TYPE_CHECKING")
    return [statement]


def strip_typing(source: str) -> str:
    """Drop what only type checkers and annotations use, at the module's top level."""
    module = ast.parse(source)
    module.body = [kept for statement in module.body for kept in _strip(statement)]
    if any(isinstance(node, ast.Name) and node.id == "TYPE_CHECKING" for node in ast.walk(module)):
        msg = "TYPE_CHECKING is used other than in an `if` at the top level"
        raise SystemExit(msg)
    return ast.unparse(module)


def minify(source: str, preserve_globals: list[str]) -> str:
    return python_minifier.minify(
        strip_typing(source),
        remove_literal_statements=True,
        rename_globals=True,
        preserve_globals=preserve_globals,
    )


def main() -> None:
    # As bytes, so that Windows neither reads in its code page nor writes CRLF.
    source = sys.stdin.buffer.read().decode()
    sys.stdout.buffer.write(minify(source, sys.argv[1:]).encode())


if __name__ == "__main__":
    main()

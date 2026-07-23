// Python loaded into the Pyodide runtime, defining `_djlint_format` and `_djlint_lint`.
export const GLUE = `
from pathlib import Path

from djlint.lint import linter
from djlint.reformat import formatter
from djlint.settings import Config

_PATH_OPTIONS = ("configuration", "rules")


def _make_config(options):
    opts = dict(options)
    for key in _PATH_OPTIONS:
        value = opts.get(key)
        if value is not None:
            opts[key] = Path(value)
    return Config("-", **opts)


def _djlint_format(src, options):
    return formatter(_make_config(options), src)


def _djlint_lint(src, options):
    errors = linter(_make_config(options), src, "-", "-")["-"]
    result = []
    for error in errors:
        line, _, column = str(error["line"]).partition(":")
        result.append(
            {
                "code": error["code"],
                "line": int(line),
                "column": int(column) if column else 0,
                "message": error["message"],
            }
        )
    return result
`;

// Python loaded into the Pyodide runtime, defining `_djlint_format` and `_djlint_lint`.
export const GLUE = `
from djlint.lint import linter
from djlint.reformat import formatter
from djlint.settings import Config

# _make_config() memoization: djLint's Config.__init__ does a project-root
# filesystem walk, a gitignore lookup, and ~20 re.compile() calls that don't
# depend on the passed options -- expensive to repeat on every format/lint
# RPC (one per keystroke-save) inside WASM. options no longer ever contains
# "configuration"/"rules" (see buildConfigKwargs() in kwargs.ts -- the
# bundled runtime has no access to the host filesystem those paths would
# point to), so every remaining value is a plain scalar/string, making a
# simple equality-keyed cache of the last call sufficient.
_config_cache_key = None
_config_cache_value = None


def _make_config(options):
    global _config_cache_key, _config_cache_value
    key = tuple(sorted(options.items()))
    if key != _config_cache_key:
        _config_cache_value = Config("-", **options)
        _config_cache_key = key
    return _config_cache_value


def _djlint_format(src, options, filename="-"):
    # filename is accepted (and currently unused) for symmetry with
    # _djlint_lint and in case a future djlint.formatter() gains filepath-
    # sensitive behavior (e.g. per-file rules).
    return formatter(_make_config(options), src)


def _djlint_lint(src, options, filename="-"):
    # djLint's linter() matches per-file-ignores patterns against the
    # filepath argument, so a real filename (not the "-" stdin placeholder)
    # is required for that feature to work.
    errors = linter(_make_config(options), src, filename, filename)[filename]
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

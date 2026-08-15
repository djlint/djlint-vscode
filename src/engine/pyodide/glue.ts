export const GLUE = `
from djlint.lint import linter
from djlint.reformat import formatter
from djlint.settings import Config

_config_cache_key = None
_config_cache_value = None


def _make_config(options):
    global _config_cache_key, _config_cache_value
    key = tuple(sorted(options.items()))
    if key != _config_cache_key:
        _config_cache_value = Config("-", **options)
        _config_cache_key = key
    return _config_cache_value


def _djlint_format(src, options):
    return formatter(_make_config(options), src)


def _djlint_lint(src, options, filename="-"):
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

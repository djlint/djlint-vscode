"""Run djLint the way its command line runs `djlint -`, for the worker."""

import importlib
import json
import os
import sys
from pathlib import Path
from shutil import rmtree

from djlint import process_stdin
from djlint.settings import Config
from djlint.src import has_pragma

# A project's rule module leaves no __pycache__ behind in the project.
sys.dont_write_bytecode = True

_HOME = os.getcwd()
_GUEST_ROOTS = ("/host/", "/project/")
_BASE_SYS_PATH = list(sys.path)
_PROJECT = Path("/project")


def _enter(cwd):
    """Enter the folder djLint looks for its configuration from."""
    try:
        os.chdir(cwd or _HOME)
    except OSError:
        os.chdir(_HOME)


def _write_project(project):
    """Lay out the project's files, for a document with no folder to mount."""
    rmtree(_PROJECT, ignore_errors=True)
    # Where djLint's search for a project root ends.
    (_PROJECT / ".git").mkdir(parents=True)
    for name, text in project["files"].items():
        path = (_PROJECT / name).resolve()
        if not path.is_relative_to(_PROJECT):
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    cwd = _PROJECT / project["cwd"]
    cwd.mkdir(parents=True, exist_ok=True)
    return str(cwd)


def _forget_project_modules():
    """Import a project's rule modules afresh, as a new process would."""
    for name, module in list(sys.modules.items()):
        if str(getattr(module, "__file__", "")).startswith(_GUEST_ROOTS):
            del sys.modules[name]
    importlib.invalidate_caches()


def run(mode, src, options, path_options, filename, cwd, project):
    """Return the formatted text, or the diagnostics as JSON."""
    _forget_project_modules()
    _enter(cwd if project is None else _write_project(json.loads(project)))
    is_format = mode == "format"
    config = Config(
        "-",
        lint=not is_format,
        reformat=is_format,
        stdin=True,
        stdin_filename=filename,
        **json.loads(options),
        **{name: Path(value) for name, value in json.loads(path_options).items()},
    )
    # Where a custom rule's python_module is, as for `python -m djlint`.
    sys.path[:] = [str(config.project_root), *_BASE_SYS_PATH]
    if config.require_pragma and not has_pragma(config, src.split("\n", 1)[0]):
        return src if is_format else "[]"
    output, formatted = process_stdin(config, src)
    if is_format:
        return formatted
    diagnostics = []
    for error in output["lint_message"][filename]:
        line, _, column = str(error["line"]).partition(":")
        diagnostics.append(
            {
                "code": error["code"],
                "column": int(column or 0),
                "line": int(line),
                "message": error["message"],
            }
        )
    return json.dumps(diagnostics)

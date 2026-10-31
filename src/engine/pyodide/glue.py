"""Run djLint for the worker, through its Python API."""

import importlib
import json
import os
import sys
from pathlib import Path
from shutil import rmtree

from djlint.api import format_text, lint_text, load_config

# A project's rule module leaves no __pycache__ behind in the project.
sys.dont_write_bytecode = True

_HOME = os.getcwd()
_GUEST_ROOTS = ("/host/", "/project/")
_BASE_SYS_PATH = list(sys.path)
_PROJECT = Path("/project")
_reported_rules = set()


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


def _is_project_module(module):
    """Tell by its file or, for a namespace package, by its folders."""
    locations = (getattr(module, "__file__", ""), *getattr(module, "__path__", ()))
    return any(str(location).startswith(_GUEST_ROOTS) for location in locations)


def _forget_projects():
    """Import a project's rule modules afresh, as a new process would."""
    for name, module in list(sys.modules.items()):
        if _is_project_module(module):
            del sys.modules[name]
    importlib.invalidate_caches()
    # djLint leaves the project root it looks for rule modules in.
    sys.path[:] = _BASE_SYS_PATH


def _report_skipped_rules(config):
    for name in config.skipped_rules:
        if name not in _reported_rules:
            _reported_rules.add(name)
            print(f"Skipping rule {name}: python_module is not available here.", file=sys.stderr)


def run(mode, src, options, path_options, filename, cwd, project):
    """Return the formatted text, or the diagnostics as JSON."""
    _forget_projects()
    if project is not None:
        folder = _write_project(json.loads(project))
    elif cwd and os.path.isdir(cwd):
        folder = cwd
    else:
        folder = _HOME
    config = load_config(
        folder,
        # What a project handed over holds is its configuration, not its code.
        python_rules=project is None,
        **json.loads(options),
        **{name: Path(value) for name, value in json.loads(path_options).items()},
    )
    _report_skipped_rules(config)
    if mode == "format":
        return format_text(config, src)
    # A rule module can count lines from zero.
    return json.dumps(
        [
            {
                "code": finding.code,
                "column": finding.column,
                "endColumn": finding.end_column,
                "endLine": max(finding.end_line, 1),
                "line": max(finding.line, 1),
                "message": finding.message,
            }
            for finding in lint_text(config, src, filename)
        ]
    )

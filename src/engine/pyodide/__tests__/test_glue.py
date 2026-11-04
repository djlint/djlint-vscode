from __future__ import annotations

import json
import os
import sys
from types import ModuleType
from typing import TYPE_CHECKING

import pytest

import glue

if TYPE_CHECKING:
    from collections.abc import Mapping
    from pathlib import Path

UGLY = '<div><p>hi</p>\n<img src="x.png">\n</div>'
DIRTY = '<div><img src="x.png"></div>'
ZERO_RULE = """\
def run(rule, *args, **kwargs):
    return [{"code": rule["name"], "line": "0:0", "match": "<", "message": rule["message"]}]
"""


# Every test, since glue.run would otherwise write to /project.
@pytest.fixture(autouse=True)
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Stand in for the folders of Pyodide's file system."""
    # resolve(), as glue does for the project's files.
    home = tmp_path.resolve() / "home"
    home.mkdir()
    project = tmp_path.resolve() / "project"
    monkeypatch.setattr(glue, "_HOME", str(home))
    monkeypatch.setattr(glue, "_PROJECT", project)
    monkeypatch.setattr(glue, "_GUEST_ROOTS", (f"{home}{os.sep}", f"{project}{os.sep}"))
    monkeypatch.setattr(glue, "_reported_rules", set())
    # glue.run puts back what sys.path held when glue was imported.
    monkeypatch.setattr(sys, "path", list(sys.path))
    monkeypatch.setattr(glue, "_BASE_SYS_PATH", list(sys.path))
    return home


def run(
    mode: str,
    src: str,
    *,
    options: Mapping[str, object] | None = None,
    path_options: Mapping[str, str] | None = None,
    filename: str = "t.html",
    cwd: Path | None = None,
    project: Mapping[str, object] | None = None,
) -> str:
    return glue.run(
        mode,
        src,
        json.dumps(options or {}),
        json.dumps(path_options or {}),
        filename,
        None if cwd is None else str(cwd),
        None if project is None else json.dumps(project),
    )


def lint(
    src: str, *, filename: str = "t.html", project: Mapping[str, object] | None = None
) -> list[dict[str, object]]:
    findings: list[dict[str, object]] = json.loads(
        run("lint", src, filename=filename, project=project)
    )
    return findings


def test_formats() -> None:
    assert run("format", UGLY) == '<div>\n    <p>hi</p>\n    <img src="x.png">\n</div>\n'


def test_lints() -> None:
    finding = next(f for f in lint(DIRTY) if f["code"] == "H013")
    assert finding == {
        "code": "H013",
        "column": 5,
        "endColumn": 22,
        "endLine": 1,
        "line": 1,
        "message": "Img tag should have an alt attribute.",
    }


def test_takes_options() -> None:
    assert run("format", UGLY, options={"indent": 2}).startswith("<div>\n  <p>")


def test_takes_path_options(home: Path) -> None:
    (home / "custom.toml").write_text("indent = 2\n", encoding="utf-8")
    formatted = run("format", UGLY, path_options={"configuration": str(home / "custom.toml")})
    assert formatted.startswith("<div>\n  <p>")


def test_reads_the_documents_folder(home: Path) -> None:
    folder = home / "sub"
    folder.mkdir()
    (folder / "pyproject.toml").write_text("[tool.djlint]\nindent = 2\n", encoding="utf-8")
    assert run("format", UGLY, cwd=folder).startswith("<div>\n  <p>")


def test_falls_back_to_home_without_the_documents_folder(tmp_path: Path) -> None:
    assert run("format", UGLY, cwd=tmp_path / "gone").startswith("<div>\n    <p>")


def test_leaves_an_excluded_file_alone(home: Path) -> None:
    (home / "pyproject.toml").write_text(
        '[tool.djlint]\nextend_exclude = "skipped"\n', encoding="utf-8"
    )
    assert run("format", UGLY, filename="skipped/t.html") == UGLY
    assert lint(DIRTY, filename="skipped/t.html") == []
    assert run("format", UGLY, filename="t.html") != UGLY


def test_names_the_file_by_its_own_folder(home: Path) -> None:
    folder = home / "sub"
    folder.mkdir()
    (folder / "pyproject.toml").write_text('[tool.djlint]\nexclude = "t.html"\n', encoding="utf-8")
    assert run("format", UGLY, filename="sub/t.html", cwd=folder) == UGLY


def test_lays_out_a_project(tmp_path: Path) -> None:
    project = {
        "cwd": "sub",
        "files": {
            "pyproject.toml": "[tool.djlint]\nindent = 2\n",
            "../escaped.toml": "indent = 3\n",
        },
    }
    assert run("format", UGLY, project=project).startswith("<div>\n  <p>")
    assert (tmp_path / "project" / ".git").is_dir()
    assert (tmp_path / "project" / "sub").is_dir()
    assert not (tmp_path / "escaped.toml").exists()


def test_starts_each_project_afresh(tmp_path: Path) -> None:
    run("format", UGLY, project={"cwd": "", "files": {"old.txt": ""}})
    run("format", UGLY, project={"cwd": "", "files": {}})
    assert not (tmp_path / "project" / "old.txt").exists()


def test_reports_a_projects_rule_module_once(capsys: pytest.CaptureFixture[str]) -> None:
    rules = "- rule:\n    name: C001\n    message: m\n    python_module: rule\n"
    project = {"cwd": "", "files": {".djlint_rules.yaml": rules}}
    lint(DIRTY, project=project)
    lint(DIRTY, project=project)
    assert capsys.readouterr().err == ("Skipping rule C001: python_module is not available here.\n")


def test_counts_lines_from_one(home: Path) -> None:
    (home / ".djlint_rules.yaml").write_text(
        "- rule:\n    name: C001\n    message: m\n    python_module: zero_rule\n", encoding="utf-8"
    )
    (home / "zero_rule.py").write_text(ZERO_RULE, encoding="utf-8")
    finding = next(f for f in lint(DIRTY) if f["code"] == "C001")
    assert finding["line"] == 1
    assert finding["endLine"] == 1


def test_forgets_the_projects_modules(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    module = ModuleType("rule")
    module.__file__ = str(home / "rule.py")
    package = ModuleType("rules")
    package.__path__ = [str(home / "rules")]
    other = ModuleType("other")
    other.__file__ = str(home.parent / "other.py")
    for name, value in {"rule": module, "rules": package, "other": other}.items():
        monkeypatch.setitem(sys.modules, name, value)
    sys.path.append(str(home))
    run("format", UGLY)
    assert "rule" not in sys.modules
    assert "rules" not in sys.modules
    assert sys.modules["other"] is other
    assert str(home) not in sys.path

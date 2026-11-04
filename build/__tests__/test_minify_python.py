from __future__ import annotations

import io
import sys
from pathlib import Path
from textwrap import dedent

import pytest

import minify_python

GLUE = Path(__file__).parents[2] / "src" / "engine" / "pyodide" / "glue.py"


def strip(source: str) -> str:
    return minify_python.strip_typing(dedent(source))


def test_drops_the_type_checking_block() -> None:
    assert (
        strip("""\
        from __future__ import annotations
        from typing import TYPE_CHECKING
        import json
        if TYPE_CHECKING:
            from pathlib import Path
        def f(p: Path) -> str:
            return json.dumps(str(p))
        """)
        == "import json\n\ndef f(p: Path) -> str:\n    return json.dumps(str(p))"
    )


def test_drops_typing_dot_type_checking() -> None:
    source = "import typing\nif typing.TYPE_CHECKING:\n    import os\nx = 1\n"
    assert strip(source) == "import typing\nx = 1"


def test_keeps_the_else_branch() -> None:
    source = "if TYPE_CHECKING:\n    import os\nelse:\n    x = 1\n"
    assert strip(source) == "x = 1"


def test_keeps_the_other_names_of_an_import() -> None:
    source = "from __future__ import annotations, division\nfrom typing import Any, TYPE_CHECKING\n"
    assert strip(source) == "from __future__ import division\nfrom typing import Any"


def test_leaves_other_ifs_and_imports_alone() -> None:
    source = (
        "from .typing import TYPE_CHECKING as A\n"
        "from typing_extensions import TYPE_CHECKING as B\n"
        "if DEBUG:\n"
        "    import os\n"
    )
    assert strip(source) == source.rstrip("\n")


def test_stops_on_type_checking_used_elsewhere() -> None:
    source = "from typing import TYPE_CHECKING\ndef f():\n    if TYPE_CHECKING:\n        pass\n"
    with pytest.raises(SystemExit, match="TYPE_CHECKING is used other than"):
        strip(source)


def test_minifies_glue() -> None:
    minified = minify_python.minify(GLUE.read_text(encoding="utf-8"), ["run"])
    assert "TYPE_CHECKING" not in minified
    assert "__future__" not in minified
    assert "Lay out the project" not in minified
    assert "\ndef run(mode,src,options,path_options,filename,cwd,project):" in minified
    assert len(minified) < GLUE.stat().st_size / 2
    namespace: dict[str, object] = {}
    exec(compile(minified, "glue", "exec"), namespace)  # noqa: S102
    assert callable(namespace["run"])


def test_reads_stdin_and_writes_stdout(
    monkeypatch: pytest.MonkeyPatch, capsysbinary: pytest.CaptureFixture[bytes]
) -> None:
    source = "def run():\n    return 'é'\ndef helper():\n    return run()\n"
    stdin = io.TextIOWrapper(io.BytesIO(source.encode()), encoding="ascii")
    monkeypatch.setattr(sys, "stdin", stdin)
    monkeypatch.setattr(sys, "argv", ["minify_python.py", "run"])
    minify_python.main()
    assert capsysbinary.readouterr().out == "def run():return'é'\ndef A():return run()".encode()

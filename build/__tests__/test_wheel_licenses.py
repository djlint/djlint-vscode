from __future__ import annotations

import io
import sys
import urllib.request
import zipfile
from typing import TYPE_CHECKING

import pytest

import wheel_licenses

if TYPE_CHECKING:
    from pathlib import Path

RULE = "=" * 80


def make_wheel(
    tmp_path: Path, name: str, headers: str, files: dict[str, str], version: str = "1.0"
) -> Path:
    wheel = tmp_path / f"{name}-{version}-py3-none-any.whl"
    dist_info = f"{name}-{version}.dist-info"
    with zipfile.ZipFile(wheel, "w") as archive:
        archive.writestr(f"{name}/__init__.py", "")
        archive.writestr(
            f"{dist_info}/METADATA",
            f"Metadata-Version: 2.4\nName: {name}\nVersion: {version}\n{headers}",
        )
        archive.writestr(f"{dist_info}/RECORD", "")
        for path, text in files.items():
            archive.writestr(f"{dist_info}/{path}", text)
    return wheel


def test_reads_the_licenses_folder(tmp_path: Path) -> None:
    wheel = make_wheel(
        tmp_path,
        "pkg",
        "License-Expression: MIT AND BSD-3-Clause\n",
        {"licenses/LICENSE": "MIT text\r\n", "licenses/vendored/BSD": "\nBSD text\n"},
    )
    assert wheel_licenses.section(wheel) == (
        f"{RULE}\npkg 1.0 (MIT AND BSD-3-Clause)\n\nMIT text\n\nBSD text\n"
    )


@pytest.mark.parametrize(
    "file_name", ["LICENSE", "LICENSE.txt", "licence-MIT", "COPYING", "NOTICE.md"]
)
def test_finds_a_license_file_by_its_name(tmp_path: Path, file_name: str) -> None:
    wheel = make_wheel(tmp_path, "pkg", "License: MIT\n", {file_name: "text"})
    assert wheel_licenses.section(wheel) == f"{RULE}\npkg 1.0 (MIT)\n\ntext\n"


def test_skips_files_that_are_no_license(tmp_path: Path) -> None:
    wheel = make_wheel(
        tmp_path, "pkg", "License: MIT\n", {"LICENSE": "text", "LICENSES_OF_NOTHING": "no"}
    )
    assert wheel_licenses.section(wheel) == f"{RULE}\npkg 1.0 (MIT)\n\ntext\n"


def test_names_the_license_by_its_classifiers(tmp_path: Path) -> None:
    headers = (
        "Classifier: Programming Language :: Python\n"
        "Classifier: License :: OSI Approved :: MIT License\n"
        "Classifier: License :: OSI Approved :: Apache Software License\n"
        "License: ignored\n"
    )
    wheel = make_wheel(tmp_path, "pkg", headers, {"LICENSE": "text"})
    assert wheel_licenses.section(wheel).startswith(
        f"{RULE}\npkg 1.0 (MIT License, Apache Software License)\n"
    )


def test_leaves_the_license_empty_without_metadata(tmp_path: Path) -> None:
    wheel = make_wheel(tmp_path, "pkg", "", {"LICENSE": "text"})
    assert wheel_licenses.section(wheel).startswith(f"{RULE}\npkg 1.0 ()\n")


def test_fetches_a_missing_license_upstream(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    urls: list[str] = []

    def urlopen(url: str, timeout: float) -> io.BytesIO:
        assert timeout > 0
        urls.append(url)
        return io.BytesIO(b"upstream text\n")

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    wheel = make_wheel(tmp_path, "jsbeautifier", "License: MIT\n", {}, version="2.0.3")
    assert wheel_licenses.section(wheel) == (f"{RULE}\njsbeautifier 2.0.3 (MIT)\n\nupstream text\n")
    assert urls == ["https://raw.githubusercontent.com/beautifier/js-beautify/v2.0.3/LICENSE"]


def test_stops_without_a_license(tmp_path: Path) -> None:
    wheel = make_wheel(tmp_path, "pkg", "License: MIT\n", {})
    with pytest.raises(SystemExit, match=r"^the pkg 1\.0 wheel carries no license file;"):
        wheel_licenses.section(wheel)


def test_writes_every_wheel_in_order(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    second = make_wheel(tmp_path, "zzz", "License: MIT\n", {"LICENSE": "z"})
    first = make_wheel(tmp_path, "aaa", "License: MIT\n", {"LICENSE": "a"})
    output = tmp_path / "licenses.txt"
    monkeypatch.setattr(sys, "argv", ["wheel_licenses.py", str(output), str(second), str(first)])
    wheel_licenses.main()
    assert output.read_bytes().decode() == (
        "Licenses of djLint and the Python packages it uses, bundled as wheels under"
        f" assets/pyodide/.\n\n{RULE}\naaa 1.0 (MIT)\n\na\n\n{RULE}\nzzz 1.0 (MIT)\n\nz\n"
    )

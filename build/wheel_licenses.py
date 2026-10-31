"""Write the license files of wheels, for build/third-party-notices.mjs.

Usage: python wheel_licenses.py OUTPUT WHEEL...
"""

from __future__ import annotations

import re
import sys
import urllib.request
import zipfile
from email.parser import HeaderParser
from pathlib import Path

LICENSE_FILE = re.compile(r"(?:licen[cs]e|copying|notice)(?:[-.]|$)", re.I)
RULE = "=" * 80

# Upstream license files of projects whose wheels and sdists carry none.
MISSING_LICENSES = {
    "cssbeautifier": "https://raw.githubusercontent.com/beautifier/js-beautify/v{version}/LICENSE",
    "jsbeautifier": "https://raw.githubusercontent.com/beautifier/js-beautify/v{version}/LICENSE",
}


def fetch_missing_license(name: str, version: str) -> str:
    url = MISSING_LICENSES.get(name.lower())
    if url is None:
        msg = (
            f"the {name} {version} wheel carries no license file;"
            " add its upstream one to MISSING_LICENSES"
        )
        raise SystemExit(msg)
    with urllib.request.urlopen(
        url.format(version=version), timeout=60
    ) as response:
        return response.read().decode()


def section(wheel: Path) -> str:
    with zipfile.ZipFile(wheel) as archive:
        names = archive.namelist()
        dist_info = next(
            name.split("/")[0]
            for name in names
            if name.split("/")[0].endswith(".dist-info")
        )
        metadata = HeaderParser().parsestr(
            archive.read(f"{dist_info}/METADATA").decode()
        )
        files = sorted(
            name
            for name in names
            if name.startswith(f"{dist_info}/")
            and (
                name.startswith(f"{dist_info}/licenses/")
                or LICENSE_FILE.match(name.rsplit("/", 1)[-1])
            )
            and not name.endswith("/")
        )
        texts = [archive.read(name).decode() for name in files]
    if not texts:
        texts = [fetch_missing_license(metadata["Name"], metadata["Version"])]
    texts = [text.replace("\r", "").strip() for text in texts]
    license_ = (
        metadata.get("License-Expression")
        or ", ".join(
            classifier.rsplit(" :: ", 1)[-1]
            for classifier in metadata.get_all("Classifier") or []
            if classifier.startswith("License ::")
        )
        or metadata.get("License", "")
    )
    texts_joined = "\n\n".join(texts)
    return (
        f"{RULE}\n{metadata['Name']} {metadata['Version']} ({license_})\n\n"
        f"{texts_joined}\n"
    )


def main() -> None:
    output, *wheels = sys.argv[1:]
    sections = sorted(section(Path(wheel)) for wheel in wheels)
    Path(output).write_bytes(
        (
            "Licenses of djLint and the Python packages it uses, bundled as"
            " wheels under assets/pyodide/.\n\n" + "\n".join(sections)
        ).encode()
    )


if __name__ == "__main__":
    main()

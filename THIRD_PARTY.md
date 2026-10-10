# Third-party components bundled in this extension

So that the extension works without a separately installed djLint, the VSIX bundles a self-contained Python runtime (Pyodide) plus djLint and its dependencies, all under `assets/pyodide/`. These are separate programs invoked across the Pyodide runtime boundary; the extension's own TypeScript remains under the MIT license (see `LICENSE`).

## djLint (GPL-3.0-or-later)

The bundled `djlint-*.whl` is **djLint**, licensed under **GPL-3.0-or-later**. The full license text is in [`licenses/djlint-LICENSE`](licenses/djlint-LICENSE).

**Written offer of source.** The bundled wheel is an unmodified djLint release from PyPI, pinned in `djlint-requirements.txt`. Its complete corresponding source is publicly available at <https://github.com/djlint/djLint> at the tag matching that version (also visible in the wheel filename under `assets/pyodide/`). A copy of the source may also be requested from the extension maintainer.

## Runtime and dependency wheels

| Component               | Role                | License                    |
| ----------------------- | ------------------- | -------------------------- |
| Pyodide (incl. CPython) | WASM Python runtime | MPL-2.0 / PSF              |
| `regex`                 | djLint dependency   | Apache-2.0 AND CNRI-Python |
| `PyYAML`                | djLint dependency   | MIT                        |
| `click`                 | djLint dependency   | BSD-3-Clause               |
| `pathspec`              | djLint dependency   | MPL-2.0                    |
| `json5`                 | djLint dependency   | Apache-2.0                 |
| `editorconfig`          | djLint dependency   | BSD/PSF                    |
| `jsbeautifier`          | djLint dependency   | MIT                        |
| `cssbeautifier`         | djLint dependency   | MIT                        |

Each component is redistributed unmodified under its own license. The identifiers above come from each bundled wheel's own metadata and `LICENSE` files; refer to the respective project for the authoritative license text.

# Third-party software in the extension package

So that the extension works without a separately installed djLint, the VSIX bundles a Python runtime (Pyodide) plus djLint and the packages it uses under `assets/pyodide/`. esbuild also inlines npm packages into `dist/`.

- The extension's own code is MIT, see [`LICENSE`](LICENSE).
- djLint is GPL-3.0-or-later, and the extension calls it in the same process, so the published package as a whole is distributed under GPL-3.0-or-later. Its Corresponding Source is this repository at the release tag, plus the bundled wheels, which contain the Python source of djLint and its dependencies, and the sdists of regex and PyYAML, which are compiled for Pyodide, with libyaml, which PyYAML links.
- Every bundled component keeps its own license. Their texts are collected into `THIRD-PARTY-NOTICES.txt`, which ships in the VSIX.

## How the notices are built

`vscode:prepublish` writes `THIRD-PARTY-NOTICES.txt` from:

1. [`licenses/NOTICE.txt`](licenses/NOTICE.txt), the statement above;
2. the license files of the npm packages in esbuild's metafiles;
3. `assets/python-licenses.txt`, which `npm run assets` extracts from the bundled wheels with [`build/wheel_licenses.py`](build/wheel_licenses.py);
4. `assets/pyodide-licenses.txt`, which `npm run assets` builds with [`build/pyodide-licenses.mjs`](build/pyodide-licenses.mjs): the licenses of Pyodide and of what it compiles into its runtime (CPython, Emscripten and the C libraries they link), in the versions Pyodide's own build files name at the pinned tag.

The build fails if a bundled npm package or wheel has no license file, or if Pyodide starts linking a library `build/pyodide-licenses.mjs` does not know.

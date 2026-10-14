# Contributing

## Running the extension

Run `npm run assets` once to build the bundled runtime, then press <kbd>F5</kbd>. The build task watches both the extension and the Pyodide worker.

## Building the bundled runtime

`npm run assets` (also run by `vscode:prepublish`) assembles `assets/pyodide/`: the pinned Pyodide runtime, djLint, and djLint's dependency closure, all sha256-verified. It needs [`uv`](https://docs.astral.sh/uv/) on PATH.

The djLint version is pinned in `djlint-requirements.txt` and kept current by Renovate; the Pyodide runtime is pinned by the `pyodide` devDependency. Everything else follows from resolving those two, so there is no hand-maintained list to keep in sync.

`npm run verify-bundle` boots the built bundle and formats and lints through it. CI runs it after packaging and before publishing, because packaging cleanly does not on its own prove the bundled runtime still works after a dependency bump.

The licenses of everything bundled are collected into `dist/THIRD-PARTY-NOTICES.txt` at packaging; see [THIRD_PARTY.md](THIRD_PARTY.md). A Pyodide bump needs `licenses/pyodide-runtime.txt` updated, and `npm run assets` fails until it is.

## Packaging locally

`vsce package` runs `vscode:prepublish`, which rewrites `package.json` minified **in place**. CI builds from a throwaway checkout, so this only matters on a working copy: restore the file afterwards, and note that `git checkout -- package.json` also discards any uncommitted changes you had there.

## Checks

```sh
npm run lint          # eslint + tsc
npm run format        # prettier
```

# Contributing

## Running the extension

Run `npm run assets` once to build the bundled runtime, then press <kbd>F5</kbd>. The build task watches both the extension and the Pyodide worker.

## Building the bundled runtime

`npm run assets` (also run by `vscode:prepublish`) assembles `assets/pyodide/`: the pinned Pyodide runtime, djLint, and djLint's dependency closure, all sha256-verified. It needs [`uv`](https://docs.astral.sh/uv/) on PATH.

The djLint version is pinned in `djlint-requirements.txt` and kept current by Renovate; the Pyodide runtime is pinned by the `pyodide` devDependency. Everything else follows from resolving those two, so there is no hand-maintained list to keep in sync.

`npm run verify-bundle` boots the built bundle and formats and lints through it. CI runs it after packaging and before publishing, because packaging cleanly does not on its own prove the bundled runtime still works after a dependency bump.

When the djLint pin is bumped, re-check the license table in `THIRD_PARTY.md` against the bundled wheels' own metadata: `npm run assets` reports any component added to or dropped from the bundle, but not one whose license changed.

## Packaging locally

`vsce package` runs `vscode:prepublish`, which rewrites `package.json` minified **in place**. CI builds from a throwaway checkout, so this only matters on a working copy: restore the file afterwards, and note that `git checkout -- package.json` also discards any uncommitted changes you had there.

## Checks

```sh
npm run lint          # eslint + tsc
npm run format        # prettier
```

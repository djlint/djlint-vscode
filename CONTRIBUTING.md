# Contributing

## Running the extension

Run `npm run assets` once to build the bundled runtime, then press <kbd>F5</kbd>. The build task watches both the extension and the Pyodide worker.

## Building the bundled runtime

`npm run assets` (also run by `vscode:prepublish`) assembles `assets/pyodide/`: the pinned Pyodide runtime, djLint, and what djLint depends on, all sha256-verified against `uv.lock` or Pyodide's lock file. It needs [`uv`](https://docs.astral.sh/uv/) on PATH.

The djLint version is pinned in `pyproject.toml` and what it depends on in `uv.lock`, both kept current by Renovate; run `uv lock` after changing the first. The Pyodide runtime is pinned by the `pyodide` devDependency, and its own click, PyYAML and regex replace the locked ones, which the build checks djLint accepts. `requires-python` must be the Python that Pyodide runs.

`npm run verify-bundle` boots the built bundle and formats and lints through it, reading a project's configuration from disk as it does in the editor. CI runs it after packaging and before publishing, because packaging cleanly does not on its own prove the bundled runtime still works after a dependency bump.

The licenses of everything bundled are collected into `THIRD-PARTY-NOTICES.txt` at packaging; see [THIRD_PARTY.md](THIRD_PARTY.md). If a Pyodide bump links a new library into its runtime, `npm run assets` fails until its license is added to `build/pyodide-licenses.mjs`.

## Packaging locally

`vsce package` runs `vscode:prepublish`, which rewrites `package.json` minified **in place**. CI builds from a throwaway checkout, so this only matters on a working copy: restore the file afterwards, and note that `git checkout -- package.json` also discards any uncommitted changes you had there.

## Checks

The end-to-end tests need `npm run assets` and every `esbuild` script run first.

```sh
npm test              # vitest
npm run test:e2e      # the built extension in a real VS Code
npm run test:e2e:web  # the built extension in VS Code for the Web
npm run lint          # eslint + tsc
npm run format        # prettier
```

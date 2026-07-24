# djlint-vscode

[![CI](https://github.com/djlint/djlint-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/djlint/djlint-vscode/actions/workflows/ci.yml)
[![Visual Studio Marketplace Installs](https://vsmarketplacebadges.dev/installs-short/monosans.djlint.svg?label=Visual%20Studio%20Marketplace%20installs&logo=visualstudio)](https://marketplace.visualstudio.com/items?itemName=monosans.djlint)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/monosans/djlint?label=Open%20VSX%20downloads&logo=vscodium)](https://open-vsx.org/extension/monosans/djlint)

Visual Studio Code extension for formatting and linting HTML templates (Django, Jinja, Twig, Nunjucks, Handlebars, Liquid, Go templates, Mustache, Tera, Askama) using [djLint](https://djlint.com).

## Installation

Install the djLint VS Code extension from [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=monosans.djlint) or [Open VSX](https://open-vsx.org/extension/monosans/djlint).

That's it — the extension ships with a self-contained djLint runtime, so you do **not** need to install djLint or Python separately. If you prefer your own djLint (for a specific version, custom Python-module rules, or project config files such as `pyproject.toml [tool.djlint]` / `.djlintrc` — which the bundled runtime does not read), install it via the [djLint getting started guide](https://djlint.com/docs/getting-started/); the extension picks it up automatically and transparently falls back to the bundled runtime when no external djLint is found. Untrusted workspaces always use the bundled runtime, regardless of what is installed in the environment.

## Usage

The extension looks for a djLint to run, in this order:

1. `djlint.executablePath` — path to a djLint executable. Relative paths are resolved from the workspace root.
2. `djlint.pythonPath` — path to a Python interpreter to run djLint from (`python -m djlint`). Relative paths are resolved from the workspace root.
3. The active environment reported by the [Python extension](https://marketplace.visualstudio.com/items?itemName=ms-python.python), if it is installed — unless `djlint.useVenv` is set to `false`.
4. `djlint` on PATH.

`djlint.executablePath` and `djlint.pythonPath` both default to `""` (unset), so leaving them unset uses step 3, falling back to step 4 if the Python extension isn't installed (or `djlint.useVenv` is `false`). If none of the above resolves to a working djLint, the extension falls back to its bundled runtime instead of failing — see [Installation](#installation). In an untrusted workspace, the bundled runtime is always used, whatever is installed in the environment.

When an external djLint is used, the extension detects its version (`djlint --version`) and only sends command-line options that version actually supports, skipping (and logging a warning for, in the "djLint" output channel) any option that requires a newer djLint than the one resolved. This detected version is cached per workspace folder and refreshed automatically after a few minutes or whenever `djlint.executablePath`/`djlint.pythonPath`/`djlint.useVenv` changes or the active Python environment changes; run the **djLint: Restart** command (from the Command Palette) to refresh it immediately, for example right after upgrading djLint in place (`pip install -U djlint`).

On djLint ≥ 1.43.0, the extension also passes the edited file's workspace-relative path via `--stdin-filename` when linting, so [`per-file-ignores`](https://djlint.com/docs/linter/#per-file-ignores) rules work correctly even though the file's contents are piped in over stdin rather than read from disk.

The extension can be configured through the settings in VS Code. Some options can be configured through the [djLint configuration file](https://djlint.com/docs/configuration/).

Add this to your `settings.json` to format the default enabled languages with `djLint`:

```json
"[django-html][jinja][jinja-html][jinja2][html-hubl][hubl-html][twig][html-nunjucks][njk][nunjucks][handlebars][hbs][spacebars][liquid][jekyll][go-template][go-tmpl][gotemplate][GoTemplate][gohtml][GoHTML][gotmpl][hugo-html][mustache][htmlmustache][tera][askama-html][html]": {
  "editor.defaultFormatter": "monosans.djlint"
}
```

### Usage with djLint installed with pipx

[pipx](https://pypi.org/project/pipx/) creates a separate venv for each application and usually exposes a `djlint` executable. Point `djlint.executablePath` at that executable if it is not already available on PATH:

```json
"djlint.executablePath": "/home/user/.local/bin/djlint",
```

### Usage with djLint installed with uv

[uv](https://pypi.org/project/uv/) creates a separate venv for each application. Point `djlint.executablePath` at the generated `djlint` executable:

```json
"djlint.executablePath": "/home/user/.local/share/uv/tools/djlint/bin/djlint",
```

## Known issues

- Non-ASCII characters turn into `?` on Windows after formatting. To fix this, update `djLint` to v1.1.1 or higher.

- Linting does not work on Windows if the file contains non-ASCII characters. To fix this, update `djLint` to v1.1.1 or higher.

- File contents are duplicated after formatting. This is a bug in `djLint` v1.12.1, install another version.

- The config file is ignored on some versions of Python if it is in the root of the project. To fix this, update `djLint` to v1.19.2 or higher.

## Development

Building the bundled Pyodide runtime locally (`npm run assets`, which `vscode:prepublish` also runs) requires [`uv`](https://docs.astral.sh/uv/) on `PATH` and a sibling `../djlint` checkout; see `scripts/provision-assets.mjs` for details.

## License

The extension's own code is [MIT](https://github.com/djlint/djlint-vscode/blob/main/LICENSE).

The VSIX also bundles a self-contained djLint runtime (Pyodide + djLint + its dependencies) so it works without a separate install. djLint is licensed under GPL-3.0-or-later; see [THIRD_PARTY.md](THIRD_PARTY.md) for the full list of bundled components, their licenses, and the written offer of source.

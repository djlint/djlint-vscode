# <img src="icon.png" alt="" width="40" align="top"> djlint-vscode

[![CI](https://github.com/djlint/djlint-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/djlint/djlint-vscode/actions/workflows/ci.yml)
[![Visual Studio Marketplace Installs](https://vsmarketplacebadges.dev/installs-short/monosans.djlint.svg?label=Visual%20Studio%20Marketplace%20installs&logo=visualstudio)](https://marketplace.visualstudio.com/items?itemName=monosans.djlint)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/monosans/djlint?label=Open%20VSX%20downloads&logo=vscodium)](https://open-vsx.org/extension/monosans/djlint)

Visual Studio Code extension for formatting and linting HTML templates (Django, Jinja, Twig, Nunjucks, Handlebars, Liquid, Go templates, Mustache, Tera, Askama) using [djLint](https://djlint.com).

## Installation

Install the extension from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=monosans.djlint) or [Open VSX](https://open-vsx.org/extension/monosans/djlint). It ships with its own djLint, so you do not need to install djLint or Python.

Install djLint yourself to choose its version. Add it to your project with [uv](https://docs.astral.sh/uv/) or pip:

```bash
uv add --dev djlint
# or, with the project's environment activated
pip install djlint
```

The extension finds it through the Python environment selected in VS Code. If another environment is selected, or no Python environment extension is installed, the extension may fall back to its own djLint. In that case set `djlint.pythonPath` or `djlint.executablePath`, see [Which djLint is used](#which-djlint-is-used). The [djLint installation guide](https://djlint.com/docs/getting-started/#installation) has the details.

## Usage

Pick djLint as the formatter for the languages you want it to handle, for example just Django templates:

```json
"[django-html]": {
  "editor.defaultFormatter": "monosans.djlint"
}
```

Or for every language djLint supports:

```json
"[django-html][jinja][jinja-html][jinja2][html-hubl][hubl-html][twig][html-nunjucks][njk][nunjucks][handlebars][spacebars][liquid][jekyll][pos-liquid][go-template][go-tmpl][gotemplate][GoTemplate][gohtml][GoHTML][gotmpl][hugo-html][mustache][htmlmustache][tera][tera-html][askama-html][html]": {
  "editor.defaultFormatter": "monosans.djlint"
}
```

Linting is on by default for those languages and needs no setup.

The extension also works in [vscode.dev](https://vscode.dev) and [github.dev](https://github.dev), with the bundled djLint.

Everything else is configured through the `djlint.*` settings in VS Code. djLint also reads most options from a [djLint configuration file](https://djlint.com/docs/configuration/).

## Which djLint is used

The extension looks for a djLint to run, in this order:

1. `djlint.executablePath`, a path to a djLint executable.
2. `djlint.pythonPath`, a path to a Python interpreter to run djLint from (`python -m djlint`).
3. The active environment reported by the [Python Environments extension](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-python-envs) if `python.useEnvironmentsExtension` is on, otherwise by the [Python extension](https://marketplace.visualstudio.com/items?itemName=ms-python.python). Skipped when neither is installed, or when `djlint.useVenv` is `false`.
4. `djlint` on PATH, then `python -m djlint` and `python3 -m djlint`.
5. The djLint bundled with the extension.

The language status item in the status bar shows which one is in use, and opens the logs. A candidate where djLint is not installed is skipped. An installed djLint that fails is not: its error is shown, as it is not safe to format with another version. The exceptions are `python` and `python3` from PATH, which count only if `-m djlint --version` answers, because a stub such as the Windows Store one fails the same way. Both path settings are unset by default and accept either a path or a bare command name: a relative value containing a path separator (`bin/djlint`, `./venv/bin/python`) is resolved from the workspace root, while a bare name (`djlint`, `python3`) is looked up on PATH. `${workspaceFolder}`, `${workspaceFolder:name}`, `${userHome}` and `${env:NAME}` are expanded in both. The old defaults, `"djlint"` for `djlint.executablePath` and `"python"` for `djlint.pythonPath`, count as unset, so use a path if one of them has to win over the active environment.

Set `djlint.importStrategy` to `useBundled` to go from `djlint.executablePath` straight to the bundled djLint, skipping the steps between them, as `ruff.importStrategy` does. An untrusted workspace always uses the bundled djLint.

With an installed djLint, the extension detects its version and passes only the command-line options that version supports. It logs each skipped option as a warning in the "djLint" output channel. The version is detected for each environment, and for each folder when djLint comes from PATH, and again after five minutes and whenever the settings above or the active Python environment change. After upgrading djLint in the same environment, run "djLint: Restart" from the Command Palette to pick up the new version right away.

### djLint installed with uv tool or pipx

`uv tool install djlint` and `pipx install djlint` put the `djlint` executable in `~/.local/bin` by default; `uv tool dir --bin` and `pipx environment --value PIPX_BIN_DIR` print the directory. If it is not on PATH, set `djlint.executablePath` to the executable (on Windows, `djlint.exe`):

```json
"djlint.executablePath": "/home/user/.local/bin/djlint"
```

## Configuration files

djLint looks for its configuration file (`pyproject.toml`, `djlint.toml`, `.djlint.toml` or `.djlintrc`) upward from the edited file's folder, so in a monorepo the one nearest the file wins over one at the workspace root. The bundled djLint does the same, except in an untrusted workspace, where it reads no files. In a virtual workspace, the bundled djLint is used unless `djlint.executablePath` or `djlint.pythonPath` is set, because an installed djLint cannot read files there. The search stops at the workspace root, and a custom rule with a `python_module` is skipped, because that module is not read.

`djlint.configuration` and `djlint.rules` point to a file of your choice. Relative values, including a bare filename such as `.djlintrc`, are resolved from the workspace root.

[`per-file-ignores`](https://djlint.com/docs/configuration/#per-file-ignores) is read from the configuration file too. It works while linting from the editor with the bundled djLint and with an installed djLint 1.43.0 or newer.

## Known issues

These are bugs in old djLint versions, so they only affect an installed djLint. The bundled djLint is unaffected, and updating djLint fixes all of them.

- Before v1.1.1: non-ASCII characters break formatting and linting on Windows.
- v1.12.1: file contents are duplicated after formatting.
- Before v1.19.2: a config file in the project root is ignored on some Python versions.

## License

[MIT](https://github.com/djlint/djlint-vscode/blob/main/LICENSE)

The bundled djLint and the worker that loads it are distributed together under GPL-3.0-or-later. What the package bundles keeps its own license, collected in `THIRD-PARTY-NOTICES.txt` in the extension.

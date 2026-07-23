# djlint-vscode

[![CI](https://github.com/djlint/djlint-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/djlint/djlint-vscode/actions/workflows/ci.yml)
[![Visual Studio Marketplace Installs](https://vsmarketplacebadges.dev/installs-short/monosans.djlint.svg?label=Visual%20Studio%20Marketplace%20installs&logo=visualstudio)](https://marketplace.visualstudio.com/items?itemName=monosans.djlint)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/monosans/djlint?label=Open%20VSX%20downloads&logo=vscodium)](https://open-vsx.org/extension/monosans/djlint)

Visual Studio Code extension for formatting and linting HTML templates (Django, Jinja, Twig, Nunjucks, Handlebars, Liquid, Go templates, Mustache, Tera, Askama) using [djLint](https://djlint.com).

## Installation

Install the djLint VS Code extension from [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=monosans.djlint) or [Open VSX](https://open-vsx.org/extension/monosans/djlint).

That's it — the extension ships with a self-contained djLint runtime, so you do **not** need to install djLint or Python separately. If you prefer your own djLint (for a specific version, custom Python-module rules, or project config files such as `pyproject.toml [tool.djlint]` / `.djlintrc` — which the bundled runtime does not read), install it via the [djLint getting started guide](https://djlint.com/docs/getting-started/); the extension picks it up automatically and only falls back to the bundled runtime when no external djLint is found. The `djlint.importStrategy` setting controls this (`fromEnvironment`, the default, or `useBundled` to always use the bundled runtime).

## Usage

If `djlint.useVenv` is enabled and you have the [Python extension](https://marketplace.visualstudio.com/items?itemName=ms-python.python) installed, `djlint-vscode` uses the `djLint` installed in the currently activated Python environment.

If `djlint.useVenv` is disabled, the extension runs `djlint.executablePath` (`djlint` from PATH by default). Relative `djlint.executablePath` and `djlint.pythonPath` values are resolved from the workspace root. If that executable is not available, it falls back to `djlint.pythonPath -m djlint`.

The extension can be configured through the settings in VS Code. Some options can be configured through the [djLint configuration file](https://djlint.com/docs/configuration/).

Add this to your `settings.json` to format the default enabled languages with `djLint`:

```json
"[django-html][jinja][jinja-html][jinja2][html-hubl][hubl-html][twig][html-nunjucks][njk][nunjucks][handlebars][hbs][spacebars][liquid][jekyll][go-template][go-tmpl][gotemplate][GoTemplate][gohtml][GoHTML][gotmpl][hugo-html][mustache][htmlmustache][tera][askama-html][html]": {
  "editor.defaultFormatter": "monosans.djlint"
}
```

### Usage with djLint installed with pipx

[pipx](https://pypi.org/project/pipx/) creates a separate venv for each application and usually exposes a `djlint` executable. Disable `djlint.useVenv` and point `djlint.executablePath` at that executable if it is not already available on PATH:

```json
"djlint.useVenv": false,
"djlint.executablePath": "/home/user/.local/bin/djlint",
```

### Usage with djLint installed with uv

[uv](https://pypi.org/project/uv/) creates a separate venv for each application. Disable `djlint.useVenv` and point `djlint.executablePath` at the generated `djlint` executable:

```json
"djlint.useVenv": false,
"djlint.executablePath": "/home/user/.local/share/uv/tools/djlint/bin/djlint",
```

## Known issues

- Non-ASCII characters turn into `?` on Windows after formatting. To fix this, update `djLint` to v1.1.1 or higher.

- Linting does not work on Windows if the file contains non-ASCII characters. To fix this, update `djLint` to v1.1.1 or higher.

- File contents are duplicated after formatting. This is a bug in `djLint` v1.12.1, install another version.

- The config file is ignored on some versions of Python if it is in the root of the project. To fix this, update `djLint` to v1.19.2 or higher.

## License

The extension's own code is [MIT](https://github.com/djlint/djlint-vscode/blob/main/LICENSE).

The VSIX also bundles a self-contained djLint runtime (Pyodide + djLint + its dependencies) so it works without a separate install. djLint is licensed under GPL-3.0-or-later; see [THIRD_PARTY.md](THIRD_PARTY.md) for the full list of bundled components, their licenses, and the written offer of source.

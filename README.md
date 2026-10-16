# djlint-vscode

[![CI](https://github.com/djlint/djlint-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/djlint/djlint-vscode/actions/workflows/ci.yml)
[![Visual Studio Marketplace Installs](https://vsmarketplacebadges.dev/installs-short/monosans.djlint.svg?label=Visual%20Studio%20Marketplace%20installs&logo=visualstudio)](https://marketplace.visualstudio.com/items?itemName=monosans.djlint)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/monosans/djlint?label=Open%20VSX%20downloads&logo=vscodium)](https://open-vsx.org/extension/monosans/djlint)

Visual Studio Code extension for formatting and linting HTML templates (Django, Jinja, Twig, Nunjucks, Handlebars, Liquid, Go templates, Mustache, Tera, Askama) using [djLint](https://djlint.com).

## Installation

1. Install djLint into your project's environment with [uv](https://docs.astral.sh/uv/) or pip. The [djLint installation guide](https://djlint.com/docs/getting-started/#installation) has the details.

   ```bash
   uv add --dev djlint
   # or, with the project's environment activated
   pip install djlint
   ```

1. Install the extension from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=monosans.djlint) or [Open VSX](https://open-vsx.org/extension/monosans/djlint).

## Usage

How the extension finds djLint:

- If `djlint.useVenv` is enabled (the default) and the [Python extension](https://marketplace.visualstudio.com/items?itemName=ms-python.python) is installed and enabled, it runs `python -m djlint` with the interpreter of the active Python environment.
- Otherwise it runs `djlint.executablePath` (`djlint` from PATH by default) and, if that is empty or not found, `djlint.pythonPath -m djlint`. Relative paths in both settings are resolved from the workspace root.

The extension is configured through the VS Code settings. Some options can also be set in the [djLint configuration file](https://djlint.com/docs/configuration/).

To make djLint the default formatter for the languages in `djlint.formatLanguages`, add this to your `settings.json`:

```json
"[django-html][jinja][jinja-html][jinja2][html-hubl][hubl-html][twig][html-nunjucks][njk][nunjucks][handlebars][hbs][spacebars][liquid][jekyll][go-template][go-tmpl][gotemplate][GoTemplate][gohtml][GoHTML][gotmpl][hugo-html][mustache][htmlmustache][tera][askama-html][html]": {
  "editor.defaultFormatter": "monosans.djlint"
}
```

### djLint installed with uv tool or pipx

`uv tool install djlint` and `pipx install djlint` put djLint in an environment of its own, so the Python extension's active environment does not have it. Disable `djlint.useVenv`. If `djlint` is not on PATH, set `djlint.executablePath` to it. `uv tool dir --bin` and `pipx environment --value PIPX_BIN_DIR` print the directory it is in, `~/.local/bin` by default (on Windows, the file is `djlint.exe`):

```json
"djlint.useVenv": false,
"djlint.executablePath": "/home/user/.local/bin/djlint",
```

## Known issues

- On Windows, djLint before v1.1.1 turns non-ASCII characters into `?` when formatting and cannot lint files that contain them. Update djLint.
- djLint v1.12.1 duplicates the file contents when formatting. Install another version.
- On some Python versions, djLint before v1.19.2 ignores a config file in the project root. Update djLint.

## License

[MIT](https://github.com/djlint/djlint-vscode/blob/main/LICENSE)

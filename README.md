# djlint-vscode

[![Visual Studio Marketplace Installs](https://vsmarketplacebadges.dev/installs-short/monosans.djlint.svg?label=Visual%20Studio%20Marketplace%20installs&logo=visualstudio)](https://marketplace.visualstudio.com/items?itemName=monosans.djlint)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/monosans/djlint?label=Open%20VSX%20downloads&logo=vscodium)](https://open-vsx.org/extension/monosans/djlint)

Visual Studio Code extension for formatting and linting HTML templates (Django, Jinja, Twig, Nunjucks, Handlebars, Liquid, Go templates, Mustache, Tera, Askama) using [djLint](https://djlint.com).

## Installation

Install the extension from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=monosans.djlint) or [Open VSX](https://open-vsx.org/extension/monosans/djlint).

That is all you need: a self-contained djLint runtime ships with the extension, so djLint and Python do **not** have to be installed separately.

Install djLint [yourself](https://djlint.com/docs/getting-started/) if you want to pin a specific version, or to have your project's config and custom rules files read — the bundled runtime cannot read anything from disk. The extension picks up your installation automatically.

## Usage

Pick djLint as the formatter for the languages you want it to handle, for example just Django templates:

```json
"[django-html]": {
  "editor.defaultFormatter": "monosans.djlint"
}
```

Or for every language djLint supports:

```json
"[django-html][jinja][jinja-html][jinja2][html-hubl][hubl-html][twig][html-nunjucks][njk][nunjucks][handlebars][hbs][spacebars][liquid][jekyll][go-template][go-tmpl][gotemplate][GoTemplate][gohtml][GoHTML][gotmpl][hugo-html][mustache][htmlmustache][tera][askama-html][html]": {
  "editor.defaultFormatter": "monosans.djlint"
}
```

Linting is on by default for those languages and needs no setup.

Everything else is configured through the `djlint.*` settings in VS Code. Most options can also be set in a [djLint configuration file](https://djlint.com/docs/configuration/).

## Which djLint is used

The extension looks for a djLint to run, in this order:

1. `djlint.executablePath`, a path to a djLint executable.
2. `djlint.pythonPath`, a path to a Python interpreter to run djLint from (`python -m djlint`).
3. The active environment reported by the [Python Environments extension](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-python-envs) or, if that one isn't installed or is turned off via `python.useEnvironmentsExtension`, by the [Python extension](https://marketplace.visualstudio.com/items?itemName=ms-python.python). Skipped when neither is installed, or when `djlint.useVenv` is `false`.
4. `djlint` on PATH.
5. The bundled runtime.

Both path settings are unset by default and accept either a path or a bare command name: a value containing a path separator (`bin/djlint`, `./venv/bin/python`) is resolved from the workspace root, while a bare name (`djlint`, `python3`) is looked up on PATH. In an untrusted workspace the bundled runtime is always used, whatever is installed in the environment.

With an external djLint, the extension detects its version and sends only the command-line options that version supports; the rest are skipped with a warning in the "djLint" output channel. The detected version refreshes automatically after a few minutes, or whenever the settings above or the active Python environment change. To refresh it right away — after upgrading djLint in place with `pip install -U djlint`, say — run **djLint: Restart** from the Command Palette.

### djLint installed with pipx or uv

Both [pipx](https://pypi.org/project/pipx/) and [uv](https://pypi.org/project/uv/) create a separate venv per application. If the resulting `djlint` executable is not on PATH, point `djlint.executablePath` at it — `~/.local/bin/djlint` for pipx, `~/.local/share/uv/tools/djlint/bin/djlint` for uv:

```json
"djlint.executablePath": "/home/user/.local/bin/djlint"
```

## Configuration files

When `djlint.configuration` and `djlint.rules` are unset, djLint finds its own configuration by searching upward from the edited file's folder, so in a monorepo the `pyproject.toml`/`.djlintrc` nearest the file wins over one at the workspace root.

Both settings point to files on disk, so they only take effect with an externally installed djLint; the bundled runtime ignores them and says so once in the "djLint" output channel. Relative values, including a bare filename such as `.djlintrc`, are resolved from the workspace root.

[`per-file-ignores`](https://djlint.com/docs/linter/#per-file-ignores) works while linting from the editor. The bundled runtime always supports it; an external djLint needs version 1.43.0 or newer.

## Known issues

These are bugs in old djLint versions, so they only affect an externally installed djLint. The bundled runtime is unaffected, and updating djLint fixes all of them.

- Before v1.1.1: non-ASCII characters break formatting and linting on Windows.
- v1.12.1: file contents are duplicated after formatting.
- Before v1.19.2: a config file in the project root is ignored on some Python versions.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

The extension's own code is [MIT](https://github.com/djlint/djlint-vscode/blob/main/LICENSE).

The VSIX also bundles a self-contained djLint runtime (Pyodide + djLint + its dependencies) so it works without a separate install. djLint is licensed under GPL-3.0-or-later; see [THIRD_PARTY.md](THIRD_PARTY.md) for the full list of bundled components, their licenses, and the written offer of source.

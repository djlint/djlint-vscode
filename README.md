# djlint-vscode

[![CI](https://github.com/monosans/djlint-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/monosans/djlint-vscode/actions/workflows/ci.yml)
[![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/monosans.djlint?label=Visual%20Studio%20Marketplace%20installs&logo=visualstudio)](https://marketplace.visualstudio.com/items?itemName=monosans.djlint)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/monosans/djlint?label=Open%20VSX%20downloads&logo=vscodium)](https://open-vsx.org/extension/monosans/djlint)

Visual Studio Code extension for formatting and linting HTML templates (Django, Jinja, Nunjucks, Twig, Handlebars, Mustache) using [djLint](https://djlint.com).

## Installation

1. Install djLint itself with `python -m pip install -U djlint` command.
1. Install djLint VS Code extension from [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=monosans.djlint) or [Open VSX](https://open-vsx.org/extension/monosans/djlint).

## Usage

If you have the [Python extension](https://marketplace.visualstudio.com/items?itemName=ms-python.python) installed, `djlint-vscode` will use the `djLint` installed in the currently activated Python environment, unless you have the `djlint.useVenv` extension setting disabled.

The extension can be configured through the settings in VS Code. Some options can be configured through the [djLint configuration file](https://djlint.com/docs/configuration/).

Add this to your `settings.json` to format the default enabled languages with `djLint`:

```json
"[html][django-html][handlebars][hbs][mustache][jinja][jinja-html][nj][njk][nunjucks][twig]": {
  "editor.defaultFormatter": "monosans.djlint"
}
```

## Known issues

- Non-ASCII characters turn into `?` on Windows after formatting. To fix this, update `djLint` to v1.1.1 or higher.

- Linting does not work on Windows if the file contains non-ASCII characters. To fix this, update `djLint` to v1.1.1 or higher.

- File contents are duplicated after formatting. This is a bug in `djLint` v1.12.1, install another version.

- The config file is ignored on some versions of Python if it is in the root of the project. To fix this, update `djLint` to v1.19.2 or higher.

## License

[MIT](https://github.com/monosans/djlint-vscode/blob/main/LICENSE)

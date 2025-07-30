# djlint-vscode

[![CI](https://github.com/djlint/djlint-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/djlint/djlint-vscode/actions/workflows/ci.yml)
[![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/monosans.djlint?label=Visual%20Studio%20Marketplace%20installs&logo=visualstudio)](https://marketplace.visualstudio.com/items?itemName=monosans.djlint)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/monosans/djlint?label=Open%20VSX%20downloads&logo=vscodium)](https://open-vsx.org/extension/monosans/djlint)

Visual Studio Code extension for formatting and linting HTML templates (Django, Jinja, Nunjucks, Twig, Handlebars, Mustache) using [djLint](https://djlint.com).

## Installation

1. Install djLint VS Code extension from [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=monosans.djlint) or [Open VSX](https://open-vsx.org/extension/monosans/djlint).

**Note:** As of version 2025.5.0, the extension automatically manages djLint installation in an isolated environment. You no longer need to manually install djLint with pip unless you disable the `djlint.useIsolatedEnvironment` setting.

## Usage

The extension automatically manages djLint installation and updates in an isolated Python environment. On first use, it will:

1. Create a dedicated Python virtual environment
2. Install the latest version of djLint
3. Use this isolated installation for all formatting and linting operations

If you have the [Python extension](https://marketplace.visualstudio.com/items?itemName=ms-python.python) installed and want to use a different djLint installation, you can disable the `djlint.useIsolatedEnvironment` setting. When disabled, the extension will use the djLint installed in your currently activated Python environment unless you have the `djlint.useVenv` extension setting disabled.

The extension can be configured through the settings in VS Code. Some options can be configured through the [djLint configuration file](https://djlint.com/docs/configuration/).

Add this to your `settings.json` to format the default enabled languages with `djLint`:

```json
"[html][django-html][handlebars][hbs][mustache][jinja][jinja-html][nj][njk][nunjucks][twig]": {
  "editor.defaultFormatter": "monosans.djlint"
}
```

### Usage with manually installed djLint

If you prefer to manage djLint installation yourself, you can disable the automatic isolated environment:

```json
{
  "djlint.useIsolatedEnvironment": false
}
```

Then you can use djLint installed with pipx, uv, or in your project environment:

#### Usage with djLint installed with pipx

[pipx](https://pypi.org/project/pipx/) creates a separate venv for each application. You can see where it creates the venv with the `pipx environment --value PIPX_LOCAL_VENVS` command. For me it is `/home/user/.local/share/pipx/venvs`. This way I can set these settings:

```json
{
  "djlint.useIsolatedEnvironment": false,
  "djlint.useVenv": false,
  "djlint.pythonPath": "/home/user/.local/share/pipx/venvs/djlint/bin/python"
}
```

#### Usage with djLint installed with uv

[uv](https://pypi.org/project/uv/) creates a separate venv for each application. You can see where it creates the venv with the `uv tool dir` command. For me it is `/home/user/.local/share/share/uv/tools`. This way I can set these settings:

```json
{
  "djlint.useIsolatedEnvironment": false,
  "djlint.useVenv": false,
  "djlint.pythonPath": "/home/user/.local/share/share/uv/tools/djlint/bin/python"
}
```

## Known issues

- Non-ASCII characters turn into `?` on Windows after formatting. To fix this, update `djLint` to v1.1.1 or higher.

- Linting does not work on Windows if the file contains non-ASCII characters. To fix this, update `djLint` to v1.1.1 or higher.

- File contents are duplicated after formatting. This is a bug in `djLint` v1.12.1, install another version.

- The config file is ignored on some versions of Python if it is in the root of the project. To fix this, update `djLint` to v1.19.2 or higher.

## License

[MIT](https://github.com/djlint/djlint-vscode/blob/main/LICENSE)

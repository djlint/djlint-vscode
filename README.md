# djlint-vscode

Visual Studio Code extension for formatting and linting HTML templates (Django | Jinja | Nunjucks | Twig | Handlebars | Mustache) using [djLint](https://djlint.com).

## Installation

- [Install djLint itself](https://djlint.com/docs/getting-started/).
- [Install djLint VS Code extension](https://marketplace.visualstudio.com/items?itemName=monosans.djlint).

## Usage

If you have the [Python extension](https://marketplace.visualstudio.com/items?itemName=ms-python.python) installed, `djlint-vscode` will use the `djLint` installed in the currently activated Python environment, unless you have the `djlint.useVenv` extension setting disabled.

`djlint-vscode` automatically sets djLint's `profile` setting in accordance with language ID, unless you have the `djlint.guessProfile` extension setting disabled.

| djLint profile | Language ID                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------- |
| html           | html                                                                                            |
| django         | [django-html](https://marketplace.visualstudio.com/items?itemName=batisteo.vscode-django)       |
| handlebars     | handlebars, hbs, mustache                                                                       |
| jinja          | jinja, [jinja-html](https://marketplace.visualstudio.com/items?itemName=samuelcolvin.jinjahtml) |
| nunjucks       | nj, njk, nunjucks, twig                                                                         |

djLint's CLI options can be configured directly in the VS Code settings. Other djLint options can be set through the configuration file, as indicated in the [corresponding documentation](https://djlint.com/docs/configuration/). Please do not change the `linter_output_format` setting, otherwise linter will work incorrectly.

Add this to your `settings.json` to format all supported file types with `djLint`:

```json
"[html]": {
  "editor.defaultFormatter": "monosans.djlint"
},
"[django-html]": {
  "editor.defaultFormatter": "monosans.djlint"
},
"[handlebars]": {
  "editor.defaultFormatter": "monosans.djlint"
},
"[hbs]": {
  "editor.defaultFormatter": "monosans.djlint"
},
"[mustache]": {
  "editor.defaultFormatter": "monosans.djlint"
},
"[jinja]": {
  "editor.defaultFormatter": "monosans.djlint"
},
"[jinja-html]": {
  "editor.defaultFormatter": "monosans.djlint"
},
"[nj]": {
  "editor.defaultFormatter": "monosans.djlint"
},
"[njk]": {
  "editor.defaultFormatter": "monosans.djlint"
},
"[nunjucks]": {
  "editor.defaultFormatter": "monosans.djlint"
},
"[twig]": {
  "editor.defaultFormatter": "monosans.djlint"
},
```

## Known issues

- Non-ASCII characters turn into `?` on Windows after formatting. Solution - update `djLint` to version 1.1.1 or higher.

- Linting does not work on Windows if there are non-ASCII characters in the file. Solution - update `djLint` to version 1.1.1 or higher.

- The file content is duplicated after formatting. This is a bug of `djLint` v1.12.1, install another version.

## Disclaimer

This extension is not affiliated with the authors of [djLint](https://djlint.com).

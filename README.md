# djlint-vscode

Visual Studio Code extension for formatting and linting Django/Jinja HTML templates using [djLint](https://djlint.com).

## Installation

Search for `djLint` in VS Code extensions.

[Visual Studio Code Marketplace page](https://marketplace.visualstudio.com/items?itemName=monosans.djlint)

## Usage

`djlint-vscode` supports automatically setting djLint's `profile` setting for `html`, [`django-html`](https://marketplace.visualstudio.com/items?itemName=batisteo.vscode-django), [`jinja`](https://marketplace.visualstudio.com/items?itemName=wholroyd.jinja) and [`jinja-html`](https://marketplace.visualstudio.com/items?itemName=samuelcolvin.jinjahtml).

Some djLint options, such as `indent` and `ignore`, can be configured directly in the VSCode settings. All other djLint options can be set through the configuration file, as indicated in the [corresponding documentation](https://djlint.com/docs/configuration/).

Add this to your `settings.json` to format all supported file types with `djLint`:

```json
"[html]": {
  "editor.defaultFormatter": "monosans.djlint"
},
"[django-html]": {
  "editor.defaultFormatter": "monosans.djlint"
},
"[jinja]": {
  "editor.defaultFormatter": "monosans.djlint"
},
"[jinja-html]": {
  "editor.defaultFormatter": "monosans.djlint"
},
```

## Disclaimer

This extension is not affiliated with the authors of [djLint](https://djlint.com).

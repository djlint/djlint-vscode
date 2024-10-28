# Changelog

## [2024.10.0] - 2024-10-28

- Rebuild with updated dependencies.

## [2024.7.0] - 2024-07-07

- Allow ignoring install errors by disabling `djlint.showInstallError` setting.
- Require VSCode 1.90 or newer.
- Bump `execa` to v9.3.0.
- Bump `esbuild` to v0.23.0.

## [2024.6.0] - 2024-06-07

- Bump `execa` to 9.2.0.

## [2024.5.3] - 2024-05-20

- Bump `execa` to 9.1.0.
- Require VSCode 1.88 or higher.

## [2024.5.2] - 2024-05-20

- Downgrade `execa` to 8.0.1.

## [2024.5.1] - 2024-05-16

- Rebuild with esbuild v0.21.3.

## [2024.5.0] - 2024-05-08

- Bump bundled `execa` from 8.0.1 to 9.0.0.

## [2023.11.0] - 2023-11-19

- Rebuild with esbuild v0.19.6.

## [2023.8.10] - 2023-08-20

- Add a check to ensure the document has not been linted yet when activating the extension.

## [2023.8.9] - 2023-08-19

- Bump bundled `execa` from 8.0.0 to 8.0.1.

## [2023.8.8] - 2023-08-19

- Bump bundled `execa` from 7.2.0 to 8.0.0.

## [2023.8.7] - 2023-08-07

- Fix not all documents being linted on extension activation.

## [2023.8.6] - 2023-08-07

- Lint only documents with `file` or `vscode-vfs` URI scheme. (#323)
- Add more unsupported cwd URI scheme logs. (#323)

## [2023.8.5] - 2023-08-06

- Don't set cwd for vscode-vfs.

## [2023.8.4] - 2023-08-06

- Add unsupported cwd scheme logs.

## [2023.8.3] - 2023-08-06

- Add cwd scheme check. (#323)

## [2023.8.2] - 2023-08-05

- Remove empty output channel logs.
- Reduce extension size by minifying package.json.

## [2023.8.1] - 2023-08-04

- Use tab instead of 2 spaces for printing errors.

## [2023.8.0] - 2023-08-04

- Set minimum required VSCode version to 1.78.0.
- Improve errors output and logs.
- Use [@vscode/python-extension](https://www.npmjs.com/package/@vscode/python-extension).
- Minor refactoring.

## [2023.7.6] - 2023-07-27

- Update dependencies.
- Minor refactoring.

## [2023.7.5] - 2023-07-07

- Make sure files with git scheme are not linted.

## [2023.7.4] - 2023-07-07

- Improve error handling.

## [2023.7.3] - 2023-07-03

- Use [execa](https://github.com/sindresorhus/execa) for running djLint.

## [2023.7.2] - 2023-07-02

- Replace `djlint.languages` with `djlint.formatLanguages` and language-overridable `djlint.enableLinting` and `djlint.profile`.
- Add logging via VS Code output channels.
- Improve error handling and overall stability.

## [2023.7.1] - 2023-07-01

- Remove `--profile` for `html` language ID in `djlint.languages` setting.

## [2023.7.0] - 2023-07-01

- Add a new, more reliable linter output parser. It requires djLint ≥ 1.25, but you can use the old parser by disabling `djlint.useNewLinterOutputParser`.
- Improve error messages by adding a command to update djLint.

## [2023.6.2] - 2023-06-30

- Replace `djlint.guessProfile` setting with more flexible `djlint.languages` setting, which allows to control for which files types and with which `--profile` parameter djLint runs.
- Change logic of setting current working directory to support relative `djlint.configuration` path.
- Improve the error message that djLint is not installed.
- Add event handlers for changing `djlint.enableLinting` setting.

## [2023.6.1] - 2023-06-13

- Add support for `--max-blank-lines` option added in djLint v1.31.0.

## [2023.6.0] - 2023-06-02

- Add support for `--no-function-formatting` and `--no-set-formatting` options added in djLint v1.30.2.

## [2023.5.2] - 2023-05-30

- Change `djlint.configuration` option type from `string | null` to `string`.
- Minor refactoring.
- Switch from webpack to esbuild.

## [2023.5.1] - 2023-05-28

- Add support for `--no-line-after-yaml` option added in djLint v1.29.0.

## [2023.5.0] - 2023-05-13

- Add support for CLI arguments added in djLint 1.26.0 & 1.27.0.
- Lower minimum required version of VSCode to 1.72.0.
- Make the package smaller by eliminating unnecessary files.

## [2023.4.2] - 2023-04-27

- Add support for CLI arguments added in djLint 1.24.0 & 1.25.0.

## [2023.4.1] - 2023-04-13

- Add support for `--ignore-case` option.

## [2023.4.0] - 2023-04-12

- Add support for `--include` option.

## [2023.3.1] - 2023-03-31

- Remove debug console.log.

## [2023.3.0] - 2023-03-31

- Use [new Python Environment API](https://github.com/microsoft/vscode-python/blob/3269137c4cd0fa8b28b5c5741e54c95b00cd05c8/src/client/apiTypes.ts).

## [2022.10.1] - 2022-10-13

- Improve error handling.

## [2022.10.0] - 2022-10-13

- Fix usage of config file when it is not in the project root.

## [2022.9.0] - 2022-09-13

- Add support for `--configuration` option.
- Some refactoring to make the code more readable and understandable.

## [2022.7.2] - 2022-07-29

- Add support for `--format-css` and `--format-js` options.

## [2022.7.1] - 2022-07-02

- Add `No such option` error handling.

## [2022.7.0] - 2022-07-02

- Add `djlint.preserveLeadingSpace` option.
- Add `djlint.preserveBlankLines` option.
- Add `djlint.requirePragma` option.
- Lower the minimum required version of VSCode from 1.66 to 1.64.

## [2022.6.1] - 2022-06-16

- Add `djlint.guessProfile` option to disable automatic djLint profile guessing.

## [2022.6.0] - 2022-06-14

- Replace the `djlint.indent` option with `djlint.useEditorIndentation`, which is more flexible and more consistent with the VS Code API.

## [2022.5.2] - 2022-05-19

- Minor bug fix.

## [2022.5.1] - 2022-05-19

- Minor performance fix.

## [2022.5.0] - 2022-05-18

- Huge refactoring.
- Remove the djLint installer because it was causing problems. It was decided that it is better to let users install it themselves.
- Fix venv detection.
- Switch to `webpack` for module bundling.

## [1.1.0] - 2022-05-04

- Add support for Nunjucks, Twig, Handlebars and Mustache templates.

## [1.0.7] - 2022-04-13

- Minor improvements.

## [1.0.6] - 2022-04-12

- Huge refactoring.

## [1.0.5] - 2022-03-25

- Set default `indent` to `null`.

## [1.0.4] - 2022-03-05

- Minor improvements.

## [1.0.3] - 2022-02-21

- Code quality improvements.

## [1.0.2] - 2022-02-20

- Fix `djlint.pythonPath` not working.

## [1.0.1] - 2022-02-20

- Remove unneeded output.

## [1.0.0] - 2022-02-20

- Add option to use the Python executable from the current virtual environment.
- Remove `djlint.autoUpdate` option.

## [0.2.1] - 2022-02-19

- Save the current file before formatting.

## [0.2.0] - 2022-02-15

- Add `ignore` option.

## [0.1.1] - 2022-02-06

- Add `Linters` category in `package.json`.

## [0.1.0] - 2022-02-06

- Initial release.

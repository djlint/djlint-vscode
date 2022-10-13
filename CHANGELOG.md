# Changelog

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

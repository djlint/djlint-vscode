# Changelog

## [Unreleased]

- Follow the interpreter selected in the Python extension while `python.useEnvironmentsExtension` is off, which is the default, instead of the environment of the Python Environments extension that it installs.
- Let `djlint.executablePath`, `djlint.pythonPath`, `djlint.useVenv` and `djlint.importStrategy` apply again from the user settings of the local machine in a remote window, and sync with Settings Sync. They can be set per workspace folder.
- Try `python -m djlint` before `python3 -m djlint` when looking on PATH, so a `python` that used to run keeps running.
- Run the djLint of the environment of each project when a workspace folder holds several, and of each language that sets its own `djlint.executablePath` or `djlint.pythonPath`, instead of the one found first for five minutes.
- Detect the version of a djLint found on PATH per folder, because a version manager's shim can pick another one in each.
- Show the djLint of the active file's folder in the status bar, instead of the last one used in the workspace folder.
- Keep the bundled djLint running when the active Python environment changes.
- Pick up a Python extension as soon as it is installed or enabled when there was none, as before 2026.10.2, instead of after `djLint: Restart`.
- Let `djlint.executablePath` win over `djlint.importStrategy: useBundled`, as `ruff.path` does over `ruff.importStrategy`.
- Expand `${workspaceFolder}`, `${workspaceFolder:name}`, `${userHome}` and `${env:NAME}` in `djlint.executablePath` and `djlint.pythonPath`.

## [2026.10.2] - 2026-10-31

- Bundle djLint 1.48.0, so the extension works when neither djLint nor Python is installed. It is used automatically when no djLint is found, and it reads the project's configuration files like an installed djLint ([#780](https://github.com/djlint/djlint-vscode/issues/780)).
- Work in VS Code for the Web and in virtual workspaces, with the bundled djLint, which reads the project's configuration files there too. A custom rule with a `python_module` is skipped there.
- Register the formatter and enable linting by default for the `tera-html` language ID, which the main Tera extension gives to `.tera` and `.html.tera` files, and `pos-liquid`, used by platformOS.
- Remove the `hbs` language ID from the defaults. `.hbs` files are `handlebars`. To keep it, add it to `djlint.formatLanguages` and set `djlint.enableLinting` to `true` and `djlint.profile` to `"handlebars"` for it.
- Add the `djlint.importStrategy` setting. `useBundled` always uses the bundled djLint, whatever is installed.
- Honor `per-file-ignores` when linting from the editor, with the bundled djLint and with an installed djLint 1.43 or newer, which added `--stdin-filename` ([#1676](https://github.com/djlint/djlint-vscode/issues/1676)).
- Add a `djLint: Restart` command that detects djLint again, for example after upgrading it in the same environment, and a `djLint: Show Logs` command.
- Show the djLint in use in the language status item of the status bar.
- Detect the installed djLint version and pass only the command-line options that version supports, instead of erroring when a configured option is too new for it. That includes a `djlint.profile` it does not know, such as the default `tera` and `liquid` for djLint before 1.42, which can crash it.
- Remove the `djlint.useNewLinterOutputParser` setting. The extension now picks the most reliable linter output format your djLint supports on its own.
- Refresh diagnostics immediately when a setting that affects linting changes, instead of waiting for the next save. A language's warnings now clear as soon as linting is disabled for it.
- Show the rule code of a diagnostic as a link to its documentation, instead of at the end of the message.
- Underline what djLint found, with the bundled djLint and an installed djLint 1.48 or newer, instead of a single point. A finding over several lines is underlined on its first.
- Put a diagnostic in the right column on a line with an emoji before it.
- Stop an unresponsive djLint from hanging a format or lint indefinitely. Such a run is now given up on, and the stuck process ended, instead of surviving for the rest of the session.
- Error notifications now show what djLint actually reported, instead of the whole failed command followed by its output.
- Always look for `pyproject.toml`/`.djlintrc` starting from the edited file's own folder. Setting `djlint.configuration` or `djlint.rules` previously moved that search to the workspace root, so a monorepo could pick the root config instead of the one next to the file. Relative values for those two settings are still resolved from the workspace root, as documented.
- Read the active Python environment from the [Python Environments extension](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-python-envs) when it is installed and enabled, falling back to the [Python extension](https://marketplace.visualstudio.com/items?itemName=ms-python.python) otherwise. Interpreters that need extra launch arguments (conda, uv) are now run correctly.
- `djlint.executablePath` and `djlint.pythonPath` now take precedence over the active Python environment instead of being ignored while `djlint.useVenv` is enabled, and both now default to `""` (unset) rather than `"djlint"`/`"python"`. Setting either no longer requires disabling `djlint.useVenv`. Unset, `djlint` on PATH is still found, and so is `python -m djlint`. The old default values mean the same as unset when written out in `settings.json`, so they do not take precedence over the active environment.
- `djlint.pythonPath` is no longer deprecated.
- Remove the `djlint.showInstallError` setting; a missing djLint now falls back to the bundled one instead of showing an error.
- Ship the licenses of everything the package bundles (npm packages, Pyodide, djLint and the Python packages it uses) in `THIRD-PARTY-NOTICES.txt` in the root of the extension, which moved from `dist/`.

## [2026.10.1] - 2026-10-22

- Add `djlint.sortLoadTags` setting for the `--sort-load-tags` option added in djLint v1.47.
- Lower the minimum required VSCode version to 1.106.0.

## [2026.10.0] - 2026-10-19

- Ship the licenses of the bundled npm packages in `dist/THIRD-PARTY-NOTICES.txt`.
- Say in the descriptions of `djlint.useVenv`, `djlint.executablePath` and `djlint.pythonPath` that `djlint.useVenv` has no effect when the Python extension is not installed or is disabled.
- Link the error messages to the installation sections of the README and the djLint docs instead of the top of the page.

## [2026.9.0] - 2026-09-20

- Add settings for the options added in djLint v1.45: `djlint.keepBrInline` (`--keep-br-inline`), `djlint.nameEndblocks` (`--name-endblocks`), `djlint.noEntityFormatting` (`--no-entity-formatting`), `djlint.noIndentInnerHtml` (`--no-indent-inner-html`), `djlint.quoteStyle` (`--quote-style`) and `djlint.sortAttributes` (`--sort-attributes`).
- Add the `all` profile, accepted by djLint since v1.44, to the `djlint.profile` setting, and describe each profile in the settings UI.
- Bring the setting descriptions in line with djLint's own documentation.

## [2026.7.1] - 2026-07-20

- Raise minimal required VSCode version to `v1.107.0`.
- Add `djlint.rules` setting for the `--rules` option added in djLint v1.41.
- Add `askama`, `tera` and `liquid` profiles added in djLint v1.42 to the `djlint.profile` setting.
- Register the formatter and enable linting by default for Askama, Tera, Liquid, Jekyll and Go template language IDs (`askama-html`, `tera`, `liquid`, `jekyll`, `go-template`, `go-tmpl`, `gotemplate`, `GoTemplate`, `gohtml`, `GoHTML`, `gotmpl`, `hugo-html`).
- Register the formatter and enable linting by default for additional Jinja, Nunjucks and Mustache language IDs (`jinja2`, `html-hubl`, `hubl-html`, `html-nunjucks`, `htmlmustache`, `spacebars`).
- Remove the `nj` language ID from the defaults, as no published extension provides it.

## [2026.7.0] - 2026-07-01

- Add support for `--single-attribute-per-line` option added in djLint v1.40.

## [2026.6.3] - 2026-06-21

- Add settings for djLint attribute JavaScript/JSON formatting and preserving class attribute newlines.

## [2026.6.2] - 2026-06-05

- Resolve relative `djlint.executablePath` and `djlint.pythonPath` from the workspace root.

## [2026.6.1] - 2026-06-05

- Lower the minimum vscode version to 1.105.1

## [2026.6.0] - 2026-06-04

- Add `djlint.executablePath` setting for use when `djlint.useVenv` is disabled. `djlint.pythonPath` is now deprecated and is used as a fallback.

## [2025.11.0] - 2025-11-18

- Abort running djLint processes on extension deactivation.

## [2025.9.0] - 2025-09-06

- Cancel previous in-flight djLint runs per document to avoid race conditions and unnecessary work.
- Avoid shared mutable state of RegExp objects in linter.
- Drop support for VSCode < 1.101.
- Update dependencies.

## [2025.5.0] - 2025-05-26

- Fix Markdown syntax in settings description.
- Drop support for VSCode < 1.95.

## [2025.0.0] - 2025-02-14

- Improve settings description and fix typos.

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

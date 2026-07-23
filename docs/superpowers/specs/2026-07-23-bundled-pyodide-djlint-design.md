# Bundled Pyodide djLint — Design Spec

- **Date:** 2026-07-23
- **Issue:** [djlint/djlint-vscode#780](https://github.com/djlint/djlint-vscode/issues/780) — "The VSCode extension `djlint` should not require people to install the Python package"
- **Status:** Approved design, pending spec review → implementation plan
- **Feasibility research:** GO-WITH-CAVEATS, no showstoppers (see "Feasibility summary" below)

## 1. Problem

Today the extension can only run djLint by shelling out to an externally installed
copy: it resolves a Python interpreter / `djlint` executable and pipes the document
to `djlint -` over stdin ([src/runner.ts](../../../src/runner.ts)). If the user has
not installed djLint (and Python), the extension does nothing useful. Issue #780 asks
that the extension not force users to add djLint to their own project's dependencies.

Additionally, the current architecture is Node-only (uses `execa`, `node:path`,
`@vscode/python-extension`), so the extension does **not work at all** in web/remote
VS Code (vscode.dev / github.dev), where the extension host is a Web Worker with no
subprocess.

## 2. Goals / Non-goals

### Goals
- The extension works with **zero manually installed djLint/Python**, by bundling a
  self-contained djLint that runs via **Pyodide** (CPython compiled to WASM).
- **Existing desktop users are unaffected:** the external djLint (venv / executable)
  stays the default; bundled Pyodide is a fallback.
- The extension **works in web VS Code**, where bundled Pyodide is the only engine.
- Fully **offline** — no PyPI/CDN access at runtime.

### Non-goals
- Not replacing the subprocess path. External djLint remains first-class on desktop
  (native/mypyc speed, user's pinned version, custom Python-module rules).
- Not adding a "lint the whole workspace / directory mode" — the extension stays
  single-document (stdin-shaped), which is what keeps the Pyodide path simple.
- Not auto-installing djLint via pip/uv (a different strategy that was considered and
  rejected — it still requires provisioning Python and network on first run).

### Success criteria
- On a clean machine with no Python, opening a supported template in desktop VS Code
  formats and lints correctly using bundled Pyodide.
- On vscode.dev/github.dev, the same works with no local runtime.
- A user who has djLint installed sees identical behavior to today (subprocess path).
- Format-on-save latency after warm-up is well within VS Code's formatter timeout.

## 3. Feasibility summary (from research, GO-WITH-CAVEATS)

- **Core path is pure in-memory.** `formatter(config, text) -> str`
  ([djlint reformat.py:27](../../../../djlint/src/djlint/reformat.py#L27)) and
  `linter(config, html, "-", "-") -> dict`
  ([djlint lint.py:63](../../../../djlint/src/djlint/lint.py#L63)) touch no
  subprocess/thread/socket/network. `ProcessPoolExecutor` exists only in the
  multi-file batch branch ([djlint __init__.py:469](../../../../djlint/src/djlint/__init__.py#L469))
  and is never reached for a single document. → Call the library API directly, never
  the click CLI.
- **All deps are satisfiable.** `regex`/`pyyaml`/`click` ship as prebuilt Emscripten
  wheels in Pyodide (`regex` is the only C extension, and it exists);
  `pathspec`/`json5`/`editorconfig`/`jsbeautifier`/`cssbeautifier` are pure
  `py3-none-any`; the **djLint pure-python wheel is producible in-house** because the
  mypyc build hook is `enable-by-default = false`
  ([djlint pyproject.toml:104](../../../../djlint/pyproject.toml#L104)). Pyodide 0.29 =
  CPython 3.13, so the `tomli`/`typing-extensions` (py<3.11) branch is dead.
- **Structured lint output** `{code,line,match,message}` maps straight into
  `vscode.Diagnostic`; djLint's 1-based line / 0-based column already match what the
  extension consumes ([src/linter.ts:115-117](../../../src/linter.ts#L115-L117)).
- **Precedent — the maintainer's own code.** The djlint.com playground already runs
  djLint formatting in Pyodide in a browser web worker
  ([djlint docs/src/static/js/worker.js](../../../../djlint/docs/src/static/js/worker.js)):
  it loads Pyodide 0.29.x, `micropip.install("djlint")`, then calls
  `formatter(Config("."), html)` directly. This is strong prior art (see §3.1).
- **Bundle size:** ~10 MB compressed added to the VSIX (Pyodide core + stdlib + a few
  wheels) — comfortably under any plausible marketplace limit.

### 3.1 Prior art: djlint.com already runs djLint in Pyodide

[djlint docs/src/static/js/worker.js](../../../../djlint/docs/src/static/js/worker.js)
is a shipping browser web worker that formats HTML with djLint in Pyodide. What it
proves and what it leaves open directly shapes this design:

- **Proves:** the core bet — Pyodide resolves and runs djLint (including the `regex`
  C-extension and `pyyaml`) via `micropip`, and the programmatic
  `formatter(Config(...), html)` call works warm. It also contains a ready
  `CONFIG_ARGS` table mapping the same VS Code-style option names to `Config` kwargs —
  a proven reference for §6 (though it covers only the **formatting** options).
- **Leaves open (⇒ what Phase 0 must cover):**
  1. It runs in a **plain website worker** via `importScripts(<CDN>)` **online** — not
     the VS Code **extension-host** worker, and not **offline** from bundled assets.
     The unproven surface is specifically: offline asset `fetch` + CORS from the
     extension resource origin inside the extension-host worker.
  2. It only **formats**; linting via `linter(config, html, "-", "-")` is un-exercised
     by prior art (validated by code-reading only). The spike/Phase 1 must exercise it.
  3. It builds the `Config(...)` call by **string-interpolating** option values into
     Python source (`Config("."${configArguments})`) and uses `Config(".")`. The
     extension will instead use `Config("-")` (stdin semantics, matching today's
     `djlint -` pipe) and pass values via `pyodide.globals.set` / `toPy` as a dict —
     avoiding Python-source escaping/injection bugs.

### Caveats the design must close
1. **The VS Code extension-host worker + offline bundled assets is unproven.**
   djLint-in-Pyodide-in-a-browser-worker itself is proven (§3.1), but only online via
   CDN `importScripts` in a plain website worker. What remains unproven: loading
   Pyodide **offline** from bundled assets inside the **extension-host** web worker —
   asset `fetch` + CORS of wasm/stdlib/wheels from the extension resource origin on
   **both** vscode.dev and github.dev. A fallback exists (preload bytes via
   `vscode.workspace.fs.readFile` + a loader shim) but is non-trivial. → **Phase 0
   spike.**
2. **Licensing:** bundling GPL-3.0-or-later djLint into the MIT VSIX is a
   redistribution. GPL permits it (no permission from co-author required); we must
   ship license text + a written offer of source. → §11.

## 4. Architecture

### 4.1 Engine abstraction

Introduce a `DjlintEngine` interface that hides *how* djLint is invoked. Both the
formatter and linter go through it instead of calling `runDjlint` directly.

```ts
interface LintDiagnostic {
  line: number;    // 1-based, as djLint emits
  column: number;  // 0-based
  code: string;
  message: string;
}

interface DjlintEngine {
  format(
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
    formattingOptions: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<string>;

  lint(
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
    token: vscode.CancellationToken,
  ): Promise<LintDiagnostic[]>;

  dispose(): void;
}
```

Two implementations:

- **`SubprocessEngine`** — wraps today's [src/runner.ts](../../../src/runner.ts)
  (execa + venv/executable resolution). **Node-only.** Its `lint()` absorbs the
  current regex parsing of CLI stdout (moved out of [src/linter.ts](../../../src/linter.ts))
  and returns `LintDiagnostic[]`. Its `format()` returns stdout unchanged.
- **`PyodideEngine`** — loads Pyodide, calls djLint's Python API directly. Runs in
  **both** Node (desktop) and the web worker. `format()` returns the formatted string
  directly; `lint()` returns djLint's structured output with no regex parsing.

Consequences for existing files:
- [src/formatter.ts](../../../src/formatter.ts): `provideDocumentFormattingEdits` calls
  `engine.format(...)` instead of `runDjlint(...)`. The whole-document
  `TextEdit.replace` logic is unchanged.
- [src/linter.ts](../../../src/linter.ts): `#lint` calls `engine.lint(...)` and maps
  `LintDiagnostic[] -> vscode.Diagnostic[]`. The `#outputRegex`/`#oldOutputRegex`
  parsing moves into `SubprocessEngine`. The `supportedUriSchemes` set already includes
  `vscode-vfs` (the web/remote scheme), which is retained.
- [src/args.ts](../../../src/args.ts) is reused (see §6).

### 4.2 Engine selection — `djlint.importStrategy` (inspired by ruff-vscode)

Adopt ruff-vscode's `importStrategy` pattern
([ruff-vscode package.json](../../../../ruff-vscode/package.json),
[ruff-vscode server.ts](../../../../ruff-vscode/src/common/server.ts)) rather than
ad-hoc fallback logic. New setting:

- **`djlint.importStrategy`**: `"fromEnvironment"` (default) | `"useBundled"`.
  - `fromEnvironment`: resolve external djLint (the existing `useVenv` /
    `executablePath` / `pythonPath` logic), **falling back to bundled Pyodide** if no
    external djLint can be found or executed.
  - `useBundled`: always use bundled Pyodide, ignore external resolution.

Selection algorithm (in a new `engine/select.ts`):

1. **Not a Node host** (web/remote worker): always `PyodideEngine` — subprocess is
   impossible. (Detect via absence of the Node build / `typeof process`.)
2. **Untrusted workspace**: force `PyodideEngine` (do not execute a
   workspace-specified interpreter/executable). Mark `executablePath`, `pythonPath`,
   `configuration`, `rules` as `restrictedConfigurations` in the
   `capabilities.untrustedWorkspaces` manifest section (ruff-vscode does this).
3. `importStrategy === "useBundled"`: `PyodideEngine`.
4. `importStrategy === "fromEnvironment"` (default): try `SubprocessEngine`. If it
   raises a "djLint unavailable" error (`ENOENT`, "No module named djlint", no Python
   interpreter), transparently fall back to `PyodideEngine` and remember the fallback
   for the session.

This subsumes and generalizes the previous "bundled as fallback" scope decision, and
gives power users an explicit `useBundled` switch. The bundled version is pinned
(§5), so `fromEnvironment` remains the way to get a project's own djLint version.

Note vs ruff-vscode: ruff bundles a **native binary + LSP** and is desktop-only. Our
Pyodide approach is what enables the web target ruff cannot offer. We keep esbuild
(ruff uses webpack).

## 5. `PyodideEngine` internals

### 5.1 Lifecycle & threading
- **Single warm instance, lazy init.** `loadPyodide` runs once on the first
  format/lint (not on activation), cached behind a promise. **Never** re-created per
  call — repeated `loadPyodide` leaks WASM heap and each cold start is ~2–5 s. A
  one-time progress notification ("Starting djLint runtime…") covers the cold start.
- **Threading:**
  - Desktop: run Pyodide in a Node `worker_thread` so a format call never blocks the
    extension host.
  - Web: the extension host is itself a Web Worker; the cold init is hidden behind
    progress and warm single-document calls are sub-100 ms. Whether to offload to a
    nested worker vs. run inline is resolved in the Phase 0 spike (§9, §12).
- **Fatal-error recovery:** on an unrecoverable Pyodide error ("memory access out of
  bounds"), tear down and re-create the worker/instance, then retry once.

### 5.2 Python glue (call the library, not the CLI)
```python
from djlint.settings import Config
from djlint.reformat import formatter
from djlint.lint import linter

# built once per distinct option set, cached (see 5.3)
cfg = Config('-', reformat=True, profile=profile, indent=tab_size, **opts)

formatted = formatter(cfg, source)                 # -> str
errors = linter(cfg, source, '-', '-')['-']        # -> [{code, line, match, message}]
```
This bypasses click argv parsing, the stdin/stdout streams, the progressbar,
`os.getenv`, `sys.exit(1)` on lint errors, and the `ProcessPoolExecutor` batch branch.

### 5.3 Config building & caching
- Build `Config(**kwargs)` from VS Code settings using the same option data as
  [src/args.ts](../../../src/args.ts) (see §6).
- **Cache the `Config` object** keyed by a hash of the resolved option set. Config
  construction parses `rules.yaml` and compiles dozens of regexes — the expensive
  part. Rebuild only when settings change, not per keystroke.

### 5.4 Config-file discovery without a real filesystem
- Pass all VS Code settings **explicitly as kwargs** (never rely on on-disk
  auto-discovery for those).
- For a project's own config files, djLint loads them from a **single**
  `project_root` directory (not an ancestor merge:
  [djlint settings.py:116-154](../../../../djlint/src/djlint/settings.py#L116-L154)).
  On web, resolve `project_root` via `vscode.workspace.fs`, read the up-to-5 files
  (`pyproject.toml`, `djlint.toml`/`.djlint.toml`, `.djlintrc`, `.editorconfig`,
  `.djlint_rules.yaml`), **mirror them into Pyodide MEMFS**, `chdir` there, and let
  djLint's own loader preserve exact precedence. Re-mirror when the files change.
- `--use-gitignore`/`exclude` are already inert in stdin mode
  ([djlint settings.py:1348-1350](../../../../djlint/src/djlint/settings.py#L1348-L1350)) —
  no filesystem work needed for them.

### 5.5 Error handling
- Catch `PythonError`; capture Python stdout/stderr via `loadPyodide({stdout,stderr})`
  and map exceptions to user messages. The CLI-shaped error parsing in
  [src/errors.ts](../../../src/errors.ts) ("No module named djlint", "No such option")
  becomes dead code for the Pyodide path (still used by `SubprocessEngine`).

## 6. Config/args refactor

- Extend the `CliArg` model in [src/args.ts](../../../src/args.ts) (or add a parallel
  builder) to emit **Python `Config` kwargs** `{name: value}` in addition to CLI
  flags. Names map 1:1 (`--format-css` → `format_css`, `--profile X` → `profile="X"`,
  `--max-line-length N` → `max_line_length=N`). List options stay comma-joined strings
  (Config splits them internally).
- **Proven reference:** the djlint.com worker's `CONFIG_ARGS` table
  ([djlint docs/src/static/js/worker.js:13-50](../../../../djlint/docs/src/static/js/worker.js#L13-L50))
  already encodes this option-name → `Config`-kwarg mapping for the formatting options;
  model `buildKwargs()` on it (and extend with the linting options it omits).
- **Pass values safely.** Unlike the playground (which string-interpolates values into
  Python source), build a JS object of kwargs and hand it to Python via
  `pyodide.globals.set` / `toPy`, then `Config('-', **opts_dict)`. No Python-source
  concatenation — avoids escaping/injection bugs on arbitrary user config strings.
- Skip CLI-only args for the kwargs path: `--quiet`, `--linter-output-format`
  (structured output is native), and `--reformat` (implied by calling `formatter()`).
- Unify lint output: `SubprocessEngine.lint` parses CLI stdout into `LintDiagnostic[]`
  (moving today's regex from linter.ts); `PyodideEngine.lint` returns the structured
  dict mapped to `LintDiagnostic[]`. `linter.ts` consumes `LintDiagnostic[]` in both
  cases.

## 7. djLint pure-python wheel & version pinning

- In the **djLint repo**, produce a `djlint-<v>-py3-none-any.whl` with the **mypyc
  hook disabled** (already the default), including `rules.yaml` + `rules/*.py` as
  package data — required at runtime by
  [djlint settings.py:1365](../../../../djlint/src/djlint/settings.py#L1365) and
  [djlint lint.py:89-90](../../../../djlint/src/djlint/lint.py#L89-L90).
- **Pin together:** djLint version + Pyodide version + Emscripten wheel ABI of
  `regex`/`pyyaml`/`click`. Align on the Pyodide version the docs playground already
  tracks (currently 0.29.x) so both use the same known-good runtime. Bundle those
  wheels locally and `loadPackage` from a trimmed local `pyodide-lock.json` — no
  `micropip`, no network.
- **CI gate:** before bumping djLint, verify the pinned Pyodide's prebuilt
  `regex`/`pyyaml`/`click` versions still satisfy djLint's constraints (micropip
  cannot compile a C extension in-browser, so there is no runtime escape hatch).

## 8. Bundling & dual-target build

- Second esbuild pass: `--platform=browser --format=esm`, add a **`browser`** entry in
  package.json next to `main`; exclude `execa` and `@vscode/python-extension` from the
  web bundle.
- Copy (do not esbuild-bundle) Pyodide assets to `dist/pyodide/`: `pyodide.mjs`,
  `pyodide.asm.js`, `pyodide.asm.wasm`, `python_stdlib.zip`, the trimmed
  `pyodide-lock.json`, and `packages/` with the vendored wheels (`regex`, `pyyaml`,
  `click`, `six` from a Pyodide release; our pure wheels `pathspec`, `json5`,
  `editorconfig`, `jsbeautifier`, `cssbeautifier`; and `djlint`).
- Load via `loadPyodide({ indexURL })` + `loadPackage(['djlint'])`. `indexURL` is a
  disk path on desktop and `context.extensionUri`-derived URL on web.

## 9. Phasing (spike-web-first)

- **Phase 0 — throwaway spike.** Formatting djLint-in-Pyodide-in-a-browser-worker is
  already proven (§3.1); the spike targets only the unproven residue: (a) load Pyodide
  **offline from bundled assets** inside the **extension-host web worker** on
  **vscode.dev and github.dev** — asset fetch + CORS from the extension resource
  origin; and (b) run `linter(...)` (not just `formatter(...)`) to confirm the lint
  path works in Pyodide. If CORS blocks (a), validate the `workspace.fs.readFile`
  byte-preload + loader-shim fallback. **Gate:** if neither loading path works, Phase 1
  still ships (desktop no-Python), but the Pyodide-vs-frozen-binary choice should be
  revisited for the web goal.
- **Phase 1 — desktop fallback (production).** Engine abstraction; `PyodideEngine` in a
  Node `worker_thread`; `importStrategy` setting; pure-python wheel build; offline
  bundle; version pinning + CI gate. Closes #780 for desktop-without-Python via the
  well-trodden Node Pyodide path.
- **Phase 2 — web target (production).** `browser` bundle; load Pyodide from
  `extensionUri`; config mirroring via `workspace.fs`; register formatter/linter in the
  web host. Delivers the reason Pyodide was chosen.

Each phase is independently shippable.

## 10. Error/UX changes

- When a bundled fallback exists, "djLint is not installed" stops being a blocking
  error — replace with a transparent switch to bundled + an info line in the output
  channel. The `showInstallError` nag ([src/errors.ts](../../../src/errors.ts)) becomes
  irrelevant for `fromEnvironment`-with-fallback and `useBundled`.
- Cold start shows a progress indicator.
- Cancellation caveat: on vscode.dev without cross-origin isolation, a runaway format
  cannot be interrupted cooperatively; the only cancel path is terminating the worker
  (cold restart). Single-document formats are normally fast, so accept this.

## 11. Licensing (aggregation, extension stays MIT)

- Ship in the VSIX: djLint's `LICENSE` (GPL-3.0-or-later), a written **offer of
  source**, and a `NOTICE`/`THIRD_PARTY` file listing bundled components (djLint,
  Pyodide, and each vendored wheel with its license).
- The extension's own TypeScript stays **MIT** — it invokes djLint across the Pyodide
  runtime boundary (aggregation). Document the bundling in the README.
- GPL grants redistribution rights to everyone; no permission from the djLint
  co-author is required, only compliance with GPL terms.

## 12. Testing

- **Python-glue smoke tests** across profiles (html/django/jinja) so all nine
  `python_module` rules ([djlint lint.py:89-90](../../../../djlint/src/djlint/lint.py#L89-L90))
  are exercised in Pyodide.
- **Parity tests:** subprocess vs Pyodide on a set of fixture templates — format and
  lint must produce identical results (within the pinned djLint version).
- **Spike verification:** manual load/run on vscode.dev and github.dev.
- **CI checks:** VSIX size budget; djLint ⇄ Pyodide version-compatibility gate (§7).

## 13. Risks & open questions

- **Web threading:** block the extension-host worker during cold init vs. spawn a
  nested sub-worker — decide in Phase 0.
- **CORS/asset fetch** in the web extension host — the main unknown; Phase 0 gates it.
- **Version drift:** bundled djLint is frozen to the VSIX; `fromEnvironment` covers
  users who need their own version. `python_module` custom rules pointing outside
  `djlint.rules.*` are unsupported in bundled mode (route to subprocess on desktop;
  warn on web).
- **Cold start** (~2–5 s first use) and **VSIX growth** (~10 MB) are accepted costs.

## 14. Affected / new modules (indicative)

- New: `src/engine/types.ts` (`DjlintEngine`, `LintDiagnostic`),
  `src/engine/subprocess.ts` (wraps runner.ts), `src/engine/pyodide.ts`,
  `src/engine/select.ts`, `src/engine/pyodide-worker.ts` (Node worker_thread + web
  worker entry), Python glue module (bundled).
- Modified: [src/formatter.ts](../../../src/formatter.ts),
  [src/linter.ts](../../../src/linter.ts), [src/args.ts](../../../src/args.ts),
  [src/runner.ts](../../../src/runner.ts) (becomes SubprocessEngine internals),
  [src/errors.ts](../../../src/errors.ts) (subprocess-only), `package.json`
  (`browser` entry, `djlint.importStrategy`, `capabilities.untrustedWorkspaces`, build
  scripts), esbuild build config.
- djLint repo: pure-python wheel build target + CI version-compat gate.

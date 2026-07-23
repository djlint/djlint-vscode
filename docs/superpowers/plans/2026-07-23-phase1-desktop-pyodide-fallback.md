# Phase 1 — Desktop Pyodide Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On desktop VS Code, when no external djLint can be found (or when the user opts in), format and lint using a self-contained djLint running in Pyodide inside a Node `worker_thread` — so the extension works with zero installed Python/djLint, closing issue #780 for desktop.

**Architecture:** Introduce a `DjlintEngine` interface with two implementations — `SubprocessEngine` (today's execa path, refactored behind the interface) and `PyodideEngine` (Pyodide in a Node `worker_thread`, calling djLint's Python API directly). A selector chooses between them per the `djlint.importStrategy` setting, falling back to bundled Pyodide when the external tool is unavailable. Pyodide + djLint + deps are bundled as offline assets; in Node there is no CORS, so offline loading is a plain `indexURL` filesystem path.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers, `@tsconfig/strictest`+`node22`), esbuild (cjs bundle, `node22.21.1` target), `execa` (subprocess), Pyodide **314.0.2** (Node build, CPython 3.14), Node `worker_thread`, `vitest` (unit + Node-integration tests), a pure-python `djlint` wheel built from the sibling `../djlint` checkout.

## Global Constraints

- **Behavior parity for existing users:** default `djlint.importStrategy` is `fromEnvironment`; users with djLint installed must see byte-identical format/lint output to today. (Spec §2, §4.2.)
- **Call the djLint library API, never the CLI, in Pyodide:** `formatter(Config("-", **opts), src)` and `linter(Config("-", **opts), src, "-", "-")["-"]`. (Spec §5.2.)
- **Config values pass as a `toPy` dict**, never string-interpolated into Python source. (Spec §6.)
- **Pyodide version `314.0.2` exactly**, pinned with matching Emscripten wheels for `regex`/`pyyaml`; no `micropip`/network at runtime — `loadPackage` from a local `indexURL`. (Spec §7, §8.)
- **Pure-python djLint wheel only** (`py3-none-any`, mypyc hook off) plus `rules.yaml` + `rules/*.py` package data. (Spec §7.)
- **Node-only in this phase:** `PyodideEngine` runs in a Node `worker_thread`; the web target is Phase 2. Do not add a `browser` entry here.
- **Licensing:** bundling GPL-3.0 djLint requires shipping its `LICENSE` + a written source offer + a `THIRD_PARTY` notice; the extension stays MIT (aggregation). (Spec §11.)
- **djLint diagnostic coordinates:** `line` is 1-based, `column` is 0-based — map to `vscode.Diagnostic` unchanged. (Spec §4.1; matches current [src/linter.ts:115-117](../../../src/linter.ts#L115-L117).)

## File Structure

New `src/engine/` module (one responsibility per file):
- `src/engine/types.ts` — `DjlintEngine`, `LintDiagnostic`, engine error types. No `vscode`-heavy logic; pure types.
- `src/engine/subprocess/index.ts` — `SubprocessEngine`; owns the execa invocation (moved from [src/runner.ts](../../../src/runner.ts)).
- `src/engine/subprocess/parse-lint-output.ts` — pure `parseLinterOutput(stdout, useNewParser): LintDiagnostic[]` (extracted from linter.ts regexes).
- `src/engine/pyodide/index.ts` — `PyodideEngine`; owns the worker lifecycle + RPC.
- `src/engine/pyodide/worker.ts` — runs inside the `worker_thread`; loads Pyodide, executes format/lint.
- `src/engine/pyodide/protocol.ts` — worker request/response message types (shared by index.ts + worker.ts).
- `src/engine/pyodide/glue.ts` — the Python glue as a string constant.
- `src/engine/select.ts` — `selectEngine(...)`; `importStrategy` + fallback + trust logic.
- `src/engine/kwargs.ts` — `buildConfigKwargs(config, document, formattingOptions, mode): Record<string, unknown>`.
- `assets/pyodide/**` — bundled Pyodide dist + wheels + trimmed lock (produced by `scripts/fetch-pyodide-assets.mjs`).
- `scripts/fetch-pyodide-assets.mjs` — provisions `assets/pyodide/`.
- `scripts/build-djlint-wheel.mjs` — builds the pure-python djLint wheel from `../djlint`.
- `THIRD_PARTY.md`, bundled `licenses/djlint-LICENSE` — licensing notices.

Modified: [src/formatter.ts](../../../src/formatter.ts), [src/linter.ts](../../../src/linter.ts), [src/args.ts](../../../src/args.ts), [src/runner.ts](../../../src/runner.ts) (becomes SubprocessEngine internals), [src/errors.ts](../../../src/errors.ts), `package.json`, `esbuild` build.

---

## Part A — Foundation & subprocess refactor (behavior-preserving)

### Task A1: Test harness (vitest)

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `src/engine/__tests__/smoke.test.ts`

**Interfaces:**
- Produces: `npm test` runs vitest over `src/**/*.test.ts`.

- [ ] **Step 1: Add vitest config**

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 2: Add deps + script to package.json**

In `package.json` add to `devDependencies`: `"vitest": "^3"`. Add to `scripts`: `"test": "vitest run"`, `"test:watch": "vitest"`.

- [ ] **Step 3: Write a smoke test**

`src/engine/__tests__/smoke.test.ts`:
```ts
import { expect, test } from "vitest";

test("vitest runs", () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 4: Install + run**

Run: `npm install && npm test`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/engine/__tests__/smoke.test.ts
git commit -m "test: add vitest harness"
```

---

### Task A2: Engine interface & shared types

**Files:**
- Create: `src/engine/types.ts`

**Interfaces:**
- Produces:
  - `interface LintDiagnostic { line: number; column: number; code: string; message: string }`
  - `interface DjlintEngine { format(document, config, formattingOptions, token): Promise<string>; lint(document, config, token): Promise<LintDiagnostic[]>; dispose(): void }`
  - `class DjlintUnavailableError extends Error` — thrown by an engine that cannot run (drives fallback).

- [ ] **Step 1: Write the types**

`src/engine/types.ts`:
```ts
import type * as vscode from "vscode";

export interface LintDiagnostic {
  line: number; // 1-based, as djLint emits
  column: number; // 0-based
  code: string;
  message: string;
}

export interface DjlintEngine {
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

/** Thrown when an engine cannot run at all (missing tool/interpreter), so the
 * selector may fall back to another engine. Distinct from a djLint runtime/lint
 * error, which must propagate. */
export class DjlintUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DjlintUnavailableError";
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/engine/types.ts
git commit -m "feat(engine): add DjlintEngine interface and shared types"
```

---

### Task A3: Extract linter-output parsing into a pure, tested function

**Files:**
- Create: `src/engine/subprocess/parse-lint-output.ts`
- Create: `src/engine/subprocess/__tests__/parse-lint-output.test.ts`

**Interfaces:**
- Produces: `parseLinterOutput(stdout: string, useNewParser: boolean): LintDiagnostic[]`.

- [ ] **Step 1: Write failing tests capturing today's two formats**

`src/engine/subprocess/__tests__/parse-lint-output.test.ts`:
```ts
import { expect, test } from "vitest";
import { parseLinterOutput } from "../parse-lint-output.js";

test("parses the new (templated) output format", () => {
  const stdout =
    "<filename>-</filename><line>12:3</line><code>H025</code><message>Tag seems to be an orphan</message>\n";
  expect(parseLinterOutput(stdout, true)).toEqual([
    { line: 12, column: 3, code: "H025", message: "Tag seems to be an orphan" },
  ]);
});

test("parses the legacy output format", () => {
  const stdout = "H025   12:3   Tag seems to be an orphan\n";
  expect(parseLinterOutput(stdout, false)).toEqual([
    { line: 12, column: 3, code: "H025", message: "Tag seems to be an orphan" },
  ]);
});

test("returns [] for empty output", () => {
  expect(parseLinterOutput("", true)).toEqual([]);
});
```

- [ ] **Step 2: Run — expect fail (module missing)**

Run: `npx vitest run src/engine/subprocess/__tests__/parse-lint-output.test.ts`
Expected: FAIL (cannot resolve `../parse-lint-output.js`).

- [ ] **Step 3: Implement by lifting the regexes from linter.ts**

`src/engine/subprocess/parse-lint-output.ts`:
```ts
import type { LintDiagnostic } from "../types.js";

const NEW_OUTPUT_REGEX =
  /^<filename>(?<filename>.*)<\/filename><line>(?<line>\d+):(?<column>\d+)<\/line><code>(?<code>.+)<\/code><message>(?<message>.+)<\/message>$/gmu;
const OLD_OUTPUT_REGEX =
  /^(?<code>[A-Z]+\d+)\s+(?<line>\d+):(?<column>\d+)\s+(?<message>.+)$/gmu;

export function parseLinterOutput(
  stdout: string,
  useNewParser: boolean,
): LintDiagnostic[] {
  const base = useNewParser ? NEW_OUTPUT_REGEX : OLD_OUTPUT_REGEX;
  const regex = new RegExp(base.source, base.flags);
  const diags: LintDiagnostic[] = [];
  for (const { groups } of stdout.matchAll(regex)) {
    if (!groups) continue;
    diags.push({
      line: Number.parseInt(groups["line"]!, 10),
      column: Number.parseInt(groups["column"]!, 10),
      code: groups["code"]!,
      message: groups["message"]!,
    });
  }
  return diags;
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run src/engine/subprocess/__tests__/parse-lint-output.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/engine/subprocess/parse-lint-output.ts src/engine/subprocess/__tests__/parse-lint-output.test.ts
git commit -m "refactor(engine): extract pure parseLinterOutput"
```

---

### Task A4: `SubprocessEngine` wrapping the existing execa path

**Files:**
- Create: `src/engine/subprocess/index.ts`
- Modify: `src/runner.ts` (export the internals SubprocessEngine needs; keep `runDjlint`/`CustomExecaError` intact)

**Interfaces:**
- Consumes: `runDjlint(document, config, args, outputChannel, controller, formattingOptions?)` and `isCustomExecaError` from [src/runner.ts](../../../src/runner.ts); `parseLinterOutput` (A3); `formattingArgs`/`lintingArgs` from [src/args.ts](../../../src/args.ts).
- Produces: `class SubprocessEngine implements DjlintEngine`. Its `format`/`lint` build an `AbortController` from the `token`, call `runDjlint`, and for `lint` return `parseLinterOutput(stdout, config.get("useNewLinterOutputParser"))`. It throws `DjlintUnavailableError` when `runDjlint` fails with `ENOENT`/"No module named djlint" (so the selector can fall back).

- [ ] **Step 1: Write the engine**

`src/engine/subprocess/index.ts`:
```ts
import * as vscode from "vscode";
import { formattingArgs, lintingArgs } from "../../args.js";
import { isCustomExecaError, runDjlint } from "../../runner.js";
import { DjlintUnavailableError, type DjlintEngine, type LintDiagnostic } from "../types.js";
import { parseLinterOutput } from "./parse-lint-output.js";

function controllerFor(token: vscode.CancellationToken): AbortController {
  const controller = new AbortController();
  token.onCancellationRequested(() => controller.abort());
  return controller;
}

function asUnavailable(e: unknown): never {
  if (isCustomExecaError(e) && (e.code === "ENOENT" || /No\s+module\s+named\s+djlint/u.test(e.stderr))) {
    throw new DjlintUnavailableError("External djLint is not available.", e);
  }
  throw e;
}

export class SubprocessEngine implements DjlintEngine {
  constructor(private readonly outputChannel: vscode.LogOutputChannel) {}

  async format(document, config, formattingOptions, token): Promise<string> {
    try {
      return await runDjlint(document, config, formattingArgs, this.outputChannel, controllerFor(token), formattingOptions);
    } catch (e) { asUnavailable(e); }
  }

  async lint(document, config, token): Promise<LintDiagnostic[]> {
    let stdout: string;
    try {
      stdout = await runDjlint(document, config, lintingArgs, this.outputChannel, controllerFor(token));
    } catch (e) { asUnavailable(e); }
    return parseLinterOutput(stdout, config.get<boolean>("useNewLinterOutputParser") ?? true);
  }

  dispose(): void {}
}
```
(Add explicit parameter types matching `DjlintEngine`; omitted here for brevity — copy them from `types.ts`.)

- [ ] **Step 2: Typecheck**

Run: `npx tsc`
Expected: no errors. (If `runDjlint`'s current error handling swallows errors via `checkErrors`, adjust `runner.ts` so a genuine ENOENT/"No module" surfaces as a throw the engine can classify — keep the existing user-facing error messages for the non-fallback case.)

- [ ] **Step 3: Commit**

```bash
git add src/engine/subprocess/index.ts src/runner.ts
git commit -m "feat(engine): add SubprocessEngine over the execa path"
```

---

### Task A5: Route formatter & linter through a `DjlintEngine`

**Files:**
- Modify: [src/formatter.ts](../../../src/formatter.ts), [src/linter.ts](../../../src/linter.ts)
- Create: `src/engine/select.ts` (temporary trivial version — returns `SubprocessEngine`)
- Modify: [src/extension.ts](../../../src/extension.ts)

**Interfaces:**
- Produces (temporary): `function getEngine(outputChannel): DjlintEngine` returning a cached `SubprocessEngine`. Replaced with real selection in Task C2.

- [ ] **Step 1: Trivial selector**

`src/engine/select.ts`:
```ts
import type * as vscode from "vscode";
import { SubprocessEngine } from "./subprocess/index.js";
import type { DjlintEngine } from "./types.js";

let cached: DjlintEngine | undefined;

export function getEngine(outputChannel: vscode.LogOutputChannel): DjlintEngine {
  cached ??= new SubprocessEngine(outputChannel);
  return cached;
}

export function disposeEngine(): void {
  cached?.dispose();
  cached = undefined;
}
```

- [ ] **Step 2: Formatter uses the engine**

In [src/formatter.ts](../../../src/formatter.ts), replace the `runDjlint(...)` call in `provideDocumentFormattingEdits` with `await getEngine(this.#outputChannel).format(document, config, options, token)`. Delete the now-unused local `AbortController` plumbing if the engine owns cancellation (keep the per-document dedupe by aborting the previous token via a stored source, or keep the existing controller map and pass a token wrapping it). Keep the whole-document `TextEdit.replace` unchanged.

- [ ] **Step 3: Linter uses the engine and maps diagnostics**

In [src/linter.ts](../../../src/linter.ts), replace the `runDjlint(...)` + regex loop with:
```ts
const diagnostics = await getEngine(this.#outputChannel).lint(document, config, token);
this.#collection.set(
  document.uri,
  diagnostics.map((d) => {
    const range = new vscode.Range(d.line - 1, d.column, d.line - 1, d.column);
    return new vscode.Diagnostic(range, `${d.message} (${d.code})`);
  }),
);
```
Remove `#outputRegex`/`#oldOutputRegex` and the `isCustomExecaError` import (cancellation is now handled by passing a `CancellationToken`; keep the per-document abort by wrapping the controller in a token source).

- [ ] **Step 4: Dispose the engine on deactivate**

In [src/extension.ts](../../../src/extension.ts), push a disposable calling `disposeEngine()`.

- [ ] **Step 5: Typecheck + manual integration check**

Run: `npx tsc && npm run esbuild-base`. Then in an Extension Development Host with djLint installed, format and lint a Django template. Expected: identical behavior to before this task (same formatting, same diagnostics). This is the parity gate for the refactor.

- [ ] **Step 6: Commit**

```bash
git add src/formatter.ts src/linter.ts src/engine/select.ts src/extension.ts
git commit -m "refactor: route formatter/linter through DjlintEngine"
```

---

## Part B — PyodideEngine (Node worker_thread, offline)

### Task B1: Provision bundled Pyodide + wheels + the pure djLint wheel

**Files:**
- Create: `scripts/build-djlint-wheel.mjs`
- Create: `scripts/fetch-pyodide-assets.mjs`
- Modify: `package.json` (`assets` script), `.gitignore` (ignore `assets/pyodide/`)

**Interfaces:**
- Produces: `assets/pyodide/` containing `pyodide.mjs`, `pyodide.asm.js`, `pyodide.asm.wasm`, `python_stdlib.zip`, a trimmed `pyodide-lock.json`, and `packages/` with `regex`/`pyyaml` (from the Pyodide release) + `djlint`/`pathspec`/`json5`/`editorconfig`/`jsbeautifier`/`cssbeautifier` wheels.

- [ ] **Step 1: Build the pure-python djLint wheel from the sibling checkout**

`scripts/build-djlint-wheel.mjs` runs, in `../djlint`, a hatch/build wheel with the mypyc hook left disabled (the default), then copies the resulting `dist/djlint-*-py3-none-any.whl` into `assets/pyodide/packages/`.
```js
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync } from "node:fs";
const DJLINT = "../djlint";
execFileSync("python", ["-m", "build", "--wheel", "--outdir", "dist-wheel"], { cwd: DJLINT, stdio: "inherit" });
const wheel = readdirSync(`${DJLINT}/dist-wheel`).find((f) => f.endsWith("-py3-none-any.whl"));
if (!wheel) throw new Error("pure-python djlint wheel not found — is the mypyc hook disabled?");
mkdirSync("assets/pyodide/packages", { recursive: true });
cpSync(`${DJLINT}/dist-wheel/${wheel}`, `assets/pyodide/packages/${wheel}`);
console.log("built", wheel);
```

- [ ] **Step 2: Fetch the pinned Pyodide dist + wheels and trim the lock**

`scripts/fetch-pyodide-assets.mjs` downloads Pyodide `314.0.2` core files + the `regex`/`pyyaml` wheels named in its lock, downloads the 5 pure wheels from PyPI, writes a `pyodide-lock.json` trimmed to `{djlint, regex, pyyaml, pathspec, json5, editorconfig, jsbeautifier, cssbeautifier}` with correct `file_name`/`sha256`/`depends`, all under `assets/pyodide/`. (Reuse the recipe from the Phase 0 spike's `fetch-assets.mjs`.)

- [ ] **Step 3: Wire scripts + gitignore**

Add to `package.json` scripts: `"assets": "node scripts/build-djlint-wheel.mjs && node scripts/fetch-pyodide-assets.mjs"`. Add `assets/pyodide/` to `.gitignore` (assets are provisioned at build time, not committed).

- [ ] **Step 4: Run + verify**

Run: `npm run assets`
Expected: `assets/pyodide/packages/` contains all 8 wheels; `assets/pyodide/pyodide-lock.json` lists exactly those packages; core files present.

- [ ] **Step 5: Commit (scripts only)**

```bash
git add scripts/build-djlint-wheel.mjs scripts/fetch-pyodide-assets.mjs package.json .gitignore
git commit -m "build: provision offline Pyodide + djLint wheel assets"
```

---

### Task B2: Config kwargs builder

**Files:**
- Create: `src/engine/kwargs.ts`
- Create: `src/engine/__tests__/kwargs.test.ts`

**Interfaces:**
- Produces: `buildConfigKwargs(config, document, formattingOptions, mode: "format" | "lint"): Record<string, unknown>` — the djLint `Config` kwargs equivalent to the CLI flags [src/args.ts](../../../src/args.ts) builds, minus CLI-only flags (`--quiet`, `--linter-output-format`, `--reformat`).

- [ ] **Step 1: Failing tests (drive names/types)**

`src/engine/__tests__/kwargs.test.ts`:
```ts
import { expect, test } from "vitest";
import { buildConfigKwargs } from "../kwargs.js";

function fakeConfig(values: Record<string, unknown>) {
  return { get: (k: string) => values[k] } as any;
}

test("maps format settings to Config kwargs", () => {
  const cfg = fakeConfig({ profile: "django", formatCss: true, maxLineLength: 120, useEditorIndentation: true });
  const kwargs = buildConfigKwargs(cfg, {} as any, { tabSize: 4, insertSpaces: true } as any, "format");
  expect(kwargs).toMatchObject({ profile: "django", format_css: true, max_line_length: 120, indent: 4 });
  expect(kwargs).not.toHaveProperty("reformat");
});

test("omits empty/absent values", () => {
  const cfg = fakeConfig({ profile: "" });
  expect(buildConfigKwargs(cfg, {} as any, { tabSize: 2 } as any, "lint")).not.toHaveProperty("profile");
});

test("joins array options into comma strings", () => {
  const cfg = fakeConfig({ ignore: ["H001", "H002"] });
  expect(buildConfigKwargs(cfg, {} as any, { tabSize: 2 } as any, "lint")).toMatchObject({ ignore: "H001,H002" });
});
```

- [ ] **Step 2: Run — expect fail.** `npx vitest run src/engine/__tests__/kwargs.test.ts` → FAIL.

- [ ] **Step 3: Implement** a table of `{ pythonName, vscodeName, kind: "bool"|"int"|"string"|"stringArray", modes }` mirroring [src/args.ts](../../../src/args.ts) and worker.js `CONFIG_ARGS` ([djlint worker.js:4-33](../../../../djlint/docs/src/static/js/worker.js#L4-L33)); include the editor-indentation rule (`indent = formattingOptions.tabSize` when `useEditorIndentation`). Emit only truthy/non-empty values; `stringArray` → `value.join(",")`. Exclude `--quiet`/`--linter-output-format`/`--reformat`.

- [ ] **Step 4: Run — expect pass.** `npx vitest run src/engine/__tests__/kwargs.test.ts` → passed.

- [ ] **Step 5: Commit**

```bash
git add src/engine/kwargs.ts src/engine/__tests__/kwargs.test.ts
git commit -m "feat(engine): map VS Code settings to djLint Config kwargs"
```

---

### Task B3: Python glue + worker protocol

**Files:**
- Create: `src/engine/pyodide/glue.ts`
- Create: `src/engine/pyodide/protocol.ts`

**Interfaces:**
- Produces:
  - `GLUE: string` defining `_djlint_format(src, options)` and `_djlint_lint(src, options)` (returns list of `{code,line,column,message}`).
  - `type WorkerRequest = { id: number; kind: "format" | "lint"; src: string; opts: Record<string, unknown> }`
  - `type WorkerResponse = { id: number; ok: true; result: string | LintDiagnostic[] } | { id: number; ok: false; error: string }`

- [ ] **Step 1: Glue** — `src/engine/pyodide/glue.ts` exports the `GLUE` string from the Phase 0 spike (`glue.py.ts`), unchanged.

- [ ] **Step 2: Protocol** — `src/engine/pyodide/protocol.ts` exports the `WorkerRequest`/`WorkerResponse` types above (import `LintDiagnostic` from `../types.js`).

- [ ] **Step 3: Typecheck + commit**

Run `npx tsc`.
```bash
git add src/engine/pyodide/glue.ts src/engine/pyodide/protocol.ts
git commit -m "feat(engine): pyodide python glue and worker protocol"
```

---

### Task B4: The worker thread

**Files:**
- Create: `src/engine/pyodide/worker.ts`

**Interfaces:**
- Consumes: `GLUE`, `WorkerRequest`, `WorkerResponse`; an `initPath` (the `assets/pyodide/` dir) passed as `workerData`.
- Produces: a `worker_thread` entry that lazily loads Pyodide from the local `indexURL`, imports djLint, and answers `format`/`lint` requests.

- [ ] **Step 1: Implement the worker**

`src/engine/pyodide/worker.ts`:
```ts
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { GLUE } from "./glue.js";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";

const indexURL: string = workerData.indexURL; // absolute path to assets/pyodide/

const ready = (async () => {
  const mod = await import(pathToFileURL(`${indexURL}/pyodide.mjs`).href);
  const pyodide = await mod.loadPyodide({ indexURL });
  await pyodide.loadPackage("djlint"); // resolves regex/pyyaml/... from the local lock
  pyodide.runPython(GLUE);
  return {
    format: pyodide.globals.get("_djlint_format"),
    lint: pyodide.globals.get("_djlint_lint"),
    toPy: (o: unknown) => pyodide.toPy(o),
  };
})();

parentPort!.on("message", async (req: WorkerRequest) => {
  let res: WorkerResponse;
  try {
    const py = await ready;
    const opts = py.toPy(req.opts);
    try {
      if (req.kind === "format") {
        res = { id: req.id, ok: true, result: py.format(req.src, opts) as string };
      } else {
        const r = py.lint(req.src, opts);
        const arr = r.toJs({ dict_converter: Object.fromEntries });
        r.destroy();
        res = { id: req.id, ok: true, result: arr };
      }
    } finally { opts.destroy(); }
  } catch (e) {
    res = { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  parentPort!.postMessage(res);
});
```

- [ ] **Step 2: Ensure the worker is emitted by the build** — esbuild must produce `dist/pyodide-worker.cjs` (a second entry; see Task C4). For now just typecheck: `npx tsc`.

- [ ] **Step 3: Commit**

```bash
git add src/engine/pyodide/worker.ts
git commit -m "feat(engine): pyodide worker_thread runner"
```

---

### Task B5: `PyodideEngine` + Node-integration parity test

**Files:**
- Create: `src/engine/pyodide/index.ts`
- Create: `src/engine/pyodide/__tests__/pyodide-engine.test.ts`
- Create: `src/engine/__tests__/fixtures/basic.html.ts` (input + expected output constant)

**Interfaces:**
- Consumes: `buildConfigKwargs` (B2), worker (B4), protocol (B3).
- Produces: `class PyodideEngine implements DjlintEngine` with lazy single worker, RPC by `id`, `dispose()` terminating the worker. Constructor takes `(assetsDir: string, outputChannel)`.

- [ ] **Step 1: Implement the engine (RPC over the worker)**

`src/engine/pyodide/index.ts`:
```ts
import { Worker } from "node:worker_threads";
import * as vscode from "vscode";
import { buildConfigKwargs } from "../kwargs.js";
import type { DjlintEngine, LintDiagnostic } from "../types.js";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";

export class PyodideEngine implements DjlintEngine {
  #worker: Worker | undefined;
  #seq = 0;
  readonly #pending = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void }>();

  constructor(private readonly workerPath: string, private readonly indexURL: string) {}

  #ensure(): Worker {
    if (this.#worker) return this.#worker;
    const w = new Worker(this.workerPath, { workerData: { indexURL: this.indexURL } });
    w.on("message", (res: WorkerResponse) => {
      const p = this.#pending.get(res.id);
      if (!p) return;
      this.#pending.delete(res.id);
      res.ok ? p.resolve(res.result) : p.reject(new Error(res.error));
    });
    w.on("error", (e) => { for (const p of this.#pending.values()) p.reject(e); this.#pending.clear(); this.#worker = undefined; });
    this.#worker = w;
    return w;
  }

  #call(kind: "format" | "lint", src: string, opts: Record<string, unknown>): Promise<any> {
    const id = ++this.#seq;
    const req: WorkerRequest = { id, kind, src, opts };
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ensure().postMessage(req);
    });
  }

  async format(document, config, formattingOptions): Promise<string> {
    return this.#call("format", document.getText(), buildConfigKwargs(config, document, formattingOptions, "format"));
  }

  async lint(document, config): Promise<LintDiagnostic[]> {
    return this.#call("lint", document.getText(), buildConfigKwargs(config, document, undefined as any, "lint"));
  }

  dispose(): void { void this.#worker?.terminate(); this.#worker = undefined; }
}
```
(Add the full `DjlintEngine` parameter signatures; wire `token` to reject the pending call on cancellation.)

- [ ] **Step 2: Fixture** — `basic.html.ts` exports `INPUT = "<div><p>hi</p></div>"` and `EXPECTED` = the djLint-formatted result (generate once by running the real djLint CLI, paste the exact output).

- [ ] **Step 3: Integration test (real Pyodide in Node)**

`pyodide-engine.test.ts` builds the worker to a temp file (or points at `dist/pyodide-worker.cjs`), constructs `PyodideEngine`, and asserts `format(INPUT) === EXPECTED` and `lint` returns structured diagnostics. Use a fake `document`/`config`. Mark the test with a longer timeout (`{ timeout: 60_000 }`) for cold start. Skip gracefully if `assets/pyodide/` is absent (`test.skipIf(!existsSync(...))`).

- [ ] **Step 4: Run**

Run: `npm run assets && npm run esbuild-base && npx vitest run src/engine/pyodide/__tests__/pyodide-engine.test.ts`
Expected: format matches `EXPECTED`; lint returns ≥1 diagnostic with real codes.

- [ ] **Step 5: Commit**

```bash
git add src/engine/pyodide/index.ts src/engine/pyodide/__tests__ src/engine/__tests__/fixtures
git commit -m "feat(engine): PyodideEngine with Node parity test"
```

---

## Part C — Selection, importStrategy, UX, packaging

### Task C1: `djlint.importStrategy` setting + untrusted-workspace capability

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the setting**

Under `contributes.configuration.properties`, add:
```json
"djlint.importStrategy": {
  "type": "string",
  "enum": ["fromEnvironment", "useBundled"],
  "enumDescriptions": [
    "Use djLint from the environment, falling back to the bundled version if it is not found.",
    "Always use the version of djLint bundled with the extension."
  ],
  "default": "fromEnvironment",
  "scope": "window",
  "markdownDescription": "Strategy for locating djLint. `fromEnvironment` uses your installed djLint (see `#djlint.useVenv#`), falling back to the bundled runtime. `useBundled` always uses the bundled runtime."
}
```

- [ ] **Step 2: Restrict trust-sensitive settings**

Add top-level:
```json
"capabilities": {
  "untrustedWorkspaces": {
    "supported": "limited",
    "restrictedConfigurations": ["djlint.executablePath", "djlint.pythonPath", "djlint.configuration", "djlint.rules"]
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat: add djlint.importStrategy and untrusted-workspace capability"
```

---

### Task C2: Real engine selection

**Files:**
- Modify: `src/engine/select.ts`
- Create: `src/engine/__tests__/select.test.ts`

**Interfaces:**
- Produces: `selectEngine(deps): DjlintEngine` where `deps = { importStrategy: "fromEnvironment"|"useBundled"; isTrusted: boolean; makeSubprocess(): DjlintEngine; makePyodide(): DjlintEngine }`. Pure decision logic, unit-testable without vscode.

- [ ] **Step 1: Failing tests**

`select.test.ts`:
```ts
import { expect, test, vi } from "vitest";
import { selectEngine } from "../select.js";

const deps = (over: Partial<any> = {}) => ({
  importStrategy: "fromEnvironment", isTrusted: true,
  makeSubprocess: vi.fn(() => ({ kind: "sub" })), makePyodide: vi.fn(() => ({ kind: "pyo" })),
  ...over,
});

test("useBundled → pyodide", () => {
  expect((selectEngine(deps({ importStrategy: "useBundled" })) as any).kind).toBe("pyo");
});
test("untrusted → pyodide", () => {
  expect((selectEngine(deps({ isTrusted: false })) as any).kind).toBe("pyo");
});
test("fromEnvironment trusted → subprocess (fallback handled at call time)", () => {
  expect((selectEngine(deps()) as any).kind).toBe("sub");
});
```

- [ ] **Step 2: Implement** `selectEngine` with that precedence (`!isTrusted || useBundled → pyodide; else subprocess`). Run tests → pass.

- [ ] **Step 3: Commit**

```bash
git add src/engine/select.ts src/engine/__tests__/select.test.ts
git commit -m "feat(engine): importStrategy/trust-based selection"
```

---

### Task C3: Runtime fallback + UX

**Files:**
- Modify: `src/engine/select.ts` (add a `FallbackEngine` wrapper), `src/errors.ts`, `src/extension.ts`

**Interfaces:**
- Produces: a `DjlintEngine` used by formatter/linter that, under `fromEnvironment`, tries `SubprocessEngine` and on `DjlintUnavailableError` transparently switches to `PyodideEngine` for the rest of the session, logging an info line (not the blocking "not installed" error).

- [ ] **Step 1: Implement `FallbackEngine`** wrapping primary (subprocess) + lazy secondary (pyodide): each `format`/`lint` calls primary; on `DjlintUnavailableError`, sets a `switched` flag, logs `outputChannel.info("djLint not found in the environment; using the bundled runtime.")`, and delegates to secondary (this and all subsequent calls).

- [ ] **Step 2: Neutralize the install nag** — in `src/errors.ts`, when a bundled fallback exists the "No module named djlint" branch must not `showErrorMessage`; gate it so it only fires when there is genuinely no fallback (e.g., pass a `hasFallback` flag). Keep the "unsupported option" and other branches.

- [ ] **Step 3: Assemble in `getEngine`** — build `makeSubprocess`/`makePyodide` (Pyodide constructed with the bundled `dist/pyodide-worker.cjs` path via `context.extensionUri`/`__dirname` and the `assets/pyodide` indexURL), pass to `selectEngine`, and wrap the `fromEnvironment` case in `FallbackEngine`. Thread `vscode.workspace.isTrusted`.

- [ ] **Step 4: Manual verification (two scenarios)** in the Extension Development Host:
  - With djLint installed: unchanged behavior (subprocess).
  - With djLint **uninstalled**: no error popup; output shows the info line; formatting/linting still work via bundled Pyodide (after cold start).

- [ ] **Step 5: Commit**

```bash
git add src/engine/select.ts src/errors.ts src/extension.ts
git commit -m "feat(engine): transparent bundled fallback + quieter UX"
```

---

### Task C4: Build & packaging (assets + worker in the VSIX)

**Files:**
- Modify: `package.json` (esbuild scripts, `vscode:prepublish`, `.vscodeignore`)
- Create: `.vscodeignore` entries; `THIRD_PARTY.md`; `licenses/djlint-LICENSE`

- [ ] **Step 1: Emit the worker bundle** — add an esbuild entry for `src/engine/pyodide/worker.ts` → `dist/pyodide-worker.cjs` (cjs, platform node, `--external:vscode` not needed — the worker must NOT import vscode; verify it doesn't). Extend `esbuild-base` or add `esbuild-worker`.

- [ ] **Step 2: Copy assets into the VSIX** — ensure `assets/pyodide/**` ships: reference it via `context.extensionUri` at runtime; add a `vscode:prepublish` step running `npm run assets` before esbuild; make sure `.vscodeignore` does NOT exclude `assets/` or `dist/pyodide-worker.cjs`, and that `dist/` sourcemaps are excluded.

- [ ] **Step 3: Licensing files** — add `licenses/djlint-LICENSE` (copy GPL-3.0 text from `../djlint/LICENSE`), write `THIRD_PARTY.md` listing djLint (GPL-3.0-or-later) + Pyodide + each wheel with its license + a written offer of source. Reference it from `README.md`.

- [ ] **Step 4: Package + inspect**

Run: `npx vsce package -o djlint.vsix` then `npx vsce ls djlint.vsix | grep -E "pyodide|worker"`.
Expected: the VSIX contains `assets/pyodide/**` (incl. `.wasm`, wheels, lock) and `dist/pyodide-worker.cjs`; size is roughly the extension + ~10 MB.

- [ ] **Step 5: Commit**

```bash
git add package.json .vscodeignore THIRD_PARTY.md licenses/ README.md
git commit -m "build: bundle Pyodide assets + worker; add licensing notices"
```

---

### Task C5: Parity test suite across profiles

**Files:**
- Create: `src/engine/__tests__/parity.test.ts`
- Create: `src/engine/__tests__/fixtures/*.ts` (a handful of templates)

**Interfaces:**
- Consumes: `PyodideEngine` (B5), a small subprocess-or-golden reference.

- [ ] **Step 1: Golden fixtures** — for ~5 representative templates (django, jinja, handlebars/mustache, golang, plain html) capture the expected formatted output and expected lint codes by running the real djLint CLI once; store as constants.

- [ ] **Step 2: Parity test** — for each fixture + its profile, assert `PyodideEngine.format` equals the golden output and `PyodideEngine.lint` codes match the golden set. Running lint across django/jinja/html profiles exercises all nine `python_module` rules ([djlint lint.py:89-90](../../../../djlint/src/djlint/lint.py#L89-L90)); a bundling gap surfaces here as an ImportError.

- [ ] **Step 3: Run**

Run: `npm run assets && npm run esbuild-base && npx vitest run src/engine/__tests__/parity.test.ts`
Expected: all fixtures pass; no ImportError from any rule module.

- [ ] **Step 4: Commit**

```bash
git add src/engine/__tests__/parity.test.ts src/engine/__tests__/fixtures
git commit -m "test(engine): subprocess/Pyodide parity across profiles"
```

---

## Self-Review

**1. Spec coverage (Phase 1 scope):**
- Engine abstraction (§4.1) → A2, A4, A5, B5. Subprocess lint parsing moved (§4.1) → A3.
- Config kwargs from settings, safe `toPy` (§5.2, §6) → B2, B4. Never-CLI, `Config("-")` (§5.2) → B3 glue.
- Pyodide in Node worker_thread, single warm instance (§5.1) → B4, B5. Fatal-error recovery is partial (worker `error` handler clears the instance in B5; full retry-once can be added when hardened).
- Offline bundling + pinned 314.0.2 + pure wheel + package data (§7, §8) → B1, C4.
- `importStrategy` + untrusted workspace `restrictedConfigurations` (§4.2) → C1, C2. Transparent fallback + quieter install UX (§4.2, §10) → C3.
- Licensing aggregation notices (§11) → C4.
- Testing: python-glue across profiles / all nine rules, parity (§12) → C5; kwargs/selection/parse units → A3, B2, C2.
- **Deferred to Phase 2 (web), by design:** `browser` entry, `workspace.fs` config-file mirroring into MEMFS (§5.4), CORS handling (§3.1) — all web-only. Cancellation-of-runaway caveat (§10) is web-specific. Not gaps.

**2. Placeholder scan:** Two steps intentionally describe rather than fully code — B1 Step 2 (lock-trim, deferred to reuse the spike's proven recipe) and C4 Step 1/2 (build wiring). Both name exact files/targets. No `TODO`/"handle edge cases". The `SubprocessEngine`/`PyodideEngine` signature notes say "copy the full parameter types from `types.ts`" — the types exist in A2, so this is a repetition instruction, not a placeholder.

**3. Type consistency:** `LintDiagnostic {line,column,code,message}` defined in A2 (types.ts) and used unchanged in A3, B3, B4, B5, C. `DjlintEngine.format/lint/dispose` signatures are identical across A2/A4/B5. `WorkerRequest`/`WorkerResponse` defined once (B3) and consumed by B4 + B5. `buildConfigKwargs(config, document, formattingOptions, mode)` defined B2, called B5. `selectEngine(deps)` defined C2, assembled C3. Glue names `_djlint_format`/`_djlint_lint` defined B3, called B4. Consistent.

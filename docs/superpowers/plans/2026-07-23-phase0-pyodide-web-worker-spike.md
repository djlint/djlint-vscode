# Phase 0 — Pyodide Web-Worker Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This is a throwaway validation spike, not production code.** Its deliverable is a yes/no answer to the one unproven question in the design, plus a written findings report and a couple of reusable artifacts (the Python glue string, the asset-bundling recipe). Tasks are *build → verify on a real host*, not TDD. Do NOT wire this into the production extension; it lives in an isolated `spikes/` folder that is deleted after Phase 1 starts.

**Goal:** Prove (or disprove) that Pyodide can load **offline from bundled extension assets** and run djLint **format + lint** inside the **VS Code extension-host web worker** on **both vscode.dev and github.dev**.

**Architecture:** A minimal standalone VS Code *web* extension (browser entry only) that, on a command, loads Pyodide inside the extension-host web worker, installs/loads djLint + deps, and formats and lints a hard-coded Django template, printing results to an output channel. Loading is attempted first online (CDN) to isolate "worker runs Pyodide at all" from "offline assets + CORS", then offline from bundled assets (the real target).

**Tech Stack:** TypeScript, esbuild (browser/ESM bundling), Pyodide **314.0.2** (CPython 3.14, ESM-only), `@vscode/test-web` (local web-host harness), djLint pure-python wheel + Pyodide-repo wheels (`regex`, `pyyaml`), `vsce` (pre-release publish for real-host test).

## Global Constraints

- **Pyodide version:** `314.0.2` exactly — CPython 3.14, ESM-only. Classic workers / `importScripts` are unsupported; load via `import { loadPyodide } from ".../pyodide.mjs"`. (Verbatim from spec §7; confirmed against `https://cdn.jsdelivr.net/pyodide/v314.0.2/full/pyodide-lock.json` → `info.python` = "3.14.0", `regex` 2026.3.32, `pyyaml` 6.0.3.)
- **Call the library API, never the CLI:** `formatter(Config("-", **opts), src)` and `linter(Config("-", **opts), src, "-", "-")["-"]`. Never drive click / stdin / `ProcessPoolExecutor`. (Spec §5.2.)
- **Config values pass as a `toPy` dict**, never string-interpolated into Python source. (Spec §6.)
- **Web extension host = Web Worker:** no `node:*`, no `execa`, no `child_process`, no `importScripts`; workspace access only via `vscode.workspace.fs`; extension assets addressed via `context.extensionUri`. (Spec §1, §8.)
- **Offline is the target:** the real test loads every Pyodide/wheel byte from bundled `dist/` assets, not PyPI/CDN, at runtime. Online CDN loading is a diagnostic stepping-stone only. (Spec §2, §8.)
- **Both hosts are in scope:** a pass requires **vscode.dev AND github.dev**. A pass on only one is a partial result to record, not a green light.

## File Structure

All spike code is isolated under `spikes/pyodide-web-worker/` in the djlint-vscode repo (deleted after Phase 1 begins):

- `spikes/pyodide-web-worker/package.json` — web-only extension manifest (`browser` entry, one command, `@vscode/test-web` + build scripts).
- `spikes/pyodide-web-worker/esbuild.mjs` — browser/ESM bundle of the extension entry.
- `spikes/pyodide-web-worker/src/extension.ts` — activates, registers the `djlint-spike.run` command, owns the Pyodide runtime, prints results to an output channel.
- `spikes/pyodide-web-worker/src/pyodide-runtime.ts` — loads Pyodide (online then offline), exposes `format(src, opts)` / `lint(src, opts)`; holds the Python glue string.
- `spikes/pyodide-web-worker/src/glue.py.ts` — the Python glue as a TS string constant (kept/reused in Phase 1).
- `spikes/pyodide-web-worker/dist/` — build output + copied Pyodide assets (`dist/pyodide/…`, `dist/wheels/…`).
- `spikes/pyodide-web-worker/scripts/fetch-assets.mjs` — downloads the pinned Pyodide dist + wheels into `dist/` for offline bundling.
- `spikes/pyodide-web-worker/FINDINGS.md` — the spike's actual deliverable (filled in Task 7).

---

### Task 1: Minimal web extension runs in the extension-host worker

**Files:**
- Create: `spikes/pyodide-web-worker/package.json`
- Create: `spikes/pyodide-web-worker/esbuild.mjs`
- Create: `spikes/pyodide-web-worker/src/extension.ts`
- Create: `spikes/pyodide-web-worker/.vscode/launch.json` (optional convenience)

**Interfaces:**
- Produces: a web extension exposing command `djlint-spike.run` (title "djLint Spike: Run") and an output channel named `djLint Spike`.

- [ ] **Step 1: Create the manifest**

`spikes/pyodide-web-worker/package.json`:
```json
{
  "name": "djlint-pyodide-spike",
  "publisher": "monosans",
  "version": "0.0.1",
  "engines": { "vscode": "^1.107.0" },
  "browser": "./dist/extension.js",
  "activationEvents": ["onCommand:djlint-spike.run"],
  "contributes": {
    "commands": [{ "command": "djlint-spike.run", "title": "djLint Spike: Run" }]
  },
  "scripts": {
    "build": "node esbuild.mjs",
    "assets": "node scripts/fetch-assets.mjs",
    "test-web": "vscode-test-web --browserType=chromium --extensionDevelopmentPath=."
  },
  "devDependencies": {
    "@types/vscode": "1.107.0",
    "@vscode/test-web": "*",
    "esbuild": "*",
    "typescript": "*"
  }
}
```

- [ ] **Step 2: Create the browser esbuild script**

`spikes/pyodide-web-worker/esbuild.mjs`:
```js
import * as esbuild from "esbuild";
await esbuild.build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  format: "cjs",
  platform: "browser",
  target: "es2022",
  external: ["vscode"],
  sourcemap: true,
});
```

- [ ] **Step 3: Create the extension entry (no Pyodide yet — just prove the worker runs our code)**

`spikes/pyodide-web-worker/src/extension.ts`:
```ts
import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel("djLint Spike");
  context.subscriptions.push(out);
  context.subscriptions.push(
    vscode.commands.registerCommand("djlint-spike.run", () => {
      out.show(true);
      out.appendLine(`[hello] extension host is running our code`);
      out.appendLine(`[env] uiKind=${vscode.env.uiKind} appHost=${vscode.env.appHost}`);
      out.appendLine(`[env] globalThis.process=${typeof (globalThis as any).process}`);
    }),
  );
}
export function deactivate(): void {}
```

- [ ] **Step 4: Install deps and build**

Run:
```bash
cd spikes/pyodide-web-worker && npm install && npm run build
```
Expected: `dist/extension.js` is produced with no errors.

- [ ] **Step 5: Launch the local web host and verify**

Run:
```bash
cd spikes/pyodide-web-worker && npm run test-web
```
Then in the opened browser: open the Command Palette → run **"djLint Spike: Run"**.
Expected in the `djLint Spike` output channel: the `[hello]` line, and `[env] uiKind=Web`, `appHost=…`, `globalThis.process=undefined` (confirming a real web-worker host with no Node).

- [ ] **Step 6: Commit**

```bash
git add spikes/pyodide-web-worker
git commit -m "spike(phase0): minimal web extension runs in extension-host worker"
```

---

### Task 2: Load Pyodide ONLINE in the worker and format a string

Purpose: isolate "the extension-host worker can run Pyodide + djLint at all" from the harder "offline assets + CORS" question. Online loading is close to the proven playground path.

**Files:**
- Create: `spikes/pyodide-web-worker/src/glue.py.ts`
- Create: `spikes/pyodide-web-worker/src/pyodide-runtime.ts`
- Modify: `spikes/pyodide-web-worker/src/extension.ts`

**Interfaces:**
- Consumes: command `djlint-spike.run` from Task 1.
- Produces: `class PyodideRuntime { init(mode: "online" | "offline"): Promise<void>; format(src: string, opts: Record<string, unknown>): Promise<string>; lint(src: string, opts: Record<string, unknown>): Promise<LintDiag[]>; }` where `LintDiag = { code: string; line: number; column: number; message: string }`.

- [ ] **Step 1: Author the Python glue (reused verbatim in Phase 1)**

`spikes/pyodide-web-worker/src/glue.py.ts`:
```ts
// Defines _djlint_format(src, options) and _djlint_lint(src, options) in the
// Pyodide global scope. options arrives as a Python dict (via toPy).
export const GLUE = `
from djlint.reformat import formatter
from djlint.lint import linter
from djlint.settings import Config

def _make_config(options):
    return Config("-", **options)

def _djlint_format(src, options):
    return formatter(_make_config(options), src)

def _djlint_lint(src, options):
    errors = linter(_make_config(options), src, "-", "-")["-"]
    out = []
    for e in errors:
        line_col = str(e["line"]).split(":")
        out.append({
            "code": e["code"],
            "line": int(line_col[0]),
            "column": int(line_col[1]) if len(line_col) > 1 else 0,
            "message": e["message"],
        })
    return out
`;
```

- [ ] **Step 2: Write the runtime (online mode: import pyodide.mjs from the CDN)**

`spikes/pyodide-web-worker/src/pyodide-runtime.ts`:
```ts
import { GLUE } from "./glue.py.ts";

export interface LintDiag { code: string; line: number; column: number; message: string }
const PYODIDE_VERSION = "314.0.2";
const CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

export class PyodideRuntime {
  #pyodide: any;
  #format: any;
  #lint: any;

  async init(mode: "online" | "offline", indexURL?: string): Promise<void> {
    // Dynamic import so the specifier is decided at runtime (online vs offline).
    const url = mode === "online" ? `${CDN}pyodide.mjs` : `${indexURL}pyodide.mjs`;
    const { loadPyodide } = await import(/* webpackIgnore: true */ url);
    this.#pyodide = await loadPyodide({ indexURL: mode === "online" ? CDN : indexURL });
    if (mode === "online") {
      await this.#pyodide.loadPackage("micropip");
      const micropip = this.#pyodide.pyimport("micropip");
      await micropip.install("djlint");
    } else {
      await this.#pyodide.loadPackage("djlint"); // resolved from the bundled lock
    }
    this.#pyodide.runPython(GLUE);
    this.#format = this.#pyodide.globals.get("_djlint_format");
    this.#lint = this.#pyodide.globals.get("_djlint_lint");
  }

  async format(src: string, opts: Record<string, unknown>): Promise<string> {
    const o = this.#pyodide.toPy(opts);
    try { return this.#format(src, o); } finally { o.destroy(); }
  }

  async lint(src: string, opts: Record<string, unknown>): Promise<LintDiag[]> {
    const o = this.#pyodide.toPy(opts);
    try {
      const res = this.#lint(src, o);
      const arr = res.toJs({ dict_converter: Object.fromEntries }) as LintDiag[];
      res.destroy();
      return arr;
    } finally { o.destroy(); }
  }
}
```

- [ ] **Step 3: Wire the command to run format online**

Replace the command body in `src/extension.ts` with:
```ts
import { PyodideRuntime } from "./pyodide-runtime.ts";
// inside registerCommand callback:
out.show(true);
const t0 = Date.now();
const rt = new PyodideRuntime();
out.appendLine(`[init] loading Pyodide ${"online"}…`);
await rt.init("online");
out.appendLine(`[init] ready in ${Date.now() - t0} ms`);
const src = `<div><p>hello</p></div>`;
const formatted = await rt.format(src, { profile: "django", indent: 4 });
out.appendLine(`[format]\n${formatted}`);
```
(Make the callback `async`.)

- [ ] **Step 4: Build and verify locally**

Run:
```bash
cd spikes/pyodide-web-worker && npm run build && npm run test-web
```
Run the command. Expected: `[init] ready in …ms` (single-digit seconds), then `[format]` shows the multi-line reformatted `<div>` (each element on its own indented line). No errors in the browser devtools console about `importScripts`, WASM, or CSP.

- [ ] **Step 5: Record the cold-start number and any console warnings in FINDINGS.md (create the file), then commit**

```bash
git add spikes/pyodide-web-worker
git commit -m "spike(phase0): load Pyodide online in worker, format a string"
```

---

### Task 3: Prove lint works in the worker

**Files:**
- Modify: `spikes/pyodide-web-worker/src/extension.ts`

- [ ] **Step 1: Extend the command to lint**

Append to the command callback after the format block:
```ts
const lintSrc = `<img src="x">\n<div class=foo></div>`;
const diags = await rt.lint(lintSrc, { profile: "django" });
out.appendLine(`[lint] ${diags.length} findings`);
for (const d of diags) out.appendLine(`  ${d.code} ${d.line}:${d.column} ${d.message}`);
```

- [ ] **Step 2: Build, run, verify**

Run `npm run build && npm run test-web`, run the command.
Expected: `[lint] N findings` with N ≥ 1, each line showing a real djLint code (e.g. `H006`/`H025`-style), a `line:column`, and a message. This confirms `linter()` runs in Pyodide and its structured output survives the `toJs` conversion.

- [ ] **Step 3: Record lint result in FINDINGS.md, commit**

```bash
git add spikes/pyodide-web-worker
git commit -m "spike(phase0): prove linter() runs in the worker"
```

---

### Task 4: Bundle Pyodide + wheels and load OFFLINE from extension assets (the real test)

**Files:**
- Create: `spikes/pyodide-web-worker/scripts/fetch-assets.mjs`
- Modify: `spikes/pyodide-web-worker/esbuild.mjs` (copy assets into `dist/`)
- Modify: `spikes/pyodide-web-worker/src/extension.ts` (compute `indexURL` from `extensionUri`, init `"offline"`)

**Interfaces:**
- Consumes: `PyodideRuntime.init("offline", indexURL)` from Task 2.
- Produces: `dist/pyodide/` (Pyodide core + trimmed `pyodide-lock.json` + package wheels) served from the extension origin.

- [ ] **Step 1: Fetch the pinned Pyodide dist + wheels**

`spikes/pyodide-web-worker/scripts/fetch-assets.mjs` (downloads to `dist/pyodide/`): fetch from `https://cdn.jsdelivr.net/pyodide/v314.0.2/full/` these files — `pyodide.mjs`, `pyodide.asm.js`, `pyodide.asm.wasm`, `python_stdlib.zip`, `pyodide-lock.json`, plus the wheels named in the lock for `regex` and `pyyaml`; and download the pure-python wheels for `djlint`, `pathspec`, `json5`, `editorconfig`, `jsbeautifier`, `cssbeautifier` from PyPI. Write them all under `dist/pyodide/` and `dist/pyodide/wheels/`.
```js
import { mkdir, writeFile } from "node:fs/promises";
const V = "314.0.2";
const BASE = `https://cdn.jsdelivr.net/pyodide/v${V}/full/`;
const core = ["pyodide.mjs","pyodide.asm.js","pyodide.asm.wasm","python_stdlib.zip","pyodide-lock.json"];
await mkdir("dist/pyodide", { recursive: true });
for (const f of core) {
  const r = await fetch(BASE + f);
  if (!r.ok) throw new Error(`${f}: ${r.status}`);
  await writeFile(`dist/pyodide/${f}`, Buffer.from(await r.arrayBuffer()));
  console.log("fetched", f);
}
// NOTE: read dist/pyodide/pyodide-lock.json, copy the regex + pyyaml wheel
// filenames it lists (BASE + filename) into dist/pyodide/, then fetch the six
// pure-python wheels from PyPI (pypi.org/pypi/<name>/json → urls[].url for the
// py3-none-any file) into the same dir, and append their entries to the lock so
// loadPackage(["djlint"]) resolves the whole graph offline.
```

- [ ] **Step 2: Copy `dist/pyodide/` alongside the bundle**

Assets are already written into `dist/pyodide/` by Step 1; ensure `esbuild.mjs` does not clean that directory (write the JS bundle to `dist/extension.js` only). No extra copy needed.

- [ ] **Step 3: Switch the command to offline init**

In `src/extension.ts`, replace the init call:
```ts
const indexURL = vscode.Uri.joinPath(context.extensionUri, "dist", "pyodide").toString() + "/";
out.appendLine(`[init] indexURL=${indexURL}`);
await rt.init("offline", indexURL);
```

- [ ] **Step 4: Build assets + bundle, run, verify offline path locally**

Run:
```bash
cd spikes/pyodide-web-worker && npm run assets && npm run build && npm run test-web
```
Run the command with the browser devtools **Network** tab open and (to simulate offline) throttled to "Offline" *after* the page loads but the harness is served locally — instead, verify that **all** Pyodide/wheel requests go to the extension asset origin (the `indexURL`) and none to `cdn.jsdelivr.net` or `pypi.org`.
Expected: format + lint still succeed; every request in Network is to the local extension origin; no request to jsdelivr/pypi. If a request is **blocked by CORS**, record the exact error and proceed to Task 6.

- [ ] **Step 5: Commit**

```bash
git add spikes/pyodide-web-worker
git commit -m "spike(phase0): load Pyodide + wheels offline from extension assets"
```

---

### Task 5: Verify on the real hosts — vscode.dev AND github.dev

`@vscode/test-web` serves the extension from localhost, which does not fully reproduce vscode.dev's asset origin/CORS. This task is the true gate.

**Files:**
- Modify: `spikes/pyodide-web-worker/package.json` (pre-release publish metadata as needed)

- [ ] **Step 1: Package a pre-release web extension**

Run:
```bash
cd spikes/pyodide-web-worker && npx vsce package --pre-release -o djlint-spike.vsix
```
Expected: a `.vsix` under ~15 MB containing `dist/pyodide/**`.

- [ ] **Step 2: Publish as a pre-release (or use a private publisher) and open on vscode.dev**

Publish (`npx vsce publish --pre-release`) under the `monosans` publisher, then open `https://vscode.dev`, install the extension from the Marketplace, open any workspace, run **"djLint Spike: Run"**.
Expected: same `[format]` + `[lint]` output as local. **Watch devtools Network for CORS failures** fetching `dist/pyodide/*` from the extension's `*.vscode-cdn.net` / `*.vscode-unpkg.net` origin.

- [ ] **Step 3: Repeat on github.dev**

Open a repo on `https://github.dev`, install the same extension, run the command. Expected: identical success.

- [ ] **Step 4: Record per-host results (pass / CORS-blocked / other) in FINDINGS.md, commit**

```bash
git add spikes/pyodide-web-worker/FINDINGS.md
git commit -m "spike(phase0): record real-host (vscode.dev + github.dev) results"
```

---

### Task 6 (conditional): CORS fallback — preload asset bytes via `workspace.fs`

Do this task **only if** Task 4 or Task 5 showed a CORS/fetch failure loading `dist/pyodide/*`.

**Files:**
- Modify: `spikes/pyodide-web-worker/src/pyodide-runtime.ts`

- [ ] **Step 1: Preload bytes and hand them to Pyodide**

Read each asset with `vscode.workspace.fs.readFile(vscode.Uri.joinPath(extensionUri, "dist", "pyodide", name))`, then load Pyodide from those bytes: import `pyodide.mjs` via a `Blob` URL (`URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }))`), and provide the wasm/stdlib/lock/wheels via a custom `lockFileURL`/`packageBaseUrl` backed by Blob URLs (or Pyodide's `loadPyodide({ indexURL, … })` with a `fetch` shim resolving to the preloaded bytes). Record how much shim code this required.

- [ ] **Step 2: Re-run Task 5 verification with the fallback; record whether it unblocks both hosts.**

- [ ] **Step 3: Commit**

```bash
git add spikes/pyodide-web-worker
git commit -m "spike(phase0): workspace.fs byte-preload fallback for CORS"
```

---

### Task 7: Findings report + go/no-go decision

**Files:**
- Modify: `spikes/pyodide-web-worker/FINDINGS.md`

- [ ] **Step 1: Write the report answering every open question**

`FINDINGS.md` must state, with evidence:
- **Does it load offline in the extension-host worker?** vscode.dev: yes/no (+ error). github.dev: yes/no (+ error).
- **CORS:** did direct `indexURL` fetch work, or was the `workspace.fs` byte-preload fallback (Task 6) required? How much extra code did the fallback cost?
- **Lint:** confirmed working in Pyodide? (yes/no).
- **Cold start:** measured ms for `init()` on each host; does it block the extension host noticeably? → **web threading recommendation** (inline vs nested worker) for spec §5.1/§13.
- **Bundle size:** actual `.vsix` size.
- **Verdict:** GO / GO-WITH-FALLBACK / NO-GO, and the concrete inputs Phase 1 & Phase 2 plans must assume.

- [ ] **Step 2: Commit the report**

```bash
git add spikes/pyodide-web-worker/FINDINGS.md
git commit -m "spike(phase0): findings + go/no-go for web target"
```

- [ ] **Step 3: Report back to the maintainer**

Summarize the verdict and the two decisions it feeds (CORS fallback needed? web threading model?) so the Phase 1 (desktop) and Phase 2 (web) plans can be written against real data. Do **not** delete the spike folder yet — its `glue.py.ts` and `fetch-assets.mjs` are lifted into Phase 1.

---

## Self-Review

**1. Spec coverage (Phase 0 scope only):** The spec's Phase 0 (§9) asks to prove (a) offline Pyodide load in the extension-host web worker on vscode.dev + github.dev with asset fetch + CORS, and (b) `linter()` working in Pyodide. Task 4/5 cover (a); Task 3 covers (b). The CORS fallback (§3.1 caveat 1, §13) is Task 6. The threading open question (§5.1, §13) is answered in Task 7. Covered.

**2. Placeholder scan:** The one deliberately descriptive step is Task 4 Step 1 (the lock-file wheel-copy logic) and Task 6 Step 1 (the shim) — both are inherently exploratory in a spike and are described with the exact APIs/URLs to use; acceptable for a spike, not a production task. No `TODO`/`TBD`/"handle edge cases".

**3. Type consistency:** `LintDiag { code, line, column, message }` is defined in Task 2 and reused in Task 3/Task 7 and matches the spec's `LintDiagnostic` (§4.1). `PyodideRuntime.init/format/lint` signatures are consistent across Tasks 2, 4, 6. The Python glue names `_djlint_format` / `_djlint_lint` are defined once (Task 2) and consumed by the same names.

**Note (not a production plan):** because this is a throwaway spike, tasks are build-and-verify rather than red-green-refactor. Phase 1 (desktop) and Phase 2 (web) will be separate, TDD-structured plans written after this spike's verdict.

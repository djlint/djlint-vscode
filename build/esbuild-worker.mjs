// Bundles the Pyodide worker, for Node or for the browser. glue.py goes in as
// text, and --minify minifies it as well, with build/minify_python.py.
// Usage: node build/esbuild-worker.mjs node|web [--minify] [--sourcemap] [--watch] [--metafile=FILE]
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { build, context } from "esbuild";

/**
 * @typedef {import("esbuild").BuildOptions} BuildOptions
 * @typedef {import("esbuild").Plugin} Plugin
 */

/** @type {Record<string, BuildOptions>} */
const TARGETS = {
  node: {
    entryPoints: ["src/engine/pyodide/worker.ts"],
    format: "cjs",
    outfile: "dist/pyodide-worker.cjs",
    platform: "node",
    target: "node22.20.0",
  },
  web: {
    entryPoints: ["src/engine/pyodide/worker.web.ts"],
    format: "iife",
    outfile: "dist/web/pyodide-worker.js",
    platform: "browser",
    target: "es2023",
  },
};

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    metafile: { type: "string" },
    minify: { type: "boolean", default: false },
    sourcemap: { type: "boolean", default: false },
    watch: { type: "boolean", default: false },
  },
});
const [name = ""] = positionals;
const target = Object.hasOwn(TARGETS, name) ? TARGETS[name] : void 0;
if (target == null || positionals.length > 1) {
  throw new Error(
    "usage: esbuild-worker.mjs node|web [--minify] [--sourcemap] [--watch] [--metafile=FILE]",
  );
}

/**
 * @param {string} source
 * @returns {string}
 */
function minifyPython(source) {
  return execFileSync(
    "uv",
    [
      "run",
      "--quiet",
      // Keeps the project's .venv as it is.
      "--isolated",
      "--locked",
      "--only-group",
      "minify",
      "--",
      "python",
      "build/minify_python.py",
      // The worker calls run() by its name.
      "run",
    ],
    { encoding: "utf8", input: source, stdio: ["pipe", "pipe", "inherit"] },
  );
}

/** @type {Plugin} */
const python = {
  name: "python",
  setup(pluginBuild) {
    // oxlint-disable-next-line require-unicode-regexp -- esbuild runs it as a Go regexp, which has no flags
    pluginBuild.onLoad({ filter: /\.py$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      return { contents: values.minify ? minifyPython(source) : source, loader: "text" };
    });
  },
};

// What the esbuild problem matcher of the watch task waits for, as the CLI prints it.
/** @type {Plugin} */
const watchLog = {
  name: "watch-log",
  setup(pluginBuild) {
    pluginBuild.onStart(() => {
      console.log("[watch] build started");
    });
    pluginBuild.onEnd(() => {
      console.log("[watch] build finished");
    });
  },
};

/** @type {BuildOptions} */
const options = {
  ...target,
  bundle: true,
  logLevel: "info",
  metafile: values.metafile != null,
  minify: values.minify,
  plugins: values.watch ? [python, watchLog] : [python],
  sourcemap: values.sourcemap,
};

if (values.watch) {
  const watched = await context(options);
  await watched.watch();
} else {
  const result = await build(options);
  if (values.metafile != null) {
    await writeFile(values.metafile, JSON.stringify(result.metafile));
  }
}

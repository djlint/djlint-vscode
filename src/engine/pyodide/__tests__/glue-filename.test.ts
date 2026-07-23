import { existsSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildWorker } from "../../__tests__/pyodide-harness.js";
import type { LintDiagnostic } from "../../types.js";
import type { WorkerRequest, WorkerResponse } from "../protocol.js";

// Talks to the real worker_thread directly (bypassing PyodideEngine) so the test can inject a `per_file_ignores` Config kwarg and an arbitrary `filename`, neither of which the extension's own settings surface exposes. This proves the `filename` field on `WorkerRequest` actually reaches djLint's `linter()` `filepath` argument and drives its `per-file-ignores` matching end to end (glue.ts + worker.ts + the wire protocol), which is the root cause fixed in this change.
const assetsDir = path.resolve("assets/pyodide");
const hasAssets = existsSync(path.join(assetsDir, "pyodide.mjs"));

function codesOf(result: string | LintDiagnostic[]): string[] {
  return Array.isArray(result) ? result.map((d) => d.code) : [];
}

describe.skipIf(!hasAssets)(
  "filename threading reaches djLint's per-file-ignores matching",
  () => {
    let worker: Worker;
    let seq = 0;

    beforeAll(async () => {
      worker = new Worker(await buildWorker(), {
        workerData: { indexURL: assetsDir },
      });
    }, 120_000);

    afterAll(async () => {
      await worker.terminate();
    });

    async function call(
      req: Omit<WorkerRequest, "id">,
    ): Promise<WorkerResponse> {
      seq += 1;
      const id = seq;
      return new Promise((resolve) => {
        const onMessage = (res: WorkerResponse): void => {
          if (res.id !== id) {
            return;
          }
          worker.off("message", onMessage);
          resolve(res);
        };
        worker.on("message", onMessage);
        // eslint-disable-next-line unicorn/require-post-message-target-origin -- node:worker_threads postMessage, not the browser window.postMessage this rule targets.
        worker.postMessage({ ...req, id } satisfies WorkerRequest);
      });
    }

    test("a per-file-ignores pattern only suppresses the rule for a matching filename", async () => {
      const src = '<img src="x">\n';
      // djLint's Config(per_file_ignores=...) kwarg name is snake_case; reference it via a variable computed key to keep the `camelcase` rule happy.
      const perFileIgnoresKwarg = "per_file_ignores";
      const opts: Record<string, unknown> = {
        [perFileIgnoresKwarg]: [[String.raw`ignored\.html$`, "H013"]],
        profile: "html",
      };

      const ignored = await call({
        filename: "templates/ignored.html",
        kind: "lint",
        opts,
        src,
      });
      const other = await call({
        filename: "templates/other.html",
        kind: "lint",
        opts,
        src,
      });

      expect(ignored.ok).toBe(true);
      expect(other.ok).toBe(true);
      if (!ignored.ok || !other.ok) {
        return;
      }

      expect(codesOf(ignored.result)).not.toContain("H013");
      expect(codesOf(other.result)).toContain("H013");
    }, 120_000);

    test("the default filename placeholder ('-') still lints normally", async () => {
      const src = '<img src="x">\n';
      const res = await call({ filename: "-", kind: "lint", opts: {}, src });

      expect(res.ok).toBe(true);
      if (!res.ok) {
        return;
      }
      expect(codesOf(res.result)).toContain("H013");
    }, 120_000);
  },
);

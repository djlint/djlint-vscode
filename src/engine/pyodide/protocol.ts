import type { LintDiagnostic } from "../types.js";

export interface WorkerRequest {
  id: number;
  kind: "format" | "lint";
  src: string;
  opts: Record<string, unknown>;
  // Path djLint should see, e.g. for `per-file-ignores` matching (forward slashes only; see `derivePyodideFilename()` in `../index.ts`).
  filename: string;
}

export type WorkerResponse =
  | { id: number; ok: true; result: string | LintDiagnostic[] }
  | { id: number; ok: false; error: string };

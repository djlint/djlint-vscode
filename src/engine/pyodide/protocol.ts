import type { LintDiagnostic } from "../types.js";

export interface WorkerRequest {
  id: number;
  kind: "format" | "lint";
  src: string;
  opts: Record<string, unknown>;
}

export type WorkerResponse =
  | { id: number; ok: true; result: string | LintDiagnostic[] }
  | { id: number; ok: false; error: string };

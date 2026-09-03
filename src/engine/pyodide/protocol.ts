import type { DjlintMode, LintDiagnostic } from "../types.js";

export interface WorkerRequest {
  id: number;
  kind: DjlintMode;
  src: string;
  opts: Record<string, unknown>;
  filename: string;
}

export type WorkerResult = string | LintDiagnostic[];

export type WorkerResponse =
  | { id: number; ok: true; result: WorkerResult }
  | { id: number; ok: false; error: string };

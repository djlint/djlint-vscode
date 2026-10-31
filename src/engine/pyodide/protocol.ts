import type { DjlintMode } from "../types.js";

export interface WorkerData {
  indexURL: string;
}

export interface RunRequest {
  type: "run";
  id: number;
  mode: DjlintMode;
  src: string;
  options: Record<string, unknown>;
  pathOptions: Record<string, string>;
  filename: string;
  cwd: string | undefined;
}

export interface CancelRequest {
  type: "cancel";
  id: number;
}

export type WorkerRequest = CancelRequest | RunRequest;

export type RunResponse =
  | { type: "result"; id: number; ok: false; error: string }
  | { type: "result"; id: number; ok: true; output: string };

export interface LogMessage {
  type: "log";
  level: "debug" | "info" | "warn";
  line: string;
}

export type WorkerResponse = LogMessage | RunResponse;

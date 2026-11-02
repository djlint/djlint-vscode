import type { DjlintMode } from "../types.js";

export interface WorkerData {
  indexURL: string;
}

export interface ProjectSnapshot {
  cwd: string;
  files: Record<string, string>;
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
  project: ProjectSnapshot | undefined;
}

interface CancelRequest {
  type: "cancel";
  id: number;
}

export type WorkerRequest = CancelRequest | RunRequest;

export type RunResponse =
  | { type: "result"; id: number; ok: false; error: string }
  | { type: "result"; id: number; ok: true; output: string };

interface LogMessage {
  type: "log";
  level: "debug" | "warn";
  line: string;
}

interface ReadyMessage {
  type: "ready";
  version: string;
}

interface BootFailedMessage {
  type: "boot-failed";
  error: string;
}

interface CrashedMessage {
  type: "crashed";
  error: string;
}

export type WorkerResponse =
  | BootFailedMessage
  | CrashedMessage
  | LogMessage
  | ReadyMessage
  | RunResponse;

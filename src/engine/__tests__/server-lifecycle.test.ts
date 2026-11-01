// When SubprocessEngine starts and stops its language servers, with DjlintServer
// replaced: a server left running keeps its environment and folder locked on Windows.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  liveToken,
  makeChannel,
  makeConfig,
  makeDocument,
  makePythonEnvironments,
  makeStatus,
  setWorkspaceFolders,
} from "../../__tests__/helpers.js";
import {
  fireWorkspaceEvent,
  resetVscode,
  Uri,
} from "../../__tests__/vscode-stub.js";
import { SubprocessEngine } from "../subprocess/index.js";

const { servers, spawn } = vi.hoisted(() => ({
  servers: [] as { dispose: () => void; isStopped: boolean }[],
  spawn: vi.fn<() => Promise<{ exitCode?: number; stdout: string }>>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  stat: vi.fn<() => Promise<object>>(async () => ({})),
}));

vi.mock("which-command", () => ({
  whichCommand: async (command: string) => command,
}));

vi.mock("execa", async (importOriginal) => ({
  ...(await importOriginal<typeof import("execa")>()),
  execa: async () => ({ stderr: "", ...(await spawn()) }),
}));

vi.mock("../subprocess/server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../subprocess/server.js")>()),
  DjlintServer: class {
    isClosed = false;
    isStopped = false;
    isStopping = false;

    constructor() {
      servers.push(this);
    }

    dispose(): void {
      this.isStopped = true;
    }

    lint = vi.fn<() => Promise<never[]>>().mockResolvedValue([]);
  },
}));

const VERSION = { exitCode: 0, stdout: "djlint, version 1.49.0" };
const document = makeDocument("/w/t.html", "<p>x</p>");
const config = makeConfig({ executablePath: "/bin/djlint" });

function makeEngine(): {
  engine: SubprocessEngine;
  fireEnvironmentChange: () => void;
} {
  const { environments, fireChange } = makePythonEnvironments();
  return {
    engine: new SubprocessEngine(makeChannel(), environments, makeStatus()),
    fireEnvironmentChange: fireChange,
  };
}

/** Holds the `--version` probe until `finish` runs. */
function holdProbe(): () => void {
  const { promise, resolve } = Promise.withResolvers<typeof VERSION>();
  spawn.mockImplementation(async () => promise);
  return () => {
    resolve(VERSION);
  };
}

beforeEach(() => {
  resetVscode();
  servers.length = 0;
  spawn.mockReset();
  spawn.mockResolvedValue(VERSION);
  setWorkspaceFolders("/w");
});

describe("a language server", () => {
  it("starts for a run", async () => {
    const { engine } = makeEngine();
    await engine.lint(document, config, liveToken());
    expect(servers).toHaveLength(1);
  });

  it("doesn't start once the engine has stopped", async () => {
    const finish = holdProbe();
    const { engine } = makeEngine();
    const run = engine.lint(document, config, liveToken());
    engine.dispose();
    finish();
    await run.catch(() => void 0);
    expect(servers).toHaveLength(0);
  });

  it("doesn't start for an environment that was left during the lookup", async () => {
    const finish = holdProbe();
    const { engine, fireEnvironmentChange } = makeEngine();
    const run = engine.lint(document, config, liveToken());
    fireEnvironmentChange();
    finish();
    await run.catch(() => void 0);
    expect(servers).toHaveLength(0);
  });

  it("stops with its workspace folder", async () => {
    const { engine } = makeEngine();
    await engine.lint(document, config, liveToken());
    fireWorkspaceEvent("folders", {
      added: [],
      removed: [{ uri: Uri.file("/other") }],
    });
    expect(servers[0]?.isStopped).toBe(false);
    fireWorkspaceEvent("folders", {
      added: [],
      removed: [{ uri: Uri.file("/w") }],
    });
    expect(servers[0]?.isStopped).toBe(true);
  });
});

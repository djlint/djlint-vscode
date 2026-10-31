// Activation wiring: which events actually cause the extension to drop its
// resolved-djLint state. Getting this wrong is invisible in normal use:
// changing djlint.executablePath would simply keep running the old djLint until
// the 5-minute TTL lapsed.
import { execa } from "execa";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { EngineManager, engineSettingKeys } from "../engine/select.js";
import { activate } from "../extension.js";
import { DjlintStatus } from "../status.js";
import { changeOf, flush, makeContext, makeDocument } from "./helpers.js";
import {
  control,
  fireWorkspaceEvent,
  resetVscode,
  workspaceListenerCount,
} from "./vscode-stub.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  stat: vi.fn(async () => ({})),
}));
vi.mock("which-command", () => ({
  whichCommand: async (command: string) => command,
}));
vi.mock("execa", async (importOriginal) => ({
  ...(await importOriginal<typeof import("execa")>()),
  execa: vi.fn(),
}));
vi.mock("@vscode/python-environments", () => ({
  EXTENSION_ID: "ms-python.vscode-python-envs",
}));
vi.mock(
  "@vscode/python-extension",
  async () => import("./python-extension-mock.js"),
);

type Spawn = (
  exec: string,
  args: readonly string[],
) => Promise<{ exitCode: number; stdout: string }>;

const spawn = execa as unknown as Mock<Spawn>;

const document = makeDocument("/w/a.html", "<p>x</p>");

let context: vscode.ExtensionContext;

function probes(): number {
  return spawn.mock.calls.filter(([, args]) => args.includes("--version"))
    .length;
}

/**
 * Whether `action` dropped the resolved djLint: warm the cache, run it, and see
 * whether the next lint has to probe again. Watching other side effects would
 * not discriminate, since Linter has a config listener of its own.
 */
async function reacted(action: () => void): Promise<boolean> {
  fireWorkspaceEvent("open", document);
  await flush();
  const before = probes();
  action();
  await flush();
  fireWorkspaceEvent("open", document);
  await flush();
  return probes() > before;
}

beforeEach(() => {
  resetVscode();
  control.configuration = {
    enableLinting: true,
    executablePath: "/bin/djlint",
  };
  spawn.mockReset();
  spawn.mockImplementation(async (_exec, args) => ({
    exitCode: 0,
    stdout: args.includes("--version") ? "djlint, version 1.44.2" : "",
  }));
  context = makeContext();
  activate(context);
});

afterEach(() => {
  for (const subscription of context.subscriptions) {
    subscription.dispose();
  }
});

describe("activate", () => {
  it("registers its listeners and the restart command", () => {
    expect(workspaceListenerCount("config")).toBeGreaterThan(0);
    expect(workspaceListenerCount("trust")).toBeGreaterThan(0);
    expect(typeof control.commands.get("djlint.restart")).toBe("function");
  });

  it("opens one output channel", () => {
    expect(control.outputChannels).toHaveLength(1);
  });

  it.each(engineSettingKeys)(
    "re-resolves when djlint.%s changes",
    async (key) => {
      await expect(
        reacted(() => {
          fireWorkspaceEvent("config", changeOf(`djlint.${key}`));
        }),
      ).resolves.toBe(true);
    },
  );

  it("does not pay for that when an output-only setting changes", async () => {
    await expect(
      reacted(() => {
        fireWorkspaceEvent("config", changeOf("djlint.maxLineLength"));
      }),
    ).resolves.toBe(false);
  });

  it("does not react to other extensions' settings", async () => {
    await expect(
      reacted(() => {
        fireWorkspaceEvent("config", changeOf("editor.tabSize"));
      }),
    ).resolves.toBe(false);
  });

  it("re-resolves on djLint: Restart", async () => {
    await expect(
      reacted(() => {
        control.commands.get("djlint.restart")?.();
      }),
    ).resolves.toBe(true);
  });

  it("re-resolves when the workspace is trusted", async () => {
    await expect(
      reacted(() => {
        fireWorkspaceEvent("trust");
      }),
    ).resolves.toBe(true);
  });

  describe("when the active Python environment changes", () => {
    let fireEnvironmentChange = (): void => void 0;
    let activePath = "/py";

    beforeEach(() => {
      activePath = "/py";
      const environments = {
        getActiveEnvironmentPath: () => ({ path: activePath }),
        onDidChangeActiveEnvironmentPath: (listener: () => void) => {
          fireEnvironmentChange = listener;
          return { dispose: () => void 0 };
        },
        resolveEnvironment: async ({ path }: { path: string }) => ({
          executable: { uri: { fsPath: path } },
        }),
      };
      control.extensions.set("ms-python.python", {
        exports: { environments },
        isActive: true,
      });
      control.configuration = { enableLinting: true, useVenv: true };
    });

    it("resolves djLint for the new environment", async () => {
      await expect(
        reacted(() => {
          activePath = "/other";
          fireEnvironmentChange();
        }),
      ).resolves.toBe(true);
    });

    it("lints after forgetting, so the status shows the new djLint", async () => {
      control.documents = [document];
      fireWorkspaceEvent("open", document);
      await flush();
      const update = vi.spyOn(DjlintStatus.prototype, "update");
      activePath = "/other";
      fireEnvironmentChange();
      await flush();
      expect(update).toHaveBeenCalled();
      update.mockRestore();
    });

    it("keeps the engines, and with them a running Pyodide", async () => {
      const reset = vi.spyOn(EngineManager.prototype, "reset");
      fireWorkspaceEvent("open", document);
      await flush();
      reset.mockClear();
      fireEnvironmentChange();
      await flush();
      expect(reset).not.toHaveBeenCalled();
      reset.mockRestore();
    });
  });

  it("relints open documents after a restart", async () => {
    control.documents = [document];
    await flush();
    const lintRuns = (): number => spawn.mock.calls.length - probes();
    const before = lintRuns();
    control.commands.get("djlint.restart")?.();
    await flush();
    expect(lintRuns()).toBe(before + 1);
  });
});

// Config changes fire for the whole window, and most belong to other
// extensions. Rejecting those must cost a constant number of queries, not one
// per lint setting per open document, which is what it degrades into without
// the parent-section early-out.
describe("the cost of a configuration change", () => {
  const documents = Array.from({ length: 8 }, (_unused, index) =>
    makeDocument(`/w/${index}.html`),
  );

  function queriesFor(
    answer: (query: string) => boolean,
    openDocuments: readonly unknown[],
  ): string[] {
    const asked: string[] = [];
    control.documents = openDocuments;
    fireWorkspaceEvent("config", {
      affectsConfiguration: (query: string) => {
        asked.push(query);
        return answer(query);
      },
    });
    return asked;
  }

  it("is constant for a change that is not ours", () => {
    const withNoDocuments = queriesFor(() => false, []);
    const withEight = queriesFor(() => false, documents);
    expect(withEight).toHaveLength(withNoDocuments.length);
    expect(withEight.every((query) => query.startsWith("djlint"))).toBe(true);
  });

  it("is constant for a setting that only picks which djLint runs", () => {
    const { affectsConfiguration } = changeOf("djlint.executablePath");
    const answer = (query: string): boolean => affectsConfiguration(query);
    expect(queriesFor(answer, documents)).toHaveLength(
      queriesFor(answer, []).length,
    );
  });
});

describe("disposal", () => {
  it("leaves only disposable subscriptions, which dispose cleanly", () => {
    const local = makeContext();
    activate(local);
    expect(
      local.subscriptions.every(
        (subscription) => typeof subscription.dispose === "function",
      ),
    ).toBe(true);
    expect(() => {
      for (const subscription of local.subscriptions) {
        subscription.dispose();
      }
    }).not.toThrow();
  });
});

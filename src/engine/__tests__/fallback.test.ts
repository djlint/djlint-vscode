// FallbackEngine decides whether a user gets their own djLint or the bundled
// runtime, and for how long.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  formattingOptions,
  liveToken,
  makeChannel,
  makeConfig,
  makeDocument,
  setWorkspaceFolders,
} from "../../__tests__/helpers.js";
import { resetVscode } from "../../__tests__/vscode-stub.js";
import { FallbackEngine } from "../select.js";
import {
  DjlintUnavailableError,
  RESOLUTION_TTL_MS,
  type DjlintEngine,
  type LintDiagnostic,
} from "../types.js";

const finding: LintDiagnostic = {
  code: "H1",
  column: 0,
  line: 1,
  message: "m",
};

function unavailable(): never {
  throw new DjlintUnavailableError("nope");
}

function makeFallback(primaryBehaviour: () => string): {
  calls: string[];
  channel: ReturnType<typeof makeChannel>;
  engine: FallbackEngine;
  secondaryBuilds: () => number;
} {
  const calls: string[] = [];
  const primary: DjlintEngine = {
    dispose: () => {
      calls.push("primary-dispose");
    },
    format: async () => {
      calls.push("primary");
      return primaryBehaviour();
    },
    lint: async () => {
      calls.push("primary");
      primaryBehaviour();
      return [];
    },
  };
  const secondary: DjlintEngine = {
    dispose: () => {
      calls.push("secondary-dispose");
    },
    format: async () => {
      calls.push("secondary");
      return "SECONDARY";
    },
    lint: async () => {
      calls.push("secondary");
      return [finding];
    },
  };
  let builds = 0;
  const channel = makeChannel();
  const engine = new FallbackEngine(
    primary,
    () => {
      builds += 1;
      return secondary;
    },
    channel,
  );
  return { calls, channel, engine, secondaryBuilds: () => builds };
}

const document = makeDocument("/w/a.html");
const config = makeConfig();

async function format(
  engine: FallbackEngine,
  target: vscode.TextDocument = document,
  workspaceConfig: vscode.WorkspaceConfiguration = config,
): Promise<string> {
  return engine.format(target, workspaceConfig, formattingOptions, liveToken());
}

beforeEach(() => {
  resetVscode();
  setWorkspaceFolders("/w", "/bad", "/good");
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FallbackEngine", () => {
  it("keeps to a healthy primary and never builds the secondary", async () => {
    const { calls, engine, secondaryBuilds } = makeFallback(() => "PRIMARY");
    await expect(format(engine)).resolves.toBe("PRIMARY");
    await format(engine);
    expect(calls).toStrictEqual(["primary", "primary"]);
    expect(secondaryBuilds()).toBe(0);
  });

  it("falls back and stays on the secondary for the TTL", async () => {
    const { calls, engine } = makeFallback(unavailable);
    await expect(format(engine)).resolves.toBe("SECONDARY");
    await format(engine);
    expect(calls).toStrictEqual(["primary", "secondary", "secondary"]);

    vi.advanceTimersByTime(RESOLUTION_TTL_MS - 1);
    await format(engine);
    expect(calls).toHaveLength(4);
    expect(calls[3]).toBe("secondary");
  });

  it("retries the primary once the TTL lapses", async () => {
    const { calls, engine } = makeFallback(unavailable);
    await format(engine);
    vi.advanceTimersByTime(RESOLUTION_TTL_MS + 1);
    await format(engine);
    expect(calls).toStrictEqual([
      "primary",
      "secondary",
      "primary",
      "secondary",
    ]);
  });

  it("goes back to a primary that recovered", async () => {
    let isMissing = true;
    const { engine } = makeFallback(() =>
      isMissing ? unavailable() : "PRIMARY",
    );
    await format(engine);
    isMissing = false;
    vi.advanceTimersByTime(RESOLUTION_TTL_MS + 1);
    await expect(format(engine)).resolves.toBe("PRIMARY");
  });

  it("lets a genuine error reach the user instead of falling back", async () => {
    const { calls, engine } = makeFallback(() => {
      throw new Error("djLint blew up");
    });
    await expect(format(engine)).rejects.toThrow("djLint blew up");
    expect(calls).toStrictEqual(["primary"]);
  });

  it("keeps one folder's missing djLint from diverting another", async () => {
    const seen: string[] = [];
    const record = (engineName: string, target: vscode.TextDocument): void => {
      seen.push(`${engineName}:${target.uri.path}`);
    };
    const engine = new FallbackEngine(
      {
        dispose: () => void 0,
        format: async (target) => {
          record("primary", target);
          return target.uri.path.startsWith("/bad") ? unavailable() : "PRIMARY";
        },
        lint: async () => [],
      },
      () => ({
        dispose: () => void 0,
        format: async (target) => {
          record("secondary", target);
          return "SECONDARY";
        },
        lint: async () => [],
      }),
      makeChannel(),
    );
    await format(engine, makeDocument("/bad/x.html"));
    await expect(format(engine, makeDocument("/good/y.html"))).resolves.toBe(
      "PRIMARY",
    );
    expect(seen).toStrictEqual([
      "primary:/bad/x.html",
      "secondary:/bad/x.html",
      "primary:/good/y.html",
    ]);
  });

  it("refuses work once disposed", async () => {
    const { engine, secondaryBuilds } = makeFallback(unavailable);
    engine.dispose();
    await expect(format(engine)).rejects.toBeInstanceOf(
      vscode.CancellationError,
    );
    expect(secondaryBuilds()).toBe(0);
  });

  it("disposes both engines", async () => {
    const { calls, engine } = makeFallback(unavailable);
    await format(engine);
    engine.dispose();
    expect(calls).toContain("primary-dispose");
    expect(calls).toContain("secondary-dispose");
  });

  it("does not build a secondary just to dispose it", () => {
    const { engine, secondaryBuilds } = makeFallback(() => "PRIMARY");
    engine.dispose();
    expect(secondaryBuilds()).toBe(0);
  });

  it("makes format and lint racing on a missing primary share one secondary", async () => {
    const { channel, engine, secondaryBuilds } = makeFallback(unavailable);
    const [formatted, diagnostics] = await Promise.all([
      format(engine),
      engine.lint(document, config, liveToken()),
    ]);
    expect(formatted).toBe("SECONDARY");
    expect(diagnostics).toStrictEqual([finding]);
    expect(secondaryBuilds()).toBe(1);
    expect(channel.of("info")).toHaveLength(1);
  });

  it("logs the fallback again only after the TTL", async () => {
    const { channel, engine } = makeFallback(unavailable);
    await format(engine);
    await format(engine);
    expect(channel.of("info")).toHaveLength(1);

    vi.advanceTimersByTime(RESOLUTION_TTL_MS + 1);
    await format(engine);
    expect(channel.of("info")).toHaveLength(2);
  });
});

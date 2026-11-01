// The save path: format and lint fire simultaneously for the same document, so
// they race on CommandResolver. This exercises the interleavings that actually
// happen on every save.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandResolver } from "../engine/subprocess/resolve.js";
import type { ResolveDjlintCommandDeps } from "../engine/subprocess/resolve.js";
import { DjlintUnavailableError, RESOLUTION_TTL_MS } from "../engine/types.js";

function makeDeps(probe: ResolveDjlintCommandDeps["probe"]): ResolveDjlintCommandDeps {
  return {
    activeEnvironment: null,
    executablePath: "/bin/djlint",
    onConfiguredPathRejected: () => void 0,
    probe,
    pythonPath: "",
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe(CommandResolver, () => {
  it("shares one resolution between concurrent callers", async () => {
    const resolver = new CommandResolver();
    let probes = 0;
    const gate = Promise.withResolvers<undefined>();
    const deps = makeDeps(async () => {
      probes += 1;
      await gate.promise;
      return "1.44.2";
    });
    const format = resolver.resolve(deps, "ws", "dir");
    const lint = resolver.resolve(deps, "ws", "dir");
    gate.resolve(void 0);
    const results = await Promise.all([format, lint]);
    expect(results.map(({ exec }) => exec)).toStrictEqual(["/bin/djlint", "/bin/djlint"]);
    expect(probes).toBe(1);
  });

  it("serves from the cache until the TTL lapses", async () => {
    const resolver = new CommandResolver();
    let probes = 0;
    const deps = makeDeps(async () => {
      probes += 1;
      return "1.44.2";
    });
    await resolver.resolve(deps, "ws", "dir");
    await resolver.resolve(deps, "ws", "dir");
    expect(probes).toBe(1);

    vi.advanceTimersByTime(RESOLUTION_TTL_MS - 1);
    await resolver.resolve(deps, "ws", "dir");
    expect(probes).toBe(1);

    vi.advanceTimersByTime(1);
    await resolver.resolve(deps, "ws", "dir");
    expect(probes).toBe(2);
  });

  it("resolves distinct workspace folders independently", async () => {
    const resolver = new CommandResolver();
    const seen: string[] = [];
    const deps = makeDeps(async (exec) => {
      seen.push(exec);
      return "1.44.2";
    });
    await Promise.all([
      resolver.resolve(deps, "ws-a", "dir"),
      resolver.resolve(deps, "ws-b", "dir"),
    ]);
    expect(seen).toHaveLength(2);
  });

  it("does not let an in-flight resolution undo an invalidation", async () => {
    const resolver = new CommandResolver();
    let probes = 0;
    const gate = Promise.withResolvers<undefined>();
    const deps = makeDeps(async () => {
      probes += 1;
      await gate.promise;
      return "1.44.2";
    });
    const inFlight = resolver.resolve(deps, "ws", "dir");
    resolver.invalidate(); // e.g. the user runs djLint: Restart
    gate.resolve(void 0);
    await expect(inFlight).resolves.toMatchObject({ exec: "/bin/djlint" });
    expect(probes).toBe(1);

    await resolver.resolve(deps, "ws", "dir");
    expect(probes).toBe(2);
  });

  it("does not share a resolution across an invalidation", async () => {
    const resolver = new CommandResolver();
    const gates = [Promise.withResolvers<string>(), Promise.withResolvers<string>()];
    let calls = 0;
    const deps = makeDeps(async () => {
      calls += 1;
      return gates[calls - 1]?.promise ?? null;
    });
    const stale = resolver.resolve(deps, "ws", "dir");
    resolver.invalidate();
    const fresh = resolver.resolve(deps, "ws", "dir");
    gates[0]?.resolve("1.0");
    await stale;
    gates[1]?.resolve("2.0");
    await expect(fresh).resolves.toMatchObject({ version: "2.0" });
    await expect(resolver.resolve(deps, "ws", "dir")).resolves.toMatchObject({ version: "2.0" });
    expect(calls).toBe(2);
  });

  it("remembers a missing djLint until the TTL lapses", async () => {
    const resolver = new CommandResolver();
    let installed = false;
    let probes = 0;
    const deps = makeDeps(async () => {
      probes += 1;
      return installed ? "1.44.2" : null;
    });
    await expect(resolver.resolve(deps, "ws", "dir")).rejects.toBeInstanceOf(
      DjlintUnavailableError,
    );
    const probesWhileMissing = probes;

    installed = true;
    await expect(resolver.resolve(deps, "ws", "dir")).rejects.toBeInstanceOf(
      DjlintUnavailableError,
    );
    expect(probes).toBe(probesWhileMissing);

    vi.advanceTimersByTime(RESOLUTION_TTL_MS);
    await expect(resolver.resolve(deps, "ws", "dir")).resolves.toMatchObject({
      exec: "/bin/djlint",
    });
  });

  it("forgets a missing djLint on invalidation", async () => {
    const resolver = new CommandResolver();
    let installed = false;
    const deps = makeDeps(async () => (installed ? "1.44.2" : null));
    await expect(resolver.resolve(deps, "ws", "dir")).rejects.toBeInstanceOf(
      DjlintUnavailableError,
    );
    installed = true;
    resolver.invalidate();
    await expect(resolver.resolve(deps, "ws", "dir")).resolves.toMatchObject({
      exec: "/bin/djlint",
    });
  });
});

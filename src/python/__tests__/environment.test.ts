// Provider selection between the Python Environments extension and the classic
// Python extension, plus the change-event dedup and the unavailable-latch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import { makeChannel } from "../../__tests__/helpers.js";
import { control, fireWorkspaceEvent, resetVscode } from "../../__tests__/vscode-stub.js";
import { ENVIRONMENT_TIMEOUT_MS, PythonEnvironments } from "../environment.js";

vi.mock("@vscode/python-environments", () => ({ EXTENSION_ID: "ms-python.vscode-python-envs" }));
vi.mock("@vscode/python-extension", async () => import("../../__tests__/python-extension-mock.js"));

const ENVS_ID = "ms-python.vscode-python-envs";
const PY_ID = "ms-python.python";

function environment(executable: string, args: readonly string[] = []): object {
  return {
    environmentPath: { toString: () => executable },
    execInfo: { run: { args, executable } },
    sysPrefix: "/p",
    version: "3.12",
  };
}

/** A Python Environments extension whose API returns `active`. */
function envsExtension(
  active: unknown,
  options: { activateThrows?: boolean; exportsApi?: boolean } = {},
): {
  extension: { activate: () => Promise<unknown>; exports: unknown; isActive: boolean };
  fire: (event: unknown) => void;
  getEnvironment: ReturnType<typeof vi.fn>;
} {
  const listeners: ((event: unknown) => void)[] = [];
  const getEnvironment = vi.fn<() => Promise<unknown>>(async () => active);
  const api = {
    getEnvironment,
    onDidChangeEnvironment: (listener: (event: unknown) => void) => {
      listeners.push(listener);
      return {
        dispose: () => {
          listeners.length = 0;
        },
      };
    },
  };
  const exported = options.exportsApi === false ? void 0 : api;
  return {
    extension: {
      activate: async () => {
        if (options.activateThrows) {
          throw new Error("boom");
        }
        return exported;
      },
      exports: exported,
      isActive: !options.activateThrows,
    },
    fire: (event) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
    getEnvironment,
  };
}

function classicExtension(executable: string | null | undefined): {
  extension: object;
  fireChange: () => void;
} {
  const listeners = new Set<() => void>();
  const api = {
    environments: {
      getActiveEnvironmentPath: () => ({ path: executable ?? "" }),
      onDidChangeActiveEnvironmentPath: (listener: () => void) => {
        listeners.add(listener);
        return {
          dispose: () => {
            listeners.delete(listener);
          },
        };
      },
      resolveEnvironment: async () =>
        executable === null
          ? void 0
          : { executable: { uri: executable == null ? void 0 : { fsPath: executable } } },
    },
  };
  return {
    extension: { activate: async () => api, exports: api, isActive: true },
    fireChange: () => {
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

function makeEnvironments(): {
  channel: ReturnType<typeof makeChannel>;
  environments: PythonEnvironments;
} {
  const channel = makeChannel();
  return { channel, environments: new PythonEnvironments(channel) };
}

const classicResult = { command: { args: [], executable: "/usr/bin/python" } };

beforeEach(() => {
  resetVscode();
  control.configuration = { useEnvironmentsExtension: true };
});

describe("provider selection", () => {
  it("has no environment with neither extension installed", async () => {
    const { environments } = makeEnvironments();
    await expect(environments.getActive(void 0)).resolves.toBeNull();
  });

  it("stays latched until reset, then picks up a new install", async () => {
    const { environments } = makeEnvironments();
    await environments.getActive(void 0);

    control.extensions.set(PY_ID, classicExtension("/usr/bin/python").extension);
    await expect(environments.getActive(void 0)).resolves.toBeNull();

    environments.resetIfUnavailable();
    await expect(environments.getActive(void 0)).resolves.toStrictEqual(classicResult);
  });

  it("picks up a Python extension installed while running", async () => {
    const { environments } = makeEnvironments();
    const onChange = vi.fn<() => void>();
    environments.onDidChange(onChange);
    await environments.getActive(void 0);

    control.extensions.set(PY_ID, classicExtension("/usr/bin/python").extension);
    fireWorkspaceEvent("extensions");
    expect(onChange).toHaveBeenCalledOnce();
    await expect(environments.getActive(void 0)).resolves.toStrictEqual(classicResult);
  });

  it("ignores other extensions once it has a provider", async () => {
    control.extensions.set(PY_ID, classicExtension("/usr/bin/python").extension);
    const { environments } = makeEnvironments();
    const onChange = vi.fn<() => void>();
    environments.onDidChange(onChange);
    await environments.getActive(void 0);

    fireWorkspaceEvent("extensions");
    expect(onChange).not.toHaveBeenCalled();
  });

  describe("with python.useEnvironmentsExtension off, the default", () => {
    beforeEach(() => {
      control.configuration = {};
    });

    it("follows the classic extension, which holds the selection", async () => {
      control.extensions.set(ENVS_ID, envsExtension(environment("conda", ["run"])).extension);
      control.extensions.set(PY_ID, classicExtension("/usr/bin/python").extension);
      const { environments } = makeEnvironments();
      await expect(environments.getActive(void 0)).resolves.toStrictEqual(classicResult);
    });

    it("still reads Python Environments when it is all there is", async () => {
      const conda = environment("conda", ["run"]);
      control.extensions.set(ENVS_ID, envsExtension(conda).extension);
      const { environments } = makeEnvironments();
      await expect(environments.getActive(void 0)).resolves.toMatchObject({
        command: { args: ["run"] },
      });
    });
  });

  describe("with an extension that never answers", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function hangingExtension(): {
      answer: (value: unknown) => void;
      extension: unknown;
      fireChange: () => void;
      lookups: () => number;
      subscriptions: () => number;
    } {
      const { promise, resolve } = Promise.withResolvers<unknown>();
      const { extension } = envsExtension(void 0);
      const listeners: ((event: unknown) => void)[] = [];
      const api = {
        getEnvironment: vi.fn<() => Promise<unknown>>(async () => promise),
        onDidChangeEnvironment: (listener: (event: unknown) => void) => {
          listeners.push(listener);
          return { dispose: () => void 0 };
        },
      };
      return {
        answer: resolve,
        extension: { ...extension, exports: api },
        fireChange: () => {
          for (const listener of listeners) {
            listener({ new: environment("/new", []) });
          }
        },
        lookups: () => api.getEnvironment.mock.calls.length,
        subscriptions: () => listeners.length,
      };
    }

    it("stops waiting, then does not wait again", async () => {
      const { extension } = hangingExtension();
      control.extensions.set(ENVS_ID, extension);
      const { channel, environments } = makeEnvironments();
      const first = environments.getActive(void 0);
      await vi.advanceTimersByTimeAsync(ENVIRONMENT_TIMEOUT_MS);
      await expect(first).resolves.toBeNull();
      expect(channel.of("warn")).toHaveLength(1);
      await expect(environments.getActive(void 0)).resolves.toBeNull();
    });

    it("tells when it does answer", async () => {
      const { answer, extension } = hangingExtension();
      control.extensions.set(ENVS_ID, extension);
      const { environments } = makeEnvironments();
      const onChange = vi.fn<() => void>();
      environments.onDidChange(onChange);
      const first = environments.getActive(void 0);
      await vi.advanceTimersByTimeAsync(ENVIRONMENT_TIMEOUT_MS);
      await first;
      answer(environment("/late", []));
      await vi.advanceTimersByTimeAsync(0);
      expect(onChange).toHaveBeenCalledOnce();
    });

    it("tries again on a restart, on the same subscription", async () => {
      const { answer, extension, subscriptions } = hangingExtension();
      control.extensions.set(ENVS_ID, extension);
      const { environments } = makeEnvironments();
      const first = environments.getActive(void 0);
      await vi.advanceTimersByTimeAsync(ENVIRONMENT_TIMEOUT_MS);
      await first;
      environments.resetIfUnavailable();
      const second = environments.getActive(void 0);
      answer(environment("/py", []));
      await expect(second).resolves.toMatchObject({ command: { executable: "/py" } });
      expect(subscriptions()).toBe(1);
    });

    it("takes a change of environment for an answer", async () => {
      const { extension, fireChange, lookups } = hangingExtension();
      control.extensions.set(ENVS_ID, extension);
      const { environments } = makeEnvironments();
      const onChange = vi.fn<() => void>();
      environments.onDidChange(onChange);
      const first = environments.getActive(void 0);
      await vi.advanceTimersByTimeAsync(ENVIRONMENT_TIMEOUT_MS);
      await first;
      fireChange();
      expect(onChange).toHaveBeenCalledOnce();
      const second = environments.getActive(void 0);
      await vi.advanceTimersByTimeAsync(ENVIRONMENT_TIMEOUT_MS);
      await second;
      expect(lookups()).toBe(2);
    });
  });

  it("prefers Python Environments over the classic extension", async () => {
    control.extensions.set(
      ENVS_ID,
      envsExtension(environment("conda", ["run", "-p", "/env"])).extension,
    );
    control.extensions.set(PY_ID, classicExtension("/not/used").extension);
    const { environments } = makeEnvironments();
    await expect(environments.getActive(void 0)).resolves.toStrictEqual({
      command: { args: ["run", "-p", "/env"], executable: "conda" },
    });
  });

  it("tolerates a run without args", async () => {
    control.extensions.set(
      ENVS_ID,
      envsExtension({
        environmentPath: { toString: () => "/py" },
        execInfo: { run: { executable: "/py" } },
      }).extension,
    );
    const { environments } = makeEnvironments();
    await expect(environments.getActive(void 0)).resolves.toStrictEqual({
      command: { args: [], executable: "/py" },
    });
  });

  // python.useEnvironmentsExtension=false: the extension exports no API.
  it("falls back to classic when Python Environments exports no API", async () => {
    control.extensions.set(ENVS_ID, envsExtension(null, { exportsApi: false }).extension);
    control.extensions.set(PY_ID, classicExtension("/usr/bin/python").extension);
    const { environments } = makeEnvironments();
    await expect(environments.getActive(void 0)).resolves.toStrictEqual(classicResult);
  });

  it("falls back to classic when activation fails", async () => {
    control.extensions.set(ENVS_ID, envsExtension(null, { activateThrows: true }).extension);
    control.extensions.set(PY_ID, classicExtension("/usr/bin/python").extension);
    const { channel, environments } = makeEnvironments();
    await expect(environments.getActive(void 0)).resolves.toStrictEqual(classicResult);
    expect(channel.of("warn").join()).toContain("boom");
  });

  // An API shape we can't wire a change listener to must not poison activation.
  it("falls back to classic when the API is unusable", async () => {
    const broken = { getEnvironment: async () => null };
    control.extensions.set(ENVS_ID, {
      activate: async () => broken,
      exports: broken,
      isActive: true,
    });
    control.extensions.set(PY_ID, classicExtension("/usr/bin/python").extension);
    const { environments } = makeEnvironments();
    await expect(environments.getActive(void 0)).resolves.toStrictEqual(classicResult);
  });

  it("falls back to nothing when the classic API is unusable too", async () => {
    control.extensions.set(PY_ID, { activate: async () => ({}), exports: {}, isActive: true });
    const { channel, environments } = makeEnvironments();
    await expect(environments.getActive(void 0)).resolves.toBeNull();
    expect(channel.of("warn")).toHaveLength(1);
  });

  it("activates an extension that is not active yet", async () => {
    const activate = vi.fn<() => Promise<void>>(async () => void 0);
    const { extension } = classicExtension("/usr/bin/python");
    control.extensions.set(PY_ID, { ...extension, activate, isActive: false });
    const { environments } = makeEnvironments();
    await expect(environments.getActive(void 0)).resolves.toStrictEqual(classicResult);
    expect(activate).toHaveBeenCalledOnce();
  });
});

describe("the active environment", () => {
  it("is null for one flagged broken, and says why", async () => {
    control.extensions.set(
      ENVS_ID,
      envsExtension({
        ...environment("/broken"),
        environmentPath: { toString: () => "/x" },
        error: "interpreter is broken",
      }).extension,
    );
    const { channel, environments } = makeEnvironments();
    await expect(environments.getActive(void 0)).resolves.toBeNull();
    expect(channel.of("warn").join()).toContain("interpreter is broken");
  });

  it("is null when Python Environments has none", async () => {
    control.extensions.set(ENVS_ID, envsExtension(void 0).extension);
    const { environments } = makeEnvironments();
    await expect(environments.getActive(void 0)).resolves.toBeNull();
  });

  it("is asked for the document's scope", async () => {
    const envs = envsExtension(environment("/py"));
    control.extensions.set(ENVS_ID, envs.extension);
    const { environments } = makeEnvironments();
    const uri = vscode.Uri.file("/w/a.html");
    await environments.getActive(uri);
    expect(envs.getEnvironment).toHaveBeenCalledExactlyOnceWith(uri);
  });

  it("is null, not a rejection, when the API throws", async () => {
    const envs = envsExtension(environment("/py"));
    envs.getEnvironment.mockRejectedValue(new Error("api down"));
    control.extensions.set(ENVS_ID, envs.extension);
    const { environments } = makeEnvironments();
    await expect(environments.getActive(void 0)).resolves.toBeNull();
  });

  it("has no command when classic cannot name an executable", async () => {
    control.extensions.set(PY_ID, classicExtension(void 0).extension);
    const { environments } = makeEnvironments();
    await expect(environments.getActive(void 0)).resolves.toStrictEqual({ command: null });
  });

  it("is null when classic cannot resolve the environment", async () => {
    control.extensions.set(PY_ID, classicExtension(null).extension);
    const { environments } = makeEnvironments();
    await expect(environments.getActive(void 0)).resolves.toBeNull();
  });
});

describe("activation", () => {
  it("happens once for concurrent callers, and survives a reset", async () => {
    let activations = 0;
    const envs = envsExtension(environment("/py"));
    control.extensions.set(ENVS_ID, {
      ...envs.extension,
      activate: async () => {
        activations += 1;
        return envs.extension.exports;
      },
      isActive: false,
    });
    const { environments } = makeEnvironments();
    const results = await Promise.all([
      environments.getActive(void 0),
      environments.getActive(void 0),
    ]);
    expect(results.map((result) => result?.command?.executable)).toStrictEqual(["/py", "/py"]);
    expect(activations).toBe(1);

    environments.resetIfUnavailable();
    await environments.getActive(void 0);
    expect(activations).toBe(1);
  });
});

describe("change events", () => {
  const same = environment("/py");
  const other = environment("/other-py");

  async function watched(
    active: unknown,
  ): Promise<{
    environments: PythonEnvironments;
    fire: (event: unknown) => void;
    fired: () => number;
  }> {
    const envs = envsExtension(active);
    control.extensions.set(ENVS_ID, envs.extension);
    const { environments } = makeEnvironments();
    let count = 0;
    environments.onDidChange(() => {
      count += 1;
    });
    await environments.getActive(void 0);
    return { environments, fire: envs.fire, fired: () => count };
  }

  it("does not fire for an unchanged environment", async () => {
    const { fire, fired } = await watched(same);
    fire({ new: same, old: same, uri: void 0 });
    expect(fired()).toBe(0);
  });

  it("fires once for a real change, not again for its repeat", async () => {
    const { fire, fired } = await watched(same);
    fire({ new: other, old: same, uri: void 0 });
    expect(fired()).toBe(1);
    fire({ new: other, old: other, uri: void 0 });
    expect(fired()).toBe(1);
  });

  it("does not fire when the event only repeats what was last seen", async () => {
    const { fire, fired } = await watched(same);
    fire({ new: same, old: other, uri: void 0 });
    expect(fired()).toBe(0);
  });

  it("does not fire for a new scope whose event reports no change", async () => {
    const { fire, fired } = await watched(same);
    fire({ new: same, old: same, uri: vscode.Uri.file("/never/seen") });
    expect(fired()).toBe(0);
  });

  it("fires for the classic extension", async () => {
    const classic = classicExtension("/usr/bin/python");
    control.extensions.set(PY_ID, classic.extension);
    const { environments } = makeEnvironments();
    const listener = vi.fn<() => void>();
    environments.onDidChange(listener);
    await environments.getActive(void 0);
    classic.fireChange();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("stops on disposal", async () => {
    const classic = classicExtension("/usr/bin/python");
    control.extensions.set(PY_ID, classic.extension);
    const { environments } = makeEnvironments();
    const listener = vi.fn<() => void>();
    environments.onDidChange(listener);
    await environments.getActive(void 0);
    environments.dispose();
    classic.fireChange();
    expect(listener).not.toHaveBeenCalled();
  });
});

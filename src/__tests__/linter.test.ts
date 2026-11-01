// The behaviour that only exists inside Linter: what reaches the Problems
// panel, when diagnostics are cleared, which documents are skipped, and the
// supersession guard that stops a slow run from wiping a newer run's results.
// integration.test.ts drives the same path through the real bundled runtime.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { DjlintEngine, LintDiagnostic } from "../engine/types.js";
import { Linter } from "../linter.js";
import { changeOf, flush, makeChannel, makeContext, makeDocument, makeEngines } from "./helpers.js";
import { control, fireWorkspaceEvent, resetVscode } from "./vscode-stub.js";

const H013: LintDiagnostic = {
  code: "H013",
  column: 5,
  line: 3,
  message: "Img tag should have an alt attribute.",
};

type Lint = DjlintEngine["lint"];

function makeLinter(lint: Lint): { channel: ReturnType<typeof makeChannel>; linter: Linter } {
  const channel = makeChannel();
  return { channel, linter: new Linter(makeContext(), channel, makeEngines({ lint })) };
}

function diagnosticsOf(document: vscode.TextDocument): readonly unknown[] | undefined {
  return control.diagnostics.get(document.uri.toString());
}

/** A lint call the suite finishes by hand. */
function makeManualLint(): {
  calls: {
    reject: (reason: Error) => void;
    resolve: (found: LintDiagnostic[]) => void;
    token: vscode.CancellationToken;
  }[];
  lint: Lint;
} {
  const calls: ReturnType<typeof makeManualLint>["calls"] = [];
  return {
    calls,
    lint: async (_document, _config, token) =>
      new Promise((resolve, reject) => {
        calls.push({ reject, resolve, token });
      }),
  };
}

const document = makeDocument("/w/a.html", "<img>");

beforeEach(() => {
  resetVscode();
  control.configuration = { enableLinting: true };
});

describe("typing", () => {
  function type(typedIn: vscode.TextDocument = document): void {
    fireWorkspaceEvent("change", { contentChanges: [{ text: "x" }], document: typedIn });
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    control.configuration = { enableLinting: true, lintOnType: true };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lints once, after a pause", async () => {
    const lint = vi.fn<Lint>().mockResolvedValue([H013]);
    const { linter } = makeLinter(lint);
    linter.activate();
    type();
    vi.advanceTimersByTime(200);
    type();
    vi.advanceTimersByTime(200);
    expect(lint).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    await flush();
    expect(lint).toHaveBeenCalledOnce();
    expect(diagnosticsOf(document)).toHaveLength(1);
  });

  it("waits as long as the last lint took, when that is longer", async () => {
    const lint = vi.fn<Lint>().mockImplementation(async () => {
      vi.advanceTimersByTime(800);
      return [];
    });
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(800);
    const { linter } = makeLinter(lint);
    linter.activate();
    fireWorkspaceEvent("save", document);
    await flush();
    expect(lint).toHaveBeenCalledOnce();
    type();
    vi.advanceTimersByTime(700);
    expect(lint).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(100);
    await flush();
    expect(lint).toHaveBeenCalledTimes(2);
  });

  it("waits no more than a second, after a lint that took long", async () => {
    const lint = vi.fn<Lint>().mockResolvedValue([]);
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(30_000);
    const { linter } = makeLinter(lint);
    linter.activate();
    fireWorkspaceEvent("save", document);
    await flush();
    type();
    vi.advanceTimersByTime(1000);
    await flush();
    expect(lint).toHaveBeenCalledTimes(2);
  });

  it("doesn't lint without lintOnType", () => {
    control.configuration = { enableLinting: true, lintOnType: false };
    const lint = vi.fn<Lint>().mockResolvedValue([]);
    const { linter } = makeLinter(lint);
    linter.activate();
    type();
    vi.advanceTimersByTime(1000);
    expect(lint).not.toHaveBeenCalled();
  });

  it("doesn't lint without enableLinting", () => {
    control.configuration = { enableLinting: false, lintOnType: true };
    const lint = vi.fn<Lint>().mockResolvedValue([]);
    const { linter } = makeLinter(lint);
    linter.activate();
    type();
    vi.advanceTimersByTime(1000);
    expect(lint).not.toHaveBeenCalled();
  });

  it("ignores a change with no edit, such as the dirty state", () => {
    const lint = vi.fn<Lint>().mockResolvedValue([]);
    const { linter } = makeLinter(lint);
    linter.activate();
    fireWorkspaceEvent("change", { contentChanges: [], document });
    vi.advanceTimersByTime(1000);
    expect(lint).not.toHaveBeenCalled();
  });

  it("lints once when a save follows", async () => {
    const lint = vi.fn<Lint>().mockResolvedValue([]);
    const { linter } = makeLinter(lint);
    linter.activate();
    type();
    fireWorkspaceEvent("save", document);
    vi.advanceTimersByTime(1000);
    await flush();
    expect(lint).toHaveBeenCalledOnce();
  });

  it("doesn't lint a document closed during the pause", () => {
    const lint = vi.fn<Lint>().mockResolvedValue([]);
    const { linter } = makeLinter(lint);
    linter.activate();
    type();
    fireWorkspaceEvent("close", document);
    vi.advanceTimersByTime(1000);
    expect(lint).not.toHaveBeenCalled();
  });

  it("doesn't lint after the extension stops", () => {
    const lint = vi.fn<Lint>().mockResolvedValue([]);
    const { linter } = makeLinter(lint);
    linter.activate();
    type();
    linter.dispose();
    vi.advanceTimersByTime(1000);
    expect(lint).not.toHaveBeenCalled();
  });

  it("leaves the next lint to the pause when a run ends mid-typing", async () => {
    const edited = makeDocument("/w/edited.html", "<img>");
    const lint = vi
      .fn<Lint>()
      .mockImplementationOnce(async () => {
        (edited as { version: number }).version += 1;
        type(edited);
        return [];
      })
      .mockResolvedValue([]);
    const { linter } = makeLinter(lint);
    linter.activate();
    fireWorkspaceEvent("save", edited);
    await flush();
    expect(lint).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(300);
    await flush();
    expect(lint).toHaveBeenCalledTimes(2);
  });
});

describe("a document closed before its turn in a sweep", () => {
  it("gets no diagnostics", async () => {
    const closed = {
      ...makeDocument("/w/closed.html", "<p>x</p>"),
      isClosed: true,
    } as vscode.TextDocument;
    control.configuration = { enableLinting: true };
    control.documents = [closed];
    const lint = vi.fn<DjlintEngine["lint"]>(async () => []);
    const linter = new Linter(makeContext(), makeChannel(), { engine: { lint } } as never);
    await linter.refreshAll();
    expect(lint).not.toHaveBeenCalled();
  });
});

describe("the startup sweep", () => {
  it("publishes diagnostics for open documents", async () => {
    control.documents = [document];
    makeLinter(async () => [H013]).linter.activate();
    await flush();
    expect(diagnosticsOf(document)).toHaveLength(1);
  });

  it("does not hold up activation", () => {
    control.documents = [document];
    const { lint } = makeManualLint();
    expect(() => {
      makeLinter(lint).linter.activate();
    }).not.toThrow();
  });

  it("diagnoses the editor on screen before background tabs", async () => {
    const background = makeDocument("/w/bg.html");
    const another = makeDocument("/w/bg2.html");
    const onScreen = makeDocument("/w/onscreen.html");
    control.documents = [background, another, onScreen];
    control.visibleDocuments = [onScreen];
    const order: string[] = [];
    makeLinter(async (linted) => {
      order.push(linted.uri.path);
      return [];
    }).linter.activate();
    await flush();
    expect(order).toStrictEqual(["/w/onscreen.html", "/w/bg.html", "/w/bg2.html"]);
  });

  it("lints one document at a time", async () => {
    control.documents = [document, makeDocument("/w/b.html")];
    const { calls, lint } = makeManualLint();
    makeLinter(lint).linter.activate();
    await flush();
    expect(calls).toHaveLength(1);

    calls[0]?.resolve([]);
    await flush();
    expect(calls).toHaveLength(2);
  });

  it("stops the sweep when disposed", async () => {
    control.documents = [document, makeDocument("/w/b.html")];
    const { calls, lint } = makeManualLint();
    const { linter } = makeLinter(lint);
    linter.activate();
    await flush();
    linter.dispose();
    calls[0]?.resolve([]);
    await flush();
    expect(calls).toHaveLength(1);
  });
});

describe("published diagnostics", () => {
  async function published(): Promise<vscode.Diagnostic> {
    await makeLinter(async () => [H013]).linter.refreshAll();
    const [diagnostic] = (diagnosticsOf(document) ?? []) as readonly vscode.Diagnostic[];
    if (!diagnostic) {
      throw new Error("nothing was published");
    }
    return diagnostic;
  }

  beforeEach(() => {
    control.documents = [document];
  });

  it("uses a 0-based line and an empty range at the column", async () => {
    const { range } = await published();
    expect(range.start).toMatchObject({ character: 5, line: 2 });
    expect(range.end).toMatchObject({ character: 5, line: 2 });
  });

  it("lints again when the document changed under a lint", async () => {
    const document = makeDocument("/w/a.html", "<p>x</p>");
    let runs = 0;
    const { linter } = makeLinter(async () => {
      runs += 1;
      if (runs === 1) {
        (document as { version: number }).version += 1;
      }
      return [{ code: "H013", column: runs, line: 1, message: "m" }];
    });
    control.documents = [document];
    linter.activate();
    await flush();
    expect(runs).toBe(2);
    expect(diagnosticsOf(document)).toMatchObject([{ range: { start: { character: 2 } } }]);
  });

  it("carries the message", async () => {
    expect((await published()).message).toBe(H013.message);
  });

  it("uses the default severity, which is Error", async () => {
    expect((await published()).severity).toBe(vscode.DiagnosticSeverity.Error);
  });

  it('names its source "djLint"', async () => {
    expect((await published()).source).toBe("djLint");
  });

  it("links the code to the rule's documentation", async () => {
    const { code } = await published();
    const { target, value } = code as { target: vscode.Uri; value: string };
    expect(value).toBe("H013");
    expect(target.toString()).toBe("https://djlint.com/docs/linter/#h013");
  });
});

describe("the range of a diagnostic", () => {
  async function rangeOf(
    text: string,
    found: Omit<LintDiagnostic, "code" | "message">,
  ): Promise<unknown> {
    const document = makeDocument("/w/a.html", text);
    control.documents = [document];
    const { linter } = makeLinter(async () => [{ ...found, code: "H013", message: "m" }]);
    await linter.refreshAll();
    const [diagnostic] = (diagnosticsOf(document) ?? []) as readonly vscode.Diagnostic[];
    return diagnostic?.range;
  }

  it("covers what djLint found", async () => {
    await expect(
      rangeOf("<img>", { column: 1, endColumn: 4, endLine: 1, line: 1 }),
    ).resolves.toStrictEqual(new vscode.Range(0, 1, 0, 4));
  });

  it("stops at the end of the first line of a finding over several", async () => {
    await expect(
      rangeOf("<img\n  src>", { column: 1, endColumn: 6, endLine: 2, line: 1 }),
    ).resolves.toStrictEqual(new vscode.Range(0, 1, 0, 4));
  });

  it("counts an emoji as the two units the editor does", async () => {
    await expect(
      rangeOf("\u{1F600}<a>", { column: 1, endColumn: 4, endLine: 1, line: 1 }),
    ).resolves.toStrictEqual(new vscode.Range(0, 2, 0, 5));
  });

  it("is empty when djLint gives no end", async () => {
    await expect(rangeOf("<img>", { column: 1, line: 1 })).resolves.toStrictEqual(
      new vscode.Range(0, 1, 0, 1),
    );
  });
});

describe("clearing diagnostics", () => {
  beforeEach(() => {
    control.documents = [document];
  });

  it("clears them when linting is turned off, and republishes after", async () => {
    const { linter } = makeLinter(async () => [H013]);
    await linter.refreshAll();
    expect(diagnosticsOf(document)).toHaveLength(1);

    control.configuration = { enableLinting: false };
    await linter.refreshAll();
    expect(diagnosticsOf(document)).toBeUndefined();

    control.configuration = { enableLinting: true };
    await linter.refreshAll();
    expect(diagnosticsOf(document)).toHaveLength(1);
  });

  it("replaces them with an empty set once the document is clean", async () => {
    let findings = [H013];
    const { linter } = makeLinter(async () => findings);
    await linter.refreshAll();
    findings = [];
    await linter.refreshAll();
    expect(diagnosticsOf(document)).toStrictEqual([]);
  });

  it("drops them on close, cancelling what is in flight", async () => {
    const { calls, lint } = makeManualLint();
    const { linter } = makeLinter(lint);
    linter.activate();
    await flush();
    calls[0]?.resolve([H013]);
    await flush();
    expect(diagnosticsOf(document)).toHaveLength(1);

    fireWorkspaceEvent("save", document);
    await flush();
    fireWorkspaceEvent("close", document);
    expect(calls[1]?.token.isCancellationRequested).toBe(true);
    expect(diagnosticsOf(document)).toBeUndefined();

    calls[1]?.resolve([H013]);
    await flush();
    expect(diagnosticsOf(document)).toBeUndefined();
  });

  it("does not leave stale ones behind when a run fails", async () => {
    let healthy = true;
    const { linter } = makeLinter(async () => {
      if (!healthy) {
        throw new Error("djLint failed");
      }
      return [H013];
    });
    await linter.refreshAll();
    healthy = false;
    await expect(linter.refreshAll()).resolves.toBeUndefined();
    expect(diagnosticsOf(document)).toBeUndefined();
  });
});

describe("which documents get linted", () => {
  it("skips unsupported schemes, saying so", async () => {
    const untitled = makeDocument(vscode.Uri.parse("untitled:1"));
    control.documents = [untitled];
    const lint = vi.fn<Lint>(async () => [H013]);
    const { channel, linter } = makeLinter(lint);
    await linter.refreshAll();
    expect(lint).not.toHaveBeenCalled();
    expect(control.diagnostics.size).toBe(0);
    expect(channel.of("debug")).toHaveLength(1);
  });

  it("lints a virtual workspace's documents", async () => {
    const virtual = makeDocument(vscode.Uri.parse("vscode-vfs://github/o/r/a.html"));
    control.documents = [virtual];
    await makeLinter(async () => [H013]).linter.refreshAll();
    expect(diagnosticsOf(virtual)).toHaveLength(1);
  });

  it("leaves documents alone with linting off, for any scheme", async () => {
    control.configuration = { enableLinting: false };
    control.documents = [document];
    const lint = vi.fn<Lint>(async () => []);
    await makeLinter(lint).linter.refreshAll();
    expect(lint).not.toHaveBeenCalled();
  });

  it("lints on open and save", async () => {
    const lint = vi.fn<Lint>(async () => []);
    makeLinter(lint).linter.activate();
    fireWorkspaceEvent("open", document);
    await flush();
    fireWorkspaceEvent("save", document);
    await flush();
    expect(lint).toHaveBeenCalledTimes(2);
  });

  it("skips documents the startup sweep finds already diagnosed", async () => {
    control.documents = [document];
    control.diagnostics.set(document.uri.toString(), []);
    const lint = vi.fn<Lint>(async () => []);
    makeLinter(lint).linter.activate();
    await flush();
    expect(lint).not.toHaveBeenCalled();
  });
});

describe("configuration changes", () => {
  const other = makeDocument("/v/b.html");

  async function linted(event: vscode.ConfigurationChangeEvent): Promise<string[]> {
    control.documents = [document, other];
    const paths: string[] = [];
    control.diagnostics.set(document.uri.toString(), []);
    control.diagnostics.set(other.uri.toString(), []);
    makeLinter(async (target) => {
      paths.push(target.uri.path);
      return [];
    }).linter.activate();
    await flush();
    fireWorkspaceEvent("config", event);
    await flush();
    return paths;
  }

  it("relints only the documents a lint setting affects", async () => {
    await expect(
      linted(changeOf("djlint.ignore", (scope) => scope === document)),
    ).resolves.toStrictEqual(["/w/a.html"]);
  });

  it("relints for enableLinting", async () => {
    await expect(linted(changeOf("djlint.enableLinting"))).resolves.toHaveLength(2);
  });

  it("ignores a setting that only affects formatting", async () => {
    await expect(linted(changeOf("djlint.maxLineLength"))).resolves.toHaveLength(0);
  });

  it("ignores other extensions' settings", async () => {
    await expect(linted(changeOf("editor.tabSize"))).resolves.toHaveLength(0);
  });
});

describe("supersession", () => {
  beforeEach(() => {
    control.documents = [document];
  });

  it("does not let a slow run overwrite a newer run's results", async () => {
    const { calls, lint } = makeManualLint();
    makeLinter(lint).linter.activate();
    await flush();
    fireWorkspaceEvent("save", document);
    await flush();

    calls[1]?.resolve([]);
    await flush();
    calls[0]?.resolve([H013]);
    await flush();
    expect(diagnosticsOf(document)).toStrictEqual([]);
  });

  it("does not publish while a newer run is still going", async () => {
    const { calls, lint } = makeManualLint();
    makeLinter(lint).linter.activate();
    await flush();
    fireWorkspaceEvent("save", document);
    await flush();

    calls[0]?.resolve([H013]);
    await flush();
    expect(diagnosticsOf(document)).toBeUndefined();
  });

  it("does not let a superseded run's failure wipe results", async () => {
    const { calls, lint } = makeManualLint();
    makeLinter(lint).linter.activate();
    await flush();
    fireWorkspaceEvent("save", document);
    await flush();

    calls[1]?.resolve([H013]);
    await flush();
    calls[0]?.reject(new vscode.CancellationError());
    await flush();
    expect(diagnosticsOf(document)).toHaveLength(1);
  });

  it("cancels the superseded run", async () => {
    const { calls, lint } = makeManualLint();
    makeLinter(lint).linter.activate();
    await flush();
    fireWorkspaceEvent("save", document);
    await flush();
    expect(calls[0]?.token.isCancellationRequested).toBe(true);
    expect(calls[1]?.token.isCancellationRequested).toBe(false);
  });
});

describe("dispose", () => {
  it("is terminal: no further work reaches the collection", async () => {
    control.documents = [document];
    const lint = vi.fn<Lint>(async () => [H013]);
    const { linter } = makeLinter(lint);
    linter.dispose();
    await linter.refreshAll();
    fireWorkspaceEvent("open", document);
    await flush();
    expect(lint).not.toHaveBeenCalled();
    expect(control.diagnostics.size).toBe(0);
  });

  it("cancels what is in flight, discarding its result", async () => {
    control.documents = [document];
    const { calls, lint } = makeManualLint();
    const { linter } = makeLinter(lint);
    linter.activate();
    await flush();
    linter.dispose();
    expect(calls[0]?.token.isCancellationRequested).toBe(true);

    calls[0]?.resolve([H013]);
    await flush();
    expect(control.diagnostics.size).toBe(0);
  });
});

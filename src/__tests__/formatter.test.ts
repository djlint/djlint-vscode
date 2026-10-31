// The parts that only exist inside Formatter: the replacement range, the
// swallow-on-error contract, and supersession when a second format starts for
// the same document. integration.test.ts drives the same paths through the
// real bundled runtime.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { DjlintEngine } from "../engine/types.js";
import { Formatter } from "../formatter.js";
import {
  changeOf,
  flush,
  formattingOptions,
  liveToken,
  makeContext,
  makeDocument,
  makeEngines,
} from "./helpers.js";
import {
  control,
  fireWorkspaceEvent,
  resetVscode,
  type TextEditRecord,
} from "./vscode-stub.js";

const UGLY = `<div><p>hi</p>\n<img src="x.png">\n</div>`;

type Format = DjlintEngine["format"];

function makeFormatter(format: Format): Formatter {
  return new Formatter(makeContext(), makeEngines({ format }));
}

/** An engine that answers only when cancelled, as a slow djLint would. */
const untilCancelled: Format = async (_document, _config, _options, token) =>
  new Promise((_resolve, reject) => {
    token.onCancellationRequested(() => {
      reject(new vscode.CancellationError());
    });
  });

beforeEach(() => {
  resetVscode();
});

describe("provideDocumentFormattingEdits", () => {
  it("returns one edit spanning the whole document", async () => {
    const document = makeDocument("/w/t.html", UGLY);
    const formatter = makeFormatter(async () => "FORMATTED");
    const edits = (await formatter.provideDocumentFormattingEdits(
      document,
      formattingOptions,
      liveToken(),
    )) as unknown as TextEditRecord[];
    expect(edits).toHaveLength(1);
    const [edit] = edits as [TextEditRecord];
    expect(edit.newText).toBe("FORMATTED");
    expect(edit.range.start).toMatchObject({ character: 0, line: 0 });
    expect(edit.range.end).toMatchObject({
      character: "</div>".length,
      line: document.lineCount - 1,
    });
  });

  it("ends the range at the last line even when that line is empty", async () => {
    const edits = (await makeFormatter(
      async () => "",
    ).provideDocumentFormattingEdits(
      makeDocument("/w/t.html", "<p>\n"),
      formattingOptions,
      liveToken(),
    )) as unknown as [TextEditRecord];
    expect(edits[0].range.end).toMatchObject({ character: 0, line: 1 });
  });

  it("hands the engine the document's config and the editor's options", async () => {
    control.configuration = { maxLineLength: 80 };
    const format = vi.fn<Format>(async () => "");
    const document = makeDocument("/w/t.html");
    await makeFormatter(format).provideDocumentFormattingEdits(
      document,
      formattingOptions,
      liveToken(),
    );
    const [seenDocument, config, options] = format.mock.calls[0] ?? [];
    expect(seenDocument).toBe(document);
    expect(config?.get("maxLineLength")).toBe(80);
    expect(options).toBe(formattingOptions);
  });

  it("yields no edits when cancelled mid-format", async () => {
    const source = new vscode.CancellationTokenSource();
    const pending = makeFormatter(
      untilCancelled,
    ).provideDocumentFormattingEdits(
      makeDocument("/w/t.html", UGLY),
      formattingOptions,
      source.token,
    );
    source.cancel();
    await expect(pending).resolves.toBeUndefined();
  });

  it("yields no edits when the engine fails", async () => {
    await expect(
      makeFormatter(async () => {
        throw new Error("djLint failed");
      }).provideDocumentFormattingEdits(
        makeDocument("/w/t.html", UGLY),
        formattingOptions,
        liveToken(),
      ),
    ).resolves.toBeUndefined();
  });

  it("lets a second format of the same document supersede the first", async () => {
    let calls = 0;
    const formatter = makeFormatter(async (...args) => {
      calls += 1;
      return calls === 1 ? untilCancelled(...args) : "NEWEST";
    });
    const document = makeDocument("/w/t.html", UGLY);
    const first = formatter.provideDocumentFormattingEdits(
      document,
      formattingOptions,
      liveToken(),
    );
    const second = formatter.provideDocumentFormattingEdits(
      document,
      formattingOptions,
      liveToken(),
    );
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toHaveLength(1);
  });

  it("does not let formatting one document cancel another", async () => {
    let calls = 0;
    const formatter = makeFormatter(async (...args) => {
      calls += 1;
      return calls === 1 ? untilCancelled(...args) : "OTHER";
    });
    const source = new vscode.CancellationTokenSource();
    const slow = formatter.provideDocumentFormattingEdits(
      makeDocument("/w/slow.html", UGLY),
      formattingOptions,
      source.token,
    );
    await expect(
      formatter.provideDocumentFormattingEdits(
        makeDocument("/w/other.html", UGLY),
        formattingOptions,
        liveToken(),
      ),
    ).resolves.toHaveLength(1);

    let settled = false;
    void slow.finally(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    source.cancel();
    await expect(slow).resolves.toBeUndefined();
  });

  it("cancels what is in flight on disposal", async () => {
    const formatter = makeFormatter(untilCancelled);
    const pending = formatter.provideDocumentFormattingEdits(
      makeDocument("/w/t.html", UGLY),
      formattingOptions,
      liveToken(),
    );
    formatter.dispose();
    await expect(pending).resolves.toBeUndefined();
  });
});

describe("provider registration", () => {
  it("registers for the configured languages", () => {
    control.configuration = { formatLanguages: ["html", "django-html"] };
    makeFormatter(async () => "").activate();
    expect(control.formattingProviders).toHaveLength(1);
    expect(control.formattingProviders[0]?.selector).toStrictEqual([
      "html",
      "django-html",
    ]);
  });

  it("registers nothing for no languages", () => {
    control.configuration = { formatLanguages: [] };
    makeFormatter(async () => "").activate();
    expect(control.formattingProviders).toHaveLength(0);
  });

  it("re-registers when the languages change, replacing the old provider", () => {
    control.configuration = { formatLanguages: ["html"] };
    makeFormatter(async () => "").activate();

    control.configuration = { formatLanguages: ["jinja"] };
    fireWorkspaceEvent("config", changeOf("djlint.formatLanguages"));
    expect(control.formattingProviders.map((p) => p.selector)).toStrictEqual([
      ["jinja"],
    ]);

    control.configuration = { formatLanguages: [] };
    fireWorkspaceEvent("config", changeOf("djlint.formatLanguages"));
    expect(control.formattingProviders).toHaveLength(0);
  });

  it("ignores other settings", () => {
    control.configuration = { formatLanguages: ["html"] };
    makeFormatter(async () => "").activate();
    const [provider] = control.formattingProviders;

    control.configuration = { formatLanguages: ["jinja"] };
    fireWorkspaceEvent("config", changeOf("djlint.maxLineLength"));
    expect(control.formattingProviders).toStrictEqual([provider]);
  });

  it("unregisters on disposal", () => {
    control.configuration = { formatLanguages: ["html"] };
    const formatter = makeFormatter(async () => "");
    formatter.activate();
    formatter.dispose();
    expect(control.formattingProviders).toHaveLength(0);
  });

  it("puts its config listener in the extension's subscriptions", () => {
    const context = makeContext();
    new Formatter(context, makeEngines({})).activate();
    expect(context.subscriptions).toHaveLength(1);
  });
});

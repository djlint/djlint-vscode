// A warning reaches showWarning from every run that has it, and from each engine worded the same.
import { beforeEach, describe, expect, it } from "vitest";

import { forgetShownWarnings, showWarning } from "../notify.js";
import { makeChannel } from "./helpers.js";
import { control, resetVscode } from "./vscode-stub.js";

describe(showWarning, () => {
  beforeEach(() => {
    resetVscode();
  });

  it("shows a warning once a session, whichever engine gives it", async () => {
    await showWarning("djLint: once", makeChannel());
    await showWarning("djLint: once", makeChannel());
    await showWarning("djLint: other", makeChannel());
    expect(control.shownWarnings).toStrictEqual(["djLint: once", "djLint: other"]);
  });

  it("shows a warning again once it is forgotten", async () => {
    await showWarning("djLint: again", makeChannel());
    forgetShownWarnings();
    await showWarning("djLint: again", makeChannel());
    expect(control.shownWarnings).toStrictEqual(["djLint: again", "djLint: again"]);
  });

  it("opens the log from the notification's Details button", async () => {
    control.messageChoice = "Details";
    const channel = makeChannel();
    await showWarning("djLint: details", channel);
    expect(channel.shownCount).toBe(1);
  });
});

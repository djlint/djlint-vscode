// Runs inside a real VS Code, on the desktop and in the browser, with the fixture workspace open.
const vscode = require("vscode");

const WIDE_INDENT = " ".repeat(7);
const TIMEOUT_MS = 120_000;

function check(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
  console.log(`ok   ${label}`);
}

async function waitForDiagnostics(uri) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const diagnostics = vscode.languages.getDiagnostics(uri);
    if (diagnostics.length > 0) {
      return diagnostics;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
  }
  throw new Error("no diagnostics arrived");
}

async function format(uri) {
  const edits = await vscode.commands.executeCommand("vscode.executeFormatDocumentProvider", uri, {
    insertSpaces: true,
    tabSize: 2,
  });
  return (edits ?? []).map((edit) => edit.newText).join("");
}

exports.run = async () => {
  const [folder] = vscode.workspace.workspaceFolders;
  const uri = vscode.Uri.joinPath(folder.uri, "templates", "sub", "page.html");
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  await vscode.extensions.getExtension("monosans.djlint").activate();

  const [diagnostic] = await waitForDiagnostics(uri);
  check("lint reports the violation", diagnostic.code.value, "H013");

  check(
    "format reads the project's configuration",
    (await format(uri)).includes(WIDE_INDENT),
    true,
  );

  await vscode.commands.executeCommand("djlint.restart");
  check("format works after a restart", (await format(uri)).includes(WIDE_INDENT), true);
};

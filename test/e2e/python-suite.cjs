// Runs inside a real VS Code with the real Python extensions: which djLint runs for the selected environment.
const { execFileSync } = require("node:child_process");
const vscode = require("vscode");

const TIMEOUT_MS = 180_000;
// Saving again cancels the lint in progress, which on a runner can take seconds.
const RETRY_MS = 15_000;
const POLL_MS = 250;
// djLint 1.48 reports where a finding ends. Before it, a finding has no length.
const WHOLE_MATCH = 13;
const NO_LENGTH = 0;

const { environments, hasDjlintOnPath, version } = JSON.parse(process.env.DJLINT_E2E);

async function sleep(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

exports.run = async () => {
  const [folder] = vscode.workspace.workspaceFolders;
  const uri = vscode.Uri.joinPath(folder.uri, "page.html");
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  const python = await vscode.extensions.getExtension("ms-python.python").activate();
  await vscode.extensions.getExtension("monosans.djlint").activate();

  async function select(executable) {
    if (vscode.workspace.getConfiguration("python").get("useEnvironmentsExtension")) {
      const api = await vscode.extensions.getExtension("ms-python.vscode-python-envs").activate();
      await api.setEnvironment(
        folder.uri,
        await api.resolveEnvironment(vscode.Uri.file(executable)),
      );
    } else {
      await python.environments.updateActiveEnvironmentPath(executable, folder.uri);
    }
  }

  async function lintAgain() {
    const edit = new vscode.WorkspaceEdit();
    const last = document.lineAt(document.lineCount - 1);
    if (last.isEmptyOrWhitespace && last.text) {
      edit.delete(uri, last.range);
    } else {
      edit.insert(uri, last.range.end, " ");
    }
    await vscode.workspace.applyEdit(edit);
    await document.save();
  }

  function findingLength() {
    const finding = vscode.languages.getDiagnostics(uri).find(({ code }) => code?.value === "H013");
    return finding && finding.range.end.character - finding.range.start.character;
  }

  // Selecting more than once, because the Python extension can pick an environment of its own when it starts.
  async function expectLength(label, executable, length) {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      await select(executable);
      await lintAgain();
      const retryAt = Date.now() + RETRY_MS;
      while (Date.now() < retryAt) {
        if (findingLength() === length) {
          console.log(`ok   ${label}`);
          return;
        }
        await sleep(POLL_MS);
      }
    }
    throw new Error(`${label}: expected ${length}, got ${String(findingLength())}`);
  }

  await expectLength("runs the selected environment", environments.installed, WHOLE_MATCH);
  await expectLength("follows a new selection", environments.withoutEnd, NO_LENGTH);
  if (environments.conda != null) {
    await select(environments.installed);
    await expectLength("runs a conda environment", environments.conda, NO_LENGTH);
  }
  if (!hasDjlintOnPath) {
    await expectLength("falls back to the bundled djLint", environments.empty, WHOLE_MATCH);
  }

  await select(environments.later);
  await sleep(RETRY_MS);
  await expectLength("goes to another environment", environments.installed, WHOLE_MATCH);
  execFileSync("uv", ["pip", "install", "--python", environments.later, `djlint==${version}`]);
  await expectLength("finds djLint installed since", environments.later, NO_LENGTH);

  await select(environments.installed);
  const edits = await vscode.commands.executeCommand("vscode.executeFormatDocumentProvider", uri, {
    insertSpaces: true,
    tabSize: 4,
  });
  const edit = new vscode.WorkspaceEdit();
  edit.set(uri, edits);
  await vscode.workspace.applyEdit(edit);
  if (!document.getText().includes(`    <img src="x">`)) {
    throw new Error(`not formatted: ${document.getText()}`);
  }
  console.log("ok   formats");
};

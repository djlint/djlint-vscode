// Runs test/e2e/python-suite.cjs in a downloaded VS Code with the real Python extensions and real
// environments, with python.useEnvironmentsExtension off and on.
import { spawnSync } from "node:child_process";
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from "@vscode/test-electron";

// Where this is set, djLint prints GitHub annotations whatever output format it is told.
delete process.env["GITHUB_ACTIONS"];

const WITHOUT_END = "1.47.1";

const root = path.resolve(import.meta.dirname, "../..");
const INSTALLED = /"djlint==(?<version>[^"]+)"/u.exec(
  readFileSync(path.join(root, "pyproject.toml"), "utf8"),
)?.groups?.["version"];
if (INSTALLED == null) {
  throw new Error("pyproject.toml pins no djLint");
}
const isWindows = process.platform === "win32";

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {boolean} [shell]
 */
function run(command, args, shell = false) {
  const { status, stderr } = spawnSync(command, args, { encoding: "utf8", shell });
  if (status !== 0) {
    throw new Error(`${command} failed: ${stderr}`);
  }
}

/** @param {string} environment */
function pythonOf(environment) {
  return path.join(environment, ...(isWindows ? ["Scripts", "python.exe"] : ["bin", "python"]));
}

/**
 * @param {string} python
 * @param {string} version
 */
function installDjlint(python, version) {
  run("uv", ["pip", "install", "--compile-bytecode", "--python", python, `djlint==${version}`]);
}

/**
 * @param {string} workspace
 * @param {string} name
 * @param {string} [version]
 */
function makeVenv(workspace, name, version) {
  const environment = path.join(workspace, name);
  run("uv", ["venv", "--python", "3.14", environment]);
  const python = pythonOf(environment);
  if (version != null) {
    installDjlint(python, version);
  }
  return python;
}

/** @param {string} workspace */
function makeCondaEnvironment(workspace) {
  const { CONDA: conda } = process.env;
  if (conda == null) {
    return void 0;
  }
  const environment = path.join(workspace, "conda");
  run(path.join(conda, ...(isWindows ? ["Scripts", "conda.exe"] : ["bin", "conda"])), [
    "create",
    "--yes",
    "--quiet",
    "--prefix",
    environment,
    "python=3.12",
    "pip",
  ]);
  const python = isWindows ? path.join(environment, "python.exe") : pythonOf(environment);
  installDjlint(python, WITHOUT_END);
  return python;
}

const logs = mkdtempSync(path.join(os.tmpdir(), "djlint-logs-"));
const workspace = mkdtempSync(path.join(os.tmpdir(), "djlint python "));
try {
  mkdirSync(path.join(workspace, ".vscode"));
  writeFileSync(path.join(workspace, "page.html"), `<div><img src="x"></div>\n`);
  const environments = {
    conda: makeCondaEnvironment(workspace),
    empty: makeVenv(workspace, "empty"),
    installed: makeVenv(workspace, "installed", INSTALLED),
    withoutEnd: makeVenv(workspace, "without-end", WITHOUT_END),
  };
  const hasDjlintOnPath = spawnSync("djlint", ["--version"], { shell: isWindows }).status === 0;

  const version = "stable";
  const executable = await downloadAndUnzipVSCode(version);
  const [cli = "", ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable);
  const extensionsDir = path.join(workspace, ".extensions");
  // A .cmd needs a shell on Windows, which needs the quotes.
  const quote = isWindows
    ? (/** @type {string} */ arg) => `"${arg}"`
    : (/** @type {string} */ arg) => arg;
  run(
    quote(cli),
    [
      ...cliArgs.filter((arg) => !arg.startsWith("--extensions-dir")),
      `--extensions-dir=${extensionsDir}`,
      "--install-extension",
      "ms-python.python",
    ].map(quote),
    isWindows,
  );

  for (const useEnvironmentsExtension of [false, true]) {
    console.log(`\npython.useEnvironmentsExtension: ${useEnvironmentsExtension}`);
    writeFileSync(
      path.join(workspace, ".vscode", "settings.json"),
      JSON.stringify({
        "[html]": { "editor.defaultFormatter": "monosans.djlint" },
        "djlint.enableLinting": true,
        "python.useEnvironmentsExtension": useEnvironmentsExtension,
      }),
    );
    rmSync(path.join(workspace, "without-end-later"), { force: true, recursive: true });
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsEnv: {
        DJLINT_E2E: JSON.stringify({
          environments: { ...environments, later: makeVenv(workspace, "without-end-later") },
          hasDjlintOnPath,
          version: WITHOUT_END,
        }),
      },
      extensionTestsPath: path.join(root, "test/e2e/python-suite.cjs"),
      launchArgs: [
        workspace,
        `--extensions-dir=${extensionsDir}`,
        `--logsPath=${logs}`,
        `--user-data-dir=${path.join(workspace, `.user-${useEnvironmentsExtension}`)}`,
        "--disable-workspace-trust",
      ],
      version,
    });
  }
} catch (e) {
  for (const file of globSync("**/djLint.log", { cwd: logs })) {
    console.log(readFileSync(path.join(logs, file), "utf8"));
  }
  throw e;
} finally {
  rmSync(workspace, { force: true, maxRetries: 3, recursive: true });
}

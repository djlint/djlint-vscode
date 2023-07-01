import { formattingArgs, lintingArgs } from "./args";

const goodStderrRegex = /Linting\s+\d+\/\d+\s+files/;
const noSuchOptionRegex = /No\s+such\s+option:\s+(\S+)/;
const argsMap = new Map(
  [...formattingArgs, ...lintingArgs].map((arg) => [arg.cliName, arg])
);

export function getErrorMsg(stderr: string, pythonExec: string): string | null {
  if (!stderr) {
    return null;
  }

  if (stderr.endsWith("No module named djlint")) {
    return `djLint is not installed for the current active Python interpreter. Install it with the \`${pythonExec} -m pip install -U djlint\` command.`;
  }

  // Workaround for djLint < 1.18
  if (goodStderrRegex.test(stderr)) {
    return null;
  }

  const noSuchOption = noSuchOptionRegex.exec(stderr);
  if (noSuchOption) {
    const arg = argsMap.get(noSuchOption[1]);
    if (arg) {
      const updateCmd = arg.minVersion
        ? `${pythonExec} -m pip install -U djlint>=${arg.minVersion}`
        : `${pythonExec} -m pip install -U djlint`;
      return `Your version of djLint does not support the \`djlint.${arg.vscodeName}\` option. Disable it in the settings or update djLint with the \`${updateCmd}\` command.`;
    }
  }

  return stderr;
}

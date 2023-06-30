import { formattingArgs, lintingArgs } from "./args";

const goodStderrRegex = /Linting\s+\d+\/\d+\s+files/;
const noSuchOptionRegex = /No\s+such\s+option:\s+(\S+)/;
const argsMap = new Map(
  [...formattingArgs, ...lintingArgs].map((arg) => [arg.cliName, arg])
);

export function getErrorMsg(stderr: string): string | null {
  if (!stderr) {
    return null;
  }

  if (stderr.endsWith("No module named djlint")) {
    return "djLint is not installed for the current active Python interpreter. Install it with `pip install djlint`.";
  }

  // Workaround for djLint < 1.18
  if (goodStderrRegex.test(stderr)) {
    return null;
  }

  const noSuchOption = noSuchOptionRegex.exec(stderr);
  if (noSuchOption) {
    const arg = argsMap.get(noSuchOption[1]);
    if (arg) {
      return `Your version of djLint does not support the ${
        arg.vscodeName
      } option. Disable it in the settings or update djLint to ≥ ${
        arg.minVersion ?? "undefined"
      }.`;
    }
  }

  return stderr;
}

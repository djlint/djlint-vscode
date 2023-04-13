const versionedOptions = [
  ["ignore-case", "ignoreCase", "1.23.0"],
  ["include", "include", "1.20.0"],
  ["configuration", "configuration", "1.13.0"],
  ["format-css", "formatCss", "1.9.0"],
  ["format-js", "formatJs", "1.9.0"],
  ["preserve-blank-lines", "preserveBlankLines", "1.3.0"],
  ["preserve-leading-space", "preserveLeadingSpace", "1.2.0"],
];
const goodStderrRegex = /Linting\s\d+\/\d+\sfiles/;

export function getErrorMsg(stderr: string): string | null {
  if (stderr.endsWith("No module named djlint")) {
    return "djLint is not installed for the current active Python interpreter.";
  }
  for (const [cliOption, vscodeOption, minVersion] of versionedOptions) {
    if (stderr.includes(`Error: No such option: --${cliOption}`)) {
      return `Your version of djLint does not support the ${vscodeOption} option. Disable it in the settings or install djLint>=${minVersion}.`;
    }
  }

  // Workaround for djLint<1.18
  if (goodStderrRegex.test(stderr)) {
    return null;
  }

  return stderr;
}

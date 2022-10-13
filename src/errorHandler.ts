const versionedOptions = [
  ["configuration", "configuration", "1.13.0"],
  ["format-css", "formatCss", "1.9.0"],
  ["format-js", "formatJs", "1.9.0"],
  ["preserve-blank-lines", "preserveBlankLines", "1.3.0"],
  ["preserve-leading-space", "preserveLeadingSpace", "1.2.0"],
];
const errorRegex = /Error.*/;

export function getErrorMsg(stderr: string): string | undefined {
  if (stderr.includes("No module named")) {
    return "djLint is not installed for the current active Python interpreter.";
  }
  for (const [cliOption, vscodeOption, minVersion] of versionedOptions) {
    if (stderr.includes(`No such option: --${cliOption}`)) {
      return `Your version of djLint does not support the ${vscodeOption} option. Disable it in the settings or install djLint>=${minVersion}.`;
    }
  }
  return stderr.match(errorRegex)?.toString();
}

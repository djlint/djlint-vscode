// Provision the pure-python djLint wheel into assets/pyodide/.
//
// Preferred: build it from the sibling ../djlint checkout (mypyc hook left
// disabled -> py3-none-any wheel), so the bundled djLint matches your working
// tree. Fallback (no local Python / build tooling): download the published
// py3-none-any wheel from PyPI. Either way the result is a pure wheel Pyodide
// can load.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";

const DJLINT_SRC = process.env.DJLINT_SRC ?? "../djlint";
const OUT = "assets/pyodide";

mkdirSync(OUT, { recursive: true });

// Drop any stale djlint wheel so exactly one version is bundled.
for (const f of readdirSync(OUT)) {
  if (/^djlint-.*-py3-none-any\.whl$/u.test(f)) {
    rmSync(`${OUT}/${f}`);
  }
}

function buildFromSource() {
  execFileSync("python", ["-m", "build", "--wheel", "--outdir", "dist-wheel"], {
    cwd: DJLINT_SRC,
    stdio: "inherit",
  });
  const wheel = readdirSync(`${DJLINT_SRC}/dist-wheel`).find((f) =>
    f.endsWith("-py3-none-any.whl"),
  );
  if (!wheel) {
    throw new Error(
      "no pure-python djlint wheel produced — is the mypyc hook disabled?",
    );
  }
  copyFileSync(`${DJLINT_SRC}/dist-wheel/${wheel}`, `${OUT}/${wheel}`);
  return wheel;
}

async function downloadFromPypi() {
  const meta = await (await fetch("https://pypi.org/pypi/djlint/json")).json();
  const url = meta.urls.find((u) => u.filename.endsWith("-py3-none-any.whl"));
  if (!url) {
    throw new Error("PyPI has no pure-python djlint wheel");
  }
  const buf = Buffer.from(await (await fetch(url.url)).arrayBuffer());
  const expected = url.digests?.sha256;
  if (!expected) {
    throw new Error(`PyPI provided no sha256 digest for ${url.filename}`);
  }
  if (createHash("sha256").update(buf).digest("hex") !== expected) {
    throw new Error(`sha256 mismatch for ${url.filename} against PyPI digest`);
  }
  writeFileSync(`${OUT}/${url.filename}`, buf);
  return url.filename;
}

try {
  const wheel = buildFromSource();
  console.log(`built pure djLint wheel from ${DJLINT_SRC} -> ${wheel}`);
} catch (e) {
  console.warn(
    `local build unavailable (${e instanceof Error ? e.message : String(e)}); falling back to PyPI`,
  );
  const wheel = await downloadFromPypi();
  console.log(`downloaded djLint wheel from PyPI -> ${wheel}`);
}

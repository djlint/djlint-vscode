// Download the pinned Pyodide runtime + every wheel djLint needs into
// assets/pyodide/, then write an augmented pyodide-lock.json so a single
// `loadPyodide({ indexURL }).loadPackage("djlint")` resolves the whole closure
// OFFLINE (no PyPI/CDN at runtime). Run AFTER build-djlint-wheel.mjs.
//
// Layout is flat (all wheels beside the lock), matching Pyodide's default
// packageBaseUrl == indexURL.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const PYODIDE_VERSION = "314.0.2";
const CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full`;
const OUT = "assets/pyodide";

const CORE = [
  "pyodide.mjs",
  "pyodide.asm.mjs",
  "pyodide.asm.wasm",
  "python_stdlib.zip",
  "pyodide-lock.json",
];

// Pure-python wheels djLint depends on that Pyodide does NOT ship, with the
// lock `depends` chains that let loadPackage("djlint") pull the whole closure.
const PURE_DEPENDS = {
  pathspec: [],
  json5: [],
  editorconfig: [],
  jsbeautifier: ["editorconfig", "six"],
  cssbeautifier: ["jsbeautifier", "editorconfig", "six"],
};
const DJLINT_DEPENDS = [
  "regex",
  "pyyaml",
  "click",
  "pathspec",
  "json5",
  "cssbeautifier",
  "jsbeautifier",
];
// C-extension / stock wheels djLint needs that Pyodide DOES ship.
const STOCK = ["regex", "pyyaml", "click", "six"];

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${res.status} fetching ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function download(url, name) {
  writeFileSync(`${OUT}/${name}`, await get(url));
}

// Verify a download against an expected sha256 before writing it, so a
// corrupted or tampered wheel never lands in the bundled runtime.
async function downloadVerified(url, name, expectedSha) {
  const buf = await get(url);
  const actual = sha256(buf);
  if (actual !== expectedSha) {
    throw new Error(
      `sha256 mismatch for ${name}: expected ${expectedSha}, got ${actual}`,
    );
  }
  writeFileSync(`${OUT}/${name}`, buf);
}

async function pypiWheel(pkg) {
  const meta = await (await fetch(`https://pypi.org/pypi/${pkg}/json`)).json();
  const url = meta.urls.find((u) => u.filename.endsWith("-py3-none-any.whl"));
  if (!url) {
    throw new Error(`no pure-python wheel for ${pkg}`);
  }
  const buf = await get(url.url);
  const expected = url.digests?.sha256;
  if (!expected) {
    throw new Error(`PyPI provided no sha256 digest for ${url.filename}`);
  }
  if (sha256(buf) !== expected) {
    throw new Error(`sha256 mismatch for ${url.filename} against PyPI digest`);
  }
  writeFileSync(`${OUT}/${url.filename}`, buf);
  return { filename: url.filename, version: meta.info.version, buf };
}

function lockEntry(name, version, fileName, buf, depends) {
  return {
    name,
    version,
    file_name: fileName,
    install_dir: "site",
    sha256: sha256(buf),
    package_type: "package",
    imports: [name],
    depends,
    unvendored_tests: false,
    shared_library: false,
  };
}

mkdirSync(OUT, { recursive: true });

// 1. Pyodide core + stock lock.
for (const f of CORE) {
  await download(`${CDN}/${f}`, f);
}
const lock = JSON.parse(readFileSync(`${OUT}/pyodide-lock.json`, "utf8"));

// 2. Stock wheels (file names + sha256 come from the lock; verify each).
for (const name of STOCK) {
  const entry = lock.packages[name];
  await downloadVerified(
    `${CDN}/${entry.file_name}`,
    entry.file_name,
    entry.sha256,
  );
}

// 3. Pure wheels from PyPI + their lock entries.
for (const [pkg, depends] of Object.entries(PURE_DEPENDS)) {
  const { filename, version, buf } = await pypiWheel(pkg);
  lock.packages[pkg] = lockEntry(pkg, version, filename, buf, depends);
  console.log(`+ ${pkg} ${version}`);
}

// 4. djLint entry (wheel already placed by build-djlint-wheel.mjs).
const djwheel = readdirSync(OUT).find((f) =>
  /^djlint-.*-py3-none-any\.whl$/u.test(f),
);
if (!djwheel) {
  throw new Error("djlint wheel missing — run build-djlint-wheel.mjs first");
}
const djversion = /^djlint-(.+?)-py3-none-any\.whl$/u.exec(djwheel)[1];
lock.packages["djlint"] = lockEntry(
  "djlint",
  djversion,
  djwheel,
  readFileSync(`${OUT}/${djwheel}`),
  DJLINT_DEPENDS,
);
console.log(`+ djlint ${djversion}`);

writeFileSync(`${OUT}/pyodide-lock.json`, JSON.stringify(lock));
console.log(`\nassembled offline Pyodide assets in ${OUT}`);

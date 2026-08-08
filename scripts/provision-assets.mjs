// Provisions assets/pyodide/ with the pinned Pyodide runtime, a pure-python
// djLint wheel built from source, and every runtime dependency djLint needs,
// then writes an augmented pyodide-lock.json so
// `loadPyodide({ indexURL }).loadPackage("djlint")` resolves the whole
// closure OFFLINE (no PyPI/CDN at runtime).
//
// The Pyodide core files and stock lock come from the `pyodide` devDependency,
// so the runtime version is pinned by package.json and the lockfile (bumpable
// by Renovate) rather than a hardcoded constant. djLint's wheel is built from
// the sibling ../djlint checkout with `uv` (https://docs.astral.sh/uv/; mypyc
// disabled there, so the result is pure-python), and its runtime dependency
// closure is derived from ../djlint's uv.lock, so nothing here is a
// hand-maintained list that could go stale.
//
// The closure is split by source: packages the pinned Pyodide build ships are
// pulled from its matching CDN release (sha256-verified against the stock
// lock); the rest are pure-python wheels pulled from PyPI (sha256-verified
// against PyPI's digest). Layout is flat, matching Pyodide's packageBaseUrl.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const DJLINT_SRC = process.env.DJLINT_SRC ?? "../djlint";
const OUT = "assets/pyodide";

// Resolve the installed `pyodide` package: its version drives the CDN release
// the package wheels are fetched from, keeping the wheels and the stock lock
// (both read from this same install) in lockstep by construction.
const PYODIDE_DIR = path.dirname(
  createRequire(import.meta.url).resolve("pyodide/package.json"),
);
const PYODIDE_VERSION = JSON.parse(
  readFileSync(`${PYODIDE_DIR}/package.json`, "utf8"),
).version;
const CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full`;

const CORE = [
  "pyodide.mjs",
  "pyodide.asm.mjs",
  "pyodide.asm.wasm",
  "python_stdlib.zip",
  "pyodide-lock.json",
];

function runUv(args, options = {}) {
  try {
    return execFileSync("uv", args, { encoding: "utf8", ...options });
  } catch (e) {
    if (e.code === "ENOENT") {
      throw new Error(
        "`uv` was not found on PATH. Install it from https://docs.astral.sh/uv/ to build the bundled Pyodide assets.",
        { cause: e },
      );
    }
    throw e;
  }
}

// --- 1. Build the djLint wheel from source with uv -------------------------

function buildDjlintWheel() {
  runUv(["build", "--wheel", "--no-create-gitignore", "-o", OUT, DJLINT_SRC], {
    stdio: "inherit",
  });
  const wheel = readdirSync(OUT).find((f) => /^djlint-.*\.whl$/u.test(f));
  if (!wheel) {
    throw new Error(`uv build produced no djlint wheel in ${OUT}`);
  }
  if (!wheel.endsWith("-py3-none-any.whl")) {
    throw new Error(
      `uv build produced a platform-specific wheel (${wheel}) instead of a pure-python wheel. Is the mypyc build hook enabled in ${DJLINT_SRC}/pyproject.toml?`,
    );
  }
  console.log(`built pure djLint wheel from ${DJLINT_SRC} -> ${wheel}`);
  return wheel;
}

// --- 2. Derive the runtime dependency closure from uv -----------------------

// Returns a Map<packageName, version> of djLint's runtime dependency closure
// (transitive, dev/test excluded), resolved for the bundled runtime's target:
// Python 3.14 on a non-win32 platform, matching Pyodide (sys.platform ==
// "emscripten"). `uv export` emits the universal lock with PEP 508 markers on
// conditional deps (py<3.11 backports, click's win32-only colorama); piping it
// through `uv pip compile` evaluates those markers for the target and drops
// what doesn't apply, while preserving the lock's exact pins, so we get a
// flat name==version closure without re-implementing PEP 508 markers here.
// (win32 is the only platform djLint's deps branch on, so `linux` stands in
// for emscripten: both are simply "not win32".)
function runtimeClosure() {
  const exported = runUv([
    "export",
    "--project",
    DJLINT_SRC,
    "--frozen",
    "--no-dev",
    "--no-hashes",
    "--no-annotate",
    "--no-header",
    "--no-emit-project",
  ]);
  const resolved = runUv(
    [
      "pip",
      "compile",
      "-",
      "--python-version",
      "3.14",
      "--python-platform",
      "linux",
      "--no-header",
      "--no-annotate",
      "--quiet",
    ],
    { input: exported },
  );
  const closure = new Map();
  for (const line of resolved.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)==(\S+)$/u.exec(trimmed);
    if (!m) {
      throw new Error(`unrecognized line from uv pip compile: ${trimmed}`);
    }
    closure.set(m[1].toLowerCase(), m[2]);
  }
  return closure;
}

// --- Download helpers --------------------------------------------------

async function get(url, attempts = 4) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`${res.status} fetching ${url}`);
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (i >= attempts) {
        throw e;
      }
      console.warn(`retry ${i}/${attempts} for ${url}: ${e.message}`);
      await new Promise((resolve) => {
        setTimeout(resolve, 1000 * i);
      });
    }
  }
  throw new Error(`failed to fetch ${url}`);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// Downloads to OUT/<name>, verifying the bytes against an expected sha256 so a
// corrupted or tampered wheel never lands in the bundle. Returns the verified
// sha256 so callers can reuse it (e.g. for a lock entry) without re-hashing.
async function downloadVerified(url, name, expectedSha) {
  const buf = await get(url);
  const actual = sha256(buf);
  if (actual !== expectedSha) {
    throw new Error(
      `sha256 mismatch for ${name}: expected ${expectedSha}, got ${actual}`,
    );
  }
  writeFileSync(`${OUT}/${name}`, buf);
  return actual;
}

// Fetches a specific released pure-python wheel from PyPI, verified against
// PyPI's own sha256 digest. Returns the wheel's filename and verified sha256.
async function pypiWheel(pkg, version) {
  const meta = await (
    await fetch(`https://pypi.org/pypi/${pkg}/${version}/json`)
  ).json();
  const url = meta.urls.find((u) => u.filename.endsWith("-py3-none-any.whl"));
  if (!url) {
    throw new Error(`no pure-python wheel for ${pkg}==${version} on PyPI`);
  }
  const expected = url.digests?.sha256;
  if (!expected) {
    throw new Error(`PyPI provided no sha256 digest for ${url.filename}`);
  }
  const sha = await downloadVerified(url.url, url.filename, expected);
  return { filename: url.filename, sha };
}

function lockEntry(name, version, fileName, sha, depends) {
  return {
    name,
    version,
    file_name: fileName,
    install_dir: "site",
    sha256: sha,
    package_type: "package",
    imports: [name],
    depends,
    unvendored_tests: false,
    shared_library: false,
  };
}

// --- main -------------------------------------------------------------

// Start from a clean output dir so a package dropped from the dependency
// closure, or any other stale artifact, can't linger in the bundle.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const djlintWheel = buildDjlintWheel();
const djlintVersion = /^djlint-(.+?)-py3-none-any\.whl$/u.exec(djlintWheel)[1];

const closure = runtimeClosure();
const closureNames = closure
  .keys()
  .toArray()
  .toSorted((a, b) => a.localeCompare(b));
console.log(`djLint runtime dependency closure: ${closureNames.join(", ")}`);

// 3. Copy the Pyodide core + its stock lock from the npm package (no network).
for (const f of CORE) {
  copyFileSync(`${PYODIDE_DIR}/${f}`, `${OUT}/${f}`);
}
const lock = JSON.parse(readFileSync(`${OUT}/pyodide-lock.json`, "utf8"));

// 4. Fetch each dependency from wherever it lives, verified. Packages the stock
// Pyodide lock already ships are pulled as emscripten WebAssembly wheels from
// the matching CDN release (verified against that lock, its entry left as-is);
// the rest are pure-python wheels from PyPI (verified against PyPI's digest),
// each given a `depends: []` lock entry. The flattened djlint entry below
// pulls the whole closure, so the individual chains no longer matter.
for (const [name, required] of closure) {
  if (Object.hasOwn(lock.packages, name)) {
    const entry = lock.packages[name];
    if (entry.version !== required) {
      console.warn(
        `pyodide ships ${name} ${entry.version}, but djlint's uv.lock resolved ${required}; verify compatibility`,
      );
    }
    await downloadVerified(
      `${CDN}/${entry.file_name}`,
      entry.file_name,
      entry.sha256,
    );
    console.log(`= ${name} ${entry.version} (from Pyodide)`);
  } else {
    const { filename, sha } = await pypiWheel(name, required);
    lock.packages[name] = lockEntry(name, required, filename, sha, []);
    console.log(`+ ${name} ${required} (from PyPI)`);
  }
}

// 5. djLint's own lock entry, `depends` flattened to the full closure so
// `loadPackage("djlint")` pulls everything regardless of the finer graph.
const djlintSha = sha256(readFileSync(`${OUT}/${djlintWheel}`));
lock.packages["djlint"] = lockEntry(
  "djlint",
  djlintVersion,
  djlintWheel,
  djlintSha,
  closureNames,
);
console.log(`+ djlint ${djlintVersion}`);

writeFileSync(`${OUT}/pyodide-lock.json`, JSON.stringify(lock));
console.log(`\nassembled offline Pyodide assets in ${OUT}`);

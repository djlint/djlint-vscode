// Provisions assets/pyodide/ with the pinned Pyodide runtime, a pure-python
// djLint wheel built from source, and every runtime dependency djLint needs,
// then writes an augmented pyodide-lock.json so
// `loadPyodide({ indexURL }).loadPackage("djlint")` resolves the whole
// closure OFFLINE (no PyPI/CDN at runtime).
//
// Requires `uv` (https://docs.astral.sh/uv/) on PATH: it builds the djLint
// wheel from the sibling ../djlint checkout (mypyc disabled there, so the
// result is pure-python) and derives the runtime dependency closure from
// ../djlint's uv.lock, instead of a hand-maintained map that would go stale.
//
// The closure is split: packages the pinned Pyodide build already ships are
// pulled from the Pyodide CDN (sha256-verified against its lock); the rest
// are pure-python wheels pulled from PyPI (sha256-verified against PyPI's
// digest). Layout is flat, matching Pyodide's default packageBaseUrl.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";

const DJLINT_SRC = process.env.DJLINT_SRC ?? "../djlint";
const OUT = "assets/pyodide";

const PYODIDE_VERSION = "314.0.2";
const CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full`;

const CORE = [
  "pyodide.mjs",
  "pyodide.asm.mjs",
  "pyodide.asm.wasm",
  "python_stdlib.zip",
  "pyodide-lock.json",
];

// Marker environment matching the bundled runtime: Python 3.14 under
// Pyodide, which reports sys.platform == "emscripten" (never "win32").
// Evaluates the PEP 508 markers uv export attaches to conditional
// dependencies (e.g. py<3.11 backports, click's win32-only colorama).
const TARGET_ENV = {
  python_full_version: "3.14.0",
  python_version: "3.14",
  sys_platform: "emscripten",
};

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
      `uv build produced a platform-specific wheel (${wheel}) instead of a pure-python wheel — is the mypyc build hook enabled in ${DJLINT_SRC}/pyproject.toml?`,
    );
  }
  console.log(`built pure djLint wheel from ${DJLINT_SRC} -> ${wheel}`);
  return wheel;
}

// --- 2. Derive the runtime dependency closure from uv -----------------------

const MARKER_CMP = {
  "==": (cmp) => cmp === 0,
  "!=": (cmp) => cmp !== 0,
  "<": (cmp) => cmp < 0,
  "<=": (cmp) => cmp <= 0,
  ">": (cmp) => cmp > 0,
  ">=": (cmp) => cmp >= 0,
};

// Throws on a non-numeric segment instead of letting it silently become NaN
// (which would make every comparison involving it false instead of loud).
function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  if (pa.some((n) => Number.isNaN(n)) || pb.some((n) => Number.isNaN(n))) {
    throw new TypeError(
      `non-numeric version segment while comparing "${a}" to "${b}"`,
    );
  }
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return Math.sign(diff);
    }
  }
  return 0;
}

function evalClause(clause, env) {
  const m = /^(\w+)\s*(==|!=|<=|>=|<|>)\s*['"]([^'"]+)['"]$/u.exec(clause);
  if (!m) {
    throw new Error(`unsupported marker clause from uv export: ${clause}`);
  }
  const [, key, op, literal] = m;
  if (key === "python_version" || key === "python_full_version") {
    return MARKER_CMP[op](compareVersions(env[key], literal));
  }
  if (key === "sys_platform") {
    if (op === "==") {
      return env.sys_platform === literal;
    }
    if (op === "!=") {
      return env.sys_platform !== literal;
    }
    throw new Error(`unsupported operator ${op} for sys_platform`);
  }
  throw new Error(`unsupported marker variable from uv export: ${key}`);
}

// Evaluates the small PEP 508 marker subset djLint's dependencies actually
// use. Throws on anything unrecognized, so an unfamiliar marker fails the
// build loudly rather than corrupting the bundle.
function evalMarker(marker, env) {
  return marker
    .split(/\s+or\s+/u)
    .some((orPart) =>
      orPart
        .split(/\s+and\s+/u)
        .every((clause) => evalClause(clause.trim(), env)),
    );
}

// Returns a Map<packageName, version> of djLint's runtime dependency
// closure (transitive, dev/test excluded), for the target environment.
function runtimeClosure() {
  const output = runUv([
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
  const closure = new Map();
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;]+)(?:\s*;\s*(.+))?$/u.exec(
      trimmed,
    );
    if (!m) {
      throw new Error(`unrecognized line from uv export: ${trimmed}`);
    }
    const [, name, version, marker] = m;
    if (marker && !evalMarker(marker, TARGET_ENV)) {
      continue;
    }
    closure.set(name.toLowerCase(), version);
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

async function download(url, name) {
  writeFileSync(`${OUT}/${name}`, await get(url));
}

// Verifies against an expected sha256 before writing, so a corrupted or
// tampered wheel never lands in the bundle.
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

// Fetches a specific released pure-python wheel from PyPI, verified against
// PyPI's own sha256 digest.
async function pypiWheel(pkg, version) {
  const meta = await (
    await fetch(`https://pypi.org/pypi/${pkg}/${version}/json`)
  ).json();
  const url = meta.urls.find((u) => u.filename.endsWith("-py3-none-any.whl"));
  if (!url) {
    throw new Error(`no pure-python wheel for ${pkg}==${version} on PyPI`);
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
  return url.filename;
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

// 3. Pyodide core + its stock lock.
for (const f of CORE) {
  await download(`${CDN}/${f}`, f);
}
const lock = JSON.parse(readFileSync(`${OUT}/pyodide-lock.json`, "utf8"));

// 4. Split the closure by whether the stock lock already ships it.
const pyodideProvided = [];
const pureWheels = [];
for (const name of closure.keys()) {
  if (Object.hasOwn(lock.packages, name)) {
    pyodideProvided.push(name);
  } else {
    pureWheels.push(name);
  }
}

// 4a. Pyodide-provided: download the file the stock lock describes,
// verified against its sha256. Lock entry left untouched.
for (const name of pyodideProvided) {
  const entry = lock.packages[name];
  await downloadVerified(
    `${CDN}/${entry.file_name}`,
    entry.file_name,
    entry.sha256,
  );
  console.log(`= ${name} ${entry.version} (from Pyodide)`);
}

// 4b. Not shipped by Pyodide: download the pure wheel from PyPI and add a
// lock entry with `depends: []` — the flattened djlint entry below pulls
// the whole closure, so individual chains no longer matter.
for (const name of pureWheels) {
  const version = closure.get(name);
  const filename = await pypiWheel(name, version);
  const buf = readFileSync(`${OUT}/${filename}`);
  lock.packages[name] = lockEntry(name, version, filename, buf, []);
  console.log(`+ ${name} ${version} (from PyPI)`);
}

// 5. djLint's own lock entry, `depends` flattened to the full closure so
// `loadPackage("djlint")` pulls everything regardless of the finer graph.
const djlintBuf = readFileSync(`${OUT}/${djlintWheel}`);
lock.packages["djlint"] = lockEntry(
  "djlint",
  djlintVersion,
  djlintWheel,
  djlintBuf,
  closureNames,
);
console.log(`+ djlint ${djlintVersion}`);

writeFileSync(`${OUT}/pyodide-lock.json`, JSON.stringify(lock));
console.log(`\nassembled offline Pyodide assets in ${OUT}`);

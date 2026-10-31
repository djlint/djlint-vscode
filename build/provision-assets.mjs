// Assembles assets/pyodide/: the Pyodide runtime, djLint and what djLint needs,
// every file verified against its sha256, plus the licenses of all of it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { download } from "./download.mjs";
import { pyodideLicenses } from "./pyodide-licenses.mjs";

/**
 * @typedef {{
 *   file_name: string,
 *   version: string,
 *   sha256: string,
 *   depends: string[],
 *   [key: string]: unknown,
 * }} LockEntry
 * @typedef {{
 *   info: { python: string },
 *   packages: Record<string, LockEntry>,
 * }} Lock
 * @typedef {Map<string, string>} Pins
 */

const REQUIREMENTS = "djlint-requirements.txt";
const PYTHON_LICENSES = "assets/python-licenses.txt";
const OUT = "assets/pyodide";

const PYODIDE_DIR = path.dirname(
  createRequire(import.meta.url).resolve("pyodide/package.json"),
);
const PYODIDE_VERSION =
  /** @type {{ version: string }} */
  (JSON.parse(readFileSync(`${PYODIDE_DIR}/package.json`, "utf8"))).version;
const CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full`;

const PYODIDE_CORE_FILES = [
  "pyodide.mjs",
  "pyodide.asm.mjs",
  "pyodide.asm.wasm",
  "python_stdlib.zip",
  "pyodide-lock.json",
];

/**
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [options]
 * @returns {string}
 */
function runUv(args, options = {}) {
  try {
    return String(
      execFileSync("uv", args, {
        encoding: "utf8",
        ...options,
        env: { ...process.env, UV_EXCLUDE_NEWER: "3 days" },
      }),
    );
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") {
      throw new Error(
        "`uv` was not found on PATH. Install it from https://docs.astral.sh/uv/ to build the bundled Pyodide assets.",
        { cause: e },
      );
    }
    throw e;
  }
}

/**
 * @param {string} resolved
 * @returns {Pins}
 */
function parsePins(resolved) {
  /** @type {Pins} */
  const pins = new Map();
  for (const line of resolved.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const pin = /^([\w.-]+)==(\S+)$/u.exec(trimmed);
    if (!pin) {
      throw new Error(`unrecognized line from uv pip compile: ${trimmed}`);
    }
    const [, name = "", version = ""] = pin;
    pins.set(name.toLowerCase(), version);
  }
  return pins;
}

/**
 * @param {Lock} lock
 * @returns {string} The Python version Pyodide runs, as major.minor.
 */
function pythonVersion(lock) {
  return lock.info.python.split(".").slice(0, 2).join(".");
}

/**
 * @param {string} python
 * @returns {string[]}
 */
function resolverTarget(python) {
  return [
    "--python-version",
    python,
    "--python-platform",
    "linux",
    "--no-header",
    "--no-annotate",
    "--quiet",
  ];
}

/**
 * @param {Buffer} buf
 * @returns {string}
 */
function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * @param {string} url
 * @param {string} name
 * @param {string} expectedSha
 */
async function downloadVerified(url, name, expectedSha) {
  const buf = await download(url);
  const actual = sha256(buf);
  if (actual !== expectedSha) {
    throw new Error(
      `sha256 mismatch for ${name}: expected ${expectedSha}, got ${actual}`,
    );
  }
  writeFileSync(`${OUT}/${name}`, buf);
}

/**
 * @param {string} pkg
 * @param {string} version
 * @returns {Promise<{ filename: string, sha: string }>}
 */
async function downloadPureWheelFromPypi(pkg, version) {
  const meta =
    /** @type {{ urls: { filename: string, url: string, digests: { sha256: string } }[] }} */
    (
      JSON.parse(
        (
          await download(`https://pypi.org/pypi/${pkg}/${version}/json`)
        ).toString("utf8"),
      )
    );
  const wheel = meta.urls.find((u) => u.filename.endsWith("-py3-none-any.whl"));
  if (!wheel) {
    throw new Error(`no pure-python wheel for ${pkg}==${version} on PyPI`);
  }
  await downloadVerified(wheel.url, wheel.filename, wheel.digests.sha256);
  return { filename: wheel.filename, sha: wheel.digests.sha256 };
}

/**
 * @param {string} name
 * @param {string} version
 * @param {string} fileName
 * @param {string} sha
 * @param {string[]} depends
 * @returns {LockEntry}
 */
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

/**
 * @returns {Lock}
 */
function copyPyodideCore() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  for (const file of PYODIDE_CORE_FILES) {
    copyFileSync(`${PYODIDE_DIR}/${file}`, `${OUT}/${file}`);
  }
  return /** @type {Lock} */ (
    JSON.parse(readFileSync(`${OUT}/pyodide-lock.json`, "utf8"))
  );
}

/**
 * @param {[string, string][]} pairs
 * @returns {string}
 */
function describePins(pairs) {
  return pairs.map(([name, version]) => `${name} ${version}`).join(", ");
}

/**
 * @param {Pins} closure
 * @param {Pins} shipped
 * @param {string} djlintVersion
 * @param {string} python
 */
function assertPyodideVersionsSatisfyDjlint(
  closure,
  shipped,
  djlintVersion,
  python,
) {
  const skewed = [...shipped].filter(
    ([name, version]) => closure.get(name) !== version,
  );
  if (skewed.length === 0) {
    return;
  }
  const pins = [
    `djlint==${djlintVersion}`,
    ...[...shipped].map(([name, version]) => `${name}==${version}`),
  ].join("\n");
  try {
    runUv(["pip", "compile", "-", ...resolverTarget(python)], {
      input: `${pins}\n`,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    throw new Error(
      `djLint ${djlintVersion} is not compatible with the versions Pyodide ${PYODIDE_VERSION} ships (${describePins(skewed)}). Those wheels cannot be swapped for PyPI ones, so this bundle would break at runtime. Bump the pyodide devDependency or hold djlint back.\n${/** @type {{ stderr?: string }} */ (e).stderr ?? ""}`,
      { cause: e },
    );
  }
  console.log(
    `verified djLint ${djlintVersion} accepts Pyodide's ${describePins(skewed)}`,
  );
}

/**
 * @param {Lock} lock
 * @param {Pins} closure
 * @param {Pins} shipped
 * @param {string[]} dependencyNames
 */
async function fetchDependencies(lock, closure, shipped, dependencyNames) {
  for (const name of dependencyNames) {
    const shippedVersion = shipped.get(name);
    if (shippedVersion == null) {
      const version = closure.get(name) ?? "";
      const { filename, sha } = await downloadPureWheelFromPypi(name, version);
      lock.packages[name] = lockEntry(name, version, filename, sha, []);
      console.log(`+ ${name} ${version} (from PyPI)`);
    } else {
      const { file_name: fileName, sha256: sha } = lock.packages[name];
      await downloadVerified(`${CDN}/${fileName}`, fileName, sha);
      console.log(`= ${name} ${shippedVersion} (from Pyodide)`);
    }
  }
}

/**
 * @param {string[]} wheels
 * @param {string} python
 */
function writePythonLicenses(wheels, python) {
  runUv(
    [
      "run",
      "--no-project",
      "--python",
      python,
      "build/wheel_licenses.py",
      PYTHON_LICENSES,
      ...wheels.map((wheel) => `${OUT}/${wheel}`),
    ],
    { stdio: "inherit" },
  );
}

const lock = copyPyodideCore();
const python = pythonVersion(lock);

const closure = parsePins(
  runUv(["pip", "compile", REQUIREMENTS, ...resolverTarget(python)]),
);
const djlintVersion = closure.get("djlint");
if (!djlintVersion) {
  throw new Error(
    `${REQUIREMENTS} must pin djlint, but the resolved closure has no djlint`,
  );
}
const dependencyNames = closure
  .keys()
  .filter((name) => name !== "djlint")
  .toArray()
  .toSorted((a, b) => a.localeCompare(b));
console.log(
  `djlint ${djlintVersion}; runtime dependency closure: ${dependencyNames.join(", ")}`,
);

/** @type {Pins} */
const shipped = new Map(
  dependencyNames
    .filter((name) => Object.hasOwn(lock.packages, name))
    .map((name) => [name, lock.packages[name].version]),
);
assertPyodideVersionsSatisfyDjlint(closure, shipped, djlintVersion, python);
await fetchDependencies(lock, closure, shipped, dependencyNames);

const djlint = await downloadPureWheelFromPypi("djlint", djlintVersion);
lock.packages["djlint"] = lockEntry(
  "djlint",
  djlintVersion,
  djlint.filename,
  djlint.sha,
  dependencyNames,
);
console.log(`+ djlint ${djlintVersion} (from PyPI)`);

// The rest of Pyodide's package index points at files this bundle leaves out.
const packages = Object.fromEntries(
  ["djlint", ...dependencyNames].map((name) => [name, lock.packages[name]]),
);
writeFileSync(
  `${OUT}/pyodide-lock.json`,
  JSON.stringify({ ...lock, packages }),
);
writePythonLicenses(
  Object.values(packages).map((entry) => entry.file_name),
  python,
);
writeFileSync(
  "assets/pyodide-licenses.txt",
  await pyodideLicenses(PYODIDE_VERSION),
);

console.log(`\nassembled offline Pyodide assets in ${OUT}`);

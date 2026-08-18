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

const REQUIREMENTS = "djlint-requirements.txt";
const THIRD_PARTY = "THIRD_PARTY.md";
const OUT = "assets/pyodide";

const PYODIDE_DIR = path.dirname(
  createRequire(import.meta.url).resolve("pyodide/package.json"),
);
const PYODIDE_VERSION = JSON.parse(
  readFileSync(`${PYODIDE_DIR}/package.json`, "utf8"),
).version;
const CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full`;

const PYODIDE_CORE_FILES = [
  "pyodide.mjs",
  "pyodide.asm.mjs",
  "pyodide.asm.wasm",
  "python_stdlib.zip",
  "pyodide-lock.json",
];

const RESOLVER_TARGET = [
  "--python-version",
  "3.14",
  "--python-platform",
  "linux",
  "--no-header",
  "--no-annotate",
  "--quiet",
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

function parsePins(resolved) {
  const pins = new Map();
  for (const line of resolved.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const pin = /^([A-Za-z0-9][A-Za-z0-9._-]*)==(\S+)$/u.exec(trimmed);
    if (!pin) {
      throw new Error(`unrecognized line from uv pip compile: ${trimmed}`);
    }
    pins.set(pin[1].toLowerCase(), pin[2]);
  }
  return pins;
}

function resolveRuntimeClosure() {
  return parsePins(runUv(["pip", "compile", REQUIREMENTS, ...RESOLVER_TARGET]));
}

const ATTEMPTS = 4;

async function get(url) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`${res.status} fetching ${url}`);
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (attempt >= ATTEMPTS) {
        throw e;
      }
      console.warn(`retry ${attempt}/${ATTEMPTS} for ${url}: ${e.message}`);
      await new Promise((resolve) => {
        setTimeout(resolve, 1000 * attempt);
      });
    }
  }
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

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

async function downloadPureWheelFromPypi(pkg, version) {
  const meta = JSON.parse(
    await get(`https://pypi.org/pypi/${pkg}/${version}/json`),
  );
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

function copyPyodideCore() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  for (const file of PYODIDE_CORE_FILES) {
    copyFileSync(`${PYODIDE_DIR}/${file}`, `${OUT}/${file}`);
  }
  return JSON.parse(readFileSync(`${OUT}/pyodide-lock.json`, "utf8"));
}

function versionsShippedByPyodide(lock, dependencyNames) {
  const shipped = new Map();
  for (const name of dependencyNames) {
    if (Object.hasOwn(lock.packages, name)) {
      shipped.set(name, lock.packages[name].version);
    }
  }
  return shipped;
}

function describePins(pairs) {
  return pairs.map(([name, version]) => `${name} ${version}`).join(", ");
}

function assertPyodideVersionsSatisfyDjlint(closure, shipped, djlintVersion) {
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
    runUv(["pip", "compile", "-", ...RESOLVER_TARGET], {
      input: `${pins}\n`,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    throw new Error(
      `djLint ${djlintVersion} is not compatible with the versions Pyodide ${PYODIDE_VERSION} ships (${describePins(skewed)}). Those wheels cannot be swapped for PyPI ones, so this bundle would break at runtime. Bump the pyodide devDependency or hold djlint back.\n${e.stderr ?? ""}`,
      { cause: e },
    );
  }
  console.log(
    `verified djLint ${djlintVersion} accepts Pyodide's ${describePins(skewed)}`,
  );
}

async function fetchDependencies(lock, closure, shipped, dependencyNames) {
  for (const name of dependencyNames) {
    const shippedVersion = shipped.get(name);
    if (shippedVersion == null) {
      const version = closure.get(name);
      const { filename, sha } = await downloadPureWheelFromPypi(name, version);
      lock.packages[name] = lockEntry(name, version, filename, sha, []);
      console.log(`+ ${name} ${version} (from PyPI)`);
    } else {
      const entry = lock.packages[name];
      await downloadVerified(
        `${CDN}/${entry.file_name}`,
        entry.file_name,
        entry.sha256,
      );
      console.log(`= ${name} ${shippedVersion} (from Pyodide)`);
    }
  }
}

function normalizeComponentName(name) {
  return name.toLowerCase().replaceAll("_", "-");
}

function documentedComponents() {
  const documented = new Set();
  for (const line of readFileSync(THIRD_PARTY, "utf8").split(/\r?\n/u)) {
    const row = /^\|\s*`([^`]+)`\s*\|/u.exec(line);
    if (row) {
      documented.add(normalizeComponentName(row[1]));
    }
  }
  return documented;
}

function reportLicenseInventoryDrift(dependencyNames) {
  const documented = documentedComponents();
  const bundled = new Set(
    dependencyNames.map((name) => normalizeComponentName(name)),
  );
  const undocumented = bundled.difference(documented);
  const stale = documented.difference(bundled);
  if (undocumented.size > 0) {
    console.warn(
      `warning: bundled but missing from ${THIRD_PARTY}: ${[...undocumented].join(", ")}`,
    );
  }
  if (stale.size > 0) {
    console.warn(
      `warning: listed in ${THIRD_PARTY} but no longer bundled: ${[...stale].join(", ")}`,
    );
  }
}

const closure = resolveRuntimeClosure();
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

const lock = copyPyodideCore();
const shipped = versionsShippedByPyodide(lock, dependencyNames);
assertPyodideVersionsSatisfyDjlint(closure, shipped, djlintVersion);
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

writeFileSync(`${OUT}/pyodide-lock.json`, JSON.stringify(lock));
reportLicenseInventoryDrift(dependencyNames);

console.log(`\nassembled offline Pyodide assets in ${OUT}`);

// Collects the licenses of the Pyodide runtime: Pyodide itself and what its build compiles into pyodide.asm.wasm.
// The versions come from Pyodide's own build files at the release tag.
// The build fails if Pyodide starts linking a library this script does not know, rather than leaving its license out.

import { download } from "./download.mjs";

const RAW = "https://raw.githubusercontent.com";
const RULE = "=".repeat(80);

// What Pyodide 314 links; a change means a license to add below.
const KNOWN_BUILT = ["libffi", "libhiwire", "liblzma", "libzstd"];
const KNOWN_PORTS = ["USE_BZIP2", "USE_ZLIB"];
const KNOWN_LINKED = ["bz2", "lzma", "sqlite3", "zstd"];

// Pyodide's package recipes, which build the PyYAML wheel, are kept elsewhere.
const LIBYAML = "0.2.5";

/**
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchText(url) {
  return (await download(url)).toString("utf8").replaceAll("\r", "").trim();
}

/**
 * @param {string} text
 * @param {RegExp} pattern
 * @param {string} what
 * @returns {string}
 */
function capture(text, pattern, what) {
  const match = pattern.exec(text);
  if (match?.[1] == null) {
    throw new Error(`could not find ${what} in Pyodide's build files`);
  }
  return match[1];
}

/**
 * @param {string[]} found
 * @param {string[]} known
 * @param {string} what
 */
function assertSame(found, known, what) {
  const actual = [...new Set(found)].toSorted((a, b) => a.localeCompare(b));
  if (actual.join(" ") !== known.join(" ")) {
    throw new Error(
      `Pyodide now uses ${what} ${actual.join(", ")} instead of ${known.join(", ")}. Add the licenses of the new ones to build/pyodide-licenses.mjs.`,
    );
  }
}

/**
 * @param {string} version
 * @returns {Promise<string>}
 */
export async function pyodideLicenses(version) {
  /**
   * @param {string} file
   * @returns {string}
   */
  function pyodide(file) {
    return `${RAW}/pyodide/pyodide/${version}/${file}`;
  }
  const envs = await fetchText(pyodide("Makefile.envs"));
  const makefile = await fetchText(pyodide("cpython/Makefile"));
  const setup = await fetchText(pyodide("cpython/Setup.local"));

  assertSame(
    capture(makefile, /^all: \S+ (.+)$/mu, "the libraries it builds").split(/\s+/u),
    KNOWN_BUILT,
    "the libraries",
  );
  assertSame(
    envs
      .matchAll(/-s\s*(USE_[A-Z0-9_]+)/gu)
      .map((m) => m[1])
      .toArray(),
    KNOWN_PORTS,
    "the Emscripten ports",
  );
  assertSame(
    setup
      .matchAll(/\s-l(\w+)/gu)
      .map((m) => m[1])
      .toArray(),
    KNOWN_LINKED,
    "the linked libraries",
  );

  const python = capture(envs, /^export PYVERSION \?= (\S+)$/mu, "PYVERSION");
  const emscripten = capture(
    envs,
    /^export PYODIDE_EMSCRIPTEN_VERSION \?= (\S+)$/mu,
    "the Emscripten version",
  );
  /**
   * @param {string} name
   * @returns {Promise<string>}
   */
  async function port(name) {
    return capture(
      await fetchText(`${RAW}/emscripten-core/emscripten/${emscripten}/tools/ports/${name}.py`),
      /^VERSION = '([^']+)'$/mu,
      `the version of the ${name} port`,
    );
  }
  const libffi = capture(makefile, /^LIBFFI_COMMIT=(\S+)$/mu, "libffi");
  const hiwire = capture(makefile, /^HIWIRE_COMMIT=(\S+)$/mu, "hiwire");
  const xz = capture(makefile, /^LZMATARBALL=.*\/xz-([\d.]+)\.tar\.gz$/mu, "xz");
  const zstd = capture(makefile, /^ZSTDTARBALL=.*\/zstd-([\d.]+)\.tar\.gz$/mu, "zstd");
  const bzip2 = await port("bzip2");
  const zlib = await port("zlib");

  const license = await fetchText(`${RAW}/python/cpython/v${python}/Doc/license.rst`);
  const incorporated = license.indexOf("Licenses and Acknowledgements for Incorporated Software");
  if (incorporated === -1) {
    throw new Error("CPython's Doc/license.rst has no incorporated software");
  }

  const sections = [
    [
      `Pyodide ${version} (pyodide.mjs, pyodide.asm.mjs, pyodide.asm.wasm)\n\nSource: https://github.com/pyodide/pyodide/tree/${version}`,
      await fetchText(pyodide("LICENSE")),
    ],
    [
      "stackframe and error-stack-parser, compiled into pyodide.mjs",
      await fetchText(pyodide("src/js/vendor/stackframe/LICENSE")),
    ],
    [
      "hiwire, linked into pyodide.asm.wasm",
      await fetchText(`${RAW}/pyodide/hiwire/${hiwire}/LICENSE`),
    ],
    [
      `CPython ${python} (the interpreter in pyodide.asm.wasm and the standard library in python_stdlib.zip)`,
      await fetchText(`${RAW}/python/cpython/v${python}/LICENSE`),
    ],
    [
      `Software incorporated in CPython ${python} (from its Doc/license.rst)`,
      license.slice(incorporated),
    ],
    [
      "libffi, linked into pyodide.asm.wasm",
      await fetchText(`${RAW}/libffi/libffi/${libffi}/LICENSE`),
    ],
    [
      `XZ Utils ${xz} (liblzma), linked into pyodide.asm.wasm`,
      await fetchText(`${RAW}/tukaani-project/xz/v${xz}/COPYING`),
    ],
    [
      `Zstandard ${zstd}, linked into pyodide.asm.wasm (used under the BSD license)`,
      await fetchText(`${RAW}/facebook/zstd/v${zstd}/LICENSE`),
    ],
    [
      `zlib ${zlib}, linked into pyodide.asm.wasm`,
      await fetchText(`${RAW}/madler/zlib/v${zlib}/LICENSE`),
    ],
    [
      `bzip2 ${bzip2} (libbz2), linked into pyodide.asm.wasm`,
      await fetchText(`${RAW}/emscripten-ports/bzip2/${bzip2}/LICENSE`),
    ],
    [
      "libyaml, linked into the PyYAML wheel",
      await fetchText(`${RAW}/yaml/libyaml/${LIBYAML}/License`),
    ],
    [
      `Emscripten ${emscripten} (the runtime in pyodide.asm.mjs and pyodide.asm.wasm)`,
      await fetchText(`${RAW}/emscripten-core/emscripten/${emscripten}/LICENSE`),
    ],
    [
      `musl libc, as shipped with Emscripten ${emscripten}, linked into pyodide.asm.wasm`,
      await fetchText(
        `${RAW}/emscripten-core/emscripten/${emscripten}/system/lib/libc/musl/COPYRIGHT`,
      ),
    ],
    [
      "Other components linked into pyodide.asm.wasm",
      "SQLite is in the public domain.\nlibc++, libc++abi and compiler-rt from LLVM are under Apache-2.0 WITH\nLLVM-exception, which waives the notice requirements for code compiled\ninto object form.",
    ],
  ];

  return `Licenses of the Pyodide ${version} runtime bundled under assets/pyodide/.\n\n${sections
    .map(([title, text]) => `${RULE}\n${title}\n\n${text}\n`)
    .join("\n")}`;
}

// Boots the built worker on the provisioned runtime and formats and lints
// through it: packaging cleanly does not prove the bundle still works.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { Worker } from "node:worker_threads";

/**
 * @typedef {import("../src/engine/pyodide/protocol.js").RunRequest} RunRequest
 * @typedef {import("../src/engine/pyodide/protocol.js").WorkerResponse} WorkerResponse
 */

const WORKER = path.resolve("dist/pyodide-worker.cjs");
const INDEX_URL = path.resolve("assets/pyodide");
const TIMEOUT_MS = 180_000;

for (const required of [WORKER, INDEX_URL]) {
  if (!existsSync(required)) {
    throw new Error(
      `${required} is missing. Build first: npm run assets && npm run esbuild-worker`,
    );
  }
}

function assertBundledDjlintIsPinnedVersion() {
  const pinned = /"djlint==(?<version>[^"]+)"/u.exec(
    readFileSync("pyproject.toml", "utf8"),
  )?.groups?.["version"];
  const lock =
    /** @type {{ packages: Record<string, { version: string }> }} */
    (
      JSON.parse(
        readFileSync(path.join(INDEX_URL, "pyodide-lock.json"), "utf8"),
      )
    );
  const bundled = lock.packages["djlint"].version;
  if (bundled !== pinned) {
    throw new Error(
      `bundled djLint is ${bundled}, but pyproject.toml pins ${pinned}`,
    );
  }
  console.log(`ok   bundled djLint is the pinned ${pinned}`);
}

assertBundledDjlintIsPinnedVersion();

const worker = new Worker(WORKER, { workerData: { indexURL: INDEX_URL } });
/** @type {Map<number, (response: WorkerResponse) => void>} */
const pending = new Map();
const seq = { value: 0 };

worker.on("message", (/** @type {WorkerResponse} */ response) => {
  // eslint-disable-next-line default-case -- every type has a case
  switch (response.type) {
    case "boot-failed": {
      throw new Error(`bundled worker failed to start: ${response.error}`);
    }
    case "log": {
      console.log(`     ${response.line}`);
      break;
    }
    case "ready": {
      console.log(`     bundled djLint ${response.version}`);
      break;
    }
    case "result": {
      pending.get(response.id)?.(response);
      pending.delete(response.id);
      break;
    }
  }
});
worker.on("error", (e) => {
  console.error("bundled worker errored:", e);
  process.exit(1);
});

/**
 * @param {RunRequest["mode"]} mode
 * @param {string} src
 * @param {Partial<RunRequest>} [request]
 * @returns {Promise<string>}
 */
async function call(mode, src, request = {}) {
  seq.value += 1;
  const id = seq.value;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${mode} timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    pending.set(id, (response) => {
      clearTimeout(timer);
      if (response.type === "result" && response.ok) {
        resolve(response.output);
      } else {
        reject(new Error(`${mode} failed: ${JSON.stringify(response)}`));
      }
    });
    /** @type {RunRequest} */
    const message = {
      cwd: void 0,
      filename: "templates/a.html",
      id,
      mode,
      options: { profile: "django" },
      pathOptions: {},
      project: void 0,
      src,
      type: "run",
      ...request,
    };
    worker.postMessage(message);
  });
}

/** @type {string[]} */
const failures = [];

/**
 * @param {string} label
 * @param {unknown} actual
 * @param {unknown} expected
 */
function expect(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
  }
}

const IMG = '<div><img src="x.png"></div>';
const H013 = [
  {
    code: "H013",
    column: 5,
    line: 1,
    message: "Img tag should have an alt attribute.",
  },
];

expect(
  "format applies indent, profile and close_void_tags",
  await call("format", '<div><p>hi</p>\n<img src="x.png">\n</div>', {
    options: { close_void_tags: true, indent: 2, profile: "django" },
  }),
  '<div>\n  <p>hi</p>\n  <img src="x.png" />\n</div>\n',
);

expect(
  "format keeps CRLF line endings",
  await call("format", "<div>\r\n<p>hi</p>\r\n</div>\r\n"),
  "<div>\r\n    <p>hi</p>\r\n</div>\r\n",
);

expect(
  "format accepts the djLint 1.45 options and sorts attributes",
  await call(
    "format",
    '<div><img src="x.png" class="a" id="b" alt="x"></div>',
    {
      options: {
        indent: 2,
        keep_br_inline: true,
        name_endblocks: true,
        no_entity_formatting: true,
        no_indent_inner_html: true,
        profile: "django",
        quote_style: "double",
        sort_attributes: true,
      },
    },
  ),
  '<div>\n  <img id="b" class="a" alt="x" src="x.png">\n</div>\n',
);

expect(
  "format reads a project handed over with the request",
  await call("format", "<div><p>hi</p></div>", {
    project: {
      cwd: "templates/sub",
      files: { "templates/pyproject.toml": "[tool.djlint]\nindent = 3\n" },
    },
  }),
  "<div>\n   <p>hi</p>\n</div>\n",
);

expect(
  "lint reports the expected violation",
  JSON.parse(await call("lint", IMG)),
  H013,
);

expect(
  "require_pragma leaves a file without the pragma alone",
  await call("format", "<div><p>hi</p></div>", {
    options: { require_pragma: true },
  }),
  "<div><p>hi</p></div>",
);

expect(
  "require_pragma does not lint a file without the pragma",
  JSON.parse(await call("lint", IMG, { options: { require_pragma: true } })),
  [],
);

const project = mkdtempSync(path.join(tmpdir(), "djlint-verify-"));
try {
  const folder = path.join(project, "templates");
  mkdirSync(folder);
  writeFileSync(
    path.join(project, "pyproject.toml"),
    '[tool.djlint]\nindent = 7\n\n[tool.djlint.per-file-ignores]\n"templates/.*" = "H013"\n',
  );
  const global = path.join(project, "shared.toml");
  writeFileSync(global, 'ignore = "H013"\n');

  expect(
    "the project's configuration file is read from above the file",
    await call("format", "<div><p>hi</p></div>", { cwd: folder }),
    "<div>\n       <p>hi</p>\n</div>\n",
  );
  expect(
    "per-file-ignores suppresses the violation",
    JSON.parse(await call("lint", IMG, { cwd: folder })),
    [],
  );
  expect(
    "a folder that no longer exists falls back to no configuration",
    JSON.parse(await call("lint", IMG, { cwd: `${folder}-gone` })),
    H013,
  );
  expect(
    "the configuration option takes a path on the host",
    JSON.parse(
      await call("lint", IMG, { pathOptions: { configuration: global } }),
    ),
    [],
  );
} finally {
  rmSync(project, { force: true, recursive: true });
}

await worker.terminate();

if (failures.length > 0) {
  console.error(`\n${failures.length} bundle check(s) failed`);
  process.exit(1);
}
console.log("\nbundled runtime verified");

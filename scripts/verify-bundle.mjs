import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

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
  const pinned = readFileSync("djlint-requirements.txt", "utf8")
    .trim()
    .replace(/^djlint\s*==\s*/u, "");
  const lock = JSON.parse(
    readFileSync(path.join(INDEX_URL, "pyodide-lock.json"), "utf8"),
  );
  const bundled = lock.packages?.djlint?.version;
  if (bundled !== pinned) {
    throw new Error(
      `bundled djLint is ${bundled}, but djlint-requirements.txt pins ${pinned}`,
    );
  }
  console.log(`ok   bundled djLint is the pinned ${pinned}`);
}

assertBundledDjlintIsPinnedVersion();

const worker = new Worker(WORKER, { workerData: { indexURL: INDEX_URL } });
const pending = new Map();
const seq = { value: 0 };

worker.on("message", (res) => {
  pending.get(res.id)?.(res);
  pending.delete(res.id);
});
worker.on("error", (e) => {
  console.error("bundled worker errored:", e);
  process.exit(1);
});

async function call(kind, src, opts, filename) {
  seq.value += 1;
  const id = seq.value;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${kind} timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    pending.set(id, (res) => {
      clearTimeout(timer);
      if (res.ok) {
        resolve(res.result);
      } else {
        reject(new Error(`${kind} failed: ${res.error}`));
      }
    });
    // eslint-disable-next-line unicorn/require-post-message-target-origin -- worker_threads postMessage takes no targetOrigin
    worker.postMessage({ filename, id, kind, opts, src });
  });
}

const failures = [];

function withSortedKeys(value) {
  if (Array.isArray(value)) {
    return value.map((item) => withSortedKeys(item));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .toSorted((a, b) => a.localeCompare(b))
      .map((key) => [key, withSortedKeys(value[key])]),
  );
}

function expect(label, actual, expected) {
  const a = JSON.stringify(withSortedKeys(actual));
  const e = JSON.stringify(withSortedKeys(expected));
  if (a === e) {
    console.log(`ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
  }
}

const formatted = await call(
  "format",
  '<div><p>hi</p>\n<img src="x.png">\n</div>',
  { close_void_tags: true, indent: 2, profile: "django" },
  "templates/a.html",
);
expect(
  "format applies indent, profile and close_void_tags",
  formatted,
  '<div>\n  <p>hi</p>\n  <img src="x.png" />\n</div>\n',
);

const diagnostics = await call(
  "lint",
  '<div><img src="x.png"></div>',
  { profile: "django" },
  "templates/a.html",
);
expect("lint reports the expected violation", diagnostics, [
  {
    code: "H013",
    column: 5,
    line: 1,
    message: "Img tag should have an alt attribute.",
  },
]);

const ignored = await call(
  "lint",
  '<div><img src="x.png"></div>',
  { per_file_ignores: [["templates/.*", "H013"]], profile: "django" },
  "templates/a.html",
);
expect("per-file-ignores suppresses the violation", ignored, []);

await worker.terminate();

if (failures.length > 0) {
  console.error(`\n${failures.length} bundle check(s) failed`);
  process.exit(1);
}
console.log("\nbundled runtime verified");

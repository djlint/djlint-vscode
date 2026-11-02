// Rewrites package.json in place, so restore it after packaging on a working copy.
import { readFileSync, writeFileSync } from "node:fs";

const json = readFileSync("package.json", "utf8");
const minifiedJson = JSON.stringify(JSON.parse(json));
writeFileSync("package.json", minifiedJson);

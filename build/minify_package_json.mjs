import * as fs from "node:fs";

const json = fs.readFileSync("package.json", "utf8");
const minifiedJson = JSON.stringify(JSON.parse(json));
fs.writeFileSync("package.json", minifiedJson);

import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifestPath = ".claude-plugin/plugin.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

manifest.version = pkg.version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

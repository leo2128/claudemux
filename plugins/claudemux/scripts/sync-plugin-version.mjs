import { readFileSync, writeFileSync } from "node:fs";

// Mirror each plugin's package.json version into its Claude plugin manifest.
// `changeset version` bumps package.json across the whole workspace, but the
// .claude-plugin/plugin.json manifests are not npm packages, so changesets
// never touches them — they would drift without this sync.
//
// Runs from plugins/claudemux (see package.json `version-packages`), so the
// sibling feishu-channel package is addressed relative to that cwd.
const targets = [
  { pkg: "package.json", manifest: ".claude-plugin/plugin.json" },
  {
    pkg: "../feishu-channel/package.json",
    manifest: "../feishu-channel/.claude-plugin/plugin.json",
  },
];

for (const { pkg, manifest } of targets) {
  const { version } = JSON.parse(readFileSync(pkg, "utf8"));
  const data = JSON.parse(readFileSync(manifest, "utf8"));
  data.version = version;
  writeFileSync(manifest, `${JSON.stringify(data, null, 2)}\n`);
}

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const prePath = ".changeset/pre.json";
const fragmentIds = new Set(
  process.argv
    .slice(2)
    .filter((path) => path.endsWith(".md"))
    .map((path) => basename(path, ".md"))
    .filter((id) => id && id !== "README"),
);

if (fragmentIds.size === 0) {
  console.log("No release changeset fragments to prepare.");
  process.exit(0);
}

if (!existsSync(prePath)) {
  console.log("No prerelease state found; nothing to prepare.");
  process.exit(0);
}

const pre = JSON.parse(readFileSync(prePath, "utf8"));

if (!Array.isArray(pre.changesets)) {
  throw new Error(`${prePath} does not contain a changesets array`);
}

// Changesets treats ids in pre.json as already consumed in prerelease mode.
// A feature branch can carry both a new fragment and its id in pre.json, so
// release automation must reopen just those newly added fragments before
// running `changeset version`.
const nextChangesets = pre.changesets.filter((id) => !fragmentIds.has(id));
const removedCount = pre.changesets.length - nextChangesets.length;

if (removedCount === 0) {
  console.log("No newly added changesets were already marked as consumed.");
  process.exit(0);
}

pre.changesets = nextChangesets;
writeFileSync(prePath, `${JSON.stringify(pre, null, 2)}\n`);
console.log(`Prepared ${removedCount} prerelease changeset(s) for versioning.`);

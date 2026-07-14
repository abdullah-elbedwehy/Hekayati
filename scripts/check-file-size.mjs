import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const roots = ["src", "tests", "scripts"];
const extensions = new Set([".ts", ".tsx", ".css", ".mjs"]);
const limit = 800;

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = join(directory, entry.name);
      return entry.isDirectory() ? collect(target) : [target];
    }),
  );
  return nested.flat();
}

const files = (await Promise.all(roots.map(collect)))
  .flat()
  .filter((file) => extensions.has(extname(file)));
const violations = [];

for (const file of files) {
  const lines = (await readFile(file, "utf8")).split("\n").length;
  if (lines > limit) violations.push(`${file}: ${lines} lines`);
}

if (violations.length > 0) {
  console.error(
    `Files exceed the ${limit}-line limit:\n${violations.join("\n")}`,
  );
  process.exitCode = 1;
} else {
  console.log(`File-size guard passed for ${files.length} files.`);
}

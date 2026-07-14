import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { uiFonts } from "./ui-font-manifest.mjs";

const destinationRoot = resolve("src/ui/fonts");
await mkdir(destinationRoot, { recursive: true });

for (const font of uiFonts) {
  const response = await fetch(font.url, { redirect: "follow" });
  if (!response.ok)
    throw new Error(`UI_FONT_DOWNLOAD_FAILED ${font.path} ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== font.sha256)
    throw new Error(`UI_FONT_HASH_MISMATCH ${font.path}`);
  await writeFile(resolve(destinationRoot, font.path), bytes, { mode: 0o644 });
  process.stdout.write(`verified ${font.path} ${actual}\n`);
}

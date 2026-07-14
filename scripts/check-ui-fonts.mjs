import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { uiFonts } from "./ui-font-manifest.mjs";

for (const font of uiFonts) {
  const bytes = await readFile(resolve("src/ui/fonts", font.path));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== font.sha256)
    throw new Error(`UI_FONT_HASH_MISMATCH ${font.path}`);
}

process.stdout.write(`UI font hashes passed for ${uiFonts.length} files.\n`);

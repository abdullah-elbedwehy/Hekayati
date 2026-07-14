import { execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { renderCharacterSheetPdf } from "../../src/pdf/character-sheet.js";
import { temporaryDirectory } from "../helpers/temp.js";

const run = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("compact character sheet PDF", () => {
  it("renders one offline Arabic page with all required views", async () => {
    const temp = await temporaryDirectory("hekayati-sheet-pdf-");
    cleanups.push(temp.cleanup);
    const bytes = await renderCharacterSheetPdf({
      characterName: "نور",
      views: {
        face: image("face"),
        front: image("front"),
        threeQuarter: image("three-quarter"),
        fullBody: image("full-body"),
        mainOutfit: image("outfit"),
      },
      referenceThumbnails: [image("reference")],
    });
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("%PDF");
    const pdfPath = join(temp.path, "sheet.pdf");
    await writeFile(pdfPath, bytes);
    const info = await run("pdfinfo", [pdfPath], { encoding: "utf8" });
    expect(info.stdout).toMatch(/Pages:\s+1/u);
    expect(info.stdout).toMatch(
      /Page size:\s+594(?:\.\d+)? x 420(?:\.\d+)? pts/u,
    );
    const textPath = join(temp.path, "sheet.txt");
    await run("pdftotext", [pdfPath, textPath]);
    const text = await readFile(textPath, "utf8");
    expect(text).toContain("نور");
    expect(text).toContain("الوجه");
    expect(text).toContain("الرئيسية");
    const renderPrefix = join(temp.path, "sheet-render");
    await run("pdftoppm", [
      "-f",
      "1",
      "-singlefile",
      "-png",
      "-r",
      "120",
      pdfPath,
      renderPrefix,
    ]);
    expect((await stat(`${renderPrefix}.png`)).size).toBeGreaterThan(5_000);
  }, 30_000);
});

function image(seed: string) {
  return {
    bytes: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
    mime: "image/png" as const,
    alt: `synthetic-${seed}`,
  };
}

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

const fixtures = [
  {
    path: "fixtures/fonts/Lemonada-SemiBold.ttf",
    sha256: "7a51391cbecb60a7b6dac8b2b45ef72109e93568ae78016e246027ce09af9d4a",
    url: "https://raw.githubusercontent.com/google/fonts/0a305919137700d960d61643f1a926d861694c76/ofl/lemonada/static/Lemonada-SemiBold.ttf",
  },
  {
    path: "fixtures/fonts/LICENSE-Lemonada-OFL.txt",
    sha256: "d8a8801a55cbc8eeaab7dc9396c4491d60cc7e4ecb2501c6f8282754d743fc2a",
    url: "https://raw.githubusercontent.com/google/fonts/0a305919137700d960d61643f1a926d861694c76/ofl/lemonada/OFL.txt",
  },
  {
    path: "fixtures/fonts/IBMPlexSansArabic-Regular.ttf",
    sha256: "8e0f1046c736bf939d4939ee3ae0116acf61cbcd6592deae7656761627080981",
    url: "https://raw.githubusercontent.com/IBM/plex/1da12f02587b630c07e92692d21492d722f53614/packages/plex-sans-arabic/fonts/complete/ttf/IBMPlexSansArabic-Regular.ttf",
  },
  {
    path: "fixtures/fonts/LICENSE-IBM-Plex-OFL.txt",
    sha256: "7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da",
    url: "https://raw.githubusercontent.com/IBM/plex/1da12f02587b630c07e92692d21492d722f53614/packages/plex-sans-arabic/LICENSE.txt",
  },
];

for (const fixture of fixtures) {
  const response = await fetch(fixture.url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Font fixture download failed (${response.status}): ${fixture.path}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== fixture.sha256) {
    throw new Error(`SHA-256 mismatch for ${fixture.path}: expected ${fixture.sha256}, got ${actual}`);
  }

  const destination = resolve(root, fixture.path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { mode: 0o644 });
  process.stdout.write(`verified ${fixture.path} ${actual}\n`);
}

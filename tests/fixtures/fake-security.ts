#!/usr/bin/env -S node --import tsx

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const statePath = process.env.HEKAYATI_FAKE_KEYCHAIN_FILE;
if (!statePath) process.exit(70);

const command = process.argv[2];
if (command === "add-generic-password") {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const secret = Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await writeFile(statePath, secret, { mode: 0o600 });
} else if (command === "find-generic-password") {
  try {
    process.stdout.write(`${await readFile(statePath, "utf8")}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      process.exitCode = 44;
    } else throw error;
  }
} else if (command === "delete-generic-password") {
  try {
    await rm(statePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      process.exitCode = 44;
    } else throw error;
  }
} else {
  process.exitCode = 64;
}

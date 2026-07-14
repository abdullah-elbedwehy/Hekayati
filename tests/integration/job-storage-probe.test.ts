import { readdir, rm, symlink, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { prepareDataPaths, resolveDataPaths } from "../../src/config/paths.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import {
  probeSchedulerStorage,
  type StorageProbeDatabase,
} from "../../src/jobs/storage-probe.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("scheduler storage recovery probe", () => {
  it("checks SQLite and completes a durable write lifecycle", async () => {
    const fixture = await harness();
    let transactions = 0;
    const database: StorageProbeDatabase = {
      isHealthy: () => fixture.store.isHealthy(),
      transaction: (operation) => {
        transactions += 1;
        return fixture.store.transaction(operation);
      },
    };

    await expect(
      probeSchedulerStorage({
        paths: fixture.paths,
        database,
        minimumFreeBytes: 0,
      }),
    ).resolves.toBe(true);

    expect(transactions).toBe(1);
    expect(await probeArtifacts(fixture.paths.root)).toEqual([]);
  });

  it("fails closed when the DB transaction or health read fails", async () => {
    const fixture = await harness();
    const failingTransaction: StorageProbeDatabase = {
      isHealthy: () => true,
      transaction: () => {
        throw new Error("SQLITE_BUSY");
      },
    };
    const unhealthy: StorageProbeDatabase = {
      isHealthy: () => false,
      transaction: (operation) => operation(),
    };

    await expect(
      probeSchedulerStorage({
        paths: fixture.paths,
        database: failingTransaction,
        minimumFreeBytes: 0,
      }),
    ).resolves.toBe(false);
    await expect(
      probeSchedulerStorage({
        paths: fixture.paths,
        database: unhealthy,
        minimumFreeBytes: 0,
      }),
    ).resolves.toBe(false);
    expect(await probeArtifacts(fixture.paths.root)).toEqual([]);
  });

  it("enforces the configured free-space threshold before writing", async () => {
    const fixture = await harness();

    await expect(
      probeSchedulerStorage({
        paths: fixture.paths,
        database: fixture.store,
        minimumFreeBytes: Number.MAX_SAFE_INTEGER,
      }),
    ).resolves.toBe(false);
    expect(await probeArtifacts(fixture.paths.root)).toEqual([]);
  });

  it("rejects non-canonical paths, bad ownership, and symlinked directories", async () => {
    const fixture = await harness();
    const external = await temporaryDirectory("hekayati-probe-external-");
    cleanups.push(external.cleanup);
    const input = {
      paths: fixture.paths,
      database: fixture.store,
      minimumFreeBytes: 0,
    };

    await expect(
      probeSchedulerStorage({
        ...input,
        paths: { ...fixture.paths, assets: external.path },
      }),
    ).resolves.toBe(false);

    await writeFile(fixture.paths.ownershipMarker, "{}", "utf8");
    await expect(probeSchedulerStorage(input)).resolves.toBe(false);

    await writeFile(
      fixture.paths.ownershipMarker,
      JSON.stringify({ product: "Hekayati", schemaVersion: 1 }),
      "utf8",
    );
    await rm(fixture.paths.logs, { recursive: true });
    await symlink(external.path, fixture.paths.logs, "dir");
    await expect(probeSchedulerStorage(input)).resolves.toBe(false);
    expect(await probeArtifacts(fixture.paths.root)).toEqual([]);
  });

  it("rejects invalid byte thresholds without touching storage", async () => {
    const fixture = await harness();

    await expect(
      probeSchedulerStorage({
        paths: fixture.paths,
        database: fixture.store,
        minimumFreeBytes: -1,
      }),
    ).resolves.toBe(false);
    await expect(
      probeSchedulerStorage({
        paths: fixture.paths,
        database: fixture.store,
        minimumFreeBytes: Number.POSITIVE_INFINITY,
      }),
    ).resolves.toBe(false);
    expect(await probeArtifacts(fixture.paths.root)).toEqual([]);
  });
});

async function harness() {
  const directory = await temporaryDirectory("hekayati-storage-probe-");
  const paths = resolveDataPaths(directory.path);
  await prepareDataPaths(paths);
  const store = new DocumentStore(paths.database);
  cleanups.push(async () => {
    store.close();
    await directory.cleanup();
  });
  return { paths, store };
}

async function probeArtifacts(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) =>
    name.startsWith(".hekayati-storage-probe-"),
  );
}

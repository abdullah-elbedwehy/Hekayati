import {
  chmod,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { AssetStore } from "../../src/assets/asset-store.js";
import { prepareDataPaths, resolveDataPaths } from "../../src/config/paths.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { createRuntime } from "../../src/server/app.js";
import { DocumentRepository } from "../../src/domain/repository/document-store.js";
import { SettingsService } from "../../src/domain/settings/settings.js";
import { HealthService } from "../../src/server/health/health-service.js";
import { LocalRequestBoundary } from "../../src/server/security/request-boundary.js";
import { httpRequest } from "../helpers/http.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () =>
  Promise.all(cleanups.splice(0).map((cleanup) => cleanup())),
);

describe("settings and health foundation", () => {
  it("persists validated settings across a full server restart", async () => {
    const directory = await temporaryDirectory();
    cleanups.push(directory.cleanup);
    const first = await createRuntime({
      dataDir: directory.path,
      serveUi: false,
    });
    let origin = await first.start();
    const bootstrap = await json(origin, "/api/bootstrap");
    const settings = await json(origin, "/api/settings");
    const update = settingsUpdate(settings, {
      watermarkText: "علامة اختبار",
      diskWarnGb: 999,
    });
    const saved = await json(origin, "/api/settings", {
      method: "PUT",
      headers: {
        ...secureHeaders(origin, bootstrap.csrfToken),
        "content-type": "application/json",
      },
      body: JSON.stringify(update),
    });
    expect(saved.watermarkText).toBe("علامة اختبار");
    await first.close();

    const second = await createRuntime({
      dataDir: directory.path,
      serveUi: false,
    });
    cleanups.push(() => second.close());
    origin = await second.start();
    const persisted = await json(origin, "/api/settings");
    expect(persisted.watermarkText).toBe("علامة اختبار");
    expect(persisted.diskWarnGb).toBe(999);
    const health = await json(origin, "/api/health");
    expect(health.disk.status).toBe("warning");
  });

  it("rejects secrets and read-only path changes from the settings document", async () => {
    const fixture = await runtimeFixture();
    const bootstrap = await json(fixture.origin, "/api/bootstrap");
    const settings = await json(fixture.origin, "/api/settings");
    for (const malicious of [
      { ...settingsUpdate(settings), apiKey: "must-not-persist" },
      {
        ...settingsUpdate(settings),
        storagePathsReadonly: { data: "/tmp/evil", assets: "/tmp" },
      },
      {
        ...settingsUpdate(settings),
        models: {
          ...settings.models,
          geminiText: "AIza1234567890123456789012345",
        },
      },
    ]) {
      const response = await httpRequest(fixture.origin, "/api/settings", {
        method: "PUT",
        headers: {
          ...secureHeaders(fixture.origin, bootstrap.csrfToken),
          "content-type": "application/json",
        },
        body: JSON.stringify(malicious),
      });
      expect(response.status).toBe(400);
      expect(response.body).not.toContain("must-not-persist");
    }
    const corpus = await readCorpus(fixture.runtime.paths.root);
    expect(corpus.includes(Buffer.from("AIza1234567890123456789012345"))).toBe(
      false,
    );
  });

  it("rejects the exact runtime token in an otherwise allowed field", async () => {
    const fixture = await runtimeFixture();
    const bootstrap = await json(fixture.origin, "/api/bootstrap");
    const settings = await json(fixture.origin, "/api/settings");
    const response = await httpRequest(fixture.origin, "/api/settings", {
      method: "PUT",
      headers: {
        ...secureHeaders(fixture.origin, bootstrap.csrfToken),
        "content-type": "application/json",
      },
      body: JSON.stringify(
        settingsUpdate(settings, { watermarkText: bootstrap.csrfToken }),
      ),
    });

    expect(response.status).toBe(400);
    const persisted = await json(fixture.origin, "/api/settings");
    expect(persisted.watermarkText === bootstrap.csrfToken).toBe(false);
    const corpus = await readCorpus(fixture.runtime.paths.root);
    expect(corpus.includes(Buffer.from(bootstrap.csrfToken))).toBe(false);
  });

  it("classifies malformed and oversized JSON as safe client errors", async () => {
    const fixture = await runtimeFixture();
    const bootstrap = await json(fixture.origin, "/api/bootstrap");
    const headers = {
      ...secureHeaders(fixture.origin, bootstrap.csrfToken),
      "content-type": "application/json",
    };
    const malformed = await httpRequest(fixture.origin, "/api/settings", {
      method: "PUT",
      headers,
      body: "{private-invalid-json",
    });
    const oversized = await httpRequest(fixture.origin, "/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ padding: "x".repeat(1024 * 1024) }),
    });

    expect(malformed.status).toBe(400);
    expect(malformed.body).toBe('{"code":"INVALID_REQUEST"}');
    expect(malformed.body).not.toContain("private-invalid-json");
    expect(oversized.status).toBe(413);
    expect(oversized.body).toBe('{"code":"PAYLOAD_TOO_LARGE"}');
    expect(
      await readFile(`${fixture.runtime.paths.logs}/app.log`, "utf8"),
    ).not.toContain("private-invalid-json");
  });

  it("reports unavailable future subsystems honestly and scans without regeneration", async () => {
    const fixture = await runtimeFixture();
    const bootstrap = await json(fixture.origin, "/api/bootstrap");
    const health = await json(fixture.origin, "/api/health");
    expect(health.providers).toEqual({ status: "not_configured" });
    expect(health.queue).toEqual({ status: "not_available", depth: null });
    expect(health.printerProfiles).toEqual({ status: "not_configured" });
    expect(health.listener).toEqual({
      status: "ok",
      canonicalOrigin: fixture.origin,
    });

    const scan = await json(fixture.origin, "/api/health/integrity-scan", {
      method: "POST",
      headers: secureHeaders(fixture.origin, bootstrap.csrfToken),
    });
    expect(scan).toMatchObject({ checked: 0, healthy: 0, issues: [] });
  });

  it("reports a real corrupt indexed asset at startup and on operator rescan", async () => {
    const directory = await temporaryDirectory();
    cleanups.push(directory.cleanup);
    const paths = resolveDataPaths(join(directory.path, "data"));
    await prepareDataPaths(paths);
    const seedStore = new DocumentStore(paths.database);
    const seedAssets = new AssetStore(seedStore, paths.assets);
    const asset = await seedAssets.put({
      bytes: Buffer.from("healthy-before-restart"),
      extension: "bin",
      mime: "application/octet-stream",
      origin: "derived",
      role: "thumbnail",
    });
    const assetPath = seedAssets.pathForRecord(asset);
    seedStore.close();
    await writeFile(assetPath, "corrupt-after-close", { mode: 0o600 });

    const runtime = await createRuntime({
      dataDir: paths.root,
      serveUi: false,
    });
    cleanups.push(() => runtime.close());
    const origin = await runtime.start();
    const startup = await json(origin, "/api/health");
    expect(startup.integrity.issues).toEqual([
      { assetId: asset.id, reason: "checksum_mismatch" },
    ]);
    const bootstrap = await json(origin, "/api/bootstrap");
    const rescanned = await json(origin, "/api/health/integrity-scan", {
      method: "POST",
      headers: secureHeaders(origin, bootstrap.csrfToken),
    });
    expect(rescanned.issues).toEqual([
      { assetId: asset.id, reason: "checksum_mismatch" },
    ]);
    expect(await readFile(assetPath, "utf8")).toBe("corrupt-after-close");
  });

  it("runs the deferred seed-template installation hook before readiness", async () => {
    const directory = await temporaryDirectory();
    cleanups.push(directory.cleanup);
    const markerSchema = z
      .object({
        id: z.literal("phase-3-installer"),
        schemaVersion: z.literal(1),
        createdAt: z.iso.datetime(),
        updatedAt: z.iso.datetime(),
        installed: z.literal(true),
      })
      .strict();
    let calls = 0;
    const runtime = await createRuntime({
      dataDir: directory.path,
      serveUi: false,
      seedTemplateInstaller: {
        install: (store) => {
          calls += 1;
          const repository = new DocumentRepository(
            store,
            "seed_installation_markers",
            markerSchema,
          );
          const now = new Date().toISOString();
          repository.put({
            id: "phase-3-installer",
            schemaVersion: 1,
            createdAt: now,
            updatedAt: now,
            installed: true,
          });
        },
      },
    });
    cleanups.push(() => runtime.close());

    expect(calls).toBe(1);
    expect(runtime.app.server.listening).toBe(false);
    const origin = await runtime.start();
    expect((await json(origin, "/api/health")).database.status).toBe("ok");
  });

  it("keeps settings reads side-effect free after explicit initialization", async () => {
    const fixture = await serviceFixture();
    fixture.settings.initialize();
    fixture.store.database
      .prepare("DELETE FROM documents WHERE collection = 'settings'")
      .run();
    const count = () =>
      (
        fixture.store.database
          .prepare(
            "SELECT COUNT(*) AS count FROM documents WHERE collection = 'settings'",
          )
          .get() as { count: number }
      ).count;

    expect(count()).toBe(0);
    expect(() => fixture.settings.get()).toThrow("SETTINGS_NOT_INITIALIZED");
    expect(count()).toBe(0);
  });

  it("returns a degraded health snapshot when the database becomes unavailable", async () => {
    const fixture = await serviceFixture();
    fixture.settings.initialize();
    const assets = new AssetStore(fixture.store, fixture.paths.assets);
    const health = new HealthService(
      fixture.store,
      assets,
      fixture.settings,
      new LocalRequestBoundary(),
      fixture.paths,
      await assets.scanIntegrity(),
    );
    fixture.store.close();

    const snapshot = await health.snapshot();

    expect(snapshot.database.status).toBe("error");
    expect(snapshot.disk.thresholdGb).toBe(10);
    expect(snapshot.listener.status).toBe("error");
  });

  it("keeps every foundation data directory and live file private", async () => {
    const directory = await temporaryDirectory();
    cleanups.push(directory.cleanup);
    const runtime = await createRuntime({
      dataDir: `${directory.path}/data`,
      serveUi: false,
    });
    cleanups.push(() => runtime.close());
    await runtime.start();

    await expectPrivateTree(runtime.paths.root);
  });

  it("locks the data root before a second launch can sweep unindexed bytes", async () => {
    const directory = await temporaryDirectory();
    cleanups.push(directory.cleanup);
    const dataDir = join(directory.path, "data");
    const first = await createRuntime({ dataDir, serveUi: false });
    const orphanDirectory = join(first.paths.assets, "aa");
    const orphan = join(orphanDirectory, `${"a".repeat(64)}.bin`);
    await mkdir(orphanDirectory, { recursive: true, mode: 0o700 });
    await writeFile(orphan, "renamed-before-db-commit", { mode: 0o600 });

    await expect(createRuntime({ dataDir, serveUi: false })).rejects.toThrow(
      "DATA_ROOT_IN_USE",
    );
    expect(await readFile(orphan, "utf8")).toBe("renamed-before-db-commit");

    await first.close();
    const recovered = await createRuntime({ dataDir, serveUi: false });
    cleanups.push(() => recovered.close());
    await expect(stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an unowned non-empty data root without changing its files", async () => {
    const directory = await temporaryDirectory();
    cleanups.push(directory.cleanup);
    const dataDir = join(directory.path, "existing-folder");
    const unrelatedAssets = join(dataDir, "assets");
    const unrelated = join(unrelatedAssets, "family-notes.txt");
    await mkdir(unrelatedAssets, { recursive: true, mode: 0o700 });
    await writeFile(unrelated, "must remain", { mode: 0o600 });

    await expect(createRuntime({ dataDir, serveUi: false })).rejects.toThrow(
      "UNOWNED_DATA_ROOT",
    );
    expect(await readFile(unrelated, "utf8")).toBe("must remain");
    await expect(
      stat(join(dataDir, ".hekayati-data-root.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked ownership marker without touching its target", async () => {
    const directory = await temporaryDirectory();
    cleanups.push(directory.cleanup);
    const dataDir = join(directory.path, "linked-marker-root");
    const external = join(directory.path, "external-marker.json");
    const marker = join(dataDir, ".hekayati-data-root.json");
    const content = JSON.stringify({ product: "Hekayati", schemaVersion: 1 });
    await mkdir(dataDir, { mode: 0o700 });
    await writeFile(external, content, { mode: 0o600 });
    await chmod(external, 0o644);
    await symlink(external, marker);

    await expect(createRuntime({ dataDir, serveUi: false })).rejects.toThrow(
      "INVALID_DATA_ROOT_MARKER",
    );
    expect(await readFile(external, "utf8")).toBe(content);
    expect((await stat(external)).mode & 0o777).toBe(0o644);
    await expect(stat(join(dataDir, "assets"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

async function serviceFixture() {
  const directory = await temporaryDirectory();
  cleanups.push(directory.cleanup);
  const paths = resolveDataPaths(`${directory.path}/data`);
  await prepareDataPaths(paths);
  const store = new DocumentStore(paths.database);
  const settings = new SettingsService(store, paths);
  cleanups.push(async () => store.close());
  return { paths, store, settings };
}

async function runtimeFixture() {
  const directory = await temporaryDirectory();
  const runtime = await createRuntime({
    dataDir: directory.path,
    serveUi: false,
  });
  const origin = await runtime.start();
  cleanups.push(runtime.close, directory.cleanup);
  return { runtime, origin };
}

async function readCorpus(root: string): Promise<Buffer> {
  const entries = await readdir(root, { withFileTypes: true });
  const chunks = await Promise.all(
    entries.map(async (entry) => {
      const target = join(root, entry.name);
      return entry.isDirectory() ? readCorpus(target) : readFile(target);
    }),
  );
  return Buffer.concat(chunks);
}

async function expectPrivateTree(root: string): Promise<void> {
  expect((await stat(root)).mode & 0o777).toBe(0o700);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = join(root, entry.name);
    if (entry.isDirectory()) await expectPrivateTree(target);
    else {
      expect(entry.isFile()).toBe(true);
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    }
  }
}

async function json(
  origin: string,
  path: string,
  options?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) {
  const response = await httpRequest(origin, path, options);
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return JSON.parse(response.body);
}

function secureHeaders(origin: string, token: string): Record<string, string> {
  return {
    origin,
    "x-hekayati-csrf": token,
  };
}

function settingsUpdate(
  settings: any,
  overrides: Record<string, unknown> = {},
) {
  return {
    textProvider: settings.textProvider,
    imageProvider: settings.imageProvider,
    models: settings.models,
    concurrencyPerProvider: settings.concurrencyPerProvider,
    typography: settings.typography,
    watermarkText: settings.watermarkText,
    diskWarnGb: settings.diskWarnGb,
    firstRunAcknowledged: settings.firstRunAcknowledged,
    ...overrides,
  };
}

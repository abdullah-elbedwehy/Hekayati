import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { appendFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  writeDeterministicArchive,
  type StagedArchiveSource,
} from "../../src/portability/export.js";
import { createManifest } from "../../src/portability/manifest.js";
import {
  scanStagedArchive,
  verifyFinalizedArchive,
} from "../../src/portability/release-gate.js";
import { SecretReleaseGate } from "../../src/portability/secret-scan.js";
import { SecretRegistry } from "../../src/security/secret-registry.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () =>
  Promise.all(cleanups.splice(0).map((cleanup) => cleanup())),
);

describe("finalized portability archive release gate", () => {
  it("scans frozen staged entries before packaging without leaking matches", async () => {
    const secret = "synthetic-staged-secret-canary";
    const blocked = stagedFixture(Buffer.from(`{"value":"${secret}"}`));
    const registry = new SecretRegistry();
    registry.register(secret);

    const finding = await scanStagedArchive(
      blocked.manifest,
      blocked.sources,
      new SecretReleaseGate(registry),
    );

    expect(finding).toEqual({
      category: "registered_or_known_secret",
      entry: blocked.manifest.documents[0].path,
    });
    expect(JSON.stringify(finding)).not.toContain(secret);
    const clean = stagedFixture(Buffer.from('{"safe":true}'));
    await expect(
      scanStagedArchive(
        clean.manifest,
        clean.sources,
        new SecretReleaseGate(new SecretRegistry()),
      ),
    ).resolves.toBeNull();
  });

  it("independently verifies the archive and every finalized entry", async () => {
    const fixture = await archiveFixture(Buffer.from('{"safe":true}'));

    await expect(
      verifyFinalizedArchive(
        fixture.file,
        fixture.manifest,
        fixture.written,
        new SecretReleaseGate(new SecretRegistry()),
      ),
    ).resolves.toEqual({ ok: true, archive: fixture.written });
  });

  it("returns only bounded finding facts when finalized bytes contain a secret", async () => {
    const secret = "synthetic-runtime-secret-canary";
    const fixture = await archiveFixture(Buffer.from(`{"value":"${secret}"}`));
    const registry = new SecretRegistry();
    registry.register(secret);

    const result = await verifyFinalizedArchive(
      fixture.file,
      fixture.manifest,
      fixture.written,
      new SecretReleaseGate(registry),
    );

    expect(result).toEqual({
      ok: false,
      finding: {
        category: "registered_or_known_secret",
        entry: fixture.manifest.documents[0].path,
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("rejects archive checksum drift before entry release", async () => {
    const fixture = await archiveFixture(Buffer.from('{"safe":true}'));
    await appendFile(fixture.file, Buffer.from("drift"));

    await expect(
      verifyFinalizedArchive(
        fixture.file,
        fixture.manifest,
        fixture.written,
        new SecretReleaseGate(new SecretRegistry()),
      ),
    ).rejects.toThrow("PORTABILITY_ARCHIVE_CHECKSUM_MISMATCH");
  });

  it("requires the finalized candidate to remain an exact private 0600 file", async () => {
    const fixture = await archiveFixture(Buffer.from('{"safe":true}'));
    await chmod(fixture.file, 0o700);

    await expect(
      verifyFinalizedArchive(
        fixture.file,
        fixture.manifest,
        fixture.written,
        new SecretReleaseGate(new SecretRegistry()),
      ),
    ).rejects.toThrow("PORTABILITY_ARCHIVE_PERMISSIONS_INVALID");
  });
});

async function archiveFixture(documentBytes: Buffer) {
  const directory = await temporaryDirectory("hekayati-release-");
  cleanups.push(directory.cleanup);
  const file = join(directory.path, "candidate.zip");
  const { manifest, sources } = stagedFixture(documentBytes);
  const written = await writeDeterministicArchive(
    manifest,
    sources,
    createWriteStream(file, { flags: "wx", mode: 0o600 }),
  );
  await chmod(file, 0o600);
  return { file, manifest, written };
}

function stagedFixture(documentBytes: Buffer) {
  const documentHash = sha256(documentBytes);
  const manifest = createManifest({
    appVersion: "0.1.0",
    createdAt: "2026-07-16T00:00:00.000Z",
    exportId: "export-release-1",
    mode: "project",
    scope: {
      kind: "project",
      projectId: "project-1",
      customerId: "customer-1",
      familyId: "family-1",
    },
    roots: [{ kind: "project", id: "project-1" }],
    documents: [
      {
        collection: "projects",
        id: "project-1",
        schemaVersion: 1,
        bytes: documentBytes.byteLength,
        sha256: documentHash,
      },
    ],
    media: [],
    snapshotHash: "a".repeat(64),
  });
  const sources: StagedArchiveSource[] = [
    {
      path: manifest.documents[0].path,
      bytes: documentBytes.byteLength,
      sha256: documentHash,
      open: () => Readable.from(documentBytes),
    },
  ];
  return { manifest, sources };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

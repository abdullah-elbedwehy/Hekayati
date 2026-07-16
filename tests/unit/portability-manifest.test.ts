import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/contracts/canonical-json.js";
import {
  createManifest,
  parseManifestBytes,
} from "../../src/portability/manifest.js";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);

describe("HekayatiArchive/v2 manifest", () => {
  it("sorts exact generated entries and hashes the canonical projection", () => {
    const manifest = createManifest({
      appVersion: "0.1.0",
      createdAt: "2026-07-16T00:00:00.000Z",
      exportId: "export-1",
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
          collection: "stories",
          id: "story-1",
          schemaVersion: 1,
          bytes: 11,
          sha256: hashB,
        },
        {
          collection: "projects",
          id: "project-1",
          schemaVersion: 1,
          bytes: 7,
          sha256: hashA,
        },
      ],
      media: [
        {
          namespace: "asset",
          assetId: "asset-1",
          role: "illustration",
          mime: "image/png",
          extension: "png",
          bytes: 13,
          sha256: hashC,
        },
      ],
      snapshotHash: hashA,
    });

    expect(manifest.format).toBe("HekayatiArchive");
    expect(manifest.manifestVersion).toBe(2);
    expect(manifest.mode).toBe("project");
    expect(manifest.documents.map((entry) => entry.path)).toEqual([
      "data/projects/project-1.json",
      "data/stories/story-1.json",
    ]);
    expect(manifest.media[0]?.path).toBe(`media/assets/${hashC}.png`);
    expect(manifest.totalUncompressedBytes).toBe(31);

    const { manifestHash, ...projection } = manifest;
    expect(manifestHash).toBe(
      createHash("sha256").update(canonicalJson(projection)).digest("hex"),
    );
    expect(parseManifestBytes(Buffer.from(canonicalJson(manifest)))).toEqual(
      manifest,
    );
  });

  it("rejects duplicate, caller-controlled, non-canonical, and tampered entries", () => {
    const base = {
      appVersion: "0.1.0",
      createdAt: "2026-07-16T00:00:00.000Z",
      exportId: "export-2",
      mode: "project" as const,
      scope: {
        kind: "project" as const,
        projectId: "project-2",
        customerId: "customer-2",
        familyId: "family-2",
      },
      roots: [{ kind: "project" as const, id: "project-2" }],
      documents: [
        {
          collection: "projects",
          id: "project-2",
          schemaVersion: 1,
          bytes: 7,
          sha256: hashA,
        },
      ],
      media: [],
      snapshotHash: hashB,
    };

    expect(() =>
      createManifest({
        ...base,
        documents: [...base.documents, ...base.documents],
      }),
    ).toThrow("PORTABILITY_MANIFEST_DUPLICATE_PATH");

    const valid = createManifest(base);
    const { mode: _mode, ...withoutMode } = valid;
    expect(_mode).toBe("project");
    expect(() =>
      parseManifestBytes(Buffer.from(canonicalJson(withoutMode))),
    ).toThrow();
    expect(() =>
      parseManifestBytes(
        Buffer.from(canonicalJson({ ...valid, mode: "customer" })),
      ),
    ).toThrow();
    expect(() =>
      parseManifestBytes(
        Buffer.from(
          JSON.stringify({
            ...valid,
            documents: [{ ...valid.documents[0], path: "../../outside.json" }],
          }),
        ),
      ),
    ).toThrow();
    expect(() =>
      parseManifestBytes(Buffer.from(JSON.stringify(valid, null, 2))),
    ).toThrow("PORTABILITY_MANIFEST_NOT_CANONICAL");
    expect(() =>
      parseManifestBytes(
        Buffer.from(canonicalJson({ ...valid, snapshotHash: hashC })),
      ),
    ).toThrow("PORTABILITY_MANIFEST_HASH_MISMATCH");

    expect(() =>
      createManifest({
        ...base,
        documents: [
          base.documents[0],
          { ...base.documents[0], id: "PROJECT-2", sha256: hashB },
        ],
      }),
    ).toThrow("PORTABILITY_MANIFEST_PATH_COLLISION");
  });
});

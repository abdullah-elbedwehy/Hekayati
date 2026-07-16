import { describe, expect, it } from "vitest";

import {
  assertNoUnmappedArchiveIds,
  createExactIdMap,
  exactIdMapHash,
  lookupExactId,
  rewriteParticipantDocumentIds,
} from "../../src/domain/portability/id-map.js";

const at = "2026-07-16T18:30:00.000Z";
const id = (suffix: string) =>
  `01K51000000000000000000000`.slice(0, 25).concat(suffix);

describe("namespace-complete import ID maps", () => {
  it("disambiguates identical source IDs by declared namespace", () => {
    const source = id("0");
    const targetProject = id("1");
    const targetCharacter = id("2");
    const map = createExactIdMap([
      { namespace: "projects", sourceId: source, targetId: targetProject },
      { namespace: "characters", sourceId: source, targetId: targetCharacter },
      { namespace: "synthetic_docs", sourceId: id("3"), targetId: id("4") },
    ]);

    const rewritten = rewriteParticipantDocumentIds({
      collection: "synthetic_docs",
      document: {
        id: id("3"),
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        projectId: source,
        characterId: source,
        prose: `do not rewrite ${source} inside prose`,
      },
      idMap: map,
      documentReferences: [
        { collection: "projects", id: source, field: "projectId" },
        { collection: "characters", id: source, field: "characterId" },
      ],
      assetReferences: [],
      originalReferences: [],
    });

    expect(rewritten).toMatchObject({
      id: id("4"),
      projectId: targetProject,
      characterId: targetCharacter,
      prose: `do not rewrite ${source} inside prose`,
    });
    expect(lookupExactId(map, "projects", source)).toBe(targetProject);
    expect(exactIdMapHash(map)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => assertNoUnmappedArchiveIds(rewritten, map)).toThrow(
      "IMPORT_UNDECLARED_ARCHIVE_ID_RETAINED",
    );
  });

  it("fails closed on missing required mappings, ambiguous aliases, and conflicts", () => {
    const source = id("5");
    expect(() =>
      createExactIdMap([
        { namespace: "projects", sourceId: source, targetId: id("6") },
        { namespace: "projects", sourceId: source, targetId: id("7") },
      ]),
    ).toThrow("IMPORT_ID_MAP_SOURCE_CONFLICT");

    const map = createExactIdMap([
      { namespace: "projects", sourceId: source, targetId: id("6") },
      { namespace: "characters", sourceId: source, targetId: id("7") },
      { namespace: "synthetic_docs", sourceId: id("8"), targetId: id("9") },
    ]);
    expect(() => lookupExactId(map, null, source)).toThrow(
      "IMPORT_ID_MAP_NAMESPACE_AMBIGUOUS",
    );
    expect(() =>
      rewriteParticipantDocumentIds({
        collection: "synthetic_docs",
        document: {
          id: id("8"),
          schemaVersion: 1,
          createdAt: at,
          updatedAt: at,
          missingId: id("A"),
        },
        idMap: map,
        documentReferences: [
          {
            collection: "families",
            id: id("A"),
            field: "missingId",
            required: true,
          },
        ],
        assetReferences: [],
        originalReferences: [],
      }),
    ).toThrow("IMPORT_ID_MAP_REQUIRED_MAPPING_MISSING");
  });
});

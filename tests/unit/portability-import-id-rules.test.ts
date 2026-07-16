import { describe, expect, it } from "vitest";

import type { BaseDocument } from "../../src/domain/repository/document-store.js";
import { createExactIdMap } from "../../src/domain/portability/id-map.js";
import {
  explicitImportIdValues,
  importIdentityAlias,
  rewriteAdditionalParticipantIds,
} from "../../src/domain/portability/import-id-rules.js";

const ids = Array.from(
  { length: 16 },
  (_, index) =>
    `01J000000000000000000000${index.toString(36).toUpperCase().padStart(2, "0")}`,
);

describe("import explicit ID rules", () => {
  it("rewrites only declared nested job request and provenance IDs", () => {
    const document = jobDocument();
    const idMap = createExactIdMap([
      mapping("projects", 1, 9),
      mapping("characters", 2, 10),
      mapping("character_versions", 3, 11),
      mapping("looks", 4, 12),
      mapping("story_versions", 5, 13),
      mapping("asset", 6, 14),
    ]);

    const rewritten = rewriteAdditionalParticipantIds("jobs", document, idMap);

    expect(path(rewritten, "inputSnapshot.storyVersion")).toBe(ids[13]);
    expect(
      path(
        rewritten,
        "request.request.task.participants.0.characterRef.characterId",
      ),
    ).toBe(ids[10]);
    expect(
      path(
        rewritten,
        "request.request.task.participants.0.characterRef.characterVersionId",
      ),
    ).toBe(ids[11]);
    expect(
      path(rewritten, "request.request.task.participants.0.availableLookIds.0"),
    ).toBe(ids[12]);
    expect(path(rewritten, "provenance.referenceAssetIds.0")).toBe(ids[14]);
    expect(path(rewritten, "failure.message")).toBe(`leave ${ids[2]} alone`);
    expect(document).toEqual(jobDocument());
  });

  it("enumerates auxiliary IDs and declares identity-head aliases", () => {
    const document = jobDocument();
    const values = explicitImportIdValues("jobs", document);

    expect(values).toContainEqual({
      path: "inputSnapshot.*",
      namespace: null,
      required: true,
      sourceId: ids[5],
    });
    expect(values).toContainEqual({
      path: "provenance.referenceAssetIds.*",
      namespace: "asset",
      required: true,
      sourceId: ids[6],
    });
    expect(importIdentityAlias("page_layout_heads")).toEqual({
      targetCollection: "pages",
      targetPath: "pageId",
    });
    expect(importIdentityAlias("cover_compositions")).toEqual({
      targetCollection: "projects",
      targetPath: "projectId",
    });
  });
});

function jobDocument(): BaseDocument {
  return {
    id: ids[0],
    schemaVersion: 1,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    projectId: ids[1],
    inputSnapshot: { storyVersion: ids[5] },
    request: {
      kind: "structured",
      request: {
        task: {
          inputVersionRefs: { storyVersion: ids[5] },
          participants: [
            {
              characterRef: {
                characterId: ids[2],
                characterVersionId: ids[3],
              },
              availableLookIds: [ids[4]],
            },
          ],
        },
      },
    },
    provenance: {
      inputVersionRefs: { storyVersion: ids[5] },
      referenceAssetIds: [ids[6]],
    },
    failure: { message: `leave ${ids[2]} alone` },
  } as BaseDocument;
}

function mapping(namespace: string, source: number, target: number) {
  return { namespace, sourceId: ids[source], targetId: ids[target] };
}

function path(value: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((current, segment) => {
    if (Array.isArray(current)) return current[Number(segment)];
    return (current as Record<string, unknown>)[segment];
  }, value);
}

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  sanitizeSelectedImportDocument,
  selectImportBundle,
} from "../../src/domain/portability/import-plan-selection.js";
import {
  createPortabilityRegistry,
  definePortabilityParticipant,
} from "../../src/domain/portability/participants.js";
import type { BaseDocument } from "../../src/domain/repository/document-store.js";

const at = "2026-07-16T19:30:00.000Z";
const ids = Array.from({ length: 20 }, (_, index) => id(index));
const hash = "a".repeat(64);

describe("import plan mode selection", () => {
  it("keeps full project modes complete", () => {
    const source = sourceBundle();
    const registry = selectionRegistry();
    for (const mode of ["as_new_project", "replace_existing"] as const) {
      const selected = selectImportBundle({
        request: request(mode),
        source,
        registry,
      });
      expect(selected.documents).toHaveLength(source.documents.length);
    }
  });

  it("closes characters-only to the selected library graph", () => {
    const source = sourceBundle();
    const selected = selectImportBundle({
      request: {
        ...request("characters_only"),
        selectedCharacterIds: [ids[3]],
      },
      source,
      registry: selectionRegistry(),
    });
    const keys = selected.documents.map(
      (item) => `${item.collection}:${item.id}`,
    );

    expect(keys).toEqual(
      expect.arrayContaining([
        `customers:${ids[0]}`,
        `families:${ids[1]}`,
        `characters:${ids[3]}`,
        `character_versions:${ids[5]}`,
        `looks:${ids[7]}`,
        `look_versions:${ids[8]}`,
        `reference_photos:${ids[9]}`,
      ]),
    );
    expect(keys.some((key) => key.startsWith("projects:"))).toBe(false);
    expect(keys).not.toContain(`characters:${ids[4]}`);
    const family = selected.documents.find(
      (item) => item.collection === "families",
    )!.document;
    expect(
      sanitizeSelectedImportDocument(
        "characters_only",
        new Set(keys),
        "families",
        family,
      ),
    ).toMatchObject({ anchorCharacterId: null });
  });

  it("closes templates-only to selected identities and versions", () => {
    const selected = selectImportBundle({
      request: {
        ...request("templates_only"),
        customerResolution: null,
        selectedTemplateIds: [ids[10]],
        templateCatalogRevisionHash: hash,
      },
      source: sourceBundle(),
      registry: selectionRegistry(),
    });

    expect(
      selected.documents.map((item) => `${item.collection}:${item.id}`),
    ).toEqual([
      `story_templates:${ids[10]}`,
      `story_template_versions:${ids[11]}`,
    ]);
    expect(selected.media).toEqual([]);
  });
});

const schema = z
  .object({
    id: z.string(),
    schemaVersion: z.literal(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .passthrough() as z.ZodType<BaseDocument>;

function selectionRegistry() {
  const definitions = [
    ["customers", []],
    ["families", ["customers"]],
    ["characters", ["families"]],
    ["character_versions", ["characters"]],
    ["looks", ["characters"]],
    ["look_versions", ["looks"]],
    ["reference_photos", ["families", "characters"]],
  ] as const;
  return createPortabilityRegistry(
    definitions.map(([key, dependencies]) =>
      definePortabilityParticipant({
        key,
        collection: key,
        currentSchemaVersion: 1,
        schema,
        dependencies,
      }),
    ),
    {
      collections: definitions.map(([key]) => ({
        key,
        owner: "participant" as const,
      })),
      assetRoles: [],
      jobTypes: [],
      scopedWriters: [],
    },
  );
}

function sourceBundle() {
  const documents = [
    document("customers", ids[0], {}),
    document("families", ids[1], {
      customerId: ids[0],
      anchorCharacterId: ids[4],
    }),
    document("projects", ids[2], {
      customerId: ids[0],
      familyId: ids[1],
    }),
    document("characters", ids[3], { familyId: ids[1] }),
    document("characters", ids[4], { familyId: ids[1] }),
    document("character_versions", ids[5], { characterId: ids[3] }),
    document("character_versions", ids[6], { characterId: ids[4] }),
    document("looks", ids[7], { characterId: ids[3] }),
    document("look_versions", ids[8], { lookId: ids[7] }),
    document("reference_photos", ids[9], {
      owner: { type: "character", characterId: ids[3] },
    }),
    document("story_templates", ids[10], {}),
    document("story_template_versions", ids[11], {
      templateId: ids[10],
    }),
    document("story_templates", ids[12], {}),
    document("story_template_versions", ids[13], {
      templateId: ids[12],
    }),
  ];
  return {
    root: { projectId: ids[2], customerId: ids[0], familyId: ids[1] },
    documents,
    media: [],
    graphHash: hash,
    sourceSnapshotHash: hash,
    migratedDocumentCount: 0,
  };
}

function document(
  collection: string,
  documentId: string,
  fields: Record<string, unknown>,
) {
  const value = {
    id: documentId,
    schemaVersion: 1 as const,
    createdAt: at,
    updatedAt: at,
    ...fields,
  };
  return {
    collection,
    id: documentId,
    schemaVersion: 1,
    sourceSha256: hash,
    normalizedSha256: hash,
    migrationCount: 0,
    document: value,
  };
}

function request(
  mode:
    | "as_new_project"
    | "replace_existing"
    | "characters_only"
    | "templates_only",
) {
  return {
    idempotencyKey: `plan-${mode}`,
    expectedOperationRevision: 2,
    mode,
    sourceRoot: { projectId: ids[2], customerId: ids[0], familyId: ids[1] },
    customerResolution: { kind: "create_from_archive" as const },
    replaceTarget:
      mode === "replace_existing"
        ? {
            projectId: ids[14],
            projectRevision: 1,
            projectRevisionHash: hash,
            destructiveScopeConfirmed: true,
          }
        : null,
    selectedCharacterIds: [],
    selectedTemplateIds: [],
    templateCatalogRevisionHash: null,
    explicitMappings: [],
    approvalPolicy: "demote" as const,
  };
}

function id(value: number): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return `01K80000000000000000000000`
    .slice(0, 24)
    .concat(alphabet[Math.floor(value / 32)], alphabet[value % 32]);
}

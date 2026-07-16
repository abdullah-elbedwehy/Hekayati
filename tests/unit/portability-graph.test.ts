import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createPortabilityRegistry,
  definePortabilityParticipant,
  type PortabilityCatalog,
} from "../../src/domain/portability/participants.js";
import {
  selectPortabilityGraph,
  type PortabilityStoredDocument,
} from "../../src/domain/portability/graph.js";

const documentBase = {
  id: z.string().min(1),
  schemaVersion: z.literal(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};
const customerSchema = z.object({ ...documentBase }).strict();
const projectSchema = z
  .object({
    ...documentBase,
    customerId: z.string(),
    familyId: z.string(),
    currentVersionId: z.string(),
  })
  .strict();
const versionSchema = z
  .object({
    ...documentBase,
    projectId: z.string(),
    previousVersionId: z.string().nullable(),
    artworkAssetIds: z.array(z.string()),
    originalAssetIds: z.array(z.string()),
  })
  .strict();
const assetSchema = z.object({ ...documentBase, sha256: z.string() }).strict();
const customerOnlySchema = z
  .object({ ...documentBase, projectId: z.string(), customerId: z.string() })
  .strict();
const at = "2026-07-16T00:00:00.000Z";

describe("portability graph selection", () => {
  it("selects a deterministic closure, reasons, and occurrence-preserving media multiset", () => {
    const registry = graphRegistry();
    const documents = graphDocuments();
    const result = selectPortabilityGraph({
      registry,
      documents,
      root: {
        kind: "project",
        projectId: "project-a",
        customerId: "customer-a",
        familyId: "family-a",
      },
    });

    expect(
      result.documents.map((item) => `${item.collection}:${item.id}`),
    ).toEqual([
      "assets:asset-a",
      "customers:customer-a",
      "original_assets:original-a",
      "project_versions:version-a",
      "projects:project-a",
    ]);
    expect(result.mediaReferences.map((item) => item.id)).toEqual([
      "asset-a",
      "asset-a",
      "original-a",
    ]);
    expect(result.media).toEqual([
      {
        namespace: "asset",
        id: "asset-a",
        occurrenceCount: 2,
        ownedCount: 1,
        referencedCount: 1,
        outsideScopeOccurrenceCount: 1,
      },
      {
        namespace: "original",
        id: "original-a",
        occurrenceCount: 1,
        ownedCount: 1,
        referencedCount: 0,
        outsideScopeOccurrenceCount: 0,
      },
    ]);
    expect(
      result.documents.find((item) => item.id === "version-a")?.reasons,
    ).toEqual(["edge:projects:project-a#currentVersionId", "owned_version"]);
    expect(
      result.documents.find((item) => item.id === "project-a")?.reasons,
    ).toEqual(["edge:project_versions:version-a#projectId", "project_root"]);
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result.media)).not.toContain("project-b");
    expect(
      selectPortabilityGraph({
        registry,
        documents: [...documents].reverse(),
        root: {
          kind: "project",
          projectId: "project-a",
          customerId: "customer-a",
          familyId: "family-a",
        },
      }).hash,
    ).toBe(result.hash);
  });

  it("honors export modes without losing participant selector reasons", () => {
    const registry = graphRegistry();
    const documents = graphDocuments();
    const project = selectPortabilityGraph({
      registry,
      documents,
      root: {
        kind: "project",
        projectId: "project-a",
        customerId: "customer-a",
        familyId: "family-a",
      },
    });
    const customer = selectPortabilityGraph({
      registry,
      documents,
      root: { kind: "customer", customerId: "customer-a" },
    });

    expect(
      project.documents.some(
        (item) => item.collection === "customer_only_records",
      ),
    ).toBe(false);
    expect(
      customer.documents.find(
        (item) => item.collection === "customer_only_records",
      )?.reasons,
    ).toEqual(["customer_archive_history"]);
  });

  it("fails on missing document/media closure and a reachable second project root", () => {
    const registry = graphRegistry();
    const documents = graphDocuments();

    expect(() =>
      selectPortabilityGraph({
        registry,
        documents: documents.filter(
          (item) => (item.document as Record<string, unknown>).id !== "asset-a",
        ),
        root: {
          kind: "project",
          projectId: "project-a",
          customerId: "customer-a",
          familyId: "family-a",
        },
      }),
    ).toThrowError("PORTABILITY_MEDIA_REFERENCE_MISSING:asset:asset-a");

    const crossRoot = documents.map((item) =>
      (item.document as Record<string, unknown>).id === "version-a"
        ? {
            ...item,
            document: {
              ...(item.document as Record<string, unknown>),
              projectId: "project-b",
            },
          }
        : item,
    );
    expect(() =>
      selectPortabilityGraph({
        registry,
        documents: crossRoot,
        root: {
          kind: "project",
          projectId: "project-a",
          customerId: "customer-a",
          familyId: "family-a",
        },
      }),
    ).toThrowError("PORTABILITY_SECOND_PROJECT_REACHABLE:project-b");
  });

  it("rejects duplicate stored identities and unregistered collections", () => {
    const registry = graphRegistry();
    const documents = graphDocuments();

    expect(() =>
      selectPortabilityGraph({
        registry,
        documents: [...documents, documents[0]],
        root: {
          kind: "customer",
          customerId: "customer-a",
        },
      }),
    ).toThrowError("PORTABILITY_DOCUMENT_DUPLICATE");
    expect(() =>
      selectPortabilityGraph({
        registry,
        documents: [
          ...documents,
          stored("unknown", { id: "unknown-a", schemaVersion: 1 }),
        ],
        root: {
          kind: "customer",
          customerId: "customer-a",
        },
      }),
    ).toThrowError("PORTABILITY_COLLECTION_UNREGISTERED:unknown");
  });
});

function graphRegistry() {
  const catalog: PortabilityCatalog = {
    collections: [
      "customers",
      "projects",
      "project_versions",
      "assets",
      "original_assets",
      "customer_only_records",
    ].map((key) => ({ key, owner: "participant" })),
    assetRoles: [],
    jobTypes: [],
    scopedWriters: [],
  };
  return createPortabilityRegistry(
    [
      definePortabilityParticipant({
        key: "customers",
        collection: "customers",
        currentSchemaVersion: 1,
        schema: customerSchema,
        selectForProject: (document, root) =>
          document.id === root.customerId ? "owning_customer" : null,
        selectForCustomer: (document, root) =>
          document.id === root.customerId ? "customer_root" : null,
      }),
      definePortabilityParticipant({
        key: "projects",
        collection: "projects",
        currentSchemaVersion: 1,
        schema: projectSchema,
        dependencies: ["customers"],
        selectForProject: (document, root) =>
          document.id === root.projectId ? "project_root" : null,
        selectForCustomer: (document, root) =>
          document.customerId === root.customerId ? "owned_project" : null,
        references: (document) => [
          {
            collection: "customers",
            id: document.customerId,
            field: "customerId",
          },
          {
            collection: "project_versions",
            id: document.currentVersionId,
            field: "currentVersionId",
          },
        ],
      }),
      definePortabilityParticipant({
        key: "project_versions",
        collection: "project_versions",
        currentSchemaVersion: 1,
        schema: versionSchema,
        dependencies: ["projects"],
        selectForProject: (document, root) =>
          document.projectId === root.projectId ? "owned_version" : null,
        ownerReferences: (document) => [
          {
            collection: "projects",
            id: document.projectId,
            field: "projectId",
          },
        ],
        references: (document) =>
          document.previousVersionId
            ? [
                {
                  collection: "project_versions",
                  id: document.previousVersionId,
                  field: "previousVersionId",
                },
              ]
            : [],
        assetReferences: (document) =>
          document.artworkAssetIds.map((id, index) => ({
            id,
            field: `artworkAssetIds.${index}`,
            ownership:
              index === 0 ? ("owned" as const) : ("referenced" as const),
          })),
        originalReferences: (document) =>
          document.originalAssetIds.map((id, index) => ({
            id,
            field: `originalAssetIds.${index}`,
            ownership: "owned" as const,
          })),
      }),
      definePortabilityParticipant({
        key: "assets",
        collection: "assets",
        currentSchemaVersion: 1,
        schema: assetSchema,
      }),
      definePortabilityParticipant({
        key: "original_assets",
        collection: "original_assets",
        currentSchemaVersion: 1,
        schema: assetSchema,
      }),
      definePortabilityParticipant({
        key: "customer_only_records",
        collection: "customer_only_records",
        currentSchemaVersion: 1,
        schema: customerOnlySchema,
        exportModes: ["customer"],
        selectForProject: (document, root) =>
          document.projectId === root.projectId
            ? "prior_project_archive"
            : null,
        selectForCustomer: (document, root) =>
          document.customerId === root.customerId
            ? "customer_archive_history"
            : null,
      }),
    ],
    catalog,
  );
}

function graphDocuments(): PortabilityStoredDocument[] {
  return [
    stored("projects", {
      id: "project-a",
      customerId: "customer-a",
      familyId: "family-a",
      currentVersionId: "version-a",
    }),
    stored("project_versions", {
      id: "version-a",
      projectId: "project-a",
      previousVersionId: null,
      artworkAssetIds: ["asset-a", "asset-a"],
      originalAssetIds: ["original-a"],
    }),
    stored("customers", { id: "customer-a" }),
    stored("assets", { id: "asset-a", sha256: "a".repeat(64) }),
    stored("original_assets", {
      id: "original-a",
      sha256: "b".repeat(64),
    }),
    stored("customer_only_records", {
      id: "archive-a",
      projectId: "project-a",
      customerId: "customer-a",
    }),
    stored("customers", { id: "customer-b" }),
    stored("projects", {
      id: "project-b",
      customerId: "customer-b",
      familyId: "family-b",
      currentVersionId: "version-b",
    }),
    stored("project_versions", {
      id: "version-b",
      projectId: "project-b",
      previousVersionId: null,
      artworkAssetIds: ["asset-a"],
      originalAssetIds: [],
    }),
  ];
}

function stored(
  collection: string,
  document: Record<string, unknown>,
): PortabilityStoredDocument {
  return {
    collection,
    document: {
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
      ...document,
    },
  };
}

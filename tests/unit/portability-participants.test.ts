import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { assetRecordSchema } from "../../src/assets/asset-store.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { createCreativeJobDefinitions } from "../../src/jobs/creative-definitions.js";
import { createLayoutJobDefinitions } from "../../src/jobs/layout-definitions.js";
import { createPrintProducerDefinitions } from "../../src/jobs/print-definitions.js";
import { createPrintPreflightDefinition } from "../../src/jobs/print-preflight-definition.js";
import { humanGateJobRegistration } from "../../src/jobs/registrations.js";
import { DOMAIN_MUTATION_WRITER_KEYS } from "../../src/domain/portability/domain-mutation-admission.js";
import {
  PARTICIPANT_ASSET_ROLES,
  PARTICIPANT_PROJECT_JOB_TYPES,
  REAL_PORTABILITY_CATALOG,
  createPortabilityRegistry,
  definePortabilityParticipant,
  extendPortabilityCatalog,
} from "../../src/domain/portability/participants.js";
import { realPortabilityParticipants } from "../../src/domain/portability/real-participants.js";
import { temporaryDirectory } from "../helpers/temp.js";

const at = "2026-07-16T00:00:00.000Z";
const testSchema = z
  .object({
    id: z.string().min(1),
    schemaVersion: z.literal(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

describe("portability participant registry", () => {
  it("freezes and hashes the complete real 003-009 catalogs", () => {
    const registry = createPortabilityRegistry(realPortabilityParticipants);

    expect(registry.participants).toHaveLength(59);
    expect(registry.catalog.collections).toHaveLength(70);
    expect(
      registry.catalog.collections.filter((entry) => entry.owner === "global"),
    ).toHaveLength(8);
    expect(
      registry.catalog.collections.filter(
        (entry) => entry.owner === "internal",
      ),
    ).toEqual([
      { key: "deletion_inventories", owner: "internal" },
      { key: "deletion_operations", owner: "internal" },
      { key: "deletion_reports", owner: "internal" },
    ]);
    expect(
      registry.catalog.assetRoles.filter(
        (entry) => entry.owner === "participant",
      ),
    ).toHaveLength(PARTICIPANT_ASSET_ROLES.length);
    expect(
      registry.catalog.assetRoles.find(
        (entry) => entry.key === "import_staging",
      )?.owner,
    ).toBe("internal");
    expect(
      registry.catalog.jobTypes.filter(
        (entry) => entry.owner === "participant",
      ),
    ).toHaveLength(PARTICIPANT_PROJECT_JOB_TYPES.length);
    expect(
      registry.catalog.scopedWriters.find(
        (entry) => entry.key === "layout.persistence-migration",
      )?.owner,
    ).toBe("internal");
    expect(registry.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(registry.participants)).toBe(true);
    expect(Object.isFrozen(registry.catalog.collections)).toBe(true);
    const order = new Map(
      registry.participants.map((item, index) => [item.key, index]),
    );
    for (const participant of registry.participants) {
      expect(participant.deletionOrder).toBe("reverse_dependencies");
      expect(participant.postDeleteVerification).toEqual({
        kind: "document_id_absent",
        collection: participant.collection,
      });
      expect(participant.verifyDeleted("inventoried-id")).toEqual({
        kind: "document_id_absent",
        collection: participant.collection,
        id: "inventoried-id",
      });
      for (const dependency of participant.dependencies)
        expect(order.get(dependency)).toBeLessThan(order.get(participant.key)!);
    }
    expect(
      createPortabilityRegistry([...realPortabilityParticipants].reverse())
        .hash,
    ).toBe(registry.hash);
  });

  it("registers operation ownership while excluding prior exports from project archives", () => {
    const registry = createPortabilityRegistry(realPortabilityParticipants);
    const operation = registry.forCollection("export_operations");
    const managed = registry.forCollection("managed_exports");
    const document = {
      id: "01J00000000000000000000000",
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
      projectId: "01J00000000000000000000001",
      customerId: "01J00000000000000000000002",
    } as never;
    const projectRoot = {
      kind: "project" as const,
      projectId: "01J00000000000000000000001",
      customerId: "01J00000000000000000000002",
      familyId: "01J00000000000000000000003",
    };
    const customerRoot = {
      kind: "customer" as const,
      customerId: "01J00000000000000000000002",
    };

    for (const participant of [operation, managed]) {
      expect(participant.projectIds(document)).toEqual([projectRoot.projectId]);
      expect(participant.customerIds(document)).toEqual([
        customerRoot.customerId,
      ]);
      expect(participant.selectForProject(document, projectRoot)).toBe(
        `owned_project:${projectRoot.projectId}`,
      );
      expect(participant.selectForCustomer(document, customerRoot)).toBe(
        `owned_customer:${customerRoot.customerId}`,
      );
      expect(participant.exportModes).toEqual(["customer"]);
    }
  });

  it("matches real schema, job-definition, and direct-writer inventories", async () => {
    const registry = createPortabilityRegistry(realPortabilityParticipants);
    const actualAssetRoles = registry.catalog.assetRoles.map((entry) => [
      entry.key,
      entry.owner,
    ]);
    expect(actualAssetRoles).toEqual(
      [...assetRecordSchema.shape.role.options]
        .sort()
        .map((role) => [
          role,
          role === "import_staging" ? "internal" : "participant",
        ]),
    );

    const temp = await temporaryDirectory("hekayati-portability-catalog-");
    const store = new DocumentStore(join(temp.path, "catalog.sqlite"));
    try {
      const definitions = [
        ...createCreativeJobDefinitions({} as never),
        ...createLayoutJobDefinitions({} as never),
        ...createPrintProducerDefinitions({} as never),
        createPrintPreflightDefinition({
          store,
          assets: {} as never,
          production: () => {
            throw new Error("NOT_CALLED");
          },
        }),
        humanGateJobRegistration("human_gate"),
      ];
      expect(
        definitions.map((definition) => definition.jobType).sort(),
      ).toEqual([...PARTICIPANT_PROJECT_JOB_TYPES].sort());
    } finally {
      store.close();
      await temp.cleanup();
    }

    const registeredDomainWriters = registry.catalog.scopedWriters
      .filter(
        (entry) =>
          entry.owner === "participant" &&
          !entry.key.startsWith("assets.") &&
          entry.key !== "jobs.job-record",
      )
      .map((entry) => entry.key)
      .sort();
    expect(registeredDomainWriters).toEqual(
      [...DOMAIN_MUTATION_WRITER_KEYS].sort(),
    );
    expect(
      registry.catalog.scopedWriters.filter(
        (entry) => entry.owner === "internal",
      ),
    ).toEqual([
      { key: "layout.persistence-migration", owner: "internal" },
      { key: "portability.deletion-storage", owner: "internal" },
    ]);
  });

  it("rejects duplicate keys, collections, and dependency cycles", () => {
    const first = syntheticParticipant("first", "synthetic_first", []);
    const duplicateKey = syntheticParticipant("first", "synthetic_second", []);
    const duplicateCollection = syntheticParticipant(
      "second",
      "synthetic_first",
      [],
    );
    const catalog = syntheticCatalog("synthetic_first", "synthetic_second");

    expect(() =>
      createPortabilityRegistry([first, duplicateKey], catalog),
    ).toThrowError("PORTABILITY_PARTICIPANT_KEY_DUPLICATE:first");
    expect(() =>
      createPortabilityRegistry([first, duplicateCollection], catalog),
    ).toThrowError(
      "PORTABILITY_PARTICIPANT_COLLECTION_DUPLICATE:synthetic_first",
    );

    const left = syntheticParticipant("left", "synthetic_first", ["right"]);
    const right = syntheticParticipant("right", "synthetic_second", ["left"]);
    expect(() =>
      createPortabilityRegistry([left, right], catalog),
    ).toThrowError("PORTABILITY_PARTICIPANT_CYCLE");
  });

  it("fails closed for omitted or unknown owned catalog entries", () => {
    const participant = syntheticParticipant("first", "synthetic_first", [], {
      assetRoles: ["synthetic_asset"],
      jobTypes: ["synthetic_job"],
      scopedWriters: ["synthetic.writer"],
    });
    const complete = syntheticCatalog("synthetic_first");

    expect(createPortabilityRegistry([participant], complete).hash).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(() => createPortabilityRegistry([], complete)).toThrowError(
      "PORTABILITY_COLLECTION_OMITTED:synthetic_first",
    );
    expect(() =>
      createPortabilityRegistry(
        [participant],
        extendPortabilityCatalog(complete, {
          collections: [{ key: "synthetic_extra", owner: "participant" }],
        }),
      ),
    ).toThrowError("PORTABILITY_COLLECTION_OMITTED:synthetic_extra");
    expect(() =>
      createPortabilityRegistry(
        [participant],
        extendPortabilityCatalog(complete, {
          assetRoles: [{ key: "synthetic_extra", owner: "participant" }],
        }),
      ),
    ).toThrowError("PORTABILITY_ASSET_ROLE_OMITTED:synthetic_extra");
    expect(() =>
      createPortabilityRegistry(
        [participant],
        extendPortabilityCatalog(complete, {
          scopedWriters: [
            { key: "synthetic.extra_writer", owner: "participant" },
          ],
        }),
      ),
    ).toThrowError("PORTABILITY_SCOPED_WRITER_OMITTED:synthetic.extra_writer");
  });

  it("supports a test-only 011 participant seam without weakening real catalogs", () => {
    const studio = syntheticParticipant(
      "studio_generations",
      "studio_generations",
      ["customers"],
      {
        jobTypes: ["studio_image"],
        scopedWriters: ["studio.repository"],
      },
    );
    const catalog = extendPortabilityCatalog(REAL_PORTABILITY_CATALOG, {
      collections: [{ key: "studio_generations", owner: "participant" }],
      jobTypes: [{ key: "studio_image", owner: "participant" }],
      scopedWriters: [{ key: "studio.repository", owner: "participant" }],
    });
    const registry = createPortabilityRegistry(
      [...realPortabilityParticipants, studio],
      catalog,
    );

    expect(registry.forCollection("studio_generations").key).toBe(
      "studio_generations",
    );
    expect(() =>
      createPortabilityRegistry(realPortabilityParticipants, catalog),
    ).toThrowError("PORTABILITY_COLLECTION_OMITTED:studio_generations");
  });

  it("keeps later import rewrite and rebase hooks explicitly fail-closed", () => {
    const participant = syntheticParticipant("first", "synthetic_first", [], {
      assetRoles: ["synthetic_asset"],
      jobTypes: ["synthetic_job"],
      scopedWriters: ["synthetic.writer"],
    });
    const document = testSchema.parse({
      id: "one",
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
    });

    expect(() => participant.rewriteIds(document, new Map())).toThrowError(
      "PORTABILITY_REWRITE_NOT_IMPLEMENTED:first",
    );
    expect(() =>
      participant.rebaseDerivedFields(document, new Map()),
    ).toThrowError("PORTABILITY_REBASE_NOT_IMPLEMENTED:first");
  });
});

function syntheticParticipant(
  key: string,
  collection: string,
  dependencies: readonly string[],
  claims: {
    assetRoles?: readonly string[];
    jobTypes?: readonly string[];
    scopedWriters?: readonly string[];
  } = {},
) {
  return definePortabilityParticipant({
    key,
    collection,
    currentSchemaVersion: 1,
    schema: testSchema,
    dependencies,
    claims,
  });
}

function syntheticCatalog(...collections: string[]) {
  return {
    collections: collections.map((key) => ({
      key,
      owner: "participant" as const,
    })),
    assetRoles: [{ key: "synthetic_asset", owner: "participant" as const }],
    jobTypes: [{ key: "synthetic_job", owner: "participant" as const }],
    scopedWriters: [{ key: "synthetic.writer", owner: "participant" as const }],
  };
}

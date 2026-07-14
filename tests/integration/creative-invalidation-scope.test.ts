import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { AuthoringRepositories } from "../../src/domain/authoring/repositories.js";
import { CreativeInvalidationService } from "../../src/domain/creative/invalidation.js";
import { CreativeRepositories } from "../../src/domain/creative/repositories.js";
import { LibraryRepositories } from "../../src/domain/library/repositories.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { temporaryDirectory } from "../helpers/temp.js";

const at = "2026-07-14T00:00:00.000Z";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("creative invalidation ownership and source routing", () => {
  it("rejects absent events and unresolved or ambiguous library ownership", async () => {
    const fixture = await harness();

    expectCreativeError(
      () => fixture.invalidation.consume(ulid()),
      "CREATIVE_ENTITY_NOT_FOUND",
      404,
    );

    const missingCharacter = append(fixture, "character", ulid());
    expectCreativeError(
      () =>
        fixture.invalidation.affectedItemsForFamily(
          fixture.ownerScope,
          missingCharacter.id,
        ),
      "CREATIVE_ENTITY_NOT_FOUND",
      404,
    );

    const missingFamilyCharacterId = ulid();
    fixture.library.characters.insert(
      {
        ...base(missingFamilyCharacterId),
        familyId: ulid(),
        status: "active",
        currentVersionId: ulid(),
      },
      "DUPLICATE_ENTITY_ID",
    );
    const missingFamily = append(
      fixture,
      "character",
      missingFamilyCharacterId,
    );
    expectCreativeError(
      () =>
        fixture.invalidation.affectedItemsForFamily(
          fixture.ownerScope,
          missingFamily.id,
        ),
      "CREATIVE_ENTITY_NOT_FOUND",
      404,
    );

    const missingLook = append(fixture, "look", ulid());
    expectCreativeError(
      () =>
        fixture.invalidation.affectedItemsForFamily(
          fixture.ownerScope,
          missingLook.id,
        ),
      "CREATIVE_ENTITY_NOT_FOUND",
      404,
    );

    const missingVisibility = append(
      fixture,
      "library_visibility",
      ulid(),
      "IM-21",
    );
    expectCreativeError(
      () =>
        fixture.invalidation.affectedItemsForFamily(
          fixture.ownerScope,
          missingVisibility.id,
        ),
      "CREATIVE_ENTITY_NOT_FOUND",
      404,
    );

    const ambiguousId = ulid();
    fixture.library.characters.insert(
      {
        ...base(ambiguousId),
        familyId: fixture.ownerScope.familyId,
        status: "active",
        currentVersionId: ulid(),
      },
      "DUPLICATE_ENTITY_ID",
    );
    fixture.library.looks.insert(
      {
        ...base(ambiguousId),
        characterId: fixture.characterId,
        status: "active",
        currentVersionId: ulid(),
      },
      "DUPLICATE_ENTITY_ID",
    );
    const ambiguousVisibility = append(
      fixture,
      "library_visibility",
      ambiguousId,
      "IM-21",
    );
    expectCreativeError(
      () =>
        fixture.invalidation.affectedItemsForFamily(
          fixture.ownerScope,
          ambiguousVisibility.id,
        ),
      "CREATIVE_INVALIDATION_CONFLICT",
      409,
    );

    const noProjectSource = append(fixture, "template", ulid());
    expectCreativeError(
      () =>
        fixture.invalidation.affectedItemsForFamily(
          fixture.ownerScope,
          noProjectSource.id,
        ),
      "CREATIVE_SCOPE_MISMATCH",
      403,
    );
    expect(fixture.library.invalidationReceipts.list()).toHaveLength(0);
    fixture.close();
  });

  it("enforces both customer and family dimensions for character and look events", async () => {
    const fixture = await harness();
    const characterEvent = append(
      fixture,
      "character",
      fixture.characterId,
      "IM-02",
    );

    expectCreativeError(
      () =>
        fixture.invalidation.affectedItemsForFamily(
          {
            customerId: fixture.foreignScope.customerId,
            familyId: fixture.ownerScope.familyId,
          },
          characterEvent.id,
        ),
      "CREATIVE_SCOPE_MISMATCH",
      403,
    );
    expectCreativeError(
      () =>
        fixture.invalidation.affectedItemsForFamily(
          {
            customerId: fixture.ownerScope.customerId,
            familyId: fixture.foreignScope.familyId,
          },
          characterEvent.id,
        ),
      "CREATIVE_SCOPE_MISMATCH",
      403,
    );
    expect(
      fixture.invalidation.affectedItemsForFamily(
        fixture.ownerScope,
        characterEvent.id,
      ).affected,
    ).toEqual([]);

    const lookEvent = append(fixture, "look", fixture.lookId, "IM-16");
    expect(
      fixture.invalidation.affectedItemsForFamily(
        fixture.ownerScope,
        lookEvent.id,
      ).affected,
    ).toEqual([]);

    const characterVisibility = append(
      fixture,
      "library_visibility",
      fixture.characterId,
      "IM-21",
    );
    const lookVisibility = append(
      fixture,
      "library_visibility",
      fixture.lookId,
      "IM-21",
    );
    expect(
      fixture.invalidation.affectedItemsForFamily(
        fixture.ownerScope,
        characterVisibility.id,
      ).affected,
    ).toEqual([]);
    expect(
      fixture.invalidation.affectedItemsForFamily(
        fixture.ownerScope,
        lookVisibility.id,
      ).affected,
    ).toEqual([]);
    expect(fixture.library.invalidationReceipts.list()).toHaveLength(4);
    fixture.close();
  });

  it("resolves project ownership through every persisted source entity", async () => {
    const fixture = await harness();
    const projectOverrideId = ulid();
    const sceneId = ulid();
    const storyId = ulid();
    const pageId = ulid();
    const illustrationId = ulid();

    fixture.authoring.projectOverrides.insert({
      ...base(projectOverrideId),
      projectId: fixture.projectId,
      characterId: fixture.characterId,
      currentVersionId: ulid(),
      status: "active",
    });
    fixture.authoring.scenes.insert({
      ...base(sceneId),
      projectId: fixture.projectId,
      storyPageIndex: 1,
      currentVersionId: ulid(),
    });
    fixture.authoring.stories.insert({
      ...base(storyId),
      projectId: fixture.projectId,
      status: "draft",
      currentVersionId: ulid(),
    });
    fixture.creative.pages.insert({
      ...base(pageId),
      revision: 0,
      projectId: fixture.projectId,
      pageNumber: 3,
      storyPageIndex: 1,
      kind: "story",
      locked: false,
      reviewStatus: "unreviewed",
      staleState: "current",
      staleReasons: [],
      currentTextVersionId: null,
      currentPromptVersionId: null,
      currentIllustrationVersionId: null,
      currentLayoutVersionId: null,
    });
    fixture.creative.illustrations.insert(illustration(illustrationId, pageId));

    const routedEvents = [
      append(fixture, "project_override", projectOverrideId),
      append(fixture, "internal", fixture.projectId),
      append(fixture, "scene", sceneId),
      append(fixture, "story", storyId),
      append(fixture, "narrative_text", pageId),
      append(fixture, "illustration", illustrationId),
    ];
    for (const event of routedEvents) {
      const result = fixture.invalidation.affectedItemsForFamily(
        fixture.ownerScope,
        event.id,
      );
      expect(result.affected).toEqual([]);
      expect(result.audit.eventId).toBe(event.id);
    }

    const missingOverride = append(fixture, "project_override", ulid());
    expectCreativeError(
      () =>
        fixture.invalidation.affectedItemsForFamily(
          fixture.ownerScope,
          missingOverride.id,
        ),
      "CREATIVE_ENTITY_NOT_FOUND",
      404,
    );

    const orphanOverrideId = ulid();
    fixture.authoring.projectOverrides.insert({
      ...base(orphanOverrideId),
      projectId: ulid(),
      characterId: fixture.characterId,
      currentVersionId: ulid(),
      status: "active",
    });
    const orphanOverride = append(
      fixture,
      "project_override",
      orphanOverrideId,
    );
    expectCreativeError(
      () =>
        fixture.invalidation.affectedItemsForFamily(
          fixture.ownerScope,
          orphanOverride.id,
        ),
      "CREATIVE_ENTITY_NOT_FOUND",
      404,
    );

    const foreignProject = append(
      fixture,
      "internal",
      fixture.foreignProjectId,
    );
    expectCreativeError(
      () =>
        fixture.invalidation.affectedItemsForFamily(
          fixture.ownerScope,
          foreignProject.id,
        ),
      "CREATIVE_SCOPE_MISMATCH",
      403,
    );

    const orphanIllustrationId = ulid();
    fixture.creative.illustrations.insert(
      illustration(orphanIllustrationId, ulid()),
    );
    const orphanIllustration = append(
      fixture,
      "illustration",
      orphanIllustrationId,
    );
    expectCreativeError(
      () =>
        fixture.invalidation.affectedItemsForFamily(
          fixture.ownerScope,
          orphanIllustration.id,
        ),
      "CREATIVE_SCOPE_MISMATCH",
      403,
    );
    fixture.close();
  });
});

async function harness() {
  const temp = await temporaryDirectory("hekayati-invalidation-scope-");
  cleanups.push(temp.cleanup);
  const store = new DocumentStore(join(temp.path, "creative.db"));
  const library = new LibraryRepositories(store);
  const authoring = new AuthoringRepositories(store);
  const creative = new CreativeRepositories(store);
  const ownerScope = { customerId: ulid(), familyId: ulid() };
  const foreignScope = { customerId: ulid(), familyId: ulid() };
  const characterId = ulid();
  const foreignCharacterId = ulid();
  const lookId = ulid();
  const projectId = ulid();
  const foreignProjectId = ulid();

  seedLibraryFamily(library, ownerScope, characterId, "مالك");
  seedLibraryFamily(library, foreignScope, foreignCharacterId, "أجنبي");
  library.looks.insert(
    {
      ...base(lookId),
      characterId,
      status: "active",
      currentVersionId: ulid(),
    },
    "DUPLICATE_ENTITY_ID",
  );
  authoring.projects.insert(project(projectId, ownerScope));
  authoring.projects.insert(project(foreignProjectId, foreignScope));

  return {
    store,
    library,
    authoring,
    creative,
    invalidation: new CreativeInvalidationService(store, { now: () => at }),
    ownerScope,
    foreignScope,
    characterId,
    lookId,
    projectId,
    foreignProjectId,
    close: () => store.close(),
  };
}

type Fixture = Awaited<ReturnType<typeof harness>>;
type Entity = Parameters<
  CreativeInvalidationService["appendEvent"]
>[0]["entity"];
type MatrixRow = Parameters<
  CreativeInvalidationService["appendEvent"]
>[0]["matrixRow"];

function append(
  fixture: Fixture,
  entity: Entity,
  entityId: string,
  matrixRow: MatrixRow = "IM-16",
) {
  return fixture.invalidation.appendEvent({
    id: ulid(),
    entity,
    entityId,
    fromVersionId: null,
    toVersionId: null,
    changeType: "internal_only",
    matrixRow,
    changedFields: ["synthetic"],
    correlationId: ulid(),
  });
}

function seedLibraryFamily(
  repositories: LibraryRepositories,
  scope: { customerId: string; familyId: string },
  characterId: string,
  name: string,
): void {
  repositories.customers.insert(
    {
      ...base(scope.customerId),
      name,
      whatsapp: "",
      notes: "synthetic",
      consent: null,
      status: "active",
    },
    "DUPLICATE_ENTITY_ID",
  );
  repositories.families.insert(
    {
      ...base(scope.familyId),
      customerId: scope.customerId,
      name: `عائلة ${name}`,
      anchorCharacterId: characterId,
      status: "active",
    },
    "DUPLICATE_ENTITY_ID",
  );
  repositories.characters.insert(
    {
      ...base(characterId),
      familyId: scope.familyId,
      status: "active",
      currentVersionId: ulid(),
    },
    "DUPLICATE_ENTITY_ID",
  );
}

function project(id: string, scope: { customerId: string; familyId: string }) {
  return {
    ...base(id),
    customerId: scope.customerId,
    familyId: scope.familyId,
    status: "internal_review" as const,
    priority: 0,
    paused: false,
    currentVersionId: ulid(),
    bookVersion: 1,
    printerProfileId: null,
  };
}

function illustration(id: string, pageId: string) {
  return {
    ...base(id),
    pageId,
    previousVersionId: null,
    assetId: ulid(),
    promptVersionId: ulid(),
    inputSnapshot: {},
    provenance: {
      provider: "mock" as const,
      modelId: "mock-image-v1",
      at,
      inputVersionRefs: {},
      promptVersion: "mock-v1",
      referenceAssetIds: [],
      attempt: 1,
      settingsSnapshotHash: "f".repeat(64),
    },
  };
}

function base(id: string) {
  return {
    id,
    schemaVersion: 1 as const,
    createdAt: at,
    updatedAt: at,
  };
}

function expectCreativeError(
  operation: () => unknown,
  code: string,
  statusCode: number,
): void {
  expect(operation).toThrowError(expect.objectContaining({ code, statusCode }));
}

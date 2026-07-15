import { ulid } from "ulid";

import { AuthoringService, type Project } from "../authoring/index.js";
import { LibraryService } from "../library/index.js";
import type { DocumentStore } from "../repository/document-store.js";
import { failCreative } from "./errors.js";
import { CreativeInvalidationService } from "./invalidation.js";
import type { Page, PageTextVersion } from "./schemas.js";

interface PageChangeCoordinatorOptions {
  now?: () => string;
  idFactory?: () => string;
  invalidation?: CreativeInvalidationService;
}

export class PageChangeCoordinator {
  private readonly authoring: AuthoringService;
  private readonly invalidation: CreativeInvalidationService;
  private readonly idFactory: () => string;

  constructor(
    store: DocumentStore,
    options: PageChangeCoordinatorOptions = {},
  ) {
    this.authoring = new AuthoringService(
      store,
      new LibraryService(store, options),
      { ...options, changeEventMode: "suppress" },
    );
    this.invalidation =
      options.invalidation ?? new CreativeInvalidationService(store, options);
    this.idFactory = options.idFactory ?? ulid;
  }

  appendAuthoringNarrative(
    page: Page,
    current: PageTextVersion,
    project: Project,
    input: {
      narrative: string;
      dialogue: Array<{ speakerCharacterId: string; text: string }>;
    },
  ): string {
    if (page.storyPageIndex === null) failCreative("CREATIVE_VERSION_CONFLICT");
    const scope = {
      customerId: project.customerId,
      familyId: project.familyId,
    };
    const workspace = this.authoring.getProjectWorkspace(scope, project.id);
    const scene = workspace.scenes.find(
      (item) => item.scene.storyPageIndex === page.storyPageIndex,
    );
    if (!scene || scene.version.id !== current.sceneVersionId)
      failCreative("CREATIVE_VERSION_CONFLICT");
    const updated = this.authoring.updateScene(
      scope,
      project.id,
      page.storyPageIndex,
      {
        expectedStoryVersionId: workspace.storyVersion.id,
        expectedSceneVersionId: scene.version.id,
        content: {
          ...scene.version.content,
          narrativeText: input.narrative,
          dialogue: input.dialogue,
        },
      },
    );
    const version = updated.scenes.find(
      (item) => item.scene.storyPageIndex === page.storyPageIndex,
    )?.version;
    if (!version) failCreative("CREATIVE_VERSION_CONFLICT");
    return version.id;
  }

  record(input: {
    page: Page;
    entity: "illustration" | "narrative_text" | "layout";
    matrixRow: "IM-07" | "IM-10" | "IM-11";
    changeType:
      "narrative_text" | "illustration_regeneration" | "layout_recalculation";
    fromVersionId: string | null;
    toVersionId: string;
    changedFields: string[];
  }): void {
    const eventId = this.idFactory();
    this.invalidation.recordAndConsume({
      id: eventId,
      entity: input.entity,
      entityId: input.page.id,
      fromVersionId: input.fromVersionId,
      toVersionId: input.toVersionId,
      changeType: input.changeType,
      matrixRow: input.matrixRow,
      changedFields: input.changedFields,
      correlationId: eventId,
    });
  }
}

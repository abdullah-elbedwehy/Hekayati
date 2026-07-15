import { ulid } from "ulid";

import { getBookPageMap } from "../authoring/book-structure.js";
import { AuthoringRepositories } from "../authoring/repositories.js";
import type { PageCount } from "../authoring/schemas.js";
import type { DocumentStore } from "../repository/document-store.js";
import type { NeutralProvenance as Provenance } from "../../contracts/creative-generation.js";
import type { PagePrompt } from "./output-types.js";
import { failCreative } from "./errors.js";
import { CreativeRepositories } from "./repositories.js";
import {
  illustrationVersionSchema,
  layoutWorkRequestSchema,
  pagePromptVersionSchema,
  pageReviewSchema,
  pageSchema,
  pageTextVersionSchema,
  type IllustrationVersion,
  type LayoutWorkRequest,
  type MatrixRow,
  type Page,
  type PageReview,
  type PageTextVersion,
} from "./schemas.js";
import type { z } from "zod";
import type { reviewChecksSchema } from "./schemas.js";
import { PageChangeCoordinator } from "./page-change-coordinator.js";
import type { CreativeInvalidationService } from "./invalidation.js";

export interface CreativePageServiceOptions {
  now?: () => string;
  idFactory?: () => string;
  invalidation?: CreativeInvalidationService;
}

export interface SeedGeneratedPageInput {
  pageId: string;
  expectedRevision: number;
  sceneVersionId: string;
  narrative: string;
  prompt: z.input<typeof pagePromptVersionSchema>["output"];
  illustrationAssetId: string;
  provenance: Provenance;
}

interface SeedGeneratedPageResult {
  page: Page;
  text: PageTextVersion;
  promptVersionId: string;
  illustration: IllustrationVersion;
}

export class CreativePageService {
  private readonly repositories: CreativeRepositories;
  private readonly authoring: AuthoringRepositories;
  private readonly changes: PageChangeCoordinator;
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(
    private readonly store: DocumentStore,
    options: CreativePageServiceOptions = {},
  ) {
    this.repositories = new CreativeRepositories(store);
    this.authoring = new AuthoringRepositories(store);
    this.changes = new PageChangeCoordinator(store, options);
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ulid;
  }

  ensureProjectPages(projectId: string, pageCount: PageCount): Page[] {
    return this.store.transaction(() => {
      this.requireProject(projectId);
      const existing = this.listProjectPages(projectId);
      const map = getBookPageMap(pageCount);
      if (existing.length > 0) {
        if (
          existing.length !== map.length ||
          existing.some(
            (page, index) =>
              page.pageNumber !== map[index]?.pageNumber ||
              page.kind !== pageKind(map[index].kind),
          )
        )
          failCreative("CREATIVE_VERSION_CONFLICT");
        return existing;
      }
      const at = this.now();
      return map.map((entry) =>
        this.repositories.pages.insert(
          pageSchema.parse({
            id: this.idFactory(),
            schemaVersion: 2,
            createdAt: at,
            updatedAt: at,
            revision: 0,
            projectId,
            pageNumber: entry.pageNumber,
            storyPageIndex:
              entry.kind === "story" ? entry.storyPageIndex : null,
            kind: pageKind(entry.kind),
            locked: false,
            reviewStatus: "unreviewed",
            staleState: "current",
            staleReasons: [],
            currentTextVersionId: null,
            currentPromptVersionId: null,
            currentIllustrationVersionId: null,
          }),
        ),
      );
    });
  }

  listProjectPages(projectId: string): Page[] {
    return this.repositories.pages
      .queryByField("projectId", projectId)
      .sort((left, right) => left.pageNumber - right.pageNumber);
  }

  getPage(pageId: string): Page {
    return this.requirePage(pageId);
  }

  seedGeneratedPage(input: SeedGeneratedPageInput): SeedGeneratedPageResult {
    return this.store.transaction(() =>
      this.seedGeneratedPageInTransaction(input),
    );
  }

  private seedGeneratedPageInTransaction(
    input: SeedGeneratedPageInput,
  ): SeedGeneratedPageResult {
    const page = this.expectedMutableStoryPage(
      input.pageId,
      input.expectedRevision,
    );
    if (
      page.currentTextVersionId ||
      page.currentPromptVersionId ||
      page.currentIllustrationVersionId ||
      input.prompt.pageNumber !== page.storyPageIndex
    )
      failCreative("CREATIVE_VERSION_CONFLICT");
    const at = this.now();
    const text = this.insertSeedText(page, input, at);
    const prompt = this.insertSeedPrompt(page, input, at);
    const illustration = this.insertSeedIllustration(
      page,
      prompt.id,
      input,
      at,
    );
    const updated = this.updatePage(page, {
      currentTextVersionId: text.id,
      currentPromptVersionId: prompt.id,
      currentIllustrationVersionId: illustration.id,
      reviewStatus: "unreviewed",
      staleState: "current",
      staleReasons: [],
    });
    this.changes.record({
      page,
      entity: "illustration",
      matrixRow: "IM-10",
      changeType: "illustration_regeneration",
      fromVersionId: page.currentIllustrationVersionId,
      toVersionId: illustration.id,
      changedFields: ["currentIllustrationVersionId"],
    });
    return {
      page: this.requirePage(updated.id),
      text,
      promptVersionId: prompt.id,
      illustration,
    };
  }

  private insertSeedText(
    page: Page,
    input: SeedGeneratedPageInput,
    at: string,
  ): PageTextVersion {
    return this.repositories.pageTexts.insert(
      pageTextVersionSchema.parse({
        id: this.idFactory(),
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        pageId: page.id,
        previousVersionId: null,
        sceneVersionId: input.sceneVersionId,
        narrative: input.narrative,
        dialogue: [],
        source: "generated",
        inputSnapshot: { sceneVersion: input.sceneVersionId },
      }),
    );
  }

  private insertSeedPrompt(
    page: Page,
    input: SeedGeneratedPageInput,
    at: string,
  ) {
    return this.repositories.pagePrompts.insert(
      pagePromptVersionSchema.parse({
        id: this.idFactory(),
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        pageId: page.id,
        previousVersionId: null,
        sceneVersionId: input.sceneVersionId,
        output: input.prompt,
        styleId: "modern_cartoon",
        jobId: this.idFactory(),
        provenance: input.provenance,
      }),
    );
  }

  private insertSeedIllustration(
    page: Page,
    promptVersionId: string,
    input: SeedGeneratedPageInput,
    at: string,
  ): IllustrationVersion {
    return this.repositories.illustrations.insert(
      illustrationVersionSchema.parse({
        id: this.idFactory(),
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        pageId: page.id,
        previousVersionId: null,
        assetId: input.illustrationAssetId,
        promptVersionId,
        inputSnapshot: {
          sceneVersion: input.sceneVersionId,
          promptVersion: promptVersionId,
        },
        provenance: input.provenance,
      }),
    );
  }

  appendIllustration(input: {
    pageId: string;
    expectedRevision: number;
    promptVersionId: string;
    assetId: string;
    inputSnapshot: Record<string, string>;
    provenance: Provenance;
  }): { page: Page; illustration: IllustrationVersion } {
    return this.store.transaction(() => {
      const page = this.expectedMutableStoryPage(
        input.pageId,
        input.expectedRevision,
      );
      if (page.currentPromptVersionId !== input.promptVersionId)
        failCreative("CREATIVE_VERSION_CONFLICT");
      const at = this.now();
      const illustration = this.repositories.illustrations.insert(
        illustrationVersionSchema.parse({
          id: this.idFactory(),
          schemaVersion: 1,
          createdAt: at,
          updatedAt: at,
          pageId: page.id,
          previousVersionId: page.currentIllustrationVersionId,
          assetId: input.assetId,
          promptVersionId: input.promptVersionId,
          inputSnapshot: input.inputSnapshot,
          provenance: input.provenance,
        }),
      );
      const updated = this.updatePage(page, {
        currentIllustrationVersionId: illustration.id,
        reviewStatus: "unreviewed",
      });
      this.changes.record({
        page,
        entity: "illustration",
        matrixRow: "IM-10",
        changeType: "illustration_regeneration",
        fromVersionId: page.currentIllustrationVersionId,
        toVersionId: illustration.id,
        changedFields: ["currentIllustrationVersionId"],
      });
      return { page: this.requirePage(updated.id), illustration };
    });
  }

  appendGeneratedText(input: {
    pageId: string;
    expectedRevision: number;
    sceneVersionId: string;
    narrative: string;
    dialogue: Array<{ speakerCharacterId: string; text: string }>;
    inputSnapshot: Record<string, string>;
  }): { page: Page; text: PageTextVersion } {
    return this.store.transaction(() => {
      const page = this.expectedMutableStoryPage(
        input.pageId,
        input.expectedRevision,
      );
      const at = this.now();
      const text = this.repositories.pageTexts.insert(
        pageTextVersionSchema.parse({
          id: this.idFactory(),
          schemaVersion: 1,
          createdAt: at,
          updatedAt: at,
          pageId: page.id,
          previousVersionId: page.currentTextVersionId,
          sceneVersionId: input.sceneVersionId,
          narrative: input.narrative,
          dialogue: input.dialogue,
          source: "generated",
          inputSnapshot: input.inputSnapshot,
        }),
      );
      const updated = this.updatePage(page, {
        currentTextVersionId: text.id,
        reviewStatus: "unreviewed",
      });
      this.changes.record({
        page,
        entity: "narrative_text",
        matrixRow: "IM-07",
        changeType: "narrative_text",
        fromVersionId: page.currentTextVersionId,
        toVersionId: text.id,
        changedFields: ["narrative", "dialogue"],
      });
      return { page: this.requirePage(updated.id), text };
    });
  }

  appendPrompt(input: {
    pageId: string;
    expectedRevision: number;
    sceneVersionId: string;
    output: PagePrompt;
    styleId: "modern_cartoon" | "colorful_2d" | "soft_watercolor";
    jobId: string;
    provenance: Provenance;
  }): { page: Page; promptVersionId: string } {
    return this.store.transaction(() => {
      const page = this.expectedMutableStoryPage(
        input.pageId,
        input.expectedRevision,
      );
      if (
        page.storyPageIndex !== input.output.pageNumber ||
        !page.currentTextVersionId
      )
        failCreative("CREATIVE_VERSION_CONFLICT");
      const at = this.now();
      const prompt = this.repositories.pagePrompts.insert(
        pagePromptVersionSchema.parse({
          id: this.idFactory(),
          schemaVersion: 1,
          createdAt: at,
          updatedAt: at,
          pageId: page.id,
          previousVersionId: page.currentPromptVersionId,
          sceneVersionId: input.sceneVersionId,
          output: input.output,
          styleId: input.styleId,
          jobId: input.jobId,
          provenance: input.provenance,
        }),
      );
      return {
        page: this.updatePage(page, {
          currentPromptVersionId: prompt.id,
          reviewStatus: "unreviewed",
        }),
        promptVersionId: prompt.id,
      };
    });
  }

  getPromptVersion(id: string) {
    const prompt = this.repositories.pagePrompts.get(id);
    if (!prompt) failCreative("CREATIVE_ENTITY_NOT_FOUND", 404);
    return prompt;
  }

  getTextVersion(id: string) {
    const text = this.repositories.pageTexts.get(id);
    if (!text) failCreative("CREATIVE_ENTITY_NOT_FOUND", 404);
    return text;
  }

  getIllustrationVersion(id: string) {
    const illustration = this.repositories.illustrations.get(id);
    if (!illustration) failCreative("CREATIVE_ENTITY_NOT_FOUND", 404);
    return illustration;
  }

  appendManualText(input: {
    pageId: string;
    expectedRevision: number;
    narrative: string;
    dialogue: Array<{ speakerCharacterId: string; text: string }>;
  }): { page: Page; text: PageTextVersion } {
    return this.store.transaction(() => {
      const page = this.expectedMutableStoryPage(
        input.pageId,
        input.expectedRevision,
      );
      if (!page.currentTextVersionId)
        failCreative("CREATIVE_DEPENDENCY_INCOMPLETE");
      const current = this.getTextVersion(page.currentTextVersionId);
      const at = this.now();
      const sceneVersionId = this.changes.appendAuthoringNarrative(
        page,
        current,
        this.requireProject(page.projectId),
        {
          narrative: input.narrative,
          dialogue: input.dialogue,
        },
      );
      return this.commitTextVersion(
        page,
        {
          id: this.idFactory(),
          schemaVersion: 1,
          createdAt: at,
          updatedAt: at,
          pageId: page.id,
          previousVersionId: current.id,
          sceneVersionId,
          narrative: input.narrative,
          dialogue: input.dialogue,
          source: "manual",
          inputSnapshot: {
            previousText: current.id,
            sceneVersion: sceneVersionId,
          },
        },
        ["narrative", "dialogue"],
      );
    });
  }

  revertText(input: {
    pageId: string;
    expectedRevision: number;
    targetVersionId: string;
  }): { page: Page; text: PageTextVersion } {
    return this.store.transaction(() => {
      const page = this.expectedMutableStoryPage(
        input.pageId,
        input.expectedRevision,
      );
      const target = this.getTextVersion(input.targetVersionId);
      if (target.pageId !== page.id || !page.currentTextVersionId)
        failCreative("CREATIVE_VERSION_CONFLICT");
      const current = this.getTextVersion(page.currentTextVersionId);
      const at = this.now();
      const sceneVersionId = this.changes.appendAuthoringNarrative(
        page,
        current,
        this.requireProject(page.projectId),
        {
          narrative: target.narrative,
          dialogue: target.dialogue,
        },
      );
      return this.commitTextVersion(
        page,
        {
          ...target,
          id: this.idFactory(),
          createdAt: at,
          updatedAt: at,
          previousVersionId: page.currentTextVersionId,
          sceneVersionId,
          source: "revert",
          inputSnapshot: {
            revertSource: target.id,
            sceneVersion: sceneVersionId,
          },
        },
        ["currentTextVersionId"],
      );
    });
  }

  private commitTextVersion(
    page: Page,
    version: z.input<typeof pageTextVersionSchema>,
    changedFields: string[],
  ): { page: Page; text: PageTextVersion } {
    const text = this.repositories.pageTexts.insert(
      pageTextVersionSchema.parse(version),
    );
    const updated = this.updatePage(page, {
      currentTextVersionId: text.id,
      reviewStatus: "unreviewed",
    });
    this.changes.record({
      page,
      entity: "narrative_text",
      matrixRow: "IM-07",
      changeType: "narrative_text",
      fromVersionId: page.currentTextVersionId,
      toVersionId: text.id,
      changedFields,
    });
    return { page: this.requirePage(updated.id), text };
  }

  revertIllustration(input: {
    pageId: string;
    expectedRevision: number;
    targetVersionId: string;
  }): { page: Page; illustration: IllustrationVersion } {
    return this.store.transaction(() => {
      const page = this.expectedMutableStoryPage(
        input.pageId,
        input.expectedRevision,
      );
      const target = this.getIllustrationVersion(input.targetVersionId);
      if (target.pageId !== page.id) failCreative("CREATIVE_VERSION_CONFLICT");
      const at = this.now();
      const illustration = this.repositories.illustrations.insert(
        illustrationVersionSchema.parse({
          ...target,
          id: this.idFactory(),
          createdAt: at,
          updatedAt: at,
          previousVersionId: page.currentIllustrationVersionId,
          inputSnapshot: {
            ...target.inputSnapshot,
            revertSource: target.id,
          },
        }),
      );
      const updated = this.updatePage(page, {
        currentIllustrationVersionId: illustration.id,
        currentPromptVersionId: illustration.promptVersionId,
        reviewStatus: "unreviewed",
      });
      this.changes.record({
        page,
        entity: "illustration",
        matrixRow: "IM-10",
        changeType: "illustration_regeneration",
        fromVersionId: page.currentIllustrationVersionId,
        toVersionId: illustration.id,
        changedFields: ["currentIllustrationVersionId"],
      });
      return { page: this.requirePage(updated.id), illustration };
    });
  }

  requestLayoutRecalculation(input: {
    pageId: string;
    expectedRevision: number;
    reason: string;
    requestedPlacement?: "auto" | "top" | "bottom" | "right" | "left";
  }): LayoutWorkRequest {
    return this.store.transaction(() => {
      const page = this.expectedMutableStoryPage(
        input.pageId,
        input.expectedRevision,
      );
      if (
        !page.currentTextVersionId ||
        !page.currentIllustrationVersionId ||
        page.staleState !== "current"
      )
        failCreative("CREATIVE_DEPENDENCY_INCOMPLETE");
      const at = this.now();
      const request = this.repositories.layoutWorkRequests.insert(
        layoutWorkRequestSchema.parse({
          id: this.idFactory(),
          schemaVersion: 1,
          createdAt: at,
          updatedAt: at,
          pageId: page.id,
          projectId: page.projectId,
          textVersionId: page.currentTextVersionId,
          illustrationVersionId: page.currentIllustrationVersionId,
          reason: input.reason,
          requestedPlacement: input.requestedPlacement,
          state: "pending",
        }),
      );
      this.changes.record({
        page,
        entity: "layout",
        matrixRow: "IM-11",
        changeType: "layout_recalculation",
        fromVersionId: null,
        toVersionId: request.id,
        changedFields: ["layoutWorkRequest"],
      });
      return request;
    });
  }

  listLayoutRequests(projectId: string): LayoutWorkRequest[] {
    return this.repositories.layoutWorkRequests.queryByField(
      "projectId",
      projectId,
    );
  }

  recordReview(input: {
    pageId: string;
    expectedRevision: number;
    textVersionId: string;
    illustrationVersionId: string;
    checks: z.input<typeof reviewChecksSchema>;
    notes: string;
  }): { page: Page; review: PageReview } {
    return this.store.transaction(() => {
      const page = this.expectedPage(input.pageId, input.expectedRevision);
      if (
        page.currentTextVersionId !== input.textVersionId ||
        page.currentIllustrationVersionId !== input.illustrationVersionId
      )
        failCreative("CREATIVE_REVIEW_STALE");
      if (page.staleState !== "current") failCreative("CREATIVE_PAGE_STALE");
      const at = this.now();
      const review = this.repositories.reviews.insert(
        pageReviewSchema.parse({
          id: this.idFactory(),
          schemaVersion: 1,
          createdAt: at,
          updatedAt: at,
          pageId: page.id,
          pageRevision: page.revision,
          textVersionId: input.textVersionId,
          illustrationVersionId: input.illustrationVersionId,
          checks: input.checks,
          notes: input.notes,
          completed: true,
          recordedAt: at,
        }),
      );
      const updated = this.updatePage(page, { reviewStatus: "approved" });
      return { page: updated, review };
    });
  }

  lockPage(pageId: string, expectedRevision: number): Page {
    return this.store.transaction(() => {
      const page = this.expectedPage(pageId, expectedRevision);
      if (page.reviewStatus !== "approved")
        failCreative("CREATIVE_PAGE_NOT_REVIEWED");
      if (page.staleState !== "current") failCreative("CREATIVE_PAGE_STALE");
      if (page.locked) return page;
      return this.updatePage(page, { locked: true });
    });
  }

  unlockPage(pageId: string, expectedRevision: number): Page {
    return this.store.transaction(() => {
      const page = this.expectedPage(pageId, expectedRevision);
      if (!page.locked) return page;
      return this.updatePage(page, {
        locked: false,
        staleState:
          page.staleState === "locked_stale" ? "stale" : page.staleState,
      });
    });
  }

  markStale(pageId: string, row: MatrixRow): Page {
    return this.store.transaction(() => {
      const page = this.requirePage(pageId);
      if (page.staleReasons.includes(row)) return page;
      return this.updatePage(page, {
        staleState: page.locked ? "locked_stale" : "stale",
        staleReasons: [...page.staleReasons, row],
        reviewStatus:
          page.reviewStatus === "approved" ? "flagged" : page.reviewStatus,
      });
    });
  }

  flagForReview(pageId: string): Page {
    return this.store.transaction(() => {
      const page = this.requirePage(pageId);
      if (page.reviewStatus === "flagged") return page;
      return this.updatePage(page, { reviewStatus: "flagged" });
    });
  }

  illustrationHistory(pageId: string): IllustrationVersion[] {
    this.requirePage(pageId);
    return this.repositories.illustrations.queryByField("pageId", pageId);
  }

  textHistory(pageId: string): PageTextVersion[] {
    this.requirePage(pageId);
    return this.repositories.pageTexts.queryByField("pageId", pageId);
  }

  private expectedMutableStoryPage(pageId: string, revision: number): Page {
    const page = this.expectedPage(pageId, revision);
    if (page.kind !== "story") failCreative("CREATIVE_VERSION_CONFLICT");
    if (page.locked) failCreative("CREATIVE_PAGE_LOCKED");
    return page;
  }

  private expectedPage(pageId: string, revision: number): Page {
    const page = this.requirePage(pageId);
    if (page.revision !== revision) failCreative("CREATIVE_REVISION_CONFLICT");
    return page;
  }

  private requirePage(pageId: string): Page {
    const page = this.repositories.pages.get(pageId);
    if (!page) failCreative("CREATIVE_ENTITY_NOT_FOUND", 404);
    return page;
  }

  private requireProject(projectId: string) {
    const project = this.authoring.projects.get(projectId);
    if (!project) failCreative("CREATIVE_ENTITY_NOT_FOUND", 404);
    return project;
  }

  private updatePage(page: Page, patch: Partial<Page>): Page {
    return this.repositories.pages.update(
      pageSchema.parse({
        ...page,
        ...patch,
        updatedAt: this.now(),
        revision: page.revision + 1,
      }),
    );
  }
}

function pageKind(
  kind: "title" | "dedication" | "story" | "farewell" | "brand",
) {
  if (kind === "farewell") return "ending1" as const;
  if (kind === "brand") return "ending2" as const;
  return kind;
}

import type { ZodType } from "zod";

import {
  DocumentRepository,
  type BaseDocument,
  type DocumentStore,
} from "../repository/document-store.js";
import { failCreative } from "./errors.js";
import {
  characterApprovalSchema,
  characterSheetSchema,
  characterSheetIntentSchema,
  creativeRunSchema,
  creativeStageRecordSchema,
  findingAcknowledgementSchema,
  illustrationVersionSchema,
  invalidationAuditSchema,
  layoutWorkRequestSchema,
  pagePromptVersionSchema,
  pageReviewSchema,
  pageSchema,
  pageTextVersionSchema,
  type CharacterApproval,
  type CharacterSheet,
  type CharacterSheetIntent,
  type CreativeRun,
  type CreativeStageRecord,
  type FindingAcknowledgement,
  type IllustrationVersion,
  type InvalidationAudit,
  type LayoutWorkRequest,
  type Page,
  type PagePromptVersion,
  type PageReview,
  type PageTextVersion,
} from "./schemas.js";

export const creativeCollections = {
  characterSheets: "character_sheets",
  characterSheetIntents: "character_sheet_intents",
  characterApprovals: "character_approvals",
  runs: "creative_runs",
  stageRecords: "creative_stage_records",
  pages: "pages",
  pageTextVersions: "page_text_versions",
  pagePromptVersions: "page_prompt_versions",
  illustrationVersions: "illustration_versions",
  pageReviews: "page_reviews",
  findingAcknowledgements: "finding_acknowledgements",
  invalidationAudits: "invalidation_audits",
  layoutWorkRequests: "layout_work_requests",
} as const;

export class CreativeRepository<T extends BaseDocument> {
  private readonly documents: DocumentRepository<T>;

  constructor(
    private readonly store: DocumentStore,
    readonly collection: string,
    private readonly schema: ZodType<T>,
  ) {
    this.documents = new DocumentRepository(store, collection, schema);
  }

  get(id: string): T | null {
    return this.documents.get(id);
  }

  list(): T[] {
    return this.documents.list();
  }

  queryByField(field: string, value: string | number | boolean): T[] {
    return this.documents.queryByField(field, value);
  }

  insert(document: T): T {
    const parsed = this.schema.parse(document);
    this.store.assertSafeForPersistence(parsed);
    if (this.get(parsed.id)) failCreative("CREATIVE_DUPLICATE_ENTITY");
    try {
      this.store.database
        .prepare(
          `INSERT INTO documents(collection, id, doc, schema_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.collection,
          parsed.id,
          JSON.stringify(parsed),
          parsed.schemaVersion,
          parsed.createdAt,
          parsed.updatedAt,
        );
    } catch (error) {
      if (constraintFailure(error)) failCreative("CREATIVE_DUPLICATE_ENTITY");
      throw error;
    }
    return parsed;
  }

  update(document: T): T {
    const parsed = this.schema.parse(document);
    if (!this.get(parsed.id)) failCreative("CREATIVE_ENTITY_NOT_FOUND", 404);
    return this.documents.put(parsed);
  }
}

export class CreativeRepositories {
  readonly sheets: CreativeRepository<CharacterSheet>;
  readonly sheetIntents: CreativeRepository<CharacterSheetIntent>;
  readonly approvals: CreativeRepository<CharacterApproval>;
  readonly runs: CreativeRepository<CreativeRun>;
  readonly stages: CreativeRepository<CreativeStageRecord>;
  readonly pages: CreativeRepository<Page>;
  readonly pageTexts: CreativeRepository<PageTextVersion>;
  readonly pagePrompts: CreativeRepository<PagePromptVersion>;
  readonly illustrations: CreativeRepository<IllustrationVersion>;
  readonly reviews: CreativeRepository<PageReview>;
  readonly acknowledgements: CreativeRepository<FindingAcknowledgement>;
  readonly invalidationAudits: CreativeRepository<InvalidationAudit>;
  readonly layoutWorkRequests: CreativeRepository<LayoutWorkRequest>;

  constructor(store: DocumentStore) {
    const sheet = sheetRepositories(store);
    const page = pageRepositories(store);
    this.sheets = sheet.sheets;
    this.sheetIntents = sheet.sheetIntents;
    this.approvals = sheet.approvals;
    this.runs = repository(store, creativeCollections.runs, creativeRunSchema);
    this.stages = repository(
      store,
      creativeCollections.stageRecords,
      creativeStageRecordSchema,
    );
    this.pages = page.pages;
    this.pageTexts = page.pageTexts;
    this.pagePrompts = page.pagePrompts;
    this.illustrations = page.illustrations;
    this.reviews = page.reviews;
    this.acknowledgements = repository(
      store,
      creativeCollections.findingAcknowledgements,
      findingAcknowledgementSchema,
    );
    this.invalidationAudits = repository(
      store,
      creativeCollections.invalidationAudits,
      invalidationAuditSchema,
    );
    this.layoutWorkRequests = repository(
      store,
      creativeCollections.layoutWorkRequests,
      layoutWorkRequestSchema,
    );
  }
}

function sheetRepositories(store: DocumentStore) {
  return {
    sheets: repository(
      store,
      creativeCollections.characterSheets,
      characterSheetSchema,
    ),
    sheetIntents: repository(
      store,
      creativeCollections.characterSheetIntents,
      characterSheetIntentSchema,
    ),
    approvals: repository(
      store,
      creativeCollections.characterApprovals,
      characterApprovalSchema,
    ),
  };
}

function pageRepositories(store: DocumentStore) {
  return {
    pages: repository(store, creativeCollections.pages, pageSchema),
    pageTexts: repository(
      store,
      creativeCollections.pageTextVersions,
      pageTextVersionSchema,
    ),
    pagePrompts: repository(
      store,
      creativeCollections.pagePromptVersions,
      pagePromptVersionSchema,
    ),
    illustrations: repository(
      store,
      creativeCollections.illustrationVersions,
      illustrationVersionSchema,
    ),
    reviews: repository(
      store,
      creativeCollections.pageReviews,
      pageReviewSchema,
    ),
  };
}

function repository<T extends BaseDocument>(
  store: DocumentStore,
  collection: string,
  schema: ZodType<T>,
): CreativeRepository<T> {
  return new CreativeRepository(store, collection, schema);
}

function constraintFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  );
}

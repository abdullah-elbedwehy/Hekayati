import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AssetStore } from "../../assets/asset-store.js";
import {
  creativeCapacityConfirmationSchema,
  creativePromptConfirmationSchema,
} from "../../contracts/creative-policy.js";
import type { AuthoringService } from "../../domain/authoring/index.js";
import type { CreativeRuntime } from "../app.js";
import {
  reviewChecksSchema,
  sheetViewNameSchema,
} from "../../domain/creative/schemas.js";
import {
  entityIdSchema,
  type LibraryService,
} from "../../domain/library/index.js";

const idParams = z.object({ id: entityIdSchema }).strict();
const sheetViewParams = idParams.extend({ view: sheetViewNameSchema }).strict();
const scopedQuery = z.object({ familyId: entityIdSchema }).strict();
const scopedVersionQuery = scopedQuery
  .extend({ version: entityIdSchema.optional() })
  .strict();
const revisionSchema = z.number().int().nonnegative();
const policyConfirmationsSchema = z
  .object({
    prompt: creativePromptConfirmationSchema.optional(),
    capacity: creativeCapacityConfirmationSchema.optional(),
  })
  .strict();

const sheetStartSchema = z
  .object({
    characterId: entityIdSchema,
    expectedProjectVersionId: entityIdSchema,
    priorSheetId: entityIdSchema.nullable().optional(),
    revisionNotes: z.string().max(12_000).optional(),
    priority: z.number().int().min(1).max(5).optional(),
    confirmations: policyConfirmationsSchema.optional(),
  })
  .strict();
const sheetApproveSchema = z
  .object({
    expectedSheetRevision: revisionSchema,
    intentId: entityIdSchema,
    expectedIntentRevision: revisionSchema,
    gateJobId: entityIdSchema,
    expectedGateRevision: revisionSchema,
    notes: z.string().max(12_000),
  })
  .strict();
const sheetChangeSchema = z
  .object({
    expectedSheetRevision: revisionSchema,
    intentId: entityIdSchema,
    expectedIntentRevision: revisionSchema,
    gateJobId: entityIdSchema,
    expectedGateRevision: revisionSchema,
    expectedProjectVersionId: entityIdSchema,
    notes: z.string().trim().min(1).max(12_000),
    priority: z.number().int().min(1).max(5).optional(),
    confirmations: policyConfirmationsSchema.optional(),
  })
  .strict();
const runStartSchema = z
  .object({
    expectedProjectVersionId: entityIdSchema,
    expectedStoryVersionId: entityIdSchema,
    priority: z.number().int().min(1).max(5).optional(),
    confirmations: policyConfirmationsSchema.optional(),
  })
  .strict();
const pageMutationSchema = z
  .object({ expectedRevision: revisionSchema })
  .strict();
const pageReviewSchema = pageMutationSchema
  .extend({
    textVersionId: entityIdSchema,
    illustrationVersionId: entityIdSchema,
    checks: reviewChecksSchema,
    notes: z.string().max(12_000),
  })
  .strict();
const pageTextSchema = pageMutationSchema
  .extend({
    narrative: z.string().max(12_000),
    dialogue: z
      .array(
        z
          .object({
            speakerCharacterId: entityIdSchema,
            text: z.string().max(12_000),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
const revertSchema = pageMutationSchema
  .extend({ targetVersionId: entityIdSchema })
  .strict();
const layoutRequestSchema = pageMutationSchema
  .extend({
    reason: z.string().trim().min(1).max(500),
    requestedPlacement: z
      .enum(["auto", "top", "bottom", "right", "left"])
      .optional(),
  })
  .strict();
const regenerateSchema = pageMutationSchema
  .extend({ runId: entityIdSchema })
  .strict();
const acknowledgeSchema = z
  .object({
    expectedRunRevision: revisionSchema,
    findingKey: z.string().regex(/^[a-f0-9]{64}$/),
    note: z.string().trim().min(1).max(500),
  })
  .strict();
const completeReviewSchema = z
  .object({
    expectedRunRevision: revisionSchema,
    gateJobId: entityIdSchema,
    expectedGateRevision: revisionSchema,
  })
  .strict();

export function registerCreativeApi(
  app: FastifyInstance,
  creative: CreativeRuntime,
  library: LibraryService,
  authoring: AuthoringService,
  assets: AssetStore,
): void {
  const context = { creative, library, authoring, assets };
  registerCreativeProjectRoutes(app, context);
  registerCreativeSheetRoutes(app, context);
  registerCreativeRunRoutes(app, context);
  registerCreativePageReadRoutes(app, context);
  registerCreativePageReviewRoutes(app, context);
  registerCreativePageEditRoutes(app, context);
  registerCreativeInvalidationRoutes(app, context);
}

function registerCreativeInvalidationRoutes(
  app: FastifyInstance,
  context: CreativeApiContext,
): void {
  app.post(
    "/api/creative/invalidation-events/:id/affected-items",
    (request, reply) => {
      const eventId = idParams.parse(request.params).id;
      const scope = scopeFromQuery(context.library, request.query);
      return reply
        .header("cache-control", "private, no-store")
        .send(
          context.creative.invalidation.affectedItemsForFamily(scope, eventId),
        );
    },
  );
}

interface CreativeApiContext {
  creative: CreativeRuntime;
  library: LibraryService;
  authoring: AuthoringService;
  assets: AssetStore;
}

function registerCreativeProjectRoutes(
  app: FastifyInstance,
  context: CreativeApiContext,
): void {
  const { creative, library, authoring } = context;
  app.get("/api/creative/projects/:id", (request) => {
    const projectId = idParams.parse(request.params).id;
    assertProjectScope(authoring, library, projectId, request.query);
    return {
      sheets: creative.sheets.listProjectSheets(projectId),
      sheetIntents: creative.sheets.listProjectIntents(projectId),
      runs: creative.pipeline.listProjectRuns(projectId),
      pages: creative.pages.listProjectPages(projectId),
      layoutRequests: creative.pages.listLayoutRequests(projectId),
    };
  });
  app.post("/api/creative/projects/:id/sheets", (request) => {
    const projectId = idParams.parse(request.params).id;
    const scope = scopeFromQuery(library, request.query);
    return creative.sheetPipeline.start(
      scope,
      projectId,
      sheetStartSchema.parse(request.body),
    );
  });
  app.post("/api/creative/projects/:id/runs", (request) => {
    const projectId = idParams.parse(request.params).id;
    return creative.pipeline.startRun(
      scopeFromQuery(library, request.query),
      projectId,
      runStartSchema.parse(request.body),
    );
  });
}

function registerCreativeSheetRoutes(
  app: FastifyInstance,
  context: CreativeApiContext,
): void {
  const { creative, library } = context;
  registerCreativeSheetAssetRoutes(app, context);
  app.get("/api/creative/sheets/:id", (request) => {
    const sheet = creative.sheets.getSheet(idParams.parse(request.params).id);
    assertSheetScope(library, sheet, request.query);
    return sheet;
  });

  app.post("/api/creative/sheets/:id/approve", (request) => {
    const sheetId = idParams.parse(request.params).id;
    const sheet = creative.sheets.getSheet(sheetId);
    assertSheetScope(library, sheet, request.query);
    return creative.sheets.approveSheet({
      sheetId,
      ...sheetApproveSchema.parse(request.body),
    });
  });

  app.post("/api/creative/sheets/:id/change-request", (request) => {
    const sheetId = idParams.parse(request.params).id;
    const sheet = creative.sheets.getSheet(sheetId);
    const scope = assertSheetScope(library, sheet, request.query);
    return creative.sheetPipeline.requestChanges(scope, sheet.projectId, {
      sheetId,
      ...sheetChangeSchema.parse(request.body),
    });
  });
}

function registerCreativeSheetAssetRoutes(
  app: FastifyInstance,
  context: CreativeApiContext,
): void {
  const { creative, library, assets } = context;
  app.get("/api/creative/sheets/:id/pdf", async (request, reply) => {
    const sheet = creative.sheets.getSheet(idParams.parse(request.params).id);
    assertSheetScope(library, sheet, request.query);
    const pdf = assets.get(sheet.pdfAssetId);
    if (!pdf || pdf.role !== "pdf_preview")
      throw new Error("SHEET_PDF_MISSING");
    return reply
      .header("cache-control", "private, no-store")
      .header("content-disposition", `inline; filename="sheet-${sheet.id}.pdf"`)
      .header("x-content-type-options", "nosniff")
      .type("application/pdf")
      .send(await assets.read(pdf.id));
  });
  app.get("/api/creative/sheets/:id/views/:view", async (request, reply) => {
    const params = sheetViewParams.parse(request.params);
    const sheet = creative.sheets.getSheet(params.id);
    assertSheetScope(library, sheet, request.query);
    const asset = assets.get(sheet.views[params.view]);
    if (!asset || asset.role !== "sheet_view")
      return reply.code(404).send({ code: "CREATIVE_ENTITY_NOT_FOUND" });
    return reply
      .header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff")
      .type(asset.mime)
      .send(await assets.read(asset.id));
  });
}

function registerCreativeRunRoutes(
  app: FastifyInstance,
  context: CreativeApiContext,
): void {
  const { creative } = context;
  app.get("/api/creative/runs/:id", (request) => {
    const run = assertRunScope(context, request.params, request.query);
    return run;
  });
  app.get("/api/creative/runs/:id/findings", (request) => {
    const run = assertRunScope(context, request.params, request.query);
    return creative.pipeline.findingProjection(run.id);
  });
  app.post("/api/creative/runs/:id/findings/acknowledge", (request) => {
    const run = assertRunScope(context, request.params, request.query);
    return creative.pipeline.acknowledgeFinding({
      runId: run.id,
      ...acknowledgeSchema.parse(request.body),
    });
  });
  app.post("/api/creative/runs/:id/complete-review", (request) => {
    const run = assertRunScope(context, request.params, request.query);
    return creative.pipeline.completeInternalReview({
      runId: run.id,
      ...completeReviewSchema.parse(request.body),
    });
  });
}

function registerCreativePageReadRoutes(
  app: FastifyInstance,
  context: CreativeApiContext,
): void {
  const { creative, authoring, library, assets } = context;
  app.get("/api/creative/projects/:id/pages", (request) => {
    const projectId = idParams.parse(request.params).id;
    assertProjectScope(authoring, library, projectId, request.query);
    return creative.pages.listProjectPages(projectId);
  });
  app.get("/api/creative/pages/:id/history", (request) => {
    const pageId = idParams.parse(request.params).id;
    assertPageScope(creative, authoring, library, pageId, request.query);
    return {
      text: creative.pages.textHistory(pageId),
      illustrations: creative.pages.illustrationHistory(pageId),
    };
  });
  app.get("/api/creative/pages/:id/illustration", async (request, reply) => {
    const pageId = idParams.parse(request.params).id;
    const page = creative.pages.getPage(pageId);
    const query = scopedVersionQuery.parse(request.query);
    assertPageScope(creative, authoring, library, pageId, {
      familyId: query.familyId,
    });
    const versionId = query.version ?? page.currentIllustrationVersionId;
    if (!versionId)
      return reply.code(404).send({ code: "CREATIVE_ENTITY_NOT_FOUND" });
    const illustration = creative.pages.getIllustrationVersion(versionId);
    if (illustration.pageId !== page.id)
      return reply.code(404).send({ code: "CREATIVE_ENTITY_NOT_FOUND" });
    const asset = assets.get(illustration.assetId);
    if (!asset || asset.role !== "illustration")
      return reply.code(404).send({ code: "CREATIVE_ENTITY_NOT_FOUND" });
    return reply
      .header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff")
      .type(asset.mime)
      .send(await assets.read(asset.id));
  });
}

function registerCreativePageReviewRoutes(
  app: FastifyInstance,
  context: CreativeApiContext,
): void {
  const { creative, authoring, library } = context;
  app.post("/api/creative/pages/:id/review", (request) => {
    const pageId = idParams.parse(request.params).id;
    assertPageScope(creative, authoring, library, pageId, request.query);
    const body = pageReviewSchema.parse(request.body);
    return creative.pages.recordReview({
      pageId,
      expectedRevision: body.expectedRevision,
      textVersionId: body.textVersionId,
      illustrationVersionId: body.illustrationVersionId,
      checks: body.checks,
      notes: body.notes,
    });
  });
  app.post("/api/creative/pages/:id/lock", (request) => {
    const pageId = idParams.parse(request.params).id;
    assertPageScope(creative, authoring, library, pageId, request.query);
    return creative.pages.lockPage(
      pageId,
      pageMutationSchema.parse(request.body).expectedRevision,
    );
  });
  app.post("/api/creative/pages/:id/unlock", (request) => {
    const pageId = idParams.parse(request.params).id;
    assertPageScope(creative, authoring, library, pageId, request.query);
    return creative.pages.unlockPage(
      pageId,
      pageMutationSchema.parse(request.body).expectedRevision,
    );
  });
}

function registerCreativePageEditRoutes(
  app: FastifyInstance,
  context: CreativeApiContext,
): void {
  const { creative, authoring, library } = context;
  app.post("/api/creative/pages/:id/text", (request) => {
    const pageId = idParams.parse(request.params).id;
    assertPageScope(creative, authoring, library, pageId, request.query);
    return creative.pages.appendManualText({
      pageId,
      ...pageTextSchema.parse(request.body),
    });
  });
  app.post("/api/creative/pages/:id/revert-text", (request) => {
    const pageId = idParams.parse(request.params).id;
    assertPageScope(creative, authoring, library, pageId, request.query);
    return creative.pages.revertText({
      pageId,
      ...revertSchema.parse(request.body),
    });
  });
  app.post("/api/creative/pages/:id/revert-illustration", (request) => {
    const pageId = idParams.parse(request.params).id;
    assertPageScope(creative, authoring, library, pageId, request.query);
    return creative.pages.revertIllustration({
      pageId,
      ...revertSchema.parse(request.body),
    });
  });
  app.post("/api/creative/pages/:id/layout-request", (request) => {
    const pageId = idParams.parse(request.params).id;
    assertPageScope(creative, authoring, library, pageId, request.query);
    return creative.pages.requestLayoutRecalculation({
      pageId,
      ...layoutRequestSchema.parse(request.body),
    });
  });
  app.post("/api/creative/pages/:id/regenerate-illustration", (request) => {
    const pageId = idParams.parse(request.params).id;
    assertPageScope(creative, authoring, library, pageId, request.query);
    const body = regenerateSchema.parse(request.body);
    return creative.pipeline.regenerateIllustration({
      runId: body.runId,
      pageId,
      expectedPageRevision: body.expectedRevision,
    });
  });
}

function assertRunScope(
  context: CreativeApiContext,
  rawParams: unknown,
  rawQuery: unknown,
) {
  const run = context.creative.pipeline.getRun(idParams.parse(rawParams).id);
  assertProjectScope(
    context.authoring,
    context.library,
    run.projectId,
    rawQuery,
  );
  return run;
}

function scopeFromQuery(library: LibraryService, raw: unknown) {
  return library.scopeForFamilyId(scopedQuery.parse(raw).familyId);
}

function assertProjectScope(
  authoring: AuthoringService,
  library: LibraryService,
  projectId: string,
  rawQuery: unknown,
) {
  const scope = scopeFromQuery(library, rawQuery);
  authoring.getProjectWorkspace(scope, projectId);
  return scope;
}

function assertSheetScope(
  library: LibraryService,
  sheet: { customerId: string; familyId: string; characterId: string },
  rawQuery: unknown,
) {
  const scope = scopeFromQuery(library, rawQuery);
  library.getCharacter(scope, sheet.characterId);
  return scope;
}

function assertPageScope(
  creative: CreativeRuntime,
  authoring: AuthoringService,
  library: LibraryService,
  pageId: string,
  rawQuery: unknown,
) {
  const page = creative.pages.getPage(pageId);
  return assertProjectScope(authoring, library, page.projectId, rawQuery);
}

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { AssetStore } from "../../assets/asset-store.js";
import type { AuthoringService } from "../../domain/authoring/index.js";
import { ApprovalError } from "../../domain/layout/approvals.js";
import { bookApprovalScopeSchema } from "../../domain/layout/schemas.js";
import {
  entityIdSchema,
  sha256Pattern,
  type LibraryService,
} from "../../domain/library/index.js";
import type { CreativeRuntime, LayoutRuntime } from "../app.js";

const idParams = z.object({ id: entityIdSchema }).strict();
const scopedQuery = z.object({ familyId: entityIdSchema }).strict();
const revisionSchema = z.number().int().nonnegative();
const hashSchema = z.string().regex(sha256Pattern);
const placementSchema = z.enum(["auto", "top", "bottom", "right", "left"]);

const recalculateSchema = z
  .object({
    expectedRevision: revisionSchema,
    reason: z.string().trim().min(1).max(500),
    requestedPlacement: placementSchema,
  })
  .strict();
const compositionSourceSchema = z
  .object({
    expectedPageRevision: revisionSchema,
    expectedWorkflowRevision: revisionSchema,
    assetId: entityIdSchema.nullable(),
    requestedPlacement: placementSchema,
  })
  .strict();
const coverCompositionSchema = z
  .object({
    expectedProjectRevision: revisionSchema,
    expectedWorkflowRevision: revisionSchema,
    expectedCoverVersionId: entityIdSchema,
    frontArtworkAssetId: entityIdSchema,
    backArtworkAssetId: entityIdSchema.nullable().optional(),
    environmentLine: z.string().max(1_000).nullable().optional(),
    synopsis: z.string().max(4_000).nullable().optional(),
  })
  .strict();
const regenerateSchema = z
  .object({
    expectedProjectRevision: revisionSchema,
    expectedWorkflowRevision: revisionSchema,
  })
  .strict();
const approvalBase = {
  cycleId: entityIdSchema,
  idempotencyKey: z.string().trim().min(1).max(160),
  customerContentHash: hashSchema,
  approvalBundleHash: hashSchema,
  expectedProjectRevision: revisionSchema,
  expectedPreviewOutputRevision: revisionSchema,
  expectedApprovalRevision: revisionSchema,
  expectedGateRevision: revisionSchema,
  expectedContentApprovalId: entityIdSchema.nullable(),
  expectedContentApprovalRevision: revisionSchema.nullable(),
};
const approvalActionSchema = z.object(approvalBase).strict();
const changesRequestedSchema = z
  .object({
    ...approvalBase,
    notes: z.string().trim().min(1).max(8_000),
    affectedScopes: z.array(bookApprovalScopeSchema).min(1).max(100),
  })
  .strict();

interface LayoutApiContext {
  layout: LayoutRuntime;
  creative: CreativeRuntime;
  library: LibraryService;
  authoring: AuthoringService;
  assets: AssetStore;
}

export function registerLayoutApi(
  app: FastifyInstance,
  context: LayoutApiContext,
): void {
  registerProjectRoutes(app, context);
  registerCompositionRoutes(app, context);
  registerPreviewRoutes(app, context);
  registerApprovalRoutes(app, context);
}

function registerProjectRoutes(
  app: FastifyInstance,
  context: LayoutApiContext,
): void {
  app.get("/api/layout/projects/:id", (request, reply) => {
    const projectId = idParams.parse(request.params).id;
    assertProjectScope(context, projectId, request.query);
    return noStore(reply).send(context.layout.workspace.project(projectId));
  });
  app.post("/api/layout/projects/:id/preview-regenerate", (request, reply) => {
    const projectId = idParams.parse(request.params).id;
    assertProjectScope(context, projectId, request.query);
    const result = context.layout.workflow.regenerate(
      projectId,
      regenerateSchema.parse(request.body),
    );
    return noStore(reply).send(result);
  });
  app.get(
    "/api/layout/projects/:id/approved-snapshot-status",
    async (request, reply) => {
      const projectId = idParams.parse(request.params).id;
      assertProjectScope(context, projectId, request.query);
      return noStore(reply).send(
        await approvedSnapshotStatus(context.layout, projectId),
      );
    },
  );
}

function registerCompositionRoutes(
  app: FastifyInstance,
  context: LayoutApiContext,
): void {
  app.post("/api/layout/pages/:id/recalculate", (request, reply) => {
    const pageId = idParams.parse(request.params).id;
    const page = context.creative.pages.getPage(pageId);
    assertProjectScope(context, page.projectId, request.query);
    const workRequest = context.creative.pages.requestLayoutRecalculation({
      pageId,
      ...recalculateSchema.parse(request.body),
    });
    const workflow = context.layout.workflow.start(page.projectId);
    return noStore(reply).send({ workRequest, workflow });
  });
  app.post("/api/layout/pages/:id/composition-source", (request, reply) => {
    const pageId = idParams.parse(request.params).id;
    const page = context.creative.pages.getPage(pageId);
    assertProjectScope(context, page.projectId, request.query);
    const workflow = context.layout.workflow.changeSpecialCompositionSource(
      page.projectId,
      { pageId, ...compositionSourceSchema.parse(request.body) },
    );
    return noStore(reply).send(workflow);
  });
  app.post("/api/layout/projects/:id/cover-composition", (request, reply) => {
    const projectId = idParams.parse(request.params).id;
    assertProjectScope(context, projectId, request.query);
    return noStore(reply).send(
      context.layout.workflow.changeCoverComposition(
        projectId,
        coverCompositionSchema.parse(request.body),
      ),
    );
  });
}

function registerPreviewRoutes(
  app: FastifyInstance,
  context: LayoutApiContext,
): void {
  app.get("/api/layout/previews/:id/pdf", async (request, reply) => {
    const output = context.layout.workspace.preview(
      idParams.parse(request.params).id,
    );
    assertProjectScope(context, output.projectId, request.query);
    const asset =
      output.status === "ready" ? context.assets.get(output.assetId) : null;
    if (!asset || asset.role !== "pdf_preview")
      return noStore(reply)
        .code(404)
        .send({ code: "LAYOUT_PREVIEW_ASSET_INVALID" });
    return noStore(reply)
      .header(
        "content-disposition",
        `inline; filename="preview-${output.id}.pdf"`,
      )
      .header("x-content-type-options", "nosniff")
      .type("application/pdf")
      .send(await context.assets.read(asset.id));
  });
}

function registerApprovalRoutes(
  app: FastifyInstance,
  context: LayoutApiContext,
): void {
  registerApprovalAction(app, context, "sent", "preview_sent");
  registerApprovalAction(app, context, "approve", "approved");
  app.post("/api/layout/previews/:id/changes-requested", (request, reply) => {
    const output = scopedPreview(context, request.params, request.query);
    const scope = scopeFromQuery(context.library, request.query);
    return noStore(reply).send(
      context.layout.approvals.act({
        owner: scope,
        projectId: output.projectId,
        previewOutputId: output.id,
        action: "changes_requested",
        ...changesRequestedSchema.parse(request.body),
      }),
    );
  });
}

function registerApprovalAction(
  app: FastifyInstance,
  context: LayoutApiContext,
  route: "sent" | "approve",
  action: "preview_sent" | "approved",
): void {
  app.post(`/api/layout/previews/:id/${route}`, (request, reply) => {
    const output = scopedPreview(context, request.params, request.query);
    const scope = scopeFromQuery(context.library, request.query);
    return noStore(reply).send(
      context.layout.approvals.act({
        owner: scope,
        projectId: output.projectId,
        previewOutputId: output.id,
        action,
        ...approvalActionSchema.parse(request.body),
      }),
    );
  });
}

function scopedPreview(
  context: LayoutApiContext,
  rawParams: unknown,
  rawQuery: unknown,
) {
  const output = context.layout.workspace.preview(idParams.parse(rawParams).id);
  assertProjectScope(context, output.projectId, rawQuery);
  return output;
}

function assertProjectScope(
  context: LayoutApiContext,
  projectId: string,
  rawQuery: unknown,
) {
  const scope = scopeFromQuery(context.library, rawQuery);
  context.authoring.getProjectWorkspace(scope, projectId);
  return scope;
}

function scopeFromQuery(library: LibraryService, rawQuery: unknown) {
  return library.scopeForFamilyId(scopedQuery.parse(rawQuery).familyId);
}

async function approvedSnapshotStatus(
  layout: LayoutRuntime,
  projectId: string,
) {
  try {
    return {
      state: "authorized" as const,
      snapshot: await layout.approvedSnapshots.read(projectId),
    };
  } catch (error) {
    if (error instanceof ApprovalError)
      return { state: "blocked" as const, code: error.code };
    throw error;
  }
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header("cache-control", "private, no-store");
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  projectInputSchema,
  sceneContentSchema,
  storyTemplateContentSchema,
  templateStatusSchema,
  type AuthoringService,
} from "../../domain/authoring/index.js";
import {
  entityIdSchema,
  type LibraryService,
} from "../../domain/library/index.js";

const familyParamSchema = z.object({ id: entityIdSchema }).strict();
const projectParamSchema = z.object({ id: entityIdSchema }).strict();
const projectSceneParamSchema = z
  .object({
    id: entityIdSchema,
    storyPageIndex: z.coerce.number().int().min(1).max(20),
  })
  .strict();
const scopedQuerySchema = z.object({ familyId: entityIdSchema }).strict();
const projectCreateSchema = projectInputSchema;
const projectUpdateSchema = z
  .object({ expectedVersionId: entityIdSchema, input: projectInputSchema })
  .strict();
const overrideSchema = z
  .object({
    expectedProjectVersionId: entityIdSchema,
    expectedOverrideVersionId: entityIdSchema.optional(),
    characterId: entityIdSchema,
    clothing: z.string().max(8_000),
    appearanceOverrides: z.record(
      z.string().min(1).max(80),
      z.string().max(1_000),
    ),
  })
  .strict();
const sceneUpdateSchema = z
  .object({
    expectedStoryVersionId: entityIdSchema,
    expectedSceneVersionId: entityIdSchema,
    content: sceneContentSchema,
  })
  .strict();
const compileSchema = z
  .object({
    selectedParticipantIds: z.array(entityIdSchema).min(1).max(20),
    capability: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("mock_unlimited") }).strict(),
      z
        .object({
          mode: z.literal("verified"),
          modelId: z.string().min(1).max(240),
          reliableReferenceCount: z.number().int().nonnegative().max(100),
        })
        .strict(),
      z
        .object({
          mode: z.literal("unavailable"),
          modelId: z.string().min(1).max(240),
          reason: z.string().min(1).max(240),
        })
        .strict(),
    ]),
    acknowledgements: z
      .object({ reconciliation: z.boolean(), capacity: z.boolean() })
      .strict(),
  })
  .strict();
const removalQuerySchema = scopedQuerySchema.extend({
  characterId: entityIdSchema,
});
const removalSchema = z
  .object({
    expectedProjectVersionId: entityIdSchema,
    expectedStoryVersionId: entityIdSchema,
    characterId: entityIdSchema,
    resolution: z.discriminatedUnion("type", [
      z.object({ type: z.literal("cancel") }).strict(),
      z
        .object({
          type: z.literal("replace"),
          replacementCharacterId: entityIdSchema,
        })
        .strict(),
      z.object({ type: z.literal("remove_mentions") }).strict(),
    ]),
  })
  .strict();
const extractionSchema = z
  .object({ name: z.string().trim().min(1).max(240) })
  .strict();
const sameFamilyDuplicateSchema = z
  .object({
    expectedProjectVersionId: entityIdSchema,
    expectedStoryVersionId: entityIdSchema,
    title: z.string().trim().min(1).max(240),
  })
  .strict();
const crossFamilySchema = z.object({ targetFamilyId: entityIdSchema }).strict();
const pageCountSchema = z
  .object({ to: z.union([z.literal(16), z.literal(24)]) })
  .strict();
const templateCreateSchema = z
  .object({ content: storyTemplateContentSchema })
  .strict();
const templateUpdateSchema = z
  .object({
    expectedVersionId: entityIdSchema,
    content: storyTemplateContentSchema,
  })
  .strict();
const templateStatusInputSchema = z
  .object({
    expectedVersionId: entityIdSchema,
    expectedStatus: templateStatusSchema,
    status: templateStatusSchema,
  })
  .strict();
const templateQuerySchema = z
  .object({ includeHidden: z.enum(["true", "false"]).optional() })
  .strict();
const mentionQuerySchema = scopedQuerySchema.extend({
  query: z.string().max(240).optional(),
});
const pagePlanSchema = z
  .object({
    input: z
      .object({
        projectId: entityIdSchema,
        expectedProjectVersionId: entityIdSchema,
        expectedStoryVersionId: entityIdSchema,
        from: z.union([z.literal(16), z.literal(24)]),
        to: z.union([z.literal(16), z.literal(24)]),
        sourceSceneVersionIds: z.array(entityIdSchema).min(1).max(20),
      })
      .strict(),
    operations: z
      .array(
        z
          .object({
            type: z.enum(["retain", "add", "merge", "remove"]),
            targetStoryPageIndex: z.number().int().min(1).max(20).nullable(),
            sourceSceneVersionIds: z.array(entityIdSchema).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(40),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export function registerAuthoringApi(
  app: FastifyInstance,
  authoring: AuthoringService,
  library: LibraryService,
): void {
  registerProjectRoutes(app, authoring, library);
  registerSceneRoutes(app, authoring, library);
  registerAdvancedProjectRoutes(app, authoring, library);
  registerPageCountRoutes(app, authoring, library);
  registerTemplateRoutes(app, authoring);
}

function registerAdvancedProjectRoutes(
  app: FastifyInstance,
  authoring: AuthoringService,
  library: LibraryService,
): void {
  app.get("/api/authoring/projects/:id/removal-preflight", (request) => {
    const { id } = projectParamSchema.parse(request.params);
    const query = removalQuerySchema.parse(request.query);
    return authoring.preflightCharacterRemoval(
      library.scopeForFamilyId(query.familyId),
      id,
      query.characterId,
    );
  });
  app.post("/api/authoring/projects/:id/removal-resolution", (request) => {
    const { id } = projectParamSchema.parse(request.params);
    return authoring.resolveCharacterRemoval(
      scopeFromQuery(library, request.query),
      id,
      removalSchema.parse(request.body),
    );
  });
  app.post("/api/authoring/projects/:id/readiness", (request) => {
    const { id } = projectParamSchema.parse(request.params);
    return authoring.validateGenerationReadiness(
      scopeFromQuery(library, request.query),
      id,
    );
  });
  app.post("/api/authoring/projects/:id/extract-template", (request) => {
    const { id } = projectParamSchema.parse(request.params);
    return authoring.extractTemplateFromCompletedStory(
      scopeFromQuery(library, request.query),
      id,
      extractionSchema.parse(request.body).name,
    );
  });
  registerDuplicationRoutes(app, authoring, library);
}

function registerDuplicationRoutes(
  app: FastifyInstance,
  authoring: AuthoringService,
  library: LibraryService,
): void {
  app.post("/api/authoring/projects/:id/duplicate-same-family", (request) => {
    const { id } = projectParamSchema.parse(request.params);
    return authoring.duplicateCompletedStoryWithinFamily(
      scopeFromQuery(library, request.query),
      id,
      sameFamilyDuplicateSchema.parse(request.body),
    );
  });
  app.post("/api/authoring/projects/:id/cross-family-draft", (request) => {
    const { id } = projectParamSchema.parse(request.params);
    const { targetFamilyId } = crossFamilySchema.parse(request.body);
    return authoring.prepareCrossFamilyDuplicate(
      scopeFromQuery(library, request.query),
      id,
      library.scopeForFamilyId(targetFamilyId),
    );
  });
}

function registerProjectRoutes(
  app: FastifyInstance,
  authoring: AuthoringService,
  library: LibraryService,
): void {
  app.get("/api/authoring/projects", (request) => {
    const scope = scopeFromQuery(library, request.query);
    return authoring.listProjects(scope);
  });
  app.get("/api/authoring/projects/:id", (request) => {
    const { id } = projectParamSchema.parse(request.params);
    return authoring.getProjectWorkspace(
      scopeFromQuery(library, request.query),
      id,
    );
  });
  app.post("/api/authoring/families/:id/projects", (request) => {
    const { id } = familyParamSchema.parse(request.params);
    return authoring.createProject(
      library.scopeForFamilyId(id),
      projectCreateSchema.parse(request.body),
    );
  });
  app.patch("/api/authoring/projects/:id", (request) => {
    const { id } = projectParamSchema.parse(request.params);
    const input = projectUpdateSchema.parse(request.body);
    return authoring.updateProject(
      scopeFromQuery(library, request.query),
      id,
      input,
    );
  });
  app.post("/api/authoring/projects/:id/overrides", (request) => {
    const { id } = projectParamSchema.parse(request.params);
    return authoring.appendProjectOverride(
      scopeFromQuery(library, request.query),
      id,
      overrideSchema.parse(request.body),
    );
  });
  app.get("/api/authoring/projects/:id/mentions", (request) => {
    const { id } = projectParamSchema.parse(request.params);
    const query = mentionQuerySchema.parse(request.query);
    return authoring.mentionCandidates(
      library.scopeForFamilyId(query.familyId),
      id,
      query.query,
    );
  });
}

function registerSceneRoutes(
  app: FastifyInstance,
  authoring: AuthoringService,
  library: LibraryService,
): void {
  app.patch("/api/authoring/projects/:id/scenes/:storyPageIndex", (request) => {
    const params = projectSceneParamSchema.parse(request.params);
    return authoring.updateScene(
      scopeFromQuery(library, request.query),
      params.id,
      params.storyPageIndex,
      sceneUpdateSchema.parse(request.body),
    );
  });
  app.post(
    "/api/authoring/projects/:id/scenes/:storyPageIndex/compile",
    (request) => {
      const params = projectSceneParamSchema.parse(request.params);
      return authoring.compileScene(
        scopeFromQuery(library, request.query),
        params.id,
        params.storyPageIndex,
        compileSchema.parse(request.body),
      );
    },
  );
}

function registerPageCountRoutes(
  app: FastifyInstance,
  authoring: AuthoringService,
  library: LibraryService,
): void {
  app.post("/api/authoring/projects/:id/page-count/preflight", (request) => {
    const { id } = projectParamSchema.parse(request.params);
    const { to } = pageCountSchema.parse(request.body);
    return authoring.preflightPageCountChange(
      scopeFromQuery(library, request.query),
      id,
      to,
    );
  });
  app.post("/api/authoring/projects/:id/page-count/confirm", (request) => {
    const { id } = projectParamSchema.parse(request.params);
    const plan = pagePlanSchema.parse(request.body);
    return authoring.confirmPageCountChange(
      scopeFromQuery(library, request.query),
      id,
      plan,
    );
  });
}

function registerTemplateRoutes(
  app: FastifyInstance,
  authoring: AuthoringService,
): void {
  app.get("/api/authoring/templates", (request) => {
    const query = templateQuerySchema.parse(request.query);
    return authoring.listTemplates({
      includeHidden: query.includeHidden === "true",
    });
  });
  app.post("/api/authoring/templates", (request) =>
    authoring.createTemplate(templateCreateSchema.parse(request.body).content),
  );
  app.patch("/api/authoring/templates/:id", (request) => {
    const { id } = projectParamSchema.parse(request.params);
    return authoring.updateTemplate(
      id,
      templateUpdateSchema.parse(request.body),
    );
  });
  app.post("/api/authoring/templates/:id/duplicate", (request) => {
    const { id } = projectParamSchema.parse(request.params);
    return authoring.duplicateTemplate(id);
  });
  app.post("/api/authoring/templates/:id/status", (request) => {
    const { id } = projectParamSchema.parse(request.params);
    return authoring.setTemplateStatus(
      id,
      templateStatusInputSchema.parse(request.body),
    );
  });
}

function scopeFromQuery(library: LibraryService, query: unknown) {
  return library.scopeForFamilyId(scopedQuerySchema.parse(query).familyId);
}

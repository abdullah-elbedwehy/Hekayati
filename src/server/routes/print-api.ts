import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { failPrint, PrintError } from "../../domain/print/errors.js";
import { printerProfileDraftSchema } from "../../domain/print/schemas.js";
import { entityIdSchema, sha256Pattern } from "../../domain/library/schemas.js";
import type { LibraryService } from "../../domain/library/index.js";
import { IccInspectionError } from "../../print/icc.js";
import { CoverTemplateInspectionError } from "../../print/template.js";
import type { PrintRuntime } from "../print-runtime.js";

const revision = z.number().int().nonnegative();
const hash = z.string().regex(sha256Pattern);
const idParams = z.object({ id: entityIdSchema }).strict();
const artifactParams = z
  .object({ id: entityIdSchema, kind: z.enum(["interior", "cover"]) })
  .strict();
const scopedQuery = z.object({ familyId: entityIdSchema }).strict();
const createProfile = z
  .object({
    name: z.string().trim().min(1).max(160),
    draft: printerProfileDraftSchema,
  })
  .strict();
const updateProfile = createProfile
  .extend({ expectedRevision: revision, archived: z.boolean() })
  .strict();
const assignProfile = z
  .object({
    expectedProjectRevision: revision,
    profileId: entityIdSchema,
    expectedProfileRevision: revision,
    profileVersionId: entityIdSchema,
  })
  .strict();
const startRun = assignProfile
  .omit({ expectedProjectRevision: true })
  .extend({
    expectedProjectRevision: revision,
    contentAuthorizationHash: hash,
    idempotencyKey: z.string().trim().min(1).max(160),
  })
  .strict();
const proofAction = z
  .object({
    proofBundleId: entityIdSchema,
    gateJobId: entityIdSchema,
    action: z.enum(["approved", "rejected"]),
    idempotencyKey: z.string().trim().min(1).max(160),
    expectedRunRevision: revision,
    expectedGateRevision: revision,
    proofBundleHash: hash,
    contentAuthorizationHash: hash,
    printerProfileHash: hash,
    iccChecksum: hash,
    notes: z.string().max(1_000).optional(),
  })
  .strict();
const templateFields = z
  .object({
    backRegion: region(),
    spineRegion: region(),
    frontRegion: region(),
    toleranceMm: z.number().finite().min(0).max(2),
  })
  .strict();

export function registerPrintApi(
  app: FastifyInstance,
  print: PrintRuntime,
  library: LibraryService,
): void {
  app.addHook("onRequest", (request, reply, done) => {
    if (isPrintRequest(request.url)) noStore(reply);
    done();
  });
  registerProfileRoutes(app, print);
  registerProjectRoutes(app, print, library);
  registerRunRoutes(app, print, library);
  registerBinaryRoutes(app, print, library);
}

function registerProfileRoutes(
  app: FastifyInstance,
  print: PrintRuntime,
): void {
  app.get("/api/print/profiles", (_request, reply) =>
    noStore(reply).send(print.workspace.profilesProjection()),
  );
  app.post("/api/print/profiles", (request, reply) =>
    noStore(reply).send(
      print.profiles.create(createProfile.parse(request.body)),
    ),
  );
  app.put("/api/print/profiles/:id", (request, reply) => {
    const input = updateProfile.parse(request.body);
    return noStore(reply).send(
      print.profiles.update({
        ...input,
        profileId: idParams.parse(request.params).id,
      }),
    );
  });
  app.post("/api/print/profile-assets/icc", async (request, reply) => {
    const upload = await uploadedFile(request, 8 * 1024 * 1024, [
      "requireCmyk",
    ]);
    const requireCmyk = requiredBoolean(upload.fields, "requireCmyk");
    return noStore(reply).send(
      await profileAssetBoundary(() =>
        print.profiles.importIcc({ bytes: upload.bytes, requireCmyk }),
      ),
    );
  });
  app.post("/api/print/profile-assets/template", async (request, reply) => {
    const upload = await uploadedFile(request, 25 * 1024 * 1024, ["geometry"]);
    const fields = templateGeometry(upload.fields);
    return noStore(reply).send(
      await profileAssetBoundary(() =>
        print.profiles.importCoverTemplate({
          bytes: upload.bytes,
          ...fields,
        }),
      ),
    );
  });
}

function registerProjectRoutes(
  app: FastifyInstance,
  print: PrintRuntime,
  library: LibraryService,
): void {
  app.get("/api/print/projects/:id", (request, reply) => {
    const scope = scopeFromQuery(library, request.query);
    return noStore(reply).send(
      print.workspace.project(scope, idParams.parse(request.params).id),
    );
  });
  app.post("/api/print/projects/:id/profile", (request, reply) => {
    const scope = scopeFromQuery(library, request.query);
    const projectId = idParams.parse(request.params).id;
    return noStore(reply).send(
      print.profiles.assignProject({
        owner: scope,
        projectId,
        ...assignProfile.parse(request.body),
      }),
    );
  });
}

function registerRunRoutes(
  app: FastifyInstance,
  print: PrintRuntime,
  library: LibraryService,
): void {
  app.post("/api/print/projects/:id/runs", async (request, reply) => {
    const owner = scopeFromQuery(library, request.query);
    const projectId = idParams.parse(request.params).id;
    print.workspace.project(owner, projectId);
    return noStore(reply).send(
      await print.production.start({
        owner,
        projectId,
        ...startRun.parse(request.body),
      }),
    );
  });
  app.post("/api/print/runs/:id/proof", (request, reply) => {
    const owner = scopeFromQuery(library, request.query);
    const runId = idParams.parse(request.params).id;
    return noStore(reply).send(
      print.proofs.act({ owner, runId, ...proofAction.parse(request.body) }),
    );
  });
}

function registerBinaryRoutes(
  app: FastifyInstance,
  print: PrintRuntime,
  library: LibraryService,
): void {
  app.get("/api/print/runs/:id/download/:kind", async (request, reply) => {
    const params = artifactParams.parse(request.params);
    const output = await print.workspace.deliverable(
      scopeFromQuery(library, request.query),
      params.id,
      params.kind,
    );
    return binary(reply, output, "attachment", "application/pdf");
  });
  app.get("/api/print/runs/:id/proof/:kind", async (request, reply) => {
    const params = artifactParams.parse(request.params);
    const output = await print.workspace.proofRaster(
      scopeFromQuery(library, request.query),
      params.id,
      params.kind,
    );
    return binary(
      reply.header("x-hekayati-deliverable", "false"),
      output,
      "inline",
      "image/png",
    );
  });
}

function scopeFromQuery(library: LibraryService, rawQuery: unknown) {
  return library.scopeForFamilyId(scopedQuery.parse(rawQuery).familyId);
}

async function uploadedFile(
  request: FastifyRequest,
  maxBytes: number,
  allowedFields: readonly string[],
): Promise<{ bytes: Buffer; fields: Readonly<Record<string, string>> }> {
  if (!request.isMultipart()) failPrint("PRINTER_PROFILE_ASSET_INVALID");
  try {
    return await consumeUpload(request, maxBytes, allowedFields);
  } catch (error) {
    if (error instanceof PrintError) throw error;
    failPrint("PRINTER_PROFILE_ASSET_INVALID");
  }
}

async function consumeUpload(
  request: FastifyRequest,
  maxBytes: number,
  allowedFields: readonly string[],
): Promise<{ bytes: Buffer; fields: Readonly<Record<string, string>> }> {
  const permitted = new Set(allowedFields);
  const fields: Record<string, string> = {};
  let bytes: Buffer | null = null;
  let fileCount = 0;
  for await (const part of request.parts({
    limits: {
      fields: allowedFields.length,
      files: 2,
      parts: allowedFields.length + 2,
      fileSize: maxBytes,
      fieldSize: 64 * 1024,
      fieldNameSize: 80,
      headerPairs: 100,
    },
  })) {
    if (part.type === "file") {
      fileCount += 1;
      if (part.fieldname !== "file" || fileCount !== 1) {
        part.file.resume();
        failPrint("PRINTER_PROFILE_ASSET_INVALID");
      }
      const candidate = await part.toBuffer();
      if (
        part.file.truncated ||
        candidate.length === 0 ||
        candidate.length > maxBytes
      )
        failPrint("PRINTER_PROFILE_ASSET_INVALID");
      bytes = candidate;
      continue;
    }
    if (
      !permitted.has(part.fieldname) ||
      Object.hasOwn(fields, part.fieldname) ||
      part.fieldnameTruncated ||
      part.valueTruncated ||
      typeof part.value !== "string"
    )
      failPrint("PRINTER_PROFILE_ASSET_INVALID");
    fields[part.fieldname] = part.value;
  }
  if (!bytes || fileCount !== 1) failPrint("PRINTER_PROFILE_ASSET_INVALID");
  return { bytes, fields };
}

function requiredBoolean(
  fields: Readonly<Record<string, string>>,
  name: string,
): boolean {
  const value = fields[name];
  if (value !== "true" && value !== "false")
    failPrint("PRINTER_PROFILE_ASSET_INVALID");
  return value === "true";
}

function templateGeometry(fields: Readonly<Record<string, string>>) {
  const value = fields.geometry;
  if (!value) failPrint("PRINTER_PROFILE_ASSET_INVALID");
  try {
    return templateFields.parse(JSON.parse(value));
  } catch (error) {
    if (error instanceof PrintError) throw error;
    failPrint("PRINTER_PROFILE_ASSET_INVALID");
  }
}

async function profileAssetBoundary<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (
      error instanceof IccInspectionError ||
      error instanceof CoverTemplateInspectionError
    )
      failPrint("PRINTER_PROFILE_ASSET_INVALID");
    throw error;
  }
}

function binary(
  reply: FastifyReply,
  output: { bytes: Buffer; filename: string },
  disposition: "inline" | "attachment",
  mime: string,
) {
  return noStore(reply)
    .header(
      "content-disposition",
      `${disposition}; filename="${output.filename}"`,
    )
    .header("x-content-type-options", "nosniff")
    .type(mime)
    .send(output.bytes);
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header("cache-control", "private, no-store");
}

function isPrintRequest(url: string): boolean {
  const path = url.split("?", 1)[0];
  return path === "/api/print" || path.startsWith("/api/print/");
}

function region() {
  return z
    .object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      width: z.number().positive().max(1),
      height: z.number().positive().max(1),
    })
    .strict();
}

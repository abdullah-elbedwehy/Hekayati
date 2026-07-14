import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { PhotoIntakeError } from "../../assets/photo-intake/index.js";
import type {
  PhotoStageOwner,
  PhotoIntakeCoordinator,
} from "../photo-intake/photo-intake-coordinator.js";

const kindSchema = z.enum(["face", "full_body", "clothing", "other"]);
const ownerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("character"), characterId: z.string() }).strict(),
  z
    .object({
      type: z.literal("look"),
      characterId: z.string(),
      lookId: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("new_character"),
      draft: z.record(z.string(), z.unknown()),
    })
    .strict(),
]);

const observationsSchema = z
  .object({
    peopleCount: z.number().int().min(0).max(20).optional(),
    obstruction: z.string().trim().max(240).optional(),
    filterSuspected: z.boolean().optional(),
    apparentAgeBand: z.string().trim().max(240).optional(),
    hair: z.string().trim().max(240).optional(),
    clothing: z.string().trim().max(240).optional(),
  })
  .strict();

const rectangleSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict();

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const commitSchema = z
  .object({
    reservationToken: tokenSchema,
    subjectSelection: rectangleSchema.optional(),
    subjectSelectionConfirmed: z.boolean().optional(),
    intendedPersonConfirmed: z.boolean().optional(),
    observations: observationsSchema,
    duplicateDecision: z.discriminatedUnion("action", [
      z.object({ action: z.literal("create_separate") }).strict(),
      z
        .object({
          action: z.literal("open_existing"),
          characterId: z.string(),
        })
        .strict(),
    ]),
  })
  .strict();
const cancelSchema = z.object({ reservationToken: tokenSchema }).strict();
const previewParamSchema = z.object({ previewId: z.string().uuid() }).strict();

export function registerPhotoIntakeApi(
  app: FastifyInstance,
  coordinator: PhotoIntakeCoordinator,
): void {
  app.post("/api/library/photo-intake/stage", async (request) =>
    stageMultipart(request, coordinator),
  );
  app.post("/api/library/photo-intake/commit", (request) =>
    coordinator.commit(commitSchema.parse(request.body)),
  );
  app.post("/api/library/photo-intake/cancel", (request, reply) => {
    coordinator.cancel(cancelSchema.parse(request.body).reservationToken);
    return reply.code(204).send();
  });
  app.get("/api/library/photo-intake/previews/:previewId", (request, reply) => {
    const { previewId } = previewParamSchema.parse(request.params);
    const preview = coordinator.preview(previewId);
    return reply
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff")
      .type(preview.mime)
      .send(preview.bytes);
  });
  app.addHook("onClose", () => coordinator.close());
}

async function stageMultipart(
  request: FastifyRequest,
  coordinator: PhotoIntakeCoordinator,
) {
  if (!request.isMultipart())
    throw new PhotoIntakeError("PHOTO_UNSUPPORTED_TYPE");
  const part = await request.file({
    limits: {
      fieldNameSize: 80,
      fieldSize: 64 * 1024,
      fields: 3,
      fileSize: coordinator.currentMaxBytes() + 1,
      files: 1,
      headerPairs: 100,
      parts: 4,
    },
  });
  if (!part || part.fieldname !== "file")
    throw new PhotoIntakeError("PHOTO_UNSUPPORTED_TYPE");
  const familyId = fieldValue(part.fields.familyId);
  const kind = kindSchema.parse(fieldValue(part.fields.kind));
  const owner = parseOwner(fieldValue(part.fields.owner));
  const result = await coordinator.stage({
    source: part.file,
    familyId,
    kind,
    owner,
  });
  if (part.file.truncated) {
    coordinator.cancel(result.reservationToken);
    throw new PhotoIntakeError("PHOTO_FILE_TOO_LARGE");
  }
  return result;
}

function parseOwner(value: string): PhotoStageOwner {
  try {
    return ownerSchema.parse(JSON.parse(value)) as PhotoStageOwner;
  } catch {
    throw new PhotoIntakeError("PHOTO_DECODE_FAILED");
  }
}

function fieldValue(field: unknown): string {
  if (
    !field ||
    typeof field !== "object" ||
    !("type" in field) ||
    field.type !== "field" ||
    !("value" in field) ||
    typeof field.value !== "string" ||
    ("valueTruncated" in field && field.valueTruncated === true)
  )
    throw new PhotoIntakeError("PHOTO_DECODE_FAILED");
  return field.value;
}

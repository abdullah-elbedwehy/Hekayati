import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  settingsUpdateSchema,
  type SettingsService,
} from "../../domain/settings/settings.js";
import type { ProviderTargetChangeCoordinator } from "../../jobs/provider-target-change.js";

const confirmSchema = z
  .object({
    update: settingsUpdateSchema,
    expectedSettingsUpdatedAt: z.iso.datetime(),
    impactHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export function registerSettingsApi(
  app: FastifyInstance,
  settings: SettingsService,
  targetChanges: ProviderTargetChangeCoordinator,
): void {
  app.get("/api/settings", (_request, reply) => {
    noStore(reply);
    return settings.get();
  });

  app.put("/api/settings", (request, reply) => {
    noStore(reply);
    return targetChanges.save(settingsUpdateSchema.parse(request.body));
  });

  app.post("/api/settings/target-change/preview", (request, reply) => {
    noStore(reply);
    return targetChanges.preview(settingsUpdateSchema.parse(request.body));
  });

  app.post("/api/settings/target-change/confirm", (request, reply) => {
    noStore(reply);
    return targetChanges.confirm(confirmSchema.parse(request.body));
  });
}

function noStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
}

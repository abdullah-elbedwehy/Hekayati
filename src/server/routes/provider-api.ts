import type { FastifyInstance, FastifyReply } from "fastify";

import type { ProviderService } from "../providers/provider-service.js";

export function registerProviderApi(
  app: FastifyInstance,
  providers: ProviderService,
): void {
  app.get("/api/providers/status", async (_request, reply) => {
    noStore(reply);
    return providers.status();
  });

  app.post("/api/providers/:providerId/test", async (request, reply) => {
    noStore(reply);
    const params = request.params as { providerId?: unknown };
    return providers.test(params.providerId);
  });

  app.get("/api/providers/gemini/credential", async (_request, reply) => {
    noStore(reply);
    return providers.credentialStatus();
  });

  app.put("/api/providers/gemini/credential", async (request, reply) => {
    noStore(reply);
    return providers.saveCredential(request.body);
  });

  app.delete("/api/providers/gemini/credential", async (_request, reply) => {
    noStore(reply);
    return providers.deleteCredential();
  });

  app.post("/api/providers/prompt-policy/check", (request, reply) => {
    noStore(reply);
    return providers.checkPrompt(request.body);
  });

  app.post("/api/providers/prompt-policy/confirm", (request, reply) => {
    noStore(reply);
    return providers.confirmPrompt(request.body);
  });
}

function noStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
}

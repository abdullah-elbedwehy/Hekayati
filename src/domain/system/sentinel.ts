import { z } from "zod";

import {
  DocumentRepository,
  type DocumentStore,
} from "../repository/document-store.js";

const sentinelSchema = z
  .object({
    id: z.literal("security_sentinel"),
    schemaVersion: z.literal(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    value: z.number().int().nonnegative(),
  })
  .strict();

type SentinelDocument = z.infer<typeof sentinelSchema>;

export class SecuritySentinel {
  private readonly repository: DocumentRepository<SentinelDocument>;

  constructor(private readonly store: DocumentStore) {
    this.repository = new DocumentRepository(
      store,
      "system_state",
      sentinelSchema,
    );
  }

  value(): number {
    return this.repository.get("security_sentinel")?.value ?? 0;
  }

  increment(): number {
    return this.store.transaction(() => {
      const current = this.repository.get("security_sentinel");
      const now = new Date().toISOString();
      const next = sentinelSchema.parse({
        id: "security_sentinel",
        schemaVersion: 1,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
        value: (current?.value ?? 0) + 1,
      });
      this.repository.put(next);
      return next.value;
    });
  }
}

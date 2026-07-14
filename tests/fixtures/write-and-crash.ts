import { z } from "zod";

import {
  DocumentRepository,
  DocumentStore,
} from "../../src/domain/repository/document-store.js";

const schema = z
  .object({
    id: z.string(),
    schemaVersion: z.literal(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    value: z.string(),
  })
  .strict();

const database = process.argv[2];
if (!database) process.exit(2);
const now = new Date().toISOString();
const store = new DocumentStore(database);
const repository = new DocumentRepository(store, "crash_fixture", schema);
repository.put({
  id: "durable",
  schemaVersion: 1,
  createdAt: now,
  updatedAt: now,
  value: "committed-before-kill",
});
process.kill(process.pid, "SIGKILL");

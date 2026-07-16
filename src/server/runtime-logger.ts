import { join } from "node:path";

import type { DocumentStore } from "../domain/repository/document-store.js";
import {
  createFileLogSink,
  Redactor,
  StructuredLogger,
} from "../security/log.js";

export function createRuntimeLogger(
  logsDirectory: string,
  store: DocumentStore,
): StructuredLogger {
  return new StructuredLogger(
    createFileLogSink(join(logsDirectory, "app.log")),
    new Redactor(store.secretRegistry),
  );
}

import type { DocumentStore } from "../../domain/repository/document-store.js";

export interface SeedTemplateInstaller {
  install(store: DocumentStore): Promise<void> | void;
}

export const deferredSeedTemplateInstaller: SeedTemplateInstaller = {
  install: () => undefined,
};

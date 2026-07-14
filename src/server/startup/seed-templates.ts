import type { DocumentStore } from "../../domain/repository/document-store.js";
import { installSeedTemplates } from "../../domain/authoring/index.js";

export interface SeedTemplateInstaller {
  install(store: DocumentStore): Promise<void> | void;
}

export const productionSeedTemplateInstaller: SeedTemplateInstaller = {
  install: (store) => installSeedTemplates(store),
};

import type { AssetStore } from "../assets/asset-store.js";
import type { ApprovedBookSnapshotReader } from "../domain/layout/approvals.js";
import type { CreativeInvalidationService } from "../domain/creative/invalidation.js";
import {
  ConvertedProofService,
  PrinterProfileService,
  PrintInvalidationParticipant,
  PrintProductionService,
  PrintWorkspaceService,
} from "../domain/print/index.js";
import type { DocumentStore } from "../domain/repository/document-store.js";
import {
  createPrintProducerDefinitions,
  type CmykConverterPort,
  type PrintRendererPort,
} from "../jobs/print-definitions.js";
import { createPrintPreflightDefinition } from "../jobs/print-preflight-definition.js";
import type { JobRuntime } from "../jobs/runtime.js";
import type { RegisteredJobDefinition } from "../jobs/types.js";
import { PrintDocumentCompiler } from "../pdf/print-document-compiler.js";
import type { preflightPrintBundle } from "../pdf/print-preflight.js";

export interface PrintRuntime {
  profiles: PrinterProfileService;
  production: PrintProductionService;
  proofs: ConvertedProofService;
  workspace: PrintWorkspaceService;
  invalidation: PrintInvalidationParticipant;
}

export interface PrintProductionHolder {
  production: PrintProductionService | null;
}

export interface PrintJobPorts {
  renderer?: PrintRendererPort;
  cmyk?: CmykConverterPort;
  preflight?: typeof preflightPrintBundle;
}

export function createPrintJobDefinitions(input: {
  store: DocumentStore;
  assets: AssetStore;
  holder: PrintProductionHolder;
  ports?: PrintJobPorts;
}): RegisteredJobDefinition[] {
  const compiler = new PrintDocumentCompiler(input.store, input.assets);
  const production = () => {
    if (!input.holder.production) throw new Error("PRINT_RUNTIME_NOT_READY");
    return input.holder.production;
  };
  return [
    ...createPrintProducerDefinitions({
      production,
      compiler: () => compiler,
      assets: input.assets,
      renderer: input.ports?.renderer,
      cmyk: input.ports?.cmyk,
    }),
    createPrintPreflightDefinition({
      store: input.store,
      assets: input.assets,
      production,
      preflight: input.ports?.preflight,
    }),
  ];
}

export function createPrintRuntime(input: {
  store: DocumentStore;
  assets: AssetStore;
  jobs: JobRuntime;
  approvedSnapshots: ApprovedBookSnapshotReader;
  invalidation: CreativeInvalidationService;
  holder: PrintProductionHolder;
}): PrintRuntime {
  const production = new PrintProductionService(
    input.store,
    input.assets,
    input.jobs.scheduler,
    input.approvedSnapshots,
  );
  input.holder.production = production;
  return {
    profiles: new PrinterProfileService(input.store, input.assets, {
      invalidation: input.invalidation,
    }),
    production,
    proofs: new ConvertedProofService(
      input.store,
      input.assets,
      input.jobs.scheduler,
    ),
    workspace: new PrintWorkspaceService(
      input.store,
      input.assets,
      input.jobs.scheduler,
      production,
    ),
    invalidation: new PrintInvalidationParticipant(
      input.store,
      input.assets,
      input.jobs.scheduler,
    ),
  };
}

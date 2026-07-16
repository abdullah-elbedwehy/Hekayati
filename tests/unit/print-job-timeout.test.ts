import { describe, expect, it } from "vitest";

import type { AssetStore } from "../../src/assets/asset-store.js";
import type { PrintProductionService } from "../../src/domain/print/workflow.js";
import type { DocumentStore } from "../../src/domain/repository/document-store.js";
import {
  createPrintProducerDefinitions,
  type PrintCompilerPort,
  type PrintRendererPort,
} from "../../src/jobs/print-definitions.js";
import { createPrintPreflightDefinition } from "../../src/jobs/print-preflight-definition.js";
import type { JobRecord } from "../../src/jobs/schemas.js";
import type { PrintInteriorDocument } from "../../src/pdf/print-document.js";

describe("print job timeout boundaries", () => {
  it("classifies a renderer-triggered abort as timeout rather than stale", async () => {
    const controller = new AbortController();
    const renderer: PrintRendererPort = {
      interior: async () => {
        controller.abort();
        return renderResult();
      },
      cover: async () => ({
        ...renderResult(),
        panelOrder: ["back", "spine", "front"],
      }),
    };
    const definition = createPrintProducerDefinitions({
      production: unavailableProduction,
      compiler: () => ({}) as PrintCompilerPort,
      assets: {} as AssetStore,
      renderer,
    }).find((candidate) => candidate.jobType === "print_interior");
    if (!definition) throw new Error("PRINT_INTERIOR_DEFINITION_MISSING");

    const result = await definition.execute({
      job: {} as JobRecord,
      prepared: {
        kind: "interior",
        context: {},
        document: {} as PrintInteriorDocument,
      },
      signal: controller.signal,
      timeoutMs: 10,
    });

    expect(result).toMatchObject({
      ok: false,
      failure: { category: "timeout" },
    });
  });

  it("short-circuits an already-aborted preflight without stale access", async () => {
    const controller = new AbortController();
    controller.abort();
    const definition = createPrintPreflightDefinition({
      store: {} as DocumentStore,
      assets: {} as AssetStore,
      production: unavailableProduction,
    });

    const result = await definition.execute({
      job: {} as JobRecord,
      prepared: null,
      signal: controller.signal,
      timeoutMs: 10,
    });

    expect(result).toMatchObject({
      ok: false,
      failure: { category: "timeout" },
    });
  });
});

function unavailableProduction(): PrintProductionService {
  throw new Error("UNEXPECTED_PRINT_PRODUCTION_ACCESS");
}

function renderResult() {
  return {
    pdfBytes: Buffer.from("synthetic-timeout-pdf"),
    pageCount: 1,
    egressRequestCount: 0 as const,
    blockedRequests: [],
    overflowPageNumbers: [],
    watermarkCount: 0 as const,
    minimumImagePpi: 300,
    fontNames: ["Hekayati Arabic", "Hekayati Brand"],
    rendererVersion: "synthetic-timeout-renderer",
    fontPolicyVersion: "hekayati.print-fonts.v1" as const,
    renderFactsHash: "f".repeat(64),
  };
}

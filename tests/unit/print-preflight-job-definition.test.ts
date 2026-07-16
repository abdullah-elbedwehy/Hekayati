import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AssetStore } from "../../src/assets/asset-store.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { JobError } from "../../src/jobs/errors.js";
import { createPrintPreflightDefinition } from "../../src/jobs/print-preflight-definition.js";
import type { EnqueueJobInput } from "../../src/jobs/types.js";
import { temporaryDirectory } from "../helpers/temp.js";

const projectId = "01J00000000000000000000001";
const hash = "a".repeat(64);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("print preflight job definition boundaries", () => {
  it("rejects every malformed enqueue boundary independently", async () => {
    const fixture = await definitionFixture();
    const valid = validInput();
    expect(() => fixture.definition.validateEnqueue(valid)).not.toThrow();

    const invalidInputs: EnqueueJobInput[] = [
      {
        ...valid,
        target: {
          providerId: "mock",
          modelId: "model",
          operation: "image",
          settingsHash: hash,
        },
      },
      { ...valid, projectId: null },
      {
        ...valid,
        request: {
          kind: "human_gate",
          gateKind: "approval",
          targetId: projectId,
          targetVersionId: projectId,
        },
      },
      ...Object.keys(valid.inputSnapshot).map((key) => ({
        ...valid,
        inputSnapshot: { ...valid.inputSnapshot, [key]: "" },
      })),
    ];

    for (const invalid of invalidInputs)
      expect(() => fixture.definition.validateEnqueue(invalid)).toThrowError(
        expect.objectContaining({ code: "JOB_REQUEST_SCHEMA_INVALID" }),
      );
    fixture.close();
  });

  it("maps abort, domain, schema, exact, and unknown failures safely", async () => {
    const fixture = await definitionFixture();
    const normalize = fixture.definition.normalizeError;
    if (!normalize) throw new Error("EXPECTED_PREFLIGHT_NORMALIZER");

    const abort = new Error("stopped");
    abort.name = "AbortError";
    expect(normalize(abort)).toMatchObject({ category: "timeout" });
    expect(normalize(new Error("ABORT_ERR"))).toMatchObject({
      category: "timeout",
    });
    expect(normalize(new JobError("PRINT_PREFLIGHT_STALE"))).toMatchObject({
      category: "stale_dependency",
      reasonCode: "PRINT_PREFLIGHT_STALE",
    });
    expect(normalize(new JobError("JOB_REQUEST_SCHEMA_INVALID"))).toMatchObject(
      {
        category: "invalid_input",
        reasonCode: "JOB_REQUEST_SCHEMA_INVALID",
      },
    );
    expect(normalize(zodLikeError("PRINT_EXACT_SCHEMA_REASON"))).toMatchObject({
      reasonCode: "PRINT_EXACT_SCHEMA_REASON",
    });
    expect(
      normalize(zodLikeError("invalid", ["firstUnsafeWord"])),
    ).toMatchObject({
      reasonCode: "PRINT_PREFLIGHT_UNSAFE_WORD_FACTS_INVALID",
    });
    expect(normalize(zodLikeError("invalid", ["textBounds"]))).toMatchObject({
      reasonCode: "PRINT_PREFLIGHT_TEXT_BOUNDS_FACTS_INVALID",
    });
    expect(normalize(zodLikeError("invalid", ["coverSpread"]))).toMatchObject({
      reasonCode: "PRINT_PREFLIGHT_COVER_SPREAD_FACTS_INVALID",
    });
    expect(normalize(zodLikeError("invalid"))).toMatchObject({
      reasonCode: "PRINT_PREFLIGHT_REPORT_SCHEMA_INVALID",
    });
    expect(normalize(new Error("PRINT_RENDER_FAILED"))).toMatchObject({
      reasonCode: "PRINT_RENDER_FAILED",
    });
    expect(normalize(new Error("unsafe provider detail"))).toMatchObject({
      reasonCode: "PRINT_PREFLIGHT_FAILED",
    });
    fixture.close();
  });
});

function validInput(): EnqueueJobInput {
  return {
    jobType: "print_preflight",
    projectId,
    standaloneScopeId: null,
    dependsOn: [],
    priority: 1,
    intentId: "print-preflight",
    target: null,
    request: { kind: "local", payloadHash: hash },
    inputSnapshot: {
      runId: projectId,
      interiorArtifactId: projectId,
      interiorChecksum: hash,
      coverArtifactId: projectId,
      coverChecksum: hash,
      contentAuthorizationHash: hash,
      printerProfileHash: hash,
    },
  };
}

function zodLikeError(message: string, path: string[] = []): Error {
  const error = new Error("synthetic schema failure") as Error & {
    issues: Array<{ message: string; path: string[] }>;
  };
  error.name = "ZodError";
  error.issues = [{ message, path }];
  return error;
}

async function definitionFixture() {
  const directory = await temporaryDirectory("hekayati-preflight-definition-");
  cleanups.push(directory.cleanup);
  const store = new DocumentStore(join(directory.path, "hekayati.db"));
  const definition = createPrintPreflightDefinition({
    store,
    assets: {} as AssetStore,
    production: () => {
      throw new Error("UNEXPECTED_PREFLIGHT_PRODUCTION_ACCESS");
    },
  });
  return {
    definition,
    close: () => store.close(),
  };
}

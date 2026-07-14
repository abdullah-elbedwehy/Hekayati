import {
  imageResultSchema,
  providerCapabilitiesSchema,
  resolvedImageRequestSchema,
  structuredRequestSchema,
  textRequestSchema,
  textResultSchema,
  type AiProvider,
  type CallControl,
  type ImageResult,
  type ProviderCapabilities,
  type ProviderResult,
  type ResolvedImageRequest,
  type StructuredRequest,
  type TextRequest,
  type TextResult,
} from "../contract.js";
import { makeFailure } from "../failures.js";
import type { GenerationTaskV1 } from "../generation-task.js";
import { compileProviderPrompt } from "../prompt/compiler.js";
import { parseStructuredOutput } from "../structured-outputs.js";
import { canonicalJson, createProvenance } from "../provenance.js";
import {
  deterministicHash,
  deterministicImageHash,
  deterministicPng,
  deterministicStructuredFixture,
} from "./deterministic-fixtures.js";
import { MockFaultScript, runFaultDelay } from "./fault-script.js";

export interface MockProviderOptions {
  clock?: () => Date;
  faults?: MockFaultScript;
  settings?: unknown;
  structuredFixture?: MockStructuredFixture;
}

export type MockStructuredFixture = (
  task: GenerationTaskV1,
  hash: string,
) => unknown;

export class MockProvider implements AiProvider {
  readonly providerId = "mock" as const;
  private readonly clock: () => Date;
  private readonly faults: MockFaultScript;
  private readonly settings: unknown;
  private readonly structuredFixture: MockStructuredFixture;

  constructor(options: MockProviderOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.faults = options.faults ?? new MockFaultScript();
    this.settings = options.settings ?? { provider: "mock" };
    this.structuredFixture =
      options.structuredFixture ?? deterministicStructuredFixture;
  }

  getCapabilities(): Promise<ProviderCapabilities> {
    return Promise.resolve(this.capabilities());
  }

  testConnection(): Promise<
    | { ok: true; capabilities: ProviderCapabilities }
    | {
        ok: false;
        failure: ReturnType<typeof makeFailure>;
      }
  > {
    const fault = this.faults.take("connection");
    if (fault?.category) {
      return Promise.resolve({
        ok: false,
        failure: makeFailure(fault.category),
      });
    }
    return Promise.resolve({ ok: true, capabilities: this.capabilities() });
  }

  async generateText(
    requestInput: TextRequest,
    control: CallControl,
  ): Promise<ProviderResult<TextResult>> {
    const parsed = textRequestSchema.safeParse(requestInput);
    if (!parsed.success) return invalidInput();
    const failure = await runFaultDelay(this.faults.take("text"), control);
    if (failure) return { ok: false, failure };
    const hash = deterministicHash(parsed.data);
    const value = textResultSchema.parse({
      text: `نص تجريبي ثابت ${hash.slice(0, 16)}`,
    });
    return { ok: true, value, provenance: this.provenance(parsed.data, hash) };
  }

  async generateStructured<T>(
    requestInput: StructuredRequest,
    control: CallControl,
  ): Promise<ProviderResult<T>> {
    const parsed = structuredRequestSchema.safeParse(requestInput);
    if (!parsed.success) return invalidInput();
    const compiled = compileProviderPrompt({
      provider: "mock",
      styleId:
        parsed.data.task.schemaId === "PagePrompt"
          ? parsed.data.task.payload.styleId
          : "modern_cartoon",
      prompt: canonicalJson(parsed.data.task),
    });
    if (!compiled.ok) return compiled;
    const fault = this.faults.take("structured");
    const failure = await runFaultDelay(fault, control);
    if (failure) return { ok: false, failure };
    const hash = deterministicHash(parsed.data);
    const raw =
      fault?.rawStructured ??
      JSON.stringify(this.structuredFixture(parsed.data.task, hash));
    const output = parseStructuredOutput(
      parsed.data.schemaId,
      raw,
      parsed.data.task,
    );
    if (!output.ok) return output;
    return {
      ok: true,
      value: output.value as T,
      provenance: this.provenance(parsed.data, hash),
    };
  }

  async generateImage(
    requestInput: ResolvedImageRequest,
    control: CallControl,
  ): Promise<ProviderResult<ImageResult>> {
    const parsed = resolvedImageRequestSchema.safeParse(requestInput);
    if (!parsed.success) return invalidInput();
    const compiled = compileProviderPrompt({
      provider: "mock",
      styleId: parsed.data.styleId,
      prompt: canonicalJson({
        scene: parsed.data.scene,
        negativeConstraints: parsed.data.negativeConstraints,
      }),
    });
    if (!compiled.ok) return compiled;
    const failure = await runFaultDelay(this.faults.take("image"), control);
    if (failure) return { ok: false, failure };
    const hash = deterministicImageHash(parsed.data);
    const value = imageResultSchema.parse({
      imageBytes: deterministicPng(hash),
      mime: "image/png",
      providerMeta: {
        responseId: hash.slice(0, 24),
        modelVersion: "mock-image-v1",
        finishReason: "fixture",
      },
    });
    return {
      ok: true,
      value,
      provenance: this.provenance(
        parsed.data,
        hash,
        parsed.data.referenceImages.map((item) => item.provenanceAssetId),
        "mock-image-v1",
      ),
    };
  }

  private capabilities(): ProviderCapabilities {
    return providerCapabilitiesSchema.parse({
      providerId: "mock",
      checkedAt: this.clock().toISOString(),
      source: "fixture",
      auth: { state: "ok", detail: "المزوّد التجريبي جاهز محليًا" },
      text: { available: true, structured: true, modelId: "mock-v1" },
      image: {
        available: true,
        modelId: "mock-image-v1",
        maxReferenceImages: 20,
        reliableCharacterCount: 20,
        economyTier: false,
      },
      limits: { concurrencySuggested: 4 },
    });
  }

  private provenance(
    input: unknown,
    hash: string,
    referenceAssetIds: string[] = [],
    modelId = "mock-v1",
  ) {
    const task = structuredRequestSchema.safeParse(input).success
      ? structuredRequestSchema.parse(input).task
      : textRequestSchema.safeParse(input).success
        ? textRequestSchema.parse(input).task
        : null;
    return createProvenance({
      provider: "mock",
      modelId,
      at: this.clock().toISOString(),
      inputVersionRefs: task?.inputVersionRefs ?? {},
      promptVersion: `mock-v1-${hash.slice(0, 16)}`,
      referenceAssetIds,
      attempt: 1,
      settings: this.settings,
    });
  }
}

function invalidInput<T>(): ProviderResult<T> {
  return { ok: false, failure: makeFailure("invalid_input") };
}

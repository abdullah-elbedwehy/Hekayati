import { z } from "zod";

import {
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
import { makeFailure, type NormalizedFailure } from "../failures.js";
import { compileProviderPrompt } from "../prompt/compiler.js";
import { canonicalJson, createProvenance } from "../provenance.js";
import {
  parseStructuredOutput,
  providerJsonSchema,
} from "../structured-outputs.js";
import {
  GoogleGenAiTransport,
  type GeminiGenerateRequest,
  type GeminiModelInfo,
  type GeminiTransport,
  type GeminiTransportResponse,
} from "./client.js";
import { controlledGeminiCall, type ControlledResult } from "./control.js";
import { parseGeminiImage, parseGeminiText } from "./output-parser.js";

const modelId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/)
  .max(160);

const configurationSchema = z
  .object({
    textModelId: modelId,
    imageModelId: modelId,
    economyImageModelId: modelId,
    imageTier: z.enum(["default", "economy"]),
    maxReferenceImages: z.number().int().positive().max(100).nullable(),
    reliableCharacterCount: z.number().int().positive().max(20).nullable(),
  })
  .strict();

export type GeminiConfiguration = z.infer<typeof configurationSchema>;

export interface GeminiCredentialReader {
  read(): Promise<string | null>;
}

export interface GeminiProviderOptions {
  credential: GeminiCredentialReader;
  transport?: GeminiTransport;
  configuration: () => GeminiConfiguration;
  settings?: () => unknown;
  clock?: () => Date;
}

export class GeminiProvider implements AiProvider {
  readonly providerId = "gemini" as const;
  private readonly transport: GeminiTransport;
  private readonly clock: () => Date;

  constructor(private readonly options: GeminiProviderOptions) {
    this.transport = options.transport ?? new GoogleGenAiTransport();
    this.clock = options.clock ?? (() => new Date());
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    const configuration = configurationSchema.parse(
      this.options.configuration(),
    );
    const key = await this.readCredential();
    if (!key.ok) return this.missingCapabilities(configuration, key.failure);
    const imageModelId = selectedImageModel(configuration);
    const control = internalControl(10_000);
    const [textProbe, imageProbe, structuredProbe] = await Promise.all([
      controlledGeminiCall(control, (signal) =>
        this.transport.getModel(key.value, configuration.textModelId, signal),
      ),
      controlledGeminiCall(control, (signal) =>
        this.transport.getModel(key.value, imageModelId, signal),
      ),
      controlledGeminiCall(control, (signal) =>
        this.transport.generate(
          key.value,
          structuredProbeRequest(configuration.textModelId),
          signal,
        ),
      ),
    ]);
    return this.capabilitiesFromProbes(
      configuration,
      textProbe,
      imageProbe,
      structuredProbe,
    );
  }

  async testConnection() {
    const capabilities = await this.getCapabilities();
    if (capabilities.text.available) return { ok: true as const, capabilities };
    const category =
      capabilities.auth.state === "missing" ||
      capabilities.auth.state === "expired"
        ? "invalid_credentials"
        : "provider_unavailable";
    return { ok: false as const, failure: makeFailure(category) };
  }

  async generateText(
    input: TextRequest,
    control: CallControl,
  ): Promise<ProviderResult<TextResult>> {
    const request = textRequestSchema.safeParse(input);
    if (!request.success) return invalidInput();
    const compiled = compileTaskPrompt(request.data.task);
    if (!compiled.ok) return compiled;
    const configuration = configurationSchema.parse(
      this.options.configuration(),
    );
    const response = await this.callWithCredential(
      {
        modelId: configuration.textModelId,
        contents: [{ text: compiled.prompt }],
        responseMimeType: "text/plain",
      },
      control,
    );
    if (!response.ok) return response;
    if (!modelMatches(response.value.modelVersion, configuration.textModelId)) {
      return providerUnavailable();
    }
    const output = parseGeminiText(response.value);
    if (!output.ok) return output;
    const value = textResultSchema.safeParse({ text: output.value });
    if (!value.success) return malformed();
    return {
      ok: true,
      value: value.data,
      provenance: this.provenance(
        request.data.task.inputVersionRefs,
        configuration.textModelId,
        compiled.promptVersion,
      ),
    };
  }

  async generateStructured<T>(
    input: StructuredRequest,
    control: CallControl,
  ): Promise<ProviderResult<T>> {
    const request = structuredRequestSchema.safeParse(input);
    if (!request.success) return invalidInput();
    const compiled = compileTaskPrompt(request.data.task);
    if (!compiled.ok) return compiled;
    const configuration = configurationSchema.parse(
      this.options.configuration(),
    );
    const response = await this.callWithCredential(
      {
        modelId: configuration.textModelId,
        contents: [{ text: compiled.prompt }],
        responseMimeType: "application/json",
        responseJsonSchema: providerJsonSchema(request.data.schemaId),
      },
      control,
    );
    if (!response.ok) return response;
    if (!modelMatches(response.value.modelVersion, configuration.textModelId)) {
      return providerUnavailable();
    }
    const output = parseGeminiText(response.value);
    if (!output.ok) return output;
    const parsed = parseStructuredOutput(
      request.data.schemaId,
      output.value,
      request.data.task,
    );
    if (!parsed.ok) return parsed;
    return {
      ok: true,
      value: parsed.value as T,
      provenance: this.provenance(
        request.data.task.inputVersionRefs,
        configuration.textModelId,
        compiled.promptVersion,
      ),
    };
  }

  async generateImage(
    input: ResolvedImageRequest,
    control: CallControl,
  ): Promise<ProviderResult<ImageResult>> {
    const request = resolvedImageRequestSchema.safeParse(input);
    if (!request.success) return invalidInput();
    const configuration = configurationSchema.parse(
      this.options.configuration(),
    );
    const boundaryFailure = imageBoundaryFailure(request.data, configuration);
    if (boundaryFailure) return { ok: false, failure: boundaryFailure };
    const compiled = compileProviderPrompt({
      provider: "gemini",
      styleId: request.data.styleId,
      prompt: canonicalJson({
        scene: request.data.scene,
        negativeConstraints: request.data.negativeConstraints,
      }),
    });
    if (!compiled.ok) return compiled;
    const selectedModel = selectedImageModel(configuration);
    const response = await this.callWithCredential(
      imageTransportRequest(request.data, selectedModel, compiled.prompt),
      control,
    );
    if (!response.ok) return response;
    if (!modelMatches(response.value.modelVersion, selectedModel)) {
      return providerUnavailable();
    }
    const output = await parseGeminiImage(response.value, {
      width: request.data.output.minWidthPx,
      height: request.data.output.minHeightPx,
    });
    if (!output.ok) return output;
    return {
      ok: true,
      value: output.value,
      provenance: this.provenance(
        imageInputVersionRefs(request.data),
        selectedModel,
        compiled.promptVersion,
        request.data.referenceImages.map((item) => item.provenanceAssetId),
      ),
    };
  }

  private async callWithCredential(
    request: GeminiGenerateRequest,
    control: CallControl,
  ): Promise<ControlledResult<GeminiTransportResponse>> {
    const key = await this.readCredential();
    if (!key.ok) return key;
    return controlledGeminiCall(control, (signal) =>
      this.transport.generate(key.value, request, signal),
    );
  }

  private async readCredential(): Promise<
    { ok: true; value: string } | { ok: false; failure: NormalizedFailure }
  > {
    try {
      const key = await this.options.credential.read();
      return key
        ? { ok: true, value: key }
        : { ok: false, failure: makeFailure("invalid_credentials") };
    } catch {
      return { ok: false, failure: makeFailure("invalid_credentials") };
    }
  }

  private capabilitiesFromProbes(
    configuration: GeminiConfiguration,
    textProbe: ControlledResult<GeminiModelInfo>,
    imageProbe: ControlledResult<GeminiModelInfo>,
    structuredProbe: ControlledResult<GeminiTransportResponse>,
  ): ProviderCapabilities {
    const assessment = assessProbes(
      configuration,
      textProbe,
      imageProbe,
      structuredProbe,
    );
    return providerCapabilitiesSchema.parse({
      providerId: "gemini",
      checkedAt: this.clock().toISOString(),
      source: "live",
      auth: probeAuth(assessment.credentialFailure),
      text: textProbeCapability(
        configuration,
        assessment,
        textProbe,
        structuredProbe,
      ),
      image: imageProbeCapability(configuration, assessment, imageProbe),
      limits: { concurrencySuggested: 1 },
      unavailableReason: assessment.credentialFailure
        ? "تعذّر التحقق من مفتاح Gemini."
        : undefined,
    });
  }

  private missingCapabilities(
    configuration: GeminiConfiguration,
    failure: NormalizedFailure,
  ): ProviderCapabilities {
    const imageId = selectedImageModel(configuration);
    return providerCapabilitiesSchema.parse({
      providerId: "gemini",
      checkedAt: this.clock().toISOString(),
      source: "live",
      auth: { state: "missing", detail: "مفتاح Gemini غير محفوظ في Keychain." },
      text: {
        available: false,
        structured: false,
        modelId: configuration.textModelId,
        unavailableReason: failure.message,
      },
      image: {
        available: false,
        modelId: imageId,
        maxReferenceImages: configuration.maxReferenceImages,
        reliableCharacterCount: configuration.reliableCharacterCount,
        economyTier: configuration.imageTier === "economy",
        unavailableReason: failure.message,
      },
      limits: { concurrencySuggested: 1 },
      unavailableReason: failure.message,
    });
  }

  private provenance(
    inputVersionRefs: Record<string, string>,
    modelIdValue: string,
    promptVersion: string,
    referenceAssetIds: string[] = [],
  ) {
    return createProvenance({
      provider: "gemini",
      modelId: modelIdValue,
      at: this.clock().toISOString(),
      inputVersionRefs,
      promptVersion,
      referenceAssetIds,
      attempt: 1,
      settings: this.options.settings?.() ?? this.options.configuration(),
    });
  }
}

function compileTaskPrompt(task: StructuredRequest["task"]) {
  const styleId =
    task.schemaId === "PagePrompt" ? task.payload.styleId : "modern_cartoon";
  return compileProviderPrompt({
    provider: "gemini",
    styleId,
    prompt: [
      "نفّذ المهمة المهيكلة التالية فقط وأعد النتيجة المطلوبة من دون معلومات إضافية.",
      canonicalJson(task),
    ].join("\n"),
  });
}

function selectedImageModel(configuration: GeminiConfiguration): string {
  return configuration.imageTier === "economy"
    ? configuration.economyImageModelId
    : configuration.imageModelId;
}

function assessProbes(
  configuration: GeminiConfiguration,
  textProbe: ControlledResult<GeminiModelInfo>,
  imageProbe: ControlledResult<GeminiModelInfo>,
  structuredProbe: ControlledResult<GeminiTransportResponse>,
) {
  const imageId = selectedImageModel(configuration);
  const textModelAvailable = probeMatches(textProbe, configuration.textModelId);
  return {
    imageId,
    textModelAvailable,
    textAvailable:
      textModelAvailable &&
      structuredProbeMatches(structuredProbe, configuration.textModelId),
    imageModelAvailable: probeMatches(imageProbe, imageId),
    boundariesMeasured:
      configuration.maxReferenceImages !== null &&
      configuration.reliableCharacterCount !== null,
    credentialFailure: [textProbe, imageProbe, structuredProbe].some(
      (probe) => !probe.ok && probe.failure.category === "invalid_credentials",
    ),
  };
}

type ProbeAssessment = ReturnType<typeof assessProbes>;

function probeAuth(credentialFailure: boolean) {
  return {
    state: credentialFailure ? ("expired" as const) : ("ok" as const),
    detail: credentialFailure
      ? "مفتاح Gemini غير صالح أو منتهي."
      : "مفتاح Gemini موجود وفحص النماذج اكتمل.",
  };
}

function textProbeCapability(
  configuration: GeminiConfiguration,
  assessment: ProbeAssessment,
  textProbe: ControlledResult<GeminiModelInfo>,
  structuredProbe: ControlledResult<GeminiTransportResponse>,
) {
  return {
    available: assessment.textAvailable,
    structured: assessment.textAvailable,
    modelId: configuration.textModelId,
    unavailableReason: assessment.textAvailable
      ? undefined
      : !assessment.textModelAvailable
        ? safeProbeReason(textProbe, "نموذج النص المحدد غير متاح.")
        : safeStructuredProbeReason(structuredProbe),
  };
}

function imageProbeCapability(
  configuration: GeminiConfiguration,
  assessment: ProbeAssessment,
  imageProbe: ControlledResult<GeminiModelInfo>,
) {
  return {
    available: assessment.imageModelAvailable && assessment.boundariesMeasured,
    modelId: assessment.imageId,
    maxReferenceImages: configuration.maxReferenceImages,
    reliableCharacterCount: configuration.reliableCharacterCount,
    economyTier: configuration.imageTier === "economy",
    unavailableReason: !assessment.imageModelAvailable
      ? safeProbeReason(imageProbe, "نموذج الصور المحدد غير متاح.")
      : !assessment.boundariesMeasured
        ? "حدود مراجع الصور وعدد الشخصيات لم تُقَس بعد."
        : undefined,
  };
}

function structuredProbeRequest(modelIdValue: string): GeminiGenerateRequest {
  return {
    modelId: modelIdValue,
    contents: [
      { text: 'Return only the JSON object {"probe":"ok"}. No other text.' },
    ],
    responseMimeType: "application/json",
    responseJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: { probe: { type: "string", const: "ok" } },
      required: ["probe"],
    },
  };
}

function imageTransportRequest(
  request: ResolvedImageRequest,
  selectedModel: string,
  prompt: string,
): GeminiGenerateRequest {
  return {
    modelId: selectedModel,
    contents: [
      { text: prompt },
      ...request.referenceImages.map((reference) => ({
        inlineData: {
          mimeType: reference.mime,
          data: Buffer.from(reference.bytes).toString("base64"),
        },
      })),
    ],
    responseModalities: ["Image"],
  };
}

function imageBoundaryFailure(
  request: ResolvedImageRequest,
  configuration: GeminiConfiguration,
): NormalizedFailure | null {
  const { maxReferenceImages, reliableCharacterCount } = configuration;
  if (maxReferenceImages === null || reliableCharacterCount === null) {
    return makeFailure("provider_unavailable", {
      message: "حدود مراجع الصور وعدد الشخصيات لم تُقَس بعد.",
    });
  }
  const participants = new Set(
    request.scene.participants.map((item) => item.characterRef.characterId),
  );
  if (
    request.referenceImages.length > maxReferenceImages ||
    participants.size > reliableCharacterCount
  ) {
    return makeFailure("invalid_input");
  }
  return null;
}

function imageInputVersionRefs(
  request: ResolvedImageRequest,
): Record<string, string> {
  return Object.fromEntries(
    request.referenceImages.map((reference, index) => [
      `character${index + 1}`,
      reference.versionRefs.characterVersionId,
    ]),
  );
}

function probeMatches(
  probe: ControlledResult<GeminiModelInfo>,
  expectedModel: string,
): boolean {
  return (
    probe.ok &&
    normalizeModelName(probe.value.name) === expectedModel &&
    Boolean(
      probe.value.supportedActions?.some(
        (action) => action.toLowerCase() === "generatecontent",
      ),
    )
  );
}

function structuredProbeMatches(
  probe: ControlledResult<GeminiTransportResponse>,
  expectedModel: string,
): boolean {
  if (!probe.ok || !modelMatches(probe.value.modelVersion, expectedModel)) {
    return false;
  }
  const parsedText = parseGeminiText(probe.value);
  if (!parsedText.ok) return false;
  try {
    const parsed = JSON.parse(parsedText.value) as unknown;
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length === 1 &&
      (parsed as { probe?: unknown }).probe === "ok"
    );
  } catch {
    return false;
  }
}

function modelMatches(actual: string | undefined, expected: string): boolean {
  return normalizeModelName(actual) === expected;
}

function normalizeModelName(value: string | undefined): string | null {
  if (!value) return null;
  return value.startsWith("models/") ? value.slice("models/".length) : value;
}

function safeProbeReason(
  probe: ControlledResult<GeminiModelInfo>,
  fallback: string,
): string {
  return probe.ok ? fallback : probe.failure.message;
}

function safeStructuredProbeReason(
  probe: ControlledResult<GeminiTransportResponse>,
): string {
  return probe.ok
    ? "لم يُرجع نموذج النص نتيجة فحص مهيكلة صالحة."
    : probe.failure.message;
}

function internalControl(timeoutMs: number): CallControl {
  return { timeoutMs, signal: new AbortController().signal };
}

function invalidInput<T>(): ProviderResult<T> {
  return { ok: false, failure: makeFailure("invalid_input") };
}

function malformed<T>(): ProviderResult<T> {
  return { ok: false, failure: makeFailure("malformed_output") };
}

function providerUnavailable<T>(): ProviderResult<T> {
  return { ok: false, failure: makeFailure("provider_unavailable") };
}

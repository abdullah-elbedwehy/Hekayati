import {
  providerCapabilitiesSchema,
  structuredRequestSchema,
  textRequestSchema,
  textResultSchema,
  type AiProvider,
  type CallControl,
  type ImageResult,
  type ProviderCapabilities,
  type ProviderResult,
  type StructuredRequest,
  type TextRequest,
  type TextResult,
} from "../contract.js";
import { makeFailure, type FailureCategory } from "../failures.js";
import { compileProviderPrompt } from "../prompt/compiler.js";
import { canonicalJson, createProvenance } from "../provenance.js";
import {
  parseStructuredOutput,
  providerJsonSchema,
} from "../structured-outputs.js";
import { classifyCodexProcess, parseCodexAuth } from "./classify.js";
import {
  CodexProcessRunner,
  type CodexProcessResult,
  type CodexRunner,
} from "./process-runner.js";

const CODEX_IMAGE_REASON =
  "G1-I: إنشاء الصور عبر اشتراك Codex غير متاح في المسار المتحقق منه.";

export interface CodexProviderOptions {
  runner?: CodexRunner;
  modelId: () => string;
  clock?: () => Date;
  settings?: () => unknown;
}

export class CodexProvider implements AiProvider {
  readonly providerId = "codex" as const;
  private readonly runner: CodexRunner;
  private readonly clock: () => Date;

  constructor(private readonly options: CodexProviderOptions) {
    this.runner = options.runner ?? new CodexProcessRunner();
    this.clock = options.clock ?? (() => new Date());
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    const modelId = this.options.modelId();
    const control = internalControl(30_000);
    try {
      const inspection = await this.runner.inspect(control);
      const binaryFailure = classifyCodexProcess(inspection.version);
      if (binaryFailure) return this.unavailableCapabilities(modelId, "binary");
      const authMode = parseCodexAuth(inspection.login);
      if (authMode !== "chatgpt_subscription") {
        return this.unavailableCapabilities(modelId, "auth", authMode);
      }
      const probe = await this.runner.execute(
        {
          modelId,
          prompt: 'Return only the JSON object {"probe":"ok"}. Use no tools.',
          outputSchema: probeSchema(),
        },
        control,
      );
      const failure = classifyCodexProcess(probe);
      const exact = probe.resolvedModel === modelId;
      const valid = validProbe(probe.output);
      return this.capabilities({
        modelId,
        textAvailable: failure === null && exact && valid,
        textReason: failure
          ? safeReason(failure)
          : !exact
            ? "لم يؤكد Codex المعرّف نفسه للنموذج المطلوب."
            : !valid
              ? "لم يُرجع Codex نتيجة فحص صالحة."
              : undefined,
      });
    } catch {
      return this.unavailableCapabilities(modelId, "unknown");
    }
  }

  async testConnection() {
    const capabilities = await this.getCapabilities();
    if (capabilities.text.available) return { ok: true as const, capabilities };
    const category =
      capabilities.auth.state === "missing"
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
    const compilation = compileTaskPrompt(request.data.task);
    if (!compilation.ok) return compilation;
    const modelId = this.options.modelId();
    const result = await this.safeExecute(
      { modelId, prompt: compilation.prompt },
      control,
    );
    const failure = processFailure(result, modelId);
    if (failure) return { ok: false, failure: makeFailure(failure) };
    const value = textResultSchema.safeParse({ text: result.output?.trim() });
    if (!value.success) return malformed();
    return {
      ok: true,
      value: value.data,
      provenance: this.provenance(
        request.data.task.inputVersionRefs,
        modelId,
        compilation.promptVersion,
      ),
    };
  }

  async generateStructured<T>(
    input: StructuredRequest,
    control: CallControl,
  ): Promise<ProviderResult<T>> {
    const request = structuredRequestSchema.safeParse(input);
    if (!request.success) return invalidInput();
    const compilation = compileTaskPrompt(request.data.task);
    if (!compilation.ok) return compilation;
    const modelId = this.options.modelId();
    const result = await this.safeExecute(
      {
        modelId,
        prompt: compilation.prompt,
        outputSchema: providerJsonSchema(request.data.schemaId),
      },
      control,
    );
    const failure = processFailure(result, modelId);
    if (failure) return { ok: false, failure: makeFailure(failure) };
    if (!result.output) return malformed();
    const parsed = parseStructuredOutput(
      request.data.schemaId,
      result.output,
      request.data.task,
    );
    if (!parsed.ok) return parsed;
    return {
      ok: true,
      value: parsed.value as T,
      provenance: this.provenance(
        request.data.task.inputVersionRefs,
        modelId,
        compilation.promptVersion,
      ),
    };
  }

  generateImage(): Promise<ProviderResult<ImageResult>> {
    return Promise.resolve({
      ok: false,
      failure: makeFailure("provider_unavailable", {
        message: CODEX_IMAGE_REASON,
      }),
    });
  }

  private async safeExecute(
    request: Parameters<CodexRunner["execute"]>[0],
    control: CallControl,
  ): Promise<CodexProcessResult> {
    try {
      return await this.runner.execute(request, control);
    } catch {
      return unknownProcessResult();
    }
  }

  private unavailableCapabilities(
    modelId: string,
    reason: "binary" | "auth" | "unknown",
    authMode?: ReturnType<typeof parseCodexAuth>,
  ): ProviderCapabilities {
    const authState = reason === "auth" ? "missing" : "error";
    const authDetail =
      authMode === "api_key_disallowed"
        ? "يلزم تسجيل دخول اشتراك ChatGPT؛ وضع API key غير مسموح."
        : reason === "auth"
          ? "سجّل الدخول إلى Codex باشتراك ChatGPT."
          : "تعذّر تشغيل Codex CLI محليًا.";
    return this.capabilities({
      modelId,
      textAvailable: false,
      textReason: authDetail,
      authState,
      authDetail,
      unavailableReason: authDetail,
    });
  }

  private capabilities(input: {
    modelId: string;
    textAvailable: boolean;
    textReason?: string;
    authState?: "ok" | "missing" | "expired" | "error";
    authDetail?: string;
    unavailableReason?: string;
  }): ProviderCapabilities {
    return providerCapabilitiesSchema.parse({
      providerId: "codex",
      checkedAt: this.clock().toISOString(),
      source: "live",
      auth: {
        state: input.authState ?? "ok",
        detail: input.authDetail ?? "تسجيل دخول اشتراك ChatGPT صالح.",
      },
      text: {
        available: input.textAvailable,
        structured: input.textAvailable,
        modelId: input.modelId,
        unavailableReason: input.textReason,
      },
      image: {
        available: false,
        maxReferenceImages: null,
        reliableCharacterCount: null,
        economyTier: false,
        unavailableReason: CODEX_IMAGE_REASON,
      },
      limits: { concurrencySuggested: 1 },
      unavailableReason: input.unavailableReason,
    });
  }

  private provenance(
    inputVersionRefs: Record<string, string>,
    modelId: string,
    promptVersion: string,
  ) {
    return createProvenance({
      provider: "codex",
      modelId,
      at: this.clock().toISOString(),
      inputVersionRefs,
      promptVersion,
      referenceAssetIds: [],
      attempt: 1,
      settings: this.options.settings?.() ?? { provider: "codex", modelId },
    });
  }
}

function compileTaskPrompt(task: StructuredRequest["task"]) {
  const styleId =
    task.schemaId === "PagePrompt" ? task.payload.styleId : "modern_cartoon";
  return compileProviderPrompt({
    provider: "codex",
    styleId,
    prompt: [
      "نفّذ المهمة المهيكلة التالية فقط. لا تستخدم أدوات أو ملفات أو شبكة.",
      canonicalJson(task),
    ].join("\n"),
  });
}

function processFailure(
  result: CodexProcessResult,
  modelId: string,
): FailureCategory | null {
  const classified = classifyCodexProcess(result);
  if (classified) return classified;
  if (result.outputTruncated) return "malformed_output";
  if (result.resolvedModel !== modelId) return "provider_unavailable";
  return null;
}

function safeReason(category: FailureCategory): string {
  return makeFailure(category).message;
}

function validProbe(output: string | undefined): boolean {
  try {
    const parsed = JSON.parse(output ?? "") as unknown;
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

function probeSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: { probe: { type: "string", const: "ok" } },
    required: ["probe"],
  };
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

function unknownProcessResult(): CodexProcessResult {
  return {
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    canceled: false,
    processGroupGone: null,
    outputTruncated: false,
  };
}

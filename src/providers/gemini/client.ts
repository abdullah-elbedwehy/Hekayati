import { GoogleGenAI, type Part } from "@google/genai";

export interface GeminiModelInfo {
  name?: string;
  supportedActions?: string[];
}

export type GeminiContentPart =
  | { text: string }
  | { inlineData: { mimeType: "image/jpeg" | "image/png"; data: string } };

export interface GeminiGenerateRequest {
  modelId: string;
  contents: GeminiContentPart[];
  responseMimeType?: "text/plain" | "application/json";
  responseJsonSchema?: object;
  responseModalities?: Array<"Text" | "Image">;
}

export interface GeminiTransportResponse {
  modelVersion?: string;
  responseId?: string;
  candidateCount: number;
  parts: Array<{
    text?: string;
    inlineData?: { mimeType?: string; data?: string };
  }>;
  finishReason?: string;
  safetyRatings: Array<{ category: string; blocked: boolean }>;
  safetyBlocked?: boolean;
}

export interface GeminiTransport {
  getModel(
    apiKey: string,
    modelId: string,
    signal: AbortSignal,
  ): Promise<GeminiModelInfo>;
  generate(
    apiKey: string,
    request: GeminiGenerateRequest,
    signal: AbortSignal,
  ): Promise<GeminiTransportResponse>;
}

export class GoogleGenAiTransport implements GeminiTransport {
  async getModel(
    apiKey: string,
    modelId: string,
    signal: AbortSignal,
  ): Promise<GeminiModelInfo> {
    const client = new GoogleGenAI({ apiKey });
    const model = await client.models.get({
      model: modelId,
      config: { abortSignal: signal },
    });
    return {
      name: model.name,
      supportedActions: model.supportedActions,
    };
  }

  async generate(
    apiKey: string,
    request: GeminiGenerateRequest,
    signal: AbortSignal,
  ): Promise<GeminiTransportResponse> {
    const client = new GoogleGenAI({ apiKey });
    const response = await client.models.generateContent({
      model: request.modelId,
      contents: request.contents.map(toSdkPart),
      config: {
        abortSignal: signal,
        responseMimeType: request.responseMimeType,
        responseJsonSchema: request.responseJsonSchema,
        responseModalities: request.responseModalities,
      },
    });
    const candidates = response.candidates ?? [];
    const first = candidates[0];
    const parts = candidates.flatMap((candidate) =>
      (candidate.content?.parts ?? []).map((part) => ({
        text: part.text,
        inlineData: part.inlineData
          ? { mimeType: part.inlineData.mimeType, data: part.inlineData.data }
          : undefined,
      })),
    );
    const safetyRatings = (first?.safetyRatings ?? []).map((rating) => ({
      category: String(rating.category ?? "unknown"),
      blocked: Boolean(rating.blocked),
    }));
    return {
      modelVersion: response.modelVersion,
      responseId: response.responseId,
      candidateCount: candidates.length,
      parts,
      finishReason: first?.finishReason
        ? String(first.finishReason)
        : undefined,
      safetyRatings,
      safetyBlocked:
        Boolean(response.promptFeedback?.blockReason) ||
        String(first?.finishReason ?? "")
          .toUpperCase()
          .includes("SAFETY"),
    };
  }
}

function toSdkPart(part: GeminiContentPart): Part {
  return "text" in part
    ? { text: part.text }
    : {
        inlineData: {
          mimeType: part.inlineData.mimeType,
          data: part.inlineData.data,
        },
      };
}

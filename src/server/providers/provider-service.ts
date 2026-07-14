import { z } from "zod";

import type { SettingsService } from "../../domain/settings/settings.js";
import type { CapabilityCache } from "../../providers/capability-cache.js";
import {
  providerIdSchema,
  type ProviderCapabilities,
  type ProviderId,
} from "../../providers/contract.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import {
  checkPromptPolicy,
  confirmPromptPolicy,
  confirmationMatches,
} from "../../providers/prompt/policy.js";
import { styleIdSchema } from "../../providers/prompt/styles.js";
import type { GeminiCredentialService } from "./gemini-credential-service.js";

const promptInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(12_000),
    styleId: styleIdSchema,
  })
  .strict();

const confirmationInputSchema = promptInputSchema
  .extend({ bindingHash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();

export interface ProviderProjection {
  state: "not_checked" | "available" | "unavailable";
  checkedAt: string | null;
  source: "fixture" | "cache" | "live" | null;
  authState: ProviderCapabilities["auth"]["state"] | null;
  text: ProviderCapabilities["text"] | null;
  image: ProviderCapabilities["image"] | null;
  unavailableReason: string | null;
}

export interface ProviderHealthSnapshot {
  status: "available";
  selected: { text: ProviderId; image: ProviderId };
  connections: Record<ProviderId, ProviderProjection>;
}

export class ProviderServiceError extends Error {
  readonly statusCode = 400;

  constructor(readonly code: "PROMPT_CONFIRMATION_STALE") {
    super(code);
    this.name = "ProviderServiceError";
  }
}

export class ProviderService {
  constructor(
    private readonly settings: SettingsService,
    private readonly credentials: GeminiCredentialService,
    private readonly registry: ProviderRegistry,
    private readonly cache: CapabilityCache,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async status() {
    const settings = this.settings.get();
    return {
      status: "available" as const,
      checkedAt: this.clock().toISOString(),
      selected: {
        text: settings.textProvider,
        image: settings.imageProvider,
      },
      models: settings.models,
      geminiImageTier: settings.geminiImageTier,
      credential: await this.credentials.status(),
      providers: this.projections(),
    };
  }

  async test(providerInput: unknown) {
    const providerId = providerIdSchema.parse(providerInput);
    const provider = this.registry.get(providerId);
    await this.cache.get(
      providerId,
      () => provider.getCapabilities(true),
      true,
      this.capabilityKey(providerId),
    );
    return {
      tested: providerId,
      provider: this.projection(providerId),
    };
  }

  credentialStatus() {
    return this.credentials.status();
  }

  saveCredential(input: unknown) {
    return this.credentials.save(input);
  }

  deleteCredential() {
    return this.credentials.delete();
  }

  checkPrompt(input: unknown) {
    const parsed = promptInputSchema.parse(input);
    const result = checkPromptPolicy(parsed.prompt, parsed.styleId);
    if (result.status === "allowed") {
      return {
        status: "allowed" as const,
        policyVersion: result.policyVersion,
      };
    }
    return {
      status: "confirmation_required" as const,
      policyVersion: result.policyVersion,
      alternativePrompt: result.alternativePrompt,
      matchedCategories: result.matchedCategories,
      bindingHash: result.bindingHash,
    };
  }

  confirmPrompt(input: unknown) {
    const parsed = confirmationInputSchema.parse(input);
    const check = checkPromptPolicy(parsed.prompt, parsed.styleId);
    if (
      check.status !== "confirmation_required" ||
      !confirmationMatches(check, {
        policyVersion: check.policyVersion,
        bindingHash: parsed.bindingHash,
        confirmed: true,
      })
    ) {
      throw new ProviderServiceError("PROMPT_CONFIRMATION_STALE");
    }
    return confirmPromptPolicy(check);
  }

  healthSnapshot(): ProviderHealthSnapshot {
    const settings = this.settings.get();
    return {
      status: "available",
      selected: { text: settings.textProvider, image: settings.imageProvider },
      connections: this.projections(),
    };
  }

  private projections(): Record<ProviderId, ProviderProjection> {
    return {
      mock: this.projection("mock"),
      codex: this.projection("codex"),
      gemini: this.projection("gemini"),
    };
  }

  private projection(providerId: ProviderId): ProviderProjection {
    const capabilities = this.cache.peek(
      providerId,
      this.capabilityKey(providerId),
    );
    if (!capabilities) return uncheckedProjection();
    const available =
      capabilities.text.available || capabilities.image.available;
    return {
      state: available ? "available" : "unavailable",
      checkedAt: capabilities.checkedAt,
      source: capabilities.source,
      authState: capabilities.auth.state,
      text: capabilities.text,
      image: capabilities.image,
      unavailableReason: capabilities.unavailableReason ?? null,
    };
  }

  private capabilityKey(providerId: ProviderId): string {
    const settings = this.settings.get();
    if (providerId === "mock") return "mock-v1";
    if (providerId === "codex") return settings.models.codexText;
    return JSON.stringify({
      text: settings.models.geminiText,
      image: settings.models.geminiImage,
      economyImage: settings.models.geminiImageEconomy,
      tier: settings.geminiImageTier,
    });
  }
}

function uncheckedProjection(): ProviderProjection {
  return {
    state: "not_checked",
    checkedAt: null,
    source: null,
    authState: null,
    text: null,
    image: null,
    unavailableReason: null,
  };
}

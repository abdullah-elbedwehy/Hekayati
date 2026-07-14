import type { SettingsService } from "../domain/settings/settings.js";
import { MacOsKeychain } from "../security/keychain.js";
import type { Redactor } from "../security/log.js";
import { CapabilityCache } from "./capability-cache.js";
import { CodexProvider } from "./codex/adapter.js";
import type { CodexRunner } from "./codex/process-runner.js";
import { GeminiProvider } from "./gemini/adapter.js";
import type { GeminiTransport } from "./gemini/client.js";
import { MockProvider } from "./mock/adapter.js";
import { ProviderRegistry } from "./registry.js";
import {
  GeminiCredentialService,
  type KeychainPort,
} from "../server/providers/gemini-credential-service.js";
import { ProviderService } from "../server/providers/provider-service.js";

export interface ProviderRuntimeOptions {
  keychain?: KeychainPort;
  keychainBinary?: string;
  codexRunner?: CodexRunner;
  geminiTransport?: GeminiTransport;
  geminiLimits?: {
    maxReferenceImages: number | null;
    reliableCharacterCount: number | null;
  };
  clock?: () => Date;
  monotonicNow?: () => number;
}

export function createProviderSubsystem(
  settings: SettingsService,
  redactor: Redactor,
  options: ProviderRuntimeOptions = {},
): ProviderService {
  const clock = options.clock ?? (() => new Date());
  const cache = new CapabilityCache({ now: options.monotonicNow });
  const keychain =
    options.keychain ??
    new MacOsKeychain({ redactor, binary: options.keychainBinary });
  const credentials = new GeminiCredentialService(keychain, redactor, () =>
    cache.invalidate("gemini"),
  );
  const mock = new MockProvider({ clock, settings: settings.get() });
  const codex = new CodexProvider({
    runner: options.codexRunner,
    modelId: () => settings.get().models.codexText,
    clock,
    settings: () => settings.get(),
  });
  const gemini = new GeminiProvider({
    credential: credentials,
    transport: options.geminiTransport,
    configuration: () => geminiConfiguration(settings, options),
    settings: () => settings.get(),
    clock,
  });
  return new ProviderService(
    settings,
    credentials,
    new ProviderRegistry([mock, codex, gemini]),
    cache,
    clock,
  );
}

function geminiConfiguration(
  settingsService: SettingsService,
  options: ProviderRuntimeOptions,
) {
  const settings = settingsService.get();
  return {
    textModelId: settings.models.geminiText,
    imageModelId: settings.models.geminiImage,
    economyImageModelId: settings.models.geminiImageEconomy,
    imageTier: settings.geminiImageTier,
    maxReferenceImages: options.geminiLimits?.maxReferenceImages ?? null,
    reliableCharacterCount:
      options.geminiLimits?.reliableCharacterCount ?? null,
  };
}

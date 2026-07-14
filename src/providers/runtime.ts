import type { SettingsService } from "../domain/settings/settings.js";
import { MacOsKeychain } from "../security/keychain.js";
import type { Redactor } from "../security/log.js";
import { CapabilityCache } from "./capability-cache.js";
import { CodexProvider } from "./codex/adapter.js";
import type { CodexRunner } from "./codex/process-runner.js";
import { GeminiProvider } from "./gemini/adapter.js";
import type { GeminiTransport } from "./gemini/client.js";
import { MockProvider, type MockStructuredFixture } from "./mock/adapter.js";
import type { MockFaultScript } from "./mock/fault-script.js";
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
  mockFaults?: MockFaultScript;
  mockStructuredFixture?: MockStructuredFixture;
}

export interface ProviderSubsystem {
  service: ProviderService;
  registry: ProviderRegistry;
  capabilityCache: CapabilityCache;
}

export function createProviderSubsystem(
  settings: SettingsService,
  redactor: Redactor,
  options: ProviderRuntimeOptions = {},
): ProviderService {
  return createProviderRuntime(settings, redactor, options).service;
}

export function createProviderRuntime(
  settings: SettingsService,
  redactor: Redactor,
  options: ProviderRuntimeOptions = {},
): ProviderSubsystem {
  const clock = options.clock ?? (() => new Date());
  const cache = new CapabilityCache({ now: options.monotonicNow });
  const keychain =
    options.keychain ??
    new MacOsKeychain({ redactor, binary: options.keychainBinary });
  const credentials = new GeminiCredentialService(keychain, redactor, () =>
    cache.invalidate("gemini"),
  );
  const mock = new MockProvider({
    clock,
    faults: options.mockFaults,
    settings: settings.get(),
    structuredFixture: options.mockStructuredFixture,
  });
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
  const registry = new ProviderRegistry([mock, codex, gemini]);
  const service = new ProviderService(
    settings,
    credentials,
    registry,
    cache,
    clock,
  );
  return { service, registry, capabilityCache: cache };
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

export const DEFAULT_MODELS = Object.freeze({
  codexText: process.env.HEKAYATI_DEFAULT_CODEX_TEXT_MODEL ?? "gpt-5.5",
  geminiText:
    process.env.HEKAYATI_DEFAULT_GEMINI_TEXT_MODEL ?? "gemini-3.5-flash",
  geminiImage:
    process.env.HEKAYATI_DEFAULT_GEMINI_IMAGE_MODEL ?? "gemini-3.1-flash-image",
  geminiImageEconomy:
    process.env.HEKAYATI_DEFAULT_GEMINI_ECONOMY_MODEL ??
    "gemini-3.1-flash-lite-image",
});

export const DEFAULT_PORT = 4173;
export const DEFAULT_DISK_WARNING_GB = 10;
export const LOOPBACK_HOST = "127.0.0.1";

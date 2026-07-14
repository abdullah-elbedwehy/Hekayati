import type { FailureCategory } from "../failures.js";

interface ErrorShape {
  status?: unknown;
  code?: unknown;
  message?: unknown;
  name?: unknown;
}

export function classifyGeminiError(error: unknown): FailureCategory {
  const shape = toShape(error);
  const status = Number(shape.status ?? 0);
  const code = safeString(shape.code).toLowerCase();
  const message = safeString(shape.message).toLowerCase();
  const name = safeString(shape.name).toLowerCase();
  const signal = `${code} ${message} ${name}`;
  if (/abort/.test(signal)) return "user_canceled";
  if (
    status === 401 ||
    status === 403 ||
    /unauthor|invalid.?api.?key|credential/.test(signal)
  ) {
    return "invalid_credentials";
  }
  if (/quota|resource_exhausted|billing|credits exhausted/.test(signal)) {
    return "quota_exhausted";
  }
  if (status === 429 || /too many requests|rate.?limit|throttl/.test(signal)) {
    return "rate_limited";
  }
  if (status === 408 || status === 504 || /timeout|deadline/.test(signal)) {
    return "timeout";
  }
  if (
    status >= 500 ||
    /dns|network|connection reset|econn|socket|fetch failed/.test(signal)
  ) {
    return "network_failure";
  }
  if (/safety|blocked|prohibited|content policy/.test(signal)) {
    return "safety_refusal";
  }
  if (
    status === 404 ||
    /model.+not found|unsupported model|invalid model/.test(signal)
  ) {
    return "provider_unavailable";
  }
  if (/json|schema|malformed/.test(signal)) return "malformed_output";
  return "unknown";
}

function toShape(error: unknown): ErrorShape {
  return typeof error === "object" && error !== null ? error : {};
}

function safeString(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? `${value}`
    : "";
}

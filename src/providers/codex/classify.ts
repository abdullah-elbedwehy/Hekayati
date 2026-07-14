import type { FailureCategory } from "../failures.js";
import type { CodexProcessResult } from "./process-runner.js";

export type CodexAuthMode =
  "chatgpt_subscription" | "api_key_disallowed" | "missing" | "unknown";

export function classifyCodexProcess(
  result: CodexProcessResult,
): FailureCategory | null {
  if (result.canceled) return "user_canceled";
  if (result.timedOut) return "timeout";
  if (result.errorCode === "ENOENT" || result.errorCode === "EACCES") {
    return "provider_unavailable";
  }
  if (result.exitCode === 0) return null;
  const signal = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (modelUnavailable(signal)) return "provider_unavailable";
  if (credentialFailure(signal)) return "invalid_credentials";
  if (quotaFailure(signal)) return "quota_exhausted";
  if (/rate limit|too many requests|\b429\b|throttl/.test(signal)) {
    return "rate_limited";
  }
  if (/timed out|timeout|deadline exceeded/.test(signal)) return "timeout";
  if (
    /dns|connection reset|connection refused|network unavailable|socket hang up/.test(
      signal,
    )
  ) {
    return "network_failure";
  }
  if (/safety|content policy|content blocked/.test(signal))
    return "safety_refusal";
  if (/malformed|invalid json|schema validation|output schema/.test(signal)) {
    return "malformed_output";
  }
  return "unknown";
}

export function parseCodexAuth(result: CodexProcessResult): CodexAuthMode {
  if (result.errorCode === "ENOENT" || result.errorCode === "EACCES") {
    return "unknown";
  }
  const text = `${result.stdout}\n${result.stderr}`;
  if (/chatgpt/i.test(text) && result.exitCode === 0) {
    return "chatgpt_subscription";
  }
  if (/api[ -]?key/i.test(text) && result.exitCode === 0) {
    return "api_key_disallowed";
  }
  if (credentialFailure(text.toLowerCase()) || result.exitCode !== 0) {
    return "missing";
  }
  return "unknown";
}

function modelUnavailable(value: string): boolean {
  return (
    /model[\s\S]{0,120}(not found|does not exist|unsupported|unavailable|invalid)/.test(
      value,
    ) || /(not found|does not exist|unsupported)[\s\S]{0,120}model/.test(value)
  );
}

function credentialFailure(value: string): boolean {
  return /not logged in|please log in|login required|invalid credentials|unauthorized|session expired|authentication failed|refresh.?token.?failed|\b401\b/.test(
    value,
  );
}

function quotaFailure(value: string): boolean {
  return /usage limit|usage_limit_reached|quota exhausted|quota exceeded|insufficient quota|insufficient_quota|credits exhausted|subscription limit/.test(
    value,
  );
}

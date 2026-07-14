import type { FailureCategory } from "../providers/failures.js";

interface RetryPolicy {
  delaysMs: readonly number[];
  exhaustedAction: "fail" | "pause" | "pause_all" | "halt" | "cancel";
  reason: string;
  honorRetryAfter?: boolean;
}

export type FailureDecision =
  | { action: "retry"; delayMs: number }
  | {
      action: "fail" | "pause" | "pause_all" | "halt" | "cancel";
      reason: string;
    };

export const RETRY_POLICIES: Record<FailureCategory, RetryPolicy> = {
  invalid_input: policy("fail", "invalid_input"),
  missing_reference_asset: policy("pause", "dependency"),
  provider_unavailable: policy(
    "pause",
    "provider_unavailable",
    [30_000, 120_000, 600_000],
  ),
  invalid_credentials: policy("pause", "credentials"),
  quota_exhausted: policy("pause", "quota"),
  rate_limited: {
    ...policy("pause", "retry_exhausted", [15_000, 60_000, 300_000]),
    honorRetryAfter: true,
  },
  timeout: policy("pause", "retry_exhausted", [30_000, 120_000]),
  network_failure: policy(
    "pause",
    "retry_exhausted",
    [10_000, 60_000, 300_000],
  ),
  safety_refusal: policy("fail", "safety_refusal"),
  malformed_output: policy("pause", "retry_exhausted", [5_000, 30_000]),
  output_validation_failed: policy("pause", "retry_exhausted", [5_000, 30_000]),
  media_decode_failure: policy("pause", "retry_exhausted", [5_000]),
  disk_write_failure: policy("pause_all", "storage"),
  insufficient_disk_space: policy("pause_all", "storage"),
  database_unavailable: policy("halt", "database"),
  user_canceled: policy("cancel", "user_canceled"),
  stale_dependency: policy("fail", "stale_dependency"),
  unknown: policy("pause", "operator"),
};

export function decideFailure(
  category: FailureCategory,
  retryIndex: number,
  retryAfterMs?: number,
): FailureDecision {
  const retryPolicy = RETRY_POLICIES[category];
  const fixedDelay = retryPolicy.delaysMs[retryIndex];
  if (fixedDelay !== undefined) {
    const requested = retryPolicy.honorRetryAfter ? retryAfterMs : undefined;
    return {
      action: "retry",
      delayMs: Math.min(requested ?? fixedDelay, 86_400_000),
    };
  }
  return {
    action: retryPolicy.exhaustedAction,
    reason: retryPolicy.reason,
  };
}

function policy(
  exhaustedAction: RetryPolicy["exhaustedAction"],
  reason: string,
  delaysMs: readonly number[] = [],
): RetryPolicy {
  return { exhaustedAction, reason, delaysMs };
}

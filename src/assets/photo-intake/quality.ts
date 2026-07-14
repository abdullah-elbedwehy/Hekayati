import type {
  LocalPhotoWarning,
  OperatorPhotoWarning,
  PhotoObservations,
  PhotoQualityEvaluationInput,
  PhotoQualityReport,
} from "./types.js";

export const photoQualityPolicyV1 = Object.freeze({
  version: "PhotoQualityPolicy/v1" as const,
  evaluationMaxDimensionPx: 512,
  thresholds: Object.freeze({
    minimumReferenceCount: 2,
    blurScore: 80,
    subjectBoxAreaRatio: 0.08,
    shadowFraction: 0.35,
  }),
});

const warningOrder = [
  "PHOTO_LIMITED_REFERENCES",
  "PHOTO_BLURRY",
  "PHOTO_FACE_TOO_SMALL",
  "PHOTO_MULTIPLE_PEOPLE",
  "PHOTO_EXTREME_SHADOWS",
  "PHOTO_OBSTRUCTED",
  "PHOTO_FILTER_SUSPECTED",
  "PHOTO_AGE_CONFLICT",
  "PHOTO_HAIR_CONFLICT",
  "PHOTO_CLOTHING_CONFLICT",
] as const;

export function evaluatePhotoQuality(
  input: PhotoQualityEvaluationInput,
): PhotoQualityReport {
  const observations = copyObservations(input.observations);
  return {
    policyVersion: photoQualityPolicyV1.version,
    metrics: { ...input.metrics },
    warnings: orderWarnings([
      ...localWarnings(input),
      ...operatorWarnings(observations, input.existingObservations ?? []),
    ]),
    observations,
  };
}

function orderWarnings<T extends { code: string }>(warnings: T[]): T[] {
  return warnings.sort(
    (left, right) =>
      warningOrder.indexOf(left.code as (typeof warningOrder)[number]) -
      warningOrder.indexOf(right.code as (typeof warningOrder)[number]),
  );
}

function localWarnings(
  input: PhotoQualityEvaluationInput,
): LocalPhotoWarning[] {
  const warnings: LocalPhotoWarning[] = [];
  const { metrics, referenceCountAfterCommit } = input;
  const thresholds = photoQualityPolicyV1.thresholds;
  if (
    referenceCountAfterCommit !== undefined &&
    referenceCountAfterCommit < thresholds.minimumReferenceCount
  )
    warnings.push(
      local(
        "PHOTO_LIMITED_REFERENCES",
        "referenceCount",
        thresholds.minimumReferenceCount,
        referenceCountAfterCommit,
        "less_than",
      ),
    );
  if (metrics.blurScore < thresholds.blurScore)
    warnings.push(
      local(
        "PHOTO_BLURRY",
        "blurScore",
        thresholds.blurScore,
        metrics.blurScore,
        "less_than",
      ),
    );
  addSubjectSizeWarning(warnings, metrics.subjectBoxAreaRatio);
  if (metrics.shadowFraction > thresholds.shadowFraction)
    warnings.push(
      local(
        "PHOTO_EXTREME_SHADOWS",
        "shadowFraction",
        thresholds.shadowFraction,
        metrics.shadowFraction,
        "greater_than",
      ),
    );
  return warnings;
}

function addSubjectSizeWarning(
  warnings: LocalPhotoWarning[],
  areaRatio?: number,
): void {
  const threshold = photoQualityPolicyV1.thresholds.subjectBoxAreaRatio;
  if (areaRatio !== undefined && areaRatio < threshold)
    warnings.push(
      local(
        "PHOTO_FACE_TOO_SMALL",
        "subjectBoxAreaRatio",
        threshold,
        areaRatio,
        "less_than",
      ),
    );
}

function operatorWarnings(
  current: PhotoObservations,
  existing: readonly PhotoObservations[],
): OperatorPhotoWarning[] {
  const warnings: OperatorPhotoWarning[] = [];
  if ((current.peopleCount ?? 0) > 1)
    warnings.push(operator("PHOTO_MULTIPLE_PEOPLE", "peopleCount", "recorded"));
  if (normalizeObservation(current.obstruction))
    warnings.push(operator("PHOTO_OBSTRUCTED", "obstruction", "recorded"));
  if (current.filterSuspected)
    warnings.push(
      operator("PHOTO_FILTER_SUSPECTED", "filterSuspected", "recorded"),
    );
  addConflict(
    warnings,
    "PHOTO_AGE_CONFLICT",
    "apparentAgeBand",
    current,
    existing,
  );
  addConflict(warnings, "PHOTO_HAIR_CONFLICT", "hair", current, existing);
  addConflict(
    warnings,
    "PHOTO_CLOTHING_CONFLICT",
    "clothing",
    current,
    existing,
  );
  return warnings;
}

function addConflict(
  warnings: OperatorPhotoWarning[],
  code:
    "PHOTO_AGE_CONFLICT" | "PHOTO_HAIR_CONFLICT" | "PHOTO_CLOTHING_CONFLICT",
  field: "apparentAgeBand" | "hair" | "clothing",
  current: PhotoObservations,
  existing: readonly PhotoObservations[],
): void {
  const value = normalizeObservation(current[field]);
  if (!value) return;
  const conflicts = existing.some((observation) => {
    const prior = normalizeObservation(observation[field]);
    return prior !== undefined && prior !== value;
  });
  if (conflicts)
    warnings.push(operator(code, field, "conflict_with_existing_reference"));
}

function local(
  code: LocalPhotoWarning["code"],
  metric: string,
  threshold: number,
  value: number,
  comparison: LocalPhotoWarning["comparison"],
): LocalPhotoWarning {
  return { code, source: "local_check", metric, threshold, value, comparison };
}

function operator(
  code: OperatorPhotoWarning["code"],
  observation: OperatorPhotoWarning["observation"],
  details: OperatorPhotoWarning["details"],
): OperatorPhotoWarning {
  return { code, source: "operator", observation, details };
}

function copyObservations(input?: PhotoObservations): PhotoObservations {
  return input ? { ...input } : {};
}

function normalizeObservation(value?: string): string | undefined {
  const normalized = value
    ?.normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
  return normalized || undefined;
}

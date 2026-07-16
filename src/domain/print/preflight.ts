import type { PrintFinding } from "./schemas.js";

export const PRINT_PREFLIGHT_POLICY_VERSION =
  "hekayati.print-preflight.v1" as const;

export const PRINT_PREFLIGHT_CODES = [
  "PDF_CORRUPT",
  "PDF_ENCRYPTED",
  "PAGE_DIMENSIONS_MISMATCH",
  "PAGE_ORIENTATION_INVALID",
  "PAGE_COUNT_MISMATCH",
  "PAGE_MAP_MISMATCH",
  "PRINTER_BLANK_MISMATCH",
  "SOURCE_ASSET_MISSING",
  "SOURCE_CHECKSUM_MISMATCH",
  "IMAGE_PPI_LOW",
  "TEXT_OVERFLOW",
  "FONT_MISSING",
  "FONT_NOT_EMBEDDED",
  "FONT_NOT_SUBSETTED",
  "FONT_TOUNICODE_MISSING",
  "GLYPH_COVERAGE_MISSING",
  "BLEED_MISSING",
  "SAFE_MARGIN_VIOLATION",
  "CROP_MARKS_INVALID",
  "COVER_SPREAD_INVALID",
  "COVER_PANEL_ORDER_INVALID",
  "SPINE_WIDTH_UNKNOWN",
  "COLOR_MODE_MISMATCH",
  "ICC_PROFILE_MISSING",
  "ICC_OUTPUT_INTENT_MISMATCH",
  "COLOR_CONVERSION_FAILED",
  "PRINT_WATERMARK_PRESENT",
  "PREVIEW_WATERMARK_MISSING",
  "PDF_PROHIBITED_FEATURE",
  "EXTERNAL_RESOURCE_PRESENT",
  "AUTHORIZATION_MISMATCH",
  "PROFILE_VERSION_MISMATCH",
] as const;

export type PrintPreflightCode = (typeof PRINT_PREFLIGHT_CODES)[number];
export type PrintArtifactFamily = "interior" | "cover" | "preview" | "bundle";

export interface PrintPreflightRule {
  code: PrintPreflightCode;
  order: number;
  artifact: PrintArtifactFamily;
  measurement: string;
  expected: string | number | boolean;
  severity: "blocking";
}

const ruleDefinitions: Array<Omit<PrintPreflightRule, "order" | "severity">> = [
  rule("PDF_CORRUPT", "bundle", "parseable", true),
  rule("PDF_ENCRYPTED", "bundle", "encrypted", false),
  rule("PAGE_DIMENSIONS_MISMATCH", "bundle", "page_boxes_match", true),
  rule("PAGE_ORIENTATION_INVALID", "bundle", "orientation_valid", true),
  rule("PAGE_COUNT_MISMATCH", "interior", "page_count_match", true),
  rule("PAGE_MAP_MISMATCH", "interior", "page_map_match", true),
  rule("PRINTER_BLANK_MISMATCH", "interior", "blank_map_match", true),
  rule("SOURCE_ASSET_MISSING", "bundle", "source_assets_present", true),
  rule("SOURCE_CHECKSUM_MISMATCH", "bundle", "source_checksums_match", true),
  rule("IMAGE_PPI_LOW", "bundle", "minimum_effective_ppi_met", true),
  rule("TEXT_OVERFLOW", "bundle", "text_overflow_count", 0),
  rule("FONT_MISSING", "bundle", "required_fonts_present", true),
  rule("FONT_NOT_EMBEDDED", "bundle", "fonts_embedded", true),
  rule("FONT_NOT_SUBSETTED", "bundle", "fonts_subsetted", true),
  rule("FONT_TOUNICODE_MISSING", "bundle", "to_unicode_present", true),
  rule("GLYPH_COVERAGE_MISSING", "bundle", "glyph_coverage_complete", true),
  rule("BLEED_MISSING", "bundle", "bleed_boxes_match", true),
  rule("SAFE_MARGIN_VIOLATION", "bundle", "safe_content_contained", true),
  rule("CROP_MARKS_INVALID", "bundle", "crop_marks_match", true),
  rule("COVER_SPREAD_INVALID", "cover", "spread_dimensions_match", true),
  rule("COVER_PANEL_ORDER_INVALID", "cover", "panel_order", "back-spine-front"),
  rule("SPINE_WIDTH_UNKNOWN", "cover", "spine_width_known", true),
  rule("COLOR_MODE_MISMATCH", "bundle", "color_mode_match", true),
  rule("ICC_PROFILE_MISSING", "bundle", "icc_present_when_required", true),
  rule("ICC_OUTPUT_INTENT_MISMATCH", "bundle", "output_intent_match", true),
  rule("COLOR_CONVERSION_FAILED", "bundle", "conversion_valid", true),
  rule("PRINT_WATERMARK_PRESENT", "bundle", "print_watermark_count", 0),
  rule(
    "PREVIEW_WATERMARK_MISSING",
    "preview",
    "preview_watermark_present",
    true,
  ),
  rule("PDF_PROHIBITED_FEATURE", "bundle", "prohibited_feature_count", 0),
  rule("EXTERNAL_RESOURCE_PRESENT", "bundle", "external_resource_count", 0),
  rule("AUTHORIZATION_MISMATCH", "bundle", "authorization_match", true),
  rule("PROFILE_VERSION_MISMATCH", "bundle", "profile_version_match", true),
];

export const PRINT_PREFLIGHT_REGISTRY: Readonly<
  Record<PrintPreflightCode, PrintPreflightRule>
> = Object.freeze(
  Object.fromEntries(
    ruleDefinitions.map((definition, order) => [
      definition.code,
      Object.freeze({ ...definition, order, severity: "blocking" as const }),
    ]),
  ) as Record<PrintPreflightCode, PrintPreflightRule>,
);

export interface PreflightCheckFact {
  passed: boolean;
  actual: string | number | boolean;
  expected?: string | number | boolean;
  artifact?: PrintArtifactFamily;
  page?: number | null;
}

export interface PrintPreflightFacts {
  policyVersion: typeof PRINT_PREFLIGHT_POLICY_VERSION;
  checks: Record<PrintPreflightCode, PreflightCheckFact>;
}

export interface PrintPreflightEvaluation {
  policyVersion: typeof PRINT_PREFLIGHT_POLICY_VERSION;
  passed: boolean;
  findings: PrintFinding[];
}

export function assertPreflightRegistryComplete(
  registry: Readonly<
    Record<string, PrintPreflightRule>
  > = PRINT_PREFLIGHT_REGISTRY,
): void {
  const actual = Object.keys(registry).sort();
  const required = [...PRINT_PREFLIGHT_CODES].sort();
  if (
    actual.length !== required.length ||
    actual.some((code, index) => code !== required[index])
  )
    throw new Error("PRINT_PREFLIGHT_REGISTRY_INCOMPLETE");
  for (const [index, code] of PRINT_PREFLIGHT_CODES.entries()) {
    const row = registry[code];
    if (!row || row.code !== code || row.order !== index)
      throw new Error("PRINT_PREFLIGHT_REGISTRY_INVALID");
  }
}

export function evaluatePreflightFacts(
  facts: PrintPreflightFacts,
): PrintPreflightEvaluation {
  assertPreflightRegistryComplete();
  if (facts.policyVersion !== PRINT_PREFLIGHT_POLICY_VERSION)
    throw new Error("PRINT_PREFLIGHT_POLICY_UNKNOWN");
  const keys = Object.keys(facts.checks).sort();
  const required = [...PRINT_PREFLIGHT_CODES].sort();
  if (
    keys.length !== required.length ||
    keys.some((code, index) => code !== required[index])
  )
    throw new Error("PRINT_PREFLIGHT_FACTS_INCOMPLETE");
  const findings = PRINT_PREFLIGHT_CODES.flatMap((code) => {
    const check = facts.checks[code];
    if (check.passed) return [];
    const rule = PRINT_PREFLIGHT_REGISTRY[code];
    return [
      {
        code,
        artifact: check.artifact ?? rule.artifact,
        page: check.page ?? null,
        severity: "blocking" as const,
        expected: check.expected ?? rule.expected,
        actual: check.actual,
      },
    ];
  });
  return {
    policyVersion: PRINT_PREFLIGHT_POLICY_VERSION,
    passed: findings.length === 0,
    findings,
  };
}

export const cleanPreflightFacts: PrintPreflightFacts = Object.freeze({
  policyVersion: PRINT_PREFLIGHT_POLICY_VERSION,
  checks: Object.freeze(
    Object.fromEntries(
      PRINT_PREFLIGHT_CODES.map((code) => {
        const expected = PRINT_PREFLIGHT_REGISTRY[code].expected;
        return [code, Object.freeze({ passed: true, actual: expected })];
      }),
    ) as Record<PrintPreflightCode, PreflightCheckFact>,
  ),
});

function rule(
  code: PrintPreflightCode,
  artifact: PrintArtifactFamily,
  measurement: string,
  expected: string | number | boolean,
): Omit<PrintPreflightRule, "order" | "severity"> {
  return { code, artifact, measurement, expected };
}

import { createHash } from "node:crypto";

export interface StructuralIssue {
  path: readonly PropertyKey[];
  code: string;
}

export interface StructuralDiagnostics {
  sha256: string;
  byteCount: number;
  topLevelType: string;
  topLevelKeys?: string[];
  issues: Array<{ path: string; code: string }>;
}

export function structuralDiagnostics(
  input: string | Uint8Array,
  issues: readonly StructuralIssue[] = [],
): StructuralDiagnostics {
  const bytes =
    typeof input === "string" ? Buffer.from(input) : Buffer.from(input);
  const parsed = typeof input === "string" ? safelyParse(input) : undefined;
  const shape = describeShape(parsed);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteCount: bytes.byteLength,
    ...shape,
    issues: issues.slice(0, 10).map((issue) => ({
      path: issue.path.map(String).join(".") || "<root>",
      code: issue.code.slice(0, 80),
    })),
  };
}

function safelyParse(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return undefined;
  }
}

function describeShape(
  value: unknown,
): Pick<StructuralDiagnostics, "topLevelType" | "topLevelKeys"> {
  if (value === undefined) return { topLevelType: "unparseable" };
  if (value === null) return { topLevelType: "null" };
  if (Array.isArray(value)) return { topLevelType: "array" };
  if (typeof value !== "object") return { topLevelType: typeof value };
  return {
    topLevelType: "object",
    topLevelKeys: Object.keys(value).sort().slice(0, 20),
  };
}

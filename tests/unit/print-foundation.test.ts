import { describe, expect, it } from "vitest";

import {
  createDefaultPrinterProfileDraft,
  finalizePrinterProfileVersion,
  printerProfileVersionSchema,
} from "../../src/domain/print/schemas.js";
import {
  compileCoverGeometry,
  compileInteriorGeometry,
  compileOutputPageMap,
} from "../../src/domain/print/geometry.js";
import {
  PRINT_PREFLIGHT_CODES,
  PRINT_PREFLIGHT_POLICY_VERSION,
  PRINT_PREFLIGHT_REGISTRY,
  assertPreflightRegistryComplete,
  cleanPreflightFacts,
  evaluatePreflightFacts,
  type PrintPreflightRule,
} from "../../src/domain/print/preflight.js";
import { inspectIccProfile } from "../../src/print/icc.js";
import { validTestIcc } from "../helpers/icc-profile.js";

const at = "2026-07-15T00:00:00.000Z";
const id = (suffix: string) =>
  `01J${String(Number.parseInt(suffix, 10)).padStart(23, "0")}`;

describe("printer profile contracts", () => {
  it("keeps canonical A4 defaults incomplete until spine truth exists", () => {
    const draft = createDefaultPrinterProfileDraft();

    expect(draft).toMatchObject({
      trim: { widthMm: 210, heightMm: 297, orientation: "portrait" },
      bleedMm: 3,
      safeContentRegion: { x: 0.07, y: 0.05, width: 0.86, height: 0.9 },
      dpiMin: 300,
      color: { mode: "rgb" },
      cropMarks: { enabled: false, offsetMm: 0, lengthMm: 0 },
      spine: { source: "missing", widthMm: null },
    });

    const version = finalizePrinterProfileVersion({
      id: id("01"),
      profileId: id("02"),
      previousVersionId: null,
      createdAt: at,
      updatedAt: at,
      draft,
    });
    expect(version.readiness).toBe("incomplete");
    expect(version.blockingReasons).toEqual(["SPINE_WIDTH_UNKNOWN"]);
    expect(version.profileHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("derives a ready immutable RGB version from an explicit spine", () => {
    const draft = {
      ...createDefaultPrinterProfileDraft(),
      spine: { source: "explicit" as const, widthMm: 8.4 },
    };
    const version = finalizePrinterProfileVersion({
      id: id("03"),
      profileId: id("02"),
      previousVersionId: id("01"),
      createdAt: at,
      updatedAt: at,
      draft,
    });

    expect(version.readiness).toBe("ready");
    expect(version.blockingReasons).toEqual([]);
    expect(printerProfileVersionSchema.parse(version)).toEqual(version);
    expect(() =>
      printerProfileVersionSchema.parse({
        ...version,
        sourcePath: "/tmp/a.icc",
      }),
    ).toThrow();
  });

  it.each([
    [
      "landscape",
      { trim: { widthMm: 297, heightMm: 210, orientation: "portrait" } },
    ],
    ["unsafe", { safeContentRegion: { x: 0.8, y: 0, width: 0.3, height: 1 } }],
    [
      "crop",
      {
        cropMarks: { enabled: false, offsetMm: 2, lengthMm: 5, strokePt: 0.25 },
      },
    ],
    [
      "blank",
      {
        requiredBlankPages: [
          { position: "before_interior", count: 1, label: "A" },
          { position: "before_interior", count: 1, label: "B" },
        ],
      },
    ],
  ])("rejects invalid %s mechanics", (_name, override) => {
    expect(() =>
      finalizePrinterProfileVersion({
        id: id("04"),
        profileId: id("02"),
        previousVersionId: null,
        createdAt: at,
        updatedAt: at,
        draft: { ...createDefaultPrinterProfileDraft(), ...override },
      }),
    ).toThrow();
  });
});

describe("print geometry", () => {
  it("keeps trim and bleed boxes exact with crop marks off and on", () => {
    const base = createDefaultPrinterProfileDraft();
    const plain = compileInteriorGeometry(base);
    expect(plain).toMatchObject({
      mediaBoxMm: { x: 0, y: 0, width: 216, height: 303 },
      bleedBoxMm: { x: 0, y: 0, width: 216, height: 303 },
      trimBoxMm: { x: 3, y: 3, width: 210, height: 297 },
      cropMarkMarginMm: 0,
    });

    const marked = compileInteriorGeometry({
      ...base,
      cropMarks: { enabled: true, offsetMm: 2, lengthMm: 5, strokePt: 0.25 },
    });
    expect(marked.cropMarkMarginMm).toBe(7);
    expect(marked.mediaBoxMm).toEqual({ x: 0, y: 0, width: 230, height: 317 });
    expect(marked.bleedBoxMm).toEqual({ x: 7, y: 7, width: 216, height: 303 });
    expect(marked.trimBoxMm).toEqual({ x: 10, y: 10, width: 210, height: 297 });
  });

  it("lays out the RTL cover as back, spine, then front", () => {
    const profile = {
      ...createDefaultPrinterProfileDraft(),
      spine: { source: "explicit" as const, widthMm: 8 },
    };
    const cover = compileCoverGeometry(profile);

    expect(cover.trimBoxMm.width).toBe(428);
    expect(
      cover.panels.map((panel) => [
        panel.kind,
        panel.boxMm.x,
        panel.boxMm.width,
      ]),
    ).toEqual([
      ["back", 3, 210],
      ["spine", 213, 8],
      ["front", 221, 210],
    ]);
  });

  it("adds printer blanks without changing customer page numbers", () => {
    const map = compileOutputPageMap(
      Array.from({ length: 16 }, (_, index) => ({
        customerPageNumber: index + 1,
        pageId: id(String(index + 10).padStart(2, "0")),
      })),
      [
        { position: "before_interior", count: 2, label: "technical-front" },
        { position: "after_interior", count: 1, label: "technical-back" },
      ],
    );

    expect(map).toHaveLength(19);
    expect(map.slice(0, 2).every((page) => page.kind === "printer_blank")).toBe(
      true,
    );
    expect(map[2]).toMatchObject({
      kind: "customer",
      outputPageNumber: 3,
      customerPageNumber: 1,
    });
    expect(map.at(-1)).toMatchObject({
      kind: "printer_blank",
      outputPageNumber: 19,
    });
  });
});

describe("closed print preflight policy", () => {
  it("is versioned and complete independently of the FR-123 detector fixtures", () => {
    expect(PRINT_PREFLIGHT_POLICY_VERSION).toBe("hekayati.print-preflight.v1");
    expect(() => assertPreflightRegistryComplete()).not.toThrow();
    expect(Object.keys(PRINT_PREFLIGHT_REGISTRY)).toEqual(
      PRINT_PREFLIGHT_CODES,
    );
  });

  it("passes a clean synthetic RGB bundle", () => {
    const report = evaluatePreflightFacts(structuredClone(cleanPreflightFacts));
    expect(report).toMatchObject({ passed: true, findings: [] });
  });

  it("uses bounded fact-specific expected evidence in findings", () => {
    const facts = structuredClone(cleanPreflightFacts);
    facts.checks.IMAGE_PPI_LOW = {
      passed: false,
      expected: 300,
      actual: 149,
      artifact: "interior",
      page: 7,
    };

    expect(evaluatePreflightFacts(facts).findings).toEqual([
      {
        code: "IMAGE_PPI_LOW",
        artifact: "interior",
        page: 7,
        severity: "blocking",
        expected: 300,
        actual: 149,
      },
    ]);
  });

  it("fails closed when a registry row, row order, fact, or policy version drifts", () => {
    const withoutLast = { ...PRINT_PREFLIGHT_REGISTRY } as Record<
      string,
      PrintPreflightRule
    >;
    delete withoutLast[PRINT_PREFLIGHT_CODES.at(-1)!];
    expect(() => assertPreflightRegistryComplete(withoutLast)).toThrow(
      "PRINT_PREFLIGHT_REGISTRY_INCOMPLETE",
    );

    const firstCode = PRINT_PREFLIGHT_CODES[0];
    const wrongOrder = {
      ...PRINT_PREFLIGHT_REGISTRY,
      [firstCode]: { ...PRINT_PREFLIGHT_REGISTRY[firstCode], order: 99 },
    };
    expect(() => assertPreflightRegistryComplete(wrongOrder)).toThrow(
      "PRINT_PREFLIGHT_REGISTRY_INVALID",
    );

    const incompleteFacts = structuredClone(cleanPreflightFacts);
    delete (incompleteFacts.checks as Partial<typeof incompleteFacts.checks>)[
      firstCode
    ];
    expect(() => evaluatePreflightFacts(incompleteFacts)).toThrow(
      "PRINT_PREFLIGHT_FACTS_INCOMPLETE",
    );
    expect(() =>
      evaluatePreflightFacts({
        ...structuredClone(cleanPreflightFacts),
        policyVersion: "hekayati.print-preflight.unknown",
      } as never),
    ).toThrow("PRINT_PREFLIGHT_POLICY_UNKNOWN");
  });
});

describe("ICC inspection", () => {
  it("accepts an exact four-channel profile and rejects wrong signature/channel", () => {
    const bytes = syntheticIcc("CMYK");
    expect(inspectIccProfile(bytes)).toMatchObject({
      bytes: bytes.length,
      dataColorSpace: "CMYK",
      channels: 4,
      profileClass: "output",
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(() => inspectIccProfile(Buffer.from(bytes).fill(0, 36, 40))).toThrow(
      "ICC_SIGNATURE_INVALID",
    );
    expect(inspectIccProfile(syntheticIcc("RGB ")).channels).toBe(3);
  });
});

function syntheticIcc(colorSpace: "CMYK" | "RGB "): Buffer {
  return validTestIcc(colorSpace);
}

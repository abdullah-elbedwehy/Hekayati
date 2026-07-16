import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AssetStore } from "../../src/assets/asset-store.js";
import { AuthoringRepositories } from "../../src/domain/authoring/repositories.js";
import { LayoutRepositories } from "../../src/domain/layout/repositories.js";
import { A4_COMPOSITION_PROFILE } from "../../src/domain/layout/policy.js";
import { createDefaultPrinterProfileDraft } from "../../src/domain/print/schemas.js";
import { PrinterProfileService } from "../../src/domain/print/profiles.js";
import { PrintRepositories } from "../../src/domain/print/repositories.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { validTestIcc } from "../helpers/icc-profile.js";
import { temporaryDirectory } from "../helpers/temp.js";

const at = "2026-07-15T00:00:00.000Z";
const ids = Array.from(
  { length: 30 },
  (_, index) => `01J${String(index + 1).padStart(23, "0")}`,
);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("printer profile service", () => {
  it("creates immutable versions and advances the head through exact CAS", async () => {
    const fixture = await setup();
    const created = fixture.service.create({
      name: "A4 synthetic printer",
      draft: createDefaultPrinterProfileDraft(),
    });
    expect(created.profile).toMatchObject({ revision: 0, archived: false });
    expect(created.version.readiness).toBe("incomplete");

    const updated = fixture.service.update({
      profileId: created.profile.id,
      expectedRevision: 0,
      name: "A4 synthetic printer",
      archived: false,
      draft: {
        ...createDefaultPrinterProfileDraft(),
        spine: { source: "explicit", widthMm: 8 },
      },
    });
    expect(updated.profile).toMatchObject({
      revision: 1,
      currentVersionId: updated.version.id,
    });
    expect(updated.version).toMatchObject({
      previousVersionId: created.version.id,
      readiness: "ready",
    });
    expect(
      fixture.repositories.profileVersions.get(created.version.id),
    ).toEqual(created.version);

    expect(() =>
      fixture.service.update({
        profileId: created.profile.id,
        expectedRevision: 0,
        name: "stale",
        archived: false,
        draft: createDefaultPrinterProfileDraft(),
      }),
    ).toThrow("PRINT_REVISION_CONFLICT");
    fixture.store.close();
  });

  it("imports a bounded four-channel ICC as a private indexed asset", async () => {
    const fixture = await setup();
    const bytes = syntheticIcc("CMYK");
    const result = await fixture.service.importIcc({
      bytes,
      requireCmyk: true,
    });

    expect(result.facts).toMatchObject({ channels: 4, dataColorSpace: "CMYK" });
    expect(result.asset).toMatchObject({
      role: "icc_profile",
      mime: "application/vnd.iccprofile",
      origin: "upload",
      sha256: result.facts.checksum,
    });
    expect(JSON.stringify(result)).not.toContain(fixture.tempPath);
    await expect(
      fixture.service.importIcc({
        bytes: syntheticIcc("RGB "),
        requireCmyk: true,
      }),
    ).rejects.toThrow("ICC_COLOR_SPACE_UNSUPPORTED");
    fixture.store.close();
  });

  it("never accepts an imported RGB ICC as a CMYK output profile", async () => {
    const fixture = await setup();
    const imported = await fixture.service.importIcc({
      bytes: syntheticIcc("RGB "),
      requireCmyk: false,
    });

    expect(imported.facts).toMatchObject({
      channels: 3,
      dataColorSpace: "RGB",
    });
    expect(() =>
      fixture.service.create({
        name: "Invalid CMYK profile",
        draft: {
          ...createDefaultPrinterProfileDraft(),
          spine: { source: "explicit", widthMm: 8 },
          color: {
            mode: "cmyk",
            iccAssetId: imported.asset.id,
            iccChecksum: imported.asset.sha256,
          },
        },
      }),
    ).toThrow("PRINTER_PROFILE_ASSET_INVALID");
    expect(fixture.repositories.profiles.list()).toEqual([]);
    expect(fixture.repositories.profileVersions.list()).toEqual([]);
    fixture.store.close();
  });

  it("assigns only an exact ready compatible version without changing approval", async () => {
    const fixture = await setup();
    fixture.layout.compositionProfiles.insert({
      ...A4_COMPOSITION_PROFILE,
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
    });
    const project = projectRecord();
    fixture.authoring.projects.insert(project);
    const created = fixture.service.create({
      name: "Ready profile",
      draft: {
        ...createDefaultPrinterProfileDraft(),
        spine: { source: "explicit", widthMm: 7.5 },
      },
    });

    const assigned = fixture.service.assignProject({
      owner: { customerId: project.customerId, familyId: project.familyId },
      projectId: project.id,
      expectedProjectRevision: 0,
      profileId: created.profile.id,
      expectedProfileRevision: 0,
      profileVersionId: created.version.id,
    });
    expect(assigned).toMatchObject({
      revision: 1,
      printerProfileId: created.profile.id,
      currentContentApprovalId: project.currentContentApprovalId,
      bookVersion: project.bookVersion,
    });
    expect(fixture.invalidationEvents).toEqual([
      expect.objectContaining({
        entity: "printer_profile",
        entityId: project.id,
        matrixRow: "IM-14",
        fromVersionId: null,
        toVersionId: created.version.id,
      }),
    ]);

    expect(() =>
      fixture.service.assignProject({
        owner: { customerId: ids[28], familyId: project.familyId },
        projectId: project.id,
        expectedProjectRevision: 1,
        profileId: created.profile.id,
        expectedProfileRevision: 0,
        profileVersionId: created.version.id,
      }),
    ).toThrow("PRINT_SCOPE_REJECTED");
    fixture.store.close();
  });

  it("rejects incompatible assignment atomically with exact migration facts", async () => {
    const fixture = await setup();
    fixture.layout.compositionProfiles.insert({
      ...A4_COMPOSITION_PROFILE,
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
    });
    const project = projectRecord();
    fixture.authoring.projects.insert(project);
    const created = fixture.service.create({
      name: "Incompatible synthetic profile",
      draft: {
        ...createDefaultPrinterProfileDraft(),
        trim: { widthMm: 210.6, heightMm: 297, orientation: "portrait" },
        spine: { source: "explicit", widthMm: 8 },
      },
    });
    const profileBefore = fixture.repositories.profiles.get(created.profile.id);
    const versionsBefore = fixture.repositories.profileVersions.list();

    expect(() =>
      fixture.service.assignProject({
        owner: { customerId: project.customerId, familyId: project.familyId },
        projectId: project.id,
        expectedProjectRevision: project.revision,
        profileId: created.profile.id,
        expectedProfileRevision: created.profile.revision,
        profileVersionId: created.version.id,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "COMPOSITION_PROFILE_MISMATCH",
        details: {
          compatible: false,
          code: "COMPOSITION_PROFILE_MISMATCH",
          failedPredicates: ["width"],
          expected: { widthMm: 210, heightMm: 297, toleranceMm: 0.5 },
          actual: {
            widthMm: 210.6,
            heightMm: 297,
            orientation: "portrait",
          },
        },
      }),
    );

    expect(fixture.authoring.projects.get(project.id)).toEqual(project);
    expect(fixture.repositories.profiles.get(created.profile.id)).toEqual(
      profileBefore,
    );
    expect(fixture.repositories.profileVersions.list()).toEqual(versionsBefore);
    expect(fixture.repositories.runs.list()).toEqual([]);
    expect(fixture.repositories.artifacts.list()).toEqual([]);
    expect(fixture.invalidationEvents).toEqual([]);
    fixture.store.close();
  });
});

async function setup() {
  const temp = await temporaryDirectory("hekayati-print-profile-");
  cleanups.push(temp.cleanup);
  const store = new DocumentStore(join(temp.path, "print.db"));
  const assets = new AssetStore(store, join(temp.path, "assets"));
  const repositories = new PrintRepositories(store);
  const authoring = new AuthoringRepositories(store);
  const layout = new LayoutRepositories(store);
  let nextId = 0;
  const invalidationEvents: unknown[] = [];
  const service = new PrinterProfileService(store, assets, {
    now: () => at,
    idFactory: () => ids[nextId++] ?? ids.at(-1)!,
    invalidation: {
      recordAndConsume: (input) => invalidationEvents.push(input),
    },
  });
  return {
    tempPath: temp.path,
    store,
    assets,
    repositories,
    authoring,
    layout,
    service,
    invalidationEvents,
  };
}

function projectRecord() {
  return {
    id: ids[20],
    schemaVersion: 2 as const,
    createdAt: at,
    updatedAt: at,
    customerId: ids[21],
    familyId: ids[22],
    revision: 0,
    status: "approved" as const,
    priority: 0,
    paused: false,
    currentVersionId: ids[23],
    bookVersion: 4,
    compositionProfileId: A4_COMPOSITION_PROFILE.id,
    currentCoverCompositionVersionId: ids[24],
    currentPreviewOutputId: ids[25],
    currentPreviewCycleId: ids[26],
    currentContentApprovalId: ids[27],
    printerProfileId: null,
  };
}

function syntheticIcc(colorSpace: "CMYK" | "RGB "): Buffer {
  return validTestIcc(colorSpace);
}

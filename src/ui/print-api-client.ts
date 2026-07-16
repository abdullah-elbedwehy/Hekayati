import { LayoutApiClient } from "./layout-api-client";
import type {
  PrinterProfileProjection,
  PrintProfileDraft,
  PrintProjectProjection,
} from "./print-types";

export abstract class PrintApiClient extends LayoutApiClient {
  printProfiles(): Promise<PrinterProfileProjection[]> {
    return this.request("/api/print/profiles");
  }

  createPrintProfile(input: { name: string; draft: PrintProfileDraft }) {
    return this.json<PrinterProfileProjection>(
      "/api/print/profiles",
      "POST",
      input,
    );
  }

  updatePrintProfile(
    profileId: string,
    input: {
      expectedRevision: number;
      name: string;
      archived: boolean;
      draft: PrintProfileDraft;
    },
  ) {
    return this.json<PrinterProfileProjection>(
      `/api/print/profiles/${encodeURIComponent(profileId)}`,
      "PUT",
      input,
    );
  }

  importPrintIcc(file: File, requireCmyk = true) {
    const form = new FormData();
    form.set("requireCmyk", String(requireCmyk));
    form.set("file", file);
    return this.request<{
      asset: { id: string; sha256: string };
      facts: { channels: 3 | 4; dataColorSpace: "RGB" | "CMYK" };
    }>("/api/print/profile-assets/icc", { method: "POST", body: form });
  }

  importPrintTemplate(
    file: File,
    geometry: {
      backRegion: PrintProfileDraft["safeContentRegion"];
      spineRegion: PrintProfileDraft["safeContentRegion"];
      frontRegion: PrintProfileDraft["safeContentRegion"];
      toleranceMm: number;
    },
  ) {
    const form = new FormData();
    form.set("geometry", JSON.stringify(geometry));
    form.set("file", file);
    return this.request<{
      facts: NonNullable<PrintProfileDraft["coverTemplate"]>;
    }>("/api/print/profile-assets/template", { method: "POST", body: form });
  }

  printProject(familyId: string, projectId: string) {
    return this.request<PrintProjectProjection>(
      `/api/print/projects/${encodeURIComponent(projectId)}?familyId=${encodeURIComponent(familyId)}`,
    );
  }

  assignPrintProfile(
    familyId: string,
    projectId: string,
    input: {
      expectedProjectRevision: number;
      profileId: string;
      expectedProfileRevision: number;
      profileVersionId: string;
    },
  ) {
    return this.json(
      `/api/print/projects/${encodeURIComponent(projectId)}/profile?familyId=${encodeURIComponent(familyId)}`,
      "POST",
      input,
    );
  }

  startPrintRun(
    familyId: string,
    projectId: string,
    input: {
      expectedProjectRevision: number;
      profileId: string;
      expectedProfileRevision: number;
      profileVersionId: string;
      contentAuthorizationHash: string;
      idempotencyKey: string;
    },
  ) {
    return this.json(
      `/api/print/projects/${encodeURIComponent(projectId)}/runs?familyId=${encodeURIComponent(familyId)}`,
      "POST",
      input,
    );
  }

  actOnPrintProof(
    familyId: string,
    runId: string,
    input: {
      proofBundleId: string;
      gateJobId: string;
      action: "approved" | "rejected";
      idempotencyKey: string;
      expectedRunRevision: number;
      expectedGateRevision: number;
      proofBundleHash: string;
      contentAuthorizationHash: string;
      printerProfileHash: string;
      iccChecksum: string;
      notes?: string;
    },
  ) {
    return this.json(
      `/api/print/runs/${encodeURIComponent(runId)}/proof?familyId=${encodeURIComponent(familyId)}`,
      "POST",
      input,
    );
  }

  printDownloadUrl(
    familyId: string,
    runId: string,
    kind: "interior" | "cover",
  ): string {
    return `/api/print/runs/${encodeURIComponent(runId)}/download/${kind}?familyId=${encodeURIComponent(familyId)}`;
  }

  printProofUrl(
    familyId: string,
    runId: string,
    kind: "interior" | "cover",
  ): string {
    return `/api/print/runs/${encodeURIComponent(runId)}/proof/${kind}?familyId=${encodeURIComponent(familyId)}`;
  }
}

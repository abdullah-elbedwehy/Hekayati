import fastifyMultipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { LibraryService } from "../../src/domain/library/index.js";
import { PrintError } from "../../src/domain/print/errors.js";
import {
  inspectIccProfile,
  requireCmykIccProfile,
} from "../../src/print/icc.js";
import { inspectCoverTemplatePdf } from "../../src/print/template.js";
import { StructuredLogger } from "../../src/security/log.js";
import { handleError } from "../../src/server/error-handler.js";
import type { PrintRuntime } from "../../src/server/print-runtime.js";
import { registerPrintApi } from "../../src/server/routes/print-api.js";

const familyId = "01J00000000000000000000001";
const customerId = "01J00000000000000000000002";
const projectId = "01J00000000000000000000003";
const profileId = "01J00000000000000000000004";
const profileVersionId = "01J00000000000000000000005";
const runId = "01J00000000000000000000006";
const proofBundleId = "01J00000000000000000000007";
const gateJobId = "01J00000000000000000000008";
const hash = "a".repeat(64);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("hostile print HTTP boundary", () => {
  it("normalizes malformed and hostile multipart uploads without persistence or leakage", async () => {
    const harness = await boundaryHarness();
    const geometry = JSON.stringify({
      backRegion: { x: 0, y: 0, width: 0.49, height: 1 },
      spineRegion: { x: 0.49, y: 0, width: 0.02, height: 1 },
      frontRegion: { x: 0.51, y: 0, width: 0.49, height: 1 },
      toleranceMm: 0.2,
    });
    const cases: Array<{
      name: string;
      url: string;
      headers: Record<string, string>;
      payload: Buffer | string;
    }> = [
      {
        name: "non multipart",
        url: "/api/print/profile-assets/icc",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ file: "/Users/operator/private.icc" }),
      },
      multipartCase("oversize file", "/api/print/profile-assets/icc", [
        field("requireCmyk", "true"),
        file("file", Buffer.alloc(8 * 1024 * 1024 + 1, 0x41), "huge.icc"),
      ]),
      multipartCase("multiple files", "/api/print/profile-assets/icc", [
        field("requireCmyk", "true"),
        file("file", validIcc("CMYK"), "first.icc"),
        file("file", validIcc("CMYK"), "second.icc"),
      ]),
      multipartCase("missing required field", "/api/print/profile-assets/icc", [
        file("file", validIcc("CMYK"), "profile.icc"),
      ]),
      multipartCase("missing file", "/api/print/profile-assets/icc", [
        field("requireCmyk", "true"),
      ]),
      multipartCase("wrong ICC channel", "/api/print/profile-assets/icc", [
        field("requireCmyk", "true"),
        file("file", validIcc("RGB "), "rgb.icc"),
      ]),
      multipartCase(
        "malformed template geometry",
        "/api/print/profile-assets/template",
        [
          field("geometry", "{/Users/operator/template.pdf}"),
          file("file", activeTemplate(), "template.pdf", "application/pdf"),
        ],
      ),
      multipartCase("active template", "/api/print/profile-assets/template", [
        field("geometry", geometry),
        file("file", activeTemplate(), "active.pdf", "application/pdf"),
      ]),
    ];

    for (const candidate of cases) {
      harness.state.mutations = 0;
      harness.logs.splice(0);
      const response = await harness.app.inject({
        method: "POST",
        url: candidate.url,
        headers: candidate.headers,
        payload: candidate.payload,
      });
      expect(response.statusCode, candidate.name).toBe(422);
      expect(response.headers["cache-control"], candidate.name).toBe(
        "private, no-store",
      );
      expect(response.json(), candidate.name).toEqual({
        code: "PRINTER_PROFILE_ASSET_INVALID",
      });
      expect(response.body.length, candidate.name).toBeLessThan(160);
      expect(response.body, candidate.name).not.toMatch(
        /Users|private\.icc|template\.pdf|huge\.icc|OpenAction|JavaScript|CMYK|RGB/iu,
      );
      expect(harness.state.mutations, candidate.name).toBe(0);
      expect(harness.logs, candidate.name).toEqual([]);
    }
  });

  it("keeps stale, scope, proof, and download failures bounded and non-mutating", async () => {
    const harness = await boundaryHarness();
    const assignment = {
      expectedProjectRevision: 1,
      profileId,
      expectedProfileRevision: 1,
      profileVersionId,
    };
    const start = {
      ...assignment,
      contentAuthorizationHash: hash,
      idempotencyKey: "negative-start",
    };
    const proof = {
      proofBundleId,
      gateJobId,
      action: "approved",
      idempotencyKey: "negative-proof",
      expectedRunRevision: 1,
      expectedGateRevision: 1,
      proofBundleHash: hash,
      contentAuthorizationHash: hash,
      printerProfileHash: hash,
      iccChecksum: hash,
    };
    const cases: Array<{
      name: string;
      operation: Operation | null;
      error: PrintError | null;
      method: "GET" | "POST";
      url: string;
      payload?: unknown;
      status: number;
      code: string;
    }> = [
      {
        name: "stale assignment revision",
        operation: "assign",
        error: new PrintError("PRINT_REVISION_CONFLICT"),
        method: "POST",
        url: `/api/print/projects/${projectId}/profile?familyId=${familyId}`,
        payload: assignment,
        status: 409,
        code: "PRINT_REVISION_CONFLICT",
      },
      {
        name: "stale authorization hash",
        operation: "start",
        error: new PrintError("PRINT_AUTHORIZATION_MISMATCH"),
        method: "POST",
        url: `/api/print/projects/${projectId}/runs?familyId=${familyId}`,
        payload: start,
        status: 422,
        code: "PRINT_AUTHORIZATION_MISMATCH",
      },
      {
        name: "foreign scope",
        operation: "project",
        error: new PrintError("PRINT_SCOPE_REJECTED"),
        method: "GET",
        url: `/api/print/projects/${projectId}?familyId=${familyId}`,
        status: 404,
        code: "PRINT_SCOPE_REJECTED",
      },
      {
        name: "proof binding mismatch",
        operation: "proof",
        error: new PrintError("PRINT_PROOF_ACTION_INVALID"),
        method: "POST",
        url: `/api/print/runs/${runId}/proof?familyId=${familyId}`,
        payload: proof,
        status: 422,
        code: "PRINT_PROOF_ACTION_INVALID",
      },
      {
        name: "non deliverable download",
        operation: "deliverable",
        error: new PrintError("PRINT_ARTIFACT_NOT_DELIVERABLE"),
        method: "GET",
        url: `/api/print/runs/${runId}/download/interior?familyId=${familyId}`,
        status: 422,
        code: "PRINT_ARTIFACT_NOT_DELIVERABLE",
      },
      {
        name: "non pending proof raster",
        operation: "raster",
        error: new PrintError("PRINT_ARTIFACT_NOT_DELIVERABLE"),
        method: "GET",
        url: `/api/print/runs/${runId}/proof/cover?familyId=${familyId}`,
        status: 422,
        code: "PRINT_ARTIFACT_NOT_DELIVERABLE",
      },
      {
        name: "path-like run id",
        operation: null,
        error: null,
        method: "GET",
        url: `/api/print/runs/..%2F..%2Fetc%2Fpasswd/download/interior?familyId=${familyId}`,
        status: 400,
        code: "INVALID_INPUT",
      },
      {
        name: "unknown artifact kind",
        operation: null,
        error: null,
        method: "GET",
        url: `/api/print/runs/${runId}/download/source?familyId=${familyId}`,
        status: 400,
        code: "INVALID_INPUT",
      },
    ];

    for (const candidate of cases) {
      harness.state.calls.splice(0);
      harness.state.mutations = 0;
      harness.state.failures.clear();
      if (candidate.operation && candidate.error)
        harness.state.failures.set(candidate.operation, candidate.error);
      const response = await harness.app.inject({
        method: candidate.method,
        url: candidate.url,
        headers: candidate.payload
          ? { "content-type": "application/json" }
          : undefined,
        payload: candidate.payload
          ? JSON.stringify(candidate.payload)
          : undefined,
      });
      expect(response.statusCode, candidate.name).toBe(candidate.status);
      expect(response.headers["cache-control"], candidate.name).toBe(
        "private, no-store",
      );
      expect(response.json().code, candidate.name).toBe(candidate.code);
      expect(response.body.length, candidate.name).toBeLessThan(320);
      expect(response.body, candidate.name).not.toMatch(
        /etc\/passwd|negative-start|negative-proof|a{32}|\/Users|\.pdf/iu,
      );
      expect(harness.state.mutations, candidate.name).toBe(0);
      if (candidate.operation)
        expect(harness.state.calls, candidate.name).toContain(
          candidate.operation,
        );
      else
        expect(harness.state.calls, candidate.name).not.toEqual(
          expect.arrayContaining(["deliverable", "raster"]),
        );
    }
  });

  it("sets private no-store before handler, parser, and not-found responses", async () => {
    const harness = await boundaryHarness();
    const cases = [
      { method: "GET" as const, url: "/api/print/profiles" },
      {
        method: "POST" as const,
        url: "/api/print/profiles",
        headers: { "content-type": "application/json" },
        payload: "{",
      },
      { method: "GET" as const, url: "/api/print?probe=1" },
      { method: "GET" as const, url: "/api/print/not-registered" },
    ];
    for (const candidate of cases) {
      const response = await harness.app.inject(candidate);
      expect(response.headers["cache-control"]).toBe("private, no-store");
    }
  });
});

type Operation =
  "assign" | "start" | "project" | "proof" | "deliverable" | "raster";

interface BoundaryState {
  mutations: number;
  calls: Operation[];
  failures: Map<Operation, PrintError>;
}

async function boundaryHarness(): Promise<{
  app: FastifyInstance;
  state: BoundaryState;
  logs: string[];
}> {
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
  const logs: string[] = [];
  const logger = new StructuredLogger((line) => logs.push(line));
  const state: BoundaryState = {
    mutations: 0,
    calls: [],
    failures: new Map(),
  };
  app.setErrorHandler((error, _request, reply) =>
    handleError(error, reply, logger),
  );
  await app.register(fastifyMultipart, {
    throwFileSizeLimit: true,
    limits: {
      fieldNameSize: 80,
      fieldSize: 64 * 1024,
      fields: 4,
      fileSize: 100 * 1024 * 1024 + 1,
      files: 1,
      headerPairs: 100,
      parts: 5,
    },
  });

  const fail = (operation: Operation) => {
    state.calls.push(operation);
    const error = state.failures.get(operation);
    if (error) throw error;
  };
  const print = {
    profiles: {
      list: () => [],
      create: () => ({}),
      update: () => ({}),
      assignProject: () => {
        fail("assign");
        state.mutations += 1;
        return {};
      },
      importIcc: async (input: { bytes: Buffer; requireCmyk: boolean }) => {
        const facts = input.requireCmyk
          ? requireCmykIccProfile(input.bytes)
          : inspectIccProfile(input.bytes);
        state.mutations += 1;
        return { asset: { id: profileId, sha256: facts.checksum }, facts };
      },
      importCoverTemplate: async (input: { bytes: Buffer }) => {
        const inspection = await inspectCoverTemplatePdf(input.bytes);
        state.mutations += 1;
        return { asset: {}, inspection, facts: {} };
      },
    },
    production: {
      start: async () => {
        fail("start");
        state.mutations += 1;
        return {};
      },
    },
    proofs: {
      act: () => {
        fail("proof");
        state.mutations += 1;
        return {};
      },
    },
    workspace: {
      profilesProjection: () => [],
      project: () => {
        fail("project");
        return {};
      },
      deliverable: async () => {
        fail("deliverable");
        return {
          bytes: Buffer.from("private-pdf-bytes"),
          filename: "secret.pdf",
        };
      },
      proofRaster: async () => {
        fail("raster");
        return {
          bytes: Buffer.from("private-png-bytes"),
          filename: "secret.png",
        };
      },
    },
  } as unknown as PrintRuntime;
  const library = {
    scopeForFamilyId: () => ({ customerId, familyId }),
  } as unknown as LibraryService;
  registerPrintApi(app, print, library);
  await app.ready();
  cleanups.push(() => app.close());
  return { app, state, logs };
}

interface MultipartPart {
  name: string;
  value: Buffer;
  filename?: string;
  contentType?: string;
}

function field(name: string, value: string): MultipartPart {
  return { name, value: Buffer.from(value) };
}

function file(
  name: string,
  value: Buffer,
  filename: string,
  contentType = "application/octet-stream",
): MultipartPart {
  return { name, value, filename, contentType };
}

function multipartCase(
  name: string,
  url: string,
  parts: MultipartPart[],
): {
  name: string;
  url: string;
  headers: Record<string, string>;
  payload: Buffer;
} {
  const boundary = `hekayati-${name.replace(/\s+/gu, "-")}`;
  return {
    name,
    url,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: multipartBody(boundary, parts),
  };
}

function multipartBody(boundary: string, parts: MultipartPart[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    const filename = part.filename ? `; filename="${part.filename}"` : "";
    chunks.push(
      Buffer.from(
        `Content-Disposition: form-data; name="${part.name}"${filename}\r\n`,
      ),
    );
    if (part.contentType)
      chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`));
    chunks.push(Buffer.from("\r\n"), part.value, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function validIcc(color: "CMYK" | "RGB "): Buffer {
  const bytes = Buffer.alloc(132);
  bytes.writeUInt32BE(bytes.length, 0);
  bytes.write(color, 16, "ascii");
  bytes.write("acsp", 36, "ascii");
  bytes.writeUInt32BE(0, 128);
  return bytes;
}

function activeTemplate(): Buffer {
  return Buffer.from(
    "%PDF-1.7\n1 0 obj\n<< /OpenAction 2 0 R /JavaScript (private) >>\nendobj\n%%EOF\n".padEnd(
      128,
      " ",
    ),
    "latin1",
  );
}

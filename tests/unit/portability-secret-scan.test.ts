import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { SecretReleaseGate } from "../../src/portability/secret-scan.js";
import { SecretRegistry } from "../../src/security/secret-registry.js";

describe("portability secret release gate", () => {
  it("finds registered runtime secrets split across stream chunks", async () => {
    const registry = new SecretRegistry();
    const secret = `runtime-${"x".repeat(700)}-canary`;
    registry.register(secret);
    const gate = new SecretReleaseGate(registry);

    const finding = await gate.scanStream(
      "data/projects/project-1.json",
      Readable.from([
        Buffer.from(`safe:${secret.slice(0, 400)}`),
        Buffer.from(secret.slice(400)),
      ]),
    );

    expect(finding).toEqual({
      category: "registered_or_known_secret",
      entry: "data/projects/project-1.json",
    });
    expect(JSON.stringify(finding)).not.toContain(secret);
  });

  it("classifies fixed credential, auth, keychain, cookie, and canary markers", async () => {
    const gate = new SecretReleaseGate(new SecretRegistry());
    const fixtures = [
      ["AIza1234567890123456789012345", "gemini_key"],
      ["Authorization: Bearer abc.def.ghi", "bearer_credential"],
      ["-----BEGIN PRIVATE KEY-----", "private_key"],
      ['{"access_token":"synthetic"}', "codex_auth"],
      ["security find-generic-password -w", "keychain_dump"],
      ["Set-Cookie: session=synthetic", "cookie_or_token"],
      ["session_token=synthetic", "cookie_or_token"],
      ["HEKAYATI_SECRET_CANARY", "seeded_canary"],
    ] as const;

    for (const [value, category] of fixtures) {
      await expect(
        gate.scanStream("data/fixture.json", Readable.from(Buffer.from(value))),
      ).resolves.toEqual({ category, entry: "data/fixture.json" });
    }
    expect(gate.scanEntryName(".codex/auth.json")).toEqual({
      category: "codex_auth",
      entry: ".codex/auth.json",
    });

    await expect(
      gate.scanStream(
        "data/chunked.json",
        Readable.from([
          Buffer.from("Authoriz"),
          Buffer.from("ation: Bearer abc"),
        ]),
      ),
    ).resolves.toEqual({
      category: "bearer_credential",
      entry: "data/chunked.json",
    });

    expect(gate.scanEntryName("/Users/operator/.codex/auth.json")).toEqual({
      category: "codex_auth",
      entry: "untrusted-entry",
    });
  });

  it("allows clean binary streams without retaining their contents", async () => {
    const gate = new SecretReleaseGate(new SecretRegistry());
    const clean = Buffer.from([0, 1, 2, 3, 255, 254, 253]);

    await expect(
      gate.scanStream("media/assets/clean.png", Readable.from(clean)),
    ).resolves.toBeNull();
    expect(gate.scanEntryName("media/assets/clean.png")).toBeNull();
  });
});

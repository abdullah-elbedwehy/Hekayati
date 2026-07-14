import { describe, expect, it } from "vitest";

import {
  assertListenerHost,
  BindConfigurationError,
  canonicalOrigin,
  parsePort,
  verifyEffectiveAddress,
} from "../../src/server/startup/bind.js";

describe("literal loopback listener", () => {
  it.each(["0.0.0.0", "localhost", "::1", "127.0.0.2", "192.168.1.8", ""])(
    "rejects %s before listen",
    (host) => {
      expect(() => assertListenerHost(host)).toThrowError(
        BindConfigurationError,
      );
    },
  );

  it("accepts only the canonical IPv4 literal", () => {
    expect(() => assertListenerHost("127.0.0.1")).not.toThrow();
    expect(canonicalOrigin(4173)).toBe("http://127.0.0.1:4173");
  });

  it("rejects malformed or out-of-range ports", () => {
    expect(parsePort(undefined, 4173)).toBe(4173);
    expect(parsePort("0", 4173)).toBe(0);
    for (const value of ["-1", "65536", "12x", "1.5", " 12"]) {
      expect(() => parsePort(value, 4173)).toThrowError(BindConfigurationError);
    }
  });

  it("independently verifies the effective address", () => {
    expect(
      verifyEffectiveAddress({
        address: "127.0.0.1",
        family: "IPv4",
        port: 4400,
      }),
    ).toEqual({ address: "127.0.0.1", family: "IPv4", port: 4400 });
    for (const address of [
      null,
      "/tmp/socket",
      { address: "0.0.0.0", family: "IPv4", port: 4400 },
      { address: "::1", family: "IPv6", port: 4400 },
    ]) {
      expect(() => verifyEffectiveAddress(address)).toThrowError(
        BindConfigurationError,
      );
    }
  });
});

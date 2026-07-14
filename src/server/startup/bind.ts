import type { AddressInfo } from "node:net";

import { LOOPBACK_HOST } from "../../config/defaults.js";

export class BindConfigurationError extends Error {
  constructor(
    readonly category:
      "invalid_host" | "invalid_port" | "effective_address_mismatch",
  ) {
    super(`BIND_${category.toUpperCase()}`);
    this.name = "BindConfigurationError";
  }
}

export function assertListenerHost(host: string): void {
  if (host !== LOOPBACK_HOST) throw new BindConfigurationError("invalid_host");
}

export function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d{1,5}$/.test(value))
    throw new BindConfigurationError("invalid_port");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new BindConfigurationError("invalid_port");
  }
  return port;
}

export function verifyEffectiveAddress(
  address: AddressInfo | string | null,
): AddressInfo {
  if (
    !address ||
    typeof address === "string" ||
    address.address !== LOOPBACK_HOST ||
    address.family !== "IPv4"
  ) {
    throw new BindConfigurationError("effective_address_mismatch");
  }
  return address;
}

export function canonicalOrigin(port: number): string {
  return `http://${LOOPBACK_HOST}:${port}`;
}

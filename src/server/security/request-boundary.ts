import { randomBytes, timingSafeEqual } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

import { canonicalOrigin } from "../startup/bind.js";

export const CSRF_HEADER = "x-hekayati-csrf";
const safeMethods = new Set(["GET", "HEAD"]);

interface BoundaryState {
  origin: string;
  authority: string;
  token: string;
}

export interface BootstrapSecurity {
  canonicalOrigin: string;
  csrfToken: string;
}

export class LocalRequestBoundary {
  private state: BoundaryState | null = null;

  activate(port: number): void {
    const origin = canonicalOrigin(port);
    this.state = {
      origin,
      authority: origin.slice("http://".length),
      token: randomBytes(32).toString("base64url"),
    };
  }

  deactivate(): void {
    this.state = null;
  }

  bootstrap(): BootstrapSecurity {
    const state = this.requireState();
    return { canonicalOrigin: state.origin, csrfToken: state.token };
  }

  status(): { ready: boolean; canonicalOrigin: string | null } {
    return {
      ready: this.state !== null,
      canonicalOrigin: this.state?.origin ?? null,
    };
  }

  guard(request: FastifyRequest, reply: FastifyReply): void {
    const state = this.state;
    if (!state) return reject(reply, 503);
    if (!hasCanonicalAuthority(request, state)) return reject(reply, 421);
    if (!hasCanonicalAbsoluteTarget(request, state)) return reject(reply, 421);
    if (!hasCanonicalPresentOrigin(request, state)) return reject(reply, 403);
    if (request.method === "OPTIONS") return reject(reply, 403);
    if (safeMethods.has(request.method)) return;
    if (!hasCanonicalSource(request, state)) return reject(reply, 403);
    if (!hasCurrentToken(request, state)) return reject(reply, 403);
  }

  private requireState(): BoundaryState {
    if (!this.state) throw new Error("LOCAL_BOUNDARY_NOT_READY");
    return this.state;
  }
}

function hasCanonicalAuthority(
  request: FastifyRequest,
  state: BoundaryState,
): boolean {
  const hosts = rawHeaderValues(request, "host");
  if (hosts.length === 1) return hosts[0] === state.authority;
  const authority = request.headers[":authority"];
  return (
    hosts.length === 0 &&
    typeof authority === "string" &&
    authority === state.authority
  );
}

function hasCanonicalAbsoluteTarget(
  request: FastifyRequest,
  state: BoundaryState,
): boolean {
  const target = request.raw.url ?? "";
  if (target.startsWith("/") && !target.startsWith("//")) return true;
  const match = /^(http):\/\/([^/?#]*)([^#]*)$/.exec(target);
  return match?.[1] === "http" && match[2] === state.authority;
}

function hasCanonicalPresentOrigin(
  request: FastifyRequest,
  state: BoundaryState,
): boolean {
  const origins = rawHeaderValues(request, "origin");
  return (
    origins.length === 0 ||
    (origins.length === 1 && origins[0] === state.origin)
  );
}

function hasCanonicalSource(
  request: FastifyRequest,
  state: BoundaryState,
): boolean {
  const origins = rawHeaderValues(request, "origin");
  if (origins.length === 1) return origins[0] === state.origin;
  if (origins.length > 1) return false;
  const referers = rawHeaderValues(request, "referer");
  if (referers.length !== 1) return false;
  const value = referers[0];
  if (value !== state.origin && !value.startsWith(`${state.origin}/`)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "http:" &&
      parsed.host === state.authority &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

function hasCurrentToken(
  request: FastifyRequest,
  state: BoundaryState,
): boolean {
  const values = rawHeaderValues(request, CSRF_HEADER);
  if (values.length !== 1) return false;
  const received = Buffer.from(values[0]);
  const expected = Buffer.from(state.token);
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

function rawHeaderValues(request: FastifyRequest, name: string): string[] {
  const values: string[] = [];
  const raw = request.raw.rawHeaders;
  for (let index = 0; index < raw.length; index += 2) {
    if (raw[index]?.toLowerCase() === name) values.push(raw[index + 1] ?? "");
  }
  return values;
}

function reject(reply: FastifyReply, status: number): void {
  void reply.code(status).header("cache-control", "no-store").send();
}

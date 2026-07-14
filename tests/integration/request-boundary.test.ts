import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntime, type HekayatiRuntime } from "../../src/server/app.js";
import { httpRequest, portOf, rawHttpRequest } from "../helpers/http.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("local HTTP trust boundary", () => {
  it.each(["0.0.0.0", "localhost", "::1", "127.0.0.2", "192.168.1.9"])(
    "rejects listener host %s before attempting a socket",
    async (host) => {
      const directory = await temporaryDirectory();
      const runtime = await createRuntime({
        dataDir: directory.path,
        serveUi: false,
      });
      await expect(runtime.start({ host })).rejects.toThrow(
        "BIND_INVALID_HOST",
      );
      expect(runtime.metrics.listenAttempts).toBe(0);
      await runtime.close();
      await directory.cleanup();
    },
  );

  it("rejects noncanonical, missing, duplicate, and absolute-form authorities before dispatch", async () => {
    const fixture = await runtimeFixture();
    const port = portOf(fixture.origin);
    const baseline = fixture.runtime.metrics.routeDispatches;
    const sentinel = fixture.runtime.sentinelValue();

    const responses = await Promise.all([
      httpRequest(fixture.origin, "/api/bootstrap", {
        headers: { host: `localhost:${port}` },
      }),
      httpRequest(fixture.origin, "/api/bootstrap", {
        headers: { host: `127.0.0.2:${port}` },
      }),
      httpRequest(fixture.origin, "/api/bootstrap", {
        headers: { host: `rebind.example:${port}` },
      }),
      rawHttpRequest(port, [
        "GET /api/bootstrap HTTP/1.1",
        "Connection: close",
      ]),
      rawHttpRequest(port, [
        "GET /api/bootstrap HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        `Host: rebind.example:${port}`,
        "Connection: close",
      ]),
      rawHttpRequest(port, [
        "GET /api/bootstrap HTTP/1.1",
        `Host: 127.0.0.1:${port} invalid`,
        "Connection: close",
      ]),
      rawHttpRequest(port, [
        "GET http://rebind.example/api/bootstrap HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Connection: close",
      ]),
      rawHttpRequest(port, [
        `GET http://2130706433:${port}/api/bootstrap HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Connection: close",
      ]),
      rawHttpRequest(port, [
        `GET http://127.1:${port}/api/bootstrap HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Connection: close",
      ]),
      rawHttpRequest(port, [
        `GET http://0x7f000001:${port}/api/bootstrap HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Connection: close",
      ]),
      rawHttpRequest(port, [
        `GET HTTP://127.0.0.1:${port}/api/bootstrap HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Connection: close",
      ]),
      rawHttpRequest(port, [
        "GET ftp://evil.example/api/bootstrap HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Connection: close",
      ]),
      rawHttpRequest(port, [
        "GET file:///api/bootstrap HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Connection: close",
      ]),
      rawHttpRequest(port, [
        "GET ws://evil.example/api/bootstrap HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Connection: close",
      ]),
      rawHttpRequest(port, [
        "GET //evil.example/api/bootstrap HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Connection: close",
      ]),
    ]);

    for (const response of responses)
      expect(response.status).toBeGreaterThanOrEqual(400);
    expect(fixture.runtime.metrics.routeDispatches).toBe(baseline);
    expect(fixture.runtime.sentinelValue()).toBe(sentinel);
  });

  it("ignores forwarded host metadata instead of trusting it", async () => {
    const fixture = await runtimeFixture();
    const port = portOf(fixture.origin);
    const baseline = fixture.runtime.metrics.routeDispatches;
    const sentinel = fixture.runtime.sentinelValue();
    const accepted = await httpRequest(fixture.origin, "/api/bootstrap", {
      headers: {
        host: `127.0.0.1:${port}`,
        "x-forwarded-host": `rebind.example:${port}`,
      },
    });
    const rejected = await httpRequest(fixture.origin, "/api/bootstrap", {
      headers: {
        host: `rebind.example:${port}`,
        "x-forwarded-host": `127.0.0.1:${port}`,
      },
    });
    expect(accepted.status).toBe(200);
    expect(rejected.status).toBe(421);
    expect(fixture.runtime.metrics.routeDispatches).toBe(baseline + 1);
    expect(fixture.runtime.sentinelValue()).toBe(sentinel);
  });

  it("rejects cross-origin and PNA preflights without opt-in headers", async () => {
    const fixture = await runtimeFixture();
    const baseline = fixture.runtime.metrics.routeDispatches;
    const sentinel = fixture.runtime.sentinelValue();
    const responses = await Promise.all([
      httpRequest(fixture.origin, "/api/health", {
        headers: { origin: "https://evil.example" },
      }),
      httpRequest(fixture.origin, "/api/health", {
        headers: { origin: "null" },
      }),
      httpRequest(fixture.origin, "/api/settings", {
        method: "OPTIONS",
        headers: {
          origin: "https://evil.example",
          "access-control-request-method": "PUT",
          "access-control-request-private-network": "true",
        },
      }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(
        response.headers["access-control-allow-credentials"],
      ).toBeUndefined();
      expect(
        response.headers["access-control-allow-private-network"],
      ).toBeUndefined();
    }
    expect(fixture.runtime.metrics.routeDispatches).toBe(baseline);
    expect(fixture.runtime.sentinelValue()).toBe(sentinel);
  });

  it("requires a trusted source and current token for every unsafe method before body parsing", async () => {
    const fixture = await runtimeFixture();
    const bootstrapResponse = await httpRequest(
      fixture.origin,
      "/api/bootstrap",
    );
    const token = JSON.parse(bootstrapResponse.body).csrfToken as string;
    const baseline = fixture.runtime.metrics.routeDispatches;
    const sentinel = fixture.runtime.sentinelValue();
    const invalid: Array<{
      method: string;
      headers?: Record<string, string>;
      body?: string;
    }> = [
      { method: "POST" },
      { method: "PUT" },
      { method: "PATCH" },
      { method: "DELETE" },
      { method: "PROPFIND" },
      { method: "POST", headers: { origin: "null", "x-hekayati-csrf": token } },
      { method: "POST", headers: { origin: fixture.origin } },
      {
        method: "POST",
        headers: { origin: fixture.origin, "x-hekayati-csrf": "wrong" },
      },
      {
        method: "POST",
        headers: {
          origin: fixture.origin,
          "content-type": "application/json",
        },
        body: "{",
      },
    ];
    for (const request of invalid) {
      const response = await httpRequest(
        fixture.origin,
        "/api/testing/sentinel",
        request,
      );
      expect(response.status).toBe(403);
    }
    expect(fixture.runtime.metrics.routeDispatches).toBe(baseline);
    expect(fixture.runtime.sentinelValue()).toBe(sentinel);

    const valid = await mutate(fixture.origin, token, {
      origin: fixture.origin,
    });
    expect(valid.status).toBe(200);
    expect(JSON.parse(valid.body)).toEqual({ value: 1 });
    const referer = await mutate(fixture.origin, token, {
      referer: `${fixture.origin}/settings`,
    });
    expect(referer.status).toBe(200);
    expect(JSON.parse(referer.body)).toEqual({ value: 2 });
    const port = portOf(fixture.origin);
    const normalizedAlias = await mutate(fixture.origin, token, {
      referer: `http://2130706433:${port}/settings`,
    });
    expect(normalizedAlias.status).toBe(403);
    const malformedReferer = await mutate(fixture.origin, token, {
      referer: "not-a-valid-url",
    });
    expect(malformedReferer.status).toBe(403);
    const mismatchedReferer = await mutate(fixture.origin, token, {
      referer: `http://rebind.example:${port}/settings`,
    });
    expect(mismatchedReferer.status).toBe(403);
    const duplicateHeaders = await Promise.all([
      rawHttpRequest(
        port,
        unsafeRawHeaders(port, token, [
          `Origin: ${fixture.origin}`,
          `Origin: ${fixture.origin}`,
        ]),
      ),
      rawHttpRequest(
        port,
        unsafeRawHeaders(port, token, [
          `Referer: ${fixture.origin}/one`,
          `Referer: ${fixture.origin}/two`,
        ]),
      ),
      rawHttpRequest(
        port,
        unsafeRawHeaders(
          port,
          token,
          [`Origin: ${fixture.origin}`, `X-Hekayati-Csrf: ${token}`],
          true,
        ),
      ),
    ]);
    for (const response of duplicateHeaders) expect(response.status).toBe(403);
    expect(fixture.runtime.sentinelValue()).toBe(2);
    expect(fixture.runtime.metrics.routeDispatches).toBe(baseline + 2);
  });

  it("serves bootstrap no-store and keeps safe methods side-effect free", async () => {
    const fixture = await runtimeFixture();
    const before = fixture.runtime.sentinelValue();
    const bootstrap = await httpRequest(fixture.origin, "/api/bootstrap", {
      headers: { origin: fixture.origin },
    });
    const health = await httpRequest(fixture.origin, "/api/health");
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.headers["cache-control"]).toContain("no-store");
    expect(health.status).toBe(200);
    expect(fixture.runtime.sentinelValue()).toBe(before);
  });

  it("rotates the token on restart, rejects a stale tab, and preserves product state", async () => {
    const directory = await temporaryDirectory();
    cleanups.push(directory.cleanup);
    const first = await createRuntime({
      dataDir: directory.path,
      serveUi: false,
      enableTestRoutes: true,
    });
    const origin = await first.start();
    const port = portOf(origin);
    const firstBootstrap = JSON.parse(
      (await httpRequest(origin, "/api/bootstrap")).body,
    );
    const settings = JSON.parse(
      (await httpRequest(origin, "/api/settings")).body,
    );
    settings.watermarkText = "يبقى بعد إعادة التشغيل";
    await httpRequest(origin, "/api/settings", {
      method: "PUT",
      headers: secureHeaders(origin, firstBootstrap.csrfToken),
      body: JSON.stringify(toSettingsUpdate(settings)),
    });
    await first.close();

    const second = await createRuntime({
      dataDir: directory.path,
      serveUi: false,
      enableTestRoutes: true,
    });
    cleanups.push(() => second.close());
    const secondOrigin = await second.start({ port });
    expect(secondOrigin).toBe(origin);
    const baseline = second.metrics.routeDispatches;
    const sentinel = second.sentinelValue();
    const stale = await mutate(secondOrigin, firstBootstrap.csrfToken, {
      origin: secondOrigin,
    });
    expect(stale.status).toBe(403);
    expect(second.metrics.routeDispatches).toBe(baseline);
    expect(second.sentinelValue()).toBe(sentinel);
    const secondBootstrap = JSON.parse(
      (await httpRequest(secondOrigin, "/api/bootstrap")).body,
    );
    expect(secondBootstrap.csrfToken === firstBootstrap.csrfToken).toBe(false);
    expect(
      (
        await mutate(secondOrigin, secondBootstrap.csrfToken, {
          origin: secondOrigin,
        })
      ).status,
    ).toBe(200);
    const persisted = JSON.parse(
      (await httpRequest(secondOrigin, "/api/settings")).body,
    );
    expect(persisted.watermarkText).toBe("يبقى بعد إعادة التشغيل");
    await second.close();

    const corpus = await readCorpus(directory.path);
    expect(corpus.includes(firstBootstrap.csrfToken)).toBe(false);
    expect(corpus.includes(secondBootstrap.csrfToken)).toBe(false);
  });
});

async function runtimeFixture(): Promise<{
  runtime: HekayatiRuntime;
  origin: string;
}> {
  const directory = await temporaryDirectory();
  const runtime = await createRuntime({
    dataDir: directory.path,
    serveUi: false,
    enableTestRoutes: true,
  });
  const origin = await runtime.start();
  cleanups.push(runtime.close, directory.cleanup);
  return { runtime, origin };
}

function mutate(origin: string, token: string, source: Record<string, string>) {
  return httpRequest(origin, "/api/testing/sentinel", {
    method: "POST",
    headers: { ...source, "x-hekayati-csrf": token },
  });
}

function secureHeaders(origin: string, token: string): Record<string, string> {
  return {
    origin,
    "x-hekayati-csrf": token,
    "content-type": "application/json",
  };
}

function toSettingsUpdate(settings: Record<string, unknown>) {
  return Object.fromEntries(
    [
      "textProvider",
      "imageProvider",
      "models",
      "concurrencyPerProvider",
      "typography",
      "watermarkText",
      "diskWarnGb",
      "firstRunAcknowledged",
    ].map((key) => [key, settings[key]]),
  );
}

async function readCorpus(root: string): Promise<Buffer> {
  const entries = await readdir(root, { withFileTypes: true });
  const chunks = await Promise.all(
    entries.map(async (entry) => {
      const target = join(root, entry.name);
      return entry.isDirectory() ? readCorpus(target) : readFile(target);
    }),
  );
  return Buffer.concat(chunks);
}

function unsafeRawHeaders(
  port: number,
  token: string,
  sourceHeaders: string[],
  duplicateToken = false,
): string[] {
  const csrf = duplicateToken
    ? [`X-Hekayati-Csrf: ${token}`, `X-Hekayati-Csrf: ${token}`]
    : [`X-Hekayati-Csrf: ${token}`];
  return [
    "POST /api/testing/sentinel HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    ...sourceHeaders,
    ...csrf,
    "Content-Length: 0",
    "Connection: close",
  ];
}

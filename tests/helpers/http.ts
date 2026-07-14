import { request } from "node:http";
import { connect } from "node:net";

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export async function httpRequest(
  origin: string,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<HttpResponse> {
  const url = new URL(path, origin);
  return new Promise((resolve, reject) => {
    const call = request(
      url,
      {
        method: options.method ?? "GET",
        agent: false,
        headers: { connection: "close", ...options.headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) =>
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
        );
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    call.once("error", reject);
    if (options.body !== undefined) call.write(options.body);
    call.end();
  });
}

export async function rawHttpRequest(
  port: number,
  lines: string[],
): Promise<HttpResponse> {
  const raw = await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.once("connect", () => socket.end(`${lines.join("\r\n")}\r\n\r\n`));
    socket.on("data", (chunk) =>
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
    );
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.once("error", reject);
  });
  const [head, body = ""] = raw.split("\r\n\r\n", 2);
  const headerLines = head.split("\r\n");
  const status = Number(headerLines[0]?.split(" ")[1] ?? 0);
  const headers = Object.fromEntries(
    headerLines.slice(1).map((line) => {
      const separator = line.indexOf(":");
      return [
        line.slice(0, separator).toLowerCase(),
        line.slice(separator + 1).trim(),
      ];
    }),
  );
  return { status, headers, body };
}

export function portOf(origin: string): number {
  return Number(new URL(origin).port);
}

import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProviderLoggingProxy } from "../../src/diagnostics/ProviderLoggingProxy.js";

const servers: Server[] = [];
const directories: string[] = [];
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  return `http://127.0.0.1:${address.port}`;
}
async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "provider-proxy-test-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("provider logging proxy", () => {
  it("preserves exact request and streamed response bytes, without logging auth headers", async () => {
    const body = JSON.stringify({ input: 'quote " slash \\ newline\nУкраїна', stream: true });
    const sse = `data: ${JSON.stringify({ delta: '"' })}\n\ndata: [DONE]\n\n`;
    let received = "";
    let authorization: string | undefined;
    let path: string | undefined;
    const upstream = await listen(createServer(async (req, res) => {
      authorization = req.headers.authorization;
      path = req.url;
      for await (const chunk of req) received += String(chunk);
      res.writeHead(200, { "content-type": "text/event-stream", "set-cookie": "secret-cookie" });
      res.write(sse.slice(0, 12));
      setTimeout(() => res.end(sse.slice(12)), 10);
    }));
    const proxy = await createProviderLoggingProxy({ upstream: `${upstream}/v1`, directory: await temporaryDirectory(), captureBodies: true });
    const base = await listen(proxy.server);
    const response = await fetch(`${base}/v1/responses`, { method: "POST", body, headers: { authorization: "Bearer secret-token" } });
    expect(await response.text()).toBe(sse);
    await proxy.flush();
    expect(received).toBe(body);
    expect(authorization).toBe("Bearer secret-token");
    expect(path).toBe("/v1/responses");
    const files = await readdir(proxy.directory);
    expect(files).toHaveLength(3);
    const contents = await Promise.all(files.map((file) => readFile(join(proxy.directory, file), "utf8")));
    expect(contents).toContain(body);
    expect(contents).toContain(sse);
    expect(contents.join("")).not.toContain("secret-token");
    expect(contents.join("")).not.toContain("secret-cookie");
    const metadata = JSON.parse(contents.find((content) => content.includes('"startedAt"')) ?? "{}");
    expect(metadata.status).toBe(200);
    expect(metadata.outcome).toBe("complete");
    expect(metadata.request.truncated).toBe(false);
    expect((await stat(proxy.directory)).mode & 0o777).toBe(0o700);
    for (const file of files) expect((await stat(join(proxy.directory, file))).mode & 0o777).toBe(0o600);
  });

  it("captures HTTP 500 and caps stored bodies without truncating the forwarded payload", async () => {
    const upstream = await listen(createServer(async (req, res) => {
      for await (const _chunk of req) { /* consume request */ }
      res.writeHead(500).end("invalid JSON arguments");
    }));
    const proxy = await createProviderLoggingProxy({ upstream: `${upstream}/v1`, directory: await temporaryDirectory(), captureBodies: true, maxBodyBytes: 4, maxRequests: 1 });
    const base = await listen(proxy.server);
    const response = await fetch(`${base}/v1/responses`, { method: "POST", body: "123456789" });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("invalid JSON arguments");
    await proxy.flush();
    const files = await readdir(proxy.directory);
    const metadata = JSON.parse(await readFile(join(proxy.directory, files.find((file) => file.endsWith(".json")) ?? ""), "utf8"));
    expect(metadata.status).toBe(500);
    expect(metadata.request).toMatchObject({ bytes: 9, capturedBytes: 4, truncated: true });
    expect(metadata.response.truncated).toBe(true);
    expect((await fetch(`${base}/v1/models`)).status).toBe(503);
    expect((await fetch(`${base}/v1/models?key=secret`)).status).toBe(404);
  });

  it("defaults to metadata only and does not follow redirects", async () => {
    const upstream = await listen(createServer((_req, res) => res.writeHead(302, { location: "http://example.invalid/" }).end("private body")));
    const proxy = await createProviderLoggingProxy({ upstream: `${upstream}/v1`, directory: await temporaryDirectory() });
    const base = await listen(proxy.server);
    const response = await fetch(`${base}/v1/models`, { redirect: "manual" });
    expect(response.status).toBe(302);
    await response.text();
    await proxy.flush();
    const files = await readdir(proxy.directory);
    expect(files).toHaveLength(1);
    expect(await readFile(join(proxy.directory, files[0] ?? ""), "utf8")).not.toContain("private body");
  });

  it("ends stalled upstream requests at the deadline with sanitized metadata", async () => {
    const upstream = await listen(createServer((_req, _res) => { /* deliberately stalled */ }));
    const proxy = await createProviderLoggingProxy({ upstream: `${upstream}/v1`, directory: await temporaryDirectory(), timeoutMs: 30 });
    const base = await listen(proxy.server);
    const response = await fetch(`${base}/v1/models`);
    expect(response.status).toBe(502);
    await response.text();
    await proxy.flush();
    const files = await readdir(proxy.directory);
    const metadata = JSON.parse(await readFile(join(proxy.directory, files[0] ?? ""), "utf8"));
    expect(metadata.outcome).toBe("transport_error_or_abort");
    expect(metadata.status).toBeNull();
  });

  it("delivers SSE before upstream completion and records interrupted streams", async () => {
    let disconnect: (() => void) | undefined;
    const upstream = await listen(createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      disconnect = () => res.destroy();
    }));
    const proxy = await createProviderLoggingProxy({ upstream: `${upstream}/v1`, directory: await temporaryDirectory(), captureBodies: true });
    const base = await listen(proxy.server);
    const response = await fetch(`${base}/v1/responses`, { method: "POST", body: "{}" });
    const reader = response.body?.getReader();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("data: first\n\n");
    disconnect?.();
    await expect(reader?.read()).rejects.toThrow();
    await proxy.flush();
    const files = await readdir(proxy.directory);
    const metadata = JSON.parse(await readFile(join(proxy.directory, files.find((file) => file.endsWith(".json")) ?? ""), "utf8"));
    expect(metadata.outcome).toBe("transport_error_or_abort");
    expect(metadata.response.bytes).toBe(13);
  });
});

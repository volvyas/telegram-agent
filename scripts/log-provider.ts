import { createProviderLoggingProxy } from "../src/diagnostics/ProviderLoggingProxy.js";

const upstream = process.env.PROVIDER_LOG_UPSTREAM;
if (!upstream) throw new Error("PROVIDER_LOG_UPSTREAM is required (include /v1)");
const port = Number(process.env.PROVIDER_LOG_PORT ?? "8081");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PROVIDER_LOG_PORT");
const captureBodies = process.env.PROVIDER_LOG_BODIES === "1";
const proxy = await createProviderLoggingProxy({
  upstream,
  directory: process.env.PROVIDER_LOG_DIR ?? "logs/provider",
  captureBodies,
  maxBodyBytes: Number(process.env.PROVIDER_LOG_MAX_BODY_BYTES ?? 2097152),
  maxRequests: Number(process.env.PROVIDER_LOG_MAX_REQUESTS ?? 100),
  onLogError: () => console.error("Provider trace write failed; check disk space and permissions."),
});
if (captureBodies) console.warn("Sensitive capture enabled: bodies may contain code, prompts, reasoning and secrets. Do not share raw logs.");
proxy.server.listen(port, "127.0.0.1", () => {
  console.log(`Provider trace: http://127.0.0.1:${port}/v1; directory: ${proxy.directory}`);
});
proxy.server.on("error", () => { console.error("Provider trace server failed to listen."); process.exitCode = 1; });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    proxy.server.close(() => { void proxy.flush(); });
  });
}

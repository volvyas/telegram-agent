import { ProviderDiagnosticService } from "../src/diagnostics/ProviderDiagnosticService.js";

const providerId = required("PROBE_PROVIDER_ID");
const baseUrl = required("PROBE_BASE_URL");
const model = required("PROBE_MODEL");
const apiKey = process.env.PROBE_API_KEY?.trim();

const url = new URL(baseUrl);
if ((url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 || url.password.length > 0 ||
    url.search.length > 0 || url.hash.length > 0 ||
    (url.protocol === "http:" && !isPrivateHost(url.hostname))) {
  throw new Error("PROBE_BASE_URL must be an absolute HTTP(S) URL without credentials, query or fragment");
}

const result = await new ProviderDiagnosticService().probe({
  providerId,
  model,
  ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
  provider: {
    type: "responses",
    name: "operator probe",
    baseUrl: baseUrl.replace(/\/+$/u, ""),
    wireApi: "responses",
  },
});

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "127.0.0.1") return true;
  if (/^10\./u.test(host) || /^192\.168\./u.test(host) || /^169\.254\./u.test(host)) return true;
  const private172 = /^172\.(\d{1,3})\./u.exec(host);
  return private172 !== null && Number(private172[1]) >= 16 && Number(private172[1]) <= 31;
}

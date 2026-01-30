import "dotenv/config";

const TOKEN = process.env.VIDALYTICS_API_TOKEN!;
const BASE = "https://api.vidalytics.com";

async function tryAuth(label: string, url: string, headers: Record<string, string>): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json", ...headers },
    });
    const body = await res.text();
    console.log(`  [${res.status}] ${label}`);
    if (res.status === 200) {
      console.log(`    FOUND! ${body.substring(0, 300)}`);
      return true;
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  [ERR] ${label}: ${msg}`);
  }
  return false;
}

async function tryPost(label: string, url: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log(`  [${res.status}] POST ${label}`);
    if (res.status === 200) {
      console.log(`    FOUND! ${text.substring(0, 300)}`);
      return true;
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  [ERR] POST ${label}: ${msg}`);
  }
  return false;
}

async function main() {
  console.log("=== Extended Vidalytics API Auth Discovery ===\n");

  // Phase 1: Query parameter auth
  console.log("Query parameter auth:");
  const qParams = ["api_token", "token", "api_key", "key", "access_token", "apiToken", "apiKey"];
  for (const param of qParams) {
    const found = await tryAuth(`?${param}=...`, `${BASE}/stats/usage?${param}=${TOKEN}`, {});
    if (found) return;
  }

  // Phase 2: Basic auth variations
  console.log("\nBasic auth:");
  const basicVariants = [
    Buffer.from(`${TOKEN}:`).toString("base64"),
    Buffer.from(`:${TOKEN}`).toString("base64"),
    Buffer.from(`api:${TOKEN}`).toString("base64"),
    Buffer.from(`${TOKEN}:x`).toString("base64"),
  ];
  for (const basic of basicVariants) {
    const found = await tryAuth(`Basic ${basic.substring(0, 15)}...`, `${BASE}/stats/usage`, {
      Authorization: `Basic ${basic}`,
    });
    if (found) return;
  }

  // Phase 3: Less common header names
  console.log("\nCustom headers:");
  const customHeaders = ["token", "api_token", "apitoken", "apiToken", "x-token", "access-token", "vid-token", "vid-api-key"];
  for (const hdr of customHeaders) {
    const found = await tryAuth(`${hdr}: <token>`, `${BASE}/stats/usage`, { [hdr]: TOKEN });
    if (found) return;
  }

  // Phase 4: POST with body
  console.log("\nPOST with body:");
  const bodyKeys = ["api_token", "token", "apiToken", "key", "api_key", "apiKey"];
  for (const key of bodyKeys) {
    const found = await tryPost(`{ ${key}: ... }`, `${BASE}/stats/usage`, { [key]: TOKEN });
    if (found) return;
  }

  // Phase 5: Try different base paths that might require different auth
  console.log("\nTrying different paths on api.vidalytics.com:");
  const altPaths = ["/", "/v1", "/v2", "/api", "/api/v1", "/health", "/ping", "/status"];
  for (const path of altPaths) {
    const found = await tryAuth(`Bearer ${path}`, `${BASE}${path}`, {
      Authorization: `Bearer ${TOKEN}`,
    });
    if (found) return;
  }

  // Phase 6: Maybe the token format is wrong — try with/without dashes
  console.log("\nTrying alternate token formats:");
  const noDashes = TOKEN.replace(/-/g, "");
  const bearerAuth = { Authorization: `Bearer ${TOKEN}` };
  const found1 = await tryAuth("No-dash token, Bearer", `${BASE}/stats/usage`, {
    Authorization: `Bearer ${noDashes}`,
  });
  if (found1) return;

  // Phase 7: Try the /videos endpoint directly with Bearer (maybe /stats/usage has different requirements)
  console.log("\nTrying non-stats endpoints with Bearer:");
  const endpoints = ["/videos", "/video", "/folders", "/account", "/me", "/user", "/videos/list"];
  for (const ep of endpoints) {
    const found = await tryAuth(`Bearer ${ep}`, `${BASE}${ep}`, bearerAuth);
    if (found) return;
  }

  console.log("\n=== No working combination found ===");
  console.log("The base URL is confirmed (api.vidalytics.com returns JSON 401s)");
  console.log("but no auth pattern works with this token.");
  console.log("\nNext steps:");
  console.log("  1. Open https://api-docs.vidalytics.com/ in your browser while logged in");
  console.log("  2. Look for the 'Authorize' button in the Swagger UI");
  console.log("  3. Check what auth scheme it expects (Bearer, API Key header name, etc.)");
  console.log("  4. Verify the token is correct in Account Settings > Global Settings");
}

main().catch(console.error);

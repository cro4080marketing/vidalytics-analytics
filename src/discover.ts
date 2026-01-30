import "dotenv/config";

const API_TOKEN: string = process.env.VIDALYTICS_API_TOKEN ?? "";
if (!API_TOKEN) {
  console.error("Missing VIDALYTICS_API_TOKEN in .env");
  process.exit(1);
}

const BASE_URLS = [
  "https://api.vidalytics.com",
  "https://api.vidalytics.com/v1",
  "https://app.vidalytics.com/api",
  "https://app.vidalytics.com/api/v1",
  "https://api-docs.vidalytics.com/api",
];

const AUTH_COMBOS = [
  { header: "Authorization", prefix: "Bearer ", label: "Bearer token" },
  { header: "Authorization", prefix: "Token ", label: "Token prefix" },
  { header: "X-Api-Key", prefix: "", label: "X-Api-Key header" },
  { header: "X-Api-Token", prefix: "", label: "X-Api-Token header" },
  { header: "X-Auth-Token", prefix: "", label: "X-Auth-Token header" },
  { header: "api-token", prefix: "", label: "api-token header" },
];

const PROBE_PATHS = [
  "/stats/usage",
  "/videos",
  "/video",
  "/folders",
  "/account",
  "/me",
  "/user",
];

const DETAIL_PROBE_PATHS = [
  "/videos?limit=1",
  "/video/list",
  "/videos/list",
  "/stats/videos",
  "/stats/video",
];

interface ProbeResult {
  baseUrl: string;
  authHeader: string;
  authPrefix: string;
  status: number;
  body: string;
}

async function probe(
  baseUrl: string,
  path: string,
  authHeader: string,
  authValue: string
): Promise<{ status: number; body: string } | null> {
  const url = `${baseUrl}${path}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        [authHeader]: authValue,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
    const body = await res.text();
    return { status: res.status, body: body.substring(0, 500) };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 0, body: `Network error: ${msg}` };
  }
}

async function discover(): Promise<void> {
  console.log("=== Vidalytics API Discovery ===\n");
  console.log(`Token: ${API_TOKEN.substring(0, 8)}...${API_TOKEN.substring(API_TOKEN.length - 4)}\n`);

  let found: ProbeResult | null = null;

  // Phase 1: Find working base URL + auth combo using /stats/usage (confirmed endpoint)
  console.log("Phase 1: Finding working auth combination...\n");

  for (const baseUrl of BASE_URLS) {
    if (found) break;
    for (const auth of AUTH_COMBOS) {
      const authValue = `${auth.prefix}${API_TOKEN}`;
      const result = await probe(baseUrl, "/stats/usage", auth.header, authValue);
      if (!result) continue;

      const indicator =
        result.status === 200
          ? "OK"
          : result.status === 401 || result.status === 403
            ? "AUTH FAIL"
            : result.status === 404
              ? "NOT FOUND"
              : result.status === 0
                ? "NET ERR"
                : `${result.status}`;

      console.log(`  [${indicator}] ${baseUrl}/stats/usage | ${auth.label}`);

      if (result.status === 200) {
        console.log(`  Response: ${result.body}\n`);
        found = {
          baseUrl,
          authHeader: auth.header,
          authPrefix: auth.prefix,
          status: result.status,
          body: result.body,
        };
        break;
      }

      // If we get a non-404 response, the base URL might be right but auth is wrong
      if (result.status !== 404 && result.status !== 0) {
        console.log(`    Body: ${result.body.substring(0, 100)}`);
      }
    }
  }

  if (!found) {
    // Phase 1b: Try without the /stats/usage path — maybe that endpoint name differs
    console.log("\n/stats/usage not found. Trying root endpoints...\n");

    for (const baseUrl of BASE_URLS) {
      if (found) break;
      for (const auth of AUTH_COMBOS) {
        const authValue = `${auth.prefix}${API_TOKEN}`;
        for (const path of PROBE_PATHS) {
          const result = await probe(baseUrl, path, auth.header, authValue);
          if (!result) continue;

          if (result.status === 200) {
            console.log(`  [OK] ${baseUrl}${path} | ${auth.label}`);
            console.log(`  Response: ${result.body}\n`);
            found = {
              baseUrl,
              authHeader: auth.header,
              authPrefix: auth.prefix,
              status: result.status,
              body: result.body,
            };
            break;
          }
        }
        if (found) break;
      }
    }
  }

  if (!found) {
    console.log("\nNo working auth combination found.");
    console.log("Possible issues:");
    console.log("  1. API token may be invalid or expired");
    console.log("  2. Your Vidalytics plan may not include API access (Premium required)");
    console.log("  3. Base URL may differ from expected patterns");
    console.log("\nPlease verify your token at: Account Settings > Global Settings in Vidalytics");
    console.log("API docs: https://api-docs.vidalytics.com/");
    return;
  }

  // Phase 2: Probe all endpoint paths with the working auth
  console.log("Phase 2: Mapping available endpoints...\n");

  const allPaths = [...PROBE_PATHS, ...DETAIL_PROBE_PATHS];
  const discovered: Array<{ path: string; status: number; body: string }> = [];

  for (const path of allPaths) {
    const authValue = `${found.authPrefix}${API_TOKEN}`;
    const result = await probe(found.baseUrl, path, found.authHeader, authValue);
    if (!result) continue;

    const indicator = result.status === 200 ? "OK" : `${result.status}`;
    console.log(`  [${indicator}] ${path}`);

    if (result.status === 200) {
      console.log(`    ${result.body.substring(0, 200)}`);
      discovered.push({ path, status: result.status, body: result.body });
    }
  }

  // Phase 3: If we found videos, try to get stats for one
  console.log("\nPhase 3: Probing video-specific endpoints...\n");

  let sampleVideoId: string | null = null;

  for (const ep of discovered) {
    if (ep.path.includes("video")) {
      try {
        const parsed = JSON.parse(ep.body);
        // Try common response shapes
        const videos = Array.isArray(parsed)
          ? parsed
          : parsed.data
            ? Array.isArray(parsed.data)
              ? parsed.data
              : []
            : parsed.videos
              ? parsed.videos
              : [];
        if (videos.length > 0) {
          sampleVideoId = videos[0].id || videos[0].video_id || videos[0].uuid;
          console.log(`  Found sample video ID: ${sampleVideoId}`);
        }
      } catch {
        // Not JSON or unexpected shape
      }
    }
  }

  if (sampleVideoId) {
    const statsPaths = [
      `/videos/${sampleVideoId}/stats`,
      `/video/${sampleVideoId}/stats`,
      `/stats/video/${sampleVideoId}`,
      `/videos/${sampleVideoId}`,
      `/video/${sampleVideoId}`,
      `/videos/${sampleVideoId}/engagement`,
      `/videos/${sampleVideoId}/timeline`,
      `/stats/timeline?video_id=${sampleVideoId}`,
      `/stats/engagement?video_id=${sampleVideoId}`,
    ];

    for (const path of statsPaths) {
      const authValue = `${found.authPrefix}${API_TOKEN}`;
      const result = await probe(found.baseUrl, path, found.authHeader, authValue);
      if (!result) continue;

      const indicator = result.status === 200 ? "OK" : `${result.status}`;
      console.log(`  [${indicator}] ${path}`);
      if (result.status === 200) {
        console.log(`    ${result.body.substring(0, 300)}`);
        discovered.push({ path, status: result.status, body: result.body });
      }
    }
  }

  // Summary
  console.log("\n=== Discovery Summary ===\n");
  console.log(`Base URL:    ${found.baseUrl}`);
  console.log(`Auth Header: ${found.authHeader}`);
  console.log(`Auth Prefix: ${found.authPrefix ? `"${found.authPrefix}"` : "(none)"}`);
  console.log(`\nWorking endpoints:`);
  for (const ep of discovered) {
    console.log(`  ${ep.path}`);
  }

  console.log("\n=== .env Configuration ===\n");
  console.log(`VIDALYTICS_BASE_URL=${found.baseUrl}`);
  console.log(`VIDALYTICS_AUTH_HEADER=${found.authHeader}`);
  console.log(`VIDALYTICS_AUTH_PREFIX=${found.authPrefix}`);

  console.log("\nAdd these to your .env file to configure the API client.");
}

discover().catch(console.error);

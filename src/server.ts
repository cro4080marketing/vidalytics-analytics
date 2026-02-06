import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { VidalyticsClient } from "./vidalytics.js";
import { GeminiAnalyzer } from "./gemini.js";
import { ClaudeRewriter } from "./claude.js";
import {
  analyzeVideo,
  analyzePortfolio,
  calculateScore,
  ratingFromScore,
  findSignificantDrops,
} from "./analyzer.js";
import type { VideoStats, ContentAnalysis, GeneratedCROTests, VideoComparison } from "./types.js";
import { cacheKey, readCache, readCacheWithMeta } from "./cache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const apiToken = process.env.VIDALYTICS_API_TOKEN;
if (!apiToken) {
  console.error("Missing VIDALYTICS_API_TOKEN in .env");
  process.exit(1);
}

const geminiKey = process.env.GEMINI_API_KEY;
const anthropicKey = process.env.ANTHROPIC_API_KEY;
const port = parseInt(process.env.PORT || "3001", 10);
const client = new VidalyticsClient(apiToken);
const gemini = geminiKey ? new GeminiAnalyzer(geminiKey) : null;
const claude = anthropicKey ? new ClaudeRewriter(anthropicKey) : null;
const app = express();

// ── Serve dashboard ──

const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// ── API Routes ──

// List all videos with basic info + score
app.get("/api/videos", async (req, res) => {
  try {
    const dateFrom = (req.query.from as string) || defaultDateFrom();
    const dateTo = (req.query.to as string) || defaultDateTo();

    const videos = await client.listVideos();

    // Fetch stats in batches of 5 with 500ms delay to avoid rate limits
    const allStats = await fetchInBatches(
      videos.map((v) => () =>
        client.getVideoStats(v.id, dateFrom, dateTo).catch(() => null)
      ),
      5,
      500
    );

    const results = videos.map((video, i) => {
      const stats = allStats[i];
      const score = stats ? calculateScore(stats) : 0;
      return {
        ...video,
        stats,
        score,
        rating: ratingFromScore(score),
      };
    });

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    res.json({ videos: results, dateFrom, dateTo });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// Get full analysis for a single video
app.get("/api/videos/:id/analysis", async (req, res) => {
  try {
    const videoId = req.params.id;
    const dateFrom = (req.query.from as string) || defaultDateFrom();
    const dateTo = (req.query.to as string) || defaultDateTo();
    const filters = parseUrlParamFilters(req.query as Record<string, unknown>);

    const [videos, stats, dropOff] = await Promise.all([
      client.listVideos(),
      client.getVideoStats(videoId, dateFrom, dateTo, filters),
      client.getDropOff(videoId, dateFrom, dateTo, filters),
    ]);

    const video = videos.find((v) => v.id === videoId);
    if (!video) {
      res.status(404).json({ error: "Video not found" });
      return;
    }

    const analysis = analyzeVideo(video, stats, dropOff);
    res.json({ analysis, dropOff, stats });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// Portfolio summary
app.get("/api/summary", async (req, res) => {
  try {
    const dateFrom = (req.query.from as string) || defaultDateFrom();
    const dateTo = (req.query.to as string) || defaultDateTo();

    const videos = await client.listVideos();

    // Fetch stats in batches of 5 with 500ms delay to avoid rate limits
    const allStatsRaw = await fetchInBatches(
      videos.map((v) => () =>
        client.getVideoStats(v.id, dateFrom, dateTo).catch(() => null)
      ),
      5,
      500
    );
    const allStats = allStatsRaw.filter((s): s is VideoStats => s !== null);

    const summary = analyzePortfolio(videos, allStats);
    res.json({ summary, dateFrom, dateTo });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// API usage
app.get("/api/usage", async (_req, res) => {
  try {
    const usage = await client.getUsage();
    res.json(usage);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── AI Analysis Routes ──

// Check if AI analysis is available
app.get("/api/ai-status", (_req, res) => {
  if (!gemini) {
    res.json({
      available: false,
      reason: "GEMINI_API_KEY not set in .env file",
    });
    return;
  }
  res.json({ available: true });
});

// Full AI content analysis for a video (SSE streaming with progress)
app.get("/api/videos/:id/content-analysis", async (req, res) => {
  if (!gemini) {
    res.status(503).json({ error: "AI analysis not available. Add GEMINI_API_KEY to .env." });
    return;
  }

  // Check if client wants SSE (streaming progress)
  const wantSSE = req.query.stream === "1";
  const videoContext = (req.query.context as string) || "";

  if (wantSSE) {
    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const onProgress = (step: number, totalSteps: number, label: string, detail?: string) => {
      sendEvent("progress", { step, totalSteps, label, detail: detail ?? "" });
    };

    try {
      const videoId = req.params.id;
      const dateFrom = (req.query.from as string) || defaultDateFrom();
      const dateTo = (req.query.to as string) || defaultDateTo();
      const filters = parseUrlParamFilters(req.query as Record<string, unknown>);

      sendEvent("progress", { step: 0, totalSteps: 6, label: "Loading video data", detail: "Fetching stats and drop-off data..." });

      const [videos, stats, dropOff] = await Promise.all([
        client.listVideos(),
        client.getVideoStats(videoId, dateFrom, dateTo, filters),
        client.getDropOff(videoId, dateFrom, dateTo, filters),
      ]);

      const video = videos.find((v) => v.id === videoId);
      if (!video) { sendEvent("error", { error: "Video not found" }); res.end(); return; }
      if (!video.videoUrl) { sendEvent("error", { error: "No video URL available" }); res.end(); return; }

      const significantDrops = findSignificantDrops(dropOff);

      const result = await gemini.analyze(
        videoId, video.videoUrl, video.title, stats, significantDrops, onProgress,
        videoContext || undefined
      );

      sendEvent("complete", {
        analysis: result.analysis,
        cached: result.cached,
        cachedAt: result.cachedAt ?? null,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[AI Analysis Error] ${msg}`);
      sendEvent("error", { error: msg });
    }
    res.end();
  } else {
    // Standard JSON response (no progress)
    try {
      const videoId = req.params.id;
      const dateFrom = (req.query.from as string) || defaultDateFrom();
      const dateTo = (req.query.to as string) || defaultDateTo();
      const filters = parseUrlParamFilters(req.query as Record<string, unknown>);

      const [videos, stats, dropOff] = await Promise.all([
        client.listVideos(),
        client.getVideoStats(videoId, dateFrom, dateTo, filters),
        client.getDropOff(videoId, dateFrom, dateTo, filters),
      ]);

      const video = videos.find((v) => v.id === videoId);
      if (!video) { res.status(404).json({ error: "Video not found" }); return; }
      if (!video.videoUrl) { res.status(400).json({ error: "No video URL available for this video" }); return; }

      const significantDrops = findSignificantDrops(dropOff);
      const result = await gemini.analyze(videoId, video.videoUrl, video.title, stats, significantDrops, undefined, videoContext || undefined);

      res.json({ analysis: result.analysis, cached: result.cached, cachedAt: result.cachedAt ?? null });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[AI Analysis Error] ${msg}`);
      res.status(500).json({ error: msg });
    }
  }
});

// ── Script Rewrite Routes (Claude) ──

// Check if script rewriting is available
app.get("/api/rewrite-status", (_req, res) => {
  if (!claude) {
    res.json({
      available: false,
      reason: "ANTHROPIC_API_KEY not set in .env file",
    });
    return;
  }
  res.json({ available: true });
});

// Rewrite script based on expert feedback (SSE streaming)
app.get("/api/videos/:id/rewrite-script", async (req, res) => {
  if (!claude) {
    res.status(503).json({ error: "Script rewriting not available. Add ANTHROPIC_API_KEY to .env." });
    return;
  }

  const videoId = req.params.id;
  const expertIndex = parseInt((req.query.expert as string) || "0", 10);
  const wantSSE = req.query.stream === "1";
  const videoContext = (req.query.context as string) || "";

  // Load the cached AI analysis (must exist already)
  const analysisKey = cacheKey(`ai-analysis-${videoId}`, {});
  const cachedAnalysis = readCacheWithMeta<ContentAnalysis>(analysisKey);

  if (!cachedAnalysis) {
    if (wantSSE) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`event: error\ndata: ${JSON.stringify({ error: "AI analysis must be run first. Click the AI Analysis button before rewriting." })}\n\n`);
      res.end();
    } else {
      res.status(400).json({ error: "AI analysis must be run first. Click the AI Analysis button before rewriting." });
    }
    return;
  }

  const analysis = cachedAnalysis.data;
  const expert = analysis.expertFeedback[expertIndex];

  if (!expert) {
    const errMsg = `Expert index ${expertIndex} not found. Available: 0-${analysis.expertFeedback.length - 1}`;
    if (wantSSE) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`event: error\ndata: ${JSON.stringify({ error: errMsg })}\n\n`);
      res.end();
    } else {
      res.status(400).json({ error: errMsg });
    }
    return;
  }

  if (!analysis.transcript) {
    const errMsg = "No transcript available. Re-run the AI analysis to generate a transcript.";
    if (wantSSE) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`event: error\ndata: ${JSON.stringify({ error: errMsg })}\n\n`);
      res.end();
    } else {
      res.status(400).json({ error: errMsg });
    }
    return;
  }

  if (wantSSE) {
    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const onProgress = (step: number, totalSteps: number, label: string, detail?: string) => {
      sendEvent("progress", { step, totalSteps, label, detail: detail ?? "" });
    };

    try {
      const result = await claude.rewrite(
        videoId, expertIndex, analysis.transcript, expert, analysis.scriptStructure, onProgress,
        videoContext || undefined
      );

      sendEvent("complete", {
        rewrittenScript: result.rewrittenScript,
        cached: result.cached,
        cachedAt: result.cachedAt ?? null,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Script Rewrite Error] ${msg}`);
      sendEvent("error", { error: msg });
    }
    res.end();
  } else {
    // Standard JSON response
    try {
      const result = await claude.rewrite(
        videoId, expertIndex, analysis.transcript, expert, analysis.scriptStructure, undefined,
        videoContext || undefined
      );

      res.json({
        rewrittenScript: result.rewrittenScript,
        cached: result.cached,
        cachedAt: result.cachedAt ?? null,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Script Rewrite Error] ${msg}`);
      res.status(500).json({ error: msg });
    }
  }
});

// ── Generate New CRO Tests (Claude) ──

app.get("/api/videos/:id/generate-cro-tests", async (req, res) => {
  if (!claude) {
    res.status(503).json({ error: "CRO test generation not available. Add ANTHROPIC_API_KEY to .env." });
    return;
  }

  const videoId = req.params.id;
  const expertIndex = parseInt((req.query.expert as string) || "0", 10);
  const wantSSE = req.query.stream === "1";
  const videoContext = (req.query.context as string) || "";

  // Load the cached AI analysis (must exist already)
  const analysisKey = cacheKey(`ai-analysis-${videoId}`, {});
  const cachedAnalysis = readCacheWithMeta<ContentAnalysis>(analysisKey);

  if (!cachedAnalysis) {
    const errMsg = "AI analysis must be run first. Click the AI Analysis button before generating new tests.";
    if (wantSSE) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`event: error\ndata: ${JSON.stringify({ error: errMsg })}\n\n`);
      res.end();
    } else {
      res.status(400).json({ error: errMsg });
    }
    return;
  }

  const analysis = cachedAnalysis.data;
  const expert = analysis.expertFeedback[expertIndex];

  if (!expert) {
    const errMsg = `Expert index ${expertIndex} not found.`;
    if (wantSSE) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`event: error\ndata: ${JSON.stringify({ error: errMsg })}\n\n`);
      res.end();
    } else {
      res.status(400).json({ error: errMsg });
    }
    return;
  }

  if (!analysis.transcript) {
    const errMsg = "No transcript available. Re-run the AI analysis to generate a transcript.";
    if (wantSSE) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`event: error\ndata: ${JSON.stringify({ error: errMsg })}\n\n`);
      res.end();
    } else {
      res.status(400).json({ error: errMsg });
    }
    return;
  }

  // Collect all existing test names (original Gemini + all previous batches)
  const allPreviousTestNames: string[] = [];
  if (expert.croTests) {
    for (const t of expert.croTests) {
      allPreviousTestNames.push(t.testName);
    }
  }

  // Scan for previously generated batches
  let nextBatch = 1;
  while (true) {
    const batchKey = cacheKey(`new-cro-tests-${videoId}-expert${expertIndex}-batch${nextBatch}`, {});
    const existingBatch = readCache<GeneratedCROTests>(batchKey);
    if (!existingBatch) break;
    for (const t of existingBatch.tests) {
      allPreviousTestNames.push(t.testName);
    }
    nextBatch++;
  }

  if (wantSSE) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });

    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const onProgress = (step: number, totalSteps: number, label: string, detail?: string) => {
      sendEvent("progress", { step, totalSteps, label, detail: detail ?? "" });
    };

    try {
      const result = await claude.generateCROTests(
        videoId, expertIndex, analysis.transcript, expert,
        allPreviousTestNames, nextBatch, onProgress,
        videoContext || undefined
      );

      sendEvent("complete", {
        generatedTests: result.generatedTests,
        cached: result.cached,
        cachedAt: result.cachedAt ?? null,
        batchNumber: nextBatch,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[CRO Test Generation Error] ${msg}`);
      sendEvent("error", { error: msg });
    }
    res.end();
  } else {
    try {
      const result = await claude.generateCROTests(
        videoId, expertIndex, analysis.transcript, expert,
        allPreviousTestNames, nextBatch, undefined,
        videoContext || undefined
      );
      res.json({
        generatedTests: result.generatedTests,
        cached: result.cached,
        cachedAt: result.cachedAt ?? null,
        batchNumber: nextBatch,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[CRO Test Generation Error] ${msg}`);
      res.status(500).json({ error: msg });
    }
  }
});

// ── Video Comparison (Claude) ──

app.get("/api/compare/:idA/:idB", async (req, res) => {
  if (!claude) {
    res.status(503).json({ error: "Comparison not available. Add ANTHROPIC_API_KEY to .env." });
    return;
  }

  const { idA, idB } = req.params;
  const wantSSE = req.query.stream === "1";
  const dateFrom = (req.query.from as string) || defaultDateFrom();
  const dateTo = (req.query.to as string) || defaultDateTo();

  // Load cached AI analyses for both videos (must exist)
  const keyA = cacheKey(`ai-analysis-${idA}`, {});
  const keyB = cacheKey(`ai-analysis-${idB}`, {});
  const cachedA = readCacheWithMeta<ContentAnalysis>(keyA);
  const cachedB = readCacheWithMeta<ContentAnalysis>(keyB);

  if (!cachedA || !cachedB) {
    const missing = !cachedA && !cachedB ? "both videos" : !cachedA ? "Video A" : "Video B";
    const errMsg = `AI analysis must be run for ${missing} first. Analyze each video individually before comparing.`;
    if (wantSSE) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`event: error\ndata: ${JSON.stringify({ error: errMsg })}\n\n`);
      res.end();
    } else {
      res.status(400).json({ error: errMsg });
    }
    return;
  }

  if (wantSSE) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });

    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onProgress = (step: number, totalSteps: number, label: string, detail?: string) => {
      sendEvent("progress", { step, totalSteps, label, detail: detail ?? "" });
    };

    try {
      sendEvent("progress", { step: 0, totalSteps: 4, label: "Loading video data", detail: "Fetching stats for both videos..." });

      const [videos, statsA, statsB] = await Promise.all([
        client.listVideos(),
        client.getVideoStats(idA, dateFrom, dateTo),
        client.getVideoStats(idB, dateFrom, dateTo),
      ]);

      const videoA = videos.find((v) => v.id === idA);
      const videoB = videos.find((v) => v.id === idB);
      if (!videoA || !videoB) {
        sendEvent("error", { error: "One or both videos not found" });
        res.end();
        return;
      }

      const scoreA = (await import("./analyzer.js")).calculateScore(statsA);
      const scoreB = (await import("./analyzer.js")).calculateScore(statsB);

      const result = await claude.compareVideos(
        idA, idB,
        videoA.title, videoB.title,
        scoreA, scoreB,
        statsA, statsB,
        cachedA.data, cachedB.data,
        onProgress
      );

      sendEvent("complete", {
        comparison: result.comparison,
        cached: result.cached,
        cachedAt: result.cachedAt ?? null,
        statsA, statsB,
        scoreA, scoreB,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Comparison Error] ${msg}`);
      sendEvent("error", { error: msg });
    }
    res.end();
  } else {
    try {
      const [videos, statsA, statsB] = await Promise.all([
        client.listVideos(),
        client.getVideoStats(idA, dateFrom, dateTo),
        client.getVideoStats(idB, dateFrom, dateTo),
      ]);

      const videoA = videos.find((v) => v.id === idA);
      const videoB = videos.find((v) => v.id === idB);
      if (!videoA || !videoB) { res.status(404).json({ error: "One or both videos not found" }); return; }

      const scoreA = (await import("./analyzer.js")).calculateScore(statsA);
      const scoreB = (await import("./analyzer.js")).calculateScore(statsB);

      const result = await claude.compareVideos(
        idA, idB,
        videoA.title, videoB.title,
        scoreA, scoreB,
        statsA, statsB,
        cachedA.data, cachedB.data
      );

      res.json({
        comparison: result.comparison,
        cached: result.cached,
        cachedAt: result.cachedAt ?? null,
        statsA, statsB,
        scoreA, scoreB,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Comparison Error] ${msg}`);
      res.status(500).json({ error: msg });
    }
  }
});

// ── Start ──

app.listen(port, () => {
  console.log(`\nVidalytics Analytics Dashboard`);
  console.log(`http://localhost:${port}`);
  console.log(`API Token: ${apiToken.substring(0, 8)}...`);
  if (gemini) console.log(`Gemini AI: enabled`);
  if (claude) console.log(`Claude Script Rewriter: enabled`);
  console.log();
});

// ── Helpers ──

/** Run promises in sequential batches to avoid API rate limits */
async function fetchInBatches<T>(
  items: Array<() => Promise<T>>,
  batchSize: number = 5,
  delayMs: number = 500
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map((fn) => fn()));
    results.push(...batchResults);
    // Delay between batches (skip after the last batch)
    if (i + batchSize < items.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return results;
}

function defaultDateFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().split("T")[0];
}

function defaultDateTo(): string {
  return new Date().toISOString().split("T")[0];
}

/** Parse URL parameter filters from query string (e.g., ?urlParam[affId]=123) */
function parseUrlParamFilters(query: Record<string, unknown>): { urlParam?: Record<string, string> } | undefined {
  const urlParams: Record<string, string> = {};

  for (const [key, value] of Object.entries(query)) {
    // Match urlParam[paramName] pattern
    const match = key.match(/^urlParam\[(.+)\]$/);
    if (match && typeof value === "string" && value.trim()) {
      urlParams[match[1]] = value.trim();
    }
  }

  // Also support simple ?affiliate=xxx shorthand
  if (typeof query.affiliate === "string" && query.affiliate.trim()) {
    urlParams["affiliate"] = query.affiliate.trim();
  }
  // Support ?affId=xxx shorthand
  if (typeof query.affId === "string" && query.affId.trim()) {
    urlParams["affId"] = query.affId.trim();
  }

  return Object.keys(urlParams).length > 0 ? { urlParam: urlParams } : undefined;
}

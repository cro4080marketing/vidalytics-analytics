import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { VidalyticsClient } from "./vidalytics.js";
import { GeminiAnalyzer } from "./gemini.js";
import {
  analyzeVideo,
  analyzePortfolio,
  calculateScore,
  ratingFromScore,
  findSignificantDrops,
} from "./analyzer.js";
import type { VideoStats } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const apiToken = process.env.VIDALYTICS_API_TOKEN;
if (!apiToken) {
  console.error("Missing VIDALYTICS_API_TOKEN in .env");
  process.exit(1);
}

const geminiKey = process.env.GEMINI_API_KEY;
const port = parseInt(process.env.PORT || "3001", 10);
const client = new VidalyticsClient(apiToken);
const gemini = geminiKey ? new GeminiAnalyzer(geminiKey) : null;
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

    // Fetch stats for all videos (in batches to avoid hammering the API)
    const statsPromises = videos.map((v) =>
      client.getVideoStats(v.id, dateFrom, dateTo).catch(() => null)
    );
    const allStats = await Promise.all(statsPromises);

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

    const [videos, stats, dropOff] = await Promise.all([
      client.listVideos(),
      client.getVideoStats(videoId, dateFrom, dateTo),
      client.getDropOff(videoId, dateFrom, dateTo),
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

    const statsPromises = videos.map((v) =>
      client.getVideoStats(v.id, dateFrom, dateTo).catch(() => null)
    );
    const allStatsRaw = await Promise.all(statsPromises);
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

// Full AI content analysis for a video
app.get("/api/videos/:id/content-analysis", async (req, res) => {
  if (!gemini) {
    res.status(503).json({ error: "AI analysis not available. Add GEMINI_API_KEY to .env." });
    return;
  }

  try {
    const videoId = req.params.id;
    const dateFrom = (req.query.from as string) || defaultDateFrom();
    const dateTo = (req.query.to as string) || defaultDateTo();

    // Get video info, stats, and drop-off data
    const [videos, stats, dropOff] = await Promise.all([
      client.listVideos(),
      client.getVideoStats(videoId, dateFrom, dateTo),
      client.getDropOff(videoId, dateFrom, dateTo),
    ]);

    const video = videos.find((v) => v.id === videoId);
    if (!video) {
      res.status(404).json({ error: "Video not found" });
      return;
    }

    if (!video.videoUrl) {
      res.status(400).json({ error: "No video URL available for this video" });
      return;
    }

    // Find significant drops
    const significantDrops = findSignificantDrops(dropOff);

    // Run AI analysis
    const result = await gemini.analyze(
      videoId,
      video.videoUrl,
      video.title,
      stats,
      significantDrops
    );

    res.json({
      analysis: result.analysis,
      cached: result.cached,
      cachedAt: result.cachedAt ?? null,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[AI Analysis Error] ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// ── Start ──

app.listen(port, () => {
  console.log(`\nVidalytics Analytics Dashboard`);
  console.log(`http://localhost:${port}`);
  console.log(`API Token: ${apiToken.substring(0, 8)}...`);
  console.log();
});

// ── Helpers ──

function defaultDateFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().split("T")[0];
}

function defaultDateTo(): string {
  return new Date().toISOString().split("T")[0];
}

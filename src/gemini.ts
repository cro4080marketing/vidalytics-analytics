import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import type {
  VideoStats,
  SignificantDrop,
  ContentAnalysis,
} from "./types.js";
import {
  cacheKey,
  readCacheWithMeta,
  writeCache,
  AI_CACHE_TTL,
} from "./cache.js";

const GEMINI_MODEL = "gemini-2.5-flash";

export class GeminiAnalyzer {
  private ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async analyze(
    videoId: string,
    videoUrl: string,
    videoTitle: string,
    stats: VideoStats,
    drops: SignificantDrop[]
  ): Promise<{ analysis: ContentAnalysis; cached: boolean; cachedAt?: number }> {
    // Check cache first
    const key = cacheKey(`ai-analysis-${videoId}`, {});
    const cached = readCacheWithMeta<ContentAnalysis>(key);
    if (cached) {
      return { analysis: cached.data, cached: true, cachedAt: cached.timestamp };
    }

    console.log(`[Gemini] Starting AI analysis for "${videoTitle}" (${videoId})`);
    console.log(`[Gemini] Video URL: ${videoUrl}`);

    // Build the analysis prompt
    const prompt = buildPrompt(videoTitle, stats, drops);

    // Upload the video to Gemini and analyze
    const analysis = await this.analyzeWithVideo(videoId, videoUrl, prompt);

    // Cache for 7 days
    writeCache(key, analysis, AI_CACHE_TTL);
    console.log(`[Gemini] Analysis complete and cached for ${videoTitle}`);

    return { analysis, cached: false };
  }

  private async analyzeWithVideo(
    videoId: string,
    videoUrl: string,
    prompt: string
  ): Promise<ContentAnalysis> {
    console.log(`[Gemini] Downloading video from Vidalytics CDN...`);

    // Download video to temp file first
    // Vidalytics CDN requires a Referer header to allow downloads
    const tempFile = path.join(os.tmpdir(), `vidalytics-${videoId}.mp4`);
    try {
      const videoRes = await fetch(videoUrl, {
        headers: {
          "Referer": "https://app.vidalytics.com",
          "User-Agent": "Mozilla/5.0",
        },
      });
      if (!videoRes.ok) {
        throw new Error(`Failed to download video: ${videoRes.status} ${videoRes.statusText}`);
      }
      const buffer = Buffer.from(await videoRes.arrayBuffer());
      fs.writeFileSync(tempFile, buffer);
      console.log(`[Gemini] Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)}MB to temp file`);
    } catch (err) {
      throw new Error(`Video download failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    console.log(`[Gemini] Uploading video to Gemini File API...`);

    // Upload the temp file to Gemini
    const uploadResult = await this.ai.files.upload({
      file: tempFile,
      config: { mimeType: "video/mp4" },
    });

    // Clean up temp file
    try { fs.unlinkSync(tempFile); } catch { /* non-fatal */ }

    const fileName = uploadResult.name!;
    console.log(`[Gemini] Upload complete: ${fileName}`);

    // Wait for video processing
    let file = await this.ai.files.get({ name: fileName });
    let waitTime = 0;
    while (file.state === "PROCESSING") {
      console.log(`[Gemini] Video processing... (${waitTime}s elapsed)`);
      await new Promise((r) => setTimeout(r, 5000));
      waitTime += 5;
      file = await this.ai.files.get({ name: fileName });

      if (waitTime > 300) {
        throw new Error("Video processing timed out after 5 minutes");
      }
    }

    if (file.state === "FAILED") {
      throw new Error(`Video processing failed: ${file.state}`);
    }

    console.log(`[Gemini] Video ready. Sending analysis prompt...`);

    // Send to Gemini with the video
    const response = await this.ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            {
              fileData: {
                fileUri: file.uri!,
                mimeType: "video/mp4",
              },
            },
            { text: prompt },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        temperature: 0.7,
      },
    });

    const text = response.text ?? "";

    // Parse the JSON response
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Try to extract JSON from markdown code blocks
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[1].trim());
      } else {
        console.error(`[Gemini] Failed to parse response:\n${text.substring(0, 500)}`);
        throw new Error("Failed to parse Gemini response as JSON");
      }
    }

    // Clean up the uploaded file
    try {
      await this.ai.files.delete({ name: fileName });
      console.log(`[Gemini] Cleaned up uploaded file`);
    } catch {
      // Non-fatal
    }

    return {
      videoId,
      analyzedAt: new Date().toISOString(),
      expertFeedback: Array.isArray(parsed.expertFeedback) ? parsed.expertFeedback : [],
      croTests: Array.isArray(parsed.croTests) ? parsed.croTests : [],
      timestampAnalysis: Array.isArray(parsed.timestampAnalysis) ? parsed.timestampAnalysis : [],
      scriptStructure: (parsed.scriptStructure as ContentAnalysis["scriptStructure"]) ?? {
        hook: "",
        problem: "",
        solution: "",
        proof: "",
        cta: "",
        overallFlow: "",
      },
      overallVerdict: (parsed.overallVerdict as string) ?? "",
    } as ContentAnalysis;
  }
}

function buildPrompt(
  videoTitle: string,
  stats: VideoStats,
  drops: SignificantDrop[]
): string {
  const dropsList = drops
    .map(
      (d) =>
        `- At ${d.formattedTime}: ${d.dropPercentage}% of viewers left (${d.viewersBefore} -> ${d.viewersAfter} viewers, severity: ${d.severity})`
    )
    .join("\n");

  return `You are analyzing a video sales letter (VSL) / marketing video titled "${videoTitle}".

## VIDEO PERFORMANCE DATA

- Play Rate: ${(stats.playRate * 100).toFixed(1)}% of page visitors press play
- Engagement: ${(stats.engagement * 100).toFixed(1)}% average watch percentage
- Unmute Rate: ${(stats.unmuteRate * 100).toFixed(1)}% of viewers unmute
- Conversion Rate: ${(stats.conversionRate * 100).toFixed(2)}%
- Total Plays: ${stats.plays.toLocaleString()}
- Unique Plays: ${stats.playsUnique.toLocaleString()}
- Revenue: $${stats.revenue.toFixed(2)}
- Revenue Per Viewer: $${stats.revenuePerViewer.toFixed(2)}

## SIGNIFICANT DROP-OFF POINTS
${dropsList || "No significant drop-offs detected."}

## YOUR TASK

Watch this entire video carefully. Pay special attention to the timestamps where drop-offs occur. Analyze the video from the perspective of 5 expert direct response marketers:

### EXPERT 1: Alex Hormozi
Role: Offer Strategy & Scaling Expert
Focus: Is the offer irresistible? Is there enough value stacking? Is urgency/scarcity real and compelling? Would a "Grand Slam Offer" framework improve this? Is the price-to-value ratio clear?

### EXPERT 2: Stefan Georgi
Role: Direct Response Copywriter
Focus: Script flow and emotional triggers. Does the copy follow proven DR frameworks? Are transitions smooth? Is the language conversational or stilted? Are power words and sensory language used effectively? Does it maintain the "greased slide" effect?

### EXPERT 3: Russell Brunson
Role: Funnel Strategist & Story Seller
Focus: Does it use story-based selling effectively? Is there an "Epiphany Bridge"? Are the hook, story, and offer connected? Does it build a movement/identity? Is the funnel positioning clear?

### EXPERT 4: Dan Kennedy
Role: Direct Response Fundamentals
Focus: Does it follow classic DR principles? Is there a clear headline/hook? Does it address the right market? Is the sales psychology sound (fear, greed, guilt, exclusivity)? Is there a compelling reason to act NOW?

### EXPERT 5: Eugene Schwartz
Role: Market Awareness & Copy Sophistication
Focus: What awareness level is the audience at (unaware, problem-aware, solution-aware, product-aware, most-aware)? Is the copy sophistication level right for this market? Does it match where the prospect is in their buying journey?

## RESPONSE FORMAT

Respond with a JSON object containing these exact fields:

{
  "expertFeedback": [
    {
      "expertName": "Alex Hormozi",
      "expertRole": "Offer Strategy & Scaling",
      "overallAssessment": "2-3 sentence assessment of the video from this expert's perspective",
      "strengths": ["strength 1", "strength 2"],
      "weaknesses": ["weakness 1", "weakness 2"],
      "specificFixes": [
        {
          "timestamp": "1:23",
          "issue": "What's wrong at this moment",
          "fix": "Specific action to fix it"
        }
      ],
      "priorityAction": "The single most impactful change this expert recommends"
    }
  ],
  "croTests": [
    {
      "testName": "Name of the A/B test",
      "hypothesis": "If we change X, then Y will happen because Z",
      "control": "Current version description",
      "variant": "What to change",
      "expectedImpact": "Expected improvement in specific metric",
      "implementation": "Step-by-step how to implement this test"
    }
  ],
  "timestampAnalysis": [
    {
      "timestamp": "1:23",
      "formattedTime": "1:23",
      "contentDescription": "What is visually happening on screen",
      "audioDescription": "What is being said or heard",
      "issue": "Why viewers are likely dropping off here",
      "fix": "Specific improvement for this moment"
    }
  ],
  "scriptStructure": {
    "hook": "Analysis of the opening hook (first 15-30 seconds)",
    "problem": "How the problem/pain point is presented",
    "solution": "How the solution is introduced",
    "proof": "What proof elements are used (testimonials, data, demos)",
    "cta": "Analysis of the call-to-action",
    "overallFlow": "Overall script flow assessment and pacing notes"
  },
  "overallVerdict": "A 2-3 sentence overall verdict summarizing the video's biggest opportunities for improvement"
}

IMPORTANT:
- For each drop-off point listed above, include a timestampAnalysis entry explaining what content at that moment is causing viewers to leave
- Each expert should provide at least 2 specificFixes tied to actual timestamps in the video
- Suggest 3-5 CRO tests that are actionable and specific to this video
- Be direct and specific. No generic advice. Reference actual content, words, and visuals from the video.
- All timestamps should be in M:SS format`;
}

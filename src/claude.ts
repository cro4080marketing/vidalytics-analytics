import Anthropic from "@anthropic-ai/sdk";
import type {
  ExpertFeedback,
  ScriptStructure,
  RewrittenScript,
  RewrittenScriptSection,
  CROTest,
  GeneratedCROTests,
  ContentAnalysis,
  VideoStats,
  VideoComparison,
} from "./types.js";
import {
  cacheKey,
  readCacheWithMeta,
  writeCache,
  AI_CACHE_TTL,
} from "./cache.js";

const CLAUDE_MODEL = "claude-sonnet-4-20250514";

/** Progress callback for streaming updates to clients */
export type RewriteProgressCallback = (
  step: number,
  totalSteps: number,
  label: string,
  detail?: string
) => void;

export class ClaudeRewriter {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async rewrite(
    videoId: string,
    expertIndex: number,
    transcript: string,
    expert: ExpertFeedback,
    scriptStructure: ScriptStructure,
    onProgress?: RewriteProgressCallback,
    videoContext?: string
  ): Promise<{ rewrittenScript: RewrittenScript; cached: boolean; cachedAt?: number }> {
    const progress = onProgress ?? (() => {});

    // Check cache first
    const key = cacheKey(`script-rewrite-${videoId}-expert${expertIndex}`, {});
    const cached = readCacheWithMeta<RewrittenScript>(key);
    if (cached) {
      progress(4, 4, "Complete", "Loaded from cache");
      return { rewrittenScript: cached.data, cached: true, cachedAt: cached.timestamp };
    }

    console.log(`[Claude] Starting script rewrite for video ${videoId} as ${expert.expertName}`);

    progress(1, 4, "Preparing analysis", `Gathering ${expert.expertName}'s feedback...`);

    // Build the rewrite prompt
    const prompt = buildRewritePrompt(transcript, expert, scriptStructure, videoContext);

    progress(2, 4, "Rewriting script", `${expert.expertName} is rewriting your script...`);

    // Send to Claude
    const response = await this.client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 8192,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    progress(3, 4, "Formatting results", "Parsing rewritten script sections...");

    // Extract text response
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    // Parse JSON response
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Try to extract JSON from markdown code blocks
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[1].trim());
      } else {
        console.error(`[Claude] Failed to parse response:\n${text.substring(0, 500)}`);
        throw new Error("Failed to parse Claude response as JSON");
      }
    }

    // Build the result
    const sections: RewrittenScriptSection[] = Array.isArray(parsed.sections)
      ? (parsed.sections as Array<Record<string, unknown>>).map((s) => ({
          sectionName: (s.sectionName as string) ?? "",
          originalText: (s.originalText as string) ?? "",
          rewrittenText: (s.rewrittenText as string) ?? "",
          changesExplained: (s.changesExplained as string) ?? "",
          expertPrinciple: (s.expertPrinciple as string) ?? "",
        }))
      : [];

    const rewrittenScript: RewrittenScript = {
      videoId,
      expertIndex,
      expertName: expert.expertName,
      rewrittenAt: new Date().toISOString(),
      sections,
      fullRewrittenScript: (parsed.fullRewrittenScript as string) ?? "",
      changesSummary: (parsed.changesSummary as string) ?? "",
    };

    // Cache for 7 days
    writeCache(key, rewrittenScript, AI_CACHE_TTL);
    console.log(`[Claude] Script rewrite complete and cached for ${expert.expertName}`);

    progress(4, 4, "Complete", "Rewritten script ready");
    return { rewrittenScript, cached: false };
  }

  async generateCROTests(
    videoId: string,
    expertIndex: number,
    transcript: string,
    expert: ExpertFeedback,
    allPreviousTestNames: string[],
    batchNumber: number,
    onProgress?: RewriteProgressCallback,
    videoContext?: string
  ): Promise<{ generatedTests: GeneratedCROTests; cached: boolean; cachedAt?: number }> {
    const progress = onProgress ?? (() => {});

    // Check cache for this specific batch
    const key = cacheKey(`new-cro-tests-${videoId}-expert${expertIndex}-batch${batchNumber}`, {});
    const cached = readCacheWithMeta<GeneratedCROTests>(key);
    if (cached) {
      progress(3, 3, "Complete", "Loaded from cache");
      return { generatedTests: cached.data, cached: true, cachedAt: cached.timestamp };
    }

    console.log(`[Claude] Generating CRO tests batch ${batchNumber} for video ${videoId} as ${expert.expertName}`);

    progress(1, 3, "Preparing context", `Gathering ${expert.expertName}'s expertise and existing tests...`);

    const prompt = buildCROTestPrompt(transcript, expert, allPreviousTestNames, batchNumber, videoContext);

    progress(2, 3, "Generating new tests", `${expert.expertName} is creating fresh split test ideas...`);

    const response = await this.client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text);
    } catch {
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[1].trim());
      } else {
        console.error(`[Claude] Failed to parse CRO test response:\n${text.substring(0, 500)}`);
        throw new Error("Failed to parse Claude response as JSON");
      }
    }

    const tests: CROTest[] = Array.isArray(parsed.tests)
      ? (parsed.tests as Array<Record<string, unknown>>).map((t) => ({
          testName: (t.testName as string) ?? "",
          hypothesis: (t.hypothesis as string) ?? "",
          control: (t.control as string) ?? "",
          variant: (t.variant as string) ?? "",
          expectedImpact: (t.expectedImpact as string) ?? "",
          implementation: (t.implementation as string) ?? "",
        }))
      : [];

    const generatedTests: GeneratedCROTests = {
      videoId,
      expertIndex,
      expertName: expert.expertName,
      generatedAt: new Date().toISOString(),
      batchNumber,
      tests,
      previousTestNames: allPreviousTestNames,
    };

    writeCache(key, generatedTests, AI_CACHE_TTL);
    console.log(`[Claude] CRO tests batch ${batchNumber} complete and cached for ${expert.expertName}`);

    progress(3, 3, "Complete", `${tests.length} new split test ideas ready`);
    return { generatedTests, cached: false };
  }

  async compareVideos(
    videoAId: string,
    videoBId: string,
    videoAName: string,
    videoBName: string,
    videoAScore: number,
    videoBScore: number,
    videoAStats: VideoStats,
    videoBStats: VideoStats,
    videoAAnalysis: ContentAnalysis,
    videoBAnalysis: ContentAnalysis,
    onProgress?: RewriteProgressCallback
  ): Promise<{ comparison: VideoComparison; cached: boolean; cachedAt?: number }> {
    const progress = onProgress ?? (() => {});

    // Sort IDs so cache key is stable regardless of order
    const sortedIds = [videoAId, videoBId].sort();
    const key = cacheKey(`comparison-${sortedIds[0]}-${sortedIds[1]}`, {});
    const cached = readCacheWithMeta<VideoComparison>(key);
    if (cached) {
      progress(4, 4, "Complete", "Loaded from cache");
      return { comparison: cached.data, cached: true, cachedAt: cached.timestamp };
    }

    console.log(`[Claude] Starting video comparison: "${videoAName}" vs "${videoBName}"`);

    progress(1, 4, "Preparing data", "Gathering both videos\u2019 analyses...");

    const prompt = buildComparisonPrompt(
      videoAName, videoBName, videoAScore, videoBScore,
      videoAStats, videoBStats, videoAAnalysis, videoBAnalysis
    );

    progress(2, 4, "Analyzing differences", "5 experts are comparing both videos...");

    const response = await this.client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    });

    progress(3, 4, "Building report", "Formatting comparison results...");

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text);
    } catch {
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[1].trim());
      } else {
        console.error(`[Claude] Failed to parse comparison response:\n${text.substring(0, 500)}`);
        throw new Error("Failed to parse Claude comparison response as JSON");
      }
    }

    const comparison: VideoComparison = {
      videoAId,
      videoBId,
      videoAName,
      videoBName,
      videoAScore,
      videoBScore,
      comparedAt: new Date().toISOString(),
      summary: (parsed.summary as string) ?? "",
      winnerStrengths: Array.isArray(parsed.winnerStrengths) ? parsed.winnerStrengths as string[] : [],
      loserWeaknesses: Array.isArray(parsed.loserWeaknesses) ? parsed.loserWeaknesses as string[] : [],
      keyDifferences: Array.isArray(parsed.keyDifferences)
        ? (parsed.keyDifferences as Array<Record<string, string>>).map((d) => ({
            area: d.area ?? "",
            videoA: d.videoA ?? "",
            videoB: d.videoB ?? "",
            insight: d.insight ?? "",
          }))
        : [],
      specificRecommendations: Array.isArray(parsed.specificRecommendations)
        ? (parsed.specificRecommendations as Array<Record<string, string>>).map((r) => ({
            area: r.area ?? "",
            currentState: r.currentState ?? "",
            recommendation: r.recommendation ?? "",
            expectedImpact: r.expectedImpact ?? "",
          }))
        : [],
      prioritizedActionPlan: Array.isArray(parsed.prioritizedActionPlan)
        ? parsed.prioritizedActionPlan as string[]
        : [],
    };

    writeCache(key, comparison, AI_CACHE_TTL);
    console.log(`[Claude] Comparison complete and cached`);

    progress(4, 4, "Complete", "Comparison analysis ready");
    return { comparison, cached: false };
  }
}

function buildComparisonPrompt(
  videoAName: string,
  videoBName: string,
  videoAScore: number,
  videoBScore: number,
  videoAStats: VideoStats,
  videoBStats: VideoStats,
  videoAAnalysis: ContentAnalysis,
  videoBAnalysis: ContentAnalysis
): string {
  const winner = videoAScore >= videoBScore ? "A" : "B";
  const winnerName = winner === "A" ? videoAName : videoBName;
  const loserName = winner === "A" ? videoBName : videoAName;

  function statsBlock(name: string, stats: VideoStats, score: number): string {
    return `### "${name}" (Score: ${score}/100)
- Play Rate: ${(stats.playRate * 100).toFixed(1)}%
- Engagement: ${(stats.engagement * 100).toFixed(1)}%
- Unmute Rate: ${(stats.unmuteRate * 100).toFixed(1)}%
- Conversion Rate: ${(stats.conversionRate * 100).toFixed(2)}%
- Total Plays: ${stats.plays.toLocaleString()}
- Revenue: $${stats.revenue.toFixed(2)}
- Revenue Per Viewer: $${stats.revenuePerViewer.toFixed(2)}`;
  }

  function expertSummary(analysis: ContentAnalysis): string {
    return analysis.expertFeedback
      .map((e) =>
        `**${e.expertName}** (${e.expertRole}): ${e.overallAssessment}\n  Priority: ${e.priorityAction}\n  Strengths: ${e.strengths.join("; ")}\n  Weaknesses: ${e.weaknesses.join("; ")}`
      )
      .join("\n\n");
  }

  function scriptSummary(analysis: ContentAnalysis): string {
    const ss = analysis.scriptStructure;
    if (!ss) return "No script structure available.";
    return `- Hook: ${ss.hook}\n- Problem: ${ss.problem}\n- Solution: ${ss.solution}\n- Proof: ${ss.proof}\n- CTA: ${ss.cta}\n- Overall Flow: ${ss.overallFlow}`;
  }

  return `You are a panel of 5 world-class direct response marketing experts (Hormozi, Georgi, Brunson, Kennedy, Schwartz). You have already individually analyzed two marketing videos. Now compare them to explain WHY one outperforms the other and give the underperformer a specific action plan.

## VIDEO A: "${videoAName}"
${statsBlock(videoAName, videoAStats, videoAScore)}

#### Expert Analysis Summary for Video A:
${expertSummary(videoAAnalysis)}

#### Script Structure for Video A:
${scriptSummary(videoAAnalysis)}

#### Overall Verdict for Video A:
${videoAAnalysis.overallVerdict}

---

## VIDEO B: "${videoBName}"
${statsBlock(videoBName, videoBStats, videoBScore)}

#### Expert Analysis Summary for Video B:
${expertSummary(videoBAnalysis)}

#### Script Structure for Video B:
${scriptSummary(videoBAnalysis)}

#### Overall Verdict for Video B:
${videoBAnalysis.overallVerdict}

---

## YOUR TASK

The WINNER is Video ${winner} ("${winnerName}"). The UNDERPERFORMER is "${loserName}".

Analyze the key differences between these two videos and provide actionable recommendations for the underperformer. Be specific — reference actual content, structures, and approaches from both videos.

## RESPONSE FORMAT

Respond with a JSON object:

{
  "summary": "3-4 sentence executive summary of why the winner outperforms and the single biggest gap in the underperformer",
  "winnerStrengths": [
    "Specific strength 1 that the winner does well (reference actual content)",
    "Specific strength 2",
    "Specific strength 3"
  ],
  "loserWeaknesses": [
    "Specific weakness 1 in the underperformer (reference actual content)",
    "Specific weakness 2",
    "Specific weakness 3"
  ],
  "keyDifferences": [
    {
      "area": "Hook / Opening",
      "videoA": "What Video A does in this area",
      "videoB": "What Video B does in this area",
      "insight": "Why this difference matters for performance"
    },
    {
      "area": "Offer / CTA",
      "videoA": "...",
      "videoB": "...",
      "insight": "..."
    }
  ],
  "specificRecommendations": [
    {
      "area": "Hook",
      "currentState": "What the underperformer currently does",
      "recommendation": "Specific change to make, inspired by the winner",
      "expectedImpact": "Expected improvement in specific metric"
    }
  ],
  "prioritizedActionPlan": [
    "Step 1: The highest-impact change to make first (be very specific)",
    "Step 2: Second most impactful change",
    "Step 3: Third change",
    "Step 4: Fourth change",
    "Step 5: Fifth change"
  ]
}

IMPORTANT:
- Provide at least 4 keyDifferences covering different areas (hook, story, proof, offer, CTA, pacing, etc.)
- Provide at least 4 specificRecommendations for the underperformer
- The prioritizedActionPlan should have exactly 5 steps, ordered by impact
- Be direct and specific. Reference actual content from both videos.
- The recommendations should be implementable — not vague advice like "improve the hook" but specific like "replace the opening question with a bold claim like Video A does"`;
}

function buildRewritePrompt(
  transcript: string,
  expert: ExpertFeedback,
  scriptStructure: ScriptStructure,
  videoContext?: string
): string {
  const fixes = expert.specificFixes
    .map((f) => `- At ${f.timestamp}: Issue: ${f.issue} → Fix: ${f.fix}`)
    .join("\n");

  const strengths = expert.strengths.map((s) => `- ${s}`).join("\n");
  const weaknesses = expert.weaknesses.map((w) => `- ${w}`).join("\n");

  const croTests = expert.croTests
    .map(
      (t) =>
        `- ${t.testName}: ${t.hypothesis}\n  Variant: ${t.variant}\n  Expected impact: ${t.expectedImpact}`
    )
    .join("\n");

  const contextBlock = videoContext
    ? `\n## VIDEO CONTEXT (provided by the user)\n${videoContext}\n\nUse this context when rewriting. Tailor the script to the specific audience, funnel placement, and product described above.\n`
    : "";

  return `You are ${expert.expertName}, ${expert.expertRole}. You have just reviewed a video sales letter (VSL) and provided feedback. Now you need to REWRITE the entire script implementing your recommendations.
${contextBlock}
## YOUR EXPERT ASSESSMENT

Overall: ${expert.overallAssessment}

Priority Action: ${expert.priorityAction}

### Strengths (KEEP these):
${strengths}

### Weaknesses (FIX these):
${weaknesses}

### Specific Fixes:
${fixes}

### CRO Tests to Implement:
${croTests}

## CURRENT SCRIPT STRUCTURE ANALYSIS

- Hook: ${scriptStructure.hook}
- Problem: ${scriptStructure.problem}
- Solution: ${scriptStructure.solution}
- Proof: ${scriptStructure.proof}
- CTA: ${scriptStructure.cta}
- Overall Flow: ${scriptStructure.overallFlow}

## ORIGINAL TRANSCRIPT

${transcript}

## YOUR TASK

Rewrite the ENTIRE script as ${expert.expertName} would write it. Apply all your feedback, fixes, and principles while:

1. **Maintaining the core message and product/service being sold**
2. **Keeping the same general voice/tone** (but improving it where needed)
3. **Implementing ALL your specific fixes** from the feedback
4. **Restructuring sections** if your feedback calls for it (e.g., moving the offer earlier, strengthening the hook)
5. **Preserving what works** — keep the strengths you identified

Break the rewritten script into 5 sections following the VSL framework:
- **Hook** (Opening 15-30 seconds — grab attention)
- **Problem** (Agitate the pain point)
- **Solution** (Introduce the solution)
- **Proof** (Social proof, testimonials, data, demos)
- **CTA** (Call-to-action with urgency/scarcity)

## RESPONSE FORMAT

Respond with a JSON object:

{
  "changesSummary": "2-3 sentence overview of the key changes made and why, written in first person as ${expert.expertName}",
  "sections": [
    {
      "sectionName": "Hook",
      "originalText": "The original transcript text that corresponds to this section",
      "rewrittenText": "Your rewritten version of this section",
      "changesExplained": "What you changed and why (2-3 sentences)",
      "expertPrinciple": "The specific ${expert.expertName} principle or framework applied here"
    },
    {
      "sectionName": "Problem",
      "originalText": "...",
      "rewrittenText": "...",
      "changesExplained": "...",
      "expertPrinciple": "..."
    },
    {
      "sectionName": "Solution",
      "originalText": "...",
      "rewrittenText": "...",
      "changesExplained": "...",
      "expertPrinciple": "..."
    },
    {
      "sectionName": "Proof",
      "originalText": "...",
      "rewrittenText": "...",
      "changesExplained": "...",
      "expertPrinciple": "..."
    },
    {
      "sectionName": "CTA",
      "originalText": "...",
      "rewrittenText": "...",
      "changesExplained": "...",
      "expertPrinciple": "..."
    }
  ],
  "fullRewrittenScript": "The complete rewritten script as one continuous block of text, ready to be read as a new VSL script. Include natural paragraph breaks and stage directions in [brackets] where relevant."
}

IMPORTANT:
- The "originalText" for each section should map the transcript to the appropriate VSL section. Do your best to divide the original transcript into these 5 sections.
- The "rewrittenText" should be a COMPLETE rewrite — not just notes or suggestions. Write the actual script words that should be spoken.
- The "fullRewrittenScript" must be the complete script concatenated, ready to record as a new video.
- Write in a natural, conversational tone appropriate for video delivery.
- Be specific and direct. Every change should tie back to your expert feedback.`;
}

function buildCROTestPrompt(
  transcript: string,
  expert: ExpertFeedback,
  allPreviousTestNames: string[],
  batchNumber: number,
  videoContext?: string
): string {
  const existingTests = expert.croTests
    .map((t) => `- ${t.testName}: ${t.hypothesis}`)
    .join("\n");

  const previouslyGenerated =
    allPreviousTestNames.length > 0
      ? allPreviousTestNames.map((n) => `- ${n}`).join("\n")
      : "None yet.";

  const creativityInstruction =
    batchNumber <= 2
      ? "Focus on high-impact, practical tests that could be implemented quickly."
      : batchNumber <= 4
        ? "Think more creatively. Consider unconventional approaches and cross-domain inspiration."
        : "Go bold. Push the boundaries of what's been tested before. Consider radical departures, contrarian approaches, and breakthrough experiments.";

  const contextBlock = videoContext
    ? `\n## VIDEO CONTEXT (provided by the user)\n${videoContext}\n\nUse this context when generating tests. Tailor tests to the specific audience, funnel placement, and product described above.\n`
    : "";

  return `You are ${expert.expertName}, ${expert.expertRole}. You have already analyzed a video sales letter and provided feedback and CRO tests. Now you need to generate 3 COMPLETELY NEW and UNIQUE split test ideas.
${contextBlock}
## YOUR ORIGINAL ASSESSMENT

${expert.overallAssessment}

### Your Strengths Identified:
${expert.strengths.map((s) => `- ${s}`).join("\n")}

### Your Weaknesses Identified:
${expert.weaknesses.map((w) => `- ${w}`).join("\n")}

### Your Priority Action:
${expert.priorityAction}

## YOUR ORIGINAL CRO TESTS (DO NOT REPEAT THESE)
${existingTests}

## ALL PREVIOUSLY GENERATED TEST NAMES (DO NOT REPEAT ANY)
${previouslyGenerated}

## VIDEO TRANSCRIPT
${transcript}

## YOUR TASK — BATCH #${batchNumber}

Generate exactly 3 NEW split test ideas that are:
1. **Completely different** from ALL tests listed above (original + previously generated)
2. **Specific to your domain** as ${expert.expertName} (${expert.expertRole})
3. **Grounded in the actual video content** — reference specific parts of the transcript
4. **Actionable and implementable** — not vague suggestions

${creativityInstruction}

## RESPONSE FORMAT

Respond with a JSON object:

{
  "tests": [
    {
      "testName": "Unique descriptive name for this A/B test",
      "hypothesis": "If we change X, then Y will happen because Z",
      "control": "Current version description",
      "variant": "What to change (be specific)",
      "expectedImpact": "Expected improvement in specific metric (e.g., +15% conversion rate)",
      "implementation": "Step-by-step how to implement this test"
    }
  ]
}

IMPORTANT:
- Return EXACTLY 3 tests.
- Every test name MUST be different from the ones listed in "DO NOT REPEAT" sections.
- Be specific. Reference actual content from the video transcript.
- Write as ${expert.expertName} — use your unique expertise and frameworks.
- Each test must have a clear, measurable expected impact.`;
}

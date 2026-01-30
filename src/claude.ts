import Anthropic from "@anthropic-ai/sdk";
import type {
  ExpertFeedback,
  ScriptStructure,
  RewrittenScript,
  RewrittenScriptSection,
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
    onProgress?: RewriteProgressCallback
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
    const prompt = buildRewritePrompt(transcript, expert, scriptStructure);

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
}

function buildRewritePrompt(
  transcript: string,
  expert: ExpertFeedback,
  scriptStructure: ScriptStructure
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

  return `You are ${expert.expertName}, ${expert.expertRole}. You have just reviewed a video sales letter (VSL) and provided feedback. Now you need to REWRITE the entire script implementing your recommendations.

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

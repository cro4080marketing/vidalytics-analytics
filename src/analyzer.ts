import type {
  Video,
  VideoStats,
  DropOffData,
  PerformanceRating,
  MetricRating,
  SignificantDrop,
  VideoAnalysis,
  Recommendation,
  PortfolioSummary,
} from "./types.js";

// ── Thresholds (0-1 scale for rates, 0-100 for percentages) ──

const THRESHOLDS: Record<
  string,
  { excellent: number; good: number; average: number; poor: number }
> = {
  // playRate is a 0-1 ratio (e.g., 0.99 = 99%)
  playRate: { excellent: 0.7, good: 0.5, average: 0.3, poor: 0.15 },
  // engagement is a 0-1 ratio
  engagement: { excellent: 0.6, good: 0.4, average: 0.25, poor: 0.15 },
  // conversionRate is 0-1 ratio
  conversionRate: { excellent: 0.05, good: 0.03, average: 0.015, poor: 0.005 },
  // unmuteRate is 0-1 ratio
  unmuteRate: { excellent: 0.6, good: 0.4, average: 0.25, poor: 0.1 },
};

// Weights for composite score
const WEIGHTS = {
  engagement: 0.35,
  conversionRate: 0.25,
  playRate: 0.2,
  unmuteRate: 0.2,
};

function rateMetric(metric: string, value: number): PerformanceRating {
  const t = THRESHOLDS[metric];
  if (!t) return "average";
  if (value >= t.excellent) return "excellent";
  if (value >= t.good) return "good";
  if (value >= t.average) return "average";
  if (value >= t.poor) return "poor";
  return "critical";
}

function metricRating(metric: string, value: number): MetricRating {
  return { value, rating: rateMetric(metric, value) };
}

function normalizeToScore(metric: string, value: number): number {
  const t = THRESHOLDS[metric];
  if (!t) return 50;
  // Map value to 0-100 scale based on thresholds
  if (value >= t.excellent) return Math.min(100, 80 + ((value - t.excellent) / t.excellent) * 20);
  if (value >= t.good) return 60 + ((value - t.good) / (t.excellent - t.good)) * 20;
  if (value >= t.average) return 40 + ((value - t.average) / (t.good - t.average)) * 20;
  if (value >= t.poor) return 20 + ((value - t.poor) / (t.average - t.poor)) * 20;
  return Math.max(0, (value / t.poor) * 20);
}

export function calculateScore(stats: VideoStats): number {
  const scores = {
    engagement: normalizeToScore("engagement", stats.engagement),
    conversionRate: normalizeToScore("conversionRate", stats.conversionRate),
    playRate: normalizeToScore("playRate", stats.playRate),
    unmuteRate: normalizeToScore("unmuteRate", stats.unmuteRate),
  };

  return Math.round(
    scores.engagement * WEIGHTS.engagement +
      scores.conversionRate * WEIGHTS.conversionRate +
      scores.playRate * WEIGHTS.playRate +
      scores.unmuteRate * WEIGHTS.unmuteRate
  );
}

export function ratingFromScore(score: number): PerformanceRating {
  if (score >= 80) return "excellent";
  if (score >= 60) return "good";
  if (score >= 40) return "average";
  if (score >= 20) return "poor";
  return "critical";
}

export function findSignificantDrops(dropOff: DropOffData): SignificantDrop[] {
  const { points, totalViewers } = dropOff;
  if (points.length < 3) return [];

  // Calculate the average drop per interval
  const drops: Array<{ idx: number; drop: number }> = [];
  for (let i = 1; i < points.length; i++) {
    const drop = points[i - 1].viewers - points[i].viewers;
    drops.push({ idx: i, drop });
  }

  const avgDrop = drops.reduce((sum, d) => sum + d.drop, 0) / drops.length;

  // Flag drops that are > 2x the average
  const significant: SignificantDrop[] = [];
  for (const { idx, drop } of drops) {
    if (drop > avgDrop * 2 && drop > 0) {
      const before = points[idx - 1];
      const after = points[idx];
      const dropPct = totalViewers > 0 ? (drop / totalViewers) * 100 : 0;

      let severity: PerformanceRating;
      if (dropPct >= 10) severity = "critical";
      else if (dropPct >= 5) severity = "poor";
      else if (dropPct >= 3) severity = "average";
      else severity = "good";

      significant.push({
        second: after.second,
        formattedTime: after.formattedTime,
        dropPercentage: Math.round(dropPct * 10) / 10,
        viewersBefore: before.viewers,
        viewersAfter: after.viewers,
        severity,
      });
    }
  }

  // Sort by drop percentage descending, return top 5
  return significant
    .sort((a, b) => b.dropPercentage - a.dropPercentage)
    .slice(0, 5);
}

function generateRecommendations(
  stats: VideoStats,
  drops: SignificantDrop[]
): Recommendation[] {
  const recs: Recommendation[] = [];

  // ── Play Rate Analysis ──
  const playRating = rateMetric("playRate", stats.playRate);
  if (playRating === "critical" || playRating === "poor") {
    recs.push({
      type: playRating === "critical" ? "critical" : "warning",
      metric: "playRate",
      title: "Low Play Rate",
      detail: `Only ${(stats.playRate * 100).toFixed(1)}% of visitors who see this video press play. Most visitors are leaving before the video even starts.`,
      actionableStep:
        "Improve the thumbnail image, add a compelling headline above the player, or use an autoplay strategy with a strong visual hook in the first frame.",
    });
  } else if (playRating === "excellent") {
    recs.push({
      type: "positive",
      metric: "playRate",
      title: "Strong Play Rate",
      detail: `${(stats.playRate * 100).toFixed(1)}% play rate is excellent. Your thumbnail/page design is compelling visitors to watch.`,
      actionableStep:
        "Document what makes this video's presentation effective and replicate the pattern on other videos.",
    });
  }

  // ── Engagement Analysis ──
  const engRating = rateMetric("engagement", stats.engagement);
  if (engRating === "critical" || engRating === "poor") {
    recs.push({
      type: engRating === "critical" ? "critical" : "warning",
      metric: "engagement",
      title: "Low Viewer Engagement",
      detail: `Viewers watch only ${(stats.engagement * 100).toFixed(1)}% of the video on average. Most people are dropping off well before your core message or CTA.`,
      actionableStep:
        "Front-load your key message. Move your strongest proof, hook, or promise to the first 15-30 seconds. Cut filler and tighten pacing.",
    });
  }

  // ── High play rate + low engagement ──
  if (playRating === "good" || playRating === "excellent") {
    if (engRating === "poor" || engRating === "critical") {
      recs.push({
        type: "warning",
        metric: "engagement",
        title: "Viewers Start But Don't Stay",
        detail:
          "People are clicking play but leaving early. The opening isn't delivering on what the thumbnail/headline promised.",
        actionableStep:
          "Review the first 15-30 seconds. Does the video immediately address what visitors expect? Consider re-scripting the intro to match the page promise.",
      });
    }
  }

  // ── Unmute Rate Analysis ──
  const unmuteRating = rateMetric("unmuteRate", stats.unmuteRate);
  if (unmuteRating === "critical" || unmuteRating === "poor") {
    recs.push({
      type: "warning",
      metric: "unmuteRate",
      title: "Low Unmute Rate",
      detail: `Only ${(stats.unmuteRate * 100).toFixed(1)}% of viewers unmute. Many may be watching silently or not engaging with audio content.`,
      actionableStep:
        "Add bold text overlays, captions, or animated elements in the first 5 seconds that encourage unmuting. Consider adding a visual 'unmute' prompt.",
    });
  }

  // ── Conversion Rate Analysis ──
  const convRating = rateMetric("conversionRate", stats.conversionRate);
  if (stats.conversionCount > 0 || stats.conversionRate > 0) {
    if (convRating === "critical" || convRating === "poor") {
      recs.push({
        type: "warning",
        metric: "conversionRate",
        title: "Low Conversion Rate",
        detail: `${(stats.conversionRate * 100).toFixed(2)}% conversion rate. Viewers are watching but not taking action.`,
        actionableStep:
          "Check CTA placement — is it only at the end? Move it to the point of highest engagement. Strengthen the offer and urgency. Verify the CTA link works correctly.",
      });
    }

    // High engagement + low conversion
    if (engRating === "good" || engRating === "excellent") {
      if (convRating === "poor" || convRating === "critical") {
        recs.push({
          type: "warning",
          metric: "conversionRate",
          title: "Engaged Viewers Aren't Converting",
          detail:
            "People are watching a good portion of your video but not converting. The issue is likely your CTA or offer, not the content.",
          actionableStep:
            "Test moving the CTA earlier. Add urgency or scarcity elements. Make the next step crystal clear. Verify the CTA button/link is prominent and functional.",
        });
      }
    }

    if (convRating === "excellent") {
      recs.push({
        type: "positive",
        metric: "conversionRate",
        title: "Excellent Conversion Rate",
        detail: `${(stats.conversionRate * 100).toFixed(2)}% conversion rate is outstanding. This video is highly effective at driving action.`,
        actionableStep:
          "Study this video's script structure and CTA placement. Use it as a template for future videos.",
      });
    }
  }

  // ── Revenue Analysis ──
  if (stats.revenue > 0) {
    recs.push({
      type: "positive",
      metric: "revenue",
      title: "Revenue Generating",
      detail: `This video has generated $${stats.revenue.toFixed(2)} in revenue ($${stats.revenuePerViewer.toFixed(2)} per viewer, $${stats.revenueAverage.toFixed(2)} AOV).`,
      actionableStep:
        "Drive more traffic to this video. Consider A/B testing small improvements to increase revenue per viewer.",
    });
  }

  // ── Drop-off Analysis ──
  for (const drop of drops.slice(0, 3)) {
    recs.push({
      type: drop.severity === "critical" ? "critical" : "warning",
      metric: "dropOff",
      title: `Major Drop-off at ${drop.formattedTime}`,
      detail: `${drop.dropPercentage}% of total viewers left at the ${drop.formattedTime} mark (${drop.viewersBefore} → ${drop.viewersAfter} viewers).`,
      actionableStep:
        "Review what happens at this timestamp. Common causes: topic change, energy drop, long-winded explanation, asking for commitment too early, or audio/video quality issues.",
    });
  }

  // ── If no issues found ──
  if (recs.length === 0) {
    recs.push({
      type: "positive",
      metric: "overall",
      title: "Solid Performance",
      detail: "This video is performing within acceptable ranges across all tracked metrics.",
      actionableStep:
        "Monitor for changes over time. Consider testing small improvements to push metrics higher.",
    });
  }

  return recs;
}

export function analyzeVideo(
  video: Video,
  stats: VideoStats,
  dropOff: DropOffData
): VideoAnalysis {
  const score = calculateScore(stats);
  const drops = findSignificantDrops(dropOff);
  const recs = generateRecommendations(stats, drops);

  return {
    videoId: video.id,
    videoName: video.title,
    overallScore: score,
    overallRating: ratingFromScore(score),
    metrics: {
      playRate: metricRating("playRate", stats.playRate),
      engagement: metricRating("engagement", stats.engagement),
      conversionRate: metricRating("conversionRate", stats.conversionRate),
      unmuteRate: metricRating("unmuteRate", stats.unmuteRate),
    },
    significantDrops: drops,
    recommendations: recs,
  };
}

export function analyzePortfolio(
  videos: Video[],
  allStats: VideoStats[]
): PortfolioSummary {
  const n = allStats.length;
  if (n === 0) {
    return {
      totalVideos: 0,
      totalPlays: 0,
      totalConversions: 0,
      totalRevenue: 0,
      avgEngagement: 0,
      avgConversionRate: 0,
      avgPlayRate: 0,
      avgUnmuteRate: 0,
      topPerformers: [],
      worstPerformers: [],
      portfolioRecommendations: [],
    };
  }

  const totalPlays = allStats.reduce((s, v) => s + v.plays, 0);
  const totalConversions = allStats.reduce((s, v) => s + v.conversionCount, 0);
  const totalRevenue = allStats.reduce((s, v) => s + v.revenue, 0);
  const avgEngagement = allStats.reduce((s, v) => s + v.engagement, 0) / n;
  const avgConversionRate = allStats.reduce((s, v) => s + v.conversionRate, 0) / n;
  const avgPlayRate = allStats.reduce((s, v) => s + v.playRate, 0) / n;
  const avgUnmuteRate = allStats.reduce((s, v) => s + v.unmuteRate, 0) / n;

  // Score all videos and rank
  const scored = allStats.map((stats) => {
    const video = videos.find((v) => v.id === stats.videoId);
    return {
      videoId: stats.videoId,
      videoName: video?.title ?? stats.videoId,
      score: calculateScore(stats),
    };
  });
  scored.sort((a, b) => b.score - a.score);

  const topPerformers = scored.slice(0, 5);
  const worstPerformers = scored.slice(-5).reverse();

  // Portfolio-level recommendations
  const portfolioRecs: Recommendation[] = [];

  if (avgEngagement < 0.25) {
    portfolioRecs.push({
      type: "critical",
      metric: "engagement",
      title: "Portfolio-Wide Low Engagement",
      detail: `Average engagement across all videos is ${(avgEngagement * 100).toFixed(1)}%. Most viewers leave before the midpoint.`,
      actionableStep:
        "Review your script structure across all videos. Consider shorter formats, faster pacing, and stronger opening hooks.",
    });
  }

  if (avgPlayRate < 0.3) {
    portfolioRecs.push({
      type: "warning",
      metric: "playRate",
      title: "Low Average Play Rate",
      detail: `Average play rate is ${(avgPlayRate * 100).toFixed(1)}%. Page visitors aren't starting your videos.`,
      actionableStep:
        "Test different thumbnails and page layouts. Ensure the video player is prominent and above the fold. Consider autoplay where appropriate.",
    });
  }

  if (totalRevenue > 0 && topPerformers.length > 0) {
    portfolioRecs.push({
      type: "positive",
      metric: "revenue",
      title: "Revenue Summary",
      detail: `Total revenue: $${totalRevenue.toFixed(2)} from ${totalConversions} conversions across ${n} videos.`,
      actionableStep:
        `Focus on driving more traffic to your top performer "${topPerformers[0].videoName}" (score: ${topPerformers[0].score}/100).`,
    });
  }

  if (worstPerformers.length > 0 && worstPerformers[0].score < 30) {
    portfolioRecs.push({
      type: "warning",
      metric: "overall",
      title: "Underperforming Videos Need Attention",
      detail: `Your lowest scoring video "${worstPerformers[0].videoName}" scores ${worstPerformers[0].score}/100.`,
      actionableStep:
        "Click into the worst performers below to see specific issues and recommended fixes.",
    });
  }

  return {
    totalVideos: n,
    totalPlays,
    totalConversions,
    totalRevenue,
    avgEngagement,
    avgConversionRate,
    avgPlayRate,
    avgUnmuteRate,
    topPerformers,
    worstPerformers,
    portfolioRecommendations: portfolioRecs,
  };
}

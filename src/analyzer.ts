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

  const lastSecond = points[points.length - 1].second;
  if (lastSecond <= 0) return [];

  // Segment boundaries: 4 quartiles of the video timeline
  const segmentBounds: Array<{
    name: "early" | "mid-early" | "mid-late" | "late";
    start: number;
    end: number;
  }> = [
    { name: "early", start: 0, end: lastSecond * 0.25 },
    { name: "mid-early", start: lastSecond * 0.25, end: lastSecond * 0.5 },
    { name: "mid-late", start: lastSecond * 0.5, end: lastSecond * 0.75 },
    { name: "late", start: lastSecond * 0.75, end: lastSecond + 1 },
  ];

  function getSegment(second: number): "early" | "mid-early" | "mid-late" | "late" {
    for (const seg of segmentBounds) {
      if (second >= seg.start && second < seg.end) return seg.name;
    }
    return "late";
  }

  // Calculate all drops with RELATIVE severity (drop / viewers at that point)
  const allDrops: Array<{
    idx: number;
    drop: number;
    relativeDrop: number;
    dropPct: number;
    segment: "early" | "mid-early" | "mid-late" | "late";
  }> = [];

  for (let i = 1; i < points.length; i++) {
    const drop = points[i - 1].viewers - points[i].viewers;
    if (drop <= 0) continue;
    const before = points[i - 1];
    const after = points[i];
    // Relative drop: percentage of current viewers lost (not total)
    const relativeDrop = before.viewers > 0 ? (drop / before.viewers) * 100 : 0;
    // Absolute drop: percentage of total viewers
    const dropPct = totalViewers > 0 ? (drop / totalViewers) * 100 : 0;

    allDrops.push({
      idx: i,
      drop,
      relativeDrop,
      dropPct,
      segment: getSegment(after.second),
    });
  }

  // Calculate average relative drop for threshold
  const avgRelDrop = allDrops.length > 0
    ? allDrops.reduce((sum, d) => sum + d.relativeDrop, 0) / allDrops.length
    : 0;

  // Filter to significant drops (> 1.5x average relative drop)
  const significant = allDrops.filter(d => d.relativeDrop > avgRelDrop * 1.5);

  // Group by segment and pick top drops from each
  const bySegment: Record<string, typeof significant> = {
    early: [], "mid-early": [], "mid-late": [], late: [],
  };
  for (const d of significant) {
    bySegment[d.segment].push(d);
  }

  // Sort each segment by relative drop and pick top entries
  // Early: max 3 (always the noisiest), others: max 3 each
  const maxPerSegment: Record<string, number> = {
    early: 3, "mid-early": 3, "mid-late": 3, late: 3,
  };

  const selected: SignificantDrop[] = [];

  for (const [segName, segDrops] of Object.entries(bySegment)) {
    segDrops.sort((a, b) => b.relativeDrop - a.relativeDrop);
    const limit = maxPerSegment[segName] || 3;
    for (const d of segDrops.slice(0, limit)) {
      const before = points[d.idx - 1];
      const after = points[d.idx];

      // Severity based on relative drop (how significant relative to current viewers)
      let severity: PerformanceRating;
      if (d.relativeDrop >= 20) severity = "critical";
      else if (d.relativeDrop >= 12) severity = "poor";
      else if (d.relativeDrop >= 7) severity = "average";
      else severity = "good";

      selected.push({
        second: after.second,
        formattedTime: after.formattedTime,
        dropPercentage: Math.round(d.dropPct * 10) / 10,
        relativeDrop: Math.round(d.relativeDrop * 10) / 10,
        viewersBefore: before.viewers,
        viewersAfter: after.viewers,
        severity,
        segment: d.segment as "early" | "mid-early" | "mid-late" | "late",
      });
    }
  }

  // Sort chronologically so the report reads in timeline order
  return selected.sort((a, b) => a.second - b.second);
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

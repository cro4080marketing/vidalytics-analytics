// ── Raw API Response Shapes ──

export interface ApiResponse<T> {
  status: boolean;
  content: T;
}

// GET /video → content.data[]
export interface RawVideo {
  id: string;
  title: string;
  date_created: string;
  last_published: string;
  status: string;
  views: number;
  folder_id: string;
  thumbnail: { desktop: string; mobile: string };
  url: string;
}

// GET /stats/video/:id?dateFrom=&dateTo= → content
export interface RawVideoStats {
  plays: number;
  playsUnique: number;
  playRate: number;
  unmuteRate: number;
  impressions: number;
  revenue: number;
  engagement: number;
  conversionRate: number;
  unmuteCount: number;
  pgOptInRate: number;
  pgEventsCount: number;
  revenueAverage: number;
  revenuePerViewer: number;
  uniquePlayRate: number;
  conversionCount: number;
}

// GET /stats/video/:id/drop-off?dateFrom=&dateTo= → content.all.watches
export interface RawDropOff {
  all: {
    watches: Record<string, number>;
  };
}

// GET /stats/usage → content
export interface RawUsage {
  monthly_limit: number | null;
  current_usage: number;
  remaining: number | null;
}

// GET /stats/videos/timeline → content.data[]
export interface RawTimelineSegment {
  segment: string;
  data: Array<{
    date: string;
    data: Array<{
      videoGuid: string;
      metrics: Record<string, number>;
    }>;
  }>;
}

// ── Normalized Types (used throughout the app) ──

export interface Video {
  id: string;
  title: string;
  dateCreated: string;
  lastPublished: string;
  status: string;
  views: number;
  folderId: string;
  thumbnailUrl: string;
  videoUrl: string;
}

export interface VideoStats {
  videoId: string;
  plays: number;
  playsUnique: number;
  playRate: number;
  uniquePlayRate: number;
  engagement: number;
  impressions: number;
  conversionCount: number;
  conversionRate: number;
  revenue: number;
  revenueAverage: number;
  revenuePerViewer: number;
  unmuteRate: number;
  unmuteCount: number;
  pgOptInRate: number;
  pgEventsCount: number;
}

export interface DropOffData {
  videoId: string;
  totalViewers: number;
  points: DropOffPoint[];
}

export interface DropOffPoint {
  second: number;
  formattedTime: string;
  viewers: number;
  percentRemaining: number;
  dropFromPrevious: number;
}

// ── Analysis Results ──

export type PerformanceRating =
  | "excellent"
  | "good"
  | "average"
  | "poor"
  | "critical";

export interface MetricRating {
  value: number;
  rating: PerformanceRating;
}

export interface SignificantDrop {
  second: number;
  formattedTime: string;
  dropPercentage: number;
  viewersBefore: number;
  viewersAfter: number;
  severity: PerformanceRating;
}

export interface VideoAnalysis {
  videoId: string;
  videoName: string;
  overallScore: number;
  overallRating: PerformanceRating;
  metrics: {
    playRate: MetricRating;
    engagement: MetricRating;
    conversionRate: MetricRating;
    unmuteRate: MetricRating;
  };
  significantDrops: SignificantDrop[];
  recommendations: Recommendation[];
}

export interface Recommendation {
  type: "critical" | "warning" | "suggestion" | "positive";
  metric: string;
  title: string;
  detail: string;
  actionableStep: string;
}

// ── Portfolio Summary ──

export interface PortfolioSummary {
  totalVideos: number;
  totalPlays: number;
  totalConversions: number;
  totalRevenue: number;
  avgEngagement: number;
  avgConversionRate: number;
  avgPlayRate: number;
  avgUnmuteRate: number;
  topPerformers: Array<{
    videoId: string;
    videoName: string;
    score: number;
  }>;
  worstPerformers: Array<{
    videoId: string;
    videoName: string;
    score: number;
  }>;
  portfolioRecommendations: Recommendation[];
}

// ── AI Content Analysis ──

export interface ExpertFeedback {
  expertName: string;
  expertRole: string;
  overallAssessment: string;
  strengths: string[];
  weaknesses: string[];
  specificFixes: Array<{
    timestamp: string;
    issue: string;
    fix: string;
  }>;
  priorityAction: string;
  croTests: CROTest[];
}

export interface CROTest {
  testName: string;
  hypothesis: string;
  control: string;
  variant: string;
  expectedImpact: string;
  implementation: string;
}

export interface TimestampAnalysis {
  timestamp: string;
  formattedTime: string;
  contentDescription: string;
  audioDescription: string;
  issue: string;
  fix: string;
}

export interface ScriptStructure {
  hook: string;
  problem: string;
  solution: string;
  proof: string;
  cta: string;
  overallFlow: string;
}

export interface ContentAnalysis {
  videoId: string;
  analyzedAt: string;
  expertFeedback: ExpertFeedback[];
  croTests: CROTest[];
  timestampAnalysis: TimestampAnalysis[];
  scriptStructure: ScriptStructure;
  overallVerdict: string;
  transcript: string;
}

// ── Script Rewriter (Claude) ──

export interface RewrittenScript {
  videoId: string;
  expertIndex: number;
  expertName: string;
  rewrittenAt: string;
  sections: RewrittenScriptSection[];
  fullRewrittenScript: string;
  changesSummary: string;
}

export interface RewrittenScriptSection {
  sectionName: string;
  originalText: string;
  rewrittenText: string;
  changesExplained: string;
  expertPrinciple: string;
}

// ── Generated CRO Tests (Claude) ──

export interface GeneratedCROTests {
  videoId: string;
  expertIndex: number;
  expertName: string;
  generatedAt: string;
  batchNumber: number;
  tests: CROTest[];
  previousTestNames: string[];
}

// ── Cache ──

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiresAt: number;
}

// ── API Usage ──

export interface ApiUsage {
  monthlyLimit: number | null;
  currentUsage: number;
  remaining: number | null;
}

import type {
  ApiResponse,
  RawVideo,
  RawVideoStats,
  RawDropOff,
  RawUsage,
  Video,
  VideoStats,
  DropOffData,
  DropOffPoint,
  ApiUsage,
} from "./types.js";
import { cacheKey, readCache, writeCache, DEFAULT_TTL } from "./cache.js";

const BASE_URL = "https://api.vidalytics.com/public/v1";

export class VidalyticsClient {
  private apiToken: string;

  constructor(apiToken: string) {
    this.apiToken = apiToken;
  }

  private async request<T>(
    endpoint: string,
    params?: Record<string, string>,
    options?: { skipCache?: boolean; cacheTtl?: number }
  ): Promise<T> {
    const key = cacheKey(endpoint, params);
    if (!options?.skipCache) {
      const cached = readCache<T>(key);
      if (cached !== null) return cached;
    }

    const url = new URL(`${BASE_URL}${endpoint}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    console.log(`[Vidalytics API] ${url.toString()}`);

    const res = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        "X-API-Key": this.apiToken,
      },
    });

    if (res.status === 429) {
      // Rate limited — exponential backoff with up to 3 retries
      for (let attempt = 1; attempt <= 3; attempt++) {
        const delay = 2000 * Math.pow(2, attempt); // 4s, 8s, 16s
        await new Promise((r) => setTimeout(r, delay));
        const retry = await fetch(url.toString(), {
          headers: {
            Accept: "application/json",
            "X-API-Key": this.apiToken,
          },
        });
        if (retry.ok) {
          const data = (await retry.json()) as ApiResponse<T>;
          writeCache(key, data.content, options?.cacheTtl ?? DEFAULT_TTL);
          return data.content;
        }
        if (retry.status !== 429) {
          throw new Error(`Vidalytics API error ${retry.status}: ${await retry.text()}`);
        }
      }
      throw new Error(`Vidalytics API rate limited (429) after 3 retries for ${endpoint}`);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Vidalytics API error ${res.status}: ${body}`);
    }

    const json = (await res.json()) as ApiResponse<T>;
    writeCache(key, json.content, options?.cacheTtl ?? DEFAULT_TTL);
    return json.content;
  }

  async getUsage(): Promise<ApiUsage> {
    const raw = await this.request<RawUsage>("/stats/usage", undefined, { skipCache: true });
    return {
      monthlyLimit: raw.monthly_limit,
      currentUsage: raw.current_usage,
      remaining: raw.remaining,
    };
  }

  async listVideos(): Promise<Video[]> {
    const raw = await this.request<{ data: RawVideo[] }>("/video", undefined, {
      cacheTtl: 24 * 60 * 60 * 1000, // Cache video list for 24h
    });
    return raw.data.map((v) => ({
      id: v.id,
      title: v.title,
      dateCreated: v.date_created,
      lastPublished: v.last_published,
      status: v.status,
      views: v.views,
      folderId: v.folder_id,
      thumbnailUrl: v.thumbnail?.desktop ?? "",
      videoUrl: v.url ?? "",
    }));
  }

  async getVideoStats(
    videoId: string,
    dateFrom: string,
    dateTo: string,
    filters?: { urlParam?: Record<string, string> }
  ): Promise<VideoStats> {
    // If filters are provided, use the timeline endpoint which supports filtering
    if (filters?.urlParam && Object.keys(filters.urlParam).length > 0) {
      return this.getVideoStatsFiltered(videoId, dateFrom, dateTo, filters);
    }

    // No filters - use the regular stats endpoint
    const params: Record<string, string> = { dateFrom, dateTo };
    const raw = await this.request<RawVideoStats>(`/stats/video/${videoId}`, params);
    return {
      videoId,
      plays: raw.plays,
      playsUnique: raw.playsUnique,
      playRate: raw.playRate,
      uniquePlayRate: raw.uniquePlayRate,
      engagement: raw.engagement,
      impressions: raw.impressions,
      conversionCount: raw.conversionCount,
      conversionRate: raw.conversionRate,
      revenue: raw.revenue,
      revenueAverage: raw.revenueAverage,
      revenuePerViewer: raw.revenuePerViewer,
      unmuteRate: raw.unmuteRate,
      unmuteCount: raw.unmuteCount,
      pgOptInRate: raw.pgOptInRate,
      pgEventsCount: raw.pgEventsCount,
    };
  }

  /**
   * Get video stats with URL parameter filtering using the timeline endpoint.
   * The timeline endpoint is the only one that supports filter.url_params.{param}
   */
  private async getVideoStatsFiltered(
    videoId: string,
    dateFrom: string,
    dateTo: string,
    filters: { urlParam?: Record<string, string> }
  ): Promise<VideoStats> {
    const params: Record<string, string> = {
      videoGuids: videoId,
      metrics: "plays,impressions,conversions,revenue", // Available metrics in timeline endpoint
      dateFrom,
      dateTo,
    };

    // Add URL parameter filters using the correct format: filter.url_params.{paramName}=value
    if (filters.urlParam) {
      for (const [key, value] of Object.entries(filters.urlParam)) {
        params[`filter.url_params.${key}`] = value;
      }
    }

    console.log(`[Vidalytics] Using timeline endpoint with filters:`, params);

    interface TimelineResponse {
      data: Array<{
        segment: string;
        data: Array<{
          date: string;
          data: Array<{
            videoGuid: string;
            metrics: {
              plays?: number;
              impressions?: number;
              conversions?: number;
              revenue?: number;
              engagement?: number;
              unmutes?: number;
            };
          }>;
        }>;
      }>;
    }

    const raw = await this.request<TimelineResponse>(`/stats/videos/timeline`, params, { skipCache: true });

    // Aggregate timeline data into totals
    let totalPlays = 0;
    let totalImpressions = 0;
    let totalConversions = 0;
    let totalRevenue = 0;

    for (const segment of raw.data || []) {
      for (const dayData of segment.data || []) {
        for (const videoData of dayData.data || []) {
          if (videoData.videoGuid === videoId) {
            const m = videoData.metrics;
            totalPlays += m.plays || 0;
            totalImpressions += m.impressions || 0;
            totalConversions += m.conversions || 0;
            totalRevenue += m.revenue || 0;
          }
        }
      }
    }

    const playRate = totalImpressions > 0 ? totalPlays / totalImpressions : 0;
    const conversionRate = totalPlays > 0 ? totalConversions / totalPlays : 0;

    return {
      videoId,
      plays: totalPlays,
      playsUnique: totalPlays, // Timeline doesn't provide unique plays
      playRate,
      uniquePlayRate: playRate,
      engagement: 0, // Not available in timeline endpoint
      impressions: totalImpressions,
      conversionCount: totalConversions,
      conversionRate,
      revenue: totalRevenue,
      revenueAverage: totalConversions > 0 ? totalRevenue / totalConversions : 0,
      revenuePerViewer: totalPlays > 0 ? totalRevenue / totalPlays : 0,
      unmuteRate: 0, // Not available in timeline endpoint
      unmuteCount: 0,
      pgOptInRate: 0,
      pgEventsCount: 0,
    };
  }

  async getDropOff(
    videoId: string,
    dateFrom: string,
    dateTo: string,
    filters?: { urlParam?: Record<string, string> }
  ): Promise<DropOffData> {
    const params: Record<string, string> = { dateFrom, dateTo };

    // Add URL parameter filters (e.g., affiliate ID)
    if (filters?.urlParam) {
      for (const [key, value] of Object.entries(filters.urlParam)) {
        params[`urlParam[${key}]`] = value;
      }
    }

    const raw = await this.request<RawDropOff>(`/stats/video/${videoId}/drop-off`, params);

    const watches = raw.all.watches;
    const seconds = Object.keys(watches)
      .map(Number)
      .sort((a, b) => a - b);

    const totalViewers = seconds.length > 0 ? watches[String(seconds[0])] : 0;

    const points: DropOffPoint[] = seconds.map((sec, i) => {
      const viewers = watches[String(sec)];
      const prevViewers = i > 0 ? watches[String(seconds[i - 1])] : viewers;
      const dropFromPrevious =
        prevViewers > 0 ? ((prevViewers - viewers) / prevViewers) * 100 : 0;

      return {
        second: sec,
        formattedTime: formatSeconds(sec),
        viewers,
        percentRemaining: totalViewers > 0 ? (viewers / totalViewers) * 100 : 0,
        dropFromPrevious,
      };
    });

    return { videoId, totalViewers, points };
  }
}

function formatSeconds(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

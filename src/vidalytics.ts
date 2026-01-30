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

    const res = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        "X-API-Key": this.apiToken,
      },
    });

    if (res.status === 429) {
      // Rate limited — wait 5s and retry once
      await new Promise((r) => setTimeout(r, 5000));
      const retry = await fetch(url.toString(), {
        headers: {
          Accept: "application/json",
          "X-API-Key": this.apiToken,
        },
      });
      if (!retry.ok) {
        throw new Error(`Vidalytics API rate limited (429) after retry: ${await retry.text()}`);
      }
      const data = (await retry.json()) as ApiResponse<T>;
      writeCache(key, data.content, options?.cacheTtl ?? DEFAULT_TTL);
      return data.content;
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
    dateTo: string
  ): Promise<VideoStats> {
    const raw = await this.request<RawVideoStats>(`/stats/video/${videoId}`, {
      dateFrom,
      dateTo,
    });
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

  async getDropOff(
    videoId: string,
    dateFrom: string,
    dateTo: string
  ): Promise<DropOffData> {
    const raw = await this.request<RawDropOff>(`/stats/video/${videoId}/drop-off`, {
      dateFrom,
      dateTo,
    });

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

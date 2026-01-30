import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import type { CacheEntry } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = path.join(__dirname, "..", "cache");

export const DEFAULT_TTL = 4 * 60 * 60 * 1000; // 4 hours
export const AI_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

export function cacheKey(endpoint: string, params?: Record<string, string>): string {
  const raw = endpoint + JSON.stringify(params ?? {});
  return crypto.createHash("md5").update(raw).digest("hex");
}

export function readCache<T>(key: string): T | null {
  const file = path.join(CACHE_DIR, `${key}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const entry: CacheEntry<T> = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (Date.now() > entry.expiresAt) {
      fs.unlinkSync(file);
      return null;
    }
    return entry.data;
  } catch {
    return null;
  }
}

export function readCacheWithMeta<T>(key: string): { data: T; timestamp: number } | null {
  const file = path.join(CACHE_DIR, `${key}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const entry: CacheEntry<T> = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (Date.now() > entry.expiresAt) {
      fs.unlinkSync(file);
      return null;
    }
    return { data: entry.data, timestamp: entry.timestamp };
  } catch {
    return null;
  }
}

export function writeCache<T>(key: string, data: T, ttl: number = DEFAULT_TTL): void {
  const entry: CacheEntry<T> = {
    data,
    timestamp: Date.now(),
    expiresAt: Date.now() + ttl,
  };
  try {
    fs.writeFileSync(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(entry));
  } catch {
    // Cache write failure is non-fatal
  }
}

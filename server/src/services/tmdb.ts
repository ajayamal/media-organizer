import type Database from 'better-sqlite3';
import type { MediaType } from './metadata-matching.js';

const API_BASE = 'https://api.themoviedb.org/3';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REQUEST_GAP_MS = 250;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface TmdbCandidate {
  id: number;
  mediaType: MediaType;
  title: string;
  originalTitle: string;
  year?: number;
  aliases: string[];
}

export interface TmdbEpisode {
  episode_number: number;
  name: string;
}

export class TmdbError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = 'TmdbError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class TmdbClient {
  private lastRequestAt = 0;
  private readonly token: string;

  constructor(private readonly db: Database.Database, token: string) {
    this.token = token.trim();
  }

  async search(type: MediaType, query: string): Promise<TmdbCandidate[]> {
    const data = await this.request(`/search/${type}`, {
      query: query.slice(0, 200),
      include_adult: 'false',
      language: 'en-US',
      page: '1',
    });
    const results = Array.isArray(data.results) ? data.results : [];
    return results.flatMap((item: unknown) => {
      if (!isRecord(item) || !Number.isSafeInteger(item.id)) return [];
      const title = type === 'movie' ? item.title : item.name;
      const originalTitle = type === 'movie' ? item.original_title : item.original_name;
      if (typeof title !== 'string' || typeof originalTitle !== 'string' || !title.trim() || title.length > 300 || originalTitle.length > 300) return [];
      const date = type === 'movie' ? item.release_date : item.first_air_date;
      const year = typeof date === 'string' && /^\d{4}-/.test(date) ? Number(date.slice(0, 4)) : undefined;
      return [{ id: item.id as number, mediaType: type, title: title.trim(), originalTitle: originalTitle.trim(), year, aliases: [title.trim(), originalTitle.trim()] }];
    });
  }

  async aliases(type: MediaType, id: number): Promise<string[]> {
    const endpoint = type === 'movie' ? `/movie/${id}/alternative_titles` : `/tv/${id}/alternative_titles`;
    const data = await this.request(endpoint);
    const rows = type === 'movie' ? data.titles : data.results;
    return Array.isArray(rows)
      ? rows.flatMap((row: unknown) => isRecord(row) && typeof row.title === 'string' && row.title.trim() && row.title.length <= 300 ? [row.title.trim()] : []).slice(0, 100)
      : [];
  }

  async season(id: number, seasonNumber: number): Promise<TmdbEpisode[]> {
    const data = await this.request(`/tv/${id}/season/${seasonNumber}`);
    return Array.isArray(data.episodes)
      ? data.episodes.flatMap((episode: unknown) => isRecord(episode) && Number.isSafeInteger(episode.episode_number) && typeof episode.name === 'string' && episode.name.length <= 300
        ? [{ episode_number: episode.episode_number as number, name: episode.name }]
        : [])
      : [];
  }

  private async request(endpoint: string, query: Record<string, string> = {}): Promise<Record<string, unknown>> {
    if (!this.token) throw new TmdbError('TMDB_READ_TOKEN is not configured.');
    const key = `tmdb:${endpoint}?${new URLSearchParams(query).toString()}`;
    this.db.prepare('DELETE FROM metadata_cache WHERE expires_at<=?').run(Date.now());
    const cached = this.db.prepare('SELECT payload FROM metadata_cache WHERE cache_key=? AND expires_at>?')
      .get(key, Date.now()) as { payload: string } | undefined;
    if (cached) {
      const payload: unknown = JSON.parse(cached.payload);
      if (isRecord(payload)) return payload;
      throw new TmdbError('Cached TMDB response is invalid.');
    }

    const url = new URL(`${API_BASE}${endpoint}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const waitMs = Math.max(0, REQUEST_GAP_MS - (Date.now() - this.lastRequestAt));
      if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
      this.lastRequestAt = Date.now();
      try {
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.status === 429 || response.status >= 500) {
          const retryAfter = Number(response.headers.get('retry-after'));
          if (attempt < 2) {
            const delay = Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter * 1000, 5000)
              : 250 * (2 ** attempt);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        }
        if (!response.ok) throw new TmdbError(`TMDB request failed with HTTP ${response.status}.`, response.status);
        const contentLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
          throw new TmdbError('TMDB response exceeded the size limit.');
        }
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
          throw new TmdbError('TMDB response exceeded the size limit.');
        }
        const data: unknown = JSON.parse(text);
        if (!isRecord(data)) {
          throw new TmdbError('TMDB returned an invalid response.');
        }
        this.db.prepare('INSERT OR REPLACE INTO metadata_cache (cache_key,payload,expires_at) VALUES (?,?,?)')
          .run(key, JSON.stringify(data), Date.now() + CACHE_TTL_MS);
        return data;
      } catch (error) {
        lastError = error;
        if (error instanceof TmdbError && error.statusCode !== 429 && (error.statusCode ?? 0) < 500) throw error;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (2 ** attempt)));
      }
    }
    if (lastError instanceof Error) throw new TmdbError(`TMDB request failed after retries: ${lastError.message}`);
    throw new TmdbError('TMDB request failed after retries.');
  }
}

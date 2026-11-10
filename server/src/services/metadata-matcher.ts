import type Database from 'better-sqlite3';
import {
  parseMediaPath,
  safeMetadataName,
  scoreCandidates,
  type Confidence,
  type MetadataCandidate,
  type ParsedMedia,
} from './metadata-matching.js';
import { TmdbClient, TmdbError, type TmdbCandidate, type TmdbEpisode } from './tmdb.js';

interface InventoryRow {
  id: string;
  rel: string;
  category: string;
}

interface MatchRun {
  id: number;
}

export class MetadataMatcher {
  private readonly client: TmdbClient;

  constructor(private readonly db: Database.Database, token: string) {
    this.client = new TmdbClient(db, token);
  }

  async run(runId: number): Promise<void> {
    const rows = this.db.prepare('SELECT id,rel,category FROM inventory ORDER BY category,rel').all() as InventoryRow[];
    const run = this.db.prepare('SELECT * FROM metadata_match_runs WHERE id=?').get(runId) as MatchRun | undefined;
    if (!run) throw new Error(`Metadata run ${runId} was not found.`);
    this.db.prepare("UPDATE metadata_match_runs SET status='running',total=? WHERE id=?").run(rows.length, runId);

    const titleSearchCache = new Map<string, Promise<TmdbCandidate[]>>();
    let matched = 0;
    let review = 0;
    let unmatched = 0;
    let preserved = 0;
    let errors = 0;

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      let result: ReturnType<typeof this.makeRecord>;
      try {
        result = await this.matchRow(row, titleSearchCache);
      } catch (error) {
        if (error instanceof TmdbError && (error.statusCode === 401 || error.statusCode === 403)) throw error;
        errors++;
        const message = error instanceof Error ? error.message : 'Unknown metadata matching error.';
        result = this.makeRecord(row, parseMediaPath(row.rel, row.category), {
          score: 0,
          confidence: 'unmatched',
          candidates: [],
          explanations: [`Metadata lookup failed: ${message}`],
        }, undefined, message);
      }

      if (result.matchStatus === 'matched') matched++;
      else if (result.matchStatus === 'review') review++;
      else if (result.matchStatus === 'preserved') preserved++;
      else unmatched++;
      this.saveRecord(runId, result);
      this.db.prepare(`UPDATE metadata_match_runs
        SET processed=?,matched=?,review=?,unmatched=?,preserved=?,errors=? WHERE id=?`)
        .run(index + 1, matched, review, unmatched, preserved, errors, runId);
    }

    this.db.prepare("UPDATE metadata_match_runs SET status='completed',completed_at=? WHERE id=?")
      .run(new Date().toISOString(), runId);
  }

  fail(runId: number, message: string): void {
    this.db.prepare("UPDATE metadata_match_runs SET status='failed',error=?,completed_at=? WHERE id=?")
      .run(message, new Date().toISOString(), runId);
  }

  private async matchRow(row: InventoryRow, searchCache: Map<string, Promise<TmdbCandidate[]>>) {
    const parsed = parseMediaPath(row.rel, row.category);
    if (parsed.preservedReason) {
      return this.makeRecord(row, parsed, { score: 0, confidence: 'preserved', candidates: [], explanations: [parsed.preservedReason] });
    }
    if (!parsed.title) {
      return this.makeRecord(row, parsed, { score: 0, confidence: 'unmatched', candidates: [], explanations: ['No reliable title could be extracted.'] });
    }

    const cacheKey = `${parsed.type}:${parsed.title.toLowerCase()}`;
    let search = searchCache.get(cacheKey);
    if (!search) {
      search = this.client.search(parsed.type, parsed.title);
      searchCache.set(cacheKey, search);
    }
    const found = await search;

    const firstPass = scoreCandidates(parsed, found);
    const likely = firstPass.candidates.slice(0, 3);
    const enriched = [];
    for (const candidate of likely) {
      try {
        const aliases = await this.client.aliases(candidate.mediaType, candidate.id);
        enriched.push({ ...candidate, aliases: [...new Set([...candidate.aliases, ...aliases])] });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown alias lookup error.';
        enriched.push({ ...candidate, aliases: candidate.aliases, aliasLookupError: message });
      }
    }

    const raw = enriched.map(candidate => ({
      id: candidate.id,
      mediaType: candidate.mediaType,
      title: candidate.title,
      originalTitle: candidate.originalTitle,
      year: candidate.year,
      aliases: candidate.aliases,
    }));
    const scored = scoreCandidates(parsed, raw);
    if (!scored.candidate) {
      return this.makeRecord(row, parsed, scored);
    }

    for (const candidate of enriched) {
      if (candidate.id === scored.candidate.id && 'aliasLookupError' in candidate) {
        scored.candidate.explanations.push('Alternative-title lookup failed; scoring used search titles only.');
      }
    }

    const mapping = await this.episodeMapping(parsed, scored.candidate);
    const record = this.makeRecord(row, parsed, scored, mapping.proposal, undefined, mapping.episodeTitle);
    if (mapping.blockReason) {
      record.explanations.push(mapping.blockReason);
      record.confidence = record.confidence === 'high' ? 'medium' : record.confidence;
      record.confidenceScore = Math.min(record.confidenceScore, 89);
      record.matchStatus = 'review';
      record.proposedRel = null;
    } else if (record.confidence === 'high' && !parsed.episodeStyle?.includes('absolute')) {
      record.matchStatus = 'matched';
    } else {
      record.matchStatus = 'review';
    }
    return record;
  }

  private async episodeMapping(parsed: ParsedMedia, candidate: MetadataCandidate): Promise<{ proposal?: string; episodeTitle?: string; blockReason?: string }> {
    if (parsed.type === 'movie') {
      if (candidate.year === undefined) return { blockReason: 'Provider metadata has no release year; a safe destination cannot be generated.' };
      const title = safeMetadataName(candidate.title);
      const folder = safeMetadataName(`${title} (${candidate.year})`);
      return { proposal: `${this.categoryPath(parsed)}/${folder}/${folder}${parsed.extension}` };
    }

    if (parsed.episodeStyle === 'absolute') {
      return { blockReason: 'Absolute episode numbering is not mapped automatically; confirm the season and episode first.' };
    }
    if (!parsed.episodeStyle || parsed.season === undefined || parsed.episode === undefined) {
      return { blockReason: 'Episode number is missing or unrecognized; series match requires review.' };
    }
    if (parsed.folderSeason !== undefined && parsed.folderSeason !== parsed.season) {
      return { blockReason: `Season folder (${parsed.folderSeason}) conflicts with filename season (${parsed.season}).` };
    }

    let episodes: TmdbEpisode[];
    try {
      episodes = await this.client.season(candidate.id, parsed.season);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown season lookup error.';
      return { blockReason: `Episode metadata could not be verified: ${message}` };
    }
    const episode = episodes.find(item => item.episode_number === parsed.episode);
    if (!episode) return { blockReason: `TMDB has no episode ${parsed.season}x${parsed.episode} for this series.` };

    const title = safeMetadataName(candidate.title);
    const folder = safeMetadataName(candidate.year === undefined ? title : `${title} (${candidate.year})`);
    const seasonFolder = `Season ${String(parsed.season).padStart(2, '0')}`;
    const filename = `${title} - S${String(parsed.season).padStart(2, '0')}E${String(parsed.episode).padStart(2, '0')}${parsed.extension}`;
    return { proposal: `${this.categoryPath(parsed)}/${folder}/${seasonFolder}/${filename}`, episodeTitle: episode.name };
  }

  private categoryPath(parsed: ParsedMedia): string {
    return parsed.category;
  }

  private makeRecord(
    row: InventoryRow,
    parsed: ParsedMedia,
    scored: { candidate?: MetadataCandidate; candidates: MetadataCandidate[]; score: number; confidence: Confidence; explanations: string[] },
    proposedRel?: string,
    error?: string,
    episodeTitle?: string,
  ) {
    let matchStatus: 'matched' | 'review' | 'unmatched' | 'preserved' =
      scored.confidence === 'preserved' ? 'preserved' :
      scored.confidence === 'unmatched' ? 'unmatched' :
      scored.confidence === 'high' ? 'matched' : 'review';
    if (parsed.type === 'tv' && (!parsed.episodeStyle || parsed.episodeStyle === 'absolute')) matchStatus = 'review';
    return {
      inventoryId: row.id,
      rel: row.rel,
      providerId: scored.candidate?.id ?? null,
      providerType: scored.candidate?.mediaType ?? null,
      title: scored.candidate?.title ?? null,
      originalTitle: scored.candidate?.originalTitle ?? null,
      releaseYear: scored.candidate?.year ?? null,
      episodeTitle: episodeTitle ?? null,
      confidenceScore: scored.score,
      confidence: scored.confidence,
      matchStatus,
      explanations: scored.explanations,
      candidates: scored.candidates,
      season: parsed.season ?? null,
      episode: parsed.episode ?? null,
      proposedRel: proposedRel ?? null,
      error: error ?? null,
      updatedAt: new Date().toISOString(),
    };
  }

  private saveRecord(runId: number, record: ReturnType<typeof this.makeRecord>): void {
    this.db.prepare(`INSERT OR REPLACE INTO metadata_matches
      (run_id,inventory_id,rel,provider_id,provider_type,title,original_title,release_year,confidence_score,confidence,
       episode_title,match_status,explanations,candidates,season,episode,proposed_rel,error,updated_at)
      VALUES (@runId,@inventoryId,@rel,@providerId,@providerType,@title,@originalTitle,@releaseYear,@confidenceScore,@confidence,
       @episodeTitle,@matchStatus,@explanations,@candidates,@season,@episode,@proposedRel,@error,@updatedAt)`)
      .run({
        runId,
        ...record,
        explanations: JSON.stringify(record.explanations),
        candidates: JSON.stringify(record.candidates),
      });
  }
}

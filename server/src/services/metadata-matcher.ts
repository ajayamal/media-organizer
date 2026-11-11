import type Database from 'better-sqlite3';
import {
  parseMediaPath,
  createMetadataProposal,
  normalizeTitle,
  safeMetadataName,
  scoreCandidates,
  type Confidence,
  type MetadataCandidate,
  type ParsedMedia,
} from './metadata-matching.js';
import { TmdbClient, TmdbError, type TmdbCandidate, type TmdbEpisode } from './tmdb.js';
import { LmStudioClient } from './lm-studio.js';

interface InventoryRow {
  id: string;
  rel: string;
  category: string;
}

interface MatchRun {
  id: number;
}

interface MetadataCorrection {
  rel: string;
  category: string;
  provider_id: number;
  provider_type: 'movie' | 'tv';
  provider_title: string;
  original_title: string;
  provider_year: number | null;
  corrected_title: string;
  corrected_year: number | null;
  aliases: string;
  candidate_set: string;
  season: number | null;
  episode: number | null;
}

export class MetadataMatcher {
  private readonly client: TmdbClient;

  constructor(
    private readonly db: Database.Database,
    token: string,
    private readonly aiClient: LmStudioClient | null = null,
  ) {
    this.client = new TmdbClient(db, token);
  }

  async run(runId: number): Promise<void> {
    const rows = this.db.prepare('SELECT id,rel,category FROM inventory ORDER BY category,rel').all() as InventoryRow[];
    const run = this.db.prepare('SELECT * FROM metadata_match_runs WHERE id=?').get(runId) as MatchRun | undefined;
    if (!run) throw new Error(`Metadata run ${runId} was not found.`);
    this.db.prepare("UPDATE metadata_match_runs SET status='running',total=? WHERE id=?").run(rows.length, runId);

    const titleSearchCache = new Map<string, Promise<TmdbCandidate[]>>();
    const aiTitleCache = new Map<string, Promise<string[]>>();
    let matched = 0;
    let review = 0;
    let unmatched = 0;
    let preserved = 0;
    let errors = 0;

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      let result: ReturnType<typeof this.makeRecord>;
      try {
        result = await this.matchRow(row, titleSearchCache, aiTitleCache);
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

  private async matchRow(
    row: InventoryRow,
    searchCache: Map<string, Promise<TmdbCandidate[]>>,
    aiTitleCache: Map<string, Promise<string[]>>,
  ) {
    const parsed = parseMediaPath(row.rel, row.category);
    if (parsed.preservedReason) {
      return this.makeRecord(row, parsed, { score: 0, confidence: 'preserved', candidates: [], explanations: [parsed.preservedReason] });
    }
    const correction = this.db.prepare('SELECT * FROM metadata_corrections WHERE rel=? AND category=?')
      .get(row.rel, row.category) as MetadataCorrection | undefined;
    if (correction) return this.applyCorrection(row, parsed, correction);
    if (!parsed.title && !this.aiClient) {
      return this.makeRecord(row, parsed, { score: 0, confidence: 'unmatched', candidates: [], explanations: ['No reliable title could be extracted.'] });
    }

    const searchTitles = async (title: string): Promise<TmdbCandidate[]> => {
      const cacheKey = `${parsed.type}:${normalizeTitle(title)}`;
      let search = searchCache.get(cacheKey);
      if (!search) {
        search = this.client.search(parsed.type, title);
        searchCache.set(cacheKey, search);
      }
      return search;
    };
    const foundById = new Map<number, TmdbCandidate>();
    if (parsed.title) {
      for (const candidate of await searchTitles(parsed.title)) foundById.set(candidate.id, candidate);
    }
    const initial = scoreCandidates(parsed, [...foundById.values()]);
    let assistedTitles: string[] = [];
    let aiError: string | undefined;
    if (this.aiClient && initial.confidence !== 'high') {
      const key = `${parsed.type}:${normalizeTitle(parsed.title)}:${parsed.year ?? ''}`;
      let suggestions = aiTitleCache.get(key);
      if (!suggestions) {
        suggestions = this.aiClient.suggestSearchTitles(row.rel, parsed);
        aiTitleCache.set(key, suggestions);
      }
      try {
        assistedTitles = await suggestions;
      } catch (error) {
        aiError = error instanceof Error ? error.message : 'Unknown LM Studio error.';
      }
      for (const title of assistedTitles) {
        if (normalizeTitle(title) === normalizeTitle(parsed.title)) continue;
        try {
          for (const candidate of await searchTitles(title)) foundById.set(candidate.id, candidate);
        } catch (error) {
          aiError = error instanceof Error ? error.message : 'TMDB search for an AI-suggested title failed.';
        }
      }
    }

    const likely = scoreCandidates(parsed, [...foundById.values()], assistedTitles).candidates.slice(0, 3);
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
    const scored = scoreCandidates(parsed, raw, assistedTitles);
    if (assistedTitles.length > 0) {
      scored.explanations.push(`LM Studio supplied additional title search terms: ${assistedTitles.join(', ')}.`);
    }
    if (aiError) scored.explanations.push(`LM Studio assistance was incomplete; deterministic matching was retained: ${aiError}`);
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

  private async episodeMapping(
    parsed: ParsedMedia,
    candidate: MetadataCandidate,
    corrected?: { title: string; year: number | null },
  ): Promise<{ proposal?: string; episodeTitle?: string; blockReason?: string }> {
    const outputTitle = safeMetadataName(corrected?.title ?? candidate.title);
    const outputYear = corrected ? corrected.year : candidate.year ?? null;
    if (parsed.type === 'movie') {
      if (outputYear === null) return { blockReason: 'Provider metadata has no release year; a safe destination cannot be generated.' };
      const proposal = createMetadataProposal({
        category: this.categoryPath(parsed),
        type: parsed.type,
        title: outputTitle,
        year: outputYear,
        extension: parsed.extension,
      });
      return proposal ? { proposal } : { blockReason: 'Metadata could not be converted to a safe movie destination.' };
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

    const proposal = createMetadataProposal({
      category: this.categoryPath(parsed),
      type: parsed.type,
      title: outputTitle,
      year: outputYear,
      season: parsed.season,
      episode: parsed.episode,
      extension: parsed.extension,
    });
    return proposal
      ? { proposal, episodeTitle: episode.name }
      : { blockReason: 'Metadata could not be converted to a safe episode destination.' };
  }

  private async applyCorrection(row: InventoryRow, parsed: ParsedMedia, correction: MetadataCorrection) {
    let aliases: string[];
    try {
      const value: unknown = JSON.parse(correction.aliases);
      if (!Array.isArray(value) || !value.every(alias => typeof alias === 'string')) throw new Error('Invalid stored aliases.');
      aliases = value;
    } catch (error) {
      throw new Error(`Saved metadata correction for "${row.rel}" is invalid: ${error instanceof Error ? error.message : 'unknown error'}`);
    }

    const candidate: MetadataCandidate = {
      id: correction.provider_id,
      mediaType: correction.provider_type,
      title: correction.provider_title,
      originalTitle: correction.original_title,
      year: correction.provider_year ?? undefined,
      aliases,
      score: 100,
      titleSimilarity: 1,
      explanations: ['This provider match was manually selected and saved for reuse.'],
      ambiguous: false,
    };
    let candidates: MetadataCandidate[] = [candidate];
    try {
      const savedCandidates: unknown = JSON.parse(correction.candidate_set);
      if (!Array.isArray(savedCandidates)) throw new Error('Invalid candidate list.');
      const previousCandidates = savedCandidates.flatMap((entry: unknown) => {
        if (typeof entry !== 'object' || entry === null) return [];
        const value = entry as Partial<MetadataCandidate>;
        if (!Number.isSafeInteger(value.id)
          || (value.mediaType !== 'movie' && value.mediaType !== 'tv')
          || typeof value.title !== 'string'
          || typeof value.originalTitle !== 'string'
          || !Array.isArray(value.aliases)
          || !value.aliases.every(alias => typeof alias === 'string')) return [];
        return [{
          id: value.id as number,
          mediaType: value.mediaType,
          title: value.title,
          originalTitle: value.originalTitle,
          year: Number.isInteger(value.year) ? value.year : undefined,
          aliases: value.aliases,
          score: value.id === candidate.id ? 100 : typeof value.score === 'number' && Number.isInteger(value.score) ? value.score : 0,
          titleSimilarity: typeof value.titleSimilarity === 'number' && Number.isFinite(value.titleSimilarity) ? value.titleSimilarity : 0,
          explanations: Array.isArray(value.explanations) && value.explanations.every(note => typeof note === 'string') ? value.explanations : [],
          ambiguous: value.id !== candidate.id && Boolean(value.ambiguous),
        }];
      });
      if (previousCandidates.some(entry => entry.id === candidate.id && entry.mediaType === candidate.mediaType)) {
        candidates = previousCandidates;
      }
    } catch (error) {
      throw new Error(`Saved candidate list for "${row.rel}" is invalid: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    const correctedParsed: ParsedMedia = {
      ...parsed,
      title: correction.corrected_title,
      year: correction.corrected_year ?? undefined,
      season: correction.season ?? undefined,
      episode: correction.episode ?? undefined,
      episodeStyle: correction.provider_type === 'tv' ? 'season-episode' : undefined,
      folderSeason: correction.season ?? undefined,
    };
    const mapping = await this.episodeMapping(correctedParsed, candidate, {
      title: correction.corrected_title,
      year: correction.corrected_year,
    });
    const record = this.makeRecord(row, correctedParsed, {
      candidate,
      candidates,
      score: 100,
      confidence: 'high',
      explanations: ['This provider match and correction were manually selected and saved for reuse.'],
    }, mapping.proposal, undefined, mapping.episodeTitle);
    record.title = correction.corrected_title;
    record.releaseYear = correction.corrected_year;
    record.manualCorrection = true;
    if (mapping.blockReason) {
      record.confidence = 'medium';
      record.confidenceScore = 89;
      record.matchStatus = 'review';
      record.proposedRel = null;
      record.explanations.push(mapping.blockReason);
    } else {
      record.matchStatus = 'matched';
    }
    return record;
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
      manualCorrection: false,
      updatedAt: new Date().toISOString(),
    };
  }

  private saveRecord(runId: number, record: ReturnType<typeof this.makeRecord>): void {
    this.db.prepare(`INSERT OR REPLACE INTO metadata_matches
      (run_id,inventory_id,rel,provider_id,provider_type,title,original_title,release_year,confidence_score,confidence,
       episode_title,match_status,explanations,candidates,season,episode,proposed_rel,error,manual_correction,updated_at)
      VALUES (@runId,@inventoryId,@rel,@providerId,@providerType,@title,@originalTitle,@releaseYear,@confidenceScore,@confidence,
       @episodeTitle,@matchStatus,@explanations,@candidates,@season,@episode,@proposedRel,@error,@manualCorrection,@updatedAt)`)
      .run({
        runId,
        ...record,
        manualCorrection: record.manualCorrection ? 1 : 0,
        explanations: JSON.stringify(record.explanations),
        candidates: JSON.stringify(record.candidates),
      });
  }
}

import path from 'node:path';

export type MediaType = 'movie' | 'tv';
export type Confidence = 'high' | 'medium' | 'low' | 'unmatched' | 'preserved';

export interface ParsedMedia {
  type: MediaType;
  category: string;
  title: string;
  year?: number;
  extension: string;
  seriesFolder?: string;
  season?: number;
  episode?: number;
  episodeStyle?: 'season-episode' | 'absolute';
  folderSeason?: number;
  preservedReason?: string;
}

export interface MetadataCandidate {
  id: number;
  mediaType: MediaType;
  title: string;
  originalTitle: string;
  year?: number;
  aliases: string[];
  score: number;
  titleSimilarity: number;
  explanations: string[];
  ambiguous: boolean;
}

export interface ScoredMatch {
  candidate?: MetadataCandidate;
  candidates: MetadataCandidate[];
  score: number;
  confidence: Confidence;
  explanations: string[];
}

export function createMetadataProposal(input: {
  category: string;
  type: MediaType;
  title: string;
  year: number | null;
  season?: number | null;
  episode?: number | null;
  extension: string;
}): string | null {
  const categories = ['movies/Anime', 'movies/Movies', 'shows/Anime', 'shows/Tv Shows'];
  if (!categories.includes(input.category) || !/^\.[a-z0-9]{1,8}$/i.test(input.extension)) return null;
  const title = safeMetadataName(input.title);
  if (input.type === 'movie') {
    if (input.year === null || !Number.isInteger(input.year)) return null;
    const folder = safeMetadataName(`${title} (${input.year})`);
    return `${input.category}/${folder}/${folder}${input.extension}`;
  }
  if (input.season == null || input.episode == null
    || !Number.isInteger(input.season) || input.season < 0 || input.season > 99
    || !Number.isInteger(input.episode) || input.episode < 1 || input.episode > 999) return null;
  const folder = safeMetadataName(input.year === null ? title : `${title} (${input.year})`);
  const seasonFolder = `Season ${String(input.season).padStart(2, '0')}`;
  const filename = `${title} - S${String(input.season).padStart(2, '0')}E${String(input.episode).padStart(2, '0')}${input.extension}`;
  return `${input.category}/${folder}/${seasonFolder}/${filename}`;
}

const releaseSuffix = /\b(?:web[- .]?dl|web[- .]?rip|bluray|bdrip|hdtv|dvdrip|proper|repack|x26[45]|h\.?26[45]|hevc|avc|aac|dts|flac|10bit|8bit|1080p|2160p|720p|480p|multi[- ]audio|dual[- ]audio|eng(?:lish)?[- ]dub|subbed|eztv(?:x)?(?:\.to)?)\b.*$/i;

function stripExtension(filename: string): { stem: string; extension: string } {
  const extension = path.posix.extname(filename);
  return { stem: extension ? filename.slice(0, -extension.length) : filename, extension };
}

function cleanTitle(value: string): string {
  return value
    .replace(/^\[[^\]]+\]\s*/g, '')
    .replace(/\[[^\]]*]/g, ' ')
    .replace(/\([^)]*(?:dual audio|multi audio|10bit|8bit|1080p|720p|x26[45]|bluray|web[- ]?dl)[^)]*\)/gi, ' ')
    .replace(/[_\.]+/g, ' ')
    .replace(/\s*[-_]{2,}\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[([{]\s*$/, '')
    .trim()
    .replace(/^[\s\-_:]+|[\s\-_:]+$/g, '');
}

function titleAndYear(value: string): { title: string; year?: number } {
  const yearMatch = value.match(/\b((?:19|20)\d{2})\b/);
  const year = yearMatch ? Number(yearMatch[1]) : undefined;
  const title = cleanTitle(yearMatch ? value.slice(0, yearMatch.index) : value)
    .replace(releaseSuffix, '')
    .trim();
  return { title: title || cleanTitle(value).replace(releaseSuffix, '').trim(), year };
}

export function parseMediaPath(rel: string, category: string): ParsedMedia {
  const parts = rel.split('/');
  const filename = parts.at(-1) || '';
  const { stem, extension } = stripExtension(filename);
  const type: MediaType = category.startsWith('movies/') ? 'movie' : 'tv';

  if (filename.startsWith('._')
    || parts.some(part => /^(extras?|specials?|featurettes?|behind the scenes|ncop|nced)$/i.test(part))
    || /\b(?:OVA|special|NCOP|NCED|featurette|extra)\b/i.test(stem)) {
    return {
      type,
      category,
      title: '',
      extension,
      preservedReason: filename.startsWith('._') ? 'AppleDouble metadata is preserved.' : 'Extras and specials require manual review.',
    };
  }

  const seasonEpisode = stem.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
  const seasonFolder = parts.slice(0, -1).map(part => part.match(/^Season\s+(\d{1,2})$/i)).find(Boolean);
  const folderSeason = seasonFolder ? Number(seasonFolder[1]) : undefined;
  const absoluteEpisode = !seasonEpisode && type === 'tv'
    ? stem.match(/(?:\s-\s|_-_)(\d{1,3})(?:\b|_)/)
    : undefined;

  let titleSource: string;
  if (type === 'tv') {
    const seriesFolder = parts.length > 3 ? parts[2] : undefined;
    titleSource = seriesFolder || stem
      .replace(/\bS\d{1,2}E\d{1,3}\b/ig, ' ')
      .replace(/(?:\s-\s|_-_)\d{1,3}(?:\b|_)/g, ' ');
    const parsed = titleAndYear(titleSource);
    return {
      type,
      category,
      ...parsed,
      extension,
      seriesFolder,
      season: seasonEpisode ? Number(seasonEpisode[1]) : folderSeason,
      episode: seasonEpisode ? Number(seasonEpisode[2]) : absoluteEpisode ? Number(absoluteEpisode[1]) : undefined,
      episodeStyle: seasonEpisode ? 'season-episode' : absoluteEpisode ? 'absolute' : undefined,
      folderSeason,
    };
  }

  const movieFolder = parts.length > 3 ? parts[2] : undefined;
  titleSource = movieFolder || stem;
  const movieYearMatch = titleSource.match(/\b((?:19|20)\d{2})\b/);
  if (!movieFolder && movieYearMatch && stem.includes(movieYearMatch[1])) {
    titleSource = stem.slice(0, stem.indexOf(movieYearMatch[1]));
  }
  const parsed = titleAndYear(titleSource);
  return { type, category, ...parsed, extension };
}

export function normalizeTitle(value: string): string {
  return value.normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[right.length];
}

export function titleSimilarity(left: string, right: string): number {
  const a = normalizeTitle(left);
  const b = normalizeTitle(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const edit = 1 - editDistance(a, b) / Math.max(a.length, b.length);
  const aTokens = new Set(a.split(' '));
  const bTokens = new Set(b.split(' '));
  const intersection = [...aTokens].filter(token => bTokens.has(token)).length;
  const tokenScore = (2 * intersection) / (aTokens.size + bTokens.size);
  return Math.max(edit, tokenScore);
}

export function scoreCandidates(
  parsed: ParsedMedia,
  candidates: Array<Omit<MetadataCandidate, 'score' | 'titleSimilarity' | 'explanations' | 'ambiguous'>>,
  assistedTitles: string[] = [],
): ScoredMatch {
  if (parsed.preservedReason) {
    return { candidates: [], score: 0, confidence: 'preserved', explanations: [parsed.preservedReason] };
  }
  if (!parsed.title && assistedTitles.length === 0) {
    return { candidates: [], score: 0, confidence: 'unmatched', explanations: ['No reliable title could be extracted.'] };
  }

  const ranked = candidates.map(candidate => {
    const aliases = [...new Set([candidate.title, candidate.originalTitle, ...candidate.aliases].filter(Boolean))];
    const titleQueries = [parsed.title, ...assistedTitles];
    const best = aliases.flatMap(alias => titleQueries.map(query => ({
      alias,
      query,
      similarity: titleSimilarity(query, alias),
    }))).sort((a, b) => b.similarity - a.similarity)[0];
    const similarity = best?.similarity ?? 0;
    const bestAlias = best?.alias || candidate.title;
    const yearScore = parsed.year === undefined ? 8 : parsed.year === candidate.year ? 20 : 0;
    const score = Math.max(0, Math.min(100, Math.round(similarity * 70 + yearScore + 10)));
    const explanations = [`Title similarity: ${Math.round(similarity * 100)}%${bestAlias !== candidate.title ? ` (matched alias “${bestAlias}”)` : ''}.`];
    const originalSimilarity = Math.max(0, ...aliases.map(alias => titleSimilarity(parsed.title, alias)));
    if (best && best.query !== parsed.title && best.similarity > originalSimilarity) {
      explanations.push(`LM Studio suggested the alternate search title “${best.query}”.`);
    }
    if (parsed.year === undefined) explanations.push('No year was found in the file path.');
    else if (parsed.year === candidate.year) explanations.push(`Release year matches (${parsed.year}).`);
    else explanations.push(`Year mismatch: file says ${parsed.year}; provider says ${candidate.year ?? 'unknown'}.`);
    explanations.push('Media type matches the library category.');
    return { ...candidate, aliases, score, titleSimilarity: similarity, explanations, ambiguous: false };
  }).filter(candidate => candidate.titleSimilarity >= 0.4)
    .sort((a, b) => b.score - a.score || a.id - b.id);

  if (!ranked.length) {
    return { candidates: [], score: 0, confidence: 'unmatched', explanations: ['No provider candidate had a reliable title match.'] };
  }

  const ambiguous = ranked.length > 1 && ranked[0].score - ranked[1].score < 8;
  if (ambiguous) {
    ranked[0].ambiguous = true;
    ranked[0].explanations.push('Top candidates have similar scores; manual selection is required.');
  }
  const best = ranked[0];
  const yearConflict = parsed.year !== undefined && best.year !== undefined && parsed.year !== best.year;
  let confidence: Confidence = ambiguous || yearConflict || parsed.episodeStyle === 'absolute'
    ? best.score >= 70 ? 'medium' : 'low'
    : best.score >= 90 ? 'high' : best.score >= 70 ? 'medium' : 'low';
  const originalSimilarity = Math.max(0, ...[best.title, best.originalTitle, ...best.aliases]
    .filter(Boolean)
    .map(alias => titleSimilarity(parsed.title, alias)));
  const aiAssisted = assistedTitles.some(title => titleSimilarity(title, best.title) > originalSimilarity
    || titleSimilarity(title, best.originalTitle) > originalSimilarity
    || best.aliases.some(alias => titleSimilarity(title, alias) > originalSimilarity));
  if (aiAssisted && confidence === 'high') {
    confidence = 'medium';
    best.explanations.push('This match relied on an AI-suggested title and remains in review for confirmation.');
  }
  if (yearConflict) best.explanations.push('Year mismatch blocks high-confidence approval.');
  if (parsed.episodeStyle === 'absolute') best.explanations.push('Absolute episode numbering has no verified season mapping.');
  return {
    candidate: best,
    candidates: ranked.slice(0, 5),
    score: best.score,
    confidence,
    explanations: best.explanations,
  };
}

export function safeMetadataName(value: string): string {
  return value.slice(0, 180).replace(/[\/\\\0-\x1f<>:"|?*]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '') || 'Unknown Title';
}

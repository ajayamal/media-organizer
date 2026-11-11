import assert from 'node:assert/strict';
import test from 'node:test';
import { createMetadataProposal, normalizeTitle, parseMediaPath, scoreCandidates } from '../src/services/metadata-matching.js';

test('normalizes punctuation without discarding Japanese script', () => {
  assert.equal(normalizeTitle('Spirited.Away (2001)!'), 'spirited away 2001');
  assert.equal(normalizeTitle('天気の子'), '天気の子');
});

test('parses movie titles and release year from a folder', () => {
  const parsed = parseMediaPath(
    "movies/Anime/Spirited Away (2001)/[AnimeRG] Spirited Away (2001) [1080p].mkv",
    'movies/Anime',
  );
  assert.equal(parsed.title, 'Spirited Away');
  assert.equal(parsed.year, 2001);
  assert.equal(parsed.type, 'movie');
});

test('strips anime release-group and audio tags from movie filenames', () => {
  const parsed = parseMediaPath(
    'movies/Anime/[DB]Tenki no Ko_-_(Dual Audio_10bit_BD1080p_x265).mkv',
    'movies/Anime',
  );
  assert.equal(parsed.title, 'Tenki no Ko');
});

test('scores recognized English alternate titles and retains the original Japanese title', () => {
  const parsed = parseMediaPath('movies/Anime/Sen and Chihiro’s Spiriting Away (2001)/film.mkv', 'movies/Anime');
  const result = scoreCandidates(parsed, [{
    id: 129,
    mediaType: 'movie',
    title: 'Spirited Away',
    originalTitle: '千と千尋の神隠し',
    year: 2001,
    aliases: ['Sen and Chihiro’s Spiriting Away'],
  }]);
  assert.equal(result.confidence, 'high');
  assert.equal(result.candidate?.score, 100);
  assert.match(result.explanations[0], /matched alias/);
});

test('year mismatch prevents high-confidence classification', () => {
  const parsed = parseMediaPath('movies/Movies/Example (2001)/movie.mkv', 'movies/Movies');
  const result = scoreCandidates(parsed, [{
    id: 1, mediaType: 'movie', title: 'Example', originalTitle: 'Example', year: 2002, aliases: [],
  }]);
  assert.notEqual(result.confidence, 'high');
  assert.ok(result.explanations.some(explanation => explanation.includes('Year mismatch')));
});

test('marks similarly scored metadata candidates ambiguous', () => {
  const parsed = parseMediaPath('movies/Movies/Example (2001)/movie.mkv', 'movies/Movies');
  const result = scoreCandidates(parsed, [
    { id: 1, mediaType: 'movie', title: 'Example', originalTitle: 'Example', year: 2001, aliases: [] },
    { id: 2, mediaType: 'movie', title: 'Example', originalTitle: 'Example', year: 2001, aliases: [] },
  ]);
  assert.equal(result.candidate?.ambiguous, true);
  assert.equal(result.confidence, 'medium');
});

test('keeps AI-assisted title matches in review instead of assigning high confidence', () => {
  const parsed = parseMediaPath('movies/Movies/Mysterious Film (2020)/movie.mkv', 'movies/Movies');
  const result = scoreCandidates(parsed, [{
    id: 1, mediaType: 'movie', title: 'Example', originalTitle: 'Example', year: 2020, aliases: [],
  }], ['Example']);
  assert.equal(result.confidence, 'medium');
  assert.equal(result.aiAssisted, true);
  assert.ok(result.explanations.some(explanation => explanation.includes('LM Studio supplied')));
});

test('keeps matches in review whenever an alternate AI search title was used', () => {
  const parsed = parseMediaPath('movies/Movies/Example (2020)/movie.mkv', 'movies/Movies');
  const result = scoreCandidates(parsed, [{
    id: 1, mediaType: 'movie', title: 'Example', originalTitle: 'Example', year: 2020, aliases: [],
  }], ['Unrelated suggestion']);
  assert.equal(result.confidence, 'medium');
  assert.equal(result.aiAssisted, true);
});

test('keeps absolute episode numbering for review instead of inventing a season', () => {
  const parsed = parseMediaPath(
    'shows/Anime/Akame ga Kill!/Akame ga Kill! - 17.mkv',
    'shows/Anime',
  );
  assert.equal(parsed.title, 'Akame ga Kill!');
  assert.equal(parsed.episode, 17);
  assert.equal(parsed.episodeStyle, 'absolute');
});

test('detects conflict between filename season and containing season folder', () => {
  const parsed = parseMediaPath(
    'shows/Tv Shows/Cosmos (2014)/Season 2/Cosmos.S01E13.Seven.Wonders.mkv',
    'shows/Tv Shows',
  );
  assert.equal(parsed.season, 1);
  assert.equal(parsed.folderSeason, 2);
});

test('preserves AppleDouble files, specials, and extras', () => {
  for (const rel of [
    'movies/Anime/._metadata.mkv',
    'shows/Anime/Drifters/Drifters - S01E13-OVA - Rewrite.mkv',
    'shows/Anime/Drifters/NCOP 01.mkv',
    'shows/Anime/Drifters/Extras/clip.mkv',
  ]) {
    const category = rel.startsWith('movies/') ? 'movies/Anime' : 'shows/Anime';
    assert.ok(parseMediaPath(rel, category).preservedReason, rel);
  }
});

test('builds safe proposals from metadata rather than path input', () => {
  assert.equal(
    createMetadataProposal({
      category: 'movies/Movies',
      type: 'movie',
      title: '../Example: Film',
      year: 2020,
      extension: '.mkv',
    }),
    'movies/Movies/.. Example Film (2020)/.. Example Film (2020).mkv',
  );
  assert.equal(
    createMetadataProposal({
      category: 'shows/Tv Shows',
      type: 'tv',
      title: 'Example',
      year: 2020,
      season: 2,
      episode: 3,
      extension: '.mkv',
    }),
    'shows/Tv Shows/Example (2020)/Season 02/Example - S02E03.mkv',
  );
});

test('rejects unsafe categories, missing episode mappings, and invalid extensions', () => {
  assert.equal(createMetadataProposal({
    category: '../movies/Movies',
    type: 'movie',
    title: 'Example',
    year: 2020,
    extension: '.mkv',
  }), null);
  assert.equal(createMetadataProposal({
    category: 'shows/Anime',
    type: 'tv',
    title: 'Example',
    year: null,
    extension: '.mkv',
  }), null);
  assert.equal(createMetadataProposal({
    category: 'movies/Anime',
    type: 'movie',
    title: 'Example',
    year: 2020,
    extension: '/../../etc/passwd',
  }), null);
});

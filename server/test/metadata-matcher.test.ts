import assert from 'node:assert/strict';
import test from 'node:test';
import { MetadataMatcher } from '../src/services/metadata-matcher.js';
import { LmStudioClient } from '../src/services/lm-studio.js';

function createDatabase(correction?: Record<string, unknown>, inventoryOverride?: { id: string; rel: string; category: string; bytes?: number }) {
  const bindings: Array<Record<string, unknown>> = [];
  const inventory = {
    ...(inventoryOverride ?? {
    id: 'movie-1',
    rel: 'movies/Movies/Example (2020)/Example.mkv',
    category: 'movies/Movies',
    }),
    bytes: inventoryOverride?.bytes ?? 123,
  };
  const db = {
    prepare(sql: string) {
      return {
        all() {
          return sql.includes('FROM inventory') ? [inventory] : [];
        },
        get() {
          if (sql.includes('metadata_match_runs')) return { id: 1 };
          if (sql.includes('metadata_corrections')) return correction;
          return undefined;
        },
        run(value: unknown) {
          if (sql.includes('INSERT OR REPLACE INTO metadata_matches')) {
            const parameters = value as Record<string, unknown>;
            assert.ok(Object.values(parameters).every(parameter => typeof parameter !== 'boolean'));
            bindings.push(parameters);
          }
          return {};
        },
      };
    },
  };
  return { db, bindings };
}

test('matches and verifies an Episode-tagged anime file using its series and season folders', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname === '/3/search/tv') {
      return new Response(JSON.stringify({
        results: [{ id: 1, name: 'Samurai Champloo', original_name: 'Samurai Champloo', first_air_date: '2004-05-20' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/3/tv/1/alternative_titles') {
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/3/tv/1/season/1') {
      return new Response(JSON.stringify({
        episodes: [{ episode_number: 2, name: 'Redeye Reprisal' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected TMDB request: ${url.pathname}`);
  };

  try {
    const result = createDatabase(undefined, {
      id: 'samurai-episode-2',
      rel: 'shows/Anime/Samurai Champloo (ENHANCED) [1080p] [DUAL-AUDIO] [x265] [HEVC] [AAC]/Season 1/[bonkai77].Samurai.Champloo.(ENHANCED).Episode.02.Redeye.Reprisal.1080p.Dual.Audio.Bluray [8A84792E].mkv',
      category: 'shows/Anime',
    });
    await new MetadataMatcher(result.db as never, 'test-token').run(1);
    assert.equal(result.bindings[0].title, 'Samurai Champloo');
    assert.equal(result.bindings[0].confidence, 'high');
    assert.equal(result.bindings[0].matchStatus, 'matched');
    assert.equal(result.bindings[0].season, 1);
    assert.equal(result.bindings[0].episode, 2);
    assert.equal(result.bindings[0].episodeTitle, 'Redeye Reprisal');
    assert.match(String(result.bindings[0].proposedRel), /Samurai Champloo - S01E02\.mkv$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('asks LM Studio to parse titles even when deterministic TMDB matching is already high confidence', async () => {
  const originalFetch = globalThis.fetch;
  let lmRequests = 0;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/chat/completions')) {
      lmRequests++;
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"titles":["Example"]}' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname.endsWith('/alternative_titles')) {
      return new Response(JSON.stringify({ titles: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      results: [{ id: 1, title: 'Example', original_title: 'Example', release_date: '2020-01-01' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = createDatabase();
    const ai = new LmStudioClient('http://127.0.0.1:1234/v1', 'test-model');
    let autoApplyCalls = 0;
    await new MetadataMatcher(result.db as never, 'test-token', ai, async () => {
      autoApplyCalls++;
      return { ok: true, inventoryId: 'renamed-id', rel: 'movies/Movies/Example (2020)/Example (2020).mkv' };
    }).run(1);
    assert.equal(lmRequests, 1);
    assert.equal(result.bindings[0].confidence, 'high');
    assert.equal(result.bindings[0].aiAssisted, 0);
    assert.equal(autoApplyCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('auto-applies deterministic high-confidence matches and retains the renamed inventory entry', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => new Response(JSON.stringify(
    String(url).includes('/alternative_titles')
      ? { titles: [] }
      : { results: [{ id: 1, title: 'Example', original_title: 'Example', release_date: '2020-01-01' }] },
  ), { status: 200, headers: { 'content-type': 'application/json' } });

  try {
    const result = createDatabase();
    let applied = 0;
    await new MetadataMatcher(result.db as never, 'test-token', null, async record => {
      applied++;
      assert.equal(record.inventoryId, 'movie-1');
      assert.equal(record.bytes, 123);
      assert.equal(record.proposedRel, 'movies/Movies/Example (2020)/Example (2020).mkv');
      return { ok: true, inventoryId: 'renamed-id', rel: record.proposedRel };
    }).run(1);
    assert.equal(applied, 1);
    assert.equal(result.bindings[0].inventoryId, 'renamed-id');
    assert.equal(result.bindings[0].rel, 'movies/Movies/Example (2020)/Example (2020).mkv');
    assert.equal(result.bindings[0].proposedRel, null);
    assert.equal(result.bindings[0].autoApplied, 1);
    assert.equal(result.bindings[0].aiAssisted, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('keeps the proposal reviewable when a safe automatic rename is rejected', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => new Response(JSON.stringify(
    String(url).includes('/alternative_titles')
      ? { titles: [] }
      : { results: [{ id: 1, title: 'Example', original_title: 'Example', release_date: '2020-01-01' }] },
  ), { status: 200, headers: { 'content-type': 'application/json' } });

  try {
    const result = createDatabase();
    await new MetadataMatcher(result.db as never, 'test-token', null, async () => ({
      ok: false,
      reason: 'Destination already exists.',
    })).run(1);
    assert.equal(result.bindings[0].autoApplied, 0);
    assert.equal(result.bindings[0].proposedRel, 'movies/Movies/Example (2020)/Example (2020).mkv');
    assert.ok(String(result.bindings[0].explanations).includes('Destination already exists.'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('binds correction flags as SQLite integers', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => new Response(JSON.stringify(
    String(url).includes('/alternative_titles')
      ? { titles: [] }
      : { results: [{ id: 1, title: 'Example', original_title: 'Example', release_date: '2020-01-01' }] },
  ), { status: 200, headers: { 'content-type': 'application/json' } });

  try {
    const regular = createDatabase();
    await new MetadataMatcher(regular.db as never, 'test-token').run(1);
    assert.equal(regular.bindings[0].manualCorrection, 0);

    const corrected = createDatabase({
      provider_id: 1,
      provider_type: 'movie',
      provider_title: 'Example',
      original_title: 'Example',
      provider_year: 2020,
      corrected_title: 'Example',
      corrected_year: 2020,
      aliases: '[]',
      candidate_set: '[]',
      season: null,
      episode: null,
    });
    let autoApplyCalls = 0;
    await new MetadataMatcher(corrected.db as never, '', null, async () => {
      autoApplyCalls++;
      return { ok: true, inventoryId: 'unexpected', rel: 'unexpected' };
    }).run(1);
    assert.equal(corrected.bindings[0].manualCorrection, 1);
    assert.equal(autoApplyCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('uses LM Studio title suggestions to recover uncertain matches without auto-approving them', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/chat/completions')) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"titles":["Example"]}' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname.endsWith('/alternative_titles')) {
      return new Response(JSON.stringify({ titles: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const query = url.searchParams.get('query');
    const results = query === 'Example'
      ? [{ id: 1, title: 'Example', original_title: 'Example', release_date: '2020-01-01' }]
      : [];
    return new Response(JSON.stringify({ results }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = createDatabase(undefined, {
      id: 'movie-1',
      rel: 'movies/Movies/Mysterious Film (2020)/Mysterious Film.mkv',
      category: 'movies/Movies',
    });
    const ai = new LmStudioClient('http://127.0.0.1:1234/v1', 'test-model');
    let autoApplyCalls = 0;
    await new MetadataMatcher(result.db as never, 'test-token', ai, async () => {
      autoApplyCalls++;
      return { ok: true, inventoryId: 'unexpected', rel: 'unexpected' };
    }).run(1);
    assert.equal(result.bindings[0].title, 'Example');
    assert.equal(result.bindings[0].confidence, 'medium');
    assert.equal(result.bindings[0].matchStatus, 'review');
    assert.equal(result.bindings[0].aiAssisted, 1);
    assert.equal(autoApplyCalls, 0);
    assert.ok(String(result.bindings[0].explanations).includes('LM Studio'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

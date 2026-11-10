import assert from 'node:assert/strict';
import test from 'node:test';
import { MetadataMatcher } from '../src/services/metadata-matcher.js';

function createDatabase(correction?: Record<string, unknown>) {
  const bindings: Array<Record<string, unknown>> = [];
  const inventory = {
    id: 'movie-1',
    rel: 'movies/Movies/Example (2020)/Example.mkv',
    category: 'movies/Movies',
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
    await new MetadataMatcher(corrected.db as never, '').run(1);
    assert.equal(corrected.bindings[0].manualCorrection, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
